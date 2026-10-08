#include "KL_air_config.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_commands.h"
#include "KL_ioexp.h"
#include "KL_nvs.h"

#define NVS_AIR        "AIR"
#define NVS_TEMP_ADJUST "TEMP_ADJ" // tenths of °C + 1000
#define NVS_HUM_FACTOR  "HUM_FACT" // thousandths
#define NVS_REMIND      "REMIND"   // minutes | level << 8
#define NVS_ROOM        "ROOM"     // air_room_t
#define NVS_FAN_QUIET   "FANQUIET" // %
#define NVS_FAN_FREQ    "FANFREQ"  // Hz
#define NVS_FRESH       "FRESH"    // min | max << 16, ppm
#define REMIND_YELLOW   2          // AIR_LEVEL_YELLOW
#define REMIND_RED      3          // AIR_LEVEL_RED

static SemaphoreHandle_t air_config_mutex;

static air_settings_t air_settings;
static int16_t temp_adjust      = 0;
static uint16_t humidity_factor = 1000;
// every 5 minutes from red ("air now"), after a request of the user
static air_remind_t remind = {.minutes = 5, .level = REMIND_RED};
static air_room_t room       = AIR_ROOM_NORMAL;
static uint8_t fan_quiet     = 25;
static uint32_t fan_freq     = FAN_FREQ_DEFAULT;
static const char *room_names[] = {"normal", "bathroom", "bedroom"};
// outside air before a calibration recorded the home's own: about 420 ppm
static air_fresh_t fresh = {.min = 400, .max = 460};

/* The thresholds of ESW0002 (the original Conny firmware): 1000 and 2000 ppm after the
 * guidance of the German Environment Agency. The fan draws room air past the sensor and
 * cools the board: ESW0002 ran it always on, here it follows the CO2 (auto), slow in
 * fresh air and up to full at red. */
static const air_settings_t air_defaults = {
    .yellow    = 1000,
    .red       = 2000,
    .buzzer    = false,
    .asc       = false,
    .altitude  = 127,
    .lamp_mode   = LAMP_MODE_TRAFFIC,
    .lamp_colors = LAMP_MASK_WHITE | LAMP_MASK_YELLOW,
    .lamp_fade   = true,
    .fan_mode  = FAN_MODE_AUTO,
    .fan_level = 100,
    .fan_on_s  = 60,
    .fan_off_s = 240,
    .smoke     = true,
    .puff_rise = 150,
    .night_fan = 100,
};

static const char *lamp_modes[] = {"traffic", "off", "white", "warm", "candle", "custom"};
// by bit of LAMP_MASK_*
static const char *lamp_colors[] = {"red", "green", "yellow", "white"};
static const char *fan_modes[]  = {"off", "on", "pulse", "auto"};

/* ----------------------------------------------------------------------- */

void config_air_load(void) {
    air_config_mutex = xSemaphoreCreateMutex();

    uint32_t stored_adjust = 1000;
    if (nvs_queue_job(NVS_TEMP_ADJUST, &stored_adjust, 0, UINT32_T, READ) && stored_adjust >= 950 && stored_adjust <= 1050) {
        temp_adjust = (int16_t)stored_adjust - 1000;
    }

    uint32_t stored_factor = 1000;
    if (nvs_queue_job(NVS_HUM_FACTOR, &stored_factor, 0, UINT32_T, READ) && stored_factor >= 700 && stored_factor <= 1300) {
        humidity_factor = (uint16_t)stored_factor;
    }

    uint32_t stored_remind = 0;
    if (nvs_queue_job(NVS_REMIND, &stored_remind, 0, UINT32_T, READ)) {
        uint8_t minutes = stored_remind & 0xff;
        uint8_t level   = (stored_remind >> 8) & 0xff;
        if (minutes <= 60 && (level == REMIND_YELLOW || level == REMIND_RED)) {
            remind = (air_remind_t){.minutes = minutes, .level = level};
        }
    }

    uint32_t stored_quiet = 0;
    if (nvs_queue_job(NVS_FAN_QUIET, &stored_quiet, 0, UINT32_T, READ) && stored_quiet >= FAN_QUIET_MIN && stored_quiet <= FAN_QUIET_MAX) {
        fan_quiet = (uint8_t)stored_quiet;
    }

    uint32_t stored_freq = 0;
    if (nvs_queue_job(NVS_FAN_FREQ, &stored_freq, 0, UINT32_T, READ) && stored_freq >= FAN_FREQ_MIN && stored_freq <= FAN_FREQ_MAX) {
        fan_freq = stored_freq;
    }

    uint32_t stored_room = 0;
    if (nvs_queue_job(NVS_ROOM, &stored_room, 0, UINT32_T, READ) && stored_room <= AIR_ROOM_BEDROOM) {
        room = (air_room_t)stored_room;
    }

    uint32_t stored_fresh = 0;
    if (nvs_queue_job(NVS_FRESH, &stored_fresh, 0, UINT32_T, READ)) {
        air_fresh_t f = {.min = stored_fresh & 0xffff, .max = stored_fresh >> 16};
        if (f.min >= 300 && f.max <= 800 && f.min <= f.max) {
            fresh = f;
        }
    }

    if (!nvs_queue_job(NVS_AIR, &air_settings, sizeof(air_settings), BLOB, READ)) {
        air_settings = air_defaults;
    }
}

