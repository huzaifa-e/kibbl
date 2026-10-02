#include "KL_config.h"

#include <stdio.h>
#include <string.h>

#include "esp_camera.h"
#include "esp_mac.h"
#include "esp_random.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_nvs.h"
#include "KL_serial.h"

#define NVS_SERVER_URL    "SERVER_URL"
#define NVS_DEVICE_SECRET "DEV_SECRET"
#define NVS_LOCAL_KEY     "LOCAL_KEY"
#define NVS_CAMERA        "CAMERA"

static SemaphoreHandle_t config_mutex;

static char device_id[DEVICE_ID_LEN + 1];
static char device_secret[DEVICE_SECRET_LEN + 1];
static char local_key[LOCAL_KEY_LEN + 1];
static char server_url[SERVER_URL_MAX];
static camera_settings_t camera_settings;

static const camera_settings_t camera_defaults = {
    .framesize  = FRAMESIZE_VGA,
    .quality    = 12,
    .vflip      = false,
    .hmirror    = false,
    .brightness = 0,
    .contrast   = 0,
    .saturation = 0,
};

/* The frame sizes the server and the frontend may choose from, by name. Larger
 * than UXGA needs a 3 or 5 MP sensor; VGA is the default for a smooth stream. */
static const struct {
    const char *name;
    framesize_t size;
} framesizes[] = {
    {"QVGA", FRAMESIZE_QVGA}, // 320x240
    {"CIF", FRAMESIZE_CIF},   // 400x296
    {"HVGA", FRAMESIZE_HVGA}, // 480x320
    {"VGA", FRAMESIZE_VGA},   // 640x480
    {"SVGA", FRAMESIZE_SVGA}, // 800x600
    {"XGA", FRAMESIZE_XGA},   // 1024x768
    {"HD", FRAMESIZE_HD},     // 1280x720
    {"SXGA", FRAMESIZE_SXGA}, // 1280x1024
    {"UXGA", FRAMESIZE_UXGA}, // 1600x1200
};

/* ----------------------------------------------------------------------- */

static void random_hex(char *out, size_t hex_len) {
    static const char hex[] = "0123456789abcdef";
    uint8_t bytes[32];
    esp_fill_random(bytes, hex_len / 2);
    for (size_t i = 0; i < hex_len / 2; i++) {
        out[2 * i]     = hex[bytes[i] >> 4];
        out[2 * i + 1] = hex[bytes[i] & 0x0f];
    }
    out[hex_len] = '\0';
    memset(bytes, 0, sizeof(bytes));
}

/* A secret read back with the wrong length or with other characters than hex was
 * not written by this firmware: make a new one rather than send it. */
