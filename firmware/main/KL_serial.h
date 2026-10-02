#ifndef KL_SERIAL_H
#define KL_SERIAL_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "cJSON.h"

extern SemaphoreHandle_t print_mutex;

#define DEBUG(format, ...)         debugPrintSerial(false, __FILE__, __LINE__, format, ##__VA_ARGS__)
#define DEBUG_F(format, ...)       debugPrintSerial(true, __FILE__, __LINE__, format, ##__VA_ARGS__)
#define DEBUG_PLAIN(format, ...)   debugPrintPlainSerial(false, format, ##__VA_ARGS__)
#define DEBUG_F_PLAIN(format, ...) debugPrintPlainSerial(true, format, ##__VA_ARGS__)
#define DEBUG_ERROR(format, ...)   debugPrintErrSerial(false, __FILE__, __LINE__, format, ##__VA_ARGS__)
#define DEBUG_F_ERROR(format, ...) debugPrintErrSerial(true, __FILE__, __LINE__, format, ##__VA_ARGS__)

bool setPrintEnable(bool enable);
bool getPrintEnable(void);

/* Serial debug output, as in ESW0009: on until debug_status_init() has read the
 * stored choice, toggled with {"cmd":"debug"} and kept in nvs. Forced prints
 * (DEBUG_F*) and the command responses always go out. */
void debug_status_init(void); // after nvs_setup()
void debug_status_toggle(void);

// checked like printf, so a wrong format is a compile warning instead of a crash
void debugPrintSerial(bool force, const char *file, int line, const char *format, ...) __attribute__((format(printf, 4, 5)));
void debugPrintPlainSerial(bool force, const char *format, ...) __attribute__((format(printf, 2, 3)));
void debugPrintErrSerial(bool force, const char *file, int line, const char *format, ...) __attribute__((format(printf, 4, 5)));

void serial_begin(void);

// one json line from the uart, NULL while none is complete; the caller frees it
cJSON *get_serial_req(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_SERIAL_H */
