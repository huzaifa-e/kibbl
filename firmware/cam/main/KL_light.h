#ifndef KL_LIGHT_H
#define KL_LIGHT_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

// false on a board without a flash led
bool light_setup(void);
bool light_available(void);

// 0 (off) to 100 (CONFIG_KIBBL_LIGHT_MAX_PERCENT duty)
void light_set(uint8_t level);
uint8_t light_get(void);

/* Flashes the light count times at level, then goes back to the level it had; runs on
 * a timer, so it returns at once. A light_set() meanwhile ends the flashing. */
void light_blink(uint8_t count, uint8_t level);
/* The light by itself (CAM_AUTO_LIGHT), fed the brightness of the middle of every frame:
 * on when something comes close and darkens it, off when it is gone. While it checks with
 * the light off for a moment, the frames are not to be shown: it returns false for them. */
bool light_auto(uint8_t middle_luma);

#ifdef __cplusplus
}
#endif

#endif /* KL_LIGHT_H */
