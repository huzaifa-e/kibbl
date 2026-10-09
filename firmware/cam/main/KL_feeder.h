#ifndef KL_FEEDER_H
#define KL_FEEDER_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "cJSON.h"

/*
 * The iris of a kibbl. feeder (hardware/feeder/iris), driven by a BTT S42B closed-loop
 * driver from STEP, DIR and EN: firmware/feeder-motor (the Arduino Nano it replaces) ported
 * to the ESP32-S3. Positions are motor steps from fully open (0) to the closed limit taught
 * under load (closedPos); the opening table of the design maps them to mm.
 */

// pins, the step timer, the stored settings and the position; false without a feeder
bool feeder_setup(void);

/* Runs cmd when it is a feeder command (docs/protocol.md: feed, iris, feeder_*) and
 * returns true; error stays NULL when it started. A move is answered as it starts, busy:
 * the telemetry follows the iris until it stands. */
bool feeder_command(const char *cmd, const cJSON *req, cJSON *resp, const char **error);

// the state as the app reads it ("feeder" of hello, telemetry and answers)
void feeder_add_state(cJSON *json);

// moving or feeding now
bool feeder_busy(void);

// stops the motor where it is (an update starts)
void feeder_stop(void);

// forgets the settings (factory reset); the position stays
void feeder_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_FEEDER_H */
