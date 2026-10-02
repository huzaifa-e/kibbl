#ifndef IC_LIGHT_H
#define IC_LIGHT_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

// false on a board without a flash led
bool light_setup(void);
bool light_available(void);

// 0 (off) to 100 (CONFIG_HM_LIGHT_MAX_PERCENT duty)
void light_set(uint8_t level);
uint8_t light_get(void);

#ifdef __cplusplus
}
#endif

#endif /* IC_LIGHT_H */
