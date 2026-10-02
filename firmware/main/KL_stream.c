#include "KL_stream.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "cJSON.h"

#include "KL_commands.h"
#include "KL_config.h"
#include "KL_frame.h"
#include "KL_ota.h"
#include "KL_serial.h"
#include "KL_status_led.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define STREAM_STACK_SIZE     6144
#define WS_TASK_STACK_SIZE    6144
#define WS_BUFFER_SIZE        8192  // one websocket fragment, one tls record of a frame
#define CMD_QUEUE_LEN         8
#define CMD_MAX_LEN           2048  // longest command json taken from the server
#define TELEMETRY_INTERVAL_MS 10000
#define FRAME_SEND_TIMEOUT_MS 5000
#define FRAME_WAIT_MS         200   // the command queue is read at least this often

static esp_websocket_client_handle_t client = NULL;
static QueueHandle_t cmd_queue;

static volatile bool connected     = false;
static volatile bool hello_pending = false;

// the command being received, when the server splits it over several data events
static char *rx_buf    = NULL;
static size_t rx_len   = 0;

static char headers[160];

/* ----------------------------------------------------------------------- */

static void rx_reset(void) {
    free(rx_buf);
    rx_buf = NULL;
    rx_len = 0;
}

/* Runs in the websocket task: only collects the text and queues it; the commands run
 * in the stream task, which may block on the camera or on sending. */
static void ws_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        DEBUG_F("server connected (%s)\n", config_server_url());
        connected     = true;
        hello_pending = true;
        set_status_led(LED_BLIP);
        // reached the server: a new image is good, keep it
        ota_confirm_image();
        break;

    case WEBSOCKET_EVENT_DISCONNECTED:
    case WEBSOCKET_EVENT_CLOSED:
        if (connected) {
            DEBUG_F("server disconnected\n");
        }
        connected = false;
        frame_set_demand(FRAME_CONSUMER_SERVER, 0);
        rx_reset();
        if (xEventGroupGetBits(wifi_event_group) & WIFI_GOT_IP_BIT) {
            set_status_led(LED_FAST);
        }
        break;

    case WEBSOCKET_EVENT_ERROR:
        if (data->error_handle.esp_ws_handshake_status_code == 401) {
            // the server knows this id with another secret: a factory reset, or another device
            DEBUG_F_ERROR("server refused the device secret (401), remove the device in the app to pair it again\n");
        } else {
            DEBUG_ERROR("server connection error (handshake %d, errno %d)\n", data->error_handle.esp_ws_handshake_status_code,
                        data->error_handle.esp_transport_sock_errno);
        }
        break;

    case WEBSOCKET_EVENT_DATA:
        if (data->op_code != 0x1) {
            break; // binary, ping, pong, close: nothing to run
        }
        if (data->payload_len <= 0 || data->payload_len > CMD_MAX_LEN) {
            DEBUG_ERROR("command of %d bytes dropped\n", data->payload_len);
            break;
        }
        if (data->payload_offset == 0) {
            rx_reset();
            rx_buf = malloc(data->payload_len + 1);
            if (rx_buf == NULL) {
                break;
            }
        }
        if (rx_buf == NULL || data->payload_offset != (int)rx_len || rx_len + data->data_len > (size_t)data->payload_len) {
            rx_reset();
            break;
        }
        memcpy(rx_buf + rx_len, data->data_ptr, data->data_len);
        rx_len += data->data_len;

        if (rx_len == (size_t)data->payload_len) {
            rx_buf[rx_len] = '\0';
            char *cmd      = rx_buf;
            rx_buf         = NULL; // the queue owns it now
            rx_len         = 0;
            if (xQueueSend(cmd_queue, &cmd, 0) != pdTRUE) {
                DEBUG_ERROR("command queue full, command dropped\n");
                free(cmd);
            }
        }
        break;

    default:
        break;
    }
}

/* ----------------------------------------------------------------------- */

static void send_json(cJSON *json) {
    char *str = cJSON_PrintUnformatted(json);
    if (str == NULL) {
        return;
    }
    if (esp_websocket_client_send_text(client, str, strlen(str), pdMS_TO_TICKS(FRAME_SEND_TIMEOUT_MS)) < 0) {
        DEBUG_ERROR("sending json failed\n");
    }
    free(str);
}

static void send_hello(void) {
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "type", "hello");
    commands_add_info(json, CMD_SOURCE_SERVER);
    send_json(json);
    cJSON_Delete(json);
}

