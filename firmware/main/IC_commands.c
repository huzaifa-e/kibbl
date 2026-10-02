#include "IC_commands.h"

#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "BUILD_INFO.h"
#include "IC_camera.h"
#include "IC_config.h"
#include "IC_frame.h"
#include "IC_hm_hw.h"
#include "IC_light.h"
#include "IC_ota.h"
#include "IC_serial.h"
#include "IC_time.h"
#include "IC_wifi_prov.h"

#define RESTART_DELAY_US (1000 * 1000) // the response goes out first

static esp_timer_handle_t restart_timer = NULL;

static void restart_cb(void *arg) {
    esp_restart();
}

static void restart_later(void) {
    if (restart_timer == NULL) {
        const esp_timer_create_args_t args = {
            .callback = restart_cb,
            .name     = "restart",
        };
        if (esp_timer_create(&args, &restart_timer) != ESP_OK) {
            esp_restart();
        }
    }
    esp_timer_stop(restart_timer);
    esp_timer_start_once(restart_timer, RESTART_DELAY_US);
}

/* ----------------------------------------------------------------------- */

void commands_add_info(cJSON *json, cmd_source_t source) {
    char ip[16];
    int rssi = 0;

    cJSON_AddStringToObject(json, "fw", FW_VERSION);
    cJSON_AddStringToObject(json, "id", config_device_id());
    cJSON_AddStringToObject(json, "model", "esp32-cam");
    cJSON_AddStringToObject(json, "board", BOARD_NAME);
    cJSON_AddStringToObject(json, "sensor", camera_sensor_name());
    if (!camera_ready()) {
        cJSON_AddStringToObject(json, "cameraError", camera_last_error());
    }
    cJSON_AddStringToObject(json, "hostname", wifi_hostname());
    if (wifi_ip_string(ip, sizeof(ip))) {
        cJSON_AddStringToObject(json, "ip", ip);
    }
    cJSON_AddStringToObject(json, "ssid", get_configured_ssid());
    if (wifi_rssi(&rssi)) {
        cJSON_AddNumberToObject(json, "rssi", rssi);
    }
    cJSON_AddNumberToObject(json, "uptime", (double)(millis() / 1000));
    cJSON_AddNumberToObject(json, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(json, "psram", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(json, "resetReason", esp_reset_reason());

    // what the device can do; the server builds its controls from this list
    cJSON *caps = cJSON_AddArrayToObject(json, "caps");
    if (camera_ready()) {
        cJSON_AddItemToArray(caps, cJSON_CreateString("camera"));
    }
    if (light_available()) {
        cJSON_AddItemToArray(caps, cJSON_CreateString("light"));
    }
    cJSON_AddItemToArray(caps, cJSON_CreateString("ota"));

    camera_settings_t settings;
    config_camera_settings(&settings);
    config_camera_to_json(&settings, cJSON_AddObjectToObject(json, "camera"));
    cJSON_AddNumberToObject(json, "light", light_get());

    if (source == CMD_SOURCE_SERIAL) {
        // the secrets of the local page and the server url go to the person holding the device only
        cJSON_AddStringToObject(json, "server", config_server_url());
        cJSON_AddStringToObject(json, "localKey", config_local_key());
#if CONFIG_HM_LOCAL_HTTP
        if (ip[0] != '\0') {
            char url[64];
            snprintf(url, sizeof(url), "http://%s/?key=%s", ip, config_local_key());
            cJSON_AddStringToObject(json, "localUrl", url);
        }
#endif
    }
}

/* ----------------------------------------------------------------------- */

static const char *json_string(const cJSON *req, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(req, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

static const char *cmd_camera(const cJSON *req, cJSON *resp) {
    camera_settings_t settings;
    config_camera_settings(&settings);
    if (!config_camera_from_json(req, &settings)) {
        return "invalid camera setting";
    }
    if (!camera_apply(&settings)) {
        return "camera did not take the settings";
    }
    if (!config_set_camera_settings(&settings)) {
        return "settings applied, not stored";
    }
    config_camera_to_json(&settings, cJSON_AddObjectToObject(resp, "camera"));
    return NULL;
}

static const char *cmd_light(const cJSON *req, cJSON *resp) {
    const cJSON *level = cJSON_GetObjectItemCaseSensitive(req, "level");
    if (!light_available()) {
        return "no light on this board";
    }
    if (!cJSON_IsNumber(level) || level->valueint < 0 || level->valueint > 100) {
        return "level must be 0 to 100";
    }
    light_set((uint8_t)level->valueint);
    cJSON_AddNumberToObject(resp, "light", light_get());
    return NULL;
}

static const char *cmd_stream(const cJSON *req, cJSON *resp) {
    const cJSON *fps = cJSON_GetObjectItemCaseSensitive(req, "fps");
    if (!cJSON_IsNumber(fps) || fps->valueint < 0 || fps->valueint > 255) {
        return "fps must be 0 to 255";
    }
    // capped by CONFIG_HM_STREAM_MAX_FPS in the frame hub
    frame_set_demand(FRAME_CONSUMER_SERVER, (uint8_t)fps->valueint);
    return NULL;
}

static const char *cmd_wifi(const cJSON *req, cJSON *resp) {
    const char *ssid     = json_string(req, "ssid");
    const char *password = json_string(req, "password");
    if (ssid == NULL || password == NULL) {
        return "ssid and password needed";
    }
    if (!wifi_set_credentials(ssid, password)) {
        return "wifi settings not taken";
    }
    return NULL;
}

static const char *cmd_server(const cJSON *req, cJSON *resp) {
    const char *url = json_string(req, "url");
    if (!config_set_server_url(url)) {
        return "url must start with ws:// or wss://, at most 127 characters";
    }
    cJSON_AddStringToObject(resp, "server", config_server_url());
    restart_later(); // the stream connects with the url read at boot
    return NULL;
}

static const char *cmd_ota(const cJSON *req, cJSON *resp) {
    if (!ota_start(json_string(req, "url"))) {
        return ota_running() ? "update already running" : "url must start with http:// or https://";
    }
    return NULL;
}

cJSON *commands_handle(const cJSON *req, cmd_source_t source) {
    cJSON *resp = cJSON_CreateObject();
    if (resp == NULL) {
        return NULL;
    }

    const cJSON *id = cJSON_GetObjectItemCaseSensitive(req, "id");
    if (id != NULL) {
        cJSON_AddItemToObject(resp, "id", cJSON_Duplicate(id, true));
    }

    const char *cmd   = json_string(req, "cmd");
    const char *error = NULL;
    bool serial       = source == CMD_SOURCE_SERIAL;

    if (cmd == NULL) {
        error = "no cmd";
    } else if (strcmp(cmd, "info") == 0) {
        commands_add_info(resp, source);
    } else if (strcmp(cmd, "camera") == 0) {
        error = cmd_camera(req, resp);
    } else if (strcmp(cmd, "light") == 0) {
        error = cmd_light(req, resp);
    } else if (strcmp(cmd, "stream") == 0) {
        error = cmd_stream(req, resp);
    } else if (strcmp(cmd, "ota") == 0) {
        error = cmd_ota(req, resp);
    } else if (strcmp(cmd, "reboot") == 0) {
        restart_later();
    } else if (strcmp(cmd, "wifi_reset") == 0) {
        wifi_reset_credentials();
    } else if (serial && strcmp(cmd, "debug") == 0) {
        debug_status_toggle();
    } else if (serial && strcmp(cmd, "wifi") == 0) {
        error = cmd_wifi(req, resp);
    } else if (serial && strcmp(cmd, "server") == 0) {
        error = cmd_server(req, resp);
    } else if (serial && strcmp(cmd, "factory_reset") == 0) {
        // a new device secret: the server sees a new device that has to be approved again
        config_reset();
        wifi_reset_credentials();
    } else {
        error = "unknown cmd";
    }

    cJSON_AddBoolToObject(resp, "ok", error == NULL);
    if (error != NULL) {
        cJSON_AddStringToObject(resp, "error", error);
    }
    return resp;
}
