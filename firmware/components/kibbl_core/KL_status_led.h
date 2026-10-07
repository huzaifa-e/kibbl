#ifndef KL_STATUS_LED_H
#define KL_STATUS_LED_H

#ifdef __cplusplus
extern "C" {
#endif

/* The device's status for the person in front of it. The core sets the network states;
 * each product shows them on its own light (KL_status_led.c of cam/ and air/). */
typedef enum {
    LED_OFF = 0,
    LED_ON,
    LED_SLOW,  // 1 Hz: waiting for wifi provisioning
    LED_FAST,  // 5 Hz: connecting to wifi or the server
    LED_BLIP,  // short flash every 3 s: connected to the server
    LED_ERROR, // two short flashes every second: the camera or the sensor is missing
} status_led_state;

void status_led_setup(void);
void set_status_led(status_led_state state);

/* Three blinks of the status led: the Wi-Fi is connected. Its pattern goes on
 * afterwards. */
void status_led_wifi_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* KL_STATUS_LED_H */
