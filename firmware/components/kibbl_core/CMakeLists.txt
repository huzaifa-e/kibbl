# The part every kibbl. firmware shares (docs/architecture.md): the server link, the
# command set, wifi, ota, nvs and the serial port. A product implements KL_product.h
# and KL_status_led.h in its main component.
idf_component_register(SRCS "KL_commands.c" "KL_config.c" "KL_nvs.c" "KL_ota.c" "KL_serial.c" "KL_stream.c" "KL_time.c" "KL_wifi_prov.c"
                    INCLUDE_DIRS "."
                    REQUIRES driver esp_event esp_http_client esp_https_ota esp_netif esp_timer esp_wifi json mbedtls nvs_flash wifi_provisioning app_update)

target_compile_options(${COMPONENT_LIB} PRIVATE "-Wformat" "-Wno-format-zero-length" "-Wextra" "-Wno-unused-parameter")
