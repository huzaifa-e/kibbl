/*
 * KIBBL-LIGHT: the Magic Home controller of an analog RGB strip as a kibbl. device
 * (docs/architecture.md), on the Arduino core of the ESP8266
 *
 * The device drives the strip with one colour, keeps it across power cuts and takes its light
 * from the server over a websocket, the protocol of kibbl_core (docs/protocol.md). It works on
 * its own without the network. kibbl_core needs ESP-IDF 5, which has no ESP8266: the KL_ files
 * here are its counterparts, small enough for the 1 MB of the ESP8285 with two images.
 */

#include "BUILD_INFO.h"
#include "KL_commands.h"
#include "KL_config.h"
#include "KL_ota.h"
#include "KL_portal.h"
#include "KL_product.h"
#include "KL_recovery.h"
#include "KL_serial.h"
#include "KL_strip.h"
#include "KL_stream.h"
#include "KL_wifi.h"

#define HEAP_LOG_MS (60 * 1000)

static uint32_t last_heap_log = 0;

void setup() {
    serial_begin();
    DEBUG_F_PLAIN("\n\033[1;32m%s\033[0m (esp8266, core %s)\n", product_fw_version(), ESP.getCoreVersion().c_str());

    recovery_boot_check();
    config_load();
    debug_status_init();
    DEBUG_F("device id %s, server %s\n", config_device_id(), config_server_url());

    // the light of before the power cut, at once; dark in safe mode
    if (!recovery_active()) {
        strip_setup();
    }
    wifi_start();
}

void loop() {
    commands_loop();
    wifi_loop();
    portal_loop();
    stream_loop();
    ota_loop();
    if (!recovery_active()) {
        strip_loop();
    }

    if (millis() - last_heap_log > HEAP_LOG_MS) {
        last_heap_log = millis();
        DEBUG("heap %u, largest block %u\n", ESP.getFreeHeap(), ESP.getMaxFreeBlockSize());
    }
}
