/*
 * The iris of a kibbl. feeder on the EMONI board: firmware/feeder-motor (Arduino Nano)
 * ported to the ESP32-S3. A gptimer gives the step pulses from a phase accumulator, a task
 * ramps the speed and runs the jobs (open, hold, close with the nudge, ...), the settings
 * and the position live in NVS. The app's commands arrive from the server directly.
 */

#include "KL_feeder.h"

#include "KL_hw.h"

#if KIBBL_FEEDER

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/gptimer.h"
#include "esp_attr.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "soc/gpio_reg.h"

#include "KL_commands.h"
#include "KL_nvs.h"
#include "KL_serial.h"
#include "KL_stream.h"
#include "KL_time.h"

#define STEPS_PER_TURN 4096  // the S42B at Microstep 16: 4096 steps a turn (2^n, its encoder)
#define TICK_HZ        20000 // the step pulse is one tick high (50 us), at most 10 kHz

/* From iris.py: the opening (0.1 mm) at 15 even steps of the stroke from open (0) to the
 * closed hard stop. The limits are taught under load (run, stop): 0 is where the open run
 * stopped, closedPos where the closed one did; the table stretches over them. */
#define STROKE        (STEPS_PER_TURN * 1575 / 3600) // 157.5 deg of motor: 1792 steps
#define AT(steps)     ((steps) * STROKE / 1400)      // a step count of the 1400 step stroke of iris.py
#define DESIGN_CLOSED (STROKE - AT(8))               // short of the stop, the blades already overlap
static const int16_t OPENING_TABLE[15] = {420, 410, 387, 363, 338, 312, 284, 255, 224, 192, 158, 123, 87, 51, 20};

// a teaching run: full speed until stopped, no limits; any stop is taught
#define RUN_SPEED 4000
#define RUN_ACCEL 20000
#define RUN_STEPS 100000000L
/* Finding the zero: past the open stop the S42B pushes against it; EN off for a moment and
 * it takes the angle its encoder reads as its target, stops pushing and holds there: 0 */
#define HOME_OVERTRAVEL AT(320) // past where open should be: more than a tooth of the pinion
#define HOME_SPEED      800
#define RELEASE_MS      120
#define MIN_SPEED       60
#define NUDGE_STEPS     AT(60) // reopen a little after closing and close again: frees kibble in the gap
/* Closed, the motor is off: held at the closed limit the S42B would keep pushing against the
 * blades and kibble. Enabled again it takes the angle it stands at; the steps wait for it */
#define ENABLE_MS 150

#define MIN_MM    2.5 // an iris command at or below: close
#define FOLLOW_MS 150 // while it moves the app gets where the iris is this often

#define FEEDER_STACK_SIZE 3072
#define NVS_CONFIG        "FEEDER_CFG"
#define NVS_POSITION      "FEEDER_POS"
#define CONFIG_MAGIC      0x4B48

typedef struct {
    uint16_t magic;
    int16_t opening;   // feed opening, 0.1 mm
    uint16_t open_ms;  // how long a portion stays open
    uint16_t speed;    // steps/s
    uint16_t accel;    // steps/s^2
    uint8_t invert;    // DIR level for closing
    int32_t closed_pos; // the closed limit, steps from the open one (0)
} feeder_config_t;

// 2400 steps/s: closed in 1.6 s, open in 1.1 s; 2092: the closed limit of the iris under load (2026-10-09)
static const feeder_config_t DEFAULTS = {CONFIG_MAGIC, 220, 1000, 2400, 8000, 0, 2092};
static feeder_config_t config;

#define CLOSED_POS (config.closed_pos)

/* ----------------------------------------------------------------------- */
/* stepping: a phase accumulator in the timer interrupt, one step per wrap */

static portMUX_TYPE step_mux = portMUX_INITIALIZER_UNLOCKED;
static volatile int32_t position   = 0;
static volatile int32_t target     = 0;
static volatile uint32_t phase_inc = 0; // speed * 2^32 / TICK_HZ
static volatile int8_t step_dir    = 0;
static uint32_t phase              = 0;

