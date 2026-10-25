/*
 * A Bambu Lab printer on the home network (docs/printer.md). Its MQTT broker (TLS, port
 * 8883, user bblp, the access code as the password) sends the state on device/<serial>/report:
 * the X1 all of it each time, the P1 and A1 only what changed, so the fields are kept and each
 * report overwrites the ones it has. Commands go to device/<serial>/request. The printer's
 * certificate is its own, signed by Bambu: not checked (CONFIG_ESP_TLS_SKIP_SERVER_CERT_VERIFY,
 * which only applies to a connection without a certificate; the server's and updates' are).
 */

#include "KL_printer.h"

#include "sdkconfig.h"

#if CONFIG_KIBBL_PRINTER

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "mqtt_client.h"

#include "KL_commands.h"
#include "KL_config.h"
#include "KL_nvs.h"
#include "KL_serial.h"
#include "KL_stream.h"
#include "KL_time.h"

#define NVS_HOST   "PRN_HOST"
#define NVS_SERIAL "PRN_SERIAL"
#define NVS_CODE   "PRN_CODE"

#define HOST_LEN   64
#define SERIAL_LEN 24
#define CODE_LEN   16
#define JOB_LEN    64

#define MQTT_PORT        8883
#define MQTT_BUFFER      4096        // one piece of a report; a longer one comes in several
#define REPORT_MAX       (64 * 1024) // a full report of an X1 with four AMS is about 15 kB
#define MQTT_STACK_SIZE  6144
#define RECONNECT_MS     15000
#define KEEPALIVE_S      30

#define HMS_MAX   4
#define TRAYS_MAX 16 // four AMS of four slots
#define NO_TRAY   255

typedef struct {
    bool present;      // a spool is in the slot
    char type[12];     // PLA, PETG, ...
    char color[7];     // RRGGBB
    int8_t remain;     // %, -1 unknown
} tray_t;

// what the printer reported last; a P1 sends only what changed, the rest stays
typedef struct {
    bool have_report;
    char state[12]; // gcode_state, lower case: idle, prepare, running, pause, finish, failed
    int percent;
    int remaining_min;
    int layer;
    int layers;
    char job[JOB_LEN];
    float nozzle, nozzle_target, bed, bed_target, chamber;
    bool has_chamber; // only the X1 measures it
    int speed;        // 1 silent, 2 standard, 3 sport, 4 ludicrous
    int light;        // the chamber light: -1 unknown, 0 off, 1 on
    long print_error;
    int hms_count;
    char hms[HMS_MAX][20];
    int tray_count;
    tray_t trays[TRAYS_MAX];
    int tray_now; // the slot it prints from, NO_TRAY none, 254 the spool outside
} printer_state_t;

static char host[HOST_LEN]     = "";
static char serial_no[SERIAL_LEN] = "";
static char code[CODE_LEN]     = "";

static esp_mqtt_client_handle_t client = NULL;
static SemaphoreHandle_t lock          = NULL;
static volatile bool connected         = false;
static const char *error_text          = NULL; // why it is not connected
static printer_state_t st;
static unsigned sequence = 0;

// a report that came in pieces
static char *report    = NULL;
static size_t report_size = 0;
static size_t report_len  = 0;

/* ----------------------------------------------------------------------- */

static bool configured(void) {
    return host[0] != '\0' && serial_no[0] != '\0' && code[0] != '\0';
}

static void topic(char *buf, size_t size, const char *kind) {
    snprintf(buf, size, "device/%s/%s", serial_no, kind);
}

static bool publish(cJSON *msg) {
    if (!connected || client == NULL) {
        return false;
    }
    char *text = cJSON_PrintUnformatted(msg);
    if (text == NULL) {
        return false;
    }
    char t[48];
    topic(t, sizeof(t), "request");
    int id = esp_mqtt_client_publish(client, t, text, 0, 0, 0);
    free(text);
    return id >= 0;
}

// {"<group>":{"sequence_id":"n","command":"<command>"}}: the body of every request
static cJSON *request(cJSON *msg, const char *group, const char *command) {
    cJSON *body = cJSON_AddObjectToObject(msg, group);
    char seq[12];
    snprintf(seq, sizeof(seq), "%u", ++sequence);
    cJSON_AddStringToObject(body, "sequence_id", seq);
    cJSON_AddStringToObject(body, "command", command);
    return body;
}

