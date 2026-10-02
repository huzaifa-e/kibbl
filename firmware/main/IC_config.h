#ifndef IC_CONFIG_H
#define IC_CONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

#define SERVER_URL_MAX    128
#define DEVICE_SECRET_LEN 32 // hex characters
#define LOCAL_KEY_LEN     16 // hex characters
#define DEVICE_ID_LEN     12 // mac address in hex, no separators

typedef struct {
    uint8_t framesize; // framesize_t of esp32-camera
    uint8_t quality;   // 4-63, a lower number is a better image
    bool vflip;
    bool hmirror;
    int8_t brightness; // -2..2
    int8_t contrast;   // -2..2
    int8_t saturation; // -2..2
} camera_settings_t;

// reads the stored settings, creates the device secret and the local key on the first boot
void config_load(void);

// wipes everything config_load() reads, the secrets included; wifi is not touched
void config_reset(void);

const char *config_device_id(void);
const char *config_device_secret(void);
const char *config_local_key(void);

const char *config_server_url(void);
bool config_set_server_url(const char *url);

void config_camera_settings(camera_settings_t *settings);
bool config_set_camera_settings(const camera_settings_t *settings);

/* Applies the keys present in json onto settings and range-checks them; keys left out
 * keep their value. False when a key is present but invalid, settings unchanged then. */
bool config_camera_from_json(const cJSON *json, camera_settings_t *settings);
void config_camera_to_json(const camera_settings_t *settings, cJSON *json);

#ifdef __cplusplus
}
#endif

#endif /* IC_CONFIG_H */
