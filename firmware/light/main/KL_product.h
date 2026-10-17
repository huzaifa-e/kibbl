#ifndef KL_PRODUCT_H
#define KL_PRODUCT_H

#include <Arduino.h>
#include <ArduinoJson.h>

#include "KL_commands.h"

/*
 * What the product adds to the core part of this firmware, as kibbl_core's KL_product.h
 */

// FW_VERSION of BUILD_INFO.h
const char *product_fw_version(void);

// model, board, caps and the product's state for the hello and {"cmd":"info"}
void product_add_info(JsonObject json, cmd_source_t source);

/* Runs cmd when it is one of the product's commands and returns true; error stays NULL
 * on success. False: not the product's, the core answers "unknown cmd". */
bool product_command(const char *cmd, JsonObjectConst req, JsonDocument &resp, cmd_source_t source, const char **error);

// the product's fields of the telemetry message, sent every 10 s
void product_add_telemetry(JsonObject json);

// an update starts, and how far it is
void product_ota_prepare(void);
void product_ota_progress(int done, int total);

// factory reset: forget the product's settings (the core forgets its own and the wifi)
void product_reset(void);

#endif /* KL_PRODUCT_H */