// everything at once: the P1 and A1 send only changes after it
static void ask_pushall(void) {
    cJSON *msg  = cJSON_CreateObject();
    cJSON *body = request(msg, "pushing", "pushall");
    cJSON_AddNumberToObject(body, "version", 1);
    cJSON_AddNumberToObject(body, "push_target", 1);
    publish(msg);
    cJSON_Delete(msg);
}

/* ----------------------------------------------------------------------- */
/* The report: numbers come as numbers or as strings ("255"), depending on the field */

static bool num_of(const cJSON *obj, const char *key, double *out) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(obj, key);
    if (cJSON_IsNumber(item)) {
        *out = item->valuedouble;
        return true;
    }
    if (cJSON_IsString(item) && item->valuestring[0] != '\0') {
        char *end;
        double v = strtod(item->valuestring, &end);
        if (*end == '\0') {
            *out = v;
            return true;
        }
    }
    return false;
}

static void int_of(const cJSON *obj, const char *key, int *out) {
    double v;
    if (num_of(obj, key, &v)) {
        *out = (int)v;
    }
}

static void float_of(const cJSON *obj, const char *key, float *out) {
    double v;
    if (num_of(obj, key, &v)) {
        *out = (float)v;
    }
}

static void string_of(const cJSON *obj, const char *key, char *out, size_t size) {
    const char *s = json_string(obj, key);
    if (s != NULL) {
        snprintf(out, size, "%s", s);
    }
}

static void read_hms(const cJSON *hms) {
    st.hms_count = 0;
    const cJSON *item;
    cJSON_ArrayForEach(item, hms) {
        double attr, c;
        if (st.hms_count >= HMS_MAX || !num_of(item, "attr", &attr) || !num_of(item, "code", &c)) {
            continue;
        }
        uint32_t a = (uint32_t)attr, k = (uint32_t)c;
        snprintf(st.hms[st.hms_count++], sizeof(st.hms[0]), "%04lX-%04lX-%04lX-%04lX", (unsigned long)(a >> 16),
                 (unsigned long)(a & 0xFFFF), (unsigned long)(k >> 16), (unsigned long)(k & 0xFFFF));
    }
}

static void read_lights(const cJSON *lights) {
    const cJSON *item;
    cJSON_ArrayForEach(item, lights) {
        const char *node = json_string(item, "node");
        const char *mode = json_string(item, "mode");
        if (node != NULL && mode != NULL && strcmp(node, "chamber_light") == 0) {
            st.light = strcmp(mode, "off") == 0 ? 0 : 1;
        }
    }
}

// "ams": {"ams": [{"id": "0", "tray": [{"id": "0", "tray_type": "PLA", "tray_color": "FFFFFFFF", "remain": 80}]}], "tray_now": "1"}
static void read_ams(const cJSON *ams) {
    int_of(ams, "tray_now", &st.tray_now);
    const cJSON *units = cJSON_GetObjectItemCaseSensitive(ams, "ams");
    if (!cJSON_IsArray(units)) {
        return;
    }
    st.tray_count = 0;
    const cJSON *unit;
    cJSON_ArrayForEach(unit, units) {
        int u = 0;
        int_of(unit, "id", &u);
        const cJSON *tray;
        cJSON_ArrayForEach(tray, cJSON_GetObjectItemCaseSensitive(unit, "tray")) {
            int t = 0;
            int_of(tray, "id", &t);
            int slot = u * 4 + t;
            if (slot < 0 || slot >= TRAYS_MAX) {
                continue;
            }
            tray_t *out = &st.trays[slot];
            memset(out, 0, sizeof(*out));
            out->remain = -1;
            const char *type = json_string(tray, "tray_type");
            if (type != NULL && type[0] != '\0') {
                out->present = true;
                snprintf(out->type, sizeof(out->type), "%s", type);
                const char *color = json_string(tray, "tray_color");
                if (color != NULL && strlen(color) >= 6) {
                    snprintf(out->color, sizeof(out->color), "%.6s", color);
                }
                int remain = -1;
                int_of(tray, "remain", &remain);
                out->remain = remain < 0 || remain > 100 ? -1 : (int8_t)remain;
            }
            if (slot + 1 > st.tray_count) {
                st.tray_count = slot + 1;
            }
        }
    }
}

