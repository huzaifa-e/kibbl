#include "KL_camera.h"

#include <stdio.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_hw.h"
#include "KL_serial.h"

static SemaphoreHandle_t cam_mutex;

static bool ready   = false;
static bool stopped = false; // camera_stop() was called: nothing starts it again until a restart
static char sensor_name[16] = "none";
static char last_error[24];

const char *camera_last_error(void) {
    return last_error;
}

/* The driver sizes its jpeg frame buffers by the frame size given at init, and a
 * later larger frame size overflows them (FB-OVF). It starts at UXGA, the largest
 * size the settings offer, and camera_apply() sets the size actually streamed. */
static camera_config_t camera_config = {
    .pin_pwdn     = CAM_PIN_PWDN,
    .pin_reset    = CAM_PIN_RESET,
    .pin_xclk     = CAM_PIN_XCLK,
    .pin_sccb_sda = CAM_PIN_SIOD,
    .pin_sccb_scl = CAM_PIN_SIOC,

    .pin_d7    = CAM_PIN_D7,
    .pin_d6    = CAM_PIN_D6,
    .pin_d5    = CAM_PIN_D5,
    .pin_d4    = CAM_PIN_D4,
    .pin_d3    = CAM_PIN_D3,
    .pin_d2    = CAM_PIN_D2,
    .pin_d1    = CAM_PIN_D1,
    .pin_d0    = CAM_PIN_D0,
    .pin_vsync = CAM_PIN_VSYNC,
    .pin_href  = CAM_PIN_HREF,
    .pin_pclk  = CAM_PIN_PCLK,

    .xclk_freq_hz = 20000000,

    .ledc_timer   = CAMERA_TIMER,
    .ledc_channel = CAMERA_CHANNEL,

    .pixel_format = PIXFORMAT_JPEG,
    .frame_size   = FRAMESIZE_UXGA,

    .jpeg_quality = 12, // 0-63, for OV series camera sensors, lower number means higher quality
    .fb_count     = 2,  // two buffers: the driver fills one while the other is sent
    .fb_location  = CAMERA_FB_IN_PSRAM,
    .grab_mode    = CAMERA_GRAB_LATEST, // a slow consumer gets the newest frame, not a queued one
};

bool camera_init(void) {
    if (cam_mutex == NULL) {
        cam_mutex = xSemaphoreCreateMutex();
    }

    xSemaphoreTake(cam_mutex, portMAX_DELAY); // Mutex block

    esp_err_t err = esp_camera_init(&camera_config);
    if (err != ESP_OK) {
        DEBUG_F_ERROR("CAM_INIT_FAILED: 0x%x\n", err);
        snprintf(last_error, sizeof(last_error), "init 0x%x", err);
        xSemaphoreGive(cam_mutex); // Mutex release
        return false;
    }

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor != NULL) {
        camera_sensor_info_t *info = esp_camera_sensor_get_info(&sensor->id);
        if (info != NULL) {
            strlcpy(sensor_name, info->name, sizeof(sensor_name));
        }
    }

    ready         = true;
    last_error[0] = '\0';
    DEBUG("camera: %s ready\n", sensor_name);

    xSemaphoreGive(cam_mutex); // Mutex release
    return true;
}

bool camera_start(void) {
    if (stopped || !camera_init()) {
        return false;
    }
    /* Settings written before the sensor delivered its first frame do not stick: the
     * stream came up at UXGA, the size of the init, whatever was stored. One frame
     * first, then the stored settings. */
    camera_return(camera_take());
    camera_settings_t settings;
    config_camera_settings(&settings);
    camera_apply(&settings);
    return true;
}

void camera_stop(void) {
    if (cam_mutex == NULL) {
        stopped = true;
        return;
    }
    xSemaphoreTake(cam_mutex, portMAX_DELAY); // Mutex block
    stopped = true;
    if (ready) {
        ready = false;
        esp_camera_deinit();
        DEBUG("camera: stopped\n");
    }
    xSemaphoreGive(cam_mutex); // Mutex release
}

bool camera_ready(void) {
    return ready;
}

const char *camera_sensor_name(void) {
    return sensor_name;
}

bool camera_apply(const camera_settings_t *settings) {
    if (!ready) {
        return false;
    }

    xSemaphoreTake(cam_mutex, portMAX_DELAY); // Mutex block

    sensor_t *sensor = esp_camera_sensor_get();
    if (sensor == NULL) {
        xSemaphoreGive(cam_mutex); // Mutex release
        return false;
    }

    framesize_t framesize = (framesize_t)settings->framesize;
    camera_sensor_info_t *info = esp_camera_sensor_get_info(&sensor->id);
    if (info != NULL && framesize > info->max_size) {
        framesize = info->max_size;
    }
    if (framesize > camera_config.frame_size) {
        framesize = camera_config.frame_size; // the frame buffers were sized for it
    }

    // each setter returns 0 on success
    int failed = 0;
    failed |= sensor->set_framesize(sensor, framesize);
    failed |= sensor->set_quality(sensor, settings->quality);
    failed |= sensor->set_vflip(sensor, settings->vflip);
    failed |= sensor->set_hmirror(sensor, settings->hmirror);
    failed |= sensor->set_brightness(sensor, settings->brightness);
    failed |= sensor->set_contrast(sensor, settings->contrast);
    failed |= sensor->set_saturation(sensor, settings->saturation);

    xSemaphoreGive(cam_mutex); // Mutex release

    if (failed) {
        DEBUG_ERROR("camera: a setting was not taken by the sensor\n");
    }
    return !failed;
}

camera_fb_t *camera_take(void) {
    if (!ready) {
        return NULL;
    }

    xSemaphoreTake(cam_mutex, portMAX_DELAY); // Mutex block
    camera_fb_t *fb = esp_camera_fb_get();
    xSemaphoreGive(cam_mutex); // Mutex release

    if (fb == NULL) {
        strlcpy(last_error, "no frame", sizeof(last_error));
        return NULL;
    }
    if (fb->format != PIXFORMAT_JPEG) {
        esp_camera_fb_return(fb);
        strlcpy(last_error, "not jpeg", sizeof(last_error));
        return NULL;
    }
    return fb;
}

void camera_return(camera_fb_t *fb) {
    if (fb != NULL) {
        esp_camera_fb_return(fb);
    }
}
