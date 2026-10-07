#include "KL_smoke.h"

#include "cJSON.h"

#include "KL_events.h"
#include "KL_serial.h"

#define BASELINE_TAU_S      300  // the room level follows the CO2 within about 5 min
#define BASELINE_FALL_ALPHA 0.05f // and a falling CO2 (a window) faster
#define SAMPLE_S            2
#define PUFF_MAX_MS         (90 * 1000) // a puff is down again by then, else it was no puff
#define BUTTON_BEFORE_MS    (5 * 60 * 1000) // a press this long before the first puff belongs to it

static bool started     = false;
static float baseline   = 0;
static float history[2] = {0}; // the two readings before this one

static bool in_puff     = false;
static float puff_peak  = 0;
static int64_t puff_start_ms = 0;

static uint8_t puffs          = 0; // of the cigarette going on
static int64_t first_puff_ms  = 0;
static int64_t last_puff_ms   = 0;
static float session_peak     = 0;
static int64_t last_button_ms = -BUTTON_BEFORE_MS - 1;

/* ----------------------------------------------------------------------- */

static void end_session(int64_t now_ms) {
    if (puffs >= SMOKE_MIN_PUFFS) {
        bool button = last_button_ms >= first_puff_ms - BUTTON_BEFORE_MS && last_button_ms <= now_ms;
        DEBUG_F("smoke: cigarette, %u puffs in %lld s%s\n", puffs, (last_puff_ms - first_puff_ms) / 1000, button ? ", logged with the button" : "");

        cJSON *json = cJSON_CreateObject();
        cJSON_AddStringToObject(json, "event", "smoke");
        cJSON_AddStringToObject(json, "source", "auto");
        cJSON_AddNumberToObject(json, "puffs", puffs);
        cJSON_AddNumberToObject(json, "durationSeconds", (double)((last_puff_ms - first_puff_ms) / 1000));
        cJSON_AddNumberToObject(json, "peakPpm", (int)session_peak);
        // the server counts this one only when the button did not log it already
        cJSON_AddBoolToObject(json, "button", button);
        // the event happened at the last puff, not when the gap ran out
        cJSON_AddNumberToObject(json, "delaySeconds", (double)((now_ms - last_puff_ms) / 1000));
        events_push(json);
    } else {
        DEBUG("smoke: %u puff(s), no cigarette\n", puffs);
    }
    puffs        = 0;
    session_peak = 0;
}

static void count_puff(int64_t now_ms) {
    if (puffs == 0) {
        first_puff_ms = now_ms;
    }
    puffs++;
    last_puff_ms = now_ms;
    if (puff_peak > session_peak) {
        session_peak = puff_peak;
    }
    DEBUG("smoke: puff %u, %.0f ppm above %.0f\n", puffs, puff_peak - baseline, baseline);
}

void smoke_feed(float co2, uint16_t puff_rise, int64_t now_ms) {
    if (!started) {
        baseline   = co2;
        history[0] = history[1] = co2;
        started    = true;
    }

    float excess = co2 - baseline;
    float slope  = co2 - history[0]; // over 4 s

    if (!in_puff) {
        if (excess >= puff_rise && slope >= puff_rise / 2.0f) {
            in_puff       = true;
            puff_peak     = co2;
            puff_start_ms = now_ms;
        } else {
            float alpha = co2 < baseline ? BASELINE_FALL_ALPHA : (float)SAMPLE_S / BASELINE_TAU_S;
            baseline += (co2 - baseline) * alpha;
        }
    } else {
        if (co2 > puff_peak) {
            puff_peak = co2;
        }
        if (co2 <= baseline + (puff_peak - baseline) / 2) {
            // half way down again: a puff
            in_puff = false;
            count_puff(now_ms);
        } else if (now_ms - puff_start_ms > PUFF_MAX_MS) {
            // the CO2 stays up: people, not smoke; the room is at this level now
            in_puff  = false;
            baseline = co2;
        }
    }

    history[0] = history[1];
    history[1] = co2;

    if (puffs > 0 && !in_puff && now_ms - last_puff_ms > SMOKE_SESSION_GAP_MS) {
        end_session(now_ms);
    }
}

void smoke_button(int64_t now_ms) {
    last_button_ms = now_ms;
}

uint8_t smoke_puffs_now(void) {
    return puffs;
}