static bool IRAM_ATTR on_tick(gptimer_handle_t timer, const gptimer_alarm_event_data_t *edata, void *arg) {
    REG_WRITE(GPIO_OUT_W1TC_REG, BIT(FEEDER_STEP_PIN)); // the pulse of the last tick ends
    portENTER_CRITICAL_ISR(&step_mux);
    if (step_dir != 0 && position != target) {
        uint32_t before = phase;
        phase += phase_inc;
        if (phase < before) { // wrapped: one step
            REG_WRITE(GPIO_OUT_W1TS_REG, BIT(FEEDER_STEP_PIN));
            position += step_dir;
        }
    }
    portEXIT_CRITICAL_ISR(&step_mux);
    return false;
}

static int32_t read_position(void) {
    portENTER_CRITICAL(&step_mux);
    int32_t p = position;
    portEXIT_CRITICAL(&step_mux);
    return p;
}

static int32_t read_target(void) {
    portENTER_CRITICAL(&step_mux);
    int32_t t = target;
    portEXIT_CRITICAL(&step_mux);
    return t;
}

static void set_position(int32_t p) {
    portENTER_CRITICAL(&step_mux);
    position = target = p;
    portEXIT_CRITICAL(&step_mux);
}

static void set_speed(float steps_per_second) {
    uint32_t inc = steps_per_second <= 0 ? 0 : (uint32_t)(steps_per_second * (4294967296.0 / TICK_HZ));
    portENTER_CRITICAL(&step_mux);
    phase_inc = inc;
    portEXIT_CRITICAL(&step_mux);
}

/* ----------------------------------------------------------------------- */
/* settings and position in NVS */

static int32_t saved_position = INT32_MIN;

static void save_position(void) {
    int32_t p = read_position();
    if (p == saved_position) {
        return;
    }
    uint32_t raw = (uint32_t)p;
    if (nvs_queue_job(NVS_POSITION, &raw, 0, UINT32_T, WRITE)) {
        saved_position = p;
    }
}

static void save_config(void) {
    nvs_queue_job(NVS_CONFIG, &config, sizeof(config), BLOB, WRITE);
}

/* ----------------------------------------------------------------------- */
/* moves: a trapezoid, accelerate, cruise and brake in time for the target */

static SemaphoreHandle_t lock;
static float speed_now      = 0;
static uint16_t move_speed  = 0;
static uint16_t move_accel  = 3000;
static volatile bool moving = false;
static int64_t last_ramp    = 0;

static const char *job_name = ""; // the job running, "" when none

static bool running(void) {
    return strcmp(job_name, "run") == 0;
}

static void start_move(int32_t to, uint16_t speed) {
    move_accel   = running() ? RUN_ACCEL : config.accel;
    int32_t from = read_position();
    if (to == from) {
        return;
    }
    int8_t dir = to > from ? 1 : -1;
    gpio_set_level((gpio_num_t)FEEDER_DIR_PIN, (dir > 0) != (config.invert != 0));
    esp_rom_delay_us(20); // DIR settles before the first STEP
    portENTER_CRITICAL(&step_mux);
    target   = to;
    step_dir = dir;
    portEXIT_CRITICAL(&step_mux);
    move_speed = speed;
    speed_now  = MIN_SPEED;
    set_speed(speed_now);
    moving    = true;
    last_ramp = esp_timer_get_time();
}

static void ramp_update(void) {
    if (!moving) {
        return;
    }
    int64_t now = esp_timer_get_time();
    float dt    = (now - last_ramp) / 1e6f;
    if (dt < 0.001f) {
        return;
    }
    last_ramp    = now;
    int32_t left = read_target() - read_position();
    if (left == 0) {
        set_speed(0);
        portENTER_CRITICAL(&step_mux);
        step_dir = 0;
        portEXIT_CRITICAL(&step_mux);
        moving    = false;
        speed_now = 0;
        save_position();
        return;
    }
    float braking = sqrtf(2.0f * move_accel * labs(left));
    speed_now     = fminf(fminf(speed_now + move_accel * dt, (float)move_speed), fmaxf(braking, (float)MIN_SPEED));
    set_speed(speed_now);
}

// brakes from here: the shortest stop the ramp allows
static void stop_move(void) {
    int32_t p     = read_position();
    int32_t left  = labs(read_target() - p);
    int32_t brake = (int32_t)(speed_now * speed_now / (2.0f * move_accel));
    if (brake > left) {
        brake = left;
    }
    portENTER_CRITICAL(&step_mux);
    target = p + (step_dir > 0 ? brake : -brake);
    portEXIT_CRITICAL(&step_mux);
}

