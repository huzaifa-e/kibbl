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
 * People leaving lower the CO2 too, but slowly. Compared are 30 s means over the last
 * WINDOW_SPAN_MS; closed again when the temperature or the CO2 rise.
 */

#define WINDOW_SPAN_MS  (3 * 60 * 1000)
#define OUTDOOR_CO2_PPM 420

// one reading (every 2 s); temperature as the sensor measures it. Pushes the events
void window_feed(float co2, float temperature, int64_t now_ms);

bool window_open(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_WINDOW_H */
