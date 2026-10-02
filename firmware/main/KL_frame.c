#include "KL_frame.h"

#include <stdlib.h>
#include <string.h>

#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "KL_camera.h"
#include "KL_serial.h"
#include "KL_time.h"

#define CAMERA_STACK_SIZE 4096
#define NEW_FRAME_BIT     BIT0
#define IDLE_WAIT_MS      1000 // longest sleep without demand before the demand is read again

static SemaphoreHandle_t frame_mutex;
static EventGroupHandle_t frame_events;
static TaskHandle_t camera_task_handle = NULL;

static uint8_t demand[FRAME_CONSUMERS];

// the latest frame, behind frame_mutex
static frame_copy_t latest;

static uint8_t fps_last_second = 0;

/* ----------------------------------------------------------------------- */

static uint8_t highest_demand(void) {
    uint8_t fps = 0;
    for (int i = 0; i < FRAME_CONSUMERS; i++) {
        if (demand[i] > fps) {
            fps = demand[i];
        }
    }
    return fps;
}

static bool grow(frame_copy_t *copy, size_t len) {
    if (copy->cap >= len) {
        return true;
    }
    // room for a somewhat larger next frame, so the buffer is not grown on every frame
    size_t cap   = len + len / 4;
    uint8_t *buf = heap_caps_realloc(copy->buf, cap, MALLOC_CAP_SPIRAM);
    if (buf == NULL) {
        DEBUG_ERROR("no memory for a %u byte frame\n", (unsigned)len);
        return false;
    }
    copy->buf = buf;
    copy->cap = cap;
    return true;
}

static void camera_task(void *pvParams) {
    int64_t second_start = millis();
    uint8_t frames       = 0;

    while (1) {
        uint8_t fps = highest_demand();
        if (fps == 0 || !camera_ready()) {
            fps_last_second = 0;
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(IDLE_WAIT_MS));
            continue;
        }

        int64_t start   = millis();
        camera_fb_t *fb = camera_take();
        if (fb == NULL) {
            DEBUG_ERROR("camera: %s\n", camera_last_error());
            delay_ms(100);
            continue;
        }

        xSemaphoreTake(frame_mutex, portMAX_DELAY);
        if (grow(&latest, fb->len)) {
            memcpy(latest.buf, fb->buf, fb->len);
            latest.len     = fb->len;
            latest.time_ms = start;
            latest.seq++;
            if (latest.seq == 0) {
                latest.seq = 1; // 0 means "no frame yet" to the consumers
            }
        }
        xSemaphoreGive(frame_mutex);
        camera_return(fb);

        /* Waiters on the bit are released when it is set, so clearing it at once
         * makes it a broadcast to every consumer waiting right now. */
        xEventGroupSetBits(frame_events, NEW_FRAME_BIT);
        xEventGroupClearBits(frame_events, NEW_FRAME_BIT);

        frames++;
        if (millis() - second_start >= 1000) {
            fps_last_second = frames;
            frames          = 0;
            second_start    = millis();
        }

        // the rest of the frame period; a demand raised meanwhile ends the wait early
        int64_t period  = 1000 / fps;
        int64_t elapsed = millis() - start;
        if (elapsed < period) {
            ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(period - elapsed));
        }
    }
}

/* ----------------------------------------------------------------------- */

void frame_hub_start(void) {
    frame_mutex  = xSemaphoreCreateMutex();
    frame_events = xEventGroupCreate();

    // core 1: wifi runs on core 0
    xTaskCreatePinnedToCore(camera_task, "camera_task", CAMERA_STACK_SIZE, NULL, 5, &camera_task_handle, 1);
}

void frame_set_demand(frame_consumer_t consumer, uint8_t fps) {
    if (consumer >= FRAME_CONSUMERS) {
        return;
    }
    if (fps > CONFIG_KIBBL_STREAM_MAX_FPS) {
        fps = CONFIG_KIBBL_STREAM_MAX_FPS;
    }
    uint8_t before   = demand[consumer];
    demand[consumer] = fps;
    if (fps > before && camera_task_handle != NULL) {
        xTaskNotifyGive(camera_task_handle);
    }
}

uint8_t frame_demand(frame_consumer_t consumer) {
    return consumer < FRAME_CONSUMERS ? demand[consumer] : 0;
}

bool frame_due(frame_consumer_t consumer, int64_t *last_ms) {
    uint8_t fps = frame_demand(consumer);
    if (fps == 0) {
        return false;
    }
    // a few ms early is still due: frames arrive with the camera's own jitter
    int64_t now = millis();
    if (now - *last_ms + 5 < 1000 / fps) {
        return false;
    }
    *last_ms = now;
    return true;
}

bool frame_copy_latest(frame_copy_t *copy, uint32_t wait_ms) {
    int64_t deadline = millis() + wait_ms;

    while (1) {
        xSemaphoreTake(frame_mutex, portMAX_DELAY);
        if (latest.seq != 0 && latest.seq != copy->seq) {
            bool ok = grow(copy, latest.len);
            if (ok) {
                memcpy(copy->buf, latest.buf, latest.len);
                copy->len     = latest.len;
                copy->seq     = latest.seq;
                copy->time_ms = latest.time_ms;
            }
            xSemaphoreGive(frame_mutex);
            return ok;
        }
        xSemaphoreGive(frame_mutex);

        int64_t left = deadline - millis();
        if (left <= 0) {
            return false;
        }
        /* A frame published between the check above and this wait is missed by the
         * bit; the short wait finds it in seq at the next check instead. */
        xEventGroupWaitBits(frame_events, NEW_FRAME_BIT, pdFALSE, pdFALSE, pdMS_TO_TICKS(left < 200 ? left : 200));
    }
}

void frame_copy_free(frame_copy_t *copy) {
    free(copy->buf);
    memset(copy, 0, sizeof(*copy));
}

uint8_t frame_fps(void) {
    return fps_last_second;
}

size_t frame_last_size(void) {
    return latest.len;
}