/* ----------------------------------------------------------------------- */
/* the opening table */

static int32_t to_design(int32_t real) {
    return (int32_t)((float)real * DESIGN_CLOSED / CLOSED_POS);
}

// the opening at a position, 0.1 mm
static int16_t opening_at(int32_t real) {
    int32_t steps = to_design(real);
    if (steps <= 0) {
        return OPENING_TABLE[0];
    }
    if (steps >= STROKE) {
        return OPENING_TABLE[14];
    }
    int32_t scaled = steps * 14;
    int k          = scaled / STROKE;
    int32_t rest   = scaled % STROKE;
    return OPENING_TABLE[k] + (int32_t)(OPENING_TABLE[k + 1] - OPENING_TABLE[k]) * rest / STROKE;
}

// the position of an opening (0.1 mm)
static int32_t steps_for(int16_t opening) {
    if (opening >= OPENING_TABLE[0]) {
        return 0;
    }
    for (int k = 0; k < 14; k++) {
        if (opening >= OPENING_TABLE[k + 1]) {
            int32_t span   = OPENING_TABLE[k] - OPENING_TABLE[k + 1];
            int32_t design = (STROKE * k + STROKE * (int32_t)(OPENING_TABLE[k] - opening) / span) / 14;
            int32_t real   = (int32_t)((float)design * CLOSED_POS / DESIGN_CLOSED);
            return abs(real) < abs(CLOSED_POS) ? real : CLOSED_POS;
        }
    }
    return CLOSED_POS;
}

/* ----------------------------------------------------------------------- */
/* jobs: a list of moves and waits, one after the other from the feeder task */

typedef enum { GO, WAIT, RELEASE, ZERO } step_kind_t;

typedef struct {
    step_kind_t kind;
    int32_t value;
    uint16_t speed;
} action_t;

static action_t job[8]; // one portion; a feed repeats it
static uint8_t job_len = 0, job_at = 0, job_repeats = 0;
static int64_t wait_until = 0;
static bool waiting       = false;
static bool enabling      = false; // the wait is the S42B coming on, the move is still to come
static bool motor_off     = false;
static int64_t job_start  = 0;
static int8_t teach_dir   = 0;
static bool job_ended     = false; // the app hears where it stopped
static struct {
    bool on;
    int portions;
    float opening;
    int open_ms;
} job_feed;

static void motor(bool on) {
    gpio_set_level((gpio_num_t)FEEDER_EN_PIN, on ? 0 : 1); // EnablePin !Enable: low is on
    motor_off = !on;
}

static void add(step_kind_t kind, int32_t value, uint16_t speed) {
    if (job_len < sizeof(job) / sizeof(job[0])) {
        job[job_len++] = (action_t){kind, value, speed};
    }
}

static void clear_job(void) {
    job_len = job_at = job_repeats = 0;
    waiting = enabling = false;
    job_feed.on = false;
}

static void start_job(const char *name) {
    job_at    = 0;
    job_name  = name;
    job_start = millis();
}

// the stop of a run: closing teaches the closed limit, opening makes where it stands 0
static void teach_limit(void) {
    int32_t p = read_position();
    if (teach_dir > 0) {
        if (p != 0) {
            config.closed_pos = p;
            save_config();
        }
    } else if (teach_dir < 0) {
        // the stroke stays: the closed limit moves with the new 0
        int32_t closed = CLOSED_POS - p;
        set_position(0);
        save_position();
        if (closed != 0) {
            config.closed_pos = closed;
            save_config();
        }
    }
    teach_dir = 0;
}

static void job_update(void) {
    if (moving || !*job_name) {
        return; // a job ends here once its last move is done
    }
    if (waiting) {
        if (millis() < wait_until) {
            return;
        }
        waiting = false;
        if (enabling) {
            enabling = false;
        } else {
            job_at++;
        }
    }
    while (job_at < job_len && !moving && !waiting) {
        action_t *a = &job[job_at];
        if (a->kind == GO && motor_off) {
            motor(true);
            enabling   = true;
            wait_until = millis() + ENABLE_MS;
            waiting    = true;
        } else if (a->kind == GO) {
            start_move(a->value, a->speed);
            job_at++;
        } else if (a->kind == ZERO) {
            // enabled again where it stands: the S42B holds its encoder angle, here is open
            motor(true);
            set_position(0);
            save_position();
            job_at++;
        } else {
            motor(a->kind != RELEASE); // a wait after a release: enabled again
            wait_until = millis() + a->value;
            waiting    = true;
        }
        if (job_at >= job_len && job_repeats) {
            job_repeats--;
            job_at = 0;
        }
    }
    if (job_at >= job_len && !moving && !waiting) {
        if (strcmp(job_name, "teach") == 0) {
            teach_limit();
        }
        if (job_feed.on) {
            DEBUG("feeder: fed %d portion(s)\n", job_feed.portions);
        }
        if (read_position() == CLOSED_POS) {
            motor(false);
        }
        clear_job();
        job_name  = "";
        job_ended = true;
        save_position();
    }
}

