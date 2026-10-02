#ifndef IC_STATUS_LED_H
#define IC_STATUS_LED_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    LED_OFF = 0,
    LED_ON,
    LED_SLOW,  // 1 Hz: waiting for wifi provisioning
    LED_FAST,  // 5 Hz: connecting to wifi or the server
    LED_BLIP,  // short flash every 3 s: connected to the server
    LED_ERROR, // two short flashes every second: camera missing
} status_led_state;

void status_led_setup(void);
void set_status_led(status_led_state state);

#ifdef __cplusplus
}
#endif

#endif /* IC_STATUS_LED_H */
