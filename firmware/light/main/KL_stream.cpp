#include "KL_stream.h"

#include <ESP8266WiFi.h>
#include <WiFiClientSecureBearSSL.h>
#include <base64.h>
#include <bearssl/bearssl_hash.h>

#include "KL_commands.h"
#include "KL_config.h"
#include "KL_ota.h"
#include "KL_product.h"
#include "KL_recovery.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_tls.h"
#include "KL_wifi.h"

#define WS_OP_TEXT  0x1
#define WS_OP_CLOSE 0x8
#define WS_OP_PING  0x9
#define WS_OP_PONG  0xa

#define CMD_MAX_LEN           2048  // longest command json taken from the server
#define TELEMETRY_INTERVAL_MS 10000
#define PING_INTERVAL_MS      10000
#define SILENT_TIMEOUT_MS     30000 // nothing from the server for this long: connected again
#define NETWORK_TIMEOUT_MS    10000
#define RECONNECT_MS          5000
#define RESPONSE_MAX          1024 // the upgrade response, its headers included

static const char *WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC11B85";

static BearSSL::WiFiClientSecure tls_client;
static WiFiClient plain_client;
static WiFiClient *client = NULL;

static bool connected          = false;
static bool hello_pending      = false;
static bool telemetry_pending  = false;
static uint32_t next_try       = 0;
static uint32_t last_rx        = 0;
static uint32_t last_ping      = 0;
static uint32_t last_telemetry = 0;

/* ----------------------------------------------------------------------- */

// exactly len bytes within timeout_ms
static bool read_full(uint8_t *buf, size_t len, uint32_t timeout_ms) {
    uint32_t since = millis();
    while (len > 0) {
        if (!client->connected() && client->available() == 0) {
            return false;
        }
        int n = client->read(buf, len);
        if (n > 0) {
            buf += n;
            len -= n;
        } else if (millis() - since > timeout_ms) {
            return false;
        } else {
            delay(1);
        }
    }
    return true;
}

// one frame, masked as a client has to, in one write: one TLS record
static bool send_frame(uint8_t opcode, const uint8_t *data, size_t len) {
    if (client == NULL || !client->connected()) {
        return false;
    }
    uint8_t *frame = (uint8_t *)malloc(len + 8);
    if (frame == NULL) {
        return false;
    }
    size_t n   = 0;
    frame[n++] = 0x80 | opcode;
    if (len < 126) {
        frame[n++] = 0x80 | (uint8_t)len;
    } else {
        frame[n++] = 0x80 | 126; // the messages of this device stay below 64 KB
        frame[n++] = (uint8_t)(len >> 8);
        frame[n++] = (uint8_t)len;
    }
    uint32_t key  = ESP.random();
    uint8_t *mask = &frame[n];
    memcpy(mask, &key, 4);
    n += 4;
    for (size_t i = 0; i < len; i++) {
        frame[n + i] = data[i] ^ mask[i & 3];
    }
    bool sent = client->write(frame, n + len) == n + len;
    free(frame);
    return sent;
}

bool stream_send_json(JsonDocument &doc) {
    if (!connected) {
        return false;
    }
    String text;
    serializeJson(doc, text);
    if (!send_frame(WS_OP_TEXT, (const uint8_t *)text.c_str(), text.length())) {
        DEBUG_ERROR("sending json failed\n");
        return false;
    }
    return true;
}

/* ----------------------------------------------------------------------- */

static void send_hello(void) {
    JsonDocument doc;
    doc["type"] = "hello";
    commands_add_info(doc.to<JsonObject>(), CMD_SOURCE_SERVER);
    doc["type"] = "hello";
    stream_send_json(doc);
}

static void send_telemetry(void) {
    JsonDocument doc;
    int rssi      = 0;
    doc["type"]   = "telemetry";
    doc["uptime"] = millis() / 1000;
    if (wifi_rssi(&rssi)) {
        doc["rssi"] = rssi;
    }
    doc["heap"] = ESP.getFreeHeap();
    product_add_telemetry(doc.as<JsonObject>());
    stream_send_json(doc);
}

static void run_command(const char *text) {
    JsonDocument req;
    if (deserializeJson(req, text)) {
        DEBUG_ERROR("command from the server is no json\n");
        return;
    }
    JsonDocument resp;
    resp.to<JsonObject>();
    commands_handle(req.as<JsonObjectConst>(), resp, CMD_SOURCE_SERVER);
    resp["type"] = "response";
    stream_send_json(resp);
}

