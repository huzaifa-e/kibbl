#ifndef KL_PORTAL_H
#define KL_PORTAL_H

#include <Arduino.h>

/*
 * The setup of a device without a cable or an app, as kibbl_core's KL_portal: it opens the
 * Wi-Fi "kibbl-xxxx" (open, xxxx the end of its id), and every address leads to its setup
 * page (portal.html of kibbl_core, a captive portal). There the person picks the home
 * network, types its password and may change the server address; the device joins it next
 * to its own access point and the page shows the result and the pairing code.
 * PORTAL_LINGER_MS after the network is joined the access point closes.
 */

#define PORTAL_LINGER_MS (3 * 60 * 1000)

void portal_start(const char *hostname);

// the page, the name server and the closing; from the loop
void portal_loop(void);

bool portal_running(void);

// from the wifi events while the portal runs
void portal_connected(const char *ssid);
void portal_connect_failed(uint8_t reason);

#endif /* KL_PORTAL_H */
