#ifndef KL_FAN_H
#define KL_FAN_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#include "KL_air_config.h"
#include "KL_lamp.h"

bool fan_setup(void);

// mode, level, the pulse times and the thresholds (auto) of the settings; takes effect at once
void fan_configure(const air_settings_t *settings);

// the air level and the CO2 (ppm, mean), for the auto mode
void fan_set_air(air_level_t level, uint16_t co2);

// night mode: the fan runs at most at cap % (0: off); 100 lifts it
void fan_set_cap(uint8_t cap);

// the quiet speed (config_fan_quiet): the lowest auto runs at
void fan_set_quiet(uint8_t percent);

// the pwm the fan runs at now, 0 when it is off
uint8_t fan_level_now(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_FAN_H */
