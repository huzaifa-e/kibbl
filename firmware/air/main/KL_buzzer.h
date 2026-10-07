#ifndef KL_BUZZER_H
#define KL_BUZZER_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

typedef enum {
    TONE_BUTTON = 0,
    TONE_YELLOW,
    TONE_RED,
    TONE_CALIBRATE_START,
    TONE_CALIBRATE_END,
    TONE_LOGGED, // a cigarette logged with the button
} buzzer_tone_t;

bool buzzer_setup(void);

/* Plays the tone on a timer, so it returns at once; a new tone replaces one that
 * still plays. The tones are the ones of ESW0002. */
void buzzer_play(buzzer_tone_t tone);

// night mode: no tone plays while muted
void buzzer_set_muted(bool muted);

#ifdef __cplusplus
}
#endif

#endif /* KL_BUZZER_H */