static void send_telemetry(uint8_t sent_fps) {
    int rssi    = 0;
    cJSON *json = cJSON_CreateObject();
    cJSON_AddStringToObject(json, "type", "telemetry");
    cJSON_AddNumberToObject(json, "uptime", (double)(millis() / 1000));
    if (wifi_rssi(&rssi)) {
        cJSON_AddNumberToObject(json, "rssi", rssi);
    }
    cJSON_AddNumberToObject(json, "heap", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(json, "psram", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    cJSON_AddNumberToObject(json, "cameraFps", frame_fps());
    cJSON_AddNumberToObject(json, "fps", sent_fps);
    cJSON_AddNumberToObject(json, "frameBytes", frame_last_size());
    send_json(json);
    cJSON_Delete(json);
}

static void run_command(char *str) {
    cJSON *req = cJSON_Parse(str);
    free(str);
    if (req == NULL) {
        DEBUG_ERROR("command from the server is no json\n");
        return;
    }

    cJSON *resp = commands_handle(req, CMD_SOURCE_SERVER);
    cJSON_Delete(req);
    if (resp == NULL) {
        return;
    }
    cJSON_AddStringToObject(resp, "type", "response");
    send_json(resp);
    cJSON_Delete(resp);
}

static void stream_task(void *pvParams) {
    frame_copy_t copy = {0};

    int64_t last_telemetry = 0;
    int64_t last_frame     = 0;
    int64_t second_start   = millis();
    uint8_t sent           = 0;
    uint8_t sent_fps       = 0;

    while (1) {
        char *cmd = NULL;
        while (xQueueReceive(cmd_queue, &cmd, 0) == pdTRUE) {
            run_command(cmd);
        }

        if (connected && hello_pending) {
            hello_pending = false;
            send_hello();
        }

        if (connected && millis() - last_telemetry >= TELEMETRY_INTERVAL_MS) {
            last_telemetry = millis();
            send_telemetry(sent_fps);
        }

        if (!connected || frame_demand(FRAME_CONSUMER_SERVER) == 0) {
            // nothing to send: wait for a command instead (the frame buffer is kept for the next stream)
            if (xQueueReceive(cmd_queue, &cmd, pdMS_TO_TICKS(FRAME_WAIT_MS)) == pdTRUE) {
                run_command(cmd);
            }
        } else if (!frame_due(FRAME_CONSUMER_SERVER, &last_frame)) {
            delay_ms(5);
        } else if (frame_copy_latest(&copy, FRAME_WAIT_MS)) {
            int wlen = esp_websocket_client_send_bin(client, (const char *)copy.buf, copy.len, pdMS_TO_TICKS(FRAME_SEND_TIMEOUT_MS));
            if (wlen < 0) {
                DEBUG_ERROR("frame of %u bytes not sent\n", (unsigned)copy.len);
            } else {
                sent++;
            }
        }

        if (millis() - second_start >= 1000) {
            sent_fps     = sent;
            sent         = 0;
            second_start = millis();
        }
    }
}

/* ----------------------------------------------------------------------- */

void stream_start(void) {
    cmd_queue = xQueueCreate(CMD_QUEUE_LEN, sizeof(char *));

    /* The id and the secret go in headers, not in the url: urls end up in proxy logs.
     * The server pairs an unknown id on first contact (approved in the app) and from
     * then on refuses the id with any other secret. */
    snprintf(headers, sizeof(headers), "X-Device-Id: %s\r\nAuthorization: Bearer %s\r\n", config_device_id(), config_device_secret());

    esp_websocket_client_config_t ws_cfg = {
        .uri                  = config_server_url(),
        .headers              = headers,
        .buffer_size          = WS_BUFFER_SIZE,
        .task_stack           = WS_TASK_STACK_SIZE,
        .task_prio            = 5,
        .reconnect_timeout_ms = 5000,
        .network_timeout_ms   = 10000,
        .ping_interval_sec    = 10,
        .pingpong_timeout_sec = 30,
        .crt_bundle_attach    = esp_crt_bundle_attach,
        .user_agent           = "KibblHW",
    };

    client = esp_websocket_client_init(&ws_cfg);
    if (client == NULL) {
        DEBUG_F_ERROR("websocket client not created\n");
        return;
    }
    esp_websocket_register_events(client, WEBSOCKET_EVENT_ANY, ws_event_handler, NULL);
    esp_websocket_client_start(client);

    // core 0 with wifi: the camera task has core 1
    xTaskCreatePinnedToCore(stream_task, "stream_task", STREAM_STACK_SIZE, NULL, 4, NULL, 0);
}

bool stream_connected(void) {
    return connected;
}
