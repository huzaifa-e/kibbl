#ifndef KL_STRIP_H
#define KL_STRIP_H

#include <Arduino.h>
#include <ArduinoJson.h>

#include "KL_config.h"

/*
 * The analog RGB strip: one colour for the whole strip, run from the loop. What it shows,
 * first that applies: blinks (find the device), a running update, provisioning and the
 * three blinks of the Wi-Fi joined after it, then the light as it was set. A change of the
 * light fades over its fade time, as the eye sees it (gamma). The light is stored a few
 * seconds after it last changed and comes back after a power cut.
 */

#define STRIP_FADE_MS     400 // a change from the app without its own fade time
#define STRIP_FADE_MAX_MS 10000

// the stored light, faded in from dark
void strip_setup(void);

// fades, patterns and storing; from the loop, as often as it turns
void strip_loop(void);

void strip_light(light_t *out);

// what the strip shows from now on, faded over fade_ms (0 switches)
void strip_set(const light_t *light, uint16_t fade_ms);

/* The strip's wires in another order than the board's red, green and blue: "rgb" (the
 * board's), "grb", "brg" ... each letter the colour the strip shows on that channel.
 * Stored at once; false for anything else. */
bool strip_set_order(const char *order);
const char *strip_order(void);

/* Vivid colours: the gamma on the brightness only, so mixed colours (warm, white) give the
 * strip's full light; natural: on every channel, the hues as the eye expects them. Stored. */
bool strip_set_vivid(bool vivid);
bool strip_vivid(void);

// count white flashes at level % (find the device), then back to the light
void strip_blink(uint8_t count, uint8_t level);

// an update runs: the light breathes; strip_loop() is not called while it downloads
void strip_set_updating(bool updating);
void strip_update_progress(void);

// the light as on, color [r, g, b], brightness and vivid, for the hello, telemetry and responses
void strip_to_json(JsonObject json);

/* The keys present of {"on", "color", "brightness"} on top of light; false when one is out
 * of range. fade_ms gets "fadeMs" when it is given. */
bool strip_from_json(JsonObjectConst json, light_t *light, uint16_t *fade_ms);

#endif /* KL_STRIP_H */
