/*
 * kibbl. feeder: motor control of the iris (hardware/feeder/iris).
 *
 * Arduino Nano (ATmega328P) giving STEP/DIR to a BTT S42B v1.0 on the NEMA 17.
 * The S42B closes the loop on its own encoder and tells nothing back: no position,
 * no stall. So the position is kept here and in EEPROM after every move, and a jam
 * cannot be seen. Set the S42B to Motor mA 600 (the motor gets half of it: 0.3 A) and 16
 * microsteps: at 0.3 A a jammed blade keeps a safety of 2.7 in PLA (hardware/feeder/iris/README.md, Loads).
 * First use of the S42B: DIP 1 on, 2 off (16), 3 on (closed loop), 4 on, then Calibrate in its menu
 * with the shaft free (K3 settings, K2 next line, K4 confirm, K1 reset when it says finished); 4 off after.
 *
 * Wiring to the S42B's signal header (as the samgas demo): D9 to CLK, D5 to DIR, D10 to EN, held low:
 * enabled at the S42B's default EnablePin !Enable.
 *
 * Serial 115200, one command per line, json as in docs/protocol.md or plain words:
 *   {"cmd":"feed","portions":2,"id":1}   feed 2      portions 1-10
 *   {"cmd":"open","mm":30}               open 30     opening 2-42 mm (42 without mm)
 *   {"cmd":"close"}                      close
 *   {"cmd":"home"}                       home        to open, HOME_OVERTRAVEL past it and back: takes up a small drift
 *   {"cmd":"zero"}                       zero        the iris is open by hand: here is 0
 *   {"cmd":"move","steps":-50}           move -50    relative, no limits, at the set speed, for setting up
 *   {"cmd":"stop"}                       stop
 *   {"cmd":"info"}                       info
 *   {"cmd":"feeder_config", ...}         config ...  any of opening (mm), openMs, speed, accel, invert
 * Every command gets {"type":"response","id":..,"ok":..}; a finished feed sends {"type":"event","event":"fed"}.
 */
#include <EEPROM.h>

// ─────────────────────────── hardware ───────────────────────────
#define STEP_BIT 1  // D9 = PB1
#define DIR_BIT 5   // D5 = PD5
#define EN_BIT 2    // D10 = PB2, low: enabled
#define STEPS_PER_TURN 4096L  // the S42B at Microstep 16: 4096 steps a turn (2^n, its encoder), not 3200
#define TICK_HZ 20000UL  // Timer1: the step pulse is one tick high (50 us), at most 10 kHz

// ─────────────────────────── iris ───────────────────────────
// From iris.py: the opening (0.1 mm) at 15 even steps of the stroke from open (0) to the closed hard stop
#define STROKE (STEPS_PER_TURN * 1575 / 3600)  // 157.5 deg of motor (iris.py): 1792 steps
#define AT(steps) ((steps) * STROKE / 1400)  // a step count of the 1400 step stroke in iris.py, here
static const int OPENING_TABLE[15] = {420, 410, 387, 363, 338, 312, 284, 255, 224, 192, 158, 123, 87, 51, 20};
#define CLOSED_POS (STROKE - AT(8L))  // short of the stop, the blades already overlap there
#define HOME_OVERTRAVEL AT(40L)    // past the open stop: the S42B pushes there at its 0.3 A
#define HOME_SPEED 300                             // steps/s
#define MIN_SPEED 60
#define NUDGE_STEPS AT(60L)        // reopen a little after closing, then close again: frees kibble in the gap

// ─────────────────────────── settings (EEPROM) ───────────────────────────
struct Config {
    uint16_t magic;
    int16_t opening;   // feed opening, 0.1 mm
    uint16_t openMs;   // how long a portion stays open
    uint16_t speed;    // steps/s
    uint16_t accel;    // steps/s^2
    uint8_t invert;    // DIR level for closing
};
#define CONFIG_MAGIC 0x4B46
#define CONFIG_ADDR 0
#define POSITION_ADDR 32  // int32 + its inverse, so a half written value is seen

