#include "KL_ota.h"

#include <ESP8266WiFi.h>
#include <ESP8266httpUpdate.h>
#include <WiFiClientSecureBearSSL.h>

#include "KL_product.h"
#include "KL_serial.h"
#include "KL_stream.h"
#include "KL_tls.h"

#define OTA_URL_MAX    256
#define OTA_TIMEOUT_MS 30000

static bool running = false;
static bool pending = false;
static char ota_url[OTA_URL_MAX];

bool ota_start(const char *url) {
    if (running || url == NULL || strlen(url) >= sizeof(ota_url)) {
        return false;
    }
    if (strncmp(url, "http://", 7) != 0 && strncmp(url, "https://", 8) != 0) {
        return false;
    }
    strlcpy(ota_url, url, sizeof(ota_url));
    running = true;
    pending = true; // after this turn of the loop: the response to the command goes out first
    return true;
}

bool ota_running(void) {
    return running;
}

void ota_loop(void) {
    if (!pending) {
        return;
    }
    pending = false;
    delay(200);
    DEBUG_F("ota: downloading %s\n", ota_url);

    // the product stops what competes for the link, the memory and the flash
    product_ota_prepare();
    stream_stop();

    ESPhttpUpdate.rebootOnUpdate(false);
    ESPhttpUpdate.setClientTimeout(OTA_TIMEOUT_MS);
    ESPhttpUpdate.onProgress([](int done, int total) { product_ota_progress(done, total); });

    HTTPUpdateResult result;
    if (strncmp(ota_url, "https://", 8) == 0) {
        BearSSL::WiFiClientSecure client;
        tls_prepare(client);
        result = ESPhttpUpdate.update(client, ota_url);
    } else {
        WiFiClient client;
        result = ESPhttpUpdate.update(client, ota_url);
    }

    if (result == HTTP_UPDATE_OK) {
        DEBUG_F("ota: done, restarting\n");
    } else {
        // what the product stopped comes back with the restart, on the image that runs now
        DEBUG_F_ERROR("ota: failed (%d: %s), restarting\n", ESPhttpUpdate.getLastError(), ESPhttpUpdate.getLastErrorString().c_str());
    }
    delay(500);
    ESP.restart();
}
