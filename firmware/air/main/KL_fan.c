#include "KL_fan.h"

#include "driver/ledc.h"
#include "esp_timer.h"

#include "KL_hw.h"
#include "KL_serial.h"

#define FAN_FREQ_HZ  25000 // above hearing, as for pc fans
#define FAN_DUTY_RES LEDC_TIMER_8_BIT
#define FAN_DUTY_MAX 255
#define FAN_TICK_US  (1000 * 1000)

/* Auto: the speed follows the CO2. Below yellow - FAN_AUTO_LEAD it idles at FAN_AUTO_MIN,
 * which still draws room air past the sensor; from there it rises in a line to the set
 * level at red. It moves at most FAN_AUTO_STEP a second, so it is not heard jumping,
 * and only by whole FAN_AUTO_GRAIN, so the noise of the sensor does not move it. */
#define FAN_AUTO_MIN   20 // %
#define FAN_AUTO_LEAD  400 // ppm below yellow where it starts to rise
#define FAN_AUTO_STEP  2 // % per second
#define FAN_AUTO_GRAIN 5 // %

static bool available = false;

static volatile uint8_t mode       = FAN_MODE_ON;
static volatile uint8_t level      = 100;
static volatile uint16_t on_s      = 60;
static volatile uint16_t off_s     = 240;
static volatile air_level_t air    = AIR_LEVEL_NONE;
static volatile uint16_t co2       = 0; // ppm, 0 until the first reading
static volatile uint16_t yellow    = 1000;
static volatile uint16_t red       = 2000;
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

// the speed auto wants for the CO2 now, before the night cap
static uint8_t auto_target(void) {
    uint8_t top = level;
    uint8_t low = FAN_AUTO_MIN < top ? FAN_AUTO_MIN : top;
    if (co2 == 0) {
        return top; // no reading yet: air past the sensor helps the first one
    }
    int start = (int)yellow - FAN_AUTO_LEAD;
    if (start < 0) {
        start = 0;
    }
    if (co2 >= red || air == AIR_LEVEL_RED) {
        return top;
    }
    if (co2 <= start) {
        return low;
    }
    int value = low + (top - low) * ((int)co2 - start) / ((int)red - start);
    value     = (value + FAN_AUTO_GRAIN / 2) / FAN_AUTO_GRAIN * FAN_AUTO_GRAIN;
    return value < low ? low : value > top ? top : (uint8_t)value;
}

static uint8_t capped(uint8_t value) {
    return value < cap ? value : cap;
}

// ramp: called every second, the auto speed moves towards its target by FAN_AUTO_STEP
static void update(bool ramp) {
    switch (mode) {
    case FAN_MODE_ON:
        write_level(capped(level));
        break;
    case FAN_MODE_PULSE:
        write_level(pulse_s < on_s ? capped(level) : 0);
        break;
    case FAN_MODE_AUTO: {
        int target = capped(auto_target());
        int now    = level_now;
        if (now == 0 || !ramp) {
            // starting, or a change of settings or night: the ramp goes on from there
            write_level(now == 0 || now > target ? target : now);
        } else if (now < target) {
            write_level(now + FAN_AUTO_STEP < target ? now + FAN_AUTO_STEP : target);
        } else if (now > target) {
            write_level(now - FAN_AUTO_STEP > target ? now - FAN_AUTO_STEP : target);
        }
        break;
    }
    default:
        write_level(0);
        break;
    }
}

static void tick_cb(void *arg) {
    pulse_s = (pulse_s + 1) % (on_s + off_s);
    update(true);
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
    yellow  = settings->yellow;
    red     = settings->red;
    pulse_s = 0; // a new pulse cycle starts on
    if (available) {
        update(false);
    }
}

void fan_set_air(air_level_t new_level, uint16_t new_co2) {
    air = new_level;
    co2 = new_co2; // the auto speed follows on the next tick
}

void fan_set_cap(uint8_t new_cap) {
    cap = new_cap > 100 ? 100 : new_cap;
    if (available) {
        update(false);
    }
}

uint8_t fan_level_now(void) {
    return level_now;
}