// what makes the app redraw at once; the temperatures follow in the telemetry
static uint32_t shown(void) {
    uint32_t h = 2166136261u;
    const char *s = st.state;
    while (*s) {
        h = (h ^ (uint8_t)*s++) * 16777619u;
    }
    int parts[] = {st.percent, st.layer, st.light, st.speed, (int)st.print_error, st.hms_count, st.tray_now};
    for (size_t i = 0; i < sizeof(parts) / sizeof(parts[0]); i++) {
        h = (h ^ (uint32_t)parts[i]) * 16777619u;
    }
    return h;
}

static void handle_report(const char *text, size_t len) {
    cJSON *msg = cJSON_ParseWithLength(text, len);
    if (msg == NULL) {
        DEBUG_ERROR("printer: a report that is no json (%u bytes)\n", (unsigned)len);
        return;
    }
    const cJSON *print = cJSON_GetObjectItemCaseSensitive(msg, "print");
    if (cJSON_IsObject(print)) {
        xSemaphoreTake(lock, portMAX_DELAY);
        uint32_t before = shown();
        st.have_report  = true;

        const char *state = json_string(print, "gcode_state");
        if (state != NULL) {
            size_t i = 0;
            for (; state[i] != '\0' && i < sizeof(st.state) - 1; i++) {
                st.state[i] = (char)tolower((unsigned char)state[i]);
            }
            st.state[i] = '\0';
        }
        int_of(print, "mc_percent", &st.percent);
        int_of(print, "mc_remaining_time", &st.remaining_min);
        int_of(print, "layer_num", &st.layer);
        int_of(print, "total_layer_num", &st.layers);
        string_of(print, "subtask_name", st.job, sizeof(st.job));
        float_of(print, "nozzle_temper", &st.nozzle);
        float_of(print, "nozzle_target_temper", &st.nozzle_target);
        float_of(print, "bed_temper", &st.bed);
        float_of(print, "bed_target_temper", &st.bed_target);
        if (cJSON_GetObjectItemCaseSensitive(print, "chamber_temper") != NULL) {
            float_of(print, "chamber_temper", &st.chamber);
            st.has_chamber = true;
        }
        int_of(print, "spd_lvl", &st.speed);
        double err;
        if (num_of(print, "print_error", &err)) {
            st.print_error = (long)err;
        }
        const cJSON *hms = cJSON_GetObjectItemCaseSensitive(print, "hms");
        if (cJSON_IsArray(hms)) {
            read_hms(hms);
        }
        const cJSON *lights = cJSON_GetObjectItemCaseSensitive(print, "lights_report");
        if (cJSON_IsArray(lights)) {
            read_lights(lights);
        }
        const cJSON *ams = cJSON_GetObjectItemCaseSensitive(print, "ams");
        if (cJSON_IsObject(ams)) {
            read_ams(ams);
        }

        bool changed = shown() != before;
        xSemaphoreGive(lock);
        if (changed) {
            stream_telemetry_soon();
        }
    }
    cJSON_Delete(msg);
}

/* ----------------------------------------------------------------------- */

static void set_connected(bool on, const char *why) {
    bool changed = connected != on || error_text != why;
    connected    = on;
    error_text   = why;
    if (changed) {
        stream_telemetry_soon();
    }
}

