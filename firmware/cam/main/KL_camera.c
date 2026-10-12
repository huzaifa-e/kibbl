#include "KL_camera.h"

#include <stdio.h>
#include <string.h>

#include <stdlib.h>

#include "driver/gpio.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_hw.h"
#include "KL_serial.h"

static SemaphoreHandle_t cam_mutex;

#if CAM_SOFT_JPEG
static int soft_quality = 80; // the encoder's 1-100, higher is better: from the setting's 4-63
#endif
static bool ready   = false;
static bool stopped = false; // camera_stop() was called: nothing starts it again until a restart
static char sensor_name[16] = "none";
static char last_error[24];

const char *camera_last_error(void) {
    return last_error;
}

/* The driver sizes its jpeg frame buffers by the frame size given at init, and a later
 * larger frame size overflows them (FB-OVF). It starts at UXGA, the largest size the
 * settings offer, and camera_apply() sets the size actually streamed. A board with raw
 * frames streams one size only, the one it starts with (CAM_FIXED_FRAMESIZE). */
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

    .xclk_freq_hz = CAM_XCLK_HZ,

    .ledc_timer   = CAMERA_TIMER,
    .ledc_channel = CAMERA_CHANNEL,

#if CAM_SOFT_JPEG
    .pixel_format = PIXFORMAT_GRAYSCALE, // the sensor has no jpeg: raw, encoded in camera_take()
#else
    .pixel_format = PIXFORMAT_JPEG,
#endif
#ifdef CAM_FIXED_FRAMESIZE
    .frame_size   = CAM_FIXED_FRAMESIZE,
#else
    .frame_size   = FRAMESIZE_UXGA,
#endif

    .jpeg_quality = 12, // 0-63, for OV series camera sensors, lower number means higher quality
    .fb_location  = CAMERA_FB_IN_PSRAM,
    .fb_count     = 2,  // two buffers: the driver fills one while the other is sent (or encoded)
    .grab_mode    = CAMERA_GRAB_LATEST, // a slow consumer gets the newest frame, not a queued one
};

// a board that switches the camera's supply: on, and time for its regulators to settle
static void camera_power(bool on) {
#ifdef CAM_POWER_PIN
    gpio_reset_pin((gpio_num_t)CAM_POWER_PIN);
    gpio_set_direction((gpio_num_t)CAM_POWER_PIN, GPIO_MODE_OUTPUT);
    gpio_set_level((gpio_num_t)CAM_POWER_PIN, on ? 0 : 1);
    if (on) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
#endif
}

bool camera_init(void) {
    if (cam_mutex == NULL) {
        cam_mutex = xSemaphoreCreateMutex();
    }
    camera_power(true);

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
        camera_power(false);
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
#ifdef CAM_FIXED_FRAMESIZE
    (void)framesize; // raw frames must stay the size the driver was started with
#else
    failed |= sensor->set_framesize(sensor, framesize);
#endif
#if CAM_SOFT_JPEG
    // the encoder is ours: the setting's 4 (best) to 63 becomes 86 to 27
    soft_quality = 90 - settings->quality;
#else
    failed |= sensor->set_quality(sensor, settings->quality);
#endif
    failed |= sensor->set_vflip(sensor, settings->vflip);
    failed |= sensor->set_hmirror(sensor, settings->hmirror);
#if CAM_SOFT_JPEG
    // the GC2145 has none of these three: its driver refuses them, nothing is wrong
    sensor->set_brightness(sensor, settings->brightness);
    sensor->set_contrast(sensor, settings->contrast);
    sensor->set_saturation(sensor, settings->saturation);
#else
    failed |= sensor->set_brightness(sensor, settings->brightness);
    failed |= sensor->set_contrast(sensor, settings->contrast);
    failed |= sensor->set_saturation(sensor, settings->saturation);
#endif

    xSemaphoreGive(cam_mutex); // Mutex release

    if (failed) {
        DEBUG_ERROR("camera: a setting was not taken by the sensor\n");
    }
    return !failed;
}

#if CAM_SOFT_JPEG
#include "esp_jpeg_enc.h"

#define JPEG_OUT_MAX (256 * 1024) // a grayscale SVGA frame is 40-80 kB

static jpeg_enc_handle_t encoder;
static uint8_t *enc_block, *enc_out; // 16-byte aligned, as the S3 encoder needs
static int enc_block_size;
static int enc_quality;
static volatile uint8_t center_luma;

uint8_t camera_center_luma(void) {
    return center_luma;
}

