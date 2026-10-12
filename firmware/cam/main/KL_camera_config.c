#include "KL_camera_config.h"

#include <string.h>

#include "esp_camera.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_commands.h"
#include "KL_hw.h"
#include "KL_nvs.h"

#define NVS_CAMERA "CAMERA"

static SemaphoreHandle_t camera_config_mutex;

static camera_settings_t camera_settings;

static const camera_settings_t camera_defaults = {
    .framesize  = FRAMESIZE_VGA,
    .quality    = 12,
    .vflip      = CAM_DEFAULT_VFLIP,
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

void config_camera_load(void) {
    camera_config_mutex = xSemaphoreCreateMutex();

    if (!nvs_queue_job(NVS_CAMERA, &camera_settings, sizeof(camera_settings), BLOB, READ)) {
        camera_settings = camera_defaults;
    }
}

void config_camera_reset(void) {
    nvs_remove_key(NVS_CAMERA);
}

void config_camera_settings(camera_settings_t *settings) {
    xSemaphoreTake(camera_config_mutex, portMAX_DELAY);
    *settings = camera_settings;
    xSemaphoreGive(camera_config_mutex);
#ifdef CAM_FIXED_FRAMESIZE
    settings->framesize = CAM_FIXED_FRAMESIZE; // the one size this board streams, as the app shows it
#endif
}

bool config_set_camera_settings(const camera_settings_t *settings) {
    xSemaphoreTake(camera_config_mutex, portMAX_DELAY);
    camera_settings = *settings;
    bool stored     = nvs_queue_job(NVS_CAMERA, &camera_settings, sizeof(camera_settings), BLOB, WRITE);
    xSemaphoreGive(camera_config_mutex);
    return stored;
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
