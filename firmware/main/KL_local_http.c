#include "KL_local_http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_http_server.h"

#include "cJSON.h"

#include "KL_commands.h"
#include "KL_config.h"
#include "KL_frame.h"
#include "KL_serial.h"
#include "KL_time.h"

#define LOCAL_STREAM_FPS 10
#define SNAPSHOT_FPS     5
#define SNAPSHOT_WAIT_MS 3000
#define STREAM_WAIT_MS   2000 // a stream without a frame this long has lost its camera

#define PART_BOUNDARY "hmframe"

static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY     = "\r\n--" PART_BOUNDARY "\r\n";
static const char *STREAM_PART         = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

extern const char index_html_start[] asm("_binary_index_html_start");
extern const char index_html_end[] asm("_binary_index_html_end");

static httpd_handle_t page_server   = NULL;
static httpd_handle_t stream_server = NULL;

/* ----------------------------------------------------------------------- */

/* Compares all characters whatever the first difference, so the time a wrong key
 * takes says nothing about how much of it was right. */
static bool key_matches(const char *given) {
    const char *key = config_local_key();
    size_t len      = strlen(key);
    if (strlen(given) != len) {
        return false;
    }
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) {
        diff |= (uint8_t)(given[i] ^ key[i]);
    }
    return diff == 0;
}

static bool authorized(httpd_req_t *req) {
    char query[64];
    char key[LOCAL_KEY_LEN + 2];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
        httpd_query_key_value(query, "key", key, sizeof(key)) == ESP_OK && key_matches(key)) {
        return true;
    }
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "the local key is missing or wrong: {\"cmd\":\"info\"} over serial prints the url\n");
    return false;
}

/* ----------------------------------------------------------------------- */

static esp_err_t index_handler(httpd_req_t *req) {
    if (!authorized(req)) {
        return ESP_OK;
    }
    httpd_resp_set_type(req, "text/html");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, index_html_start, index_html_end - index_html_start - 1);
}

static esp_err_t status_handler(httpd_req_t *req) {
    if (!authorized(req)) {
        return ESP_OK;
    }
    cJSON *json = cJSON_CreateObject();
    commands_add_info(json, CMD_SOURCE_SERVER); // the secrets stay out of it
    char *str = cJSON_PrintUnformatted(json);
    cJSON_Delete(json);
    if (str == NULL) {
        return httpd_resp_send_500(req);
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_sendstr(req, str);
    free(str);
    return err;
}

static esp_err_t capture_handler(httpd_req_t *req) {
    if (!authorized(req)) {
        return ESP_OK;
    }
    frame_copy_t copy = {0};

    frame_set_demand(FRAME_CONSUMER_SNAPSHOT, SNAPSHOT_FPS);
    // copy.seq is 0: the latest frame is taken when there is one
    bool ok = frame_copy_latest(&copy, SNAPSHOT_WAIT_MS);
    frame_set_demand(FRAME_CONSUMER_SNAPSHOT, 0);

    esp_err_t err;
    if (!ok) {
        err = httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "no frame from the camera");
    } else {
        httpd_resp_set_type(req, "image/jpeg");
        httpd_resp_set_hdr(req, "Content-Disposition", "inline; filename=capture.jpg");
        err = httpd_resp_send(req, (const char *)copy.buf, copy.len);
    }
    frame_copy_free(&copy);
    return err;
}

static esp_err_t stream_handler(httpd_req_t *req) {
    if (!authorized(req)) {
        return ESP_OK;
    }
    frame_copy_t copy = {0};
    char part[64];
    int64_t last_frame = 0;

    esp_err_t err = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    frame_set_demand(FRAME_CONSUMER_LOCAL, LOCAL_STREAM_FPS);
    DEBUG("local stream started\n");

    while (err == ESP_OK) {
        if (!frame_due(FRAME_CONSUMER_LOCAL, &last_frame)) {
            delay_ms(5);
            continue;
        }
        if (!frame_copy_latest(&copy, STREAM_WAIT_MS)) {
            err = ESP_FAIL;
            break;
        }
        size_t hlen = snprintf(part, sizeof(part), STREAM_PART, (unsigned)copy.len);

        err = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
        if (err == ESP_OK) {
            err = httpd_resp_send_chunk(req, part, hlen);
        }
        if (err == ESP_OK) {
            err = httpd_resp_send_chunk(req, (const char *)copy.buf, copy.len);
        }
    }

    // the viewer left (send failed): the camera may stop
    frame_set_demand(FRAME_CONSUMER_LOCAL, 0);
    frame_copy_free(&copy);
    DEBUG("local stream ended\n");
    return err;
}

/* ----------------------------------------------------------------------- */

bool local_http_start(void) {
    if (page_server != NULL) {
        return true;
    }

    httpd_config_t config   = HTTPD_DEFAULT_CONFIG();
    config.server_port      = 80;
    config.ctrl_port        = 32768;
    config.max_uri_handlers = 4;
    config.lru_purge_enable = true;

    const httpd_uri_t index_uri   = {.uri = "/", .method = HTTP_GET, .handler = index_handler};
    const httpd_uri_t status_uri  = {.uri = "/status", .method = HTTP_GET, .handler = status_handler};
    const httpd_uri_t capture_uri = {.uri = "/capture", .method = HTTP_GET, .handler = capture_handler};

    if (httpd_start(&page_server, &config) != ESP_OK) {
        DEBUG_F_ERROR("local page server not started\n");
        page_server = NULL;
        return false;
    }
    httpd_register_uri_handler(page_server, &index_uri);
    httpd_register_uri_handler(page_server, &status_uri);
    httpd_register_uri_handler(page_server, &capture_uri);

    config.server_port       = 81;
    config.ctrl_port         = 32769;
    config.max_open_sockets  = 2;
    config.send_wait_timeout = 10; // s: a viewer that stops reading ends the stream
    const httpd_uri_t stream_uri = {.uri = "/stream", .method = HTTP_GET, .handler = stream_handler};

    if (httpd_start(&stream_server, &config) != ESP_OK) {
        DEBUG_F_ERROR("local stream server not started\n");
        stream_server = NULL;
        return false;
    }
    httpd_register_uri_handler(stream_server, &stream_uri);

    DEBUG_F("local stream page on port 80, {\"cmd\":\"info\"} prints its url\n");
    return true;
}
