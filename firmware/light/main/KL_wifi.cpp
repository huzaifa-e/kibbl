#include "KL_wifi.h"

#include <ESP8266WiFi.h>

#include "KL_portal.h"
#include "KL_serial.h"
#include "KL_status_led.h"

static connect_state_t connect_state = WIFI_NOT_PROVISIONED;
static char hostname[24];
static char ssid_now[33];

static WiFiEventHandler got_ip_handler;
static WiFiEventHandler connected_handler;
static WiFiEventHandler disconnected_handler;

// a change from the app: the network it had, to go back to
static bool change_running = false;
static uint32_t change_since = 0;
static char change_ssid[33];
static char old_ssid[33];
static char old_password[65];
static char change_failed[33];

/* ----------------------------------------------------------------------- */

static void on_connected(const WiFiEventStationModeConnected &event) {
    strlcpy(ssid_now, event.ssid.c_str(), sizeof(ssid_now));
    connect_state = WIFI_CONNECTED;
}

static void on_got_ip(const WiFiEventStationModeGotIP &event) {
    DEBUG_F("connected to \"%s\" with ip %s as %s\n", ssid_now, event.ip.toString().c_str(), hostname);
    connect_state = WIFI_GOT_IP;
    status_led_wifi_connected();
    portal_connected(ssid_now);
}

static void on_disconnected(const WiFiEventStationModeDisconnected &event) {
    // e.g. 201 AP not found, 15 handshake timeout (weak signal or wrong password), 200 beacon timeout
    if (connect_state == WIFI_GOT_IP) {
        DEBUG("disconnected (reason %d), the sdk connects again\n", event.reason);
    }
    if (connect_state != WIFI_NOT_PROVISIONED) {
        connect_state = WIFI_DISCONNECTED;
        if (!portal_running()) {
            set_status_led(LED_FAST);
        }
    }
    // while the setup portal runs it decides: a wrong password ends in a message on the page
    if (portal_running()) {
        portal_connect_failed(event.reason);
    }
}

/* ----------------------------------------------------------------------- */

// a network is kept in the sdk's flash: set up over the portal or serial
static bool stored_network(void) {
    struct station_config conf;
    bool stored = wifi_station_get_config_default(&conf) && conf.ssid[0] != '\0';
    memset(&conf, 0, sizeof(conf));
    return stored;
}

void wifi_start(void) {
    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(hostname, sizeof(hostname), "kibbl-%02x%02x", mac[4], mac[5]);

    WiFi.persistent(true); // WiFi.begin() keeps the network in the sdk's flash
    WiFi.setAutoReconnect(true);
    WiFi.hostname(hostname);
    // modem sleep adds latency to every command and to the TV sync
    WiFi.setSleepMode(WIFI_NONE_SLEEP);

    connected_handler    = WiFi.onStationModeConnected(on_connected);
    got_ip_handler       = WiFi.onStationModeGotIP(on_got_ip);
    disconnected_handler = WiFi.onStationModeDisconnected(on_disconnected);

    if (!stored_network()) {
        connect_state = WIFI_NOT_PROVISIONED;
        set_status_led(LED_SLOW);
        portal_start(hostname);
    } else {
        connect_state = WIFI_DISCONNECTED;
        set_status_led(LED_FAST);
        WiFi.mode(WIFI_STA);
        WiFi.begin(); // the stored network
    }
}

/* ----------------------------------------------------------------------- */

void wifi_loop(void) {
    if (!change_running) {
        return;
    }
    if (connect_state == WIFI_GOT_IP && WiFi.SSID() == change_ssid) {
        change_failed[0] = '\0';
        change_running   = false;
        memset(old_password, 0, sizeof(old_password));
    } else if (millis() - change_since > WIFI_CHANGE_TIMEOUT_MS) {
        DEBUG_F_ERROR("wifi: \"%s\" not joined, back to \"%s\"\n", change_ssid, old_ssid);
        strlcpy(change_failed, change_ssid, sizeof(change_failed));
        WiFi.begin(old_ssid, old_password);
        memset(old_password, 0, sizeof(old_password));
        change_running = false;
    }
}

