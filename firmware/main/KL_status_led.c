#include "KL_status_led.h"

#include <stdbool.h>

#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "KL_hw.h"

#define STATUS_LED_STACK_SIZE 2048

static volatile status_led_state led_state = LED_OFF;
static TaskHandle_t status_led_task_handle = NULL;

static void led_write(bool on) {
    gpio_set_level((gpio_num_t)STATUS_LED_PIN, STATUS_LED_ACTIVE_LOW ? !on : on);
}

/* One pattern step: the led on or off for ms. A new state ends the step early (false),
 * so a state change shows at once even in the 3 s blip pattern. */
static bool step(bool on, uint32_t ms) {
    led_write(on);
    return ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(ms)) == 0;
}

static void hold(bool on) {
    led_write(on);
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
}

static void status_led_task(void *pvParams) {
    while (1) {
        switch (led_state) {
        case LED_OFF:
            hold(false);
            break;
        case LED_ON:
            hold(true);
            break;
        case LED_SLOW:
            if (step(true, 500)) {
                step(false, 500);
            }
            break;
        case LED_FAST:
            if (step(true, 100)) {
                step(false, 100);
            }
            break;
        case LED_BLIP:
            if (step(true, 40)) {
                step(false, 2960);
            }
            break;
        case LED_ERROR:
            if (step(true, 80) && step(false, 120) && step(true, 80)) {
                step(false, 720);
            }
            break;
        }
    }
}

void status_led_setup(void) {
    gpio_reset_pin((gpio_num_t)STATUS_LED_PIN);
    gpio_set_direction((gpio_num_t)STATUS_LED_PIN, GPIO_MODE_OUTPUT);
    led_write(false);

    xTaskCreate(status_led_task, "status_led", STATUS_LED_STACK_SIZE, NULL, 2, &status_led_task_handle);
}

void set_status_led(status_led_state state) {
    if (led_state == state) {
        return;
    }
    led_state = state;
    if (status_led_task_handle != NULL) {
        xTaskNotifyGive(status_led_task_handle);
    }
}
