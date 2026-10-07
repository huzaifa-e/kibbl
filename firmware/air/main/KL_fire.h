#ifndef KL_FIRE_H
#define KL_FIRE_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

/*
 * A possible fire from the air, as a warning next to a smoke alarm, never instead of one:
 * a certified one sees the smoke, which comes first. A fire makes CO2 and heat; the device
 * alarms when
 * - the CO2 rises by FIRE_CO2_RISE and the temperature by FIRE_TEMP_RISE within a minute
 *   (people and cigarettes raise the CO2, not the heat),
 * - the temperature rises by FIRE_TEMP_RATE per minute for two minutes (rate of rise, as
 *   heat detectors do), or
 * - the sensor reaches FIRE_TEMP_MAX (the board adds about 7 °C: the room is near 53 °C).
 * The alarm (red flashing, the buzzer) goes on also in night mode, a press of the button
 * silences it; it ends after FIRE_CLEAR_MS without any of it.
 */

#define FIRE_CO2_RISE  300.0f // ppm within a minute
#define FIRE_TEMP_RISE 1.0f   // °C within a minute, with the CO2
#define FIRE_TEMP_RATE 2.0f   // °C per minute, two minutes in a row
#define FIRE_TEMP_MAX  60.0f  // °C at the sensor
#define FIRE_CLEAR_MS  (5 * 60 * 1000)

/* one reading (every 2 s), the temperature as the sensor measures it. Pushes the event.
 * rates false: only the fixed temperature counts, the device was just moved (calibration:
 * carried in from the cold it warms fast) */
void fire_feed(float co2, float temperature, int64_t now_ms, bool rates);

bool fire_alarm(void);

// the button during an alarm: quiet, the light keeps flashing until it is over
void fire_silence(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_FIRE_H */
