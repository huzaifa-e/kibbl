#ifndef KL_RECOVERY_H
#define KL_RECOVERY_H

#include <Arduino.h>

/*
 * The ESP8266 keeps no image to go back to after an update. Instead an image that crashes
 * RECOVERY_CRASHES times in a row before reaching the server starts in safe mode: only the
 * Wi-Fi, the server link and updates run, the strip stays dark, so a fixed image can always
 * be sent over the air. The count lives in the RTC memory, which survives a reset.
 */

#define RECOVERY_CRASHES 3

// first thing in setup(): counts a crash reset, decides about safe mode
void recovery_boot_check(void);

bool recovery_active(void);

// the server was reached: the image works, the count starts again
void recovery_confirm(void);

#endif /* KL_RECOVERY_H */
