#include "KL_strip.h"

#include <math.h>

#include "KL_hw.h"
#include "KL_serial.h"
#include "KL_status_led.h"

#define FRAME_MS      20   // 50 Hz while a fade or the breathing runs
#define SAVE_DELAY_MS 3000 // the light is stored once it stays for this long
#define GAMMA         2.2f
#define BLINK_ON_MS   200
#define BLINK_OFF_MS  200
#define WIFI_BLINKS   3
#define STATUS_LEVEL  0.3f // the blue of provisioning, the green of the joined Wi-Fi
#define BREATH_MS     2000

// the warm light at first power up (the warm of the app), so a flashed controller shows that it runs
static const light_t default_light = {true, 255, 165, 0, 100};

static const uint8_t pins[3] = {RED_PIN, GREEN_PIN, BLUE_PIN};

static light_t light;
static char order[4] = "rgb";
static uint32_t save_at = 0; // 0: nothing to store

// the fade, in levels of 0..1 as the eye sees them (before the gamma)
static float shown[3];
static float fade_from[3];
static float fade_to[3];
static uint32_t fade_start = 0;
static uint16_t fade_ms    = 0;
static bool redraw         = true;

// a pattern over the light: flashes of one colour, then back
static uint8_t flashes_left = 0;
static float flash_rgb[3];
static uint32_t flash_since = 0;

static bool updating             = false;
static status_led_state status   = LED_OFF;
static uint32_t last_frame       = 0;

/* ----------------------------------------------------------------------- */

static uint16_t duty(float level) {
    if (level <= 0) {
        return 0;
    }
    uint16_t d = (uint16_t)(powf(level > 1 ? 1 : level, GAMMA) * PWM_MAX + 0.5f);
    return d == 0 ? 1 : d; // the faintest light still shows
}

// red, green, blue as the eye sees them, onto the channels in the order of the strip's wires
static void output(const float rgb[3]) {
    static uint16_t last[3] = {0xffff, 0xffff, 0xffff};
    for (int i = 0; i < 3; i++) {
        uint16_t d = duty(rgb[strchr("rgb", order[i]) - "rgb"]);
        if (d != last[i]) {
            analogWrite(pins[i], d);
            last[i] = d;
        }
    }
}

static void output_color(float r, float g, float b) {
    const float rgb[3] = {r, g, b};
    output(rgb);
}

static void target_of(const light_t *l, float out[3]) {
    float scale = l->on ? l->brightness / 100.0f : 0;
    out[0]      = l->red / 255.0f * scale;
    out[1]      = l->green / 255.0f * scale;
    out[2]      = l->blue / 255.0f * scale;
}

static void start_flashes(uint8_t count, float r, float g, float b) {
    flashes_left = count;
    flash_rgb[0] = r;
    flash_rgb[1] = g;
    flash_rgb[2] = b;
    flash_since  = millis();
}

// the flashes as they go: false once they are over
static bool show_flashes(uint32_t now) {
    if (flashes_left == 0) {
        return false;
    }
    uint32_t t = now - flash_since;
    if (t >= BLINK_ON_MS + BLINK_OFF_MS) {
        flash_since = now;
        t           = 0;
        if (--flashes_left == 0) {
            redraw = true;
            return false;
        }
    }
    if (t < BLINK_ON_MS) {
        output(flash_rgb);
    } else {
        output_color(0, 0, 0);
    }
    return true;
}

static void show_breathing(uint32_t now) {
    light_t l = light;
    if (!l.on) {
        l.red = l.green = l.blue = 255; // white when it is off
    }
    l.on         = true;
    l.brightness = l.brightness < 30 ? 30 : l.brightness;
    float base[3];
    target_of(&l, base);
    float phase = (float)(now % BREATH_MS) / BREATH_MS;
    float scale = 0.2f + 0.8f * (0.5f - 0.5f * cosf(2 * (float)M_PI * phase));
    output_color(base[0] * scale, base[1] * scale, base[2] * scale);
}

static void show_light(uint32_t now) {
    float target[3];
    target_of(&light, target);
    if (memcmp(target, fade_to, sizeof(target)) != 0) {
        // a new light: faded from what shows now
        memcpy(fade_from, shown, sizeof(shown));
        memcpy(fade_to, target, sizeof(target));
        fade_start = now;
    }
    float progress = fade_ms == 0 ? 1 : (float)(now - fade_start) / fade_ms;
    if (progress >= 1) {
        if (memcmp(shown, fade_to, sizeof(shown)) == 0 && !redraw) {
            return; // nothing moves
        }
        memcpy(shown, fade_to, sizeof(shown));
    } else {
        for (int i = 0; i < 3; i++) {
            shown[i] = fade_from[i] + (fade_to[i] - fade_from[i]) * progress;
        }
    }
    redraw = false;
    output(shown);
}

/* ----------------------------------------------------------------------- */

