#ifndef KL_TIME_H
#define KL_TIME_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

int64_t millis(void);

void delay_ms(uint64_t pause_time);

#ifdef __cplusplus
}
#endif

#endif /* KL_TIME_H */
