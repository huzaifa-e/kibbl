#include "KL_commands.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"

#include "KL_config.h"
#include "KL_ota.h"
#include "KL_product.h"
#include "KL_serial.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define RESTART_DELAY_US (1000 * 1000) // the response goes out first

static esp_timer_handle_t restart_timer = NULL;

static void restart_cb(void *arg) {
    esp_restart();
}

void restart_later(void) {
    if (restart_timer == NULL) {
        const esp_timer_create_args_t args = {
            .callback = restart_cb,
            .name     = "restart",
        };
        if (esp_timer_create(&args, &restart_timer) != ESP_OK) {
            esp_restart();
        }
    }
    esp_timer_stop(restart_timer);
    esp_timer_start_once(restart_timer, RESTART_DELAY_US);
}

/* ----------------------------------------------------------------------- */

void commands_add_info(cJSON *json, cmd_source_t source) {
    char ip[16];
    int rssi = 0;

    cJSON_AddStringToObject(json, "fw", product_fw_version());
    // "deviceId", not "id": a response carries the "id" of its request
    cJSON_AddStringToObject(json, "deviceId", config_device_id());
    cJSON_AddStringToObject(json, "hostname", wifi_hostname());
    if (wifi_ip_string(ip, sizeof(ip))) {
        cJSON_AddStringToObject(json, "ip", ip);
    }
    cJSON_AddStringToObject(json, "ssid", get_configured_ssid());
    if (wifi_change_failed()[0] != '\0') {
        cJSON_AddStringToObject(json, "wifiChangeFailed", wifi_change_failed());
    }
    cJSON_AddBoolToObject(json, "provisioned", wifi_connect_state() != WIFI_NOT_PROVISIONED);
    if (wifi_rssi(&rssi)) {
        cJSON_AddNumberToObject(json, "rssi", rssi);
    }
    cJSON_AddNumberToObject(json, "uptime", (double)(millis() / 1000));
    cJSON_AddNumberToObject(json, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(json, "resetReason", esp_reset_reason());

    // model, board, caps and the state of the product
    product_add_info(json, source);

    if (source == CMD_SOURCE_SERIAL) {
        // the server url goes to the person holding the device only
        cJSON_AddStringToObject(json, "server", config_server_url());
    }
}

/* ----------------------------------------------------------------------- */

const char *json_string(const cJSON *req, const char *key) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(req, key);
    return cJSON_IsString(item) ? item->valuestring : NULL;
}

bool json_int_in_range(const cJSON *json, const char *key, int min, int max, int *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (item == NULL) {
        return true; // left out, keeps its value
    }
    if (!cJSON_IsNumber(item) || item->valueint < min || item->valueint > max) {
        return false;
    }
    *out = item->valueint;
    return true;
}

bool json_bool(const cJSON *json, const char *key, bool *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(json, key);
    if (item == NULL) {
        return true;
    }
    if (!cJSON_IsBool(item)) {
        return false;
    }
    *out = cJSON_IsTrue(item);
    return true;
}

/* Over serial (the setup in the app, or a terminal) the network is taken at once, also
 * while provisioning runs. From the server the device switches in the background and
 * goes back to its network when the new one does not work: it may be out of reach. */
static const char *cmd_wifi(const cJSON *req, cJSON *resp, cmd_source_t source) {
    const char *ssid     = json_string(req, "ssid");
    const char *password = json_string(req, "password");
    if (ssid == NULL || password == NULL) {
        return "ssid and password needed";
    }
    if (source == CMD_SOURCE_SERIAL) {
        return wifi_set_credentials(ssid, password) ? NULL : "wifi settings not taken";
    }
    if (!wifi_change_network(ssid, password)) {
        return "ssid 1-32 and password 8-63 characters (or none), one change at a time";
    }
    cJSON_AddBoolToObject(resp, "pending", true);
    cJSON_AddNumberToObject(resp, "fallbackSeconds", WIFI_CHANGE_TIMEOUT_MS / 1000);
    return NULL;
}

#define SCAN_MAX 20

static const char *cmd_wifi_scan(const cJSON *req, cJSON *resp) {
    wifi_ap_record_t *records = calloc(SCAN_MAX, sizeof(wifi_ap_record_t));
    if (records == NULL) {
        return "no memory";
    }
    int count = wifi_scan(records, SCAN_MAX);
    if (count < 0) {
        free(records);
        return "scan failed";
    }
    cJSON *networks = cJSON_AddArrayToObject(resp, "networks");
    for (int i = 0; i < count; i++) {
        cJSON *net = cJSON_CreateObject();
        char ssid[33];
        memcpy(ssid, records[i].ssid, 32);
        ssid[32] = '\0';
        cJSON_AddStringToObject(net, "ssid", ssid);
        cJSON_AddNumberToObject(net, "rssi", records[i].rssi);
        cJSON_AddBoolToObject(net, "secure", records[i].authmode != WIFI_AUTH_OPEN);
        cJSON_AddItemToArray(networks, net);
    }
    free(records);
    return NULL;
}

static const char *cmd_server(const cJSON *req, cJSON *resp) {
    const char *url = json_string(req, "url");
    if (!config_set_server_url(url)) {
        return "url must start with ws:// or wss://, at most 127 characters";
    }
    cJSON_AddStringToObject(resp, "server", config_server_url());
    restart_later(); // the stream connects with the url read at boot
    return NULL;
}

static const char *cmd_ota(const cJSON *req, cJSON *resp) {
    if (!ota_start(json_string(req, "url"))) {
        return ota_running() ? "update already running" : "url must start with http:// or https://";
    }
    return NULL;
}

cJSON *commands_handle(const cJSON *req, cmd_source_t source) {
    cJSON *resp = cJSON_CreateObject();
    if (resp == NULL) {
        return NULL;
    }

    const cJSON *id = cJSON_GetObjectItemCaseSensitive(req, "id");
    if (id != NULL) {
        cJSON_AddItemToObject(resp, "id", cJSON_Duplicate(id, true));
    }

    const char *cmd   = json_string(req, "cmd");
    const char *error = NULL;
    bool serial       = source == CMD_SOURCE_SERIAL;

    if (cmd == NULL) {
        error = "no cmd";
    } else if (strcmp(cmd, "info") == 0) {
        commands_add_info(resp, source);
    } else if (strcmp(cmd, "ota") == 0) {
        error = cmd_ota(req, resp);
    } else if (strcmp(cmd, "reboot") == 0) {
        restart_later();
    } else if (strcmp(cmd, "wifi") == 0) {
        error = cmd_wifi(req, resp, source);
    } else if (strcmp(cmd, "wifi_scan") == 0) {
        error = cmd_wifi_scan(req, resp);
    } else if (strcmp(cmd, "wifi_reset") == 0) {
        wifi_reset_credentials();
    } else if (serial && strcmp(cmd, "debug") == 0) {
        debug_status_toggle();
    } else if (serial && strcmp(cmd, "server") == 0) {
        error = cmd_server(req, resp);
    } else if (serial && strcmp(cmd, "factory_reset") == 0) {
        // a new device secret: the server sees a new device that has to be approved again
        config_reset();
        product_reset();
        wifi_reset_credentials();
    } else if (!product_command(cmd, req, resp, source, &error)) {
        error = "unknown cmd";
    }

    cJSON_AddBoolToObject(resp, "ok", error == NULL);
    if (error != NULL) {
        cJSON_AddStringToObject(resp, "error", error);
    }
    return resp;
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
