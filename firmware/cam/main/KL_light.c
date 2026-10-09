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

void light_set(uint8_t level) {
    if (!available) {
        return;
    }
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
