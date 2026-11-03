// tests/unit/device.test.mjs — design §22.1 devicePolicy table (§16.A row) + design_accepted DA-5 (no wasmTierKey).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { devicePolicy } from '../../site/src/ui/device.mjs';

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';

const IOS_ROW = { isIOS: true, touch: true, lowMemory: true, maxSeconds: 360, keepWorkerAfterResult: false, parallelEncode: false };
const DESKTOP_ROW = { isIOS: false, touch: false, lowMemory: false, maxSeconds: 900, keepWorkerAfterResult: true, parallelEncode: true };

test('iPhone 14 UA → the iOS row', () => {
  assert.deepEqual(devicePolicy({ userAgent: IPHONE_UA, maxTouchPoints: 5 }), IOS_ROW);
});

test('iPad UA → the iOS row', () => {
  assert.deepEqual(devicePolicy({ userAgent: IPAD_UA, maxTouchPoints: 5 }), IOS_ROW);
});

test('iPadOS desktop-mode UA (Macintosh + maxTouchPoints 5) → isIOS', () => {
  assert.deepEqual(devicePolicy({ userAgent: MAC_UA, maxTouchPoints: 5 }), IOS_ROW);
});

test('macOS Safari (Macintosh, maxTouchPoints 0) → desktop policy', () => {
  assert.deepEqual(devicePolicy({ userAgent: MAC_UA, maxTouchPoints: 0 }), DESKTOP_ROW);
});

test('Windows Chrome → desktop, touch false', () => {
  assert.deepEqual(devicePolicy({ userAgent: WIN_UA, maxTouchPoints: 0, platform: 'Win32' }), DESKTOP_ROW);
});

test('Android Chrome → touch true but the desktop memory policy', () => {
  assert.deepEqual(devicePolicy({ userAgent: ANDROID_UA, maxTouchPoints: 5 }), { ...DESKTOP_ROW, touch: true });
});

test('missing maxTouchPoints → 0; missing everything → desktop', () => {
  assert.deepEqual(devicePolicy({ userAgent: WIN_UA }), DESKTOP_ROW);
  assert.deepEqual(devicePolicy(), DESKTOP_ROW);
  assert.deepEqual(devicePolicy({ userAgent: MAC_UA, maxTouchPoints: undefined }), DESKTOP_ROW);
});

test('DA-5: the policy has no wasmTierKey and exactly the six documented keys', () => {
  const p = devicePolicy({ userAgent: IPHONE_UA, maxTouchPoints: 5 });
  assert.ok(!('wasmTierKey' in p));
  assert.deepEqual(Object.keys(p).sort(), ['isIOS', 'keepWorkerAfterResult', 'lowMemory', 'maxSeconds', 'parallelEncode', 'touch']);
});