void config_air_reset(void) {
    nvs_remove_key(NVS_AIR);
    nvs_remove_key(NVS_TEMP_ADJUST);
    nvs_remove_key(NVS_HUM_FACTOR);
    nvs_remove_key(NVS_REMIND);
    nvs_remove_key(NVS_ROOM);
    nvs_remove_key(NVS_FAN_QUIET);
    nvs_remove_key(NVS_FAN_FREQ);
    nvs_remove_key(NVS_FRESH);
}

int16_t config_temp_adjust(void) {
    return temp_adjust;
}

bool config_set_temp_adjust(int16_t tenths) {
    if (tenths < -50 || tenths > 50) {
        return false;
    }
    temp_adjust     = tenths;
    uint32_t stored = (uint32_t)(tenths + 1000);
    return nvs_queue_job(NVS_TEMP_ADJUST, &stored, 0, UINT32_T, WRITE);
}

bool config_temp_adjust_from_json(const cJSON *json, int16_t *tenths) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, "tempAdjust");
    if (item == NULL) {
        return true;
    }
    if (!cJSON_IsNumber(item) || item->valuedouble < -5.0 || item->valuedouble > 5.0) {
        return false;
    }
    double v = item->valuedouble * 10.0;
    *tenths  = (int16_t)(v < 0 ? v - 0.5 : v + 0.5);
    return true;
}

uint16_t config_humidity_factor(void) {
    return humidity_factor;
}

bool config_set_humidity_factor(uint16_t permille) {
    if (permille < 700 || permille > 1300) {
        return false;
    }
    humidity_factor = permille;
    uint32_t stored = permille;
    return nvs_queue_job(NVS_HUM_FACTOR, &stored, 0, UINT32_T, WRITE);
}

bool config_humidity_factor_from_json(const cJSON *json, uint16_t *permille) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, "humidityFactor");
    if (item == NULL) {
        return true;
    }
    if (!cJSON_IsNumber(item) || item->valuedouble < 0.7 || item->valuedouble > 1.3) {
        return false;
    }
    *permille = (uint16_t)(item->valuedouble * 1000.0 + 0.5);
    return true;
}

air_fresh_t config_air_fresh(void) {
    return fresh;
}

bool config_set_air_fresh(air_fresh_t value) {
    if (value.min < 300 || value.max > 800 || value.min > value.max) {
        return false;
    }
    fresh           = value;
    uint32_t stored = value.min | ((uint32_t)value.max << 16);
    return nvs_queue_job(NVS_FRESH, &stored, 0, UINT32_T, WRITE);
}

air_remind_t config_air_remind(void) {
    return remind;
}

bool config_set_air_remind(air_remind_t value) {
    if (value.minutes > 60 || (value.level != REMIND_YELLOW && value.level != REMIND_RED)) {
        return false;
    }
    remind          = value;
    uint32_t stored = value.minutes | ((uint32_t)value.level << 8);
    return nvs_queue_job(NVS_REMIND, &stored, 0, UINT32_T, WRITE);
}

uint32_t config_fan_freq(void) {
    return fan_freq;
}

bool config_set_fan_freq(uint32_t hz) {
    if (hz < FAN_FREQ_MIN || hz > FAN_FREQ_MAX) {
        return false;
    }
    fan_freq = hz;
    return nvs_queue_job(NVS_FAN_FREQ, &hz, 0, UINT32_T, WRITE);
}

bool config_fan_freq_from_json(const cJSON *json, uint32_t *hz) {
    int value = (int)*hz;
    if (!json_int_in_range(json, "freqHz", FAN_FREQ_MIN, FAN_FREQ_MAX, &value)) {
        return false;
    }
    *hz = (uint32_t)value;
    return true;
}

