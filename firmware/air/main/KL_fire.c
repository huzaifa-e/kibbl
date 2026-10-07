#include "KL_fire.h"

#include "cJSON.h"

#include "KL_buzzer.h"
#include "KL_events.h"
#include "KL_lamp.h"
#include "KL_serial.h"

#define SAMPLES_PER_MIN 30 // a reading every 2 s
#define HISTORY         (2 * SAMPLES_PER_MIN + 1)

static float co2s[HISTORY];
static float temps[HISTORY];
static int count = 0; // readings in the history, at most HISTORY
static int head  = 0; // where the next one goes

static bool alarm        = false;
static int64_t calm_since = 0;

// the reading ago samples back, 0 the newest
static int at(int ago) {
    return (head - 1 - ago + 2 * HISTORY) % HISTORY;
}

static void start_alarm(const char *why, float co2_rise, float temperature, float temp_rise) {
    alarm = true;
    DEBUG_F_ERROR("fire: %s (CO2 +%.0f ppm, %.1f °C, +%.1f °C)\n", why, co2_rise, temperature, temp_rise);
    lamp_set_alarm(true);
    buzzer_alarm(true);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "fire");
    cJSON_AddNumberToObject(json, "co2", (int)co2s[at(0)]);
    cJSON_AddNumberToObject(json, "co2Rise", (int)co2_rise);
    cJSON_AddNumberToObject(json, "temperature", (int)(temperature * 10) / 10.0);
    cJSON_AddNumberToObject(json, "temperatureRise", (int)(temp_rise * 10) / 10.0);
    events_push(json);
}

void fire_feed(float co2, float temperature, int64_t now_ms) {
    co2s[head]  = co2;
    temps[head] = temperature;
    head        = (head + 1) % HISTORY;
    if (count < HISTORY) {
        count++;
    }

    bool hot = temperature >= FIRE_TEMP_MAX;
    float co2_rise = 0, temp_rise = 0, temp_rate_before = 0;
    if (count > SAMPLES_PER_MIN) {
        co2_rise  = co2 - co2s[at(SAMPLES_PER_MIN)];
        temp_rise = temperature - temps[at(SAMPLES_PER_MIN)];
    }
    if (count == HISTORY) {
        temp_rate_before = temps[at(SAMPLES_PER_MIN)] - temps[at(2 * SAMPLES_PER_MIN)];
    }

    bool burning = co2_rise >= FIRE_CO2_RISE && temp_rise >= FIRE_TEMP_RISE;
    bool rising  = temp_rise >= FIRE_TEMP_RATE && temp_rate_before >= FIRE_TEMP_RATE;

    if (hot || burning || rising) {
        calm_since = now_ms;
        if (!alarm) {
            start_alarm(hot ? "the sensor is hot" : burning ? "CO2 and heat rise together" : "the heat rises fast", co2_rise, temperature, temp_rise);
        }
    } else if (alarm && now_ms - calm_since >= FIRE_CLEAR_MS) {
        alarm = false;
        DEBUG_F("fire: calm for %d min, alarm over\n", FIRE_CLEAR_MS / 60000);
        lamp_set_alarm(false);
        buzzer_alarm(false);
    }
}

bool fire_alarm(void) {
    return alarm;
}

void fire_silence(void) {
    if (alarm) {
        DEBUG_F("fire: silenced with the button\n");
        buzzer_alarm(false);
    }
}
