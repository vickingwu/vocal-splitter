// tests/unit/eta.test.mjs — FIX-2 R4/R5: the download rate meter (5 s moving average, ETA after 3 s, decay on a stall,
// reset on a byte-count restart) and the separation ETA (median of the last <= 5 chunk durations × remaining chunks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateMeter, separationEta, median } from '../../site/src/ui/eta.mjs';

test('rate meter: no rate before two samples, exact average over the window, ETA only after 3 s', () => {
  const m = createRateMeter();
  assert.equal(m.rate(0), null);
  assert.equal(m.eta(0, 1000), null);
  m.sample(0, 0);
  assert.equal(m.rate(0), null, 'one sample');
  m.sample(1000, 300000);
  assert.equal(m.rate(1000), 300000, '300 KB in 1 s');
  assert.equal(m.eta(1000, 600000), null, 'before the 3 s warm-up');
  m.sample(2000, 600000);
  m.sample(3000, 900000);
  assert.equal(m.rate(3000), 300000);
  assert.equal(m.eta(3000, 900000), 3, 'remaining / rate in seconds');
});

test('rate meter: samples older than 5 s leave the window; a stalled link decays towards zero and the ETA disappears', () => {
  const m = createRateMeter();
  for (let t = 0; t <= 10000; t += 1000) m.sample(t, t * 100);     // 100 KB/s for 10 s
  assert.equal(m.rate(10000), 100000);
  // stall: the byte count stops while the clock runs → the window (7 s … 13 s, one sample kept outside the 5 s) holds 300 KB over 6 s
  m.sample(12000, 1000000);
  m.sample(13000, 1000000);
  assert.equal(m.rate(13000), 50000, 'decaying');
  m.sample(20000, 1000000);
  m.sample(25000, 1000000);
  assert.equal(m.rate(25000), 0, 'only stalled samples left in the window');
  assert.equal(m.eta(25000, 5000), null, 'no ETA without a positive rate');
});

test('rate meter: a byte count below every sample (new job) restarts the window and the warm-up; reset() clears everything', () => {
  const m = createRateMeter();
  m.sample(0, 5000); m.sample(1000, 6000); m.sample(2000, 7000); m.sample(3000, 8000);   // a resumed job starting at 5000 bytes
  assert.equal(m.rate(3000), 1000);
  m.sample(4000, 100);                      // restart at 100 bytes
  assert.equal(m.rate(4000), null, 'window cleared');
  m.sample(5000, 600);
  assert.equal(m.rate(5000), 500);
  assert.equal(m.eta(5000, 500), null, 'warm-up restarted with the window');
  m.sample(7000, 1600); m.sample(7500, 1850);
  assert.ok(m.eta(7500, 500) > 0);
  m.reset();
  assert.equal(m.rate(7500), null);
});

test('rate meter: a smaller byte count mid-download (a failed request gave up its in-flight bytes) drops only the samples it contradicts; no 0 KB/s blip', () => {
  const m = createRateMeter();
  for (let t = 0; t <= 4000; t += 1000) m.sample(t, t * 100);        // 0, 100 K, 200 K, 300 K, 400 K
  m.sample(4200, 460000);                                             // in-flight bytes counted …
  m.sample(4400, 350000);                                             // … then given up: back to 350 K
  assert.equal(m.rate(4400), (350000 - 0) / 4.4, 'the samples at 400 K and 460 K are gone, the older history stays');
  assert.equal(m.eta(4400, 100000), 100000 / ((350000) / 4.4), 'the warm-up did not restart');
  // the old behaviour emptied the window; the next tick without new bytes then read 0 KB/s
  m.sample(5000, 350000);
  assert.ok(m.rate(5000) > 0);
});

test('rate meter: the wait before the first byte (source probe) is not transfer time: no speed, no ETA, and the window starts at the last sample before the bytes moved', () => {
  const m = createRateMeter();
  m.sample(0, 0); m.sample(250, 0); m.sample(1000, 0); m.sample(2400, 0);
  assert.equal(m.rate(2400), null, 'nothing downloaded yet');
  m.sample(5000, 0); m.sample(5500, 0);
  assert.equal(m.rate(5500), null, 'still nothing: no 0 KB/s either');
  m.sample(6000, 100000);                   // the first bytes, 4 s probe + 2 s in flight so far
  assert.equal(m.rate(6000), 100000 / 0.5, 'measured from the last sample before the bytes moved (5500), not from 0');
  assert.equal(m.eta(6000, 1000000), null, 'the warm-up starts at 5500, not at 0');
  m.sample(7000, 300000); m.sample(8000, 500000); m.sample(8500, 600000);
  assert.equal(m.eta(8500, 600000), 600000 / (600000 / 3), 'ETA 3 s after the bytes moved');
  // a stall mid-download decays to 0 over the window
  const s = createRateMeter();
  s.sample(0, 0); s.sample(1000, 100000); s.sample(2000, 200000);
  for (let t = 3000; t <= 8000; t += 1000) s.sample(t, 200000);
  assert.equal(s.rate(8000), 0, 'six seconds without new bytes after a transfer reads 0 KB/s');
  // a restart below every sample: the clock tick before the next progress event does not read 0 KB/s
  const m2 = createRateMeter();
  m2.sample(0, 1000); m2.sample(1000, 2000); m2.sample(2000, 3000);
  m2.sample(2100, 500);
  m2.sample(2300, 500);
  assert.equal(m2.rate(2300), null, 'not 0 KB/s');
  assert.equal(m2.eta(2600, 1000), null, 'warm-up not started');
  m2.sample(2600, 1500);
  assert.equal(m2.rate(2600), 1000 / 0.3, 'from the tick just before the bytes moved');
});

test('median', () => {
  assert.equal(median([]), null);
  assert.equal(median([5]), 5);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('separationEta: null before two chunks, median of the last <= 5 durations × remaining, 0 when everything is done', () => {
  assert.equal(separationEta([], 69, 0), null);
  assert.equal(separationEta([1000], 69, 0), null);
  assert.equal(separationEta([1000, 2000], 69, 0), 67, 'two 1 s chunks → 67 s for the remaining 67');
  // durations 1, 1, 1, 10 (a slow one), 1, 1 → the last 5 are 1,1,10,1,1 → median 1
  const ends = [1000, 2000, 3000, 13000, 14000, 15000];
  assert.equal(separationEta(ends, 10, 0), 4);
  // the median resists one outlier among the recent five but follows a sustained change: last 5 = 5,5,5,5,5 → 25 s for 5 chunks
  const slow = [1000, 2000, 3000, 8000, 13000, 18000, 23000, 28000];
  assert.equal(separationEta(slow, 13, 0), 25);
  assert.equal(separationEta([1000, 2000], 2, 0), 0);
  assert.equal(separationEta([1000, 2000], NaN, 0), null);
  // the first duration counts from startMs
  assert.equal(separationEta([5000, 6000], 4, 4000), 2);
});
