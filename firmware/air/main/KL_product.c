/*
 * kibbl. air (the Conny CO2 traffic light) on the shared core (KL_product.h): its info,
 * its commands, its telemetry and the events it sends.
 */

#include "KL_product.h"

#include <string.h>

#include "BUILD_INFO.h"
#include "KL_air.h"
#include "KL_air_config.h"
#include "KL_events.h"
#include "KL_fan.h"
#include "KL_fire.h"
#include "KL_hw.h"
#include "KL_ioexp.h"
#include "KL_lamp.h"
#include "KL_scd30.h"
#include "KL_smoke.h"
#include "KL_window.h"

const char *product_fw_version(void) {
    return FW_VERSION;
}

/* ----------------------------------------------------------------------- */

static void add_state(cJSON *json) {
    air_state_t state;
    air_state(&state);
    if (state.valid) {
        cJSON_AddNumberToObject(json, "co2", state.co2);
        cJSON_AddNumberToObject(json, "temperature", (int)(state.temperature * 10 + (state.temperature < 0 ? -0.5f : 0.5f)) / 10.0);
        cJSON_AddNumberToObject(json, "humidity", (int)(state.humidity * 10 + 0.5f) / 10.0);
    }
    // with every telemetry: the sensor may come up or get lost after the hello
    if (!air_sensor_ok()) {
        cJSON_AddStringToObject(json, "sensorError", "no CO2 sensor answers");
    }
    cJSON_AddStringToObject(json, "level", air_level_name(state.level));
    cJSON_AddNumberToObject(json, "fan", fan_level_now());
    cJSON_AddStringToObject(json, "window", window_state(air_detecting()));
    cJSON_AddBoolToObject(json, "night", air_night());
    cJSON_AddBoolToObject(json, "calibrating", air_calibrating());
    cJSON_AddNumberToObject(json, "puffs", smoke_puffs_now());
    cJSON_AddBoolToObject(json, "fire", fire_alarm());
}

void product_add_info(cJSON *json, cmd_source_t source) {
    cJSON_AddStringToObject(json, "model", PRODUCT_MODEL); // the product, as the app names it
    cJSON_AddStringToObject(json, "board", BOARD_NAME);
    cJSON_AddStringToObject(json, "sensor", scd30_name());
    cJSON_AddStringToObject(json, "expander", ioexp_name());
    cJSON_AddBoolToObject(json, "powerOn", ioexp_power_on());

    // what the device can do; the server builds its controls from this list
    cJSON *caps = cJSON_AddArrayToObject(json, "caps");
    cJSON_AddItemToArray(caps, cJSON_CreateString("air"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("fan"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("lamp"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("blink"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("buzzer"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("night"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("calibrate"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("smoke"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("window"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("fire"));
    cJSON_AddItemToArray(caps, cJSON_CreateString("ota"));

    air_settings_t settings;
    config_air_settings(&settings);
    config_air_to_json(&settings, cJSON_AddObjectToObject(json, "air"));
    config_fan_to_json(&settings, cJSON_AddObjectToObject(json, "fanSettings"));
    config_lamp_to_json(&settings, cJSON_AddObjectToObject(json, "lamp"));

    add_state(json);
}

/* ----------------------------------------------------------------------- */

typedef bool (*settings_from_json_t)(const cJSON *json, air_settings_t *settings);

// the settings of one command: checked, applied, stored, and all of them in the response
static const char *cmd_settings(const cJSON *req, cJSON *resp, settings_from_json_t from_json) {
    air_settings_t settings;
    config_air_settings(&settings);
    int16_t temp_adjust = config_temp_adjust();
    uint16_t humidity_factor = config_humidity_factor();
    if (!from_json(req, &settings) || !config_temp_adjust_from_json(req, &temp_adjust) || !config_humidity_factor_from_json(req, &humidity_factor)) {
        return "invalid setting";
    }
    if (humidity_factor != config_humidity_factor() && !config_set_humidity_factor(humidity_factor)) {
        return "humidity adjustment not stored";
    }
    if (temp_adjust != config_temp_adjust() && !config_set_temp_adjust(temp_adjust)) {
        return "temperature adjustment not stored";
    }
    air_apply(&settings);
    if (!config_set_air_settings(&settings)) {
        return "settings applied, not stored";
    }
    config_air_to_json(&settings, cJSON_AddObjectToObject(resp, "air"));
    config_fan_to_json(&settings, cJSON_AddObjectToObject(resp, "fanSettings"));
    config_lamp_to_json(&settings, cJSON_AddObjectToObject(resp, "lamp"));
    return NULL;
}

// a short flash of the white light: find the device
static const char *cmd_blink(const cJSON *req, cJSON *resp) {
    int count = 2;
    if (!json_int_in_range(req, "count", 1, 10, &count)) {
        return "count 1 to 10";
    }
    lamp_blink((uint8_t)count);
    return NULL;
}

static const char *cmd_night(const cJSON *req, cJSON *resp) {
    const cJSON *on = cJSON_GetObjectItemCaseSensitive(req, "on");
    if (!cJSON_IsBool(on)) {
        return "on must be true or false";
    }
    air_set_night(cJSON_IsTrue(on));
    cJSON_AddBoolToObject(resp, "night", air_night());
    return NULL;
}

static const char *cmd_calibrate(const cJSON *req, cJSON *resp) {
    int ppm = 420; // fresh air outside
    if (!json_int_in_range(req, "ppm", 400, 2000, &ppm)) {
        return "ppm 400 to 2000";
    }
    if (!air_sensor_ok()) {
        return "no CO2 sensor";
    }
    if (!air_calibrate((uint16_t)ppm)) {
        return "a calibration already runs";
    }
    cJSON_AddBoolToObject(resp, "pending", true);
    cJSON_AddNumberToObject(resp, "seconds", (CALIBRATE_PREPARE_MS + CALIBRATE_FOLLOW_MS) / 1000);
    return NULL;
}

bool product_command(const char *cmd, const cJSON *req, cJSON *resp, cmd_source_t source, const char **error) {
    if (strcmp(cmd, "air_config") == 0) {
        *error = cmd_settings(req, resp, config_air_from_json);
    } else if (strcmp(cmd, "fan") == 0) {
        *error = cmd_settings(req, resp, config_fan_from_json);
    } else if (strcmp(cmd, "lamp") == 0) {
        *error = cmd_settings(req, resp, config_lamp_from_json);
    } else if (strcmp(cmd, "blink") == 0) {
        *error = cmd_blink(req, resp);
    } else if (strcmp(cmd, "night") == 0) {
        *error = cmd_night(req, resp);
    } else if (strcmp(cmd, "calibrate") == 0) {
        *error = cmd_calibrate(req, resp);
    } else {
        return false;
    }
    return true;
}

/* ----------------------------------------------------------------------- */

void product_add_telemetry(cJSON *json) {
    add_state(json);
}

// the events that waited for the server, one per round so commands are not held up
bool product_stream_work(bool connected) {
    return connected && events_send();
}

void product_stream_disconnected(void) {
}

// nothing competes with the download: the measurement goes on, the watchdog is fed; the
// lamp shows that an update runs
void product_ota_prepare(void) {
    lamp_set_updating(true);
}

void product_reset(void) {
    config_air_reset();
}
