#include "KL_config.h"

#include <EEPROM.h>
#include <ESP8266WiFi.h>
#include <bearssl/bearssl_hash.h>

#include "KL_serial.h"

#define STORE_MAGIC   0x4b4c4c54 // "KLLT"
#define STORE_VERSION 1

#define DEFAULT_SERVER_URL "wss://kibbl.uk/device/socket"

// no 0/O, 1/I/L, 5/S, 8/B: read from a phone screen and typed in elsewhere
static const char claim_alphabet[] = "ACDEFGHJKMNPQRTUVWXYZ234679";

typedef struct {
    uint32_t magic;
    uint16_t version;
    uint16_t size;
    char device_secret[DEVICE_SECRET_LEN + 1];
    char local_key[LOCAL_KEY_LEN + 1];
    char claim_code[CLAIM_CODE_LEN + 1];
    char server_url[SERVER_URL_MAX];
    uint8_t debug; // 1: on
    uint8_t has_light;
    light_t light;
    char order[4];
    uint32_t crc;
} store_t;

static store_t store;
static char device_id[DEVICE_ID_LEN + 1];
static char claim_hash[65];

/* ----------------------------------------------------------------------- */

static uint32_t store_crc(const store_t *s) {
    // crc32 of everything before the crc itself
    uint32_t crc        = 0xffffffff;
    const uint8_t *data = (const uint8_t *)s;
    for (size_t i = 0; i < offsetof(store_t, crc); i++) {
        crc ^= data[i];
        for (int k = 0; k < 8; k++) {
            crc = (crc >> 1) ^ (0xedb88320 & (0 - (crc & 1)));
        }
    }
    return ~crc;
}

static bool save(void) {
    store.crc = store_crc(&store);
    EEPROM.put(0, store);
    bool stored = EEPROM.commit();
    if (!stored) {
        DEBUG_F_ERROR("settings not stored\n");
    }
    return stored;
}

static void random_hex(char *out, size_t hex_len) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < hex_len; i++) {
        out[i] = hex[ESP.random() & 0x0f]; // the hardware random number generator
    }
    out[hex_len] = '\0';
}

static void new_claim_code(void) {
    for (size_t i = 0; i < CLAIM_CODE_LEN; i++) {
        store.claim_code[i] = claim_alphabet[ESP.random() % (sizeof(claim_alphabet) - 1)];
    }
    store.claim_code[CLAIM_CODE_LEN] = '\0';
}

// a fresh store: new secrets, the default server, debug on, no light
static void create(void) {
    memset(&store, 0, sizeof(store));
    store.magic   = STORE_MAGIC;
    store.version = STORE_VERSION;
    store.size    = sizeof(store);
    random_hex(store.device_secret, DEVICE_SECRET_LEN);
    random_hex(store.local_key, LOCAL_KEY_LEN);
    new_claim_code();
    strlcpy(store.server_url, DEFAULT_SERVER_URL, sizeof(store.server_url));
    store.debug = 1;
    strlcpy(store.order, "rgb", sizeof(store.order));
}

static void hash_claim_code(void) {
    br_sha256_context ctx;
    uint8_t digest[32];
    br_sha256_init(&ctx);
    br_sha256_update(&ctx, store.claim_code, CLAIM_CODE_LEN);
    br_sha256_out(&ctx, digest);
    for (int i = 0; i < 32; i++) {
        snprintf(&claim_hash[2 * i], 3, "%02x", digest[i]);
    }
}

void config_load(void) {
    EEPROM.begin(sizeof(store_t));
    EEPROM.get(0, store);

    if (store.magic != STORE_MAGIC || store.version != STORE_VERSION || store.size != sizeof(store) || store.crc != store_crc(&store)) {
        DEBUG_F("no stored settings, new device secret and pairing code\n");
        create();
        save();
    }

    uint8_t mac[6];
    WiFi.macAddress(mac);
    snprintf(device_id, sizeof(device_id), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    hash_claim_code();
}

void config_reset(void) {
    create();
    save();
    hash_claim_code();
}

const char *config_device_id(void) {
    return device_id;
}

const char *config_device_secret(void) {
    return store.device_secret;
}

const char *config_local_key(void) {
    return store.local_key;
}

const char *config_claim_code(void) {
    return store.claim_code;
}

const char *config_claim_hash(void) {
    return claim_hash;
}

/* ----------------------------------------------------------------------- */

const char *config_server_url(void) {
    return store.server_url;
}

bool config_set_server_url(const char *url) {
    if (url == NULL || strlen(url) >= SERVER_URL_MAX) {
        return false;
    }
    if (strncmp(url, "ws://", 5) != 0 && strncmp(url, "wss://", 6) != 0) {
        return false;
    }
    // the stream reads it on the next connect only, which happens after a reboot
    strlcpy(store.server_url, url, sizeof(store.server_url));
    return save();
}

bool config_debug(void) {
    return store.debug != 0;
}

bool config_set_debug(bool enable) {
    store.debug = enable ? 1 : 0;
    return save();
}

bool config_light(light_t *out) {
    if (!store.has_light) {
        return false;
    }
    *out = store.light;
    return true;
}

bool config_set_light(const light_t *light) {
    if (store.has_light && memcmp(&store.light, light, sizeof(light_t)) == 0) {
        return true; // a sector erase saved
    }
    store.has_light = 1;
    store.light     = *light;
    return save();
}

const char *config_order(void) {
    return store.order;
}

bool config_set_order(const char *order) {
    if (order == NULL || strlen(order) != 3) {
        return false;
    }
    strlcpy(store.order, order, sizeof(store.order));
    return save();
}
