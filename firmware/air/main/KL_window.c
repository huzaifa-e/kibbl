#include "KL_window.h"

#include "cJSON.h"

#include "KL_air.h"
#include "KL_buzzer.h"
#include "KL_events.h"
#include "KL_serial.h"

#define MEAN_MS     (30 * 1000)
#define MEANS       (WINDOW_SPAN_MS / MEAN_MS + 1) // a mean at each end of the span
#define MIN_OPEN_MS WINDOW_SPAN_MS                 // open at least this long before it can close

// open: the CO2 falls by this share of its distance to the outside air, at least the ppm
#define OPEN_CO2_SHARE      0.2f
#define OPEN_CO2_MIN_PPM    80.0f
#define OPEN_TEMP_DROP      0.4f // °C, together with the CO2
#define OPEN_CO2_ONLY_SHARE 0.35f // without the temperature (summer)
#define OPEN_CO2_ONLY_PPM   200.0f
#define OPEN_TEMP_ONLY      0.8f  // °C within the span, while the CO2 does not rise
#define OPEN_TEMP_FAST      0.5f  // °C within a minute, while the CO2 does not rise
#define OPEN_CO2_FLAT       10.0f // ppm: "does not rise"
#define OPEN_FRESH_DROP     60.0f // ppm fallen within the span
#define OPEN_FRESH_MARGIN   50.0f // to at most this above outside air (calibrated: 420 ppm)
#define MIN_MEANS           3     // a minute and a half before the fast rules decide
// open: in the fresh air range of the calibration (+ margin), reached by a fall
#define FRESH_MARGIN        20.0f
#define FRESH_FALL          30.0f
// closed: clearly above it again
#define FRESH_CLOSE_ABOVE   40.0f
// the lamp and the fan warm the sensor: after a change the temperature alone does not count
#define HEAT_SETTLE_MS (15 * 60 * 1000)
// closed: one of them rises again
#define CLOSE_TEMP_RISE 0.1f // °C: a window shut lets the room warm up again at once
#define CLOSE_CO2_RISE  20.0f
#define CLOSE_CO2_MEANS 3 // the CO2 up in this many 30 s means in a row

typedef struct {
    float co2;
    float temperature;
} mean_t;

static mean_t means[MEANS]; // the newest last
static int means_count = 0;

static float sum_co2      = 0;
static float sum_temp     = 0;
static int sum_count      = 0;
static int64_t mean_start = 0;

static bool open         = false;
static float fresh_min   = 400; // until a calibration records the home's own
static float fresh_max   = 460;
static int64_t opened_ms = 0;
static int64_t heat_from = 0; // millis() from which the temperature alone counts

/* ----------------------------------------------------------------------- */

static void push_event(const char *state, int64_t now_ms, const mean_t *from, const mean_t *to) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "window");
    cJSON_AddStringToObject(json, "state", state);
    cJSON_AddNumberToObject(json, "co2", (int)to->co2);
    cJSON_AddNumberToObject(json, "co2Before", (int)from->co2);
    cJSON_AddNumberToObject(json, "temperatureChange", (int)((to->temperature - from->temperature) * 10) / 10.0);
    if (!open) {
        cJSON_AddNumberToObject(json, "openSeconds", (double)((now_ms - opened_ms) / 1000));
    } else {
        // seen opening: a short tone says it was noticed (muted at night like all of them, and in a bedroom)
        if (!air_room_quiet()) {
            buzzer_play(TONE_WINDOW);
        }
    }
    events_push(json);
}