// a report longer than the buffer comes in pieces: kept in PSRAM until it is whole
static void collect(const esp_mqtt_event_handle_t ev) {
    if (ev->total_data_len <= 0 || ev->total_data_len > REPORT_MAX) {
        return;
    }
    if (ev->current_data_offset == 0) {
        if (report_size < (size_t)ev->total_data_len) {
            free(report);
            report      = heap_caps_malloc(ev->total_data_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
            report_size = report ? (size_t)ev->total_data_len : 0;
        }
        report_len = 0;
    }
    if (report == NULL || ev->current_data_offset != (int)report_len || report_len + ev->data_len > report_size) {
        return;
    }
    memcpy(report + report_len, ev->data, ev->data_len);
    report_len += ev->data_len;
    if (report_len == (size_t)ev->total_data_len) {
        handle_report(report, report_len);
    }
}

static void mqtt_event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data) {
    esp_mqtt_event_handle_t ev = (esp_mqtt_event_handle_t)event_data;
    char t[48];

    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED:
        DEBUG_F("printer: connected (%s)\n", host);
        topic(t, sizeof(t), "report");
        esp_mqtt_client_subscribe(client, t, 0);
        set_connected(true, NULL);
        ask_pushall();
        break;
    case MQTT_EVENT_DISCONNECTED:
        if (connected) {
            DEBUG_F("printer: disconnected\n");
        }
        // a refused login stays the reason, esp-mqtt tries again on its own
        set_connected(false, error_text != NULL && strcmp(error_text, "access code refused") == 0 ? error_text : "printer not reachable");
        break;
    case MQTT_EVENT_DATA:
        collect(ev);
        break;
    case MQTT_EVENT_ERROR:
        if (ev->error_handle == NULL) {
            break;
        }
        if (ev->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            DEBUG_F_ERROR("printer: login refused (%d)\n", ev->error_handle->connect_return_code);
            set_connected(false, "access code refused");
        } else {
            DEBUG_ERROR("printer: no connection (tls 0x%x, errno %d)\n", ev->error_handle->esp_tls_last_esp_err,
                        ev->error_handle->esp_transport_sock_errno);
            set_connected(false, "printer not reachable");
        }
        break;
    default:
        break;
    }
}

static void printer_disconnect(void) {
    if (client != NULL) {
        esp_mqtt_client_stop(client);
        esp_mqtt_client_destroy(client);
        client = NULL;
    }
    connected  = false;
    error_text = NULL;
    free(report);
    report      = NULL;
    report_size = report_len = 0;
}

static void clear_state(void) {
    xSemaphoreTake(lock, portMAX_DELAY);
    memset(&st, 0, sizeof(st));
    st.light    = -1;
    st.tray_now = NO_TRAY;
    xSemaphoreGive(lock);
}

static void printer_connect(void) {
    printer_disconnect();
    clear_state();
    if (!configured()) {
        return;
    }
    char uri[HOST_LEN + 16];
    char client_id[32];
    snprintf(uri, sizeof(uri), "mqtts://%s:%d", host, MQTT_PORT);
    snprintf(client_id, sizeof(client_id), "kibbl-%s", config_device_id());

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri                             = uri,
        .broker.verification.skip_cert_common_name_check = true,
        .credentials.username                           = "bblp",
        .credentials.client_id                          = client_id,
        .credentials.authentication.password            = code,
        .session.keepalive                              = KEEPALIVE_S,
        .network.reconnect_timeout_ms                   = RECONNECT_MS,
        .network.timeout_ms                             = 10000,
        .buffer.size                                    = MQTT_BUFFER,
        .buffer.out_size                                = 1024,
        .task.stack_size                                = MQTT_STACK_SIZE,
    };
    client = esp_mqtt_client_init(&cfg);
    if (client == NULL) {
        error_text = "no memory for the printer";
        return;
    }
    esp_mqtt_client_register_event(client, ESP_EVENT_ANY_ID, mqtt_event_handler, NULL);
    error_text = "connecting";
    esp_mqtt_client_start(client);
    DEBUG_F("printer: connecting to %s, serial %s\n", host, serial_no);
}

/* ----------------------------------------------------------------------- */

void printer_setup(void) {
    lock = xSemaphoreCreateMutex();
    nvs_queue_job(NVS_HOST, host, sizeof(host), STRING, READ);
    nvs_queue_job(NVS_SERIAL, serial_no, sizeof(serial_no), STRING, READ);
    nvs_queue_job(NVS_CODE, code, sizeof(code), STRING, READ);
    // the connection waits for the network: esp-mqtt tries again until it gets through
    printer_connect();
}

// letters, digits and what an address has: nothing that could leave the url or the topic
static bool clean_text(const char *s, size_t max, const char *extra) {
    size_t n = strlen(s);
    if (n == 0 || n >= max) {
        return false;
    }
    for (size_t i = 0; i < n; i++) {
        if (!isalnum((unsigned char)s[i]) && (extra == NULL || strchr(extra, s[i]) == NULL)) {
            return false;
        }
    }
    return true;
}

