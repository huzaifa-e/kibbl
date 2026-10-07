#ifndef KL_EVENTS_H
#define KL_EVENTS_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "cJSON.h"

/* Events for the server ({"type":"event","event":"smoke",...}, docs/protocol.md). They
 * wait in memory while the server is not reached and go out in order once it is, each
 * with its "ageSeconds": the device has no clock, the server dates them. A full queue
 * drops the oldest. */
void events_setup(void);

// takes json (the event's fields, without "type"); the queue frees it
void events_push(cJSON *json);

// sends what waits; from the stream task while connected. True when one was sent
bool events_send(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_EVENTS_H */
