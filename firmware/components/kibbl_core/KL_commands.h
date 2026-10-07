#ifndef KL_COMMANDS_H
#define KL_COMMANDS_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "cJSON.h"

typedef enum {
    CMD_SOURCE_SERIAL = 0, // the uart: someone holds the device
    CMD_SOURCE_SERVER,     // the authenticated server connection
} cmd_source_t;

/* Runs one {"cmd":"..."} request and returns the response to send back: {"ok":true}
 * with the command's data, or {"ok":false,"error":"..."}; an "id" in the request is
 * copied into it. The server url is taken from the serial port only; Wi-Fi from the
 * server switches with a fallback (docs/protocol.md). Commands the core does not know
 * go to product_command(). The caller frees the response. */
cJSON *commands_handle(const cJSON *req, cmd_source_t source);

// the device as the hello message and {"cmd":"info"} describe it
void commands_add_info(cJSON *json, cmd_source_t source);

// restarts in 1 s, so the response to the command still goes out
void restart_later(void);

// reads the serial requests and prints the responses, as one task
void serial_cmd_task(void *pvParams);

/*
 * Field checks for the commands of the core and of the products
 */

// the string at key, NULL when it is missing or no string
const char *json_string(const cJSON *req, const char *key);

// true and *out set when key is a number in min..max, true and *out kept when key is left out
bool json_int_in_range(const cJSON *json, const char *key, int min, int max, int *out);

// true and *out set when key is a bool, true and *out kept when key is left out
bool json_bool(const cJSON *json, const char *key, bool *out);

#ifdef __cplusplus
}
#endif

#endif /* KL_COMMANDS_H */
