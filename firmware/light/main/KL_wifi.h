#ifndef KL_WIFI_H
#define KL_WIFI_H

#include <Arduino.h>
#include <ArduinoJson.h>

/*
 * The Wi-Fi as kibbl_core's KL_wifi_prov runs it: station mode with the network the sdk keeps
 * in its flash, or the setup portal (KL_portal: the Wi-Fi "kibbl-xxxx" with a page to choose
 * the network) when none is stored. The sdk reconnects by itself.
 */

typedef enum {
    WIFI_NOT_PROVISIONED = 0x0,
    WIFI_DISCONNECTED,
    WIFI_CONNECTED,
    WIFI_GOT_IP,
} connect_state_t;

void wifi_start(void);

// the network switch of the app and its fallback; from the loop
void wifi_loop(void);

connect_state_t wifi_connect_state(void);
bool wifi_has_ip(void);

// stores the network and joins it, also while the portal runs (serial command, setup page)
bool wifi_set_credentials(const char *ssid, const char *password);

// forgets the network and restarts into provisioning
void wifi_reset_credentials(void);

/* Switches to another network, for a change from the app. Without an ip address within
 * WIFI_CHANGE_TIMEOUT_MS it goes back to the network it had, so a typo cannot strand a device
 * behind the TV. False when a change already runs or the network is not valid. */
#define WIFI_CHANGE_TIMEOUT_MS (30 * 1000)
bool wifi_change_network(const char *ssid, const char *password);

// the ssid of the last change that failed and was undone, "" otherwise
const char *wifi_change_failed(void);

// the networks in reach into out, strongest first, one per ssid; -1 when the scan failed
int wifi_scan(JsonArray out, int max);

const char *wifi_hostname(void);
const char *get_configured_ssid(void);
bool wifi_ip_string(char *out, size_t max);
bool wifi_rssi(int *rssi);

#endif /* KL_WIFI_H */
