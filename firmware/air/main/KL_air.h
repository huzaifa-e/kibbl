#ifndef KL_AIR_H
#define KL_AIR_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "KL_air_config.h"
#include "KL_lamp.h"

#define CALIBRATE_PREPARE_MS (5 * 60 * 1000) // in fresh air before the sensor takes the value
#define CALIBRATE_FOLLOW_MS  (60 * 1000)
// after it the detectors wait this long: the device is carried back and settles in the room
#define CALIBRATE_SETTLE_MS  (15 * 60 * 1000)

typedef struct {
    bool valid;        // false until the first measurement, and while the sensor is missing
    uint16_t co2;      // ppm, the mean of the last 3 readings
    float temperature; // °C, corrected for the warmth of the board
    float humidity;    // %RH
    air_level_t level;
} air_state_t;

/* The measurement in a task of its own: the sensor every 2 s, the traffic light, the
 * fan in auto mode, the buzzer, and the smoke and window detectors. Runs without the
 * network. Retries a missing sensor every 30 s. */
void air_start(void);

void air_state(air_state_t *state);
bool air_sensor_ok(void);

// takes new settings: thresholds, lamp, fan, altitude, asc
void air_apply(const air_settings_t *settings);

/* Forced recalibration to ppm: blinks white for CALIBRATE_PREPARE_MS while the device
 * stands in fresh air, then the sensor takes the value. False while one runs. */
bool air_calibrate(uint16_t ppm);
bool air_calibrating(void);
// false while the detectors pause: during a calibration and CALIBRATE_SETTLE_MS after it
bool air_detecting(void);

/* Night mode, sent by the server on the schedule of the device: the lamp off, the buzzer
 * muted, the fan at most at nightFan. Not stored: a restart is day until the server
 * sends it again. */
void air_set_night(bool night);
bool air_night(void);

// a press of the button: a cigarette logged by hand
void air_button_pressed(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_AIR_H */
