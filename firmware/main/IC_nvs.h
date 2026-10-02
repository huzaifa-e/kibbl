#ifndef IC_NVS_H
#define IC_NVS_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define READ  false
#define WRITE true

typedef enum {
    UINT8_T,
    UINT32_T,
    STRING,
    BLOB
} nvs_data_type_t;

// nvs_flash_init(), erased and initialised again when the partition is full or from a newer idf
bool nvs_setup(void);

/* reads or writes one key in the calling task, as in ESW0009; max_length bounds a
 * STRING read and is the size of a BLOB in both directions */
bool nvs_queue_job(const char *key, void *valuePtr, size_t max_length, nvs_data_type_t type, bool write);

bool nvs_remove_key(const char *key);

#ifdef __cplusplus
}
#endif

#endif /* IC_NVS_H */
