#ifndef KL_PRINTER_H
#define KL_PRINTER_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "cJSON.h"

/*
 * A 3D printer on the home network (Bambu Lab: X1, P1, A1), read and steered for the server
 * (docs/printer.md). The printer speaks MQTT over TLS on port 8883, user bblp with the access
 * code of its screen; this device logs into it like the slicer does and passes its state on
 * in its own telemetry, so the server needs no way into the home network. Built in with
 * CONFIG_KIBBL_PRINTER.
 */

// the stored printer and its connection; nothing runs before one was set
void printer_setup(void);

/* Runs cmd when it is a printer command (printer_config, printer) and returns true; error
 * stays NULL on success */
bool printer_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error);

// the state as the app reads it ("printer" of hello, telemetry and answers)
void printer_add_state(cJSON *json);

// an update starts: the connection and its memory go
void printer_stop(void);

// forgets the printer (factory reset)
void printer_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_PRINTER_H */
