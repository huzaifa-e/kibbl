#include "KL_portal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_http_server.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

#include "cJSON.h"

#include "KL_commands.h"
#include "KL_config.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_stream.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define DNS_STACK_SIZE   3072
#define STOP_STACK_SIZE  4096
#define HTTP_STACK_SIZE  6144
#define BODY_MAX         512
#define ATTEMPT_MS       (30 * 1000) // to join the chosen network
#define ATTEMPT_RETRIES  3
#define PORTAL_IP        "192.168.4.1" // the access point's own address (esp-netif default)
#define SCAN_MAX         20

extern const char portal_html_start[] asm("_binary_portal_html_start");
extern const char portal_html_end[] asm("_binary_portal_html_end");

typedef enum {
    PORTAL_IDLE = 0,
    PORTAL_CONNECTING,
    PORTAL_CONNECTED,
    PORTAL_FAILED,
} portal_state_t;

static volatile bool running        = false;
static volatile portal_state_t state = PORTAL_IDLE;
static volatile uint8_t fail_reason = 0;
static uint8_t attempts             = 0;
static char target_ssid[33];
static char ap_ssid[16];

static httpd_handle_t server            = NULL;
static int dns_sock                     = -1;
static esp_timer_handle_t attempt_timer = NULL;
static esp_timer_handle_t linger_timer  = NULL;

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
    case WIFI_REASON_NO_AP_FOUND:
        return "The network was not found. Is the device close enough to the router, and is it a 2.4 GHz network?";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_AUTH_EXPIRE:
        return "The password was not accepted.";
    case 0:
        return "No answer from the network in time. Try again, closer to the router.";
    default:
        return "The network refused the connection.";
    }
}

/* The address of the app, from the server's: wss://host/device/socket -> https://host */
static void app_url(char *out, size_t max) {
    const char *url = config_server_url();
    const char *scheme = strncmp(url, "wss://", 6) == 0 ? "https://" : "http://";
    const char *host   = strstr(url, "://");
    host               = host ? host + 3 : url;
    size_t len         = strcspn(host, "/");
    snprintf(out, max, "%s%.*s", scheme, (int)len, host);
}

/* ----------------------------------------------------------------------- */

static void stop_task(void *pvParams) {
    delay_ms(100);
    if (server != NULL) {
        httpd_stop(server);
        server = NULL;
    }
    if (dns_sock >= 0) {
        shutdown(dns_sock, SHUT_RDWR);
        close(dns_sock); // ends the dns task
        dns_sock = -1;
    }
    esp_wifi_set_mode(WIFI_MODE_STA);
    running = false;
    xEventGroupClearBits(wifi_event_group, WIFI_PROV_ACTIVE_BIT);
    set_status_led(stream_connected() ? LED_BLIP : LED_FAST);
    DEBUG_F("setup portal closed\n");
    vTaskDelete(NULL);
}

static void linger_cb(void *arg) {
    xTaskCreate(stop_task, "portal_stop", STOP_STACK_SIZE, NULL, 3, NULL);
}

static void attempt_cb(void *arg) {
    if (state == PORTAL_CONNECTING) {
        DEBUG_F("setup: \"%s\" not joined in %d s\n", target_ssid, ATTEMPT_MS / 1000);
        fail_reason = 0;
        state       = PORTAL_FAILED;
        esp_wifi_disconnect();
    }
}

void portal_connected(const char *ssid) {
    if (!running || state == PORTAL_CONNECTED) {
        return;
    }
    esp_timer_stop(attempt_timer);
    state = PORTAL_CONNECTED;
    DEBUG_F("setup: joined \"%s\", pairing code %s, the portal closes in %d min\n", ssid, config_claim_code(), PORTAL_LINGER_MS / 60000);
    esp_timer_start_once(linger_timer, (uint64_t)PORTAL_LINGER_MS * 1000);
}

void portal_connect_failed(uint8_t reason) {
    if (state == PORTAL_CONNECTED) {
        esp_wifi_connect(); // dropped while the page still shows the result: as always, again
        return;
    }
    if (state != PORTAL_CONNECTING) {
        return;
    }
    fail_reason = reason;
    if (++attempts < ATTEMPT_RETRIES && reason != WIFI_REASON_AUTH_FAIL) {
        esp_wifi_connect();
        return;
    }
    esp_timer_stop(attempt_timer);
    state = PORTAL_FAILED;
    DEBUG_F("setup: \"%s\" not joined (reason %u)\n", target_ssid, reason);
}