/* ----------------------------------------------------------------------- */

// the Sec-WebSocket-Accept the server has to answer to key (RFC 6455, 4.2.2)
static String expected_accept(const String &key) {
    String text = key + WS_GUID;
    uint8_t digest[20];
    br_sha1_context ctx;
    br_sha1_init(&ctx);
    br_sha1_update(&ctx, text.c_str(), text.length());
    br_sha1_out(&ctx, digest);
    return base64::encode(digest, sizeof(digest), false);
}

// the upgrade to a websocket: the http status of the answer, 101 when it is one, -1 without
static int handshake(const char *host, const char *path) {
    uint8_t nonce[16];
    for (int i = 0; i < 16; i += 4) {
        uint32_t r = ESP.random();
        memcpy(&nonce[i], &r, 4);
    }
    String key = base64::encode(nonce, sizeof(nonce), false);

    // the id and the secret go in headers, not in the url: urls end up in proxy logs
    String request = String("GET ") + path + " HTTP/1.1\r\nHost: " + host +
                     "\r\nUser-Agent: KibblHW\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key +
                     "\r\nSec-WebSocket-Version: 13\r\nX-Device-Id: " + config_device_id() + "\r\nAuthorization: Bearer " +
                     config_device_secret() + "\r\n\r\n";
    bool sent = client->write((const uint8_t *)request.c_str(), request.length()) == request.length();
    request.clear();
    if (!sent) {
        return -1;
    }

    // byte by byte up to the empty line: what follows it is already the first frame
    char response[RESPONSE_MAX + 1];
    size_t got = 0;
    while (got < RESPONSE_MAX && (got < 4 || memcmp(&response[got - 4], "\r\n\r\n", 4) != 0)) {
        if (!read_full((uint8_t *)&response[got], 1, NETWORK_TIMEOUT_MS)) {
            return -1;
        }
        got++;
    }
    response[got] = '\0';

    int status = -1;
    if (sscanf(response, "HTTP/1.%*d %d", &status) != 1) {
        return -1;
    }
    if (status == 101) {
        String expected = String("sec-websocket-accept: ") + expected_accept(key);
        String lower    = String(response);
        lower.toLowerCase();
        expected.toLowerCase();
        if (lower.indexOf(expected) < 0) {
            DEBUG_ERROR("the server's answer to the upgrade does not match the key\n");
            return -1;
        }
    }
    return status;
}

static void parse_url(const char *url, bool *tls, String *host, int *port, String *path) {
    *tls             = strncmp(url, "wss://", 6) == 0;
    const char *rest = url + (*tls ? 6 : 5);
    size_t host_len  = strcspn(rest, ":/");
    *host            = String(rest).substring(0, host_len);
    rest += host_len;
    *port = *tls ? 443 : 80;
    if (*rest == ':') {
        *port = atoi(rest + 1);
        rest += strcspn(rest, "/");
    }
    *path = *rest == '/' ? String(rest) : String("/");
}

static void connect_server(void) {
    bool tls;
    String host, path;
    int port;
    parse_url(config_server_url(), &tls, &host, &port, &path);

    if (tls) {
        tls_prepare(tls_client);
        client = &tls_client;
    } else {
        client = &plain_client;
    }
    client->setTimeout(NETWORK_TIMEOUT_MS);
    if (!client->connect(host.c_str(), port)) {
        if (tls) {
            char error[80];
            int code = tls_client.getLastSSLError(error, sizeof(error));
            DEBUG_ERROR("server connection error (tls %d: %s)\n", code, error);
        } else {
            DEBUG_ERROR("server connection error\n");
        }
        client->stop();
        return;
    }
    int status = handshake(host.c_str(), path.c_str());
    if (status != 101) {
        if (status == 401) {
            // the server knows this id with another secret: a factory reset, or another device
            DEBUG_F_ERROR("server refused the device secret (401), remove the device in the app to pair it again\n");
        } else {
            DEBUG_ERROR("server connection error (handshake %d)\n", status);
        }
        client->stop();
        return;
    }

    DEBUG_F("server connected (%s)\n", config_server_url());
    connected      = true;
    hello_pending  = true;
    last_rx        = millis();
    last_ping      = millis();
    last_telemetry = 0;
    set_status_led(LED_BLIP);
    // reached the server: an image that runs this far is good
    recovery_confirm();
}

