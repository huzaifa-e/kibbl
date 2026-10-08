import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNewer } from '../../../shared/firmware';

test('a release is newer by its version number, never an older one', () => {
    assert.equal(isNewer('KIBBL-AIR-1.2.0-8858b7f9', 'KIBBL-AIR-1.1.0-8c8280c0'), true);
    assert.equal(isNewer('KIBBL-AIR-1.2.0-8858b7f9', 'KIBBL-AIR-1.10.0-aaaaaaaa'), false);
    assert.equal(isNewer('KIBBL-AIR-1.2.0-8858b7f9', 'KIBBL-AIR-1.2.0-8858b7f9'), false);
    // the same number, another build (a local WIP): not newer
    assert.equal(isNewer('KIBBL-AIR-1.2.0-8858b7f9', 'KIBBL-AIR-1.2.0-WIP'), false);
    // a camera without numbers: any other build
    assert.equal(isNewer('KIBBL-6c8f35e6', 'KIBBL-11111111'), true);
    assert.equal(isNewer('KIBBL-AIR-1.2.0-8858b7f9', undefined), true);
});
