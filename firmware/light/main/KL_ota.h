#ifndef KL_OTA_H
#define KL_OTA_H

#include <Arduino.h>

/*
 * Updates as kibbl_core's KL_ota: the image at an http:// or https:// url. The core of the
 * ESP8266 writes it next to the running one and checks it; at the restart its loader copies it
 * over the old one (a power cut during the copy starts the copy again). The server link is
 * closed first: TLS twice does not fit in the RAM.
 */

// false when an update already runs or the url is none
bool ota_start(const char *url);

bool ota_running(void);

// the download, once ota_start() was called; from the loop
void ota_loop(void);

#endif /* KL_OTA_H */
