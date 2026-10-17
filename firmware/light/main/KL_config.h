#ifndef KL_CONFIG_H
#define KL_CONFIG_H

#include <Arduino.h>

/*
 * The settings of the device as kibbl_core's KL_config keeps them, in one EEPROM sector with
 * a checksum instead of nvs: the device secret, the pairing code, the server, the debug
 * choice, and the light of the strip. The Wi-Fi is kept by the sdk itself.
 */

#define SERVER_URL_MAX    128
#define DEVICE_SECRET_LEN 32 // hex characters
#define LOCAL_KEY_LEN     16 // hex characters
#define DEVICE_ID_LEN     12 // mac address in hex, no separators
#define CLAIM_CODE_LEN    8  // the pairing code, letters and digits that cannot be mistaken

typedef struct {
    bool on;
    uint8_t red, green, blue; // the colour at full brightness
    uint8_t brightness;       // 1-100 %
} light_t;

// reads the stored settings, creates the device secret and the pairing code on the first boot
void config_load(void);

// wipes everything, the secrets included: the server sees a new device; the Wi-Fi is not touched
void config_reset(void);

const char *config_device_id(void);
const char *config_device_secret(void);
const char *config_local_key(void);

/* The pairing code: shown by the setup page (KL_portal), typed into the app to take the
 * device into one's account. The server gets only its sha256 (claimHash in the hello). */
const char *config_claim_code(void);
const char *config_claim_hash(void);

const char *config_server_url(void);
bool config_set_server_url(const char *url);

bool config_debug(void);
bool config_set_debug(bool enable);

// false when none is stored: the first boot, or after a factory reset
bool config_light(light_t *out);
bool config_set_light(const light_t *light);

// the order of the strip's wires (KL_strip), "rgb" when none is stored
const char *config_order(void);
bool config_set_order(const char *order);

#endif /* KL_CONFIG_H */
