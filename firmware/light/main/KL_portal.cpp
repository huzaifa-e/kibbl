#include "KL_portal.h"

#include <ArduinoJson.h>
#include <DNSServer.h>
#include <ESP8266WiFi.h>

#include "KL_config.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_stream.h"
#include "KL_wifi.h"
#include "portal_html.h" // kibbl_core/portal.html, gzipped by tools/portal.py

#define BODY_MAX        512
#define ATTEMPT_MS      (30 * 1000) // to join the chosen network
#define ATTEMPT_RETRIES 3
#define SCAN_MAX        20
#define REQUEST_TIMEOUT_MS 2000

typedef enum {
    PORTAL_IDLE = 0,
    PORTAL_CONNECTING,
    PORTAL_CONNECTED,
    PORTAL_FAILED,
} portal_state_t;

static bool running          = false;
static portal_state_t state  = PORTAL_IDLE;
static uint8_t fail_reason   = 0;
static uint8_t attempts      = 0;
static uint32_t attempt_since = 0;
static uint32_t linger_since = 0;
static char target_ssid[33];

static const IPAddress portal_ip(192, 168, 4, 1);
static WiFiServer *server = NULL;
static DNSServer *dns           = NULL;

/* ----------------------------------------------------------------------- */

static const char *state_name(portal_state_t s) {
    switch (s) {
    case PORTAL_CONNECTING:
        return "connecting";
    case PORTAL_CONNECTED:
        return "connected";
    case PORTAL_FAILED:
        return "failed";
    default:
        return "idle";
    }
}

// what a person can do about the reason the station was dropped for
static const char *reason_text(uint8_t reason) {
    switch (reason) {
    case WIFI_DISCONNECT_REASON_NO_AP_FOUND:
        return "The network was not found. Is the device close enough to the router, and is it a 2.4 GHz network?";
    case WIFI_DISCONNECT_REASON_AUTH_FAIL:
    case WIFI_DISCONNECT_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_DISCONNECT_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_DISCONNECT_REASON_AUTH_EXPIRE:
        return "The password was not accepted.";
    case 0:
        return "No answer from the network in time. Try again, closer to the router.";
    default:
        return "The network refused the connection.";
    }
}

/* The address of the app, from the server's: wss://host/device/socket -> https://host */
static String app_url(void) {
    const char *url    = config_server_url();
    const char *scheme = strncmp(url, "wss://", 6) == 0 ? "https://" : "http://";
    const char *host   = strstr(url, "://");
    host               = host ? host + 3 : url;
    return String(scheme) + String(host).substring(0, strcspn(host, "/"));
}

/* ----------------------------------------------------------------------- */

/* The page server: one request at a time, four addresses, as small as it gets. The
 * ESP8266WebServer of the core takes 15 KB more of an app image that has to fit twice. */

typedef struct {
    WiFiClient client;
    String method;
    String path;
    String body;
} request_t;

static void send_head(WiFiClient &client, int status, const char *type, size_t len, const char *extra) {
    const char *text = status == 200 ? "OK" : status == 302 ? "Found" : "Bad Request";
    client.printf("HTTP/1.1 %d %s\r\nContent-Type: %s\r\nContent-Length: %u\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n",
                  status, text, type, (unsigned)len, extra);
}

static void send_json(WiFiClient &client, JsonDocument &doc) {
    String body;
    serializeJson(doc, body);
    send_head(client, 200, "application/json", body.length(), "");
    client.print(body);
}

static void page_handler(request_t &req) {
    send_head(req.client, 200, "text/html; charset=utf-8", sizeof(portal_html_gz), "Content-Encoding: gzip\r\n");
    req.client.write_P((const char *)portal_html_gz, sizeof(portal_html_gz));
}

static void scan_handler(request_t &req) {
    JsonDocument doc;
    wifi_scan(doc.to<JsonArray>(), SCAN_MAX);
    send_json(req.client, doc);
}

static void status_handler(request_t &req) {
    JsonDocument doc;
    doc["state"]    = state_name(state);
    doc["deviceId"] = config_device_id();
    doc["server"]   = config_server_url();
    doc["app"]      = app_url();
    doc["ssid"]     = target_ssid;
    if (state == PORTAL_FAILED) {
        doc["error"] = reason_text(fail_reason);
    }
    // only once it is on the home network: then the person at the page set it up
    if (state == PORTAL_CONNECTED) {
        doc["claim"] = config_claim_code();
    }
    send_json(req.client, doc);
}

static void connect_handler(request_t &req) {
    JsonDocument body;
    DeserializationError err = deserializeJson(body, req.body);
    req.body.clear(); // it holds the password
    const char *ssid     = err ? NULL : body["ssid"].as<const char *>();
    const char *password = err ? NULL : body["password"].as<const char *>();
    const char *url      = err ? NULL : body["server"].as<const char *>();
    const char *error    = NULL;

    if (ssid == NULL || password == NULL || strlen(ssid) == 0 || strlen(ssid) > 32) {
        error = "Choose a network.";
    } else if (strlen(password) != 0 && (strlen(password) < 8 || strlen(password) > 63)) {
        error = "A Wi-Fi password has 8 to 63 characters.";
    } else if (url != NULL && url[0] != '\0' && strcmp(url, config_server_url()) != 0 && !config_set_server_url(url)) {
        error = "The server address starts with ws:// or wss://.";
    } else {
        strlcpy(target_ssid, ssid, sizeof(target_ssid));
        attempts      = 0;
        state         = PORTAL_CONNECTING;
        attempt_since = millis();
        DEBUG_F("setup: joining \"%s\"\n", target_ssid);
        if (!wifi_set_credentials(ssid, password)) {
            state = PORTAL_FAILED;
            error = "The network was not taken.";
        }
    }
    body.clear();

    JsonDocument resp;
    resp["ok"] = error == NULL;
    if (error != NULL) {
        resp["error"] = error;
    }
    send_json(req.client, resp);
}

