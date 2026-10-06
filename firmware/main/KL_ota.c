#include "KL_ota.h"

#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "KL_camera.h"
#include "KL_frame.h"
#include "KL_serial.h"
#include "KL_time.h"

#define OTA_STACK_SIZE   8192
#define OTA_URL_MAX      256
#define OTA_TIMEOUT_MS   30000

static volatile bool running = false;
static char ota_url[OTA_URL_MAX];

static void ota_task(void *pvParams) {
    DEBUG_F("ota: downloading %s\n", ota_url);

    // the stream competes for the same link and PSRAM
    for (int i = 0; i < FRAME_CONSUMERS; i++) {
        frame_set_demand((frame_consumer_t)i, 0);
    }
    /* The camera keeps capturing without consumers; with the cache paused for the flash
     * writes its interrupt trips the watchdog and the board resets halfway (TG1WDT).
     * The frame task lets go of its frame within one frame time once nobody asks. */
    delay_ms(300);
    camera_stop();

    esp_http_client_config_t http_config = {
        .url               = ota_url,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .timeout_ms        = OTA_TIMEOUT_MS,
        .keep_alive_enable = true,
    };
    esp_https_ota_config_t ota_config = {
        .http_config = &http_config,
    };

    esp_err_t err = esp_https_ota(&ota_config);
    if (err == ESP_OK) {
        DEBUG_F("ota: done, restarting\n");
        delay_ms(500);
        esp_restart();
    }

    // the camera is stopped for good: a restart brings it back, on the image that runs now
    DEBUG_F_ERROR("ota: failed (%s), restarting\n", esp_err_to_name(err));
    delay_ms(500);
    esp_restart();
}

bool ota_start(const char *url) {
    if (running || url == NULL || strlen(url) >= sizeof(ota_url)) {
        return false;
    }
    if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
        return false;
    }
    strlcpy(ota_url, url, sizeof(ota_url));
    running = true;
    if (xTaskCreate(ota_task, "ota_task", OTA_STACK_SIZE, NULL, 4, NULL) != pdPASS) {
        running = false;
        return false;
    }
    return true;
}

bool ota_running(void) {
    return running;
}

void ota_confirm_image(void) {
    const esp_partition_t *running_partition = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running_partition, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
            DEBUG_F("ota: new image confirmed\n");
        }
    }
}
