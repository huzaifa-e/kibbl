/*
 * kibbl. light (the Magic Home controller of an RGB strip) on the core part of this firmware
 * (KL_product.h): its info, its commands and its telemetry.
 */

#include "KL_product.h"

#include "BUILD_INFO.h"
#include "KL_config.h"
#include "KL_hw.h"
#include "KL_recovery.h"
#include "KL_strip.h"

#define APP_MARKER "KIBBL-APP:KIBBL-LIGHT:"

/* The project and the version in the image, for the server to tell an update file
 * (backend/src/routes/firmware.ts): an ESP8266 image has no esp_app_desc_t. */
static const char app_marker[] = APP_MARKER FW_VERSION;

const char *product_fw_version(void) {
    return app_marker + strlen(APP_MARKER);
}

/* ----------------------------------------------------------------------- */

void product_add_info(JsonObject json, cmd_source_t source) {
    json["model"] = PRODUCT_MODEL; // the product, as the app names it
    json["board"] = BOARD_NAME;

    // what the device can do; the server builds its controls from this list
    JsonArray caps = json["caps"].to<JsonArray>();
    caps.add("rgb");
    caps.add("blink");
    caps.add("ota");

    JsonObject rgb = json["rgb"].to<JsonObject>();
    strip_to_json(rgb);
    rgb["order"] = strip_order();
}

/* ----------------------------------------------------------------------- */

/* {"cmd":"rgb"} with any of on, color [r, g, b], brightness 1-100, fadeMs, order and vivid:
 * the keys given change, the others stay */
static const char *cmd_rgb(JsonObjectConst req, JsonDocument &resp) {
    if (recovery_active()) {
        return "safe mode after crashes: send an update";
    }
    light_t light;
    strip_light(&light);
    uint16_t fade_ms = STRIP_FADE_MS;
    if (!strip_from_json(req, &light, &fade_ms)) {
        return "on true or false, color [r, g, b] 0-255, brightness 1-100, fadeMs 0-10000";
    }
    JsonVariantConst order = req["order"];
    if (!order.isNull() && (!order.is<const char *>() || !strip_set_order(order.as<const char *>()))) {
        return "order is rgb, rbg, grb, gbr, brg or bgr";
    }
    JsonVariantConst vivid = req["vivid"];
    if (!vivid.isNull() && (!vivid.is<bool>() || !strip_set_vivid(vivid.as<bool>()))) {
        return "vivid is true or false";
    }
    strip_set(&light, fade_ms);

    JsonObject rgb = resp["rgb"].to<JsonObject>();
    strip_to_json(rgb);
    rgb["order"] = strip_order();
    return NULL;
}

// white flashes: find the device
static const char *cmd_blink(JsonObjectConst req) {
    int count = 2;
    int level = 60;
    if (!json_int_in_range(req, "count", 1, 10, &count) || !json_int_in_range(req, "level", 1, 100, &level)) {
        return "count 1 to 10, level 1 to 100";
    }
    strip_blink((uint8_t)count, (uint8_t)level);
    return NULL;
}

bool product_command(const char *cmd, JsonObjectConst req, JsonDocument &resp, cmd_source_t source, const char **error) {
    if (strcmp(cmd, "rgb") == 0) {
        *error = cmd_rgb(req, resp);
    } else if (strcmp(cmd, "blink") == 0) {
        *error = cmd_blink(req);
    } else {
        return false;
    }
    return true;
}

/* ----------------------------------------------------------------------- */

void product_add_telemetry(JsonObject json) {
    strip_to_json(json["rgb"].to<JsonObject>());
}

// the light stays as it is, and breathes to show that an update runs
void product_ota_prepare(void) {
    strip_set_updating(true);
    strip_update_progress();
}

void product_ota_progress(int done, int total) {
    strip_update_progress();
}

void product_reset(void) {
    // config_reset() of the core forgets the light and the order too: they share its sector
}