static void close_with_nudge(void) {
    add(GO, CLOSED_POS, config.speed);
    add(WAIT, 150, 0);
    add(GO, CLOSED_POS - (CLOSED_POS > 0 ? NUDGE_STEPS : -NUDGE_STEPS), config.speed);
    add(GO, CLOSED_POS, config.speed);
}

// into the open stop, release, and zero there
static void find_zero(int32_t beyond) {
    add(GO, beyond, HOME_SPEED);
    add(WAIT, 150, 0);
    add(RELEASE, RELEASE_MS, 0);
    add(ZERO, 0, 0);
    add(WAIT, 50, 0);
}

/* ----------------------------------------------------------------------- */

static void feeder_task(void *pvParams) {
    // the timer is made here: its interrupt runs on the core of this task, away from wifi
    gptimer_handle_t timer        = NULL;
    gptimer_config_t timer_config = {
        .clk_src       = GPTIMER_CLK_SRC_DEFAULT,
        .direction     = GPTIMER_COUNT_UP,
        .resolution_hz = 1000000,
    };
    gptimer_event_callbacks_t callbacks = {.on_alarm = on_tick};
    gptimer_alarm_config_t alarm        = {
               .reload_count               = 0,
               .alarm_count                = 1000000 / TICK_HZ,
               .flags.auto_reload_on_alarm = true,
    };
    if (gptimer_new_timer(&timer_config, &timer) != ESP_OK || gptimer_register_event_callbacks(timer, &callbacks, NULL) != ESP_OK ||
        gptimer_set_alarm_action(timer, &alarm) != ESP_OK || gptimer_enable(timer) != ESP_OK || gptimer_start(timer) != ESP_OK) {
        DEBUG_F_ERROR("feeder: step timer not started\n");
        vTaskDelete(NULL);
    }

    int64_t last_follow = 0;
    while (1) {
        xSemaphoreTake(lock, portMAX_DELAY);
        ramp_update();
        job_update();
        bool busy  = moving || *job_name;
        bool ended = job_ended;
        job_ended  = false;
        xSemaphoreGive(lock);

        // the app follows the iris: where it is while it moves, and where it stopped
        if (ended || (busy && millis() - last_follow >= FOLLOW_MS)) {
            last_follow = millis();
            stream_telemetry_soon();
        }
        vTaskDelay(1);
    }
}

bool feeder_setup(void) {
    gpio_config_t out = {
        .pin_bit_mask = BIT64(FEEDER_STEP_PIN) | BIT64(FEEDER_DIR_PIN) | BIT64(FEEDER_EN_PIN),
        .mode         = GPIO_MODE_OUTPUT,
    };
    gpio_set_level((gpio_num_t)FEEDER_EN_PIN, 1); // off until the position is known
    gpio_set_level((gpio_num_t)FEEDER_STEP_PIN, 0);
    gpio_config(&out);
    motor(false);

    if (!nvs_queue_job(NVS_CONFIG, &config, sizeof(config), BLOB, READ) || config.magic != CONFIG_MAGIC || config.closed_pos == 0) {
        config = DEFAULTS;
        save_config();
    }
    uint32_t raw = 0;
    bool known   = nvs_queue_job(NVS_POSITION, &raw, 0, UINT32_T, READ);
    set_position(known ? (int32_t)raw : 0);
    saved_position = read_position();

    // closed: off, as after a close; anywhere else it holds
    motor(read_position() != CLOSED_POS);
    DEBUG_F("feeder: at %ld of %ld steps (%s), %u steps/s\n", (long)read_position(), (long)CLOSED_POS, known ? "stored" : "unknown, open assumed",
            config.speed);

    lock = xSemaphoreCreateMutex();
    xTaskCreatePinnedToCore(feeder_task, "feeder", FEEDER_STACK_SIZE, NULL, 6, NULL, 1);
    return true;
}