static Config config;
static const Config DEFAULTS = {CONFIG_MAGIC, 220, 1000, 2400, 8000, 0};  // 2400 steps/s: closed in 1.6 s, open in 1.1 s

// ─────────────────────────── stepping (Timer1) ───────────────────────────
static volatile int32_t position = 0;
static volatile int32_t target = 0;
static volatile uint32_t phaseIncrement = 0;  // speed * 2^32 / TICK_HZ
static volatile int8_t stepDir = 0;
static uint32_t phase = 0;

ISR(TIMER1_COMPA_vect) {
    PORTB &= ~_BV(STEP_BIT);  // the pulse of the last tick ends
    if (stepDir == 0 || position == target) return;
    uint32_t before = phase;
    phase += phaseIncrement;
    if (phase < before) {  // wrapped: one step
        PORTB |= _BV(STEP_BIT);
        position += stepDir;
    }
}

static void timerStart() {
    TCCR1A = 0;
    TCCR1B = _BV(WGM12) | _BV(CS11);  // CTC, /8: 2 MHz
    OCR1A = F_CPU / 8 / TICK_HZ - 1;
    TIMSK1 = _BV(OCIE1A);
}

static int32_t readPosition() {
    noInterrupts();
    int32_t p = position;
    interrupts();
    return p;
}

static void setSpeed(float stepsPerSecond) {
    uint32_t inc = stepsPerSecond <= 0 ? 0 : (uint32_t)(stepsPerSecond * (4294967296.0 / TICK_HZ));
    noInterrupts();
    phaseIncrement = inc;
    interrupts();
}

// ─────────────────────────── motion ───────────────────────────
static float speedNow = 0;
static uint16_t moveSpeed = 0;
static bool moving = false;
static uint32_t lastRamp = 0;

static void startMove(int32_t to, uint16_t speed) {
    int32_t from = readPosition();
    if (to == from) return;
    int8_t dir = to > from ? 1 : -1;
    bool level = (dir > 0) != (config.invert != 0);
    if (level) PORTD |= _BV(DIR_BIT); else PORTD &= ~_BV(DIR_BIT);
    delayMicroseconds(20);  // DIR settles before the first STEP
    noInterrupts();
    target = to;
    stepDir = dir;
    interrupts();
    moveSpeed = speed;
    speedNow = MIN_SPEED;
    setSpeed(speedNow);
    moving = true;
    lastRamp = micros();
}

static void savePosition() {
    int32_t p = readPosition();
    int32_t stored;
    EEPROM.get(POSITION_ADDR, stored);
    if (stored == p) return;
    EEPROM.put(POSITION_ADDR, p);
    EEPROM.put(POSITION_ADDR + 4, (int32_t)~p);
}

// trapezoid: accelerate, cruise, and brake in time for the target
static void rampUpdate() {
    if (!moving) return;
    uint32_t now = micros();
    float dt = (now - lastRamp) / 1e6f;
    if (dt < 0.001f) return;
    lastRamp = now;
    int32_t left = target - readPosition();
    if (left == 0) {
        setSpeed(0);
        noInterrupts();
        stepDir = 0;
        interrupts();
        moving = false;
        speedNow = 0;
        savePosition();
        return;
    }
    float braking = sqrt(2.0f * config.accel * labs(left));
    speedNow = min(min(speedNow + config.accel * dt, (float)moveSpeed), max(braking, (float)MIN_SPEED));
    setSpeed(speedNow);
}

static void stopMove() {
    // brakes from here: the shortest stop the ramp allows
    int32_t p = readPosition();
    int32_t brake = min((int32_t)(speedNow * speedNow / (2.0f * config.accel)), labs(target - p));
    noInterrupts();
    target = p + (stepDir > 0 ? brake : -brake);
    interrupts();
}