/* ----------------------------------------------------------------------- */

static esp_err_t send_json(httpd_req_t *req, cJSON *json) {
    char *str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (str == NULL) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    esp_err_t err = httpd_resp_sendstr(req, str);
    free(str);
    return err;
}

static esp_err_t page_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, portal_html_start, portal_html_end - portal_html_start);
}

static esp_err_t scan_handler(httpd_req_t *req) {
    wifi_ap_record_t *records = calloc(SCAN_MAX, sizeof(wifi_ap_record_t));
    if (records == NULL) {
        return httpd_resp_send_500(req);
    }
    int count       = wifi_scan(records, SCAN_MAX);
    cJSON *networks = cJSON_CreateArray();
    for (int i = 0; i < count; i++) {
        cJSON *net = cJSON_CreateObject();
        char ssid[33];
        memcpy(ssid, records[i].ssid, 32);
        ssid[32] = '\0';
        cJSON_AddStringToObject(net, "ssid", ssid);
        cJSON_AddNumberToObject(net, "rssi", records[i].rssi);
        cJSON_AddBoolToObject(net, "secure", records[i].authmode != WIFI_AUTH_OPEN);
        cJSON_AddItemToArray(networks, net);
    }
    free(records);
    return send_json(req, networks);
}

static esp_err_t status_handler(httpd_req_t *req) {
    char app[96];
    app_url(app, sizeof(app));
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "state", state_name(state));
    cJSON_AddStringToObject(json, "deviceId", config_device_id());
    cJSON_AddStringToObject(json, "server", config_server_url());
    cJSON_AddStringToObject(json, "app", app);
    cJSON_AddStringToObject(json, "ssid", target_ssid);
    if (state == PORTAL_FAILED) {
        cJSON_AddStringToObject(json, "error", reason_text(fail_reason));
    }
    // only once it is on the home network: then the person at the page set it up
    if (state == PORTAL_CONNECTED) {
        cJSON_AddStringToObject(json, "claim", config_claim_code());
    }
    return send_json(req, json);
}

static esp_err_t connect_handler(httpd_req_t *req) {
    char body[BODY_MAX + 1];
    if (req->content_len == 0 || req->content_len > BODY_MAX) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "bad request");
        return ESP_OK;
    }
    int got = 0;
    while (got < (int)req->content_len) {
        int n = httpd_req_recv(req, body + got, req->content_len - got);
        if (n <= 0) {
            return ESP_FAIL;
        }
        got += n;
    }
    body[got] = '\0';

    cJSON *json = cJSON_Parse(body);
    memset(body, 0, sizeof(body)); // it holds the password
    const char *ssid     = json_string(json, "ssid");
    const char *password = json_string(json, "password");
    const char *url      = json_string(json, "server");
    const char *error    = NULL;

    if (ssid == NULL || password == NULL || strlen(ssid) == 0 || strlen(ssid) > 32) {
        error = "Choose a network.";
    } else if (strlen(password) != 0 && (strlen(password) < 8 || strlen(password) > 63)) {
        error = "A Wi-Fi password has 8 to 63 characters.";
    } else if (url != NULL && url[0] != '\0' && strcmp(url, config_server_url()) != 0 && !config_set_server_url(url)) {
        error = "The server address starts with ws:// or wss://.";
    } else {
        strlcpy(target_ssid, ssid, sizeof(target_ssid));
        attempts = 0;
        state    = PORTAL_CONNECTING;
        DEBUG_F("setup: joining \"%s\"\n", target_ssid);
        if (!wifi_set_credentials(ssid, password)) {
            state = PORTAL_FAILED;
            error = "The network was not taken.";
        } else {
            esp_timer_stop(attempt_timer);
            esp_timer_start_once(attempt_timer, (uint64_t)ATTEMPT_MS * 1000);
        }
    }
    cJSON_Delete(json);

    cJSON *resp = cJSON_CreateObject();
    cJSON_AddBoolToObject(resp, "ok", error == NULL);
    if (error != NULL) {
        cJSON_AddStringToObject(resp, "error", error);
    }
    return send_json(req, resp);
}

/* Every other address: the setup page. Phones test the internet with such requests
 * (generate_204, hotspot-detect.html, connecttest.txt) and show the portal on a redirect. */
static esp_err_t redirect_handler(httpd_req_t *req) {
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://" PORTAL_IP "/");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, NULL, 0);
}

