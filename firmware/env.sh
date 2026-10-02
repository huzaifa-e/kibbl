#!/bin/bash
# source firmware/env.sh: ESP-IDF v5.1.6, the version ESW0009 is built with.
# IDF_PATH and IDF_PYTHON_ENV_PATH may be set beforehand to use another install.

export IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf-field}"
if [ -z "$IDF_PYTHON_ENV_PATH" ] && [ -d "$HOME/.espressif/python_env/idf5.1_py3.10_env" ]; then
    # the default python3 can be newer than any installed idf python environment
    export IDF_PYTHON_ENV_PATH="$HOME/.espressif/python_env/idf5.1_py3.10_env"
fi

. "$IDF_PATH/export.sh" > /dev/null

# export.sh adds only the toolchains of the targets idf was installed for
if ! command -v xtensa-esp32-elf-gcc > /dev/null; then
    for dir in "$HOME"/.espressif/tools/xtensa-esp32-elf/*/xtensa-esp32-elf/bin; do
        [ -d "$dir" ] && export PATH="$dir:$PATH"
    done
fi
