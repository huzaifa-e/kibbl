#ifndef IC_TIME_H
#define IC_TIME_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

int64_t millis(void);

void delay_ms(uint64_t pause_time);

#ifdef __cplusplus
}
#endif

#endif /* IC_TIME_H */
