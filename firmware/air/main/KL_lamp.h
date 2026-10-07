#ifndef KL_LAMP_H
#define KL_LAMP_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "KL_air_config.h"
#include "KL_status_led.h"

typedef enum {
    AIR_LEVEL_NONE = 0, // no measurement yet
    AIR_LEVEL_GREEN,
    AIR_LEVEL_YELLOW,
    AIR_LEVEL_RED,
} air_level_t;

/* The four leds of the traffic light in a task of their own. What they show, first
 * that applies: blinks of the white light (find the device, a logged cigarette), the
 * three blinks of a Wi-Fi connect, the calibration, provisioning and errors (white),
 * then the mode: the air level, off, or a light (white, warm, candle, custom colours). Night mode is off for all but the
 * blinks and provisioning. */
void lamp_setup(void);

/* colors: LAMP_MASK_* for LAMP_MODE_CUSTOM. fade: a change of the steady light (mode,
 * air level, night) fades over LAMP_FADE_MS instead of switching */
#define LAMP_FADE_MS 600
void lamp_set_mode(lamp_mode_t mode, uint8_t colors, bool fade);
void lamp_set_level(air_level_t level);

/* night mode: the leds stay off, only blinks (a press of the button, find the device)
 * and provisioning show */
void lamp_set_night(bool night);

// true while a led shows most of the time: the board warms the sensor more then
bool lamp_lit(void);

// count short flashes of the white light, then back to what it showed
void lamp_blink(uint8_t count);

// the fire alarm: red flashing, before everything else and also at night
void lamp_set_alarm(bool alarm);

// slow white blinking while a calibration runs
void lamp_set_calibrating(bool calibrating);

// the status of the core (KL_status_led.h), shown in white
void lamp_set_status(status_led_state state);
void lamp_wifi_connected(void);

const char *air_level_name(air_level_t level);

#ifdef __cplusplus
}
#endif

#endif /* KL_LAMP_H */
