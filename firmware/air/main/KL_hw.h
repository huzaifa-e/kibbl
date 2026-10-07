#ifndef KL_HW_H
#define KL_HW_H

#ifdef __cplusplus
extern "C" {
#endif

#include "sdkconfig.h"

// the product this firmware makes of the board; the app shows it by this id (shared/protocol.ts)
#define PRODUCT_MODEL "kibbl-air"

// Conny CO2 traffic light, ISIS IC EHW0001-0013 (hardware repo CO2-Ampel_EHW)
#define BOARD_NAME "conny-ehw0001-0013"

/*
 * LEDC (=PWM) CHANNELS:
 */
// for the fan
#define FAN_CHANNEL LEDC_CHANNEL_0
#define FAN_TIMER   LEDC_TIMER_0
// for the buzzer
#define BUZZER_CHANNEL LEDC_CHANNEL_1
#define BUZZER_TIMER   LEDC_TIMER_1

/*
 * GPIO
 */
#define I2C_SDA_PIN 4  // 10k pull-up on the board
#define I2C_SCL_PIN 5  // 10k pull-up on the board
#define FAN_PIN     6  // NPN low side switch, the fan on 5V
#define BUZZER_PIN  10 // magnetic buzzer behind an NPN
#define BUTTON_PIN  18 // pulls to gnd, 10k pull-up; the D- pad of the USB-Serial-JTAG

/*
 * I2C: the CO2 sensor and the io expander share one bus. The SCD30 allows at most
 * 100 kHz and stretches the clock for up to 12 ms.
 */
#define I2C_PORT    I2C_NUM_0
#define I2C_FREQ_HZ 100000 // as ESW0002; fine steps for the fade of the lamp

#define SCD30_ADDR    0x61
#define SCD4X_ADDR    0x62 // the SCD41 of other Conny builds, not supported yet
#define PCF8574A_ADDR 0x38 // io expander of the BOM variants 13a-e, A0-A2 to gnd
#define PCA9554_ADDR  0x20 // io expander of the EDB variant

/*
 * Pins of the io expander
 */
#define EXP_RED_PIN      0 // the leds run on constant current drivers: on or off, no brightness
#define EXP_GREEN_PIN    1
#define EXP_YELLOW_PIN   2
#define EXP_WHITE_PIN    3
#define EXP_WATCHDOG_PIN 4 // WDI of the MAX6371; WDO resets the ESP. Off while WD_BASE is grounded (programmer)
#define EXP_POWER_ON_PIN 5 // P5-P7: on the IO_EXTRA header only, used as a boot flag

#ifdef __cplusplus
}
#endif

#endif /* KL_HW_H */
