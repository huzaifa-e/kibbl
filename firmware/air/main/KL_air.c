#include "KL_air.h"

#include "cJSON.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "KL_buzzer.h"
#include "KL_events.h"
#include "KL_fan.h"
#include "KL_fire.h"
#include "KL_scd30.h"
#include "KL_serial.h"
#include "KL_smoke.h"
#include "KL_status_led.h"
#include "KL_time.h"
#include "KL_window.h"

#define AIR_STACK_SIZE   4096
#define AIR_POLL_MS      500
#define SENSOR_RETRY_MS  (30 * 1000)
#define SENSOR_STALE_MS  (10 * 1000) // no reading for this long: the sensor is gone
#define MEAN_SAMPLES     3           // the traffic light shows the mean of these, as ESW0002
#define LEVEL_HYSTERESIS 50          // ppm below a threshold before the level goes down

static SemaphoreHandle_t state_mutex;
static air_state_t state = {0};
static bool sensor_ok    = false;

static air_settings_t settings;
static volatile bool settings_changed = false;

static volatile bool night = false;

static volatile uint16_t calibrate_ppm = 0; // > 0: a calibration runs
static int64_t calibrate_start         = 0;
static bool calibrate_sent             = false;

/* ----------------------------------------------------------------------- */

/* The board warms the sensor: by how much depends on the leds and the fan, measured
 * for ESW0002 (HeatCheck.cpp). */
static float corrected_temperature(float raw) {
    bool lit  = lamp_lit();
    bool fan  = fan_level_now() > 0;
    if (lit && fan) {
        return raw - 7;
    } else if (lit) {
        return raw - 12;
    } else if (fan) {
        return raw - 4;
    }
    return raw - 6;
}

static air_level_t level_of(uint16_t co2, air_level_t now) {
    uint16_t yellow = settings.yellow;
    uint16_t red    = settings.red;
    // going down needs LEVEL_HYSTERESIS below the threshold, so it does not flicker on it
    if (now == AIR_LEVEL_RED && co2 + LEVEL_HYSTERESIS > red) {
        return AIR_LEVEL_RED;
    }
    if (now == AIR_LEVEL_YELLOW && co2 + LEVEL_HYSTERESIS > yellow && co2 < red) {
        return AIR_LEVEL_YELLOW;
    }
    if (co2 >= red) {
        return AIR_LEVEL_RED;
    }
    if (co2 >= yellow) {
        return AIR_LEVEL_YELLOW;
    }
    return AIR_LEVEL_GREEN;
}

static void show_level(air_level_t level, air_level_t before) {
    lamp_set_level(level);
    fan_set_air_level(level);
    if (settings.buzzer && level > before && before != AIR_LEVEL_NONE) {
        buzzer_play(level == AIR_LEVEL_RED ? TONE_RED : TONE_YELLOW);
    }
    if (level != before) {
        DEBUG("air: %s\n", air_level_name(level));
    }
}

static void calibrate_step(int64_t now) {
    if (calibrate_ppm == 0) {
        return;
    }
    if (!calibrate_sent && now - calibrate_start >= CALIBRATE_PREPARE_MS) {
        buzzer_play(TONE_CALIBRATE_START);
        if (!scd30_force_calibration(calibrate_ppm)) {
            DEBUG_F_ERROR("air: calibration not taken by the sensor\n");
        }
        calibrate_sent = true;
    } else if (calibrate_sent && now - calibrate_start >= CALIBRATE_PREPARE_MS + CALIBRATE_FOLLOW_MS) {
        buzzer_play(TONE_CALIBRATE_END);
        lamp_set_calibrating(false);
        calibrate_ppm = 0;
    }
}

