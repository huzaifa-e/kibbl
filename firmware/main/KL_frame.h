#ifndef KL_FRAME_H
#define KL_FRAME_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* One camera task takes frames at the highest rate any consumer asks for and keeps
 * the latest one. Each consumer copies it out in its own task, so a slow upload
 * never holds a camera frame buffer (two in the driver) and never slows the others. */
typedef enum {
    FRAME_CONSUMER_SERVER = 0,
    FRAME_CONSUMER_LOCAL,
    FRAME_CONSUMER_SNAPSHOT,
    FRAME_CONSUMERS
} frame_consumer_t;

typedef struct {
    uint8_t *buf;    // PSRAM, grown by frame_copy_latest() as frames grow
    size_t cap;
    size_t len;
    uint32_t seq;    // of the frame in buf; 0 before the first one
    int64_t time_ms; // millis() when the frame was taken
} frame_copy_t;

void frame_hub_start(void);

// frames per second this consumer wants, 0 stops it; the camera runs at the highest
void frame_set_demand(frame_consumer_t consumer, uint8_t fps);
uint8_t frame_demand(frame_consumer_t consumer);

/* True when the consumer's next frame is due: the camera may run faster for another
 * consumer, each one still gets only the rate it asked for. last_ms is its own. */
bool frame_due(frame_consumer_t consumer, int64_t *last_ms);

/* Waits up to wait_ms for a frame newer than copy->seq and copies it into copy.
 * False on timeout or when the copy buffer could not grow. */
bool frame_copy_latest(frame_copy_t *copy, uint32_t wait_ms);

void frame_copy_free(frame_copy_t *copy);

// frames taken in the last full second and the size of the latest, for the telemetry
uint8_t frame_fps(void);
size_t frame_last_size(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_FRAME_H */