static void decide(int64_t now_ms) {
    if (means_count < MIN_MEANS) {
        return;
    }
    const mean_t *from = &means[0];
    const mean_t *to   = &means[means_count - 1];
    // against the highest of the span: a short sharp drop counts as much as a slow one
    float co2_peak  = from->co2;
    float temp_peak = from->temperature;
    for (int i = 1; i < means_count; i++) {
        co2_peak  = means[i].co2 > co2_peak ? means[i].co2 : co2_peak;
        temp_peak = means[i].temperature > temp_peak ? means[i].temperature : temp_peak;
    }
    float co2_drop    = co2_peak - to->co2;
    float temp_drop   = temp_peak - to->temperature;
    float co2_rising  = to->co2 - from->co2;
    float above_out   = co2_peak - OUTDOOR_CO2_PPM;
    const mean_t *min_ago = &means[means_count - 3]; // a minute back (30 s means)
    float temp_drop_1min  = min_ago->temperature - to->temperature;

    if (!open) {
        float with_temp = above_out * OPEN_CO2_SHARE > OPEN_CO2_MIN_PPM ? above_out * OPEN_CO2_SHARE : OPEN_CO2_MIN_PPM;
        float co2_only  = above_out * OPEN_CO2_ONLY_SHARE > OPEN_CO2_ONLY_PPM ? above_out * OPEN_CO2_ONLY_SHARE : OPEN_CO2_ONLY_PPM;
        bool by_co2     = (co2_drop >= with_temp && temp_drop >= OPEN_TEMP_DROP) || co2_drop >= co2_only;
        /* The CO2 is where it was at the open window while calibrating, and it fell there: fresh
         * air coming in. Being there is not enough: an empty home airs out to the same level
         * over hours (with nobody breathing the CO2 sinks to that of outside), and a device that
         * starts there (after an update, a power cut) would take that for an open window that
         * never closes, as nobody comes to raise the CO2 again. */
        bool fell       = co2_drop >= FRESH_FALL;
        bool in_fresh   = to->co2 <= fresh_max + FRESH_MARGIN && fell;
        bool to_outdoor = in_fresh || (co2_drop >= OPEN_FRESH_DROP && to->co2 <= OUTDOOR_CO2_PPM + OPEN_FRESH_MARGIN);
        // the lamp or the fan changed lately: the board, not a window, cools the sensor
        bool by_temp    = now_ms >= heat_from && (temp_drop >= OPEN_TEMP_ONLY || temp_drop_1min >= OPEN_TEMP_FAST) && co2_rising <= OPEN_CO2_FLAT;
        if (means_count >= MEANS ? (by_co2 || to_outdoor || by_temp) : (to_outdoor || by_temp)) {
            open            = true;
            opened_ms       = now_ms;
            mean_t before = {.co2 = co2_peak, .temperature = temp_peak};
            DEBUG_F("window: open (%.0f -> %.0f ppm, %.1f -> %.1f °C)%s%s%s\n", co2_peak, to->co2, temp_peak, to->temperature, by_co2 ? " co2" : "",
                    to_outdoor ? " to outdoor" : "", by_temp ? " temperature" : "");
            push_event("open", now_ms, &before, to);
        }
    } else if (now_ms - opened_ms >= MIN_OPEN_MS) {
        float temp_change = to->temperature - from->temperature;
        /* the CO2 counts only when it stays up for CLOSE_CO2_MEANS means (1.5 min): a puff of a
         * cigarette smoked at the open window is gone again within a minute */
        bool co2_up = means_count >= CLOSE_CO2_MEANS;
        for (int i = means_count - CLOSE_CO2_MEANS; co2_up && i < means_count; i++) {
            co2_up = means[i].co2 - from->co2 >= CLOSE_CO2_RISE || means[i].co2 > fresh_max + FRESH_CLOSE_ABOVE;
        }
        if (temp_change >= CLOSE_TEMP_RISE || co2_up) {
            open = false;
            DEBUG_F("window: closed after %lld min\n", (now_ms - opened_ms) / 60000);
            push_event("closed", now_ms, from, to);
        }
    }
}

/* The fast rule, on the raw readings (every 2 s): the CO2 of a room with an open window falls
 * by its excess over outside air times 10-20 air changes an hour, ~25 ppm a minute at
 * 150 ppm above it; people leaving a shut room make under 1 ppm a minute. A trend line
 * through the last 60 s and the last 30 s, both steep enough, and FAST_MIN_FALL ppm in all:
 * open within about a minute. */
#define FAST_SAMPLES      30    // 60 s of readings
#define FAST_MIN_RATE     8.0f  // ppm a minute at least
#define FAST_EXCESS_SHARE 0.06f // or this share of the excess over fresh air a minute, if more
#define FAST_MIN_FALL     15.0f // ppm between the first and the last of the 60 s
#define FAST_FROM_STEADY  20.0f // ppm the level before may lie below the start of the fall