static bool start_http(void) {
    httpd_config_t cfg   = HTTPD_DEFAULT_CONFIG();
    cfg.uri_match_fn     = httpd_uri_match_wildcard;
    cfg.stack_size       = HTTP_STACK_SIZE;
    cfg.max_uri_handlers = 8;
    cfg.lru_purge_enable = true;
    if (httpd_start(&server, &cfg) != ESP_OK) {
        return false;
    }
    const httpd_uri_t uris[] = {
        {.uri = "/", .method = HTTP_GET, .handler = page_handler},
        {.uri = "/scan", .method = HTTP_GET, .handler = scan_handler},
        {.uri = "/status", .method = HTTP_GET, .handler = status_handler},
        {.uri = "/connect", .method = HTTP_POST, .handler = connect_handler},
        {.uri = "/*", .method = HTTP_GET, .handler = redirect_handler}, // last: the others first
    };
    for (size_t i = 0; i < sizeof(uris) / sizeof(uris[0]); i++) {
        httpd_register_uri_handler(server, &uris[i]);
    }
    return true;
}

/* ----------------------------------------------------------------------- */

/* A name server that answers every A query with the portal's address: whatever a phone
 * looks up while it is on the setup Wi-Fi leads to the setup page. */
static void dns_task(void *pvParams) {
    uint8_t buf[512];
    const uint8_t ip[4] = {192, 168, 4, 1};

    while (dns_sock >= 0) {
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        int len            = recvfrom(dns_sock, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &from_len);
        if (len < 0) {
            break; // closed by stop_task
        }
        // a standard query with one question, nothing else
        if (len < 12 || (buf[2] & 0x80) || buf[4] != 0 || buf[5] != 1) {
            continue;
        }
        int pos = 12;
        while (pos < len && buf[pos] != 0) {
            pos += buf[pos] + 1;
        }
        pos += 5; // the zero length, type and class
        if (pos > len) {
            continue;
        }
        bool a_query = buf[pos - 4] == 0 && buf[pos - 3] == 1;

        buf[2] = 0x84 | (buf[2] & 0x01); // a response, authoritative, recursion as asked
        buf[3] = 0x80;                   // recursion available, no error
        buf[6] = 0;
        buf[7] = a_query ? 1 : 0; // one answer for A, none for AAAA and the rest
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        len                                 = pos;
        if (a_query) {
            const uint8_t answer[] = {0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ip[0], ip[1], ip[2], ip[3]};
            memcpy(&buf[len], answer, sizeof(answer));
            len += sizeof(answer);
        }
        sendto(dns_sock, buf, len, 0, (struct sockaddr *)&from, from_len);
    }
    vTaskDelete(NULL);
}

static bool start_dns(void) {
    dns_sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (dns_sock < 0) {
        return false;
    }
    struct sockaddr_in addr = {.sin_family = AF_INET, .sin_port = htons(53), .sin_addr.s_addr = htonl(INADDR_ANY)};
    if (bind(dns_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(dns_sock);
        dns_sock = -1;
        return false;
    }
    return xTaskCreate(dns_task, "portal_dns", DNS_STACK_SIZE, NULL, 3, NULL) == pdPASS;
}

/* ----------------------------------------------------------------------- */

void portal_start(void) {
    uint8_t mac[6];
    esp_wifi_get_mac(WIFI_IF_STA, mac);
    snprintf(ap_ssid, sizeof(ap_ssid), "kibbl-%02X%02X", mac[4], mac[5]);

    const esp_timer_create_args_t attempt_args = {.callback = attempt_cb, .name = "portal_attempt"};
    const esp_timer_create_args_t linger_args  = {.callback = linger_cb, .name = "portal_linger"};
    esp_timer_create(&attempt_args, &attempt_timer);
    esp_timer_create(&linger_args, &linger_timer);

    wifi_config_t ap = {
        .ap = {
            .channel        = 1,
            .max_connection = 4,
            .authmode       = WIFI_AUTH_OPEN,
        },
    };
    memcpy(ap.ap.ssid, ap_ssid, strlen(ap_ssid));
    ap.ap.ssid_len = strlen(ap_ssid);

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());

    running = true;
    if (!start_http() || !start_dns()) {
        DEBUG_F_ERROR("setup portal not complete (page or name server)\n");
    }
    DEBUG_F("no network set: join the Wi-Fi \"%s\", the setup page opens (else http://" PORTAL_IP "/),\n", ap_ssid);
    DEBUG_F("or send {\"cmd\":\"wifi\",\"ssid\":\"...\",\"password\":\"...\"} over serial\n");
}

bool portal_running(void) {
    return running;
}
