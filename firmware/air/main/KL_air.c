#include "KL_air.h"

#include <math.h>

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
#include "KL_stream.h"
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

/* ----------------------------------------------------------------------- */

/* What the room is used for (config_air_room, set by the server from the kind of the room).
 * A bathroom: a shower is a quick rise of the humidity; once it stops rising the device
 * beeps every few minutes until the humidity is back to where it was before. A bedroom: the
 * light stays off, the traffic light, the reminder and the window do not beep, only a risk
 * to health does, also at night. The fire alarm sounds in every room. */
#define SHOWER_SAMPLE_MS (30 * 1000) // a humidity sample every 30 s
#define SHOWER_SAMPLES   40          // 20 minutes of them
#define SHOWER_RISE      8.0f        // percentage points within them: a shower runs
#define SHOWER_MIN_RH    60.0f       // and at least this humid
#define SHOWER_PEAK_MS   (2 * 60 * 1000)          // no new peak for this long: the shower is over, the beeps start
#define SHOWER_BEEP_MS   (2 * 60 * 1000)
#define SHOWER_BACK      2.0f                     // points above the humidity before it: back to it
#define SHOWER_MAX_MS    (3 * 3600 * 1000LL)      // a forgotten one ends anyway

#define HEALTH_COLD    15.0f // °C: the airways cool down, colds become likely (WHO: 18 indoors)
#define HEALTH_HOT     30.0f // °C: heat stress
#define HEALTH_HUMID   80.0f // %: water on the walls, mould
#define HEALTH_CO2     2000  // ppm: unacceptable after the German Environment Agency
#define HEALTH_BEEP_MS (30 * 60 * 1000)

static air_room_t room                = AIR_ROOM_NORMAL;
static volatile bool room_changed     = false;
static float rh_samples[SHOWER_SAMPLES];
static int rh_count                   = 0;
static int64_t rh_last                = 0;
static bool shower                    = false;
static float shower_before, shower_peak;
static int64_t shower_start, shower_peak_at, shower_beep;
static int64_t health_beep            = -HEALTH_BEEP_MS;

static const char *room_name(air_room_t r) {
    return r == AIR_ROOM_BATHROOM ? "bathroom" : r == AIR_ROOM_BEDROOM ? "bedroom" : "normal";
}

// the fan at most: the quiet speed in a bedroom, the night setting at night, else as set
static void apply_fan_cap(void) {
    fan_set_cap(room == AIR_ROOM_BEDROOM ? config_fan_quiet() : night ? settings.night_fan : 100);
}

static void room_apply(void) {
    room     = config_air_room();
    shower   = false;
    rh_count = 0;
    lamp_set_night(night || room == AIR_ROOM_BEDROOM);
    apply_fan_cap();
    DEBUG_F("air: room %s\n", room_name(room));
}

static void shower_step(float rh, int64_t now) {
    if (room != AIR_ROOM_BATHROOM) {
        return;
    }
    if (rh_count == 0 || now - rh_last >= SHOWER_SAMPLE_MS) {
        rh_samples[rh_count % SHOWER_SAMPLES] = rh;
        rh_count++;
        rh_last = now;
    }
    if (!shower) {
        int n = rh_count < SHOWER_SAMPLES ? rh_count : SHOWER_SAMPLES;
        if (n < 4) {
            return;
        }
        float lo = rh_samples[0];
        for (int i = 1; i < n; i++) {
            lo = rh_samples[i] < lo ? rh_samples[i] : lo;
        }
        if (rh - lo >= SHOWER_RISE && rh >= SHOWER_MIN_RH) {
            shower         = true;
            shower_before  = lo;
            shower_peak    = rh;
            shower_start   = now;
            shower_peak_at = now;
            shower_beep    = 0;
            DEBUG_F("air: a shower, the humidity rose from %.0f to %.0f %%\n", lo, rh);
        }
        return;
    }
    if (rh > shower_peak) {
        shower_peak    = rh;
        shower_peak_at = now;
    }
    if (rh <= shower_before + SHOWER_BACK || now - shower_start > SHOWER_MAX_MS) {
        shower   = false;
        rh_count = 0; // the next shower is measured from the humidity after this one
        DEBUG_F("air: the humidity is back to %.0f %% after the shower\n", rh);
        return;
    }
    if (now - shower_peak_at >= SHOWER_PEAK_MS && now - shower_beep >= SHOWER_BEEP_MS) {
        shower_beep = now;
        buzzer_play(TONE_SHOWER);
        DEBUG("air: still %.0f %% after the shower (%.0f %% before): open the window or the door\n", rh, shower_before);
    }
}

