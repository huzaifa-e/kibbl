#include "KL_wifi_prov.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <esp_event.h>
#include <esp_mac.h>
#include <esp_netif.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <esp_wifi.h>
#include "KL_portal.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_time.h"

EventGroupHandle_t wifi_event_group;

static connect_state_t connect_state = WIFI_NOT_PROVISIONED;
static char hostname[24];
static char ssid_now[33];

/* Reconnects back off from 1 s to 30 s, so a router that is off for the night is not
 * scanned for every second; an IP address resets it. */
#define RECONNECT_MIN_MS 1000
#define RECONNECT_MAX_MS 30000
static uint32_t reconnect_delay_ms = RECONNECT_MIN_MS;
static esp_timer_handle_t reconnect_timer;

static void reconnect_cb(void *arg) {
    esp_wifi_connect();
}

/* ----------------------------------------------------------------------- */

/* Event handler for catching system events */
static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        // the setup portal starts the station without a network: it connects once one is chosen
        if (connect_state != WIFI_NOT_PROVISIONED) {
            esp_wifi_connect();
        }
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        wifi_event_sta_connected_t *event = (wifi_event_sta_connected_t *)event_data;
        size_t len = event->ssid_len < sizeof(ssid_now) - 1 ? event->ssid_len : sizeof(ssid_now) - 1;
        memcpy(ssid_now, event->ssid, len);
        ssid_now[len] = '\0';
        connect_state = WIFI_CONNECTED;
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        DEBUG_F("connected to \"%s\" with ip " IPSTR " as %s\n", ssid_now, IP2STR(&event->ip_info.ip), hostname);

        reconnect_delay_ms = RECONNECT_MIN_MS;
        connect_state      = WIFI_GOT_IP;
        status_led_wifi_connected();
        portal_connected(ssid_now);
        /* Signal main application to continue execution */
        xEventGroupSetBits(wifi_event_group, WIFI_GOT_IP_BIT);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        // e.g. 201 AP not found, 15 handshake timeout (weak signal or wrong password), 200 beacon timeout
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)event_data;
        DEBUG("disconnected (reason %d, rssi %d), connecting again in %lu ms\n", event->reason, event->rssi,
              (unsigned long)reconnect_delay_ms);

        xEventGroupClearBits(wifi_event_group, WIFI_GOT_IP_BIT);
        if (connect_state != WIFI_NOT_PROVISIONED) {
            connect_state = WIFI_DISCONNECTED;
            if ((xEventGroupGetBits(wifi_event_group) & WIFI_PROV_ACTIVE_BIT) == 0) {
                set_status_led(LED_FAST);
            }
        }

        /* While the setup portal runs it decides about retries: a wrong password must
         * end in a message on the page, not in an endless retry. */
        if (xEventGroupGetBits(wifi_event_group) & WIFI_PROV_ACTIVE_BIT) {
            portal_connect_failed(event->reason);
        } else {
            esp_timer_stop(reconnect_timer);
            esp_timer_start_once(reconnect_timer, (uint64_t)reconnect_delay_ms * 1000);
            reconnect_delay_ms = reconnect_delay_ms * 2 > RECONNECT_MAX_MS ? RECONNECT_MAX_MS : reconnect_delay_ms * 2;
        }
    }
}

/* ************************************************************************** */

// a network is stored in the wifi flash: set up over the portal, serial or the old provisioning
static bool stored_network(void) {
    wifi_config_t cfg = {0};
    bool stored = esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK && cfg.sta.ssid[0] != '\0';
    memset(&cfg, 0, sizeof(cfg));
    return stored;
}

void wifi_start(void) {
    wifi_event_group = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());

    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL));

    esp_netif_t *sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap(); // the setup portal

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));

    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    snprintf(hostname, sizeof(hostname), "kibbl-%02x%02x", mac[4], mac[5]);
    esp_netif_set_hostname(sta_netif, hostname);

    const esp_timer_create_args_t timer_args = {
        .callback = reconnect_cb,
        .name     = "wifi_reconnect",
    };
    ESP_ERROR_CHECK(esp_timer_create(&timer_args, &reconnect_timer));

    if (!stored_network()) {
        connect_state = WIFI_NOT_PROVISIONED;
        xEventGroupSetBits(wifi_event_group, WIFI_PROV_ACTIVE_BIT);
        set_status_led(LED_SLOW);
        portal_start();
    } else {
        connect_state = WIFI_DISCONNECTED;
        set_status_led(LED_FAST);

        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_start());
    }

    // modem sleep costs frame rate and adds latency to every command
    esp_wifi_set_ps(WIFI_PS_NONE);
}

/* ----------------------------------------------------------------------- */

connect_state_t wifi_connect_state(void) {
    return connect_state;
}

bool wifi_set_credentials(const char *ssid, const char *password) {
    if (ssid == NULL || password == NULL) {
        return false;
    }
    wifi_config_t cfg = {0};
    if (strlen(ssid) == 0 || strlen(ssid) > sizeof(cfg.sta.ssid) || strlen(password) >= sizeof(cfg.sta.password)) {
        return false;
    }
    memcpy(cfg.sta.ssid, ssid, strlen(ssid));
    strlcpy((char *)cfg.sta.password, password, sizeof(cfg.sta.password));
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;

    // also while the portal runs: the station connects next to its access point
    esp_timer_stop(reconnect_timer);
    if (connect_state == WIFI_NOT_PROVISIONED) {
        connect_state = WIFI_DISCONNECTED;
    }
    esp_wifi_disconnect();
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    err |= esp_wifi_connect();
    reconnect_delay_ms = RECONNECT_MIN_MS;
    memset(&cfg, 0, sizeof(cfg));
    return err == ESP_OK;
}

