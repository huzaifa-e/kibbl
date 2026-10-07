#include "KL_lamp.h"

#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "KL_ioexp.h"

#define LAMP_STACK_SIZE 2048
#define WIFI_BLINKS     3
#define BLINK_ON_MS     150
#define BLINK_OFF_MS    150
#define FADE_PERIOD_US  8000 // 125 Hz while a fade runs

static TaskHandle_t lamp_task_handle = NULL;

static volatile lamp_mode_t mode        = LAMP_MODE_TRAFFIC;
static volatile uint8_t colors          = 0;
static volatile bool fade               = true;

static uint8_t shown = 0; // the leds on now
static volatile air_level_t level       = AIR_LEVEL_NONE;
static volatile status_led_state status = LED_OFF;
static volatile bool calibrating        = false;
static volatile bool night              = false;

// flashes still to show, before the lamp goes back to its mode
static volatile uint8_t blinks      = 0;
static volatile uint8_t wifi_blinks = 0;

static void wake(void) {
    if (lamp_task_handle != NULL) {
        xTaskNotifyGive(lamp_task_handle); // ends the current pattern step
    }
}

static void show(uint8_t mask) {
    ioexp_set_lamp(mask);
    shown = mask;
}

/* The leds have no brightness, only on and off: the fade switches between the old and the
 * new look fast, the new one ever longer (squared, as the eye sees it), the old one ever
 * shorter. Busy waits for the short times, a fade is over in LAMP_FADE_MS. */
static void fade_to(uint8_t to) {
    uint8_t from  = shown;
    int64_t start = esp_timer_get_time();
    int64_t t;
    while ((t = esp_timer_get_time() - start) < LAMP_FADE_MS * 1000LL) {
        uint32_t progress = (uint32_t)(t * 1000 / (LAMP_FADE_MS * 1000LL)); // 0-999
        uint32_t on_us    = FADE_PERIOD_US * progress * progress / 1000000;
        ioexp_set_lamp(to);
        esp_rom_delay_us(on_us);
        ioexp_set_lamp(from);
        esp_rom_delay_us(FADE_PERIOD_US - on_us);
    }
    show(to);
}

/* One pattern step: the leds of mask for ms. A change ends the step early (false), so
 * it shows at once. */
static bool step(uint8_t mask, uint32_t ms) {
    show(mask);
    return ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(ms)) == 0;
}

// a steady look: faded to, when it is another than shown
static void hold(uint8_t mask) {
    if (fade && mask != shown) {
        fade_to(mask);
    } else {
        show(mask);
    }
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

static uint8_t level_mask(void) {
    switch (level) {
    case AIR_LEVEL_GREEN:
        return LAMP_MASK_GREEN;
    case AIR_LEVEL_YELLOW:
        return LAMP_MASK_YELLOW;
    case AIR_LEVEL_RED:
        return LAMP_MASK_RED;
    default:
        return 0;
    }
}

// flashes are shown in full, a change does not cut them short
static void flash(volatile uint8_t *count) {
    show(0);
    vTaskDelay(pdMS_TO_TICKS(BLINK_OFF_MS));
    while (*count > 0) {
        (*count)--;
        show(LAMP_MASK_WHITE);
        vTaskDelay(pdMS_TO_TICKS(BLINK_ON_MS));
        show(0);
        vTaskDelay(pdMS_TO_TICKS(BLINK_OFF_MS));
    }
}

static void lamp_task(void *pvParams) {
    while (1) {
        if (blinks > 0) {
            flash(&blinks);
        } else if (wifi_blinks > 0) {
            flash(&wifi_blinks);
        } else if (status == LED_SLOW) {
            // waiting for provisioning: white and the air level in turn
            if (step(LAMP_MASK_WHITE, 500)) {
                step(night ? 0 : level_mask(), 1500);
            }
        } else if (night) {
            hold(0);
        } else if (calibrating) {
            if (step(LAMP_MASK_WHITE, 800)) {
                step(0, 800);
            }
        } else if (status == LED_ERROR) {
            if (step(LAMP_MASK_WHITE, 80) && step(0, 120) && step(LAMP_MASK_WHITE, 80)) {
                step(0, 720);
            }
        } else if (mode == LAMP_MODE_OFF) {
            hold(0);
        } else if (mode == LAMP_MODE_WHITE) {
            hold(LAMP_MASK_WHITE);
        } else if (mode == LAMP_MODE_WARM) {
            // the white leds are neutral (about 4000 K), the amber ones warm them
            hold(LAMP_MASK_WHITE | LAMP_MASK_YELLOW);
        } else if (mode == LAMP_MODE_CANDLE) {
            hold(LAMP_MASK_YELLOW | LAMP_MASK_RED);
        } else if (mode == LAMP_MODE_CUSTOM) {
            hold(colors);
        } else {
            hold(level_mask());
        }
    }
}

void lamp_setup(void) {
    xTaskCreate(lamp_task, "lamp", LAMP_STACK_SIZE, NULL, 2, &lamp_task_handle);
}

void lamp_set_mode(lamp_mode_t new_mode, uint8_t new_colors, bool new_fade) {
    fade = new_fade;
    if (mode != new_mode || colors != new_colors) {
        mode   = new_mode;
        colors = new_colors;
        wake();
    }
}

void lamp_set_level(air_level_t new_level) {
    if (level != new_level) {
        level = new_level;
        wake();
    }
}

void lamp_set_night(bool on) {
    night = on;
    wake();
}

bool lamp_lit(void) {
    if (night || mode == LAMP_MODE_OFF || (mode == LAMP_MODE_CUSTOM && colors == 0)) {
        return false;
    }
    return mode != LAMP_MODE_TRAFFIC || level != AIR_LEVEL_NONE;
}

void lamp_blink(uint8_t count) {
    blinks = count;
    wake();
}

void lamp_set_calibrating(bool on) {
    calibrating = on;
    wake();
}

/* Only provisioning and errors show: the traffic light is for the air, and a light
 * blinking all night while the router is off would only be in the way. */
void lamp_set_status(status_led_state state) {
    if (status != state) {
        status = state;
        wake();
    }
}

void lamp_wifi_connected(void) {
    wifi_blinks = WIFI_BLINKS;
    wake();
}

const char *air_level_name(air_level_t l) {
    switch (l) {
    case AIR_LEVEL_GREEN:
        return "green";
    case AIR_LEVEL_YELLOW:
        return "yellow";
    case AIR_LEVEL_RED:
        return "red";
    default:
        return "none";
    }
}
