#include "KL_button.h"

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "KL_buzzer.h"
#include "KL_hw.h"
#include "KL_serial.h"
#include "KL_time.h"
#include "KL_wifi_prov.h"

#define BUTTON_STACK_SIZE 3072
#define BUTTON_POLL_MS    20
#define BUTTON_DEBOUNCE   3    // polls in a row before a change counts
#define BUTTON_SHORT_MS   2000 // longer is no press, a release before the reset does nothing

static void (*press_cb)(void) = NULL;

static void button_task(void *pvParams) {
    bool down         = false;
    uint8_t stable    = 0;
    int64_t down_time = 0;

    while (1) {
        delay_ms(BUTTON_POLL_MS);

        bool level_down = gpio_get_level((gpio_num_t)BUTTON_PIN) == 0;
        stable          = level_down != down ? stable + 1 : 0;
        if (stable < BUTTON_DEBOUNCE) {
            if (down && millis() - down_time >= BUTTON_RESET_HOLD_MS) {
                buzzer_play(TONE_CALIBRATE_END);
                DEBUG_F("button held %d s\n", BUTTON_RESET_HOLD_MS / 1000);
                delay_ms(500);
                wifi_reset_credentials(); // restarts
            }
            continue;
        }

        stable = 0;
        down   = level_down;
        if (down) {
            down_time = millis();
            buzzer_play(TONE_BUTTON);
        } else if (millis() - down_time < BUTTON_SHORT_MS && press_cb != NULL) {
            press_cb();
        }
    }
}

void button_setup(void (*on_press)(void)) {
    press_cb = on_press;

    // also takes the pin from the USB-Serial-JTAG pad
    gpio_config_t io = {
        .pin_bit_mask = 1ULL << BUTTON_PIN,
        .mode         = GPIO_MODE_INPUT,
        .pull_up_en   = GPIO_PULLUP_DISABLE, // 10k on the board
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type    = GPIO_INTR_DISABLE,
    };
    gpio_config(&io);

    xTaskCreate(button_task, "button", BUTTON_STACK_SIZE, NULL, 3, NULL);
}
