/*
 * kibbl. cam on the shared core (KL_product.h): its info, its commands, the frames
 * it streams to the server and what stops for an update.
 */

#include "KL_product.h"

#include <stdio.h>
#include <string.h>

#include "esp_heap_caps.h"

#include "BUILD_INFO.h"
#include "KL_camera.h"
#include "KL_camera_config.h"
#include "KL_config.h"
#include "KL_frame.h"
#include "KL_hw.h"
#include "KL_light.h"
#include "KL_serial.h"
#include "KL_stream.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define FRAME_WAIT_MS 200 // the command queue is read at least this often

// frames sent to the server in the last full second, for the telemetry
static uint8_t sent        = 0;
static uint8_t sent_fps    = 0;
static int64_t second_start = 0;
static int64_t last_frame   = 0;
static frame_copy_t copy    = {0};

const char *product_fw_version(void) {
    return FW_VERSION;
}

/* ----------------------------------------------------------------------- */

void product_add_info(cJSON *json, cmd_source_t source) {
    cJSON_AddStringToObject(json, "model", PRODUCT_MODEL); // the product, as the app names it
    cJSON_AddStringToObject(json, "board", BOARD_NAME);
    cJSON_AddStringToObject(json, "sensor", camera_sensor_name());
    if (!camera_ready()) {
        cJSON_AddStringToObject(json, "cameraError", camera_last_error());
    }
    cJSON_AddNumberToObject(json, "psram", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));

    /* what the device can do; the server builds its controls from this list. A kibbl. cam
     * is a camera even while its module does not answer: the app shows cameraError then. */
    cJSON *caps = cJSON_AddArrayToObject(json, "caps");
    cJSON_AddItemToArray(caps, cJSON_CreateString("camera"));
    if (light_available()) {
        cJSON_AddItemToArray(caps, cJSON_CreateString("light"));
        cJSON_AddItemToArray(caps, cJSON_CreateString("blink"));
    }
    cJSON_AddItemToArray(caps, cJSON_CreateString("ota"));

    camera_settings_t settings;
    config_camera_settings(&settings);
    config_camera_to_json(&settings, cJSON_AddObjectToObject(json, "camera"));
    cJSON_AddNumberToObject(json, "light", light_get());

    if (source == CMD_SOURCE_SERIAL) {
        // the secret of the local page goes to the person holding the device only
        cJSON_AddStringToObject(json, "localKey", config_local_key());
#if CONFIG_KIBBL_LOCAL_HTTP
        char ip[16];
        if (wifi_ip_string(ip, sizeof(ip))) {
            char url[64];
            snprintf(url, sizeof(url), "http://%s/?key=%s", ip, config_local_key());
            cJSON_AddStringToObject(json, "localUrl", url);
        }
#endif
    }
}

/* ----------------------------------------------------------------------- */

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

// a short flash of the white light: the server sends it when it sees motion
static const char *cmd_blink(const cJSON *req, cJSON *resp) {
    const cJSON *count = cJSON_GetObjectItemCaseSensitive(req, "count");
    const cJSON *level = cJSON_GetObjectItemCaseSensitive(req, "level");
    if (!light_available()) {
        return "no light on this board";
    }
    int n = cJSON_IsNumber(count) ? count->valueint : 2;
    int l = cJSON_IsNumber(level) ? level->valueint : 30;
    if (n < 1 || n > 10 || l < 1 || l > 100) {
        return "count 1 to 10, level 1 to 100";
    }
    light_blink((uint8_t)n, (uint8_t)l);
    return NULL;
}

static const char *cmd_stream(const cJSON *req, cJSON *resp) {
    const cJSON *fps = cJSON_GetObjectItemCaseSensitive(req, "fps");
    if (!cJSON_IsNumber(fps) || fps->valueint < 0 || fps->valueint > 255) {
        return "fps must be 0 to 255";
    }
    // capped by CONFIG_KIBBL_STREAM_MAX_FPS in the frame hub
    frame_set_demand(FRAME_CONSUMER_SERVER, (uint8_t)fps->valueint);
    return NULL;
}

bool product_command(const char *cmd, const cJSON *req, cJSON *resp, cmd_source_t source, const char **error) {
    if (strcmp(cmd, "camera") == 0) {
        *error = cmd_camera(req, resp);
    } else if (strcmp(cmd, "blink") == 0) {
        *error = cmd_blink(req, resp);
    } else if (strcmp(cmd, "light") == 0) {
        *error = cmd_light(req, resp);
    } else if (strcmp(cmd, "stream") == 0) {
        *error = cmd_stream(req, resp);
    } else {
        return false;
    }
    return true;
}

/* ----------------------------------------------------------------------- */

void product_add_telemetry(cJSON *json) {
    cJSON_AddNumberToObject(json, "psram", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(json, "cameraFps", frame_fps());
    cJSON_AddNumberToObject(json, "fps", sent_fps);
    cJSON_AddNumberToObject(json, "frameBytes", frame_last_size());
}

// frames at the server's rate; the frame buffer is kept for the next stream
bool product_stream_work(bool connected) {
    bool working = true;

    if (!connected || frame_demand(FRAME_CONSUMER_SERVER) == 0) {
        working = false;
    } else if (!frame_due(FRAME_CONSUMER_SERVER, &last_frame)) {
        delay_ms(5);
    } else if (frame_copy_latest(&copy, FRAME_WAIT_MS)) {
        if (!stream_send_bin(copy.buf, copy.len)) {
            DEBUG_ERROR("frame of %u bytes not sent\n", (unsigned)copy.len);
        } else {
            sent++;
        }
    }

    if (millis() - second_start >= 1000) {
        sent_fps     = sent;
        sent         = 0;
        second_start = millis();
    }
    return working;
}

void product_stream_disconnected(void) {
    frame_set_demand(FRAME_CONSUMER_SERVER, 0);
}

/* ----------------------------------------------------------------------- */

void product_ota_prepare(void) {
    // the stream competes for the same link and PSRAM
    for (int i = 0; i < FRAME_CONSUMERS; i++) {
        frame_set_demand((frame_consumer_t)i, 0);
    }
    /* The camera keeps capturing without consumers; with the cache paused for the flash
     * writes its interrupt trips the watchdog and the board resets halfway (TG1WDT).
     * The frame task lets go of its frame within one frame time once nobody asks. */
    delay_ms(300);
    camera_stop();
}

void product_reset(void) {
    config_camera_reset();
}
