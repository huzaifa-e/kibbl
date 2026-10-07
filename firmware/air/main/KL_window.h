#ifndef KL_WINDOW_H
#define KL_WINDOW_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

/*
 * An open window from the air: outside air has about 420 ppm, so the CO2 of the room
 * falls fast towards it, and in the heating season the temperature falls with it.
 * People leaving lower the CO2 too, but slowly. In a room that is fresh already the CO2
 * cannot fall much: then a fast fall of the temperature alone counts (heating going off
 * or the sun going away cool a room far slower), unless the lamp or the fan changed and
 * the board cools the sensor. Compared are 30 s means over the last WINDOW_SPAN_MS;
 * closed again when the temperature or the CO2 rise. A window that was open before the
 * device measured is not seen: it notices the opening.
 */

#define WINDOW_SPAN_MS  (3 * 60 * 1000)
#define OUTDOOR_CO2_PPM 420

// one reading (every 2 s); temperature as the sensor measures it. Pushes the events
void window_feed(float co2, float temperature, int64_t now_ms);

bool window_open(void);

// "open", "closed", "learning" (less than WINDOW_SPAN_MS of readings) or "paused"
const char *window_state(bool detecting);

// the lamp or the fan changed: the warmth of the board moves the temperature a while
void window_heat_changed(int64_t now_ms);

// forgets the means: the device was moved (calibration), they compare other air
void window_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_WINDOW_H */
