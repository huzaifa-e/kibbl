#include "KL_time.h"

#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

/**
 * @brief get milliseconds since boot
 *
 * @return int64_t
 */
int64_t millis(void) {
    return esp_timer_get_time() / 1000;
}

/**
 * @brief pauses the calling task for the amount of time (in milliseconds)
 *
 * @param pause_time
 */
void delay_ms(uint64_t pause_time) {
    vTaskDelay(pdMS_TO_TICKS(pause_time));
}
