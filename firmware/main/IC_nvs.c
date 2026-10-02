#include "IC_nvs.h"

#include "nvs.h"
#include "nvs_flash.h"
#include <esp_err.h>

#include "IC_serial.h"

#define NVS_NAMESPACE "storage"

static SemaphoreHandle_t nvs_job_active;

bool nvs_setup(void) {
    nvs_job_active = xSemaphoreCreateMutex();

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        DEBUG_F_ERROR("nvs unusable (%s), erasing it\n", esp_err_to_name(err));
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        DEBUG_F_ERROR("nvs_flash_init failed (%s)\n", esp_err_to_name(err));
        return false;
    }
    return true;
}

/* -------------------------------- ACCESS ------------------------------- */

static bool nvs_read(nvs_handle_t handle, const char *key, void *valuePtr, size_t max_length, nvs_data_type_t type) {
    esp_err_t err = ESP_FAIL;
    size_t length = max_length;

    switch (type) {
    case UINT8_T:
        err = nvs_get_u8(handle, key, (uint8_t *)valuePtr);
        break;
    case UINT32_T:
        err = nvs_get_u32(handle, key, (uint32_t *)valuePtr);
        break;
    case STRING:
        err = nvs_get_str(handle, key, (char *)valuePtr, &length);
        break;
    case BLOB:
        err = nvs_get_blob(handle, key, valuePtr, &length);
        // a blob stored by an older layout has another size; the caller keeps its defaults
        if (err == ESP_OK && length != max_length) {
            err = ESP_ERR_NVS_INVALID_LENGTH;
        }
        break;
    }

    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        DEBUG_ERROR("Failed reading %s from nvs (%s)\n", key, esp_err_to_name(err));
    }
    return err == ESP_OK;
}

static bool nvs_write(nvs_handle_t handle, const char *key, void *valuePtr, size_t max_length, nvs_data_type_t type) {
    esp_err_t err = ESP_FAIL;

    switch (type) {
    case UINT8_T:
        err = nvs_set_u8(handle, key, *(uint8_t *)valuePtr);
        break;
    case UINT32_T:
        err = nvs_set_u32(handle, key, *(uint32_t *)valuePtr);
        break;
    case STRING:
        err = nvs_set_str(handle, key, (const char *)valuePtr);
        break;
    case BLOB:
        err = nvs_set_blob(handle, key, valuePtr, max_length);
        break;
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }

    if (err != ESP_OK) {
        // the value can be a secret, so only the key goes to the log
        DEBUG_ERROR("Failed saving %s on nvs (%s)\n", key, esp_err_to_name(err));
    }
    return err == ESP_OK;
}

bool nvs_queue_job(const char *key, void *valuePtr, size_t max_length, nvs_data_type_t type, bool write) {
    if (key == NULL || valuePtr == NULL) {
        return false;
    }

    xSemaphoreTake(nvs_job_active, portMAX_DELAY);

    bool success = false;
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, write ? NVS_READWRITE : NVS_READONLY, &handle);
    if (err == ESP_OK) {
        success = write ? nvs_write(handle, key, valuePtr, max_length, type) : nvs_read(handle, key, valuePtr, max_length, type);
        nvs_close(handle);
    } else if (err != ESP_ERR_NVS_NOT_FOUND) {
        // NOT_FOUND: the namespace does not exist before the first write
        DEBUG_ERROR("Failed (%s) opening NVS handle!\n", esp_err_to_name(err));
    }

    xSemaphoreGive(nvs_job_active);
    return success;
}

bool nvs_remove_key(const char *key) {
    xSemaphoreTake(nvs_job_active, portMAX_DELAY);

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_erase_key(handle, key);
        if (err == ESP_OK || err == ESP_ERR_NVS_NOT_FOUND) {
            err = nvs_commit(handle);
        }
        nvs_close(handle);
    }

    xSemaphoreGive(nvs_job_active);
    return err == ESP_OK;
}
