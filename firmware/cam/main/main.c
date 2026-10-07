/*
 * KIBBL-FW: live camera of kibbl. (docs/architecture.md)
 *
 * The device joins the home wifi, opens a websocket to the server and sends jpeg
 * frames at the rate the server asks for; the server relays them to the app.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"
#include "sdkconfig.h"

#include "BUILD_INFO.h"
#include "KL_camera.h"
#include "KL_camera_config.h"
#include "KL_commands.h"
#include "KL_config.h"
#include "KL_frame.h"
#include "KL_light.h"
#include "KL_local_http.h"
#include "KL_nvs.h"
#include "KL_ota.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_stream.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define SERIAL_STACK_SIZE  4096
#define NETWORK_STACK_SIZE 4096

#define CAMERA_INIT_TRIES    3
#define IMAGE_CONFIRM_S      (5 * 60) // a new image that ran this long is kept even without the server
#define QUICK_RESET_WINDOW_S 10       // a power cycle within this time of the boot counts as quick
#define QUICK_RESETS_TO_WIPE 3        // quick power cycles in a row that forget the wifi

#define NVS_QUICK_RESETS "QUICK_RST"

void network_task(void *pvParams);

/* ----------------------------------------------------------------------- */

/* The ESP32-CAM has no free button (GPIO0 is the camera clock): three power cycles,
 * each within 10 s of the boot, forget the wifi and start provisioning. A brownout
 * (weak supply when wifi starts) restarts with another reason and is not counted, so
 * a bad cable cannot wipe the settings. */
static void quick_reset_check(void) {
    esp_reset_reason_t reason = esp_reset_reason();
    uint8_t quick_resets      = 0;

    if (reason == ESP_RST_POWERON || reason == ESP_RST_EXT) {
        nvs_queue_job(NVS_QUICK_RESETS, &quick_resets, 0, UINT8_T, READ);
        quick_resets++;
    }
    nvs_queue_job(NVS_QUICK_RESETS, &quick_resets, 0, UINT8_T, WRITE);

    if (quick_resets >= QUICK_RESETS_TO_WIPE) {
        quick_resets = 0;
        nvs_queue_job(NVS_QUICK_RESETS, &quick_resets, 0, UINT8_T, WRITE);
        DEBUG_F("%d quick power cycles: forgetting the wifi\n", QUICK_RESETS_TO_WIPE);
        wifi_reset_credentials(); // needs wifi initialised, so it runs after wifi_start()
    } else if (quick_resets > 0) {
        DEBUG_F("quick power cycle %u of %d\n", quick_resets, QUICK_RESETS_TO_WIPE);
    }
}

static void quick_reset_clear(void) {
    uint8_t quick_resets = 0;
    nvs_queue_job(NVS_QUICK_RESETS, &quick_resets, 0, UINT8_T, WRITE);
}

/* ----------------------------------------------------------------------- */

static bool camera_start_at_boot(void) {
    for (int i = 0; i < CAMERA_INIT_TRIES; i++) {
        if (camera_start()) {
            return true;
        }
        delay_ms(500);
    }
    return false;
}

void app_main(void) {
    serial_begin();
    DEBUG_F_PLAIN("\n\033[1;32m%s\033[0m (%s, idf %s)\n", FW_VERSION, CONFIG_IDF_TARGET, esp_get_idf_version());

    nvs_setup();
    debug_status_init();
    config_load();
    config_camera_load();
    DEBUG_F("device id %s, server %s\n", config_device_id(), config_server_url());

    status_led_setup();
    light_setup();

    bool camera_ok = camera_start_at_boot();
    if (!camera_ok) {
        // still online: the app shows the error, the frame hub tries again every 30 s
        DEBUG_F_ERROR("no camera (%s), running without it\n", camera_last_error());
        set_status_led(LED_ERROR);
    }
    frame_hub_start();

    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_start();
    quick_reset_check();

    xTaskCreate(serial_cmd_task, "serial_cmd", SERIAL_STACK_SIZE, NULL, 3, NULL);
    xTaskCreate(network_task, "network", NETWORK_STACK_SIZE, NULL, 3, NULL);

    delay_ms(QUICK_RESET_WINDOW_S * 1000);
    quick_reset_clear();

    delay_ms((IMAGE_CONFIRM_S - QUICK_RESET_WINDOW_S) * 1000);
    ota_confirm_image();

    while (1) {
        DEBUG("heap %lu, psram %lu, camera %u fps\n", (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
              (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), frame_fps());
        delay_ms(60 * 1000);
    }
}

/* ----------------------------------------------------------------------- */

/* Starts what needs the home network once there is an ip address and the
 * provisioning access point (port 80) is gone. */
void network_task(void *pvParams) {
    xEventGroupWaitBits(wifi_event_group, WIFI_GOT_IP_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
    while (xEventGroupGetBits(wifi_event_group) & WIFI_PROV_ACTIVE_BIT) {
        delay_ms(500);
    }

    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(wifi_hostname());
        mdns_instance_name_set("kibbl. cam");
        mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }

#if CONFIG_KIBBL_LOCAL_HTTP
    local_http_start();
#endif

    stream_start();

    vTaskDelete(NULL);
}