/* {"cmd":"printer_config","host":"192.168.0.40","serial":"01P00A...","code":"12345678"}: the
 * code may be left out to keep the stored one; "enabled": false forgets the printer */
static const char *cmd_config(const cJSON *req) {
    bool enabled = true;
    if (!json_bool(req, "enabled", &enabled)) {
        return "enabled must be true or false";
    }
    if (!enabled) {
        printer_disconnect();
        host[0] = serial_no[0] = code[0] = '\0';
        nvs_remove_key(NVS_HOST);
        nvs_remove_key(NVS_SERIAL);
        nvs_remove_key(NVS_CODE);
        clear_state();
        DEBUG_F("printer: forgotten\n");
        return NULL;
    }
    const char *h = json_string(req, "host");
    const char *s = json_string(req, "serial");
    const char *c = json_string(req, "code");
    if (h == NULL || !clean_text(h, HOST_LEN, ".-")) {
        return "host: the printer's ip address or name";
    }
    if (s == NULL || !clean_text(s, SERIAL_LEN, NULL)) {
        return "serial: letters and digits";
    }
    if (c == NULL && code[0] == '\0') {
        return "code: the access code of the printer's screen";
    }
    if (c != NULL && !clean_text(c, CODE_LEN, NULL)) {
        return "code: letters and digits";
    }
    snprintf(host, sizeof(host), "%s", h);
    snprintf(serial_no, sizeof(serial_no), "%s", s);
    if (c != NULL) {
        snprintf(code, sizeof(code), "%s", c);
    }
    if (!nvs_queue_job(NVS_HOST, host, 0, STRING, WRITE) || !nvs_queue_job(NVS_SERIAL, serial_no, 0, STRING, WRITE) ||
        !nvs_queue_job(NVS_CODE, code, 0, STRING, WRITE)) {
        printer_connect();
        return "printer set, not stored";
    }
    printer_connect();
    return NULL;
}

// {"cmd":"printer","action":"pause"|"resume"|"stop"} or "light": bool or "speed": 1-4
static const char *cmd_printer(const cJSON *req) {
    const char *action = json_string(req, "action");
    bool light         = false;
    bool has_light     = cJSON_IsBool(cJSON_GetObjectItemCaseSensitive(req, "light"));
    int speed          = 0;

    if (!configured()) {
        return "no printer set";
    }
    if (!connected) {
        return error_text != NULL ? error_text : "printer not connected";
    }
    if (!json_bool(req, "light", &light) || !json_int_in_range(req, "speed", 1, 4, &speed)) {
        return "light true or false, speed 1 to 4";
    }

    cJSON *msg = cJSON_CreateObject();
    if (action != NULL) {
        if (strcmp(action, "pause") != 0 && strcmp(action, "resume") != 0 && strcmp(action, "stop") != 0) {
            cJSON_Delete(msg);
            return "action: pause, resume or stop";
        }
        cJSON_AddStringToObject(request(msg, "print", action), "param", "");
    } else if (has_light) {
        cJSON *body = request(msg, "system", "ledctrl");
        cJSON_AddStringToObject(body, "led_node", "chamber_light");
        cJSON_AddStringToObject(body, "led_mode", light ? "on" : "off");
        cJSON_AddNumberToObject(body, "led_on_time", 500);
        cJSON_AddNumberToObject(body, "led_off_time", 500);
        cJSON_AddNumberToObject(body, "loop_times", 0);
        cJSON_AddNumberToObject(body, "interval_time", 0);
    } else if (speed > 0) {
        char param[2] = {(char)('0' + speed), '\0'};
        cJSON_AddStringToObject(request(msg, "print", "print_speed"), "param", param);
    } else {
        cJSON_Delete(msg);
        return "action, light or speed";
    }
    bool sent = publish(msg);
    cJSON_Delete(msg);
    if (!sent) {
        return "printer not connected";
    }
    DEBUG_F("printer: %s\n", action != NULL ? action : has_light ? "light" : "speed");
    // what it shows now: the printer's report with the change follows within a second
    if (has_light) {
        xSemaphoreTake(lock, portMAX_DELAY);
        st.light = light ? 1 : 0;
        xSemaphoreGive(lock);
    } else if (speed > 0) {
        xSemaphoreTake(lock, portMAX_DELAY);
        st.speed = speed;
        xSemaphoreGive(lock);
    }
    return NULL;
}

