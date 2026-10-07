#ifndef KL_PORTAL_H
#define KL_PORTAL_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

/*
 * The setup of a device without a cable or an app: it opens the Wi-Fi "kibbl-xxxx"
 * (open, xxxx the end of its id), and every address leads to its setup page (a captive
 * portal: phones and laptops show it by themselves when they join). There the person picks
 * the home network, types its password and may change the server address; the device
 * joins it next to its own access point and the page shows the result and the pairing
 * code, which takes the device into their account in the app (Devices, Add with a code).
 * PORTAL_LINGER_MS after the network is joined the access point closes.
 */

#define PORTAL_LINGER_MS (3 * 60 * 1000)

// access point, page and name server; from wifi_start() when no network is stored
void portal_start(void);

bool portal_running(void);

// from the wifi events while the portal runs
void portal_connected(const char *ssid);
void portal_connect_failed(uint8_t reason);

#ifdef __cplusplus
}
#endif

#endif /* KL_PORTAL_H */
