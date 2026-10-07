#ifndef KL_I2C_H
#define KL_I2C_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* The one I2C bus of the board (sensor and io expander). Every call takes the bus for
 * itself, so the tasks of both never interleave on it. */
bool i2c_bus_setup(void);

// true when a device acknowledges addr
bool i2c_bus_probe(uint8_t addr);

bool i2c_bus_write(uint8_t addr, const uint8_t *data, size_t len);
bool i2c_bus_read(uint8_t addr, uint8_t *data, size_t len);

// one register write and one register read (the expander)
bool i2c_bus_write_reg(uint8_t addr, uint8_t reg, uint8_t value);
bool i2c_bus_read_reg(uint8_t addr, uint8_t reg, uint8_t *value);

#ifdef __cplusplus
}
#endif

#endif /* KL_I2C_H */
