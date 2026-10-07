#ifndef KL_CAMERA_CONFIG_H
#define KL_CAMERA_CONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "cJSON.h"

typedef struct {
    uint8_t framesize; // framesize_t of esp32-camera
    uint8_t quality;   // 4-63, a lower number is a better image
    bool vflip;
    bool hmirror;
    int8_t brightness; // -2..2
    int8_t contrast;   // -2..2
    int8_t saturation; // -2..2
} camera_settings_t;

// reads the stored camera settings, the defaults when none are stored; after nvs_setup()
void config_camera_load(void);

// forgets the stored camera settings (factory reset)
void config_camera_reset(void);

void config_camera_settings(camera_settings_t *settings);
bool config_set_camera_settings(const camera_settings_t *settings);

/* Applies the keys present in json onto settings and range-checks them; keys left out
 * keep their value. False when a key is present but invalid, settings unchanged then. */
bool config_camera_from_json(const cJSON *json, camera_settings_t *settings);
void config_camera_to_json(const camera_settings_t *settings, cJSON *json);

#ifdef __cplusplus
}
#endif

#endif /* KL_CAMERA_CONFIG_H */