uint8_t config_fan_quiet(void) {
    return fan_quiet;
}

bool config_set_fan_quiet(uint8_t percent) {
    if (percent < FAN_QUIET_MIN || percent > FAN_QUIET_MAX) {
        return false;
    }
    fan_quiet       = percent;
    uint32_t stored = percent;
    return nvs_queue_job(NVS_FAN_QUIET, &stored, 0, UINT32_T, WRITE);
}

bool config_fan_quiet_from_json(const cJSON *json, uint8_t *percent) {
    int value = *percent;
    if (!json_int_in_range(json, "quietLevel", FAN_QUIET_MIN, FAN_QUIET_MAX, &value)) {
        return false;
    }
    *percent = (uint8_t)value;
    return true;
}

air_room_t config_air_room(void) {
    return room;
}

bool config_set_air_room(air_room_t value) {
    if (value > AIR_ROOM_BEDROOM) {
        return false;
    }
    room            = value;
    uint32_t stored = value;
    return nvs_queue_job(NVS_ROOM, &stored, 0, UINT32_T, WRITE);
}

bool config_air_room_from_json(const cJSON *json, air_room_t *value) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, "room");
    if (item == NULL) {
        return true;
    }
    if (!cJSON_IsString(item)) {
        return false;
    }
    for (size_t i = 0; i < sizeof(room_names) / sizeof(room_names[0]); i++) {
        if (strcmp(item->valuestring, room_names[i]) == 0) {
            *value = (air_room_t)i;
            return true;
        }
    }
    return false;
}

bool config_air_remind_from_json(const cJSON *json, air_remind_t *value) {
    int minutes = value->minutes;
    if (!json_int_in_range(json, "remindMinutes", 0, 60, &minutes)) {
        return false;
    }
    const cJSON *from = cJSON_GetObjectItemCaseSensitive(json, "remindFrom");
    if (from != NULL) {
        if (!cJSON_IsString(from)) {
            return false;
        }
        if (strcmp(from->valuestring, "yellow") == 0) {
            value->level = REMIND_YELLOW;
        } else if (strcmp(from->valuestring, "red") == 0) {
            value->level = REMIND_RED;
        } else {
            return false;
        }
    }
    value->minutes = minutes;
    return true;
}

void config_air_settings(air_settings_t *settings) {
    xSemaphoreTake(air_config_mutex, portMAX_DELAY);
    *settings = air_settings;
    xSemaphoreGive(air_config_mutex);
}

bool config_set_air_settings(const air_settings_t *settings) {
    xSemaphoreTake(air_config_mutex, portMAX_DELAY);
    air_settings = *settings;
    bool stored  = nvs_queue_job(NVS_AIR, &air_settings, sizeof(air_settings), BLOB, WRITE);
    xSemaphoreGive(air_config_mutex);
    return stored;
}

/* ----------------------------------------------------------------------- */

// the index of value in names
static bool json_choice_value(const char *value, const char **names, int count, uint8_t *out) {
    for (int i = 0; i < count; i++) {
        if (strcmp(value, names[i]) == 0) {
            *out = (uint8_t)i;
            return true;
        }
    }
    return false;
}

// the index of the name at key in names, *out kept when key is left out
static bool json_choice(const cJSON *json, const char *key, const char **names, int count, uint8_t *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (item == NULL) {
        return true;
    }
    return cJSON_IsString(item) && json_choice_value(item->valuestring, names, count, out);
}

bool config_air_from_json(const cJSON *json, air_settings_t *settings) {
    air_settings_t s = *settings;

    int yellow    = s.yellow;
    int red       = s.red;
    int altitude  = s.altitude;
    int puff_rise = s.puff_rise;
    int night_fan = s.night_fan;

    bool ok = json_int_in_range(json, "yellow", 400, 5000, &yellow) &&
              json_int_in_range(json, "red", 400, 10000, &red) &&
              json_int_in_range(json, "altitude", 0, 3000, &altitude) &&
              json_int_in_range(json, "puffRise", 30, 2000, &puff_rise) &&
              json_int_in_range(json, "nightFan", 0, 100, &night_fan) &&
              json_bool(json, "buzzer", &s.buzzer) &&
              json_bool(json, "asc", &s.asc) &&
              json_bool(json, "smoke", &s.smoke);
    if (!ok || red <= yellow) {
        return false;
    }

    s.yellow    = yellow;
    s.red       = red;
    s.altitude  = altitude;
    s.puff_rise = puff_rise;
    s.night_fan = night_fan;

    *settings = s;
    return true;
}