static bool is_hex(const char *str, size_t len) {
    if (strlen(str) != len) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        char c = str[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

static void load_or_create(const char *key, char *value, size_t hex_len) {
    if (nvs_queue_job(key, value, hex_len + 1, STRING, READ) && is_hex(value, hex_len)) {
        return;
    }
    random_hex(value, hex_len);
    if (!nvs_queue_job(key, value, 0, STRING, WRITE)) {
        DEBUG_F_ERROR("%s not stored, a new one is made on the next boot\n", key);
    }
    DEBUG("%s created\n", key);
}

void config_load(void) {
    config_mutex = xSemaphoreCreateMutex();

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(device_id, sizeof(device_id), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    load_or_create(NVS_DEVICE_SECRET, device_secret, DEVICE_SECRET_LEN);
    load_or_create(NVS_LOCAL_KEY, local_key, LOCAL_KEY_LEN);

    if (!nvs_queue_job(NVS_SERVER_URL, server_url, sizeof(server_url), STRING, READ) || server_url[0] == '\0') {
        strlcpy(server_url, CONFIG_KIBBL_SERVER_URL, sizeof(server_url));
    }

    if (!nvs_queue_job(NVS_CAMERA, &camera_settings, sizeof(camera_settings), BLOB, READ)) {
        camera_settings = camera_defaults;
    }
}

void config_reset(void) {
    nvs_remove_key(NVS_SERVER_URL);
    nvs_remove_key(NVS_DEVICE_SECRET);
    nvs_remove_key(NVS_LOCAL_KEY);
    nvs_remove_key(NVS_CAMERA);
}

const char *config_device_id(void) {
    return device_id;
}

const char *config_device_secret(void) {
    return device_secret;
}

const char *config_local_key(void) {
    return local_key;
}

/* ----------------------------------------------------------------------- */

const char *config_server_url(void) {
    return server_url;
}

bool config_set_server_url(const char *url) {
    if (url == NULL || strlen(url) >= SERVER_URL_MAX) {
        return false;
    }
    if (strncmp(url, "ws://", 5) != 0 && strncmp(url, "wss://", 6) != 0) {
        return false;
    }

    // the stream task reads it on the next connect only, which happens after a reboot
    xSemaphoreTake(config_mutex, portMAX_DELAY);
    strlcpy(server_url, url, sizeof(server_url));
    bool stored = nvs_queue_job(NVS_SERVER_URL, server_url, 0, STRING, WRITE);
    xSemaphoreGive(config_mutex);
    return stored;
}

/* ----------------------------------------------------------------------- */

void config_camera_settings(camera_settings_t *settings) {
    xSemaphoreTake(config_mutex, portMAX_DELAY);
    *settings = camera_settings;
    xSemaphoreGive(config_mutex);
}

bool config_set_camera_settings(const camera_settings_t *settings) {
    xSemaphoreTake(config_mutex, portMAX_DELAY);
    camera_settings = *settings;
    bool stored     = nvs_queue_job(NVS_CAMERA, &camera_settings, sizeof(camera_settings), BLOB, WRITE);
    xSemaphoreGive(config_mutex);
    return stored;
}

static bool json_int_in_range(const cJSON *json, const char *key, int min, int max, int *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (item == NULL) {
        return true; // left out, keeps its value
    }
    if (!cJSON_IsNumber(item) || item->valueint < min || item->valueint > max) {
        return false;
    }
    *out = item->valueint;
    return true;
}

static bool json_bool(const cJSON *json, const char *key, bool *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (item == NULL) {
        return true;
    }
    if (!cJSON_IsBool(item)) {
        return false;
    }
    *out = cJSON_IsTrue(item);
    return true;
}

bool config_camera_from_json(const cJSON *json, camera_settings_t *settings) {
    camera_settings_t s = *settings;

    const cJSON *framesize = cJSON_GetObjectItemCaseSensitive(json, "framesize");
    if (framesize != NULL) {
        if (!cJSON_IsString(framesize)) {
            return false;
        }
        bool found = false;
        for (size_t i = 0; i < sizeof(framesizes) / sizeof(framesizes[0]); i++) {
            if (strcmp(framesize->valuestring, framesizes[i].name) == 0) {
                s.framesize = framesizes[i].size;
                found       = true;
                break;
            }
        }
        if (!found) {
            return false;
        }
    }

    int quality    = s.quality;
    int brightness = s.brightness;
    int contrast   = s.contrast;
    int saturation = s.saturation;

    bool ok = json_int_in_range(json, "quality", 4, 63, &quality) &&
              json_int_in_range(json, "brightness", -2, 2, &brightness) &&
              json_int_in_range(json, "contrast", -2, 2, &contrast) &&
              json_int_in_range(json, "saturation", -2, 2, &saturation) &&
              json_bool(json, "vflip", &s.vflip) &&
              json_bool(json, "hmirror", &s.hmirror);
    if (!ok) {
        return false;
    }

    s.quality    = quality;
    s.brightness = brightness;
    s.contrast   = contrast;
    s.saturation = saturation;

    *settings = s;
    return true;
}

void config_camera_to_json(const camera_settings_t *settings, cJSON *json) {
    const char *name = "VGA";
    for (size_t i = 0; i < sizeof(framesizes) / sizeof(framesizes[0]); i++) {
        if (settings->framesize == framesizes[i].size) {
            name = framesizes[i].name;
            break;
        }
    }
    cJSON_AddStringToObject(json, "framesize", name);
    cJSON_AddNumberToObject(json, "quality", settings->quality);
    cJSON_AddBoolToObject(json, "vflip", settings->vflip);
    cJSON_AddBoolToObject(json, "hmirror", settings->hmirror);
    cJSON_AddNumberToObject(json, "brightness", settings->brightness);
    cJSON_AddNumberToObject(json, "contrast", settings->contrast);
    cJSON_AddNumberToObject(json, "saturation", settings->saturation);
}
