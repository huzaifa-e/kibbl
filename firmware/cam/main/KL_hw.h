#ifndef KL_HW_H
#define KL_HW_H

#ifdef __cplusplus
extern "C" {
#endif

#include "sdkconfig.h"

// the product this firmware makes of the board; the app shows it by this id (shared/protocol.ts)
#define PRODUCT_MODEL "kibbl-cam"

/*
 * LEDC (=PWM) CHANNELS:
 */
// for camera xclk
#define CAMERA_CHANNEL LEDC_CHANNEL_0
#define CAMERA_TIMER   LEDC_TIMER_0
// for flash led
#define LIGHT_CHANNEL LEDC_CHANNEL_1
#define LIGHT_TIMER   LEDC_TIMER_1

#if CONFIG_KIBBL_BOARD_AI_THINKER

#define BOARD_NAME "ai-thinker-esp32-cam"

/*
 * Pins for LEDs
 */
#define STATUS_LED_PIN        33 // red led on the back, pulls to gnd
#define STATUS_LED_ACTIVE_LOW 1
#define LIGHT_PIN             4  // flash led, shared with the sd card (DATA1)

/*
 * Camera pins
 */
#define CAM_PIN_PWDN  32
#define CAM_PIN_RESET -1 // software reset will be performed
#define CAM_PIN_XCLK  0
#define CAM_PIN_SIOD  26
#define CAM_PIN_SIOC  27

#define CAM_PIN_D7    35
#define CAM_PIN_D6    34
#define CAM_PIN_D5    39
#define CAM_PIN_D4    36
#define CAM_PIN_D3    21
#define CAM_PIN_D2    19
#define CAM_PIN_D1    18
#define CAM_PIN_D0    5

#define CAM_PIN_VSYNC 25
#define CAM_PIN_HREF  23
#define CAM_PIN_PCLK  22

#elif CONFIG_KIBBL_BOARD_FREENOVE_S3

#define BOARD_NAME "freenove-esp32s3-cam"

/*
 * Pins for LEDs
 */
#define STATUS_LED_PIN        2 // blue led
#define STATUS_LED_ACTIVE_LOW 0
#define LIGHT_PIN             -1 // no flash led

/*
 * Camera pins
 */
#define CAM_PIN_PWDN  -1 // power down is not used
#define CAM_PIN_RESET -1 // software reset will be performed
#define CAM_PIN_XCLK  15
#define CAM_PIN_SIOD  4
#define CAM_PIN_SIOC  5

#define CAM_PIN_D7    16
#define CAM_PIN_D6    17
#define CAM_PIN_D5    18
#define CAM_PIN_D4    12
#define CAM_PIN_D3    10
#define CAM_PIN_D2    8
#define CAM_PIN_D1    9
#define CAM_PIN_D0    11

#define CAM_PIN_VSYNC 6
#define CAM_PIN_HREF  7
#define CAM_PIN_PCLK  13

#else
#error "no camera board selected (idf.py menuconfig -> kibbl.)"
#endif

#ifdef __cplusplus
}
#endif

#endif /* KL_HW_H */
