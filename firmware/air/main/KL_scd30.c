#include "KL_scd30.h"

#include <stdio.h>
#include <string.h>

#include "KL_hw.h"
#include "KL_i2c.h"
#include "KL_serial.h"
#include "KL_time.h"

// Sensirion SCD30 interface description, I2C
#define CMD_START_MEASUREMENT 0x0010 // argument: ambient pressure in mbar, 0 = use the altitude
#define CMD_INTERVAL          0x4600
#define CMD_DATA_READY        0x0202
#define CMD_READ_MEASUREMENT  0x0300
#define CMD_ASC               0x5306
#define CMD_FRC               0x5204
#define CMD_ALTITUDE          0x5102
#define CMD_FIRMWARE          0xD100

#define READ_DELAY_MS  4    // between a command and its read, at least 3 ms
#define BOOT_DELAY_MS  2000 // the sensor needs up to 2 s after power up or a reset
#define MIN_CO2_PPM    100  // below: no measurement yet (0 ppm right after power up), outside air has 420

static bool found = false;
static char name[16] = "none";

/* ----------------------------------------------------------------------- */

static uint8_t crc8(const uint8_t *data, size_t len) {
    uint8_t crc = 0xff;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
        }
    }
    return crc;
}

static bool send_cmd(uint16_t cmd) {
    uint8_t data[2] = {cmd >> 8, cmd & 0xff};
    return i2c_bus_write(SCD30_ADDR, data, sizeof(data));
}

static bool send_cmd_arg(uint16_t cmd, uint16_t arg) {
    uint8_t data[5] = {cmd >> 8, cmd & 0xff, arg >> 8, arg & 0xff, 0};
    data[4]         = crc8(&data[2], 2);
    return i2c_bus_write(SCD30_ADDR, data, sizeof(data));
}

// count words of 2 bytes, each followed by its crc
static bool read_words(uint16_t cmd, uint16_t *words, size_t count) {
    uint8_t data[18];
    if (count * 3 > sizeof(data) || !send_cmd(cmd)) {
        return false;
    }
    delay_ms(READ_DELAY_MS);
    if (!i2c_bus_read(SCD30_ADDR, data, count * 3)) {
        return false;
    }
    for (size_t i = 0; i < count; i++) {
        if (crc8(&data[3 * i], 2) != data[3 * i + 2]) {
            DEBUG_ERROR("scd30: crc error\n");
            return false;
        }
        words[i] = (uint16_t)(data[3 * i] << 8) | data[3 * i + 1];
    }
    return true;
}

static float words_to_float(const uint16_t *words) {
    uint32_t bits = ((uint32_t)words[0] << 16) | words[1];
    float value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}

// writes a setting only when the sensor has another value: it keeps them in its flash
static bool set_if_changed(uint16_t cmd, uint16_t value) {
    uint16_t now = 0;
    if (read_words(cmd, &now, 1) && now == value) {
        return true;
    }
    DEBUG("scd30: 0x%04x %u -> %u\n", cmd, now, value);
    return send_cmd_arg(cmd, value);
}

/* ----------------------------------------------------------------------- */

bool scd30_setup(uint16_t altitude_m, bool asc) {
    // the sensor may still boot when the ESP is already running
    int64_t ready_at = BOOT_DELAY_MS;
    while (millis() < ready_at) {
        delay_ms(100);
    }

    if (!i2c_bus_probe(SCD30_ADDR)) {
        if (i2c_bus_probe(SCD4X_ADDR)) {
            DEBUG_F_ERROR("scd30: an SCD4x sensor found, not supported by this firmware\n");
        } else {
            DEBUG_F_ERROR("scd30: no sensor on the bus\n");
        }
        return false;
    }

    uint16_t version = 0;
    if (!read_words(CMD_FIRMWARE, &version, 1)) {
        DEBUG_F_ERROR("scd30: no answer\n");
        return false;
    }
    snprintf(name, sizeof(name), "SCD30 %u.%u", version >> 8, version & 0xff);

    bool ok = set_if_changed(CMD_INTERVAL, SCD30_INTERVAL_S) &&
              set_if_changed(CMD_ALTITUDE, altitude_m) &&
              set_if_changed(CMD_ASC, asc ? 1 : 0) &&
              send_cmd_arg(CMD_START_MEASUREMENT, 0);
    if (!ok) {
        DEBUG_F_ERROR("scd30: not configured\n");
        return false;
    }

    found = true;
    DEBUG_F("%s, every %d s, altitude %u m, asc %s\n", name, SCD30_INTERVAL_S, altitude_m, asc ? "on" : "off");
    return true;
}

const char *scd30_name(void) {
    return name;
}

bool scd30_read(scd30_values_t *values) {
    uint16_t ready = 0;
    if (!found || !read_words(CMD_DATA_READY, &ready, 1) || ready != 1) {
        return false;
    }

    uint16_t words[6];
    if (!read_words(CMD_READ_MEASUREMENT, words, 6)) {
        return false;
    }
    values->co2         = words_to_float(&words[0]);
    values->temperature = words_to_float(&words[2]);
    values->humidity    = words_to_float(&words[4]);
    /* the first ones after power up are 0 ppm: counted, the next real one rose by all of it
     * within a minute, with the board warming up as a fire (living room, 2026-10-10) */
    return values->co2 >= MIN_CO2_PPM;
}

bool scd30_set_altitude(uint16_t altitude_m) {
    return found && set_if_changed(CMD_ALTITUDE, altitude_m);
}

bool scd30_set_asc(bool enable) {
    return found && set_if_changed(CMD_ASC, enable ? 1 : 0);
}

bool scd30_force_calibration(uint16_t ppm) {
    if (!found || ppm < 400 || ppm > 2000) {
        return false;
    }
    DEBUG_F("scd30: forced recalibration to %u ppm\n", ppm);
    return send_cmd_arg(CMD_FRC, ppm);
}
