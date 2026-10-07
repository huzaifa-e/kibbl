#ifndef KL_STREAM_H
#define KL_STREAM_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "cJSON.h"

/* The link to the server (docs/protocol.md): one websocket the device opens itself,
 * so it works behind the home router without a port forward. Binary messages are
 * the frames of a camera, text messages json: hello, telemetry and events up, commands
 * down. */
void stream_start(void);

bool stream_connected(void);

/* Sends a message of the product (an event) or a binary frame; false while not
 * connected or when the send timed out. Called from the stream task, the product's
 * own tasks may call stream_send_json() too. */
bool stream_send_json(cJSON *json);
bool stream_send_bin(const uint8_t *buf, size_t len);

// sends the hello again: what the device can do has changed (the camera came back)
void stream_announce(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_STREAM_H */