// the mean brightness of the middle quarter of a grayscale frame, every 4th pixel
static uint8_t middle_luma(const camera_fb_t *fb) {
    uint32_t sum = 0, n = 0;
    for (size_t y = fb->height / 4; y < fb->height * 3 / 4; y += 4) {
        const uint8_t *row = fb->buf + y * fb->width;
        for (size_t x = fb->width / 4; x < fb->width * 3 / 4; x += 4) {
            sum += row[x];
            n++;
        }
    }
    return n ? sum / n : 0;
}

/* The frame as jpeg with Espressif's encoder (esp_new_jpeg, SIMD on the S3), into a buffer
 * of our own: camera_return() frees it. It takes the frame a strip of rows at a time, each
 * copied into internal RAM first. */
static camera_fb_t *soft_encode(const camera_fb_t *fb) {
    if (encoder == NULL || enc_quality != soft_quality) {
        if (encoder != NULL) {
            jpeg_enc_close(encoder);
            encoder = NULL;
        }
        jpeg_enc_config_t cfg = DEFAULT_JPEG_ENC_CONFIG();
        cfg.width       = fb->width;
        cfg.height      = fb->height;
        cfg.src_type    = JPEG_PIXEL_FORMAT_GRAY;
        cfg.subsampling = JPEG_SUBSAMPLE_GRAY;
        cfg.quality     = soft_quality;
        if (jpeg_enc_open(&cfg, &encoder) != JPEG_ERR_OK) {
            encoder = NULL;
            return NULL;
        }
        enc_quality = soft_quality;
        int block   = jpeg_enc_get_block_size(encoder);
        if (block != enc_block_size) {
            heap_caps_free(enc_block);
            enc_block      = heap_caps_aligned_alloc(16, block, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
            enc_block_size = enc_block ? block : 0;
        }
    }
    if (enc_out == NULL) {
        enc_out = jpeg_calloc_align(JPEG_OUT_MAX, 16);
    }
    if (enc_block == NULL || enc_out == NULL || fb->len % enc_block_size != 0) {
        return NULL;
    }
    int out_len = 0;
    for (size_t at = 0; at < fb->len; at += enc_block_size) {
        memcpy(enc_block, fb->buf + at, enc_block_size);
        if (jpeg_enc_process_with_block(encoder, enc_block, enc_block_size, enc_out, JPEG_OUT_MAX, &out_len) < JPEG_ERR_OK) {
            return NULL;
        }
    }
    if (out_len <= 0) {
        return NULL;
    }
    camera_fb_t *jpeg = calloc(1, sizeof(camera_fb_t));
    uint8_t *buf      = malloc(out_len);
    if (jpeg == NULL || buf == NULL) {
        free(jpeg);
        free(buf);
        return NULL;
    }
    memcpy(buf, enc_out, out_len);
    *jpeg        = *fb;
    jpeg->buf    = buf;
    jpeg->len    = out_len;
    jpeg->format = PIXFORMAT_JPEG;
    return jpeg;
}
#endif

camera_fb_t *camera_take(void) {
    if (!ready) {
        return NULL;
    }

    xSemaphoreTake(cam_mutex, portMAX_DELAY); // Mutex block
#if CAM_SOFT_JPEG
    int64_t t0 = esp_timer_get_time();
#endif
    camera_fb_t *fb = esp_camera_fb_get();
    xSemaphoreGive(cam_mutex); // Mutex release

    if (fb == NULL) {
        strlcpy(last_error, "no frame", sizeof(last_error));
        return NULL;
    }
#if CAM_SOFT_JPEG
    static int64_t grab_us, encode_us;
    static uint32_t timed, luma_sum;
    int64_t t1 = esp_timer_get_time();
    center_luma = middle_luma(fb);
    camera_fb_t *jpeg = soft_encode(fb);
    esp_camera_fb_return(fb);
    if (jpeg == NULL) {
        strlcpy(last_error, "no jpeg", sizeof(last_error));
    }
    encode_us += esp_timer_get_time() - t1;
    grab_us += t1 - t0;
    luma_sum += center_luma;
    if (++timed == 50) {
        DEBUG("camera: 50 frames, each %lld ms waiting, %lld ms encoding; the middle at %lu of 255\n", grab_us / 50000,
              encode_us / 50000, luma_sum / 50);
        grab_us = encode_us = 0;
        timed = luma_sum = 0;
    }
    return jpeg;
#else
    if (fb->format != PIXFORMAT_JPEG) {
        esp_camera_fb_return(fb);
        strlcpy(last_error, "not jpeg", sizeof(last_error));
        return NULL;
    }
    return fb;
#endif
}

void camera_return(camera_fb_t *fb) {
    if (fb == NULL) {
        return;
    }
#if CAM_SOFT_JPEG
    free(fb->buf);
    free(fb);
#else
    esp_camera_fb_return(fb);
#endif
}
