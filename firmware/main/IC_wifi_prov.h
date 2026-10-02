#ifndef IC_WIFI_PROV_H
#define IC_WIFI_PROV_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include <freertos/FreeRTOS.h>
#include <freertos/event_groups.h>

#define WIFI_GOT_IP_BIT      BIT0
#define WIFI_PROV_ACTIVE_BIT BIT1

typedef enum {
    WIFI_NOT_PROVISIONED = 0x0,
    WIFI_DISCONNECTED,
    WIFI_CONNECTED,
    WIFI_GOT_IP,
} connect_state_t;

extern EventGroupHandle_t wifi_event_group;

/* Starts station mode with the stored network, or SoftAP provisioning ("HM-xxxxxx",
 * ESP SoftAP Prov app, proof of possession CONFIG_HM_PROV_POP) when none is stored.
 * Needs the default event loop. */
void wifi_start(void);

connect_state_t wifi_connect_state(void);

// stores the network and joins it, also while provisioning runs (serial command)
bool wifi_set_credentials(const char *ssid, const char *password);

// forgets the network and restarts into provisioning
void wifi_reset_credentials(void);

const char *wifi_hostname(void);
const char *get_configured_ssid(void);
bool wifi_ip_string(char *out, size_t max);
bool wifi_rssi(int *rssi);

#ifdef __cplusplus
}
#endif

#endif /* IC_WIFI_PROV_H */
