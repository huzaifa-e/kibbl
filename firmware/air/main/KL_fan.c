#include "KL_fan.h"

#include "driver/ledc.h"
#include "esp_timer.h"

#include "KL_hw.h"
#include "KL_serial.h"

#define FAN_FREQ_HZ  25000 // above hearing, as for pc fans
#define FAN_DUTY_RES LEDC_TIMER_8_BIT
#define FAN_DUTY_MAX 255
#define FAN_TICK_US  (1000 * 1000)

static bool available = false;

static volatile uint8_t mode       = FAN_MODE_ON;
static volatile uint8_t level      = 100;
static volatile uint16_t on_s      = 60;
static volatile uint16_t off_s     = 240;
static volatile air_level_t air    = AIR_LEVEL_NONE;
static volatile uint8_t level_now  = 0;
static volatile uint8_t cap        = 100;

static esp_timer_handle_t tick_timer = NULL;
static uint32_t pulse_s = 0; // seconds into the current pulse cycle

static void write_level(uint8_t value) {
    if (value == level_now) {
        return;
    }
    // full on without pwm: the fan gets a clean supply
    uint32_t duty = value >= 100 ? FAN_DUTY_MAX + 1 : (uint32_t)FAN_DUTY_MAX * value / 100;
    ledc_set_duty(LEDC_LOW_SPEED_MODE, FAN_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, FAN_CHANNEL);
    level_now = value;
    DEBUG("fan: %u %%\n", value);
}

static void update(void) {
    bool on = false;
    switch (mode) {
    case FAN_MODE_ON:
        on = true;
        break;
    case FAN_MODE_PULSE:
        on = pulse_s < on_s;
        break;
    case FAN_MODE_AUTO:
        on = air == AIR_LEVEL_YELLOW || air == AIR_LEVEL_RED;
        break;
    default:
        break;
    }
    write_level(on ? (level < cap ? level : cap) : 0);
}

static void tick_cb(void *arg) {
    pulse_s = (pulse_s + 1) % (on_s + off_s);
    update();
}

bool fan_setup(void) {
    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .duty_resolution = FAN_DUTY_RES,
        .timer_num       = FAN_TIMER,
        .freq_hz         = FAN_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ledc_channel_config_t channel = {
        .gpio_num   = FAN_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = FAN_CHANNEL,
        .timer_sel  = FAN_TIMER,
        .duty       = 0,
        .hpoint     = 0,
    };
    if (ledc_timer_config(&timer) != ESP_OK || ledc_channel_config(&channel) != ESP_OK) {
        DEBUG_F_ERROR("fan pwm not set up\n");
        return false;
    }

    const esp_timer_create_args_t args = {
        .callback = tick_cb,
        .name     = "fan_tick",
    };
    if (esp_timer_create(&args, &tick_timer) != ESP_OK || esp_timer_start_periodic(tick_timer, FAN_TICK_US) != ESP_OK) {
        DEBUG_F_ERROR("fan timer not started\n");
        return false;
    }

    available = true;
    return true;
}

void fan_configure(const air_settings_t *settings) {
    mode    = settings->fan_mode;
    level   = settings->fan_level;
    on_s    = settings->fan_on_s;
    off_s   = settings->fan_off_s;
    pulse_s = 0; // a new pulse cycle starts on
    if (available) {
        update();
    }
}

void fan_set_air_level(air_level_t new_level) {
    air = new_level;
    if (available) {
        update();
    }
}

void fan_set_cap(uint8_t new_cap) {
    cap = new_cap > 100 ? 100 : new_cap;
    if (available) {
        update();
    }
}

uint8_t fan_level_now(void) {
    return level_now;
}
