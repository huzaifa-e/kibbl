#ifndef KL_CAMERA_H
#define KL_CAMERA_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_camera.h"

#include "KL_camera_config.h"

// powers the sensor and starts the driver; false when no sensor answers
bool camera_init(void);

// camera_init(), one frame, then the stored settings: the way the camera is started
bool camera_start(void);

/* stops the driver and its DMA for good (until a restart): writing the flash pauses the
 * cache, and a capture running meanwhile trips the interrupt watchdog. No frame may be
 * held when it is called. */
void camera_stop(void);

bool camera_ready(void);

// the sensor name (OV2640, OV3660, ...), "none" before a successful camera_init()
const char *camera_sensor_name(void);

// applies all settings to the sensor; the frame size is capped by what the sensor can do
bool camera_apply(const camera_settings_t *settings);

/* the latest frame as jpeg, NULL when there is none; every frame taken must go back
 * with camera_return() */
camera_fb_t *camera_take(void);
void camera_return(camera_fb_t *fb);

// the step the last failed camera_init or camera_take stopped at, for the hello message
const char *camera_last_error(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_CAMERA_H */