/* ----------------------------------------------------------------------- */

#define WIFI_CHANGE_STACK_SIZE 4096

static volatile bool change_running = false;
static char change_ssid[33];
static char change_password[65];
static char change_failed[33];

static void wifi_change_task(void *pvParams) {
    delay_ms(1000); // the response to the server leaves before the connection drops

    wifi_config_t old = {0};
    esp_wifi_get_config(WIFI_IF_STA, &old);

    wifi_config_t cfg = {0};
    memcpy(cfg.sta.ssid, change_ssid, strnlen(change_ssid, sizeof(cfg.sta.ssid)));
    strlcpy((char *)cfg.sta.password, change_password, sizeof(cfg.sta.password));
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    memset(change_password, 0, sizeof(change_password));

    DEBUG_F("wifi: switching to \"%s\", back to \"%.*s\" without an ip in %d s\n", change_ssid,
            (int)sizeof(old.sta.ssid), (const char *)old.sta.ssid, WIFI_CHANGE_TIMEOUT_MS / 1000);

    esp_timer_stop(reconnect_timer);
    xEventGroupClearBits(wifi_event_group, WIFI_GOT_IP_BIT);
    esp_wifi_disconnect();
    esp_wifi_set_storage(WIFI_STORAGE_FLASH);
    esp_wifi_set_config(WIFI_IF_STA, &cfg);
    reconnect_delay_ms = RECONNECT_MIN_MS;
    esp_wifi_connect();
    memset(&cfg, 0, sizeof(cfg));

    EventBits_t bits = xEventGroupWaitBits(wifi_event_group, WIFI_GOT_IP_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(WIFI_CHANGE_TIMEOUT_MS));
    if (bits & WIFI_GOT_IP_BIT) {
        change_failed[0] = '\0';
    } else {
        DEBUG_F_ERROR("wifi: \"%s\" not joined, back to the previous network\n", change_ssid);
        strlcpy(change_failed, change_ssid, sizeof(change_failed));
        esp_timer_stop(reconnect_timer);
        esp_wifi_disconnect();
        esp_wifi_set_config(WIFI_IF_STA, &old);
        reconnect_delay_ms = RECONNECT_MIN_MS;
        esp_wifi_connect();
    }
    memset(&old, 0, sizeof(old));
    change_running = false;
    vTaskDelete(NULL);
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
    strlcpy(change_ssid, ssid, sizeof(change_ssid));
    strlcpy(change_password, password, sizeof(change_password));
    change_running = true;
    if (xTaskCreate(wifi_change_task, "wifi_change", WIFI_CHANGE_STACK_SIZE, NULL, 3, NULL) != pdPASS) {
        memset(change_password, 0, sizeof(change_password));
        change_running = false;
        return false;
    }
    return true;
}

const char *wifi_change_failed(void) {
    return change_failed;
}

int wifi_scan(wifi_ap_record_t *records, uint16_t max) {
    wifi_scan_config_t scan_cfg = {
        .show_hidden = false,
    };
    esp_err_t err = esp_wifi_scan_start(&scan_cfg, true);
    if (err == ESP_ERR_WIFI_STATE && !(xEventGroupGetBits(wifi_event_group) & WIFI_GOT_IP_BIT)) {
        // still trying to join a network: a scan needs the station idle
        esp_timer_stop(reconnect_timer);
        esp_wifi_disconnect();
        delay_ms(100);
        err = esp_wifi_scan_start(&scan_cfg, true);
        esp_timer_start_once(reconnect_timer, (uint64_t)RECONNECT_MIN_MS * 1000);
    }
    if (err != ESP_OK) {
        DEBUG_ERROR("wifi scan failed (%s)\n", esp_err_to_name(err));
        return -1;
    }

    uint16_t found = 0;
    esp_wifi_scan_get_ap_num(&found);
    wifi_ap_record_t *all = calloc(found ? found : 1, sizeof(wifi_ap_record_t));
    if (all == NULL) {
        esp_wifi_clear_ap_list();
        return -1;
    }
    esp_wifi_scan_get_ap_records(&found, all);

    // the driver sorts by signal: keep the first record of every ssid
    int count = 0;
    for (int i = 0; i < found && count < max; i++) {
        if (all[i].ssid[0] == '\0') {
            continue;
        }
        bool seen = false;
        for (int j = 0; j < count && !seen; j++) {
            seen = strncmp((const char *)records[j].ssid, (const char *)all[i].ssid, sizeof(all[i].ssid)) == 0;
        }
        if (!seen) {
            records[count++] = all[i];
        }
    }
    free(all);
    return count;
}

void wifi_reset_credentials(void) {
    DEBUG_F("wifi credentials erased, restarting into the setup portal\n");
    esp_wifi_restore();
    esp_restart();
}

const char *wifi_hostname(void) {
    return hostname;
}

const char *get_configured_ssid(void) {
    static char ssid[33];
    wifi_config_t cfg = {0};
    esp_wifi_get_config(WIFI_IF_STA, &cfg);
    memcpy(ssid, cfg.sta.ssid, sizeof(cfg.sta.ssid));
    ssid[32] = '\0';
    memset(&cfg, 0, sizeof(cfg));
    return ssid;
}

bool wifi_ip_string(char *out, size_t max) {
    esp_netif_t *netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t info;
    if (netif == NULL || esp_netif_get_ip_info(netif, &info) != ESP_OK || info.ip.addr == 0) {
        strlcpy(out, "", max);
        return false;
    }
    snprintf(out, max, IPSTR, IP2STR(&info.ip));
    return true;
}

bool wifi_rssi(int *rssi) {
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) != ESP_OK) {
        return false;
    }
    *rssi = ap.rssi;
    return true;
}
