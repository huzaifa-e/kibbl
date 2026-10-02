#ifndef IC_OTA_H
#define IC_OTA_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

/* Downloads the image at url into the other slot in a task of its own and restarts
 * into it. False when an update already runs or the task could not start. */
bool ota_start(const char *url);

bool ota_running(void);

/* A new image starts unconfirmed: confirmed once the server was reached, it stays;
 * reset before, the bootloader goes back to the previous one. */
void ota_confirm_image(void);

#ifdef __cplusplus
}
#endif

#endif /* IC_OTA_H */
