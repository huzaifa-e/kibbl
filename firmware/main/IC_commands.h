#ifndef IC_COMMANDS_H
#define IC_COMMANDS_H

#ifdef __cplusplus
extern "C" {
#endif

#include "cJSON.h"

typedef enum {
    CMD_SOURCE_SERIAL = 0, // the uart: someone holds the device
    CMD_SOURCE_SERVER,     // the authenticated server connection
} cmd_source_t;

/* Runs one {"cmd":"..."} request and returns the response to send back: {"ok":true}
 * with the command's data, or {"ok":false,"error":"..."}; an "id" in the request is
 * copied into it. The server url is taken from the serial port only; Wi-Fi from the
 * server switches with a fallback (docs/protocol.md). The caller frees the response. */
cJSON *commands_handle(const cJSON *req, cmd_source_t source);

// the device as the hello message and {"cmd":"info"} describe it
void commands_add_info(cJSON *json, cmd_source_t source);

#ifdef __cplusplus
}
#endif

#endif /* IC_COMMANDS_H */