static void disconnect(void) {
    if (connected) {
        DEBUG_F("server disconnected\n");
    }
    connected = false;
    if (client != NULL) {
        client->stop();
    }
    if (wifi_has_ip()) {
        set_status_led(LED_FAST);
    }
    next_try = millis() + RECONNECT_MS;
}

/* One frame, when one waits: text goes to the commands, control frames are answered here.
 * False when the connection is over. */
static bool read_frame(void) {
    uint8_t head[2];
    if (!read_full(head, 2, NETWORK_TIMEOUT_MS)) {
        return false;
    }
    uint8_t opcode = head[0] & 0x0f;
    bool masked    = head[1] & 0x80;
    uint32_t len   = head[1] & 0x7f;
    if (len == 126 || len == 127) {
        uint8_t ext[8];
        size_t n = len == 126 ? 2 : 8;
        if (!read_full(ext, n, NETWORK_TIMEOUT_MS)) {
            return false;
        }
        uint64_t l = 0;
        for (size_t i = 0; i < n; i++) {
            l = (l << 8) | ext[i];
        }
        if (l > 0xffff) {
            return false; // nothing the server sends is this long
        }
        len = (uint32_t)l;
    }
    uint8_t mask[4] = {0};
    if (masked && !read_full(mask, 4, NETWORK_TIMEOUT_MS)) {
        return false;
    }
    last_rx = millis();

    bool keep = opcode == WS_OP_TEXT || opcode == WS_OP_PING || opcode == WS_OP_CLOSE;
    if (!keep || len > CMD_MAX_LEN) {
        // binary, pong, continuation, or too long: read past it
        uint8_t skip[64];
        while (len > 0) {
            size_t n = len > sizeof(skip) ? sizeof(skip) : len;
            if (!read_full(skip, n, NETWORK_TIMEOUT_MS)) {
                return false;
            }
            len -= n;
        }
        if (opcode == WS_OP_TEXT) {
            DEBUG_ERROR("command too long, dropped\n");
        }
        return true;
    }

    char *payload = (char *)malloc(len + 1);
    if (payload == NULL) {
        return false;
    }
    if (!read_full((uint8_t *)payload, len, NETWORK_TIMEOUT_MS)) {
        free(payload);
        return false;
    }
    for (uint32_t i = 0; i < len; i++) {
        payload[i] ^= mask[i & 3];
    }
    payload[len] = '\0';

    bool alive = true;
    if (opcode == WS_OP_TEXT) {
        run_command(payload);
    } else if (opcode == WS_OP_PING) {
        alive = send_frame(WS_OP_PONG, (const uint8_t *)payload, len);
    } else {
        send_frame(WS_OP_CLOSE, (const uint8_t *)payload, len >= 2 ? 2 : 0);
        alive = false;
    }
    free(payload);
    return alive;
}

/* ----------------------------------------------------------------------- */

void stream_loop(void) {
    if (ota_running()) {
        return;
    }
    if (!connected) {
        if (!wifi_has_ip()) {
            return;
        }
        tls_time_start();
        if ((int32_t)(millis() - next_try) < 0 || !tls_time_ready()) {
            return;
        }
        next_try = millis() + RECONNECT_MS;
        connect_server();
        if (!connected) {
            return;
        }
    }

    if (!wifi_has_ip() || !client->connected()) {
        disconnect();
        return;
    }
    while (connected && client->available() > 0) {
        if (!read_frame()) {
            disconnect();
            return;
        }
    }
    if (!connected) {
        return; // a command closed the link (an update)
    }
    uint32_t now = millis();
    if (now - last_rx > SILENT_TIMEOUT_MS) {
        DEBUG_ERROR("nothing from the server for %d s\n", SILENT_TIMEOUT_MS / 1000);
        disconnect();
        return;
    }
    if (now - last_ping >= PING_INTERVAL_MS) {
        last_ping = now;
        if (!send_frame(WS_OP_PING, NULL, 0)) {
            disconnect();
            return;
        }
    }
    if (hello_pending) {
        hello_pending = false;
        send_hello();
    }
    if (telemetry_pending || last_telemetry == 0 || now - last_telemetry >= TELEMETRY_INTERVAL_MS) {
        telemetry_pending = false;
        last_telemetry    = now == 0 ? 1 : now;
        send_telemetry();
    }
}

bool stream_connected(void) {
    return connected;
}

void stream_stop(void) {
    if (connected || client != NULL) {
        disconnect();
    }
}

void stream_telemetry_soon(void) {
    telemetry_pending = true;
}
