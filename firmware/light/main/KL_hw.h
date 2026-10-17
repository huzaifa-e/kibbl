#ifndef KL_HW_H
#define KL_HW_H

// the product this firmware makes of the board; the app shows it by this id (shared/protocol.ts)
#define PRODUCT_MODEL "kibbl-light"

// Magic Home WiFi LED controller, RGB with IR, 5-28 V, board ZJ-WFMN-A V1.1 (ESP8285, 1 MB)
#define BOARD_NAME "magichome-zj-wfmn-a"

/*
 * GPIO: each colour drives the gate of a low side MOSFET, high is lit; the strip has its
 * common +V on the supply. As published for this board (ESPHome); a strip wired in another
 * order is set with the "order" of the rgb command.
 */
#define RED_PIN   12
#define GREEN_PIN 5
#define BLUE_PIN  13
#define IR_PIN    4 // the receiver of the remote, not used yet

/*
 * PWM: 1 kHz, no flicker to see, 1000 steps
 */
#define PWM_FREQ_HZ 1000
#define PWM_MAX     1000

#endif /* KL_HW_H */
