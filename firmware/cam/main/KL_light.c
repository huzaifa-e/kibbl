#include "KL_light.h"

#include "driver/ledc.h"
#include "esp_timer.h"

#include "KL_hw.h"
#include "KL_serial.h"

#define LIGHT_FREQ_HZ  5000
#define LIGHT_DUTY_RES LEDC_TIMER_8_BIT
#define LIGHT_DUTY_MAX 255
#define BLINK_ON_MS    80
#define BLINK_OFF_MS   120

static bool available = false;
static uint8_t level_now = 0;

static esp_timer_handle_t blink_timer = NULL;
static volatile uint8_t blink_steps = 0; // on and off steps still to go
static uint8_t blink_level = 0;

static void write_level(uint8_t level) {
    uint32_t duty = (uint32_t)LIGHT_DUTY_MAX * level * CONFIG_KIBBL_LIGHT_MAX_PERCENT / (100 * 100);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LIGHT_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LIGHT_CHANNEL);
}

// one step of a blink: off after on, on after off; the level the light had at the end
static void blink_cb(void *arg) {
    if (blink_steps > 0) {
        blink_steps--;
    }
    if (blink_steps == 0) {
        write_level(level_now);
        return;
    }
    bool on = blink_steps % 2 == 0;
    write_level(on ? blink_level : 0);
    esp_timer_start_once(blink_timer, (on ? BLINK_ON_MS : BLINK_OFF_MS) * 1000);
}

bool light_setup(void) {
    if (LIGHT_PIN < 0) {
        return false;
    }

    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .duty_resolution = LIGHT_DUTY_RES,
        .timer_num       = LIGHT_TIMER,
        .freq_hz         = LIGHT_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ledc_channel_config_t channel = {
        .gpio_num   = LIGHT_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = LIGHT_CHANNEL,
        .timer_sel  = LIGHT_TIMER,
        .duty       = 0,
        .hpoint     = 0,
#ifdef LIGHT_ACTIVE_LOW
        .flags.output_invert = LIGHT_ACTIVE_LOW, // on while the pin is low (a P-MOSFET)
#endif
    };
    if (ledc_timer_config(&timer) != ESP_OK || ledc_channel_config(&channel) != ESP_OK) {
        DEBUG_F_ERROR("flash led pwm not set up\n");
        return false;
    }

    const esp_timer_create_args_t args = {
        .callback = blink_cb,
        .name     = "light_blink",
    };
    esp_timer_create(&args, &blink_timer);

    available = true;
    return true;
}

void light_blink(uint8_t count, uint8_t level) {
    if (!available || count == 0) {
        return;
    }
    esp_timer_stop(blink_timer);
    blink_level = level > 100 ? 100 : level;
    blink_steps = 2 * count; // even: on, odd: off
    write_level(blink_level);
    esp_timer_start_once(blink_timer, BLINK_ON_MS * 1000);
}

bool light_available(void) {
    return available;
}

/* ----------------------------------------------------------------------- */
/* The light by itself. Something very close covers the camera: the middle of the frame goes
 * dark, the light goes on. Lit, a close thing is bright; the light reaches nothing far, so a
 * middle still dark with it on means nothing is close (night): off, and it waits until the
 * scene was brighter again. Every few seconds it looks with the light off for a moment: the
 * middle no longer dark means the thing is gone. A level set in the app wins: on stays on,
 * off keeps the automatic out for a minute. */

#if CAM_AUTO_LIGHT
#define AUTO_LEVEL       100
#define AUTO_DARK        CAM_AUTO_LIGHT_DARK
#define AUTO_SETTLE_MS   1500  // exposure follows the light
#define AUTO_CHECK_EVERY 8000
#define AUTO_CHECK_MS    500   // the light off this long before it looks
#define AUTO_QUIET_MS    60000 // after the light was switched off in the app

typedef enum { AUTO_WATCHING = 0, AUTO_LIT, AUTO_CHECKING, AUTO_RESTING } auto_state_t;

static auto_state_t auto_state = AUTO_WATCHING;
static bool manual_on          = false;
static uint8_t auto_count      = 0;
static int64_t auto_since_ms, auto_next_check_ms, auto_quiet_until_ms;

static int64_t now_ms(void) {
    return esp_timer_get_time() / 1000;
}

static void auto_level(uint8_t level) {
    write_level(level);
    level_now = level;
}

#endif

bool light_auto(uint8_t luma) {
#if CAM_AUTO_LIGHT
    if (!available || manual_on || blink_steps > 0) {
        return true;
    }
    int64_t now = now_ms();
    switch (auto_state) {
    case AUTO_WATCHING:
        if (now < auto_quiet_until_ms) {
            return true;
        }
        auto_count = luma < AUTO_DARK ? auto_count + 1 : 0;
        if (auto_count >= 3) {
            auto_level(AUTO_LEVEL);
            auto_state         = AUTO_LIT;
            auto_since_ms      = now;
            auto_next_check_ms = now + AUTO_CHECK_EVERY;
            auto_count         = 0;
            DEBUG("light: on by itself, something close (middle %u)\n", luma);
        }
        return true;
    case AUTO_LIT:
        if (now - auto_since_ms < AUTO_SETTLE_MS) {
            return true;
        }
        auto_count = luma < AUTO_DARK + 10 ? auto_count + 1 : 0;
        if (auto_count >= 6) {
            auto_level(0);
            auto_state = AUTO_RESTING;
            auto_count = 0;
            DEBUG("light: off, it lights nothing close (middle %u)\n", luma);
        } else if (now >= auto_next_check_ms) {
            auto_level(0);
            auto_state    = AUTO_CHECKING;
            auto_since_ms = now;
        }
        return true;
    case AUTO_CHECKING:
        if (now - auto_since_ms < AUTO_CHECK_MS) {
            return false;
        }
        if (luma >= AUTO_DARK + 15) {
            auto_state = AUTO_WATCHING;
            auto_count = 0;
            DEBUG("light: off, nothing close any more (middle %u)\n", luma);
        } else {
            auto_level(AUTO_LEVEL);
            auto_state         = AUTO_LIT;
            auto_since_ms      = now;
            auto_next_check_ms = now + AUTO_CHECK_EVERY;
        }
        return false;
    case AUTO_RESTING:
        if (luma >= AUTO_DARK + 25) {
            auto_state = AUTO_WATCHING;
            auto_count = 0;
        }
        return true;
    }
#else
    (void)luma;
#endif
    return true;
}

/* ----------------------------------------------------------------------- */

void light_set(uint8_t level) {
    if (!available) {
        return;
    }
#if CAM_AUTO_LIGHT
    // set in the app: on stays on, off keeps the automatic out for a while
    bool was_auto = auto_state == AUTO_LIT || auto_state == AUTO_CHECKING;
    manual_on     = level > 0;
    auto_state    = AUTO_WATCHING;
    auto_count    = 0;
    if (level == 0 && was_auto) {
        auto_quiet_until_ms = now_ms() + AUTO_QUIET_MS;
    }
#endif
    if (level > 100) {
        level = 100;
    }
    if (blink_timer != NULL) {
        esp_timer_stop(blink_timer); // a set level ends a blink
        blink_steps = 0;
    }
    write_level(level);
    level_now = level;
    DEBUG("light: level %u\n", level);
}

uint8_t light_get(void) {
    return level_now;
}
