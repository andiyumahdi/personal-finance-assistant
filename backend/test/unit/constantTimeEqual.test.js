// SPECIFICATION.md section 11.5: shared-secret comparisons must be
// timing-safe AND fail-closed. The historical bug this guards against:
// `provided !== process.env.INTERNAL_CRON_SECRET` returns "match" when
// BOTH sides are undefined, i.e. an unset secret authorized an absent
// header - and the plain !== compare is timing-unsafe.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual } from '../../src/utils/constantTimeEqual.js';
import { isAuthorizedCronRequest } from '../../src/utils/cronAuth.js';

describe('constantTimeEqual (pure)', () => {
  test('equal strings -> true', () => {
    assert.equal(constantTimeEqual('s3cret', 's3cret'), true);
    assert.equal(constantTimeEqual('', ''), true);
  });

  test('unequal strings -> false, including different lengths (no throw)', () => {
    assert.equal(constantTimeEqual('s3cret', 's3cret2'), false);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('', 'x'), false);
  });

  test('fail-closed on non-string inputs instead of throwing', () => {
    assert.equal(constantTimeEqual(undefined, undefined), false);
    assert.equal(constantTimeEqual(undefined, 'secret'), false);
    assert.equal(constantTimeEqual('secret', undefined), false);
    assert.equal(constantTimeEqual(null, null), false);
    assert.equal(constantTimeEqual(12345, 12345), false);
    assert.equal(constantTimeEqual(true, true), false);
  });
});

describe('isAuthorizedCronRequest (fail-closed shared secret)', () => {
  const SECRET = '3bcb55f6c986d0c1f4a7b2e9d8c6a5b4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8';

  test('matching header with configured secret -> authorized', () => {
    assert.equal(isAuthorizedCronRequest(SECRET, SECRET), true);
  });

  test('wrong header -> rejected', () => {
    assert.equal(isAuthorizedCronRequest('nope', SECRET), false);
  });

  test('missing header with configured secret -> rejected', () => {
    assert.equal(isAuthorizedCronRequest(undefined, SECRET), false);
  });

  test('REGRESSION: unset secret + absent header -> rejected (old !== said "match")', () => {
    assert.equal(isAuthorizedCronRequest(undefined, undefined), false);
  });

  test('empty secret never authorizes anything, not even an empty header', () => {
    assert.equal(isAuthorizedCronRequest(undefined, ''), false);
    assert.equal(isAuthorizedCronRequest('', ''), false);
  });

  test('non-string header values are rejected', () => {
    assert.equal(isAuthorizedCronRequest(12345, SECRET), false);
    assert.equal(isAuthorizedCronRequest(['a'], SECRET), false);
  });
});
