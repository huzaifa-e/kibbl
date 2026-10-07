#ifndef KL_BUTTON_H
#define KL_BUTTON_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#define BUTTON_RESET_HOLD_MS 10000 // held this long: the wifi is forgotten

/* The button on the side, read by a task of its own. A short press calls on_press; held
 * for 10 s it forgets the wifi and restarts into provisioning (the Conny has no USB
 * port for the setup in the app). */
void button_setup(void (*on_press)(void));

#ifdef __cplusplus
}
#endif

#endif /* KL_BUTTON_H */