static int16_t openingAt(int32_t steps) {
    if (steps <= 0) return OPENING_TABLE[0];
    if (steps >= STROKE) return OPENING_TABLE[14];
    int32_t scaled = steps * 14;
    int k = scaled / STROKE;
    int32_t rest = scaled % STROKE;
    return OPENING_TABLE[k] + (int32_t)(OPENING_TABLE[k + 1] - OPENING_TABLE[k]) * rest / STROKE;
}

static int32_t stepsFor(int16_t opening) {
    if (opening >= OPENING_TABLE[0]) return 0;
    for (int k = 0; k < 14; k++) {
        if (opening >= OPENING_TABLE[k + 1]) {
            int32_t span = OPENING_TABLE[k] - OPENING_TABLE[k + 1];
            return (STROKE * k + STROKE * (int32_t)(OPENING_TABLE[k] - opening) / span) / 14;
        }
    }
    return CLOSED_POS;
}

// ─────────────────────────── jobs ───────────────────────────
// A job is a list of moves and waits, run one after the other from loop().
enum Step : uint8_t { GO, WAIT };
struct Action { Step kind; int32_t value; uint16_t speed; };
static Action job[8];  // one portion; a feed repeats it
static uint8_t jobLength = 0, jobAt = 0, jobRepeats = 0;
static uint32_t waitUntil = 0;
static bool waiting = false;
static long jobId = -1;
static uint8_t jobPortions = 0;
static const char *jobName = "";

static void add(Step kind, int32_t value, uint16_t speed = 0) {
    if (jobLength < sizeof(job) / sizeof(job[0])) job[jobLength++] = {kind, value, speed};
}

static void respond(long id, bool ok, const char *error = nullptr);
static void sendInfo(long id);

static void jobUpdate() {
    if (moving || !*jobName) return;  // a job ends here once its last move is done
    if (waiting) {
        if ((int32_t)(millis() - waitUntil) < 0) return;
        waiting = false;
        jobAt++;
    }
    while (jobAt < jobLength && !moving && !waiting) {
        Action &a = job[jobAt];
        if (a.kind == GO) {
            startMove(a.value, a.speed);
            jobAt++;
        } else {
            waitUntil = millis() + a.value;
            waiting = true;
        }
        if (jobAt >= jobLength && jobRepeats) {
            jobRepeats--;
            jobAt = 0;
        }
    }
    if (jobAt >= jobLength && !moving && !waiting) {
        if (jobPortions) {
            Serial.print(F("{\"type\":\"event\",\"event\":\"fed\",\"portions\":"));
            Serial.print(jobPortions);
            Serial.println('}');
        }
        long id = jobId;
        jobLength = jobAt = jobPortions = jobRepeats = 0;
        jobId = -1;
        jobName = "";
        sendInfo(id);  // done: the caller learns where the iris is
    }
}

static bool busy() { return moving || *jobName; }

static void startJob(long id, const char *name) {
    jobAt = 0;
    jobId = id;
    jobName = name;
}

// ─────────────────────────── commands ───────────────────────────
static char line[96];
static uint8_t lineLength = 0;

// the value after "key": in a json line, or nullptr
static const char *field(const char *json, const char *key) {
    char pattern[20];
    snprintf(pattern, sizeof(pattern), "\"%s\"", key);
    const char *at = strstr(json, pattern);
    if (!at) return nullptr;
    at = strchr(at + strlen(pattern), ':');
    if (!at) return nullptr;
    at++;
    while (*at == ' ') at++;
    return at;
}

static bool number(const char *json, const char *key, float &out) {
    const char *v = field(json, key);
    if (!v || !(*v == '-' || *v == '.' || isdigit(*v))) return false;
    out = atof(v);
    return true;
}

static void respond(long id, bool ok, const char *error) {
    Serial.print(F("{\"type\":\"response\""));
    if (id >= 0) { Serial.print(F(",\"id\":")); Serial.print(id); }
    Serial.print(ok ? F(",\"ok\":true") : F(",\"ok\":false"));
    if (error) { Serial.print(F(",\"error\":\"")); Serial.print(error); Serial.print('"'); }
    Serial.println('}');
}

