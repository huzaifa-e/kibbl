/*
 * HOME-MONITOR-FW: live camera of the home monitor (docs/architecture.md)
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

#include "cJSON.h"

#include "BUILD_INFO.h"
#include "IC_camera.h"
#include "IC_commands.h"
#include "IC_config.h"
#include "IC_frame.h"
#include "IC_light.h"
#include "IC_local_http.h"
#include "IC_nvs.h"
#include "IC_ota.h"
#include "IC_serial.h"
#include "IC_status_led.h"
#include "IC_stream.h"
#include "IC_time.h"
#include "IC_wifi_prov.h"

#define SERIAL_STACK_SIZE  4096
#define NETWORK_STACK_SIZE 4096

#define CAMERA_INIT_TRIES    3
#define IMAGE_CONFIRM_S      (5 * 60) // a new image that ran this long is kept even without the server
#define QUICK_RESET_WINDOW_S 10       // a power cycle within this time of the boot counts as quick
#define QUICK_RESETS_TO_WIPE 3        // quick power cycles in a row that forget the wifi

#define NVS_QUICK_RESETS "QUICK_RST"

void serial_cmd_task(void *pvParams);
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

static bool camera_start(void) {
    for (int i = 0; i < CAMERA_INIT_TRIES; i++) {
        if (camera_init()) {
            camera_settings_t settings;
            config_camera_settings(&settings);
            camera_apply(&settings);
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
    DEBUG_F("device id %s, server %s\n", config_device_id(), config_server_url());

    status_led_setup();
    light_setup();

    bool camera_ok = camera_start();
    if (!camera_ok) {
        // still online: the server shows the error and an update can fix it
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
        mdns_instance_name_set("Home Monitor camera");
        mdns_service_add(NULL, "_http", "_tcp", 80, NULL, 0);
    }

#if CONFIG_HM_LOCAL_HTTP
    local_http_start();
#endif

    stream_start();

    vTaskDelete(NULL);
}

/* ----------------------------------------------------------------------- */

void serial_cmd_task(void *pvParams) {
    while (1) {
        cJSON *req = get_serial_req();
        if (req == NULL) {
            continue; // get_serial_req() waits 20 ms for input
        }

        cJSON *resp = commands_handle(req, CMD_SOURCE_SERIAL);
        cJSON_Delete(req);

        if (resp != NULL) {
            char *str = cJSON_PrintUnformatted(resp);
            if (str != NULL) {
                DEBUG_F_PLAIN("%s\n", str);
                free(str);
            }
            cJSON_Delete(resp);
        }
    }
}
