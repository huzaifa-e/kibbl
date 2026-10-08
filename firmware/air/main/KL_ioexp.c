#include "KL_ioexp.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

#include "KL_hw.h"
#include "KL_i2c.h"
#include "KL_serial.h"
#include "KL_time.h"

#define WATCHDOG_STACK_SIZE 2048
#define WATCHDOG_FEED_MS    1000

#define PCA9554_REG_INPUT  0
#define PCA9554_REG_OUTPUT 1
#define PCA9554_REG_CONFIG 3 // 1 = input, all inputs at power up

#define LAMP_PINS (LAMP_MASK_RED | LAMP_MASK_GREEN | LAMP_MASK_YELLOW | LAMP_MASK_WHITE)

typedef enum {
    EXP_NONE = 0,
    EXP_PCF8574A,
    EXP_PCA9554, // also the PCA9554A, the same chip at 0x38 like the PCF8574A
} expander_t;

static expander_t expander = EXP_NONE;
static uint8_t pca_addr    = PCA9554_ADDR;
static bool power_on       = false;

static SemaphoreHandle_t out_mutex;
static uint8_t out_state = 1 << EXP_WATCHDOG_PIN; // leds off, the boot flags low

/* ----------------------------------------------------------------------- */

static bool write_outputs(uint8_t state) {
    switch (expander) {
    case EXP_PCF8574A:
        // quasi-bidirectional: a 1 is a weak pull-up, enough for the led driver transistors
        return i2c_bus_write(PCF8574A_ADDR, &state, 1);
    case EXP_PCA9554:
        return i2c_bus_write_reg(pca_addr, PCA9554_REG_OUTPUT, state);
    default:
        return false;
    }
}

static void update_outputs(uint8_t mask, uint8_t value) {
    xSemaphoreTake(out_mutex, portMAX_DELAY);
    out_state = (out_state & ~mask) | (value & mask);
    if (!write_outputs(out_state)) {
        DEBUG_ERROR("io expander not written\n");
    }
    xSemaphoreGive(out_mutex);
}

static void setup_pca9554(uint8_t addr) {
    uint8_t config = 0;
    expander       = EXP_PCA9554;
    pca_addr       = addr;
    // all pins inputs after power up; this firmware makes them outputs
    power_on = i2c_bus_read_reg(addr, PCA9554_REG_CONFIG, &config) && config == 0xff;
    if (!write_outputs(out_state) || !i2c_bus_write_reg(addr, PCA9554_REG_CONFIG, 0x00)) {
        DEBUG_F_ERROR("PCA9554 not configured\n");
    }
}

bool ioexp_setup(void) {
    out_mutex = xSemaphoreCreateMutex();

    if (i2c_bus_probe(PCF8574A_ADDR)) {
        /* 0x38 is a PCF8574A or a PCA9554A. The PCF8574A takes the byte of the outputs alone;
         * the PCA9554A reads it as a register and refuses one above 3, as the outputs with the
         * watchdog pin high are. Before the read: it gives the power up state of the pins. */
        uint8_t pins = 0;
        bool read    = i2c_bus_read(PCF8574A_ADDR, &pins, 1);
        expander     = EXP_PCF8574A;
        if (write_outputs(out_state)) {
            // all pins high after power up; this firmware drives the boot flag low
            power_on = read && (pins & (1 << EXP_POWER_ON_PIN));
        } else {
            setup_pca9554(PCF8574A_ADDR);
        }
    } else if (i2c_bus_probe(PCA9554_ADDR)) {
        setup_pca9554(PCA9554_ADDR);
    } else {
        DEBUG_F_ERROR("no io expander on the bus: no leds, no watchdog feed\n");
        return false;
    }

    update_outputs(0xff, out_state);
    DEBUG_F("io expander %s, %s\n", ioexp_name(), power_on ? "power on" : "restart");
    return true;
}

const char *ioexp_name(void) {
    switch (expander) {
    case EXP_PCF8574A:
        return "PCF8574A";
    case EXP_PCA9554:
        return pca_addr == PCA9554_ADDR ? "PCA9554" : "PCA9554A";
    default:
        return "none";
    }
}

bool ioexp_power_on(void) {
    return power_on;
}

void ioexp_set_lamp(uint8_t mask) {
    if (expander == EXP_NONE) {
        return;
    }
    update_outputs(LAMP_PINS, mask);
}

/* ----------------------------------------------------------------------- */

static void watchdog_task(void *pvParams) {
    uint8_t wdi = 0;
    while (1) {
        wdi ^= 1 << EXP_WATCHDOG_PIN;
        update_outputs(1 << EXP_WATCHDOG_PIN, wdi);
        delay_ms(WATCHDOG_FEED_MS);
    }
}

void ioexp_watchdog_start(void) {
    if (expander == EXP_NONE) {
        return;
    }
    // above the other tasks: a busy network or ota must not starve it
    xTaskCreate(watchdog_task, "watchdog", WATCHDOG_STACK_SIZE, NULL, 6, NULL);
}