bool feeder_busy(void) {
    return moving || *job_name;
}

/* ----------------------------------------------------------------------- */

static bool json_number(const cJSON *req, const char *key, double min, double max, double *out, const char **error, const char *msg) {
    const cJSON *v = cJSON_GetObjectItemCaseSensitive(req, key);
    if (v == NULL) {
        return false;
    }
    if (!cJSON_IsNumber(v) || v->valuedouble < min || v->valuedouble > max) {
        *error = msg;
        return false;
    }
    *out = v->valuedouble;
    return true;
}

static const char *cmd_stop(void) {
    bool run = running();
    clear_job();
    job_name = "";
    if (run && moving) {
        // the limit is where Stop was pressed: no more steps from here
        portENTER_CRITICAL(&step_mux);
        target = position;
        portEXIT_CRITICAL(&step_mux);
    } else if (moving) {
        stop_move();
    }
    if (run) {
        // where it comes to rest is the limit: taught in job_update once it stands
        start_job("teach");
    }
    return NULL;
}

static const char *cmd_config(const cJSON *req) {
    const char *error = NULL;
    double v;
    feeder_config_t c = config;
    if (json_number(req, "opening", 4, 42, &v, &error, "opening must be 4 to 42 mm")) {
        c.opening = (int16_t)(v * 10 + 0.5);
    }
    if (json_number(req, "openMs", 100, 20000, &v, &error, "openMs must be 100 to 20000")) {
        c.open_ms = (uint16_t)v;
    }
    if (json_number(req, "speed", 100, 4000, &v, &error, "speed must be 100 to 4000 steps/s")) {
        c.speed = (uint16_t)v;
    }
    if (json_number(req, "accel", 200, 20000, &v, &error, "accel must be 200 to 20000 steps/s2")) {
        c.accel = (uint16_t)v;
    }
    if (json_number(req, "closedPos", -1000000, 1000000, &v, &error, "closedPos must be a step count") && (int32_t)v != 0) {
        c.closed_pos = (int32_t)v;
    }
    bool invert = c.invert;
    if (json_bool(req, "invert", &invert)) {
        c.invert = invert;
    }
    if (error) {
        return error;
    }
    config = c;
    save_config();
    return NULL;
}

static const char *cmd_job(const char *cmd, const cJSON *req) {
    const char *error = NULL;
    double v;
    clear_job();

    if (strcmp(cmd, "feed") == 0) {
        int portions = 1;
        if (!json_int_in_range(req, "portions", 1, 10, &portions)) {
            return "portions must be 1 to 10";
        }
        // a feeding level: opening and time of this feed only, the stored ones otherwise
        double opening = config.opening / 10.0, open_ms = config.open_ms;
        json_number(req, "opening", 4, 42, &opening, &error, "opening must be 4 to 42 mm");
        json_number(req, "openMs", 100, 20000, &open_ms, &error, "openMs must be 100 to 20000");
        if (error) {
            return error;
        }
        add(GO, steps_for((int16_t)(opening * 10 + 0.5)), config.speed);
        add(WAIT, (int32_t)open_ms, 0);
        close_with_nudge();
        add(WAIT, 300, 0);
        job_repeats = portions - 1;
        job_feed.on       = true;
        job_feed.portions = portions;
        job_feed.opening  = (float)opening;
        job_feed.open_ms  = (int)open_ms;
        start_job("feed");
    } else if (strcmp(cmd, "iris") == 0) {
        if (!json_number(req, "opening", 2, 42, &v, &error, "opening must be 2 to 42 mm")) {
            return error ? error : "opening missing";
        }
        if (v <= MIN_MM) {
            close_with_nudge();
            start_job("close");
        } else {
            add(GO, steps_for((int16_t)(v * 10 + 0.5)), config.speed);
            start_job("open");
        }
    } else if (strcmp(cmd, "feeder_home") == 0) {
        // from wherever it really is: a whole stroke and the overtravel towards open
        find_zero(read_position() - (CLOSED_POS > 0 ? 1 : -1) * (STROKE + HOME_OVERTRAVEL));
        start_job("home");
    } else if (strcmp(cmd, "feeder_run") == 0) {
        const char *d = json_string(req, "direction");
        if (d == NULL || (strcmp(d, "open") != 0 && strcmp(d, "close") != 0)) {
            return "direction must be open or close";
        }
        teach_dir = strcmp(d, "close") == 0 ? 1 : -1;
        start_job("run");
        add(GO, read_position() + teach_dir * RUN_STEPS, RUN_SPEED);
    } else if (strcmp(cmd, "feeder_move") == 0) {
        int steps = 0;
        if (!json_int_in_range(req, "steps", -1000000, 1000000, &steps) || steps == 0) {
            return "steps must be 1 to 1000000, either way";
        }
        add(GO, read_position() + steps, config.speed);
        start_job("move");
    } else if (strcmp(cmd, "feeder_release") == 0) {
        // the S42B holds the angle it is left at once enabled again: the count here stays,
        // so an iris turned by hand meanwhile needs the zero found again afterwards
        int ms = 5000;
        if (!json_int_in_range(req, "ms", 100, 30000, &ms)) {
            return "ms must be 100 to 30000";
        }
        add(RELEASE, ms, 0);
        add(WAIT, 50, 0);
        start_job("release");
    } else if (strcmp(cmd, "feeder_zero") == 0) {
        set_position(0); // the iris stands fully open: here is 0
        save_position();
    }
    return NULL;
}

