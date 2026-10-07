#ifndef KL_PRODUCT_H
#define KL_PRODUCT_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "cJSON.h"

#include "KL_commands.h"

/*
 * What a product adds to the shared core (docs/protocol.md): every firmware (cam/, air/)
 * implements these once in its main component, the core calls them.
 */

// FW_VERSION of the product's BUILD_INFO.h
const char *product_fw_version(void);

/* model, board, caps and the product's state for the hello and {"cmd":"info"}; the core
 * adds the network, uptime and heap. caps lists everything, "ota" included. */
void product_add_info(cJSON *json, cmd_source_t source);

/* Runs cmd when it is one of the product's commands and returns true; error stays NULL
 * on success. False: not the product's, the core answers "unknown cmd". */
bool product_command(const char *cmd, const cJSON *req, cJSON *resp, cmd_source_t source, const char **error);

// the product's fields of the telemetry message, sent every 10 s
void product_add_telemetry(cJSON *json);

/* Called from the stream task between the commands, also while not connected. True
 * when it did or waits for work (sending a frame), false when idle: the stream task
 * then waits for the next command. */
bool product_stream_work(bool connected);

// the server connection is gone: stop what was sent for it
void product_stream_disconnected(void);

// an update starts: free the link, the memory and the flash for the download
void product_ota_prepare(void);

// factory reset: forget the product's settings (the core forgets its own and the wifi)
void product_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_PRODUCT_H */
