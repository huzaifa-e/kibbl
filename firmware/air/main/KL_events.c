#include "KL_events.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_serial.h"
#include "KL_stream.h"
#include "KL_time.h"

#define EVENTS_MAX 32

typedef struct {
    cJSON *json;
    int64_t time_ms; // millis() when it happened
} event_t;

static SemaphoreHandle_t events_mutex;
static event_t events[EVENTS_MAX];
static int head  = 0; // the oldest
static int count = 0;

void events_setup(void) {
    events_mutex = xSemaphoreCreateMutex();
}

void events_push(cJSON *json) {
    if (json == NULL) {
        return;
    }
    xSemaphoreTake(events_mutex, portMAX_DELAY);
    if (count == EVENTS_MAX) {
        DEBUG_ERROR("event queue full, the oldest event dropped\n");
        cJSON_Delete(events[head].json);
        head = (head + 1) % EVENTS_MAX;
        count--;
    }
    events[(head + count) % EVENTS_MAX] = (event_t){.json = json, .time_ms = millis()};
    count++;
    xSemaphoreGive(events_mutex);
}

bool events_send(void) {
    xSemaphoreTake(events_mutex, portMAX_DELAY);
    if (count == 0) {
        xSemaphoreGive(events_mutex);
        return false;
    }
    event_t *event = &events[head];
    // a try that failed added them already
    cJSON_DeleteItemFromObject(event->json, "type");
    cJSON_DeleteItemFromObject(event->json, "ageSeconds");
    cJSON_AddStringToObject(event->json, "type", "event");
    cJSON_AddNumberToObject(event->json, "ageSeconds", (double)((millis() - event->time_ms) / 1000));

    bool sent = stream_send_json(event->json);
    if (sent) {
        cJSON_Delete(event->json);
        head = (head + 1) % EVENTS_MAX;
        count--;
    }
    xSemaphoreGive(events_mutex);
    return sent;
}