bool feeder_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error) {
    static const char *const jobs[] = {"feed", "iris", "feeder_home", "feeder_run", "feeder_move", "feeder_release", "feeder_zero"};
    bool is_job = false;
    for (size_t i = 0; i < sizeof(jobs) / sizeof(jobs[0]); i++) {
        is_job |= strcmp(cmd, jobs[i]) == 0;
    }
    if (!is_job && strcmp(cmd, "feeder_stop") != 0 && strcmp(cmd, "feeder_config") != 0) {
        return false;
    }

    xSemaphoreTake(lock, portMAX_DELAY);
    if (strcmp(cmd, "feeder_stop") == 0) {
        *error = cmd_stop();
    } else if (strcmp(cmd, "feeder_config") == 0) {
        *error = cmd_config(req);
    } else if (moving || *job_name) {
        *error = "busy";
    } else {
        *error = cmd_job(cmd, req);
    }
    xSemaphoreGive(lock);

    if (*error == NULL) {
        feeder_add_state(resp);
        stream_telemetry_soon();
    }
    return true;
}

void feeder_add_state(cJSON *json) {
    xSemaphoreTake(lock, portMAX_DELAY);
    int32_t p   = read_position();
    bool busy   = moving || *job_name;
    cJSON *f    = cJSON_AddObjectToObject(json, "feeder");
    cJSON_AddNumberToObject(f, "opening", opening_at(p) / 10.0);
    cJSON_AddBoolToObject(f, "busy", busy);
    if (busy) {
        cJSON_AddStringToObject(f, "job", job_name);
        cJSON_AddNumberToObject(f, "elapsedMs", (double)(millis() - job_start));
        if (job_feed.on) {
            cJSON *feed = cJSON_AddObjectToObject(f, "feed");
            cJSON_AddNumberToObject(feed, "portions", job_feed.portions);
            cJSON_AddNumberToObject(feed, "opening", job_feed.opening);
            cJSON_AddNumberToObject(feed, "openMs", job_feed.open_ms);
        }
    }
    cJSON_AddNumberToObject(f, "position", p);
    cJSON_AddNumberToObject(f, "speed", config.speed);
    cJSON_AddNumberToObject(f, "accel", config.accel);
    cJSON_AddNumberToObject(f, "closedPos", config.closed_pos);
    cJSON_AddBoolToObject(f, "motor", !motor_off);
    xSemaphoreGive(lock);
}

void feeder_stop(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    cmd_stop();
    job_name = "";
    xSemaphoreGive(lock);
}

void feeder_reset(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    config = DEFAULTS;
    save_config();
    xSemaphoreGive(lock);
}

#else // a camera without a feeder

bool feeder_setup(void) {
    return false;
}

bool feeder_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error) {
    return false;
}

void feeder_add_state(cJSON *json) {
}

bool feeder_busy(void) {
    return false;
}

void feeder_stop(void) {
}

void feeder_reset(void) {
}

#endif
