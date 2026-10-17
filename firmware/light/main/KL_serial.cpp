#include "KL_serial.h"

#include <stdarg.h>

#include "KL_config.h"

#define RX_BUF_SIZE 1024
#define LINE_MAX    256

#define FILE_NAME_SPACER "%9.3f | %16s:%-4d| "

// on until debug_status_init() has read the stored choice, so early boot lines still show
static bool print_enable = true;

static char recv_buffer[RX_BUF_SIZE];
static size_t recv_len = 0;
static bool line_ready = false;

void serial_begin(void) {
    Serial.begin(115200);
    Serial.setRxBufferSize(RX_BUF_SIZE);
}

/* ----------------------------------------------------------------------- */

static void set_print_enable(bool enable) {
    print_enable = enable;
    DEBUG_F("\033[0;33mDebugging status set to: %s\033[0m\n", enable ? "\033[1;31menabled\033[0m" : "\033[1;32mdisabled\033[0m");
}

void debug_status_init(void) {
    set_print_enable(config_debug());
}

void debug_status_toggle(void) {
    bool enable = !print_enable;
    set_print_enable(enable);
    if (!config_set_debug(enable)) {
        DEBUG_F_ERROR("Failed to store the debug status\n");
    }
}

bool getPrintEnable(void) {
    return print_enable;
}

/* ----------------------------------------------------------------------- */

char *get_serial_line(void) {
    if (line_ready) {
        // the line can hold a Wi-Fi password: gone before the next one is read
        memset(recv_buffer, 0, sizeof(recv_buffer));
        recv_len   = 0;
        line_ready = false;
    }
    while (Serial.available() > 0) {
        char c = (char)Serial.read();
        if (c == '\n' || c == '\r') {
            if (recv_len == 0) {
                continue; // the \n of a \r\n
            }
            recv_buffer[recv_len] = '\0';
            line_ready            = true;
            return recv_buffer;
        }
        if (recv_len >= sizeof(recv_buffer) - 1) {
            // overflow protection
            memset(recv_buffer, 0, sizeof(recv_buffer));
            recv_len = 0;
            continue;
        }
        recv_buffer[recv_len++] = c;
    }
    return NULL;
}

/* ----------------------------------------------------------------------- */

static const char *file_name(const char *path, char *out, size_t max) {
    strncpy_P(out, path, max - 1);
    out[max - 1]     = '\0';
    const char *name = strrchr(out, '/');
    return name ? name + 1 : out;
}

static void vprint(const char *format, va_list args) {
    char line[LINE_MAX];
    vsnprintf_P(line, sizeof(line), format, args);
    Serial.print(line);
}

void debugPrintSerial(bool force, const char *file, int line, const char *format, ...) {
    if (!force && !print_enable) {
        return;
    }
    char path[96];
    Serial.printf(FILE_NAME_SPACER, millis() / 1000.0, file_name(file, path, sizeof(path)), line);
    va_list args;
    va_start(args, format);
    vprint(format, args);
    va_end(args);
}

void debugPrintPlainSerial(bool force, const char *format, ...) {
    if (!force && !print_enable) {
        return;
    }
    va_list args;
    va_start(args, format);
    vprint(format, args);
    va_end(args);
}

void debugPrintErrSerial(bool force, const char *file, int line, const char *format, ...) {
    if (!force && !print_enable) {
        return;
    }
    char path[96];
    Serial.printf("\033[31m" FILE_NAME_SPACER "[ERROR]\t", millis() / 1000.0, file_name(file, path, sizeof(path)), line);
    va_list args;
    va_start(args, format);
    vprint(format, args);
    va_end(args);
    Serial.print("\033[0m");
}
