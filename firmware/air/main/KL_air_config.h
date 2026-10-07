#ifndef KL_AIR_CONFIG_H
#define KL_AIR_CONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"

typedef enum {
    LAMP_MODE_TRAFFIC = 0, // green, yellow, red by the CO2
    LAMP_MODE_OFF,
    LAMP_MODE_WHITE,
    LAMP_MODE_WARM,   // white and amber: a warmer light, as a lamp
    LAMP_MODE_CANDLE, // amber and red
    LAMP_MODE_CUSTOM, // the colours of lamp_colors
} lamp_mode_t;

typedef enum {
    FAN_MODE_OFF = 0,
    FAN_MODE_ON,
    FAN_MODE_PULSE, // on for onSeconds, off for offSeconds
    FAN_MODE_AUTO,  // the speed follows the CO2, up to the level at red
} fan_mode_t;

typedef struct {
    uint16_t yellow;    // ppm from which the light is yellow
    uint16_t red;       // ppm from which the light is red
    bool buzzer;        // beeps when yellow or red is reached
    bool asc;           // automatic self-calibration of the sensor (needs fresh air every day)
    uint16_t altitude;  // m above sea level, for the pressure compensation of the sensor
    uint8_t lamp_mode;  // lamp_mode_t
    uint8_t lamp_colors; // LAMP_MASK_* of KL_ioexp.h for the custom mode: the leds are not RGB,
                         // four fixed colours (red, green, amber, white) on or off
    bool lamp_fade;      // fades from one look to the next instead of switching
    uint8_t fan_mode;   // fan_mode_t
    uint8_t fan_level;  // 1-100 % pwm
    uint16_t fan_on_s;  // pulse mode
    uint16_t fan_off_s; // pulse mode
    bool smoke;         // detects cigarettes from the CO2 of exhaled smoke
    uint16_t puff_rise; // ppm above the baseline that counts as a puff
    uint8_t night_fan;  // % the fan runs at most in night mode, 0 = off
} air_settings_t;

// reads the stored settings, the defaults when none are stored; after nvs_setup()
void config_air_load(void);

// forgets the stored settings (factory reset)
void config_air_reset(void);

void config_air_settings(air_settings_t *settings);
bool config_set_air_settings(const air_settings_t *settings);

/* Apply the keys present in json onto settings and range-check them; keys left out keep
 * their value. False when a key is present but invalid, settings unchanged then.
 * air: yellow, red, buzzer, asc, altitude, smoke, puffRise, nightFan
 * fan: mode (off, on, pulse, auto), level, onSeconds, offSeconds
 * lamp: mode (traffic, off, white, warm, candle, custom), colors (of red, green, yellow, white), fade */
bool config_air_from_json(const cJSON *json, air_settings_t *settings);
bool config_fan_from_json(const cJSON *json, air_settings_t *settings);
bool config_lamp_from_json(const cJSON *json, air_settings_t *settings);

void config_air_to_json(const air_settings_t *settings, cJSON *json);
void config_fan_to_json(const air_settings_t *settings, cJSON *json);
void config_lamp_to_json(const air_settings_t *settings, cJSON *json);

#ifdef __cplusplus
}
#endif

#endif /* KL_AIR_CONFIG_H */
