#include "KL_i2c.h"

#include "driver/i2c.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include "KL_hw.h"
#include "KL_serial.h"

#define I2C_TIMEOUT_MS 100
/* The bus timeout of the controller in 2^n APB cycles: 2^23 / 80 MHz = 105 ms, longer
 * than the clock stretching of the SCD30 (up to 12 ms, more while it measures). */
#define I2C_STRETCH_TIMEOUT 23

static SemaphoreHandle_t bus_mutex;

bool i2c_bus_setup(void) {
    bus_mutex = xSemaphoreCreateMutex();

    i2c_config_t conf = {
        .mode             = I2C_MODE_MASTER,
        .sda_io_num       = I2C_SDA_PIN,
        .scl_io_num       = I2C_SCL_PIN,
        .sda_pullup_en    = GPIO_PULLUP_DISABLE, // 10k on the board
        .scl_pullup_en    = GPIO_PULLUP_DISABLE,
        .master.clk_speed = I2C_FREQ_HZ,
    };
    esp_err_t err = i2c_param_config(I2C_PORT, &conf);
    if (err == ESP_OK) {
        err = i2c_driver_install(I2C_PORT, conf.mode, 0, 0, 0);
    }
    if (err == ESP_OK) {
        err = i2c_set_timeout(I2C_PORT, I2C_STRETCH_TIMEOUT);
    }
    if (err != ESP_OK) {
        DEBUG_F_ERROR("i2c bus not set up (%s)\n", esp_err_to_name(err));
        return false;
    }
    return true;
}

bool i2c_bus_probe(uint8_t addr) {
    xSemaphoreTake(bus_mutex, portMAX_DELAY);
    i2c_cmd_handle_t cmd = i2c_cmd_link_create();
    i2c_master_start(cmd);
    i2c_master_write_byte(cmd, (addr << 1) | I2C_MASTER_WRITE, true);
    i2c_master_stop(cmd);
    esp_err_t err = i2c_master_cmd_begin(I2C_PORT, cmd, pdMS_TO_TICKS(I2C_TIMEOUT_MS));
    i2c_cmd_link_delete(cmd);
    xSemaphoreGive(bus_mutex);
    return err == ESP_OK;
}

bool i2c_bus_write(uint8_t addr, const uint8_t *data, size_t len) {
    xSemaphoreTake(bus_mutex, portMAX_DELAY);
    esp_err_t err = i2c_master_write_to_device(I2C_PORT, addr, data, len, pdMS_TO_TICKS(I2C_TIMEOUT_MS));
    xSemaphoreGive(bus_mutex);
    return err == ESP_OK;
}

bool i2c_bus_read(uint8_t addr, uint8_t *data, size_t len) {
    xSemaphoreTake(bus_mutex, portMAX_DELAY);
    esp_err_t err = i2c_master_read_from_device(I2C_PORT, addr, data, len, pdMS_TO_TICKS(I2C_TIMEOUT_MS));
    xSemaphoreGive(bus_mutex);
    return err == ESP_OK;
}

bool i2c_bus_write_reg(uint8_t addr, uint8_t reg, uint8_t value) {
    uint8_t data[2] = {reg, value};
    return i2c_bus_write(addr, data, sizeof(data));
}

bool i2c_bus_read_reg(uint8_t addr, uint8_t reg, uint8_t *value) {
    xSemaphoreTake(bus_mutex, portMAX_DELAY);
    esp_err_t err = i2c_master_write_read_device(I2C_PORT, addr, &reg, 1, value, 1, pdMS_TO_TICKS(I2C_TIMEOUT_MS));
    xSemaphoreGive(bus_mutex);
    return err == ESP_OK;
}
