#include "KL_buzzer.h"

#include <stdint.h>

#include "driver/ledc.h"
#include "esp_timer.h"

#include "KL_hw.h"
#include "KL_serial.h"

#define BUZZER_DUTY_RES LEDC_TIMER_8_BIT
#define BUZZER_DUTY     128 // half: the loudest square wave

typedef struct {
    uint16_t freq_hz;
    uint16_t on_ms;
    uint16_t pause_ms;
} note_t;

// frequency, length, pause after it: the tone tables of ESW0002 (Buzzer.cpp)
static const note_t tone_button[]          = {{800, 100, 1}};
static const note_t tone_yellow[]          = {{850, 110, 100}, {850, 110, 100}};
static const note_t tone_red[]             = {{850, 110, 100}, {850, 110, 100}, {850, 110, 100}, {850, 110, 100}};
static const note_t tone_calibrate_start[] = {{300, 180, 80}, {500, 280, 100}};
static const note_t tone_calibrate_end[]   = {{500, 280, 100}, {300, 180, 80}};
static const note_t tone_logged[]          = {{620, 110, 95}, {735, 180, 100}};

static const struct {
    const note_t *notes;
    uint8_t count;
} tones[] = {
    [TONE_BUTTON]          = {tone_button, sizeof(tone_button) / sizeof(note_t)},
    [TONE_YELLOW]          = {tone_yellow, sizeof(tone_yellow) / sizeof(note_t)},
    [TONE_RED]             = {tone_red, sizeof(tone_red) / sizeof(note_t)},
    [TONE_CALIBRATE_START] = {tone_calibrate_start, sizeof(tone_calibrate_start) / sizeof(note_t)},
    [TONE_CALIBRATE_END]   = {tone_calibrate_end, sizeof(tone_calibrate_end) / sizeof(note_t)},
    [TONE_LOGGED]          = {tone_logged, sizeof(tone_logged) / sizeof(note_t)},
};

static bool available       = false;
static volatile bool muted   = false;
static esp_timer_handle_t note_timer = NULL;

static const note_t *playing = NULL;
static uint8_t notes_left    = 0;
static bool sounding         = false; // the note sounds, else its pause runs

static void silence(void) {
    ledc_set_duty(LEDC_LOW_SPEED_MODE, BUZZER_CHANNEL, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, BUZZER_CHANNEL);
}

// one step: a note starts, or its pause; the timer calls it again at the end of each
static void note_cb(void *arg) {
    if (sounding) {
        silence();
        sounding = false;
        esp_timer_start_once(note_timer, (uint64_t)playing->pause_ms * 1000);
        playing++;
        notes_left--;
        return;
    }
    if (notes_left == 0) {
        playing = NULL;
        return;
    }
    ledc_set_freq(LEDC_LOW_SPEED_MODE, BUZZER_TIMER, playing->freq_hz);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, BUZZER_CHANNEL, BUZZER_DUTY);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, BUZZER_CHANNEL);
    sounding = true;
    esp_timer_start_once(note_timer, (uint64_t)playing->on_ms * 1000);
}

bool buzzer_setup(void) {
    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .duty_resolution = BUZZER_DUTY_RES,
        .timer_num       = BUZZER_TIMER,
        .freq_hz         = 800,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ledc_channel_config_t channel = {
        .gpio_num   = BUZZER_PIN,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = BUZZER_CHANNEL,
        .timer_sel  = BUZZER_TIMER,
        .duty       = 0,
        .hpoint     = 0,
    };
    if (ledc_timer_config(&timer) != ESP_OK || ledc_channel_config(&channel) != ESP_OK) {
        DEBUG_F_ERROR("buzzer pwm not set up\n");
        return false;
    }

    const esp_timer_create_args_t args = {
        .callback = note_cb,
        .name     = "buzzer",
    };
    if (esp_timer_create(&args, &note_timer) != ESP_OK) {
        return false;
    }
    available = true;
    return true;
}

void buzzer_set_muted(bool mute) {
    muted = mute;
}

void buzzer_play(buzzer_tone_t tone) {
    if (!available || muted || tone >= sizeof(tones) / sizeof(tones[0])) {
        return;
    }
    esp_timer_stop(note_timer);
    silence();
    playing    = tones[tone].notes;
    notes_left = tones[tone].count;
    sounding   = false;
    note_cb(NULL);
}
