/*
 * The status of the core (KL_status_led.h) on the Conny: it has no led of its own,
 * the white light of the traffic light shows provisioning and errors (KL_lamp).
 */

#include "KL_status_led.h"

#include "KL_lamp.h"

void status_led_setup(void) {
    lamp_setup();
}

void set_status_led(status_led_state state) {
    lamp_set_status(state);
}

void status_led_wifi_connected(void) {
    lamp_wifi_connected();
}