static void health_step(float t, float rh, uint16_t co2, int64_t now) {
    if (room != AIR_ROOM_BEDROOM || !(t < HEALTH_COLD || t > HEALTH_HOT || rh > HEALTH_HUMID || co2 >= HEALTH_CO2)) {
        return;
    }
    // at most every HEALTH_BEEP_MS, also when a value goes back and forth over its line
    if (now - health_beep >= HEALTH_BEEP_MS) {
        health_beep = now;
        buzzer_play_urgent(TONE_HEALTH);
        DEBUG_F("air: a risk to health in the bedroom (%.1f °C, %.0f %%, %u ppm)\n", t, rh, co2);
    }
}

void air_room_changed(void) {
    room_changed = true; // the air task takes it
}

bool air_room_quiet(void) {
    return room == AIR_ROOM_BEDROOM;
}

static volatile uint16_t calibrate_ppm = 0; // > 0: a calibration runs
static int64_t calibrate_start         = 0;
static int64_t detectors_from          = 0; // millis() from which smoke, window and fire rates run again

/* After a calibration the device may be carried back from outside: the detectors wait until
 * its readings are steady (SETTLE_STEADY_MS within these ranges), at most CALIBRATE_SETTLE_MS.
 * A device that stayed where it calibrated is steady after 3 minutes. */
#define SETTLE_TEMP_RANGE 0.3f
#define SETTLE_CO2_RANGE  30.0f
static int64_t steady_since = 0;
static float steady_t_lo, steady_t_hi, steady_c_lo, steady_c_hi;

static void settle_step(float co2, float temperature, int64_t now) {
    if (calibrate_ppm != 0 || now >= detectors_from) {
        return;
    }
    bool restart = steady_since == 0;
    if (!restart) {
        float t_lo = temperature < steady_t_lo ? temperature : steady_t_lo;
        float t_hi = temperature > steady_t_hi ? temperature : steady_t_hi;
        float c_lo = co2 < steady_c_lo ? co2 : steady_c_lo;
        float c_hi = co2 > steady_c_hi ? co2 : steady_c_hi;
        restart    = t_hi - t_lo > SETTLE_TEMP_RANGE || c_hi - c_lo > SETTLE_CO2_RANGE;
        steady_t_lo = t_lo, steady_t_hi = t_hi, steady_c_lo = c_lo, steady_c_hi = c_hi;
    }
    if (restart) {
        steady_since = now;
        steady_t_lo = steady_t_hi = temperature;
        steady_c_lo = steady_c_hi = co2;
    } else if (now - steady_since >= SETTLE_STEADY_MS) {
        detectors_from = now;
        DEBUG_F("air: readings steady for %d min, the detectors run again\n", SETTLE_STEADY_MS / 60000);
    }
}
static bool calibrate_sent             = false;

/* The CO2 at the open window in the last minutes before the calibration step: the home's
 * fresh air, kept as the reference for open windows (KL_window) */
#define FRESH_SAMPLES 60 // 2 minutes of readings
#define FRESH_MEAN_N  15 // the last 30 s: what the sensor is set to
static float fresh_samples[FRESH_SAMPLES];
static int fresh_count = 0;
static volatile bool detecting         = true; // false while smoke, window and fire rates pause

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

// saturation vapour pressure over water, hPa (Magnus)
static float saturation(float t) {
    return 6.112f * expf(17.62f * t / (243.12f + t));
}

/* The sensor measures the relative humidity at its own, warmer temperature: the same water
 * in the cooler room air is a higher relative humidity. */