static void sendInfo(long id) {
    int32_t p = readPosition();
    Serial.print(F("{\"type\":\"response\""));
    if (id >= 0) { Serial.print(F(",\"id\":")); Serial.print(id); }
    Serial.print(F(",\"ok\":true,\"model\":\"kibbl-feeder\",\"position\":")); Serial.print(p);
    Serial.print(F(",\"opening\":")); Serial.print(openingAt(p) / 10.0, 1);
    Serial.print(F(",\"busy\":")); Serial.print(busy() ? F("true") : F("false"));
    if (busy()) { Serial.print(F(",\"job\":\"")); Serial.print(jobName); Serial.print('"'); }
    Serial.print(F(",\"feeder\":{\"opening\":")); Serial.print(config.opening / 10.0, 1);
    Serial.print(F(",\"openMs\":")); Serial.print(config.openMs);
    Serial.print(F(",\"speed\":")); Serial.print(config.speed);
    Serial.print(F(",\"accel\":")); Serial.print(config.accel);
    Serial.print(F(",\"invert\":")); Serial.print(config.invert ? F("true") : F("false"));
    Serial.println(F("}}"));
}

static void closeWithNudge() {
    add(GO, CLOSED_POS, config.speed);
    add(WAIT, 150);
    add(GO, CLOSED_POS - NUDGE_STEPS, config.speed);
    add(GO, CLOSED_POS, config.speed);
}

static void command(char *text) {
    while (*text == ' ') text++;
    if (!*text) return;
    bool json = *text == '{';
    char cmd[16] = "";
    float value = 0;
    bool hasValue = false;
    long id = -1;
    if (json) {
        const char *c = field(text, "cmd");
        if (c && *c == '"') {
            c++;
            uint8_t n = 0;
            while (*c && *c != '"' && n < sizeof(cmd) - 1) cmd[n++] = *c++;
            cmd[n] = 0;
        }
        float f;
        if (number(text, "id", f)) id = (long)f;
    } else {
        // plain words: "feed 2", "open 30", "config speed 900"
        char *rest = strchr(text, ' ');
        if (rest) *rest++ = 0;
        strncpy(cmd, text, sizeof(cmd) - 1);
        if (rest) {
            while (*rest == ' ') rest++;
            if (!strcmp(cmd, "config")) {
                // rewrite as json so both forms share the parsing below
                static char rewritten[64];
                char *v = strchr(rest, ' ');
                if (v) *v++ = 0;
                snprintf(rewritten, sizeof(rewritten), "{\"%s\":%s}", rest, v ? v : "");
                text = rewritten;
                json = true;
                strcpy(cmd, "feeder_config");
            } else if (*rest) {
                value = atof(rest);
                hasValue = true;
            }
        }
    }
    for (char *c = cmd; *c; c++) *c = tolower(*c);

    if (!strcmp(cmd, "info")) { sendInfo(id); return; }
    if (!strcmp(cmd, "stop")) {
        jobLength = jobAt = jobPortions = jobRepeats = 0;
        jobName = "";
        waiting = false;
        if (moving) stopMove();
        respond(id, true);
        return;
    }
    if (!strcmp(cmd, "feeder_config")) {
        float f;
        if (number(text, "opening", f)) {
            if (f < 4 || f > 42) { respond(id, false, "opening must be 4 to 42 mm"); return; }
            config.opening = (int16_t)(f * 10 + 0.5f);
        }
        if (number(text, "openMs", f) || number(text, "openms", f)) {
            if (f < 100 || f > 20000) { respond(id, false, "openMs must be 100 to 20000"); return; }
            config.openMs = (uint16_t)f;
        }
        if (number(text, "speed", f)) {
            if (f < 100 || f > 4000) { respond(id, false, "speed must be 100 to 4000 steps/s"); return; }
            config.speed = (uint16_t)f;
        }
        if (number(text, "accel", f)) {
            if (f < 200 || f > 20000) { respond(id, false, "accel must be 200 to 20000 steps/s2"); return; }
            config.accel = (uint16_t)f;
        }
        const char *inv = field(text, "invert");
        if (inv) config.invert = (*inv == 't' || *inv == '1');
        EEPROM.put(CONFIG_ADDR, config);
        sendInfo(id);
        return;
    }
    if (busy()) { respond(id, false, "busy"); return; }

    jobLength = jobAt = jobPortions = jobRepeats = 0;
    if (!strcmp(cmd, "feed")) {
        float f = 1;
        if (json) number(text, "portions", f); else if (hasValue) f = value;
        int portions = (int)f;
        if (portions < 1 || portions > 10) { respond(id, false, "portions must be 1 to 10"); return; }
        add(GO, stepsFor(config.opening), config.speed);
        add(WAIT, config.openMs);
        closeWithNudge();
        add(WAIT, 300);
        jobRepeats = portions - 1;
        jobPortions = portions;
        startJob(id, "feed");
    } else if (!strcmp(cmd, "open")) {
        float mm = 42;
        if (json) number(text, "mm", mm); else if (hasValue) mm = value;
        if (mm < 2 || mm > 42) { respond(id, false, "mm must be 2 to 42"); return; }
        add(GO, stepsFor((int16_t)(mm * 10 + 0.5f)), config.speed);
        startJob(id, "open");
    } else if (!strcmp(cmd, "close")) {
        closeWithNudge();
        startJob(id, "close");
    } else if (!strcmp(cmd, "home")) {
        add(GO, -HOME_OVERTRAVEL, HOME_SPEED);
        add(WAIT, 300);
        // back by the overtravel: where the stop was, the S42B stops pushing. Without feedback this takes up
        // a drift of up to HOME_OVERTRAVEL; a position that is lost entirely is set with move and zero.
        add(GO, 0, HOME_SPEED);
        startJob(id, "home");
    } else if (!strcmp(cmd, "zero")) {
        noInterrupts();
        position = target = 0;
        interrupts();
        savePosition();
        sendInfo(id);
        return;
    } else if (!strcmp(cmd, "move")) {
        float f = 0;
        if (json) number(text, "steps", f); else if (hasValue) f = value;
        if (f == 0 || fabs(f) > 2L * STROKE) { respond(id, false, "steps must be 1 to 3584, either way"); return; }
        add(GO, readPosition() + (int32_t)f, config.speed);
        startJob(id, "move");
    } else {
        respond(id, false, "unknown command");
        return;
    }
    // the response comes when the job is done (info), so the caller knows where the iris is
}

