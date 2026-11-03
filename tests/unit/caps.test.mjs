// tests/unit/caps.test.mjs — design §7.1 / §22.2 probe (§16.A row) + design_accepted DA-7 (hq off on lowMemory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIMD_PROBE, probeSimd, probeCaps, isSoftwareAdapter } from '../../site/src/ui/caps.mjs';
import { makeGpuFake } from '../lib/fakes.mjs';
import { devicePolicy } from '../../site/src/ui/device.mjs';

const desktop = devicePolicy({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156', maxTouchPoints: 0 });
const ios = devicePolicy({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)', maxTouchPoints: 5 });
const HQ_MANIFEST = { tiers: { standard: {}, hq: { webgpu: 'x' } } };

test('SIMD probe validates on Node 25 and fails with the v128 opcode byte flipped', () => {
  assert.equal(SIMD_PROBE.length, 31);
  assert.equal(probeSimd(), true);
  assert.equal(WebAssembly.validate(SIMD_PROBE), true);
  const flipped = SIMD_PROBE.slice();
  const idx = flipped.lastIndexOf(0xfd);                 // the second 0xfd prefix (v128.any_true / 0xfd 0x62)
  flipped[idx] = 0x10;
  assert.equal(WebAssembly.validate(flipped), false);
  assert.equal(probeSimd(WebAssembly, flipped), false);
  assert.equal(probeSimd(null), false);
  assert.equal(probeSimd({ validate: () => { throw new Error('x'); } }), false);
});

test('gpu undefined → backend wasm, hq false, adapterInfo null', async () => {
  const c = await probeCaps({ navigatorLike: { hardwareConcurrency: 8 }, query: {}, manifest: HQ_MANIFEST, policy: desktop, crossOriginIsolated: true });
  assert.equal(c.hasGpu, false);
  assert.equal(c.backend, 'wasm');
  assert.equal(c.hq, false);
  assert.equal(c.adapterInfo, null);
  assert.equal(c.threads, 8);
  assert.equal(c.simd, true);
  assert.deepEqual(c.policy, desktop);
});

test('adapter without shader-f16 → webgpu but hq false', async () => {
  const gpu = makeGpuFake({ features: [] });
  const c = await probeCaps({ navigatorLike: { gpu, hardwareConcurrency: 4 }, query: {}, manifest: HQ_MANIFEST, policy: desktop, crossOriginIsolated: true });
  assert.equal(c.backend, 'webgpu');
  assert.equal(c.f16, false);
  assert.equal(c.hq, false);
  assert.deepEqual(c.adapterInfo, { vendor: 'fake', architecture: 'test' });
});

test('f16 + sbs 16 + tiers.hq → hq true on the desktop policy', async () => {
  const gpu = makeGpuFake({ features: ['shader-f16'], limits: { maxStorageBuffersPerShaderStage: 16 } });
  const c = await probeCaps({ navigatorLike: { gpu, hardwareConcurrency: 4 }, query: {}, manifest: HQ_MANIFEST, policy: desktop, crossOriginIsolated: true });
  assert.equal(c.backend, 'webgpu');
  assert.equal(c.sbs, 16);
  assert.equal(c.hq, true);
});

test('DA-7: the same adapter with policy.lowMemory true → hq FALSE', async () => {
  const gpu = makeGpuFake({ features: ['shader-f16'], limits: { maxStorageBuffersPerShaderStage: 16 } });
  const c = await probeCaps({ navigatorLike: { gpu, hardwareConcurrency: 4 }, query: {}, manifest: HQ_MANIFEST, policy: ios, crossOriginIsolated: true });
  assert.equal(c.backend, 'webgpu');
  assert.equal(c.f16, true);
  assert.equal(c.hq, false);
});

test('no tiers.hq in the manifest (or no manifest) → hq false even with f16', async () => {
  const gpu = makeGpuFake({ features: ['shader-f16'], limits: { maxStorageBuffersPerShaderStage: 16 } });
  const a = await probeCaps({ navigatorLike: { gpu }, query: {}, manifest: { tiers: { standard: {} } }, policy: desktop, crossOriginIsolated: true });
  assert.equal(a.hq, false);
  const b = await probeCaps({ navigatorLike: { gpu }, query: {}, manifest: null, policy: desktop, crossOriginIsolated: true });
  assert.equal(b.hq, false);
});

test('SwiftShader-like adapter info → software true → wasm; ?backend=webgpu overrides', async () => {
  const gpu = makeGpuFake({ info: { vendor: 'google', architecture: 'swiftshader' } });
  const c = await probeCaps({ navigatorLike: { gpu, hardwareConcurrency: 4 }, query: {}, manifest: HQ_MANIFEST, policy: desktop, crossOriginIsolated: true });
  assert.equal(c.software, true);
  assert.equal(c.backend, 'wasm');
  assert.equal(c.hq, false);
  const o = await probeCaps({ navigatorLike: { gpu, hardwareConcurrency: 4 }, query: { backend: 'webgpu' }, manifest: HQ_MANIFEST, policy: desktop, crossOriginIsolated: true });
  assert.equal(o.backend, 'webgpu');
  assert.equal(isSoftwareAdapter({ vendor: 'intel', architecture: 'gen-12lp' }), false);
  assert.equal(isSoftwareAdapter({ vendor: 'Google Inc.', architecture: 'SwiftShader' }), true);
});

test('?backend=wasm overrides a hardware adapter; junk query values are ignored', async () => {
  const gpu = makeGpuFake();
  const w = await probeCaps({ navigatorLike: { gpu }, query: { backend: 'wasm' }, manifest: null, policy: desktop, crossOriginIsolated: false });
  assert.equal(w.backend, 'wasm');
  const j = await probeCaps({ navigatorLike: { gpu }, query: { backend: 'cuda' }, manifest: null, policy: desktop, crossOriginIsolated: false });
  assert.equal(j.backend, 'webgpu');
});

test('threads: hardwareConcurrency undefined → 1; crossOriginIsolated false → 1; capped at 8', async () => {
  const a = await probeCaps({ navigatorLike: {}, query: {}, manifest: null, policy: desktop, crossOriginIsolated: true });
  assert.equal(a.threads, 1);
  const b = await probeCaps({ navigatorLike: { hardwareConcurrency: 12 }, query: {}, manifest: null, policy: desktop, crossOriginIsolated: false });
  assert.equal(b.threads, 1);
  assert.equal(b.isolated, false);
  const c = await probeCaps({ navigatorLike: { hardwareConcurrency: 12 }, query: {}, manifest: null, policy: desktop, crossOriginIsolated: true });
  assert.equal(c.threads, 8);
});

test('requestAdapter rejecting or returning null → wasm without throwing', async () => {
  const a = await probeCaps({ navigatorLike: { gpu: { requestAdapter: async () => null } }, query: {}, manifest: null, policy: desktop, crossOriginIsolated: true });
  assert.equal(a.backend, 'wasm');
  assert.equal(a.hasGpu, true);
  const b = await probeCaps({ navigatorLike: { gpu: { requestAdapter: async () => { throw new Error('nope'); } } }, query: {}, manifest: null, policy: desktop, crossOriginIsolated: true });
  assert.equal(b.backend, 'wasm');
});
