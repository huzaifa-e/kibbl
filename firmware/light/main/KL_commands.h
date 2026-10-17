#ifndef KL_COMMANDS_H
#define KL_COMMANDS_H

#include <Arduino.h>
#include <ArduinoJson.h>

typedef enum {
    CMD_SOURCE_SERIAL = 0, // the uart: someone holds the device
    CMD_SOURCE_SERVER,     // the authenticated server connection
} cmd_source_t;

/* Runs one {"cmd":"..."} request into resp, as kibbl_core's commands_handle(): {"ok":true}
 * with the command's data, or {"ok":false,"error":"..."}; an "id" in the request is copied
 * into it. The server url is taken from the serial port only; Wi-Fi from the server switches
 * with a fallback (docs/protocol.md). Commands the core does not know go to product_command(). */
void commands_handle(JsonObjectConst req, JsonDocument &resp, cmd_source_t source);

// the device as the hello message and {"cmd":"info"} describe it
void commands_add_info(JsonObject json, cmd_source_t source);

// restarts in 1 s, so the response to the command still goes out
void restart_later(void);

// the serial requests and the restart; from the loop
void commands_loop(void);

/*
 * Field checks for the commands of the core and of the product
 */

// true and *out set when key is a number in min..max, true and *out kept when key is left out
bool json_int_in_range(JsonObjectConst json, const char *key, int min, int max, int *out);

#endif /* KL_COMMANDS_H */