static float room_humidity(float rh_sensor, float t_sensor, float t_room) {
    float rh = rh_sensor * saturation(t_sensor) / saturation(t_room);
    return rh > 100 ? 100 : rh < 0 ? 0 : rh;
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

/* While the air stays bad, a beep every few minutes until a window is open: the room needs
 * air. The buzzer is muted at night (KL_buzzer), so the reminder is too. */
static int64_t remind_last = 0;

static void remind_to_air(air_level_t level, int64_t now) {
    air_remind_t remind = config_air_remind();
    if (remind.minutes == 0 || room == AIR_ROOM_BEDROOM || level < remind.level || window_open() || calibrate_ppm != 0) {
        remind_last = now; // the first reminder comes a full interval after the air got bad
        return;
    }
    if (now - remind_last >= (int64_t)remind.minutes * 60 * 1000) {
        remind_last = now;
        buzzer_play(level == AIR_LEVEL_RED ? TONE_RED : TONE_YELLOW);
        DEBUG("air: reminder to air (%s)\n", air_level_name(level));
    }
}

static void show_level(air_level_t level, air_level_t before, uint16_t co2) {
    lamp_set_level(level);
    fan_set_air(level, co2);
    if (settings.buzzer && room != AIR_ROOM_BEDROOM && level > before && before != AIR_LEVEL_NONE) {
        buzzer_play(level == AIR_LEVEL_RED ? TONE_RED : TONE_YELLOW);
    }
    remind_to_air(level, millis());
    if (level != before) {
        DEBUG("air: %s\n", air_level_name(level));
    }
}

// the readings before the step, shifted by what the calibration changes: calibrated ppm
static void remember_fresh_air(void) {
    int n = fresh_count < FRESH_SAMPLES ? fresh_count : FRESH_SAMPLES;
    if (n < FRESH_MEAN_N) {
        return;
    }
    float sum = 0, lo = 1e9f, hi = 0;
    for (int i = 0; i < n; i++) {
        float v = fresh_samples[i];
        lo      = v < lo ? v : lo;
        hi      = v > hi ? v : hi;
    }
    for (int i = 0; i < FRESH_MEAN_N; i++) {
        sum += fresh_samples[(fresh_count - 1 - i) % FRESH_SAMPLES];
    }
    float shift   = calibrate_ppm - sum / FRESH_MEAN_N;
    air_fresh_t f = {.min = (uint16_t)(lo + shift + 0.5f), .max = (uint16_t)(hi + shift + 0.5f)};
    if (config_set_air_fresh(f)) {
        window_set_fresh(f.min, f.max);
        DEBUG_F("air: fresh air at the window %u-%u ppm, the reference for open windows\n", f.min, f.max);
        stream_announce(); // the hello again: the server and the app show the new range
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
        } else {
            remember_fresh_air();
        }
        calibrate_sent = true;
    } else if (calibrate_sent && now - calibrate_start >= CALIBRATE_PREPARE_MS + CALIBRATE_FOLLOW_MS) {
        buzzer_play(TONE_CALIBRATE_END);
        lamp_set_calibrating(false);
        calibrate_ppm  = 0;
        detectors_from = now + CALIBRATE_SETTLE_MS;
        steady_since   = 0;
        DEBUG_F("air: calibrated; the detectors start again in %d min\n", CALIBRATE_SETTLE_MS / 60000);
    }
}

