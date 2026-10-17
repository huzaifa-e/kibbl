#ifndef KL_STREAM_H
#define KL_STREAM_H

#include <Arduino.h>
#include <ArduinoJson.h>

/*
 * The link to the server as kibbl_core's KL_stream (docs/protocol.md): one websocket the
 * device opens itself, so it works behind the home router without a port forward. Text
 * messages are json: hello, telemetry up, commands down, their responses up. The id and the
 * secret go in headers; the device pings every 10 s.
 */

// connects, reads, pings, sends the hello and the telemetry; from the loop
void stream_loop(void);

bool stream_connected(void);

// closes the link: an update needs the memory of its TLS
void stream_stop(void);

bool stream_send_json(JsonDocument &doc);

// sends the telemetry at the next turn instead of in up to 10 s
void stream_telemetry_soon(void);

#endif /* KL_STREAM_H */
