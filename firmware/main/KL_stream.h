#ifndef KL_STREAM_H
#define KL_STREAM_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

/* The link to the server (docs/protocol.md): one websocket the device opens itself,
 * so it works behind the home router without a port forward. Binary messages are
 * jpeg frames, text messages json: hello and telemetry up, commands down. */
void stream_start(void);

bool stream_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_STREAM_H */
