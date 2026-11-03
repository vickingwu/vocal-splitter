// site/src/ui/caps.mjs — capability probe (design §7.1, §22.2; design_accepted DA-7: hq is off on lowMemory policies).
// Pure over injected objects so caps.test.mjs can drive it in Node; app.mjs passes the real navigator / query / manifest.

// 30-byte wasm module with one v128 op — the SIMD probe of wasm-feature-detect (MIT).
export const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

export function probeSimd(wasm = globalThis.WebAssembly, bytes = SIMD_PROBE) {
  try { return !!wasm && typeof wasm.validate === 'function' && wasm.validate(bytes) === true; } catch { return false; }
}

// A software rasterizer (SwiftShader) would run Voc_FT for hours; prefer WASM there (§7.1 / §16.C rule).
export function isSoftwareAdapter(info) {
  if (!info) return false;
  const arch = String(info.architecture ?? '');
  const vendor = String(info.vendor ?? '');
  return /swiftshader/i.test(arch) || vendor.toLowerCase() === 'google' || /swiftshader/i.test(vendor);
}

async function adapterInfoOf(adapter) {
  if (!adapter) return null;
  try {
    if (adapter.info) return { vendor: adapter.info.vendor ?? '', architecture: adapter.info.architecture ?? '' };
    if (typeof adapter.requestAdapterInfo === 'function') {
      const i = await adapter.requestAdapterInfo();
      return { vendor: i?.vendor ?? '', architecture: i?.architecture ?? '' };
    }
  } catch { /* fall through */ }
  return { vendor: '', architecture: '' };
}

export async function probeCaps({ navigatorLike = {}, query = {}, manifest = null, policy, crossOriginIsolated = false } = {}) {
  const simd = probeSimd();
  const gpu = navigatorLike.gpu;
  const hasGpu = gpu !== undefined && gpu !== null;
  let adapter = null;
  if (hasGpu && typeof gpu.requestAdapter === 'function') {
    try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
  }
  const adapterInfo = adapter ? await adapterInfoOf(adapter) : null;
  const f16 = adapter ? (adapter.features && typeof adapter.features.has === 'function' ? adapter.features.has('shader-f16') : false) : false;
  const sbs = adapter && adapter.limits && typeof adapter.limits.maxStorageBuffersPerShaderStage === 'number' ? adapter.limits.maxStorageBuffersPerShaderStage : 0;
  const software = adapter != null && isSoftwareAdapter(adapterInfo);
  const isolated = crossOriginIsolated === true;
  const hc = navigatorLike.hardwareConcurrency;
  const threads = isolated ? Math.min((typeof hc === 'number' && hc > 0 ? hc : 1), 8) : 1;
  const override = query.backend === 'webgpu' || query.backend === 'wasm' ? query.backend : undefined;
  const backend = override ?? ((adapter && !software) ? 'webgpu' : 'wasm');
  const lowMemory = policy ? policy.lowMemory === true : false;
  const hq = backend === 'webgpu' && f16 && sbs >= 9 && manifest?.tiers?.hq != null && !lowMemory;
  return { simd, hasGpu, adapterInfo, f16, sbs, software, isolated, threads, backend, hq, policy: policy ?? null };
}
