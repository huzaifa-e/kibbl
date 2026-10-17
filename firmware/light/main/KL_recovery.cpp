#include "KL_recovery.h"

#include <user_interface.h>

#include "KL_serial.h"

#define RTC_MAGIC  0x4b4c5243 // "KLRC"
#define RTC_OFFSET 32         // in 4 byte blocks of the user RTC memory, clear of the core's own

typedef struct {
    uint32_t magic;
    uint32_t crashes;
} rtc_count_t;

static bool safe_mode = false;
static bool confirmed = false;

static void write_count(uint32_t crashes) {
    rtc_count_t count = {RTC_MAGIC, crashes};
    ESP.rtcUserMemoryWrite(RTC_OFFSET, (uint32_t *)&count, sizeof(count));
}

void recovery_boot_check(void) {
    rtc_count_t count;
    if (!ESP.rtcUserMemoryRead(RTC_OFFSET, (uint32_t *)&count, sizeof(count)) || count.magic != RTC_MAGIC) {
        count.crashes = 0; // a power up: the RTC memory holds nothing yet
    }

    uint32_t reason = ESP.getResetInfoPtr()->reason;
    bool crash      = reason == REASON_WDT_RST || reason == REASON_EXCEPTION_RST || reason == REASON_SOFT_WDT_RST;
    count.crashes   = crash ? count.crashes + 1 : 0;
    write_count(count.crashes);

    if (count.crashes >= RECOVERY_CRASHES) {
        safe_mode = true;
        DEBUG_F_ERROR("%u crashes in a row: safe mode, only the network and updates run\n", (unsigned)count.crashes);
    } else if (crash) {
        DEBUG_F_ERROR("restarted after a crash (%s)\n", ESP.getResetReason().c_str());
    }
}

bool recovery_active(void) {
    return safe_mode;
}

void recovery_confirm(void) {
    if (!confirmed) {
        confirmed = true;
        write_count(0);
    }
}