// ─────────────────────────── main ───────────────────────────
void setup() {
    DDRB |= _BV(STEP_BIT) | _BV(EN_BIT);
    DDRD |= _BV(DIR_BIT);
    PORTB &= ~(_BV(STEP_BIT) | _BV(EN_BIT));  // enabled
    Serial.begin(115200);

    EEPROM.get(CONFIG_ADDR, config);
    if (config.magic != CONFIG_MAGIC) {
        config = DEFAULTS;
        EEPROM.put(CONFIG_ADDR, config);
    }
    int32_t p, check;
    EEPROM.get(POSITION_ADDR, p);
    EEPROM.get(POSITION_ADDR + 4, check);
    bool known = check == ~p && p >= -2L * STROKE && p <= 2L * STROKE;
    position = target = known ? p : 0;

    timerStart();
    Serial.print(F("{\"type\":\"hello\",\"model\":\"kibbl-feeder\",\"caps\":[\"feeder\"],\"positionKnown\":"));
    Serial.print(known ? F("true") : F("false"));
    Serial.println('}');
    sendInfo(-1);
}

void loop() {
    while (Serial.available()) {
        char c = Serial.read();
        if (c == '\n' || c == '\r') {
            line[lineLength] = 0;
            if (lineLength) command(line);
            lineLength = 0;
        } else if (lineLength < sizeof(line) - 1) {
            line[lineLength++] = c;
        }
    }
    rampUpdate();
    jobUpdate();
}
