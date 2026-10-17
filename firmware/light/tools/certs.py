#!/usr/bin/env python3
"""main/KL_certs.h from the certificate bundle of ESP-IDF: the roots kibbl. light trusts, as DER.

tools/certs.py <cacrt_all.pem>  (components/mbedtls/esp_crt_bundle/cacrt_all.pem of ESP-IDF)
"""
import base64
import os
import re
import sys

ROOTS = [
    ('ISRG Root X1', 'isrg_x1'),
    ('ISRG Root X2', 'isrg_x2'),
    ('GTS Root R1', 'gts_r1'),
    ('GTS Root R4', 'gts_r4'),
    ('SSL.com Root Certification Authority RSA', 'sslcom_rsa'),
    ('SSL.com Root Certification Authority ECC', 'sslcom_ecc'),
]

HEADER = '''#ifndef KL_CERTS_H
#define KL_CERTS_H

#include <Arduino.h>

/*
 * The roots TLS to the server is checked against (KL_tls): Let's Encrypt (ISRG Root X1, X2),
 * Google Trust Services (GTS Root R1, R4) and SSL.com, the CAs Cloudflare's edge certificates
 * come from. DER of the certificates in the bundle of ESP-IDF (cacrt_all.pem), valid until
 * 2035 and later; made by firmware/light/tools/certs.py.
 */

'''


def main():
    pem = open(sys.argv[1], encoding='utf-8').read()
    certs = dict(re.findall(r'(^.+?)\n=+\n(-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----)\n', pem, re.M))
    out = HEADER
    for name, ident in ROOTS:
        der = base64.b64decode(re.sub(r'-----[A-Z ]+-----|\s', '', certs[name]))
        out += f'// {name}\nstatic const uint8_t {ident}[] PROGMEM = {{\n'
        for i in range(0, len(der), 16):
            out += '    ' + ', '.join(f'0x{b:02x}' for b in der[i:i + 16]) + ',\n'
        out += '};\n\n'
    out += 'static const struct {\n    const uint8_t *der;\n    size_t len;\n} trust_anchors[] = {\n'
    for _, ident in ROOTS:
        out += f'    {{{ident}, sizeof({ident})}},\n'
    out += '};\n\n#endif /* KL_CERTS_H */\n'
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'main', 'KL_certs.h')
    open(target, 'w', encoding='utf-8').write(out)


if __name__ == '__main__':
    main()