static void air_task(void *pvParams) {
    float samples[MEAN_SAMPLES] = {0};
    int sample_count            = 0;
    int64_t last_reading        = millis();
    int64_t last_try            = millis();

    while (1) {
        delay_ms(AIR_POLL_MS);
        int64_t now = millis();

        if (settings_changed) {
            settings_changed = false;
            config_air_settings(&settings);
            scd30_set_altitude(settings.altitude);
            scd30_set_asc(settings.asc);
            if (night) {
                fan_set_cap(settings.night_fan);
            }
        }

        calibrate_step(now);

        if (!sensor_ok) {
            if (now - last_try >= SENSOR_RETRY_MS) {
                last_try  = now;
                sensor_ok = scd30_setup(settings.altitude, settings.asc);
                if (sensor_ok) {
                    set_status_led(LED_OFF);
                    last_reading = now;
                }
            }
            continue;
        }

        scd30_values_t values;
        if (!scd30_read(&values)) {
            if (now - last_reading > SENSOR_STALE_MS) {
                DEBUG_F_ERROR("air: no reading for %d s, sensor lost\n", SENSOR_STALE_MS / 1000);
                sensor_ok = false;
                last_try  = now;
                set_status_led(LED_ERROR);
                xSemaphoreTake(state_mutex, portMAX_DELAY);
                state.valid = false;
                xSemaphoreGive(state_mutex);
            }
            continue;
        }
        last_reading = now;

        // the detectors take every reading, the light the mean
        if (settings.smoke) {
            smoke_feed(values.co2, settings.puff_rise, now);
        }
        window_feed(values.co2, values.temperature, now);
        fire_feed(values.co2, values.temperature, now);

        samples[sample_count % MEAN_SAMPLES] = values.co2;
        sample_count++;
        int n     = sample_count < MEAN_SAMPLES ? sample_count : MEAN_SAMPLES;
        float sum = 0;
        for (int i = 0; i < n; i++) {
            sum += samples[i];
        }
        uint16_t co2 = (uint16_t)(sum / n + 0.5f);

        // the light first: the correction of the temperature depends on it
        air_level_t before = state.level;
        air_level_t level  = level_of(co2, before);
        show_level(level, before);

        xSemaphoreTake(state_mutex, portMAX_DELAY);
        state.valid       = true;
        state.co2         = co2;
        state.temperature = corrected_temperature(values.temperature);
        state.humidity    = values.humidity;
        state.level       = level;
        xSemaphoreGive(state_mutex);

        DEBUG("air: %u ppm (%.0f), %.1f °C (sensor %.1f), %.1f %%\n", co2, values.co2, corrected_temperature(values.temperature),
              values.temperature, values.humidity);
    }
}

/* ----------------------------------------------------------------------- */

void air_start(void) {
    state_mutex = xSemaphoreCreateMutex();
    config_air_settings(&settings);

    lamp_set_mode((lamp_mode_t)settings.lamp_mode, settings.lamp_colors, settings.lamp_fade);
    fan_configure(&settings);

    sensor_ok = scd30_setup(settings.altitude, settings.asc);
    if (!sensor_ok) {
        // still online: the app shows the error, the task tries again every 30 s
        set_status_led(LED_ERROR);
    }

    xTaskCreate(air_task, "air", AIR_STACK_SIZE, NULL, 4, NULL);
}

void air_state(air_state_t *out) {
    xSemaphoreTake(state_mutex, portMAX_DELAY);
    *out = state;
    xSemaphoreGive(state_mutex);
}

bool air_sensor_ok(void) {
    return sensor_ok;
}

void air_apply(const air_settings_t *new_settings) {
    lamp_set_mode((lamp_mode_t)new_settings->lamp_mode, new_settings->lamp_colors, new_settings->lamp_fade);
    fan_configure(new_settings);
    settings_changed = true; // the air task takes the rest, it owns the sensor
}

bool air_calibrate(uint16_t ppm) {
    if (calibrate_ppm != 0 || ppm < 400 || ppm > 2000) {
        return false;
    }
    calibrate_start = millis();
    calibrate_sent  = false;
    calibrate_ppm   = ppm;
    lamp_set_calibrating(true);
    buzzer_play(TONE_CALIBRATE_START);
    DEBUG_F("air: calibration to %u ppm in %d min, keep the device in fresh air\n", ppm, CALIBRATE_PREPARE_MS / 60000);
    return true;
}

bool air_calibrating(void) {
    return calibrate_ppm != 0;
}

void air_set_night(bool on) {
    night = on;
    lamp_set_night(on);
    buzzer_set_muted(on);
    fan_set_cap(on ? settings.night_fan : 100);
    DEBUG_F("night mode %s\n", on ? "on" : "off");
}

bool air_night(void) {
    return night;
}

void air_button_pressed(void) {
    // during a fire alarm the button silences it, nothing else
    if (fire_alarm()) {
        fire_silence();
        return;
    }
    DEBUG_F("button: cigarette logged\n");
    int64_t now = millis();
    smoke_button(now);
    lamp_blink(2);
    buzzer_play(TONE_LOGGED);

    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "event", "smoke");
    cJSON_AddStringToObject(json, "source", "button");
    events_push(json);
}
