/*
 * KIBBL-AIR: the Conny CO2 traffic light as a kibbl. device (docs/architecture.md)
 *
 * The device measures CO2, temperature and humidity, shows the air on its traffic light,
 * runs the fan, finds cigarettes and open windows, and sends it all to the server over
 * the websocket of the shared core. It works on its own without the network.
 */

#include <stdio.h>

#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"
#include "sdkconfig.h"

#include "BUILD_INFO.h"
#include "KL_air.h"
#include "KL_air_config.h"
#include "KL_button.h"
#include "KL_buzzer.h"
#include "KL_commands.h"
#include "KL_config.h"
#include "KL_events.h"
#include "KL_fan.h"
#include "KL_i2c.h"
#include "KL_ioexp.h"
#include "KL_nvs.h"
#include "KL_ota.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_stream.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define SERIAL_STACK_SIZE  4096
#define NETWORK_STACK_SIZE 4096

#define IMAGE_CONFIRM_S (5 * 60) // a new image that ran this long is kept even without the server

void network_task(void *pvParams);

/* ----------------------------------------------------------------------- */

void app_main(void) {
    serial_begin();
    DEBUG_F_PLAIN("\n\033[1;32m%s\033[0m (%s, idf %s)\n", FW_VERSION, CONFIG_IDF_TARGET, esp_get_idf_version());

    nvs_setup();
    debug_status_init();
    config_load();
    config_air_load();
    DEBUG_F("device id %s, server %s\n", config_device_id(), config_server_url());

    // the external watchdog resets the board unless it is fed: first of all
    i2c_bus_setup();
    ioexp_setup();
    ioexp_watchdog_start();

    events_setup();
    status_led_setup();
    fan_setup();
    buzzer_setup();
    air_start();
    button_setup(air_button_pressed);

    ESP_ERROR_CHECK(esp_event_loop_create_default());
    wifi_start();

    xTaskCreate(serial_cmd_task, "serial_cmd", SERIAL_STACK_SIZE, NULL, 3, NULL);
    xTaskCreate(network_task, "network", NETWORK_STACK_SIZE, NULL, 3, NULL);

    delay_ms(IMAGE_CONFIRM_S * 1000);
    ota_confirm_image();

    while (1) {
        DEBUG("heap %lu, min %lu\n", (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
              (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
        delay_ms(60 * 1000);
    }
}

/* ----------------------------------------------------------------------- */

/* Starts what needs the home network once there is an ip address: the server at once
 * (the setup page waits for it to pair the device), the name on the home network once
 * the setup portal is gone. */
void network_task(void *pvParams) {
    xEventGroupWaitBits(wifi_event_group, WIFI_GOT_IP_BIT, pdFALSE, pdTRUE, portMAX_DELAY);
    stream_start();

    while (xEventGroupGetBits(wifi_event_group) & WIFI_PROV_ACTIVE_BIT) {
        delay_ms(500);
    }
    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(wifi_hostname());
        mdns_instance_name_set("kibbl. air");
    }

    vTaskDelete(NULL);
}