bool printer_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error) {
    if (strcmp(cmd, "printer_config") == 0) {
        *error = cmd_config(req);
    } else if (strcmp(cmd, "printer") == 0) {
        *error = cmd_printer(req);
    } else {
        return false;
    }
    printer_add_state(resp);
    return true;
}

/* ----------------------------------------------------------------------- */

void printer_add_state(cJSON *json) {
    cJSON *p = cJSON_AddObjectToObject(json, "printer");
    cJSON_AddBoolToObject(p, "configured", configured());
    if (!configured()) {
        return;
    }
    // the access code stays on the device
    cJSON_AddStringToObject(p, "host", host);
    cJSON_AddStringToObject(p, "serial", serial_no);
    cJSON_AddBoolToObject(p, "connected", connected);
    if (!connected && error_text != NULL) {
        cJSON_AddStringToObject(p, "error", error_text);
    }

    xSemaphoreTake(lock, portMAX_DELAY);
    if (st.have_report) {
        cJSON_AddStringToObject(p, "state", st.state[0] ? st.state : "unknown");
        cJSON_AddNumberToObject(p, "percent", st.percent);
        cJSON_AddNumberToObject(p, "remainingMin", st.remaining_min);
        cJSON_AddNumberToObject(p, "layer", st.layer);
        cJSON_AddNumberToObject(p, "layers", st.layers);
        cJSON_AddStringToObject(p, "job", st.job);
        cJSON_AddNumberToObject(p, "nozzle", (int)(st.nozzle * 10 + 0.5f) / 10.0);
        cJSON_AddNumberToObject(p, "nozzleTarget", (int)(st.nozzle_target + 0.5f));
        cJSON_AddNumberToObject(p, "bed", (int)(st.bed * 10 + 0.5f) / 10.0);
        cJSON_AddNumberToObject(p, "bedTarget", (int)(st.bed_target + 0.5f));
        if (st.has_chamber) {
            cJSON_AddNumberToObject(p, "chamber", (int)(st.chamber * 10 + 0.5f) / 10.0);
        }
        if (st.speed > 0) {
            cJSON_AddNumberToObject(p, "speed", st.speed);
        }
        if (st.light >= 0) {
            cJSON_AddBoolToObject(p, "light", st.light == 1);
        }
        if (st.print_error != 0) {
            cJSON_AddNumberToObject(p, "printError", st.print_error);
        }
        cJSON *hms = cJSON_AddArrayToObject(p, "hms");
        for (int i = 0; i < st.hms_count; i++) {
            cJSON_AddItemToArray(hms, cJSON_CreateString(st.hms[i]));
        }
        cJSON *ams = cJSON_AddArrayToObject(p, "ams");
        for (int i = 0; i < st.tray_count; i++) {
            const tray_t *t = &st.trays[i];
            cJSON *tray     = cJSON_CreateObject();
            cJSON_AddNumberToObject(tray, "slot", i);
            if (t->present) {
                cJSON_AddStringToObject(tray, "type", t->type);
                cJSON_AddStringToObject(tray, "color", t->color);
                if (t->remain >= 0) {
                    cJSON_AddNumberToObject(tray, "remain", t->remain);
                }
            }
            cJSON_AddItemToArray(ams, tray);
        }
        cJSON_AddNumberToObject(p, "trayNow", st.tray_now);
    }
    xSemaphoreGive(lock);
}

void printer_stop(void) {
    printer_disconnect();
}

void printer_reset(void) {
    printer_disconnect();
    host[0] = serial_no[0] = code[0] = '\0';
    nvs_remove_key(NVS_HOST);
    nvs_remove_key(NVS_SERIAL);
    nvs_remove_key(NVS_CODE);
}

#else

void printer_setup(void) {
}

bool printer_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error) {
    return false;
}

void printer_add_state(cJSON *json) {
}

void printer_stop(void) {
}

void printer_reset(void) {
}

#endif
