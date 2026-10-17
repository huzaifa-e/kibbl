#ifndef KL_SERIAL_H
#define KL_SERIAL_H

#include <Arduino.h>

/*
 * Serial debug output as in ESW0009 and kibbl_core: on until debug_status_init() has read
 * the stored choice, toggled with {"cmd":"debug"} and kept. Forced prints (DEBUG_F*) and
 * the command responses always go out. The texts stay in flash (PSTR): RAM is short here.
 */
#define DEBUG(format, ...)         debugPrintSerial(false, PSTR(__FILE__), __LINE__, PSTR(format), ##__VA_ARGS__)
#define DEBUG_F(format, ...)       debugPrintSerial(true, PSTR(__FILE__), __LINE__, PSTR(format), ##__VA_ARGS__)
#define DEBUG_PLAIN(format, ...)   debugPrintPlainSerial(false, PSTR(format), ##__VA_ARGS__)
#define DEBUG_F_PLAIN(format, ...) debugPrintPlainSerial(true, PSTR(format), ##__VA_ARGS__)
#define DEBUG_ERROR(format, ...)   debugPrintErrSerial(false, PSTR(__FILE__), __LINE__, PSTR(format), ##__VA_ARGS__)
#define DEBUG_F_ERROR(format, ...) debugPrintErrSerial(true, PSTR(__FILE__), __LINE__, PSTR(format), ##__VA_ARGS__)

void serial_begin(void);

void debug_status_init(void); // after config_load()
void debug_status_toggle(void);
bool getPrintEnable(void);

void debugPrintSerial(bool force, const char *file, int line, const char *format, ...);
void debugPrintPlainSerial(bool force, const char *format, ...);
void debugPrintErrSerial(bool force, const char *file, int line, const char *format, ...);

// one line from the uart without its end, NULL while none is complete; the buffer is wiped by the next call
char *get_serial_line(void);

#endif /* KL_SERIAL_H */
