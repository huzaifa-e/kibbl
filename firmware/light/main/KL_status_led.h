#ifndef KL_STATUS_LED_H
#define KL_STATUS_LED_H

/* The device's status for the person in front of it, as in kibbl_core: the network part
 * sets it, the strip shows it (KL_strip). */
typedef enum {
    LED_OFF = 0,
    LED_ON,
    LED_SLOW,  // 1 Hz: waiting for wifi provisioning
    LED_FAST,  // 5 Hz: connecting to wifi or the server
    LED_BLIP,  // short flash every 3 s: connected to the server
    LED_ERROR, // two short flashes every second
} status_led_state;

void set_status_led(status_led_state state);

/* Three blinks: the Wi-Fi is connected. Its pattern goes on afterwards. */
void status_led_wifi_connected(void);

#endif /* KL_STATUS_LED_H */
