#ifndef KL_CONFIG_H
#define KL_CONFIG_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SERVER_URL_MAX    128
#define DEVICE_SECRET_LEN 32 // hex characters
#define LOCAL_KEY_LEN     16 // hex characters
#define DEVICE_ID_LEN     12 // mac address in hex, no separators
#define CLAIM_CODE_LEN    8  // the pairing code, letters and digits that cannot be mistaken

// reads the stored settings, creates the device secret and the local key on the first boot
void config_load(void);

// wipes everything config_load() reads, the secrets included; wifi and the product's settings are not touched
void config_reset(void);

const char *config_device_id(void);
const char *config_device_secret(void);
const char *config_local_key(void);

/* The pairing code: shown by the setup page of the device (KL_portal), typed into the app
 * to take the device into one's account. The server gets only its sha256 (claimHash in the
 * hello); a factory reset makes a new one. */
const char *config_claim_code(void);
const char *config_claim_hash(void);

const char *config_server_url(void);
bool config_set_server_url(const char *url);

#ifdef __cplusplus
}
#endif

#endif /* KL_CONFIG_H */
