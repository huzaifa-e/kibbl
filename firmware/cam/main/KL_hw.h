#ifndef KL_HW_H
#define KL_HW_H

#ifdef __cplusplus
extern "C" {
#endif

#include "sdkconfig.h"

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

// the product this firmware makes of the board; the app shows it by this id (shared/protocol.ts)
#define PRODUCT_MODEL "kibbl-cam"
#define BOARD_NAME    "ai-thinker-esp32-cam"

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

#define PRODUCT_MODEL "kibbl-cam"
#define BOARD_NAME    "freenove-esp32s3-cam"

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

#elif CONFIG_KIBBL_BOARD_EMONI

/* The EMONI main board EHW0014-0011 (ESP32-S3-WROOM-1-N16R8, without the buzzer) as a
 * kibbl. feeder: its camera looks at the iris, the S42B motor driver takes STEP, DIR and
 * EN from three test pads the feeder does not need otherwise (docs/feeder-emoni.md) */
#define PRODUCT_MODEL "kibbl-feeder"
#define BOARD_NAME    "emoni-ehw0014-0011"

/*
 * Pins for LEDs: each one through a P-MOSFET, on while the pin is low
 */
#define STATUS_LED_PIN        17 // LED.1, the green led D5
#define STATUS_LED_ACTIVE_LOW 1
#define STATUS_LED_RED_PIN    18 // LED.2, the red led D4: kept off
#define LIGHT_PIN             19 // LED.0, the illuminator leds on JP1/JP2
#define LIGHT_ACTIVE_LOW      1

/*
 * Camera pins
 */
#define CAM_POWER_PIN         10 // CAM_PWR: the P-MOSFET Q1 powers the camera while low
#define CAM_XCLK_HZ           10000000 // ESW0009 runs it at 5 MHz for one picture; a stream wants more, 16 cuts frames short
/* its sensor, a GC2145, has no jpeg encoder: grayscale frames (the driver keeps the Y of its
 * YUV, as in ESW0009), encoded in software. Always SVGA: the driver subsamples the 1600 x 1200
 * sensor by half, the whole field of view; VGA and smaller crop its middle. */
#define CAM_SOFT_JPEG         1
#define CAM_FIXED_FRAMESIZE   FRAMESIZE_SVGA
#define CAM_AUTO_LIGHT        1 // the illuminator turns on by itself when something comes close (KL_light.c)
#define CAM_AUTO_LIGHT_DARK   50 // the middle of the frame darker than this (of 255): something covers it
#define CAM_DEFAULT_VFLIP     1 // the camera sits upside down on this board: flipped by default, the app can change it

#define CAM_PIN_PWDN  -1 // pulled down on the board
#define CAM_PIN_RESET -1 // pulled up on the board, software reset
#define CAM_PIN_XCLK  11
#define CAM_PIN_SIOD  1
#define CAM_PIN_SIOC  2

#define CAM_PIN_D7    40
#define CAM_PIN_D6    39
#define CAM_PIN_D5    12
#define CAM_PIN_D4    14
#define CAM_PIN_D3    47
#define CAM_PIN_D2    38
#define CAM_PIN_D1    48
#define CAM_PIN_D0    21

#define CAM_PIN_VSYNC 42
#define CAM_PIN_HREF  41
#define CAM_PIN_PCLK  13

/*
 * The feeder: the S42B's signal header, COM on +3V3, so a low pin drives its input
 */
#define KIBBL_FEEDER  1
#define FEEDER_STEP_PIN 15 // test pad BAT_READ (VBAT.READ, 100k to GND: low while booting)
#define FEEDER_DIR_PIN  9  // test pad BAT_LEVEL (VBAT.EXT, 330k to GND)
#define FEEDER_EN_PIN   8  // test pad EN.EXT (USB present, high from USB: the S42B off while booting)

#else
#error "no camera board selected (idf.py menuconfig -> kibbl.)"
#endif

#ifdef __cplusplus
}
#endif

#ifndef CAM_XCLK_HZ
#define CAM_XCLK_HZ 20000000
#endif
#ifndef CAM_AUTO_LIGHT
#define CAM_AUTO_LIGHT 0
#endif
#ifndef CAM_DEFAULT_VFLIP
#define CAM_DEFAULT_VFLIP 0
#endif
#ifndef CAM_SOFT_JPEG
#define CAM_SOFT_JPEG 0 // the sensor encodes jpeg itself
#endif

#ifndef KIBBL_FEEDER
#define KIBBL_FEEDER 0 // a camera only
#endif

// the image's project name tells the server the product: KIBBL-FEEDER for this board only
#if KIBBL_FEEDER != defined(KIBBL_PROJECT_FEEDER)
#error "the EMONI board is built with sdkconfig.defaults.emoni (docs/feeder-emoni.md)"
#endif

#endif /* KL_HW_H */
