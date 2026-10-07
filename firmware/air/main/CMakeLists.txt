# WHOLE_ARCHIVE: kibbl_core calls the product hooks (KL_product.c), which nothing in
# main calls itself, so the linker would drop them otherwise
idf_component_register(SRC_DIRS "."
                    INCLUDE_DIRS "."
                    WHOLE_ARCHIVE)

target_compile_options(${COMPONENT_LIB} PRIVATE "-Wformat" "-Wno-format-zero-length" "-Wextra" "-Wno-unused-parameter")
