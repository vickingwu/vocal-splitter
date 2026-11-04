// tests/unit/normalize.test.mjs — design §16.A row `normalize.test.mjs` (joint peak over L/R, §3.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakOf, scaleDownToPeak, scrubNonFinite } from '../../site/src/engine/normalize.mjs';
import { EngineError, ERROR_CODES, classifyAllocationFailure } from '../../site/src/engine/errors.mjs';

test('peakOf is the joint max|x| over both channels', () => {
  assert.equal(peakOf(new Float32Array([0.1, -0.7, 0.2]), new Float32Array([0.3, 0.4])), Math.fround(0.7));
  assert.equal(peakOf(new Float32Array([0.1, 0.2]), new Float32Array([-0.95, 0.4])), Math.fround(0.95));
  assert.equal(peakOf(new Float32Array(0), new Float32Array(0)), 0);
  assert.equal(peakOf(new Float32Array([0, 0]), new Float32Array([0, 0])), 0);
});

test('peakOf ignores NaN and ±Infinity', () => {
  assert.equal(peakOf(new Float32Array([NaN, 0.5]), new Float32Array([Infinity, -Infinity])), 0.5);
  assert.equal(peakOf(new Float32Array([NaN]), new Float32Array([NaN])), 0);
});

test('scaleDownToPeak is a no-op at or below the target and scales both channels jointly above it', () => {
  const l = new Float32Array([0.9, -0.5]), r = new Float32Array([0.3, 0.1]);
  assert.equal(scaleDownToPeak(l, r, 0.9), 1);
  assert.deepEqual(Array.from(l), [Math.fround(0.9), Math.fround(-0.5)]);
  const l2 = new Float32Array([0.45, -0.3]), r2 = new Float32Array([0.2, 0.1]);
  scaleDownToPeak(l2, r2, 0.9);
  assert.deepEqual(Array.from(l2), [Math.fround(0.45), Math.fround(-0.3)]);
  const l3 = new Float32Array([1.8, -0.9]), r3 = new Float32Array([0.9, 0.45]);
  scaleDownToPeak(l3, r3, 0.9);
  assert.ok(Math.abs(l3[0] - 0.9) < 1e-7 && Math.abs(l3[1] + 0.45) < 1e-7);
  assert.ok(Math.abs(r3[0] - 0.45) < 1e-7 && Math.abs(r3[1] - 0.225) < 1e-7);
});

test('L peak 1.0 / R peak 0.5 → both channels scaled by 0.9, R peak becomes 0.45 (never 0.9)', () => {
  const l = new Float32Array([1.0, -0.2, 0.3]), r = new Float32Array([0.5, -0.25, 0.1]);
  const factor = scaleDownToPeak(l, r, 0.9);
  assert.ok(Math.abs(factor - 0.9) < 1e-12);
  assert.ok(Math.abs(peakOf(l, new Float32Array(0)) - 0.9) < 1e-7);
  assert.ok(Math.abs(peakOf(new Float32Array(0), r) - 0.45) < 1e-7, `R peak ${peakOf(new Float32Array(0), r)}`);
  assert.ok(Math.abs(r[0] - 0.45) < 1e-7 && Math.abs(r[1] + 0.225) < 1e-7 && Math.abs(r[2] - 0.09) < 1e-7);
});

test('zero input is left untouched', () => {
  const l = new Float32Array(4), r = new Float32Array(4);
  assert.equal(scaleDownToPeak(l, r, 0.9), 1);
  assert.deepEqual(Array.from(l), [0, 0, 0, 0]);
});

test('scrubNonFinite replaces NaN/±Inf with 0 and returns the count', () => {
  const a = new Float32Array([1, NaN, -Infinity, 0.5, Infinity]);
  assert.equal(scrubNonFinite(a), 3);
  assert.deepEqual(Array.from(a), [1, 0, 0, 0.5, 0]);
  assert.equal(scrubNonFinite(new Float32Array([1, 2])), 0);
});

test('D1 pre-scale: x · (0.9 / peak0) on a unity-peak input gives joint peak 0.9', () => {
  const l = new Float32Array([1.0, 0.5]), r = new Float32Array([-0.25, 0.0]);
  const peak0 = peakOf(l, r);
  assert.equal(peak0, 1.0);
  const s = 0.9 / peak0;
  for (let i = 0; i < l.length; i++) { l[i] *= s; r[i] *= s; }
  assert.ok(Math.abs(peakOf(l, r) - 0.9) < 1e-7);
});

test('errors.mjs: EngineError shape, closed code list, classifyAllocationFailure', () => {
  const e = new EngineError('MODEL_HASH', 'bad chunk', { chunkIndex: 1, chunkCount: 3, file: 'model' });
  assert.equal(e.name, 'EngineError');
  assert.equal(e.code, 'MODEL_HASH');
  assert.ok(e instanceof Error);
  assert.deepEqual(e.toJSON(), { code: 'MODEL_HASH', message: 'bad chunk', detail: { chunkIndex: 1, chunkCount: 3, file: 'model' } });
  assert.deepEqual(JSON.parse(JSON.stringify(e)), { code: 'MODEL_HASH', message: 'bad chunk', detail: { chunkIndex: 1, chunkCount: 3, file: 'model' } });
  assert.equal(new EngineError('CANCELLED').message, 'CANCELLED');
  assert.equal(ERROR_CODES.length, 28);
  for (const c of ['LOGIN_FAILED', 'UNSUPPORTED', 'TOO_LARGE', 'DECODE', 'TOO_LONG', 'URL_PLATFORM', 'URL_INVALID', 'URL_FETCH', 'URL_STATUS',
    'URL_NOT_AUDIO', 'URL_TOO_LARGE', 'MANIFEST', 'MODEL_DOWNLOAD', 'MODEL_HASH', 'IMPORT_STORE', 'GPU_ONLY_MODEL', 'SESSION', 'OOM', 'INFERENCE', 'MODEL_IO',
    'NUMERIC', 'MP3', 'CANCELLED', 'WORKER', 'INTERNAL', 'GPU_LOST', 'FFT_SIZE', 'FALLBACK']) assert.ok(ERROR_CODES.includes(c), c);
  assert.ok(Object.isFrozen(ERROR_CODES));
  assert.equal(classifyAllocationFailure(new RangeError('Array buffer allocation failed')), 'OOM');
  assert.equal(classifyAllocationFailure(new RangeError('Invalid array length')), 'OOM');
  assert.equal(classifyAllocationFailure(new Error('Cannot enlarge memory arrays')), 'OOM');
  assert.equal(classifyAllocationFailure(new Error('memory access out of bounds')), 'OOM');
  assert.equal(classifyAllocationFailure(new Error('out of memory')), 'OOM');
  assert.equal(classifyAllocationFailure({ message: 'RangeError: something' }), 'OOM');
  assert.equal(classifyAllocationFailure(new TypeError('boom')), null);
  assert.equal(classifyAllocationFailure(new EngineError('INFERENCE', 'x')), null);
  assert.equal(classifyAllocationFailure(null), null);
  assert.equal(classifyAllocationFailure(undefined), null);
  assert.equal(classifyAllocationFailure('allocation failed'), 'OOM');
});
