#ifndef KL_SMOKE_H
#define KL_SMOKE_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

/*
 * Cigarettes from the CO2 alone, roughly: exhaled smoke is breath with about 4 % CO2.
 * Smoked within 1-2 m of the device, every puff is a short spike: hundreds of ppm above
 * the room within seconds, back down within a minute. People in the room raise the CO2
 * slowly and for long, so a rise that stays is no puff. Three puffs or more with less
 * than SMOKE_SESSION_GAP_MS between them are one cigarette.
 *
 * Smoked farther away it is not seen, and someone breathing straight at the sensor can
 * look like a puff: the button logs a cigarette for sure, and the cigarettes the
 * detector found with a press of the button in them tell how well it does.
 */

#define SMOKE_SESSION_GAP_MS (4 * 60 * 1000)
#define SMOKE_MIN_PUFFS      3

// one CO2 reading (every 2 s); puff_rise in ppm above the baseline. Pushes the events
void smoke_feed(float co2, uint16_t puff_rise, int64_t now_ms);

// the button logged a cigarette: the one the detector finds around it is marked
void smoke_button(int64_t now_ms);

// forgets the baseline and a cigarette going on: the device was moved (calibration)
void smoke_reset(void);

// puffs of the cigarette going on now, 0 when none
uint8_t smoke_puffs_now(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_SMOKE_H */
