#include "KL_tls.h"

#include <time.h>

#include "KL_certs.h"
#include "KL_serial.h"

#define TIME_VALID 1700000000 // 2023: a clock that was set
#define DER_MAX    2048       // the largest root certificate

static BearSSL::X509List *anchors = NULL;
static uint32_t time_started      = 0;
static bool time_logged           = false;

void tls_time_start(void) {
    if (time_started != 0) {
        return;
    }
    time_started = millis();
    configTime(0, 0, "pool.ntp.org", "time.cloudflare.com");
}

// the time of the build, from __DATE__ ("Oct 17 2026")
static time_t build_time(void) {
    static const char months[] = "JanFebMarAprMayJunJulAugSepOctNovDec";
    char mon[4] = {0};
    int day, year;
    sscanf(__DATE__, "%3s %d %d", mon, &day, &year);
    struct tm tm = {};
    tm.tm_year   = year - 1900;
    tm.tm_mon    = (strstr(months, mon) - months) / 3;
    tm.tm_mday   = day;
    return mktime(&tm);
}

bool tls_time_ready(void) {
    if (time(NULL) > TIME_VALID) {
        if (!time_logged) {
            time_logged = true;
            DEBUG("time from NTP\n");
        }
        return true;
    }
    return time_started != 0 && millis() - time_started > TLS_TIME_WAIT_MS;
}

void tls_prepare(BearSSL::WiFiClientSecure &client) {
    if (anchors == NULL) {
        anchors = new BearSSL::X509List();
        // through RAM: the decoder reads byte by byte, flash takes only aligned words
        uint8_t *der = (uint8_t *)malloc(DER_MAX);
        for (size_t i = 0; der != NULL && i < sizeof(trust_anchors) / sizeof(trust_anchors[0]); i++) {
            if (trust_anchors[i].len <= DER_MAX) {
                memcpy_P(der, trust_anchors[i].der, trust_anchors[i].len);
                anchors->append(der, trust_anchors[i].len);
            }
        }
        free(der);
    }
    client.setTrustAnchors(anchors);
    if (time(NULL) > TIME_VALID) {
        client.setX509Time(time(NULL));
    } else {
        DEBUG_ERROR("no time from NTP, certificates checked at the time of the build\n");
        client.setX509Time(build_time());
    }
    // Cloudflare negotiates no smaller records: a whole one of 16 KB has to fit in
    client.setBufferSizes(16384, 1024);
}
