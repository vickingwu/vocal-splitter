// site/src/engine/session.mjs — design §5 / §8: the ONE session factory used everywhere. Never touches ort.env
// (worker.mjs owns the only ort.env writes). Runtime-agnostic: `ort` is injected (onnxruntime-web or onnxruntime-node).
import { EngineError } from './errors.mjs';

export async function createSession(ort, { backend, bytes, externalData, device, cacheMode = 'simple' }) {
  if (!ort || !ort.InferenceSession || typeof ort.InferenceSession.create !== 'function') {
    throw new EngineError('INTERNAL', 'createSession: ort.InferenceSession.create is missing');
  }
  if (!(bytes instanceof Uint8Array)) throw new EngineError('INTERNAL', 'createSession: bytes must be a Uint8Array');
  let executionProviders;
  switch (backend) {
    case 'webgpu':
      executionProviders = [{ name: 'webgpu', ...(device ? { device } : {}), storageBufferCacheMode: cacheMode }];
      break;
    case 'wasm': executionProviders = ['wasm']; break;
    case 'cpu': executionProviders = ['cpu']; break;
    default: throw new EngineError('INTERNAL', `createSession: unknown backend ${backend}`, { backend });
  }
  const opts = {
    executionProviders,
    graphOptimizationLevel: 'all',
    ...(externalData ? { externalData: [{ path: externalData.path, data: externalData.data }] } : {}),
  };
  return ort.InferenceSession.create(bytes, opts);
}
