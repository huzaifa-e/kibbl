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

/* Matches the temperature to a thermometer the person trusts, in tenths of °C (-50..50), on
 * top of the correction for the warmth of the board. In a key of its own: the settings
 * blob keeps its layout, so an update keeps the settings. */
int16_t config_temp_adjust(void);
bool config_set_temp_adjust(int16_t tenths);
// "tempAdjust" in °C, -5..5, rounded to tenths; true and *tenths kept when left out
bool config_temp_adjust_from_json(const cJSON *json, int16_t *tenths);

/* Matches the humidity to a hygrometer the person trusts, as a factor in thousandths
 * (700..1300). A factor rather than points: the error comes from converting the humidity
 * from the warm sensor to the room, and that scales with the value. Its own key too. */
uint16_t config_humidity_factor(void);
bool config_set_humidity_factor(uint16_t permille);
// "humidityFactor" 0.7..1.3; true and *permille kept when left out
bool config_humidity_factor_from_json(const cJSON *json, uint16_t *permille);

/* The reminder to air: a beep every remind_minutes (0: off) while the air is at remind_level
 * or worse (AIR_LEVEL_YELLOW 2, AIR_LEVEL_RED 3 of KL_lamp.h). Its own key as well. */
typedef struct {
    uint8_t minutes;
    uint8_t level;
} air_remind_t;
air_remind_t config_air_remind(void);
bool config_set_air_remind(air_remind_t remind);
// "remindMinutes" 0..60, "remindFrom" "yellow" or "red"; true and *remind kept for keys left out
bool config_air_remind_from_json(const cJSON *json, air_remind_t *remind);

/* The quiet speed of the fan in %: the lowest it runs at, while the air is fresh in auto and
 * all the time in a bedroom. Which speed is silent depends on the fan, so it is a setting.
 * Its own key. */
#define FAN_QUIET_MIN 10
#define FAN_QUIET_MAX 60
uint8_t config_fan_quiet(void);
bool config_set_fan_quiet(uint8_t percent);
// "quietLevel" FAN_QUIET_MIN..FAN_QUIET_MAX; true and *percent kept when left out
bool config_fan_quiet_from_json(const cJSON *json, uint8_t *percent);

/* The pwm frequency of the fan in Hz: which one a plain 2-wire fan runs quietly at part speed
 * depends on the fan, so it is a setting too. Its own key. */
#define FAN_FREQ_MIN     10
#define FAN_FREQ_MAX     30000
#define FAN_FREQ_DEFAULT 25
uint32_t config_fan_freq(void);
bool config_set_fan_freq(uint32_t hz);
// "freqHz" FAN_FREQ_MIN..FAN_FREQ_MAX; true and *hz kept when left out
bool config_fan_freq_from_json(const cJSON *json, uint32_t *hz);

/* What the room the device stands in is used for, set by the server from the room's kind:
 * a bathroom beeps after a shower until the humidity is back, a bedroom keeps the light off
 * and beeps only for a risk to health. Its own key. */
typedef enum {
    AIR_ROOM_NORMAL = 0,
    AIR_ROOM_BATHROOM,
    AIR_ROOM_BEDROOM,
} air_room_t;
air_room_t config_air_room(void);
bool config_set_air_room(air_room_t room);
// "room" "normal", "bathroom" or "bedroom"; true and *room kept when left out
bool config_air_room_from_json(const cJSON *json, air_room_t *room);

/* Fresh air as the device saw it at the open window while it calibrated: the lowest and
 * highest CO2 (calibrated ppm). The window detection takes it as "open". Its own key. */
typedef struct {
    uint16_t min;
    uint16_t max;
} air_fresh_t;
air_fresh_t config_air_fresh(void);
bool config_set_air_fresh(air_fresh_t fresh);

void config_air_settings(air_settings_t *settings);
bool config_set_air_settings(const air_settings_t *settings);

/* Apply the keys present in json onto settings and range-check them; keys left out keep
 * their value. False when a key is present but invalid, settings unchanged then.
 * air: yellow, red, buzzer, asc, altitude, smoke, puffRise, nightFan (and tempAdjust, above)
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
