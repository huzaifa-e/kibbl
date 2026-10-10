#ifndef KL_SCD30_H
#define KL_SCD30_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#define SCD30_INTERVAL_S 2 // the shortest measurement interval of the sensor

typedef struct {
    float co2;         // ppm
    float temperature; // °C, as the sensor measures it (warmed by the board)
    float humidity;    // %RH
} scd30_values_t;

/* Finds the sensor, sets the interval and the altitude and starts the continuous
 * measurement; settings the sensor already has are not written again (they are kept
 * in its flash). False when no SCD30 answers. */
bool scd30_setup(uint16_t altitude_m, bool asc);

// "SCD30 3.66": the sensor and its firmware, "none" before scd30_setup()
const char *scd30_name(void);

// true and values set when a new measurement was ready (not the 0 ppm ones after power up)
bool scd30_read(scd30_values_t *values);

bool scd30_set_altitude(uint16_t altitude_m);
bool scd30_set_asc(bool enable);

/* Forced recalibration: the sensor takes its current reading as ppm (400-2000). It
 * must have run at a steady known concentration (fresh air outside: ~420 ppm) for
 * at least 2 minutes before. */
bool scd30_force_calibration(uint16_t ppm);

#ifdef __cplusplus
}
#endif

#endif /* KL_SCD30_H */
