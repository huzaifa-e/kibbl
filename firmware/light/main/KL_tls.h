#ifndef KL_TLS_H
#define KL_TLS_H

#include <WiFiClientSecureBearSSL.h>

/*
 * TLS as the server link and the update download use it: the roots of KL_certs.h, and the
 * time for the validity of the certificates from NTP (the ESP8266 has no clock that runs on).
 */

// starts NTP; once, after the first ip address
void tls_time_start(void);

/* true once the time is known, or after TLS_TIME_WAIT_MS without NTP: then the time of the
 * build stands in, which certificates were valid at */
#define TLS_TIME_WAIT_MS 15000
bool tls_time_ready(void);

// a client checked against the roots, with the buffers a full TLS record of Cloudflare needs
void tls_prepare(BearSSL::WiFiClientSecure &client);

#endif /* KL_TLS_H */
