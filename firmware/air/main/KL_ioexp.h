#ifndef KL_IOEXP_H
#define KL_IOEXP_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stdint.h>

#define LAMP_MASK_RED    (1 << 0) // EXP_RED_PIN ... EXP_WHITE_PIN of KL_hw.h
#define LAMP_MASK_GREEN  (1 << 1)
#define LAMP_MASK_YELLOW (1 << 2)
#define LAMP_MASK_WHITE  (1 << 3)

/* Finds the io expander (PCF8574A or PCA9554), reads whether it was just powered and
 * makes its pins outputs, the leds off. The expander keeps its state over a reset of the
 * ESP, so a fresh one means a real power cycle, not a restart or the watchdog. */
bool ioexp_setup(void);

// "PCF8574A", "PCA9554" or "none"
const char *ioexp_name(void);

// true when the board was powered up for this boot (the expander was fresh)
bool ioexp_power_on(void);

// the leds, LAMP_MASK_* bits; the other pins keep their state
void ioexp_set_lamp(uint8_t mask);

/* Feeds the external watchdog (MAX6371) from a task of its own: WDI toggles every
 * second. A firmware that hangs stops feeding it and the board resets. */
void ioexp_watchdog_start(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_IOEXP_H */