bool config_fan_from_json(const cJSON *json, air_settings_t *settings) {
    air_settings_t s = *settings;

    int level = s.fan_level;
    int on_s  = s.fan_on_s;
    int off_s = s.fan_off_s;

    bool ok = json_choice(json, "mode", fan_modes, sizeof(fan_modes) / sizeof(fan_modes[0]), &s.fan_mode) &&
              json_int_in_range(json, "level", 1, 100, &level) &&
              json_int_in_range(json, "onSeconds", 1, 3600, &on_s) &&
              json_int_in_range(json, "offSeconds", 1, 3600, &off_s);
    if (!ok) {
        return false;
    }

    s.fan_level = level;
    s.fan_on_s  = on_s;
    s.fan_off_s = off_s;

    *settings = s;
    return true;
}

bool config_lamp_from_json(const cJSON *json, air_settings_t *settings) {
    air_settings_t s = *settings;

    if (!json_choice(json, "mode", lamp_modes, sizeof(lamp_modes) / sizeof(lamp_modes[0]), &s.lamp_mode) || !json_bool(json, "fade", &s.lamp_fade)) {
        return false;
    }
    const cJSON *colors = cJSON_GetObjectItemCaseSensitive(json, "colors");
    if (colors != NULL) {
        if (!cJSON_IsArray(colors)) {
            return false;
        }
        uint8_t mask = 0;
        const cJSON *color;
        cJSON_ArrayForEach(color, colors) {
            uint8_t bit = 0;
            if (!cJSON_IsString(color) || !json_choice_value(color->valuestring, lamp_colors, sizeof(lamp_colors) / sizeof(lamp_colors[0]), &bit)) {
                return false;
            }
            mask |= 1 << bit;
        }
        s.lamp_colors = mask;
    }

    *settings = s;
    return true;
}

void config_air_to_json(const air_settings_t *settings, cJSON *json) {
    cJSON_AddNumberToObject(json, "yellow", settings->yellow);
    cJSON_AddNumberToObject(json, "red", settings->red);
    cJSON_AddBoolToObject(json, "buzzer", settings->buzzer);
    cJSON_AddBoolToObject(json, "asc", settings->asc);
    cJSON_AddNumberToObject(json, "altitude", settings->altitude);
    cJSON_AddBoolToObject(json, "smoke", settings->smoke);
    cJSON_AddNumberToObject(json, "puffRise", settings->puff_rise);
    cJSON_AddNumberToObject(json, "nightFan", settings->night_fan);
    cJSON_AddNumberToObject(json, "tempAdjust", temp_adjust / 10.0);
    cJSON_AddNumberToObject(json, "humidityFactor", humidity_factor / 1000.0);
    cJSON_AddNumberToObject(json, "freshMin", fresh.min);
    cJSON_AddNumberToObject(json, "freshMax", fresh.max);
    cJSON_AddNumberToObject(json, "remindMinutes", remind.minutes);
    cJSON_AddStringToObject(json, "remindFrom", remind.level == REMIND_YELLOW ? "yellow" : "red");
    cJSON_AddStringToObject(json, "room", room_names[room]);
}

void config_fan_to_json(const air_settings_t *settings, cJSON *json) {
    cJSON_AddStringToObject(json, "mode", settings->fan_mode < sizeof(fan_modes) / sizeof(fan_modes[0]) ? fan_modes[settings->fan_mode] : "on");
    cJSON_AddNumberToObject(json, "level", settings->fan_level);
    cJSON_AddNumberToObject(json, "onSeconds", settings->fan_on_s);
    cJSON_AddNumberToObject(json, "offSeconds", settings->fan_off_s);
    cJSON_AddNumberToObject(json, "quietLevel", fan_quiet);
    cJSON_AddNumberToObject(json, "freqHz", fan_freq);
}

void config_lamp_to_json(const air_settings_t *settings, cJSON *json) {
    cJSON_AddStringToObject(json, "mode", settings->lamp_mode < sizeof(lamp_modes) / sizeof(lamp_modes[0]) ? lamp_modes[settings->lamp_mode] : "traffic");
    cJSON_AddBoolToObject(json, "fade", settings->lamp_fade);
    cJSON *colors = cJSON_AddArrayToObject(json, "colors");
    for (size_t i = 0; i < sizeof(lamp_colors) / sizeof(lamp_colors[0]); i++) {
        if (settings->lamp_colors & (1 << i)) {
            cJSON_AddItemToArray(colors, cJSON_CreateString(lamp_colors[i]));
        }
    }
}
