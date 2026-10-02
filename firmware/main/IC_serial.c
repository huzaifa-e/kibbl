#include "IC_serial.h"

#include "driver/uart.h"
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"

#include "IC_nvs.h"
#include "IC_time.h"

#define RX_BUF_SIZE   1024
#define UART_PORT_NUM UART_NUM_0

/* ----------------------------------------------------------------------- */

#define FILE_NAME_SPACER "%9.3f | %16s:%-4d| %10s | "

SemaphoreHandle_t print_mutex;

#define NVS_DEBUG_STATUS "DEBUG_STAT" // "enable" or "disable", same key as ESW0009

// on until debug_status_init() has read the stored choice, so early boot lines still show
static bool _printEnable = true;

bool setPrintEnable(bool enable) {
    _printEnable = enable;
    // the ESP-IDF components log through their own path; keep their warnings and errors
    esp_log_level_set("*", enable ? ESP_LOG_INFO : ESP_LOG_WARN);
    DEBUG_F("\033[0;33mDebugging status set to: %s\033[0m\n", enable ? "\033[1;31menabled\033[0m" : "\033[1;32mdisabled\033[0m");
    return _printEnable;
}

bool getPrintEnable(void) {
    return _printEnable;
}

void debug_status_init(void) {
    char debug_status[8] = {0};

    /* Unlike ESW0009 nothing stored means on: the device is mains powered and the
     * serial port is the only window into it on the bench. */
    bool enable = !nvs_queue_job(NVS_DEBUG_STATUS, debug_status, sizeof(debug_status), STRING, READ) ||
                  strcmp(debug_status, "enable") == 0;
    setPrintEnable(enable);
}

void debug_status_toggle(void) {
    char debug_status[8] = {0};

    bool enable = !_printEnable;
    strlcpy(debug_status, enable ? "enable" : "disable", sizeof(debug_status));
    setPrintEnable(enable);

    if (!nvs_queue_job(NVS_DEBUG_STATUS, debug_status, 0, STRING, WRITE)) {
        DEBUG_F_ERROR("Failed to write debug status to NVS\n");
    }
}

/* ----------------------------------------------------------------------- */

void serial_begin(void) {
    print_mutex = xSemaphoreCreateMutex();

    const uart_config_t uart_config = {
        .baud_rate  = 115200,
        .data_bits  = UART_DATA_8_BITS,
        .parity     = UART_PARITY_DISABLE,
        .stop_bits  = UART_STOP_BITS_1,
        .flow_ctrl  = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };

    // We won't use a buffer for sending data; the default console pins stay as they are
    uart_driver_install(UART_PORT_NUM, RX_BUF_SIZE * 2, 0, 0, NULL, 0);
    uart_param_config(UART_PORT_NUM, &uart_config);
}

static char recv_buffer[RX_BUF_SIZE];
static size_t recv_buffer_ptr = 0;

cJSON *get_serial_req(void) {
    char data[RX_BUF_SIZE];

    int len = uart_read_bytes(UART_PORT_NUM, data, sizeof(data), pdMS_TO_TICKS(20));

    for (int i = 0; i < len; i++) {
        if (recv_buffer_ptr >= RX_BUF_SIZE) {
            // overflow protection
            recv_buffer_ptr = 0;
            memset(recv_buffer, 0x00, RX_BUF_SIZE);
            return NULL;
        }

        recv_buffer[recv_buffer_ptr] = data[i];

        if ((recv_buffer[recv_buffer_ptr] == '\n') || (recv_buffer[recv_buffer_ptr] == '\r')) {
            recv_buffer[recv_buffer_ptr] = '\0';

            // an empty line (the \n of a \r\n) is not an error
            bool empty = recv_buffer_ptr == 0;

            // read one full line, try to json-parse the input
            cJSON *root = empty ? NULL : cJSON_Parse(recv_buffer);

            /* The line can hold a Wi-Fi password: clear it before anything else
             * runs, the parsed copy is the caller's to free. */
            recv_buffer_ptr = 0;
            memset(recv_buffer, 0x00, RX_BUF_SIZE);
            memset(data, 0x00, sizeof(data));

            if (!root && !empty) {
                DEBUG_F("invalid input over serial (no json)\n");
            }
            return root;
        }

        recv_buffer_ptr++;
    }

    return NULL;
}

/* ----------------------------------------------------------------------- */

/*
 * Print functions
 */

static const char *fileNameFromPath(const char *path) {
    const char *name = strrchr(path, '/');
    if (name) {
        return ++name;
    }
    return path;
}

void debugPrintSerial(bool force, const char *file, int line, const char *format, ...) {
    if (!force && !_printEnable) {
        return;
    }

    xSemaphoreTake(print_mutex, portMAX_DELAY); // Mutex block

    file = fileNameFromPath(file);
    printf(FILE_NAME_SPACER, (float)millis() / 1000, file, line, pcTaskGetName(NULL));

    va_list args;
    va_start(args, format);
    vprintf(format, args);
    va_end(args);

    xSemaphoreGive(print_mutex); // Mutex release
}

void debugPrintPlainSerial(bool force, const char *format, ...) {
    if (!force && !_printEnable) {
        return;
    }

    xSemaphoreTake(print_mutex, portMAX_DELAY); // Mutex block

    va_list args;
    va_start(args, format);
    vprintf(format, args);
    va_end(args);

    xSemaphoreGive(print_mutex); // Mutex release
}

void debugPrintErrSerial(bool force, const char *file, int line, const char *format, ...) {
    if (!force && !_printEnable) {
        return;
    }

    xSemaphoreTake(print_mutex, portMAX_DELAY); // Mutex block

    printf("\033[31m");

    file = fileNameFromPath(file);
    printf(FILE_NAME_SPACER "[ERROR]\t", (float)millis() / 1000, file, line, pcTaskGetName(NULL));

    va_list args;
    va_start(args, format);
    vprintf(format, args);
    va_end(args);

    printf("\033[0m");

    xSemaphoreGive(print_mutex); // Mutex release
}

/* ----------------------------------------------------------------------- */