static float fast_co2[FAST_SAMPLES];
static int64_t fast_at[FAST_SAMPLES];
static int fast_count = 0; // readings in the ring, at most FAST_SAMPLES
static int fast_head  = 0; // where the next goes

// ppm a minute of the n newest readings, by least squares
static float fast_slope(int n) {
    float sx = 0, sy = 0, sxx = 0, sxy = 0;
    int64_t t0 = fast_at[(fast_head - 1 + FAST_SAMPLES) % FAST_SAMPLES];
    for (int i = 0; i < n; i++) {
        int k   = (fast_head - 1 - i + 2 * FAST_SAMPLES) % FAST_SAMPLES;
        float x = (float)(fast_at[k] - t0) / 60000.0f; // minutes, negative into the past
        float y = fast_co2[k];
        sx += x, sy += y, sxx += x * x, sxy += x * y;
    }
    float d = n * sxx - sx * sx;
    return d != 0 ? (n * sxy - sx * sy) / d : 0;
}

static void fast_rule(float co2, float temperature, int64_t now_ms) {
    fast_co2[fast_head] = co2;
    fast_at[fast_head]  = now_ms;
    fast_head           = (fast_head + 1) % FAST_SAMPLES;
    if (fast_count < FAST_SAMPLES) {
        fast_count++;
    }
    if (open || fast_count < FAST_SAMPLES) {
        return;
    }
    float oldest = fast_co2[fast_head]; // the slot written next holds the oldest
    float excess = co2 - fresh_max;
    float need   = excess * FAST_EXCESS_SHARE > FAST_MIN_RATE ? excess * FAST_EXCESS_SHARE : FAST_MIN_RATE;
    float slope60 = fast_slope(FAST_SAMPLES);
    float slope30 = fast_slope(FAST_SAMPLES / 2);
    /* a cigarette's puff spikes and falls back to where it came from: the level before the 60 s
     * (the oldest 30 s mean, 2-3 minutes back) must not be lower than at their start */
    bool from_steady = means_count >= MIN_MEANS && means[0].co2 >= oldest - FAST_FROM_STEADY;
    if (from_steady && slope60 <= -need && slope30 <= -need && oldest - co2 >= FAST_MIN_FALL) {
        open            = true;
        opened_ms       = now_ms;
        mean_t before = {.co2 = oldest, .temperature = temperature};
        mean_t now    = {.co2 = co2, .temperature = temperature};
        DEBUG_F("window: open (CO2 falling %.0f ppm/min, %.0f -> %.0f ppm in 60 s)\n", -slope60, oldest, co2);
        push_event("open", now_ms, &before, &now);
    }
}

void window_feed(float co2, float temperature, int64_t now_ms) {
    fast_rule(co2, temperature, now_ms);
    if (sum_count == 0) {
        mean_start = now_ms;
    }
    sum_co2 += co2;
    sum_temp += temperature;
    sum_count++;
    if (now_ms - mean_start < MEAN_MS) {
        return;
    }

    mean_t mean = {.co2 = sum_co2 / sum_count, .temperature = sum_temp / sum_count};
    sum_co2 = sum_temp = 0;
    sum_count          = 0;

    if (means_count == MEANS) {
        for (int i = 1; i < MEANS; i++) {
            means[i - 1] = means[i];
        }
        means_count--;
    }
    means[means_count++] = mean;
    decide(now_ms);
}

void window_reset(void) {
    fast_count  = 0;
    means_count = 0;
    sum_count   = 0;
    sum_co2 = sum_temp = 0;
    open               = false;
}

void window_heat_changed(int64_t now_ms) {
    heat_from = now_ms + HEAT_SETTLE_MS;
}

const char *window_state(bool detecting) {
    if (!detecting) {
        return "paused";
    }
    if (open) {
        return "open";
    }
    return means_count < MIN_MEANS ? "learning" : "closed";
}

void window_set_fresh(uint16_t min_ppm, uint16_t max_ppm) {
    fresh_min = min_ppm;
    fresh_max = max_ppm;
    DEBUG("window: fresh air %u-%u ppm\n", min_ppm, max_ppm);
}

bool window_open(void) {
    return open;
}