connect_state_t wifi_connect_state(void) {
    return connect_state;
}

bool wifi_has_ip(void) {
    return connect_state == WIFI_GOT_IP;
}

bool wifi_set_credentials(const char *ssid, const char *password) {
    if (ssid == NULL || password == NULL || strlen(ssid) == 0 || strlen(ssid) > 32 || strlen(password) > 63) {
        return false;
    }
    if (connect_state == WIFI_NOT_PROVISIONED) {
        connect_state = WIFI_DISCONNECTED;
    }
    // also while the portal runs: the station connects next to its access point
    if (!portal_running()) {
        WiFi.mode(WIFI_STA);
    }
    return WiFi.begin(ssid, password) != WL_CONNECT_FAILED;
}

void wifi_reset_credentials(void) {
    DEBUG_F("wifi credentials erased, restarting into the setup portal\n");
    WiFi.disconnect(true); // and forgotten in the sdk's flash
    delay(500);
    ESP.restart();
}

bool wifi_change_network(const char *ssid, const char *password) {
    if (change_running || ssid == NULL || password == NULL) {
        return false;
    }
    size_t ssid_len = strlen(ssid);
    size_t pw_len   = strlen(password);
    // wpa needs 8 to 63 characters; an open network none
    if (ssid_len == 0 || ssid_len > 32 || (pw_len > 0 && (pw_len < 8 || pw_len > 63))) {
        return false;
    }
    strlcpy(old_ssid, WiFi.SSID().c_str(), sizeof(old_ssid));
    strlcpy(old_password, WiFi.psk().c_str(), sizeof(old_password));
    strlcpy(change_ssid, ssid, sizeof(change_ssid));
    DEBUG_F("wifi: switching to \"%s\", back to \"%s\" without an ip in %d s\n", change_ssid, old_ssid, WIFI_CHANGE_TIMEOUT_MS / 1000);

    change_running = true;
    change_since   = millis();
    WiFi.begin(ssid, password);
    return true;
}

const char *wifi_change_failed(void) {
    return change_failed;
}

int wifi_scan(JsonArray out, int max) {
    int found = WiFi.scanNetworks(false, false);
    if (found < 0) {
        DEBUG_ERROR("wifi scan failed (%d)\n", found);
        return -1;
    }
    // strongest first, the first one of every ssid
    int count = 0;
    bool *taken = (bool *)calloc(found ? found : 1, sizeof(bool));
    if (taken == NULL) {
        WiFi.scanDelete();
        return -1;
    }
    while (count < max) {
        int best = -1;
        for (int i = 0; i < found; i++) {
            if (!taken[i] && WiFi.SSID(i).length() > 0 && (best < 0 || WiFi.RSSI(i) > WiFi.RSSI(best))) {
                best = i;
            }
        }
        if (best < 0) {
            break;
        }
        for (int i = 0; i < found; i++) {
            if (WiFi.SSID(i) == WiFi.SSID(best)) {
                taken[i] = true;
            }
        }
        JsonObject net = out.add<JsonObject>();
        net["ssid"]    = WiFi.SSID(best);
        net["rssi"]    = WiFi.RSSI(best);
        net["secure"]  = WiFi.encryptionType(best) != ENC_TYPE_NONE;
        count++;
    }
    free(taken);
    WiFi.scanDelete();
    return count;
}

const char *wifi_hostname(void) {
    return hostname;
}

const char *get_configured_ssid(void) {
    static char ssid[33];
    struct station_config conf;
    wifi_station_get_config_default(&conf);
    memcpy(ssid, conf.ssid, 32);
    ssid[32] = '\0';
    memset(&conf, 0, sizeof(conf));
    return ssid;
}

bool wifi_ip_string(char *out, size_t max) {
    if (!wifi_has_ip()) {
        strlcpy(out, "", max);
        return false;
    }
    strlcpy(out, WiFi.localIP().toString().c_str(), max);
    return true;
}

bool wifi_rssi(int *rssi) {
    if (!wifi_has_ip()) {
        return false;
    }
    *rssi = WiFi.RSSI();
    return true;
}