void strip_setup(void) {
    if (!config_light(&light) || light.brightness < 1 || light.brightness > 100) {
        light = default_light;
    }
    strlcpy(order, config_order(), sizeof(order));
    if (strlen(order) != 3) {
        strlcpy(order, "rgb", sizeof(order));
    }

    analogWriteFreq(PWM_FREQ_HZ);
    analogWriteRange(PWM_MAX);
    for (int i = 0; i < 3; i++) {
        pinMode(pins[i], OUTPUT);
        analogWrite(pins[i], 0);
    }
    DEBUG("light %s, #%02x%02x%02x at %u %%, order %s\n", light.on ? "on" : "off", light.red, light.green, light.blue,
          light.brightness, order);
    fade_ms = 1000; // the light of before the power cut comes up softly
}

void strip_loop(void) {
    uint32_t now = millis();
    if (now - last_frame < FRAME_MS) {
        return;
    }
    last_frame = now;

    if (save_at != 0 && (int32_t)(now - save_at) >= 0) {
        save_at = 0;
        if (!config_set_light(&light)) {
            DEBUG_ERROR("light not stored\n");
        }
    }

    if (show_flashes(now)) {
        return;
    }
    if (updating) {
        show_breathing(now);
        return;
    }
    if (status == LED_SLOW) {
        // provisioning: waits for its network (the setup portal or serial)
        if (now % 1000 < 500) {
            output_color(0, 0, STATUS_LEVEL);
        } else {
            output_color(0, 0, 0);
        }
        redraw = true;
        return;
    }
    show_light(now);
}

void strip_light(light_t *out) {
    *out = light;
}

void strip_set(const light_t *l, uint16_t fade) {
    if (l->brightness < 1 || l->brightness > 100) {
        return;
    }
    light   = *l;
    fade_ms = fade > STRIP_FADE_MAX_MS ? STRIP_FADE_MAX_MS : fade;
    save_at = millis() + SAVE_DELAY_MS;
    if (save_at == 0) {
        save_at = 1;
    }
}

bool strip_set_order(const char *o) {
    if (o == NULL || strlen(o) != 3 || !strchr("rgb", o[0]) || !strchr("rgb", o[1]) || !strchr("rgb", o[2]) || o[0] == o[1] ||
        o[0] == o[2] || o[1] == o[2]) {
        return false;
    }
    strlcpy(order, o, sizeof(order));
    redraw = true; // shown again in the new order
    return config_set_order(order);
}

const char *strip_order(void) {
    return order;
}

void strip_blink(uint8_t count, uint8_t level) {
    float l = level / 100.0f;
    start_flashes(count, l, l, l);
}

void strip_set_updating(bool on) {
    updating = on;
    redraw   = true;
}

void strip_update_progress(void) {
    show_breathing(millis());
}

void set_status_led(status_led_state state) {
    status = state;
    redraw = true;
}

void status_led_wifi_connected(void) {
    // only after a setup: a router back in the night shows nothing behind the TV
    if (status == LED_SLOW) {
        status = LED_OFF;
        start_flashes(WIFI_BLINKS, 0, STATUS_LEVEL, 0);
        // the light comes back from dark
        memset(shown, 0, sizeof(shown));
        memset(fade_to, 0, sizeof(fade_to));
    }
}

/* ----------------------------------------------------------------------- */

void strip_to_json(JsonObject json) {
    json["on"]         = light.on;
    JsonArray color    = json["color"].to<JsonArray>();
    color.add(light.red);
    color.add(light.green);
    color.add(light.blue);
    json["brightness"] = light.brightness;
}

static bool int_in_range(JsonObjectConst json, const char *key, int min, int max, int *out) {
    JsonVariantConst v = json[key];
    if (v.isNull()) {
        return true; // left out, keeps its value
    }
    if (!v.is<int>() || v.as<int>() < min || v.as<int>() > max) {
        return false;
    }
    *out = v.as<int>();
    return true;
}

bool strip_from_json(JsonObjectConst json, light_t *l, uint16_t *fade) {
    int brightness = l->brightness;
    int fade_value = *fade;
    if (!int_in_range(json, "brightness", 1, 100, &brightness) || !int_in_range(json, "fadeMs", 0, STRIP_FADE_MAX_MS, &fade_value)) {
        return false;
    }
    JsonVariantConst on = json["on"];
    if (!on.isNull()) {
        if (!on.is<bool>()) {
            return false;
        }
        l->on = on.as<bool>();
    }
    JsonVariantConst color = json["color"];
    if (!color.isNull()) {
        JsonArrayConst rgb = color.as<JsonArrayConst>();
        if (rgb.isNull() || rgb.size() != 3) {
            return false;
        }
        int c[3];
        for (int i = 0; i < 3; i++) {
            if (!rgb[i].is<int>() || rgb[i].as<int>() < 0 || rgb[i].as<int>() > 255) {
                return false;
            }
            c[i] = rgb[i].as<int>();
        }
        l->red   = c[0];
        l->green = c[1];
        l->blue  = c[2];
    }
    l->brightness = brightness;
    *fade         = fade_value;
    return true;
}