/* Every other address: the setup page. Phones test the internet with such requests
 * (generate_204, hotspot-detect.html, connecttest.txt) and show the portal on a redirect. */
static void redirect_handler(request_t &req) {
    send_head(req.client, 302, "text/plain", 0, "Location: http://192.168.4.1/\r\n");
}

// the request line, the length of the body and the body; false for anything else
static bool read_request(request_t &req) {
    req.client.setTimeout(REQUEST_TIMEOUT_MS);
    String line = req.client.readStringUntil('\n');
    int sp1     = line.indexOf(' ');
    int sp2     = line.indexOf(' ', sp1 + 1);
    if (sp1 < 0 || sp2 < 0) {
        return false;
    }
    req.method = line.substring(0, sp1);
    req.path   = line.substring(sp1 + 1, sp2);
    int query  = req.path.indexOf('?');
    if (query >= 0) {
        req.path = req.path.substring(0, query);
    }

    size_t length = 0;
    while (true) {
        line = req.client.readStringUntil('\n');
        line.trim();
        if (line.length() == 0) {
            break; // the end of the headers, or the timeout
        }
        if (line.substring(0, 15).equalsIgnoreCase("Content-Length:")) {
            length = line.substring(15).toInt();
        }
    }
    if (length > BODY_MAX) {
        return false;
    }
    while (req.body.length() < length) {
        int c = req.client.read();
        if (c < 0) {
            if (!req.client.connected()) {
                return false;
            }
            uint32_t since = millis();
            while (req.client.available() == 0 && req.client.connected() && millis() - since < REQUEST_TIMEOUT_MS) {
                delay(1);
            }
            if (req.client.available() == 0) {
                return false;
            }
            continue;
        }
        req.body += (char)c;
    }
    return true;
}

static void serve(void) {
    request_t req;
    req.client = server->accept();
    if (!req.client) {
        return;
    }
    if (!read_request(req)) {
        send_head(req.client, 400, "text/plain", 0, "");
    } else if (req.method == "GET" && req.path == "/") {
        page_handler(req);
    } else if (req.method == "GET" && req.path == "/scan") {
        scan_handler(req);
    } else if (req.method == "GET" && req.path == "/status") {
        status_handler(req);
    } else if (req.method == "POST" && req.path == "/connect") {
        connect_handler(req);
    } else {
        redirect_handler(req);
    }
    req.client.flush();
    req.client.stop();
}

/* ----------------------------------------------------------------------- */

void portal_connected(const char *ssid) {
    if (!running || state == PORTAL_CONNECTED) {
        return;
    }
    state        = PORTAL_CONNECTED;
    linger_since = millis();
    DEBUG_F("setup: joined \"%s\", pairing code %s, the portal closes in %d min\n", ssid, config_claim_code(), PORTAL_LINGER_MS / 60000);
}

void portal_connect_failed(uint8_t reason) {
    if (state != PORTAL_CONNECTING) {
        return;
    }
    fail_reason = reason;
    if (++attempts < ATTEMPT_RETRIES && reason != WIFI_DISCONNECT_REASON_AUTH_FAIL) {
        return; // the sdk tries again by itself
    }
    state = PORTAL_FAILED;
    WiFi.disconnect(false); // no endless retries with a wrong password
    DEBUG_F("setup: \"%s\" not joined (reason %u)\n", target_ssid, reason);
}

void portal_start(const char *hostname) {
    char ap_ssid[16];
    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(ap_ssid, sizeof(ap_ssid), "kibbl-%02X%02X", mac[4], mac[5]);

    WiFi.mode(WIFI_AP_STA);
    WiFi.softAPConfig(portal_ip, portal_ip, IPAddress(255, 255, 255, 0));
    WiFi.softAP(ap_ssid, NULL, 1, false, 4);

    dns = new DNSServer();
    dns->start(53, "*", portal_ip); // every name to the setup page

    server = new WiFiServer(80);
    server->begin();

    running = true;
    DEBUG_F("no network set: join the Wi-Fi \"%s\", the setup page opens (else http://192.168.4.1/),\n", ap_ssid);
    DEBUG_F("or send {\"cmd\":\"wifi\",\"ssid\":\"...\",\"password\":\"...\"} over serial\n");
}

static void portal_stop(void) {
    server->stop();
    delete server;
    server = NULL;
    dns->stop();
    delete dns;
    dns = NULL;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    running = false;
    set_status_led(stream_connected() ? LED_BLIP : LED_FAST);
    DEBUG_F("setup portal closed\n");
}

void portal_loop(void) {
    if (!running) {
        return;
    }
    dns->processNextRequest();
    serve();

    if (state == PORTAL_CONNECTING && millis() - attempt_since > ATTEMPT_MS) {
        DEBUG_F("setup: \"%s\" not joined in %d s\n", target_ssid, ATTEMPT_MS / 1000);
        fail_reason = 0;
        state       = PORTAL_FAILED;
        WiFi.disconnect(false);
    }
    if (state == PORTAL_CONNECTED && millis() - linger_since > PORTAL_LINGER_MS) {
        portal_stop();
    }
}

bool portal_running(void) {
    return running;
}
