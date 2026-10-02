#include "IC_light.h"

#include "driver/ledc.h"

#include "IC_hm_hw.h"
#include "IC_serial.h"

#define LIGHT_FREQ_HZ  5000
#define LIGHT_DUTY_RES LEDC_TIMER_8_BIT
#define LIGHT_DUTY_MAX 255

static bool available = false;
static uint8_t level_now = 0;

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
    };
    if (ledc_timer_config(&timer) != ESP_OK || ledc_channel_config(&channel) != ESP_OK) {
        DEBUG_F_ERROR("flash led pwm not set up\n");
        return false;
    }

    available = true;
    return true;
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
    uint32_t duty = (uint32_t)LIGHT_DUTY_MAX * level * CONFIG_HM_LIGHT_MAX_PERCENT / (100 * 100);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, LIGHT_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, LIGHT_CHANNEL);
    level_now = level;
    DEBUG("light: level %u, duty %lu\n", level, (unsigned long)duty);
}

uint8_t light_get(void) {
    return level_now;
}
