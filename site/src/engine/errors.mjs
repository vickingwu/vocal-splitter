// site/src/engine/errors.mjs — design §5 / §13.
// EngineError is the only error type that crosses the worker boundary; ERROR_CODES is the closed list of §13.
// Runtime-agnostic: no browser globals.

export const ERROR_CODES = Object.freeze([
  'LOGIN_FAILED', 'UNSUPPORTED', 'TOO_LARGE', 'DECODE', 'TOO_LONG',
  'URL_PLATFORM', 'URL_INVALID', 'URL_FETCH', 'URL_STATUS', 'URL_NOT_AUDIO', 'URL_TOO_LARGE',
  'MANIFEST', 'MODEL_DOWNLOAD', 'MODEL_HASH', 'IMPORT_STORE', 'GPU_ONLY_MODEL', 'SESSION', 'OOM', 'INFERENCE',
  'MODEL_IO', 'NUMERIC', 'MP3', 'CANCELLED', 'WORKER', 'INTERNAL', 'GPU_LOST', 'FFT_SIZE', 'FALLBACK',
]);

export class EngineError extends Error {
  constructor(code, message, detail) {
    super(message === undefined ? code : message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }

  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail };
  }
}

const OOM_RE = /out of memory|allocation failed|Array buffer allocation|RangeError|Cannot enlarge memory|memory access out of bounds/i;

// §5: applied to every caught exception before the INTERNAL wrap so allocation failures surface as OOM.
export function classifyAllocationFailure(err) {
  if (err === null || err === undefined) return null;
  if (typeof err === 'string') return OOM_RE.test(err) ? 'OOM' : null;
  if (err.name === 'RangeError') return 'OOM';
  const message = typeof err.message === 'string' ? err.message : '';
  return OOM_RE.test(message) ? 'OOM' : null;
}
