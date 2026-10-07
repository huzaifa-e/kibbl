#include "KL_config.h"

#include <stdio.h>
#include <string.h>

#include "esp_mac.h"
#include "esp_random.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_nvs.h"
#include "KL_serial.h"

#define NVS_SERVER_URL    "SERVER_URL"
#define NVS_DEVICE_SECRET "DEV_SECRET"
#define NVS_LOCAL_KEY     "LOCAL_KEY"

static SemaphoreHandle_t config_mutex;

static char device_id[DEVICE_ID_LEN + 1];
static char device_secret[DEVICE_SECRET_LEN + 1];
static char local_key[LOCAL_KEY_LEN + 1];
static char server_url[SERVER_URL_MAX];

/* ----------------------------------------------------------------------- */

static void random_hex(char *out, size_t hex_len) {
    static const char hex[] = "0123456789abcdef";
    uint8_t bytes[32];
    esp_fill_random(bytes, hex_len / 2);
    for (size_t i = 0; i < hex_len / 2; i++) {
        out[2 * i]     = hex[bytes[i] >> 4];
        out[2 * i + 1] = hex[bytes[i] & 0x0f];
    }
    out[hex_len] = '\0';
    memset(bytes, 0, sizeof(bytes));
}

/* A secret read back with the wrong length or with other characters than hex was
 * not written by this firmware: make a new one rather than send it. */
static bool is_hex(const char *str, size_t len) {
    if (strlen(str) != len) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        char c = str[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
            return false;
        }
    }
    return true;
}

static void load_or_create(const char *key, char *value, size_t hex_len) {
    if (nvs_queue_job(key, value, hex_len + 1, STRING, READ) && is_hex(value, hex_len)) {
        return;
    }
    random_hex(value, hex_len);
    if (!nvs_queue_job(key, value, 0, STRING, WRITE)) {
        DEBUG_F_ERROR("%s not stored, a new one is made on the next boot\n", key);
    }
    DEBUG("%s created\n", key);
}

void config_load(void) {
    config_mutex = xSemaphoreCreateMutex();

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(device_id, sizeof(device_id), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    load_or_create(NVS_DEVICE_SECRET, device_secret, DEVICE_SECRET_LEN);
    load_or_create(NVS_LOCAL_KEY, local_key, LOCAL_KEY_LEN);

    if (!nvs_queue_job(NVS_SERVER_URL, server_url, sizeof(server_url), STRING, READ) || server_url[0] == '\0') {
        strlcpy(server_url, CONFIG_KIBBL_SERVER_URL, sizeof(server_url));
    }

}

void config_reset(void) {
    nvs_remove_key(NVS_SERVER_URL);
    nvs_remove_key(NVS_DEVICE_SECRET);
    nvs_remove_key(NVS_LOCAL_KEY);
}

const char *config_device_id(void) {
    return device_id;
}

const char *config_device_secret(void) {
    return device_secret;
}

const char *config_local_key(void) {
    return local_key;
}

/* ----------------------------------------------------------------------- */

const char *config_server_url(void) {
    return server_url;
}

bool config_set_server_url(const char *url) {
    if (url == NULL || strlen(url) >= SERVER_URL_MAX) {
        return false;
    }
    if (strncmp(url, "ws://", 5) != 0 && strncmp(url, "wss://", 6) != 0) {
        return false;
    }

    // the stream task reads it on the next connect only, which happens after a reboot
    xSemaphoreTake(config_mutex, portMAX_DELAY);
    strlcpy(server_url, url, sizeof(server_url));
    bool stored = nvs_queue_job(NVS_SERVER_URL, server_url, 0, STRING, WRITE);
    xSemaphoreGive(config_mutex);
    return stored;
}
