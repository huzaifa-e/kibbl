#include "KL_commands.h"

#include <ESP8266WiFi.h>

#include "KL_config.h"
#include "KL_ota.h"
#include "KL_product.h"
#include "KL_recovery.h"
#include "KL_serial.h"
#include "KL_wifi.h"

#define RESTART_DELAY_MS 1000 // the response goes out first
#define SCAN_MAX         20

static uint32_t restart_at = 0;

void restart_later(void) {
    restart_at = millis() + RESTART_DELAY_MS;
    if (restart_at == 0) {
        restart_at = 1;
    }
}

/* ----------------------------------------------------------------------- */

void commands_add_info(JsonObject json, cmd_source_t source) {
    char ip[16];
    int rssi = 0;

    json["fw"] = product_fw_version();
    // "deviceId", not "id": a response carries the "id" of its request
    json["deviceId"] = config_device_id();
    json["hostname"] = wifi_hostname();
    if (wifi_ip_string(ip, sizeof(ip))) {
        json["ip"] = ip;
    }
    json["ssid"] = get_configured_ssid();
    if (wifi_change_failed()[0] != '\0') {
        json["wifiChangeFailed"] = wifi_change_failed();
    }
    json["provisioned"] = wifi_connect_state() != WIFI_NOT_PROVISIONED;
    if (wifi_rssi(&rssi)) {
        json["rssi"] = rssi;
    }
    json["uptime"]      = millis() / 1000;
    json["heap"]        = ESP.getFreeHeap();
    json["resetReason"] = ESP.getResetInfoPtr()->reason;
    if (recovery_active()) {
        json["safeMode"] = true;
    }

    // model, board, caps and the state of the product
    product_add_info(json, source);

    if (source == CMD_SOURCE_SERIAL) {
        // the server url and the pairing code go to the person holding the device only
        json["server"]    = config_server_url();
        json["claimCode"] = config_claim_code();
    } else {
        // the server takes a device into the account of who types the code (Devices, Add with a code)
        json["claimHash"] = config_claim_hash();
    }
}

/* ----------------------------------------------------------------------- */

bool json_int_in_range(JsonObjectConst json, const char *key, int min, int max, int *out) {
    JsonVariantConst v = json[key];
    if (v.isNull()) {
        return true; // left out, keeps its value
    }
    if (!v.is<int>() || v.as<int>() < min || v.as<int>() > max) {
        return false;
    }
    *out = v.as<int>();
    return true;
}

/* Over serial (a terminal) the network is taken at once, also while the portal runs. From
 * the server the device switches in the background and goes back to its network when the new
 * one does not work: it may be out of reach. */
static const char *cmd_wifi(JsonObjectConst req, JsonDocument &resp, cmd_source_t source) {
    const char *ssid     = req["ssid"].as<const char *>();
    const char *password = req["password"].as<const char *>();
    if (ssid == NULL || password == NULL) {
        return "ssid and password needed";
    }
    if (source == CMD_SOURCE_SERIAL) {
        return wifi_set_credentials(ssid, password) ? NULL : "wifi settings not taken";
    }
    if (!wifi_change_network(ssid, password)) {
        return "ssid 1-32 and password 8-63 characters (or none), one change at a time";
    }
    resp["pending"]         = true;
    resp["fallbackSeconds"] = WIFI_CHANGE_TIMEOUT_MS / 1000;
    return NULL;
}

static const char *cmd_wifi_scan(JsonDocument &resp) {
    return wifi_scan(resp["networks"].to<JsonArray>(), SCAN_MAX) < 0 ? "scan failed" : NULL;
}

static const char *cmd_server(JsonObjectConst req, JsonDocument &resp) {
    if (!config_set_server_url(req["url"].as<const char *>())) {
        return "url must start with ws:// or wss://, at most 127 characters";
    }
    resp["server"] = config_server_url();
    restart_later(); // the stream connects with the url read at boot
    return NULL;
}

static const char *cmd_ota(JsonObjectConst req) {
    if (!ota_start(req["url"].as<const char *>())) {
        return ota_running() ? "update already running" : "url must start with http:// or https://";
    }
    return NULL;
}

void commands_handle(JsonObjectConst req, JsonDocument &resp, cmd_source_t source) {
    if (!req["id"].isNull()) {
        resp["id"] = req["id"];
    }

    const char *cmd   = req["cmd"].as<const char *>();
    const char *error = NULL;
    bool serial       = source == CMD_SOURCE_SERIAL;

    if (cmd == NULL) {
        error = "no cmd";
    } else if (strcmp(cmd, "info") == 0) {
        commands_add_info(resp.as<JsonObject>(), source);
    } else if (strcmp(cmd, "ota") == 0) {
        error = cmd_ota(req);
    } else if (strcmp(cmd, "reboot") == 0) {
        restart_later();
    } else if (strcmp(cmd, "wifi") == 0) {
        error = cmd_wifi(req, resp, source);
    } else if (strcmp(cmd, "wifi_scan") == 0) {
        error = cmd_wifi_scan(resp);
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

    resp["ok"] = error == NULL;
    if (error != NULL) {
        resp["error"] = error;
    }
}

/* ----------------------------------------------------------------------- */

void commands_loop(void) {
    char *line = get_serial_line();
    if (line != NULL) {
        JsonDocument req;
        if (deserializeJson(req, line)) {
            DEBUG_F("invalid input over serial (no json)\n");
        } else {
            JsonDocument resp;
            commands_handle(req.as<JsonObjectConst>(), resp, CMD_SOURCE_SERIAL);
            serializeJson(resp, Serial);
            Serial.println();
        }
    }
    if (restart_at != 0 && (int32_t)(millis() - restart_at) >= 0) {
        ESP.restart();
    }
}