static void air_task(void *pvParams) {
    float samples[MEAN_SAMPLES] = {0};
    int sample_count            = 0;
    int64_t last_reading        = millis();
    int64_t last_try            = millis();
    bool detected_before        = true;
    int heat_before             = -1; // the lamp and the fan in tens of %, as they warm the board

    while (1) {
        delay_ms(AIR_POLL_MS);
        int64_t now = millis();

        if (room_changed) {
            room_changed = false;
            room_apply();
        }

        if (settings_changed) {
            settings_changed = false;
            config_air_settings(&settings);
            scd30_set_altitude(settings.altitude);
            scd30_set_asc(settings.asc);
            apply_fan_cap();
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
                fan_set_air(AIR_LEVEL_NONE, 0); // auto runs at its level until a reading comes back
                xSemaphoreTake(state_mutex, portMAX_DELAY);
                state.valid = false;
                xSemaphoreGive(state_mutex);
            }
            continue;
        }
        last_reading = now;

        /* the detectors take every reading, the light the mean. While a calibration runs and
         * the device is carried around they pause, and start over after it */
        settle_step(values.co2, values.temperature, now);
        bool detecting_now = calibrate_ppm == 0 && now >= detectors_from;
        if (detecting_now && !detected_before) {
            smoke_reset();
            window_reset();
        }
        detected_before = detecting_now;
        detecting       = detecting_now;
        int heat = (lamp_lit() ? 100 : 0) + fan_level_now() / 10;
        if (heat != heat_before) {
            window_heat_changed(now);
            heat_before = heat;
        }
        if (detecting_now) {
            if (settings.smoke) {
                smoke_feed(values.co2, settings.puff_rise, window_open(), now);
            }
            window_feed(values.co2, values.temperature, now);
        }
        // the last 2 minutes before the calibration step: the fresh air at the window
        if (calibrate_ppm != 0 && !calibrate_sent && now - calibrate_start >= CALIBRATE_PREPARE_MS - 2 * 60 * 1000) {
            fresh_samples[fresh_count % FRESH_SAMPLES] = values.co2;
            fresh_count++;
        }
        fire_feed(values.co2, values.temperature, now, detecting_now); // 60 °C at the sensor counts always

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
        show_level(level, before, co2);

        xSemaphoreTake(state_mutex, portMAX_DELAY);
        state.valid       = true;
        state.co2         = co2;
        // the warmth of the board, then the person's reference thermometer
        state.temperature = corrected_temperature(values.temperature) + config_temp_adjust() / 10.0f;
        state.humidity    = room_humidity(values.humidity, values.temperature, state.temperature) * config_humidity_factor() / 1000.0f;
        if (state.humidity > 100) {
            state.humidity = 100;
        }
        state.level       = level;
        float temperature = state.temperature;
        float humidity    = state.humidity;
        xSemaphoreGive(state_mutex);

        shower_step(humidity, now);
        health_step(temperature, humidity, co2, now);

        DEBUG("air: %u ppm (%.0f), %.1f °C (sensor %.1f), %.1f %% (sensor %.1f)\n", co2, values.co2, state.temperature, values.temperature,
              state.humidity, values.humidity);
    }
}

/* ----------------------------------------------------------------------- */

void air_start(void) {
    state_mutex = xSemaphoreCreateMutex();
    config_air_settings(&settings);

    lamp_set_mode((lamp_mode_t)settings.lamp_mode, settings.lamp_colors, settings.lamp_fade);
    fan_configure(&settings);
    fan_set_quiet(config_fan_quiet());
    room_apply();
    air_fresh_t fresh = config_air_fresh();
    window_set_fresh(fresh.min, fresh.max);

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
    fresh_count     = 0;
    calibrate_ppm   = ppm;
    lamp_set_calibrating(true);
    buzzer_play(TONE_CALIBRATE_START);
    DEBUG_F("air: calibration to %u ppm in %d min, keep the device in fresh air\n", ppm, CALIBRATE_PREPARE_MS / 60000);
    return true;
}

bool air_calibrating(void) {
    return calibrate_ppm != 0;
}

uint32_t air_settle_seconds(void) {
    if (calibrate_ppm != 0) {
        return (uint32_t)(CALIBRATE_SETTLE_MS / 1000); // after it: at most this
    }
    int64_t left = detectors_from - millis();
    if (left <= 0) {
        return 0;
    }
    // a steady device is done SETTLE_STEADY_MS after it got steady, sooner than the limit
    if (steady_since != 0) {
        int64_t steady_left = steady_since + SETTLE_STEADY_MS - millis();
        left                = steady_left < left ? steady_left : left;
    }
    return left > 0 ? (uint32_t)(left / 1000) : 0;
}

bool air_detecting(void) {
    return calibrate_ppm == 0 && detecting;
}

void air_set_night(bool on) {
    night = on;
    lamp_set_night(on || room == AIR_ROOM_BEDROOM);
    buzzer_set_muted(on);
    apply_fan_cap();
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
