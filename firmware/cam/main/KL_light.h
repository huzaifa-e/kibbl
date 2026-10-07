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

#ifdef __cplusplus
}
#endif

#endif /* KL_LIGHT_H */
