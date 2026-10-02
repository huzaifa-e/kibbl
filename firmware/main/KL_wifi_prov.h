#ifndef KL_WIFI_PROV_H
#define KL_WIFI_PROV_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#include <esp_wifi_types.h>

#define WIFI_GOT_IP_BIT      BIT0
#define WIFI_PROV_ACTIVE_BIT BIT1

typedef enum {
    WIFI_NOT_PROVISIONED = 0x0,
    WIFI_DISCONNECTED,
    WIFI_CONNECTED,
    WIFI_GOT_IP,
} connect_state_t;

extern EventGroupHandle_t wifi_event_group;

/* Starts station mode with the stored network, or SoftAP provisioning ("KIBBL-xxxxxx",
 * ESP SoftAP Prov app, proof of possession CONFIG_KIBBL_PROV_POP) when none is stored.
 * Needs the default event loop. */
void wifi_start(void);

connect_state_t wifi_connect_state(void);

// stores the network and joins it, also while provisioning runs (serial command)
bool wifi_set_credentials(const char *ssid, const char *password);

// forgets the network and restarts into provisioning
void wifi_reset_credentials(void);

/* Switches to another network in a task of its own, for a change from the app. Without
 * an ip address within WIFI_CHANGE_TIMEOUT_MS it goes back to the network it had, so a
 * typo cannot strand a device on the wall. False when a change already runs. */
#define WIFI_CHANGE_TIMEOUT_MS (30 * 1000)
bool wifi_change_network(const char *ssid, const char *password);

// the ssid of the last change that failed and was undone, "" otherwise
const char *wifi_change_failed(void);

// the networks in reach, strongest first, one record per ssid; -1 when the scan failed
int wifi_scan(wifi_ap_record_t *records, uint16_t max);

const char *wifi_hostname(void);
const char *get_configured_ssid(void);
bool wifi_ip_string(char *out, size_t max);
bool wifi_rssi(int *rssi);

#ifdef __cplusplus
}
#endif

#endif /* KL_WIFI_PROV_H */
