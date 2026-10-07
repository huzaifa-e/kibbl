#include "KL_air_config.h"

#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_commands.h"
#include "KL_ioexp.h"
#include "KL_nvs.h"

#define NVS_AIR "AIR"

static SemaphoreHandle_t air_config_mutex;

static air_settings_t air_settings;

/* The thresholds and the fan of ESW0002 (the original Conny firmware): 1000 and 2000 ppm
 * after the guidance of the German Environment Agency, the fan always on. It draws room
 * air past the sensor and cools the board. */
static const air_settings_t air_defaults = {
    .yellow    = 1000,
    .red       = 2000,
    .buzzer    = false,
    .asc       = false,
    .altitude  = 127,
    .lamp_mode   = LAMP_MODE_TRAFFIC,
    .lamp_colors = LAMP_MASK_WHITE | LAMP_MASK_YELLOW,
    .lamp_fade   = true,
    .fan_mode  = FAN_MODE_ON,
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

    if (!nvs_queue_job(NVS_AIR, &air_settings, sizeof(air_settings), BLOB, READ)) {
        air_settings = air_defaults;
    }
}

void config_air_reset(void) {
    nvs_remove_key(NVS_AIR);
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
}

void config_fan_to_json(const air_settings_t *settings, cJSON *json) {
    cJSON_AddStringToObject(json, "mode", settings->fan_mode < sizeof(fan_modes) / sizeof(fan_modes[0]) ? fan_modes[settings->fan_mode] : "on");
    cJSON_AddNumberToObject(json, "level", settings->fan_level);
    cJSON_AddNumberToObject(json, "onSeconds", settings->fan_on_s);
    cJSON_AddNumberToObject(json, "offSeconds", settings->fan_off_s);
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
