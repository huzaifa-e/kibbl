#include "KL_window.h"

#include "cJSON.h"

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
// the lamp and the fan warm the sensor: after a change the temperature alone does not count
#define HEAT_SETTLE_MS (15 * 60 * 1000)
// closed: one of them rises again
#define CLOSE_TEMP_RISE 0.3f
#define CLOSE_CO2_RISE  40.0f

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
        // calibrated, outside air reads about 420 ppm: falling fast to it is fresh air coming in
        bool to_outdoor = co2_drop >= OPEN_FRESH_DROP && to->co2 <= OUTDOOR_CO2_PPM + OPEN_FRESH_MARGIN;
        // the lamp or the fan changed lately: the board, not a window, cools the sensor
        bool by_temp    = now_ms >= heat_from && (temp_drop >= OPEN_TEMP_ONLY || temp_drop_1min >= OPEN_TEMP_FAST) && co2_rising <= OPEN_CO2_FLAT;
        if (means_count >= MEANS ? (by_co2 || to_outdoor || by_temp) : (to_outdoor || by_temp)) {
            open      = true;
            opened_ms = now_ms;
            mean_t before = {.co2 = co2_peak, .temperature = temp_peak};
            DEBUG_F("window: open (%.0f -> %.0f ppm, %.1f -> %.1f °C)%s%s%s\n", co2_peak, to->co2, temp_peak, to->temperature, by_co2 ? " co2" : "",
                    to_outdoor ? " to outdoor" : "", by_temp ? " temperature" : "");
            push_event("open", now_ms, &before, to);
        }
    } else if (now_ms - opened_ms >= MIN_OPEN_MS) {
        float temp_change = to->temperature - from->temperature;
        if (temp_change >= CLOSE_TEMP_RISE || co2_rising >= CLOSE_CO2_RISE) {
            open = false;
            DEBUG_F("window: closed after %lld min\n", (now_ms - opened_ms) / 60000);
            push_event("closed", now_ms, from, to);
        }
    }
}

void window_feed(float co2, float temperature, int64_t now_ms) {
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

bool window_open(void) {
    return open;
}
