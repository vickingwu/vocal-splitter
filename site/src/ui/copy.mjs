// site/src/ui/copy.mjs — every user-visible string in one place (design §12.3). Functional copy only; no disclaimers,
// credits, banners or reassurance (brief §1.10, enforced by tests/lib/forbidden.mjs + copy.test.mjs). Pure: no globals.

export const STATIC = Object.freeze({
  title: '人声分离',
  loginUser: '账号',
  loginPass: '密码',
  loginSubmit: '登录',
  logout: '退出',
  loginError: '账号或密码错误',
  dropDesktop: '拖入音频文件，或点击选择',
  dropTouch: '点击选择音频文件',
  formats: 'mp3 / wav / m4a / aac / flac / ogg / opus',
  urlPlaceholder: '粘贴音频文件直链（如 https://example.com/song.mp3）',
  urlLoad: '读取链接',
  model: '模型',
  standard: '标准',
  hq: '高质量',
  denoise: '降噪（两次推理，耗时约翻倍）',
  start: '开始',
  cancel: '取消',
  vocals: '人声',
  instrumental: '伴奏',
  dlMp3: '下载 MP3',
  dlWav: '下载 WAV',
  keepAwake: '处理中请保持屏幕亮起',
  backendPrefix: '运行方式：',
});

const MB = 1024 * 1024;

// ⌊s/60⌋:⌊s mod 60⌋ with two-digit seconds (1052 → 17:32). Callers pass floor (file line) or ceil (TOO_LONG).
export function mmss(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

export function formatMB(bytes) {
  const b = Math.max(0, Number(bytes) || 0);
  if (b < 10 * MB) return `${(b / MB).toFixed(1)} MB`;
  return `${Math.round(b / MB)} MB`;
}

// 「WebGPU」 | 「WASM · 8 线程」
export function backendLabel(name, threads) {
  return name === 'webgpu' ? 'WebGPU' : `WASM · ${Math.max(1, Number(threads) || 1)} 线程`;
}

// 「运行方式：WebGPU」 | 「运行方式：WASM · 8 线程」
export function backendLine(name, threads) {
  return STATIC.backendPrefix + backendLabel(name, threads);
}

// Drop-zone hint: desktop keeps the drag clause, touch devices do not; the limit comes from the device policy (§22.1).
export function dropZoneHint(maxSeconds, touch) {
  const limitMin = Math.round((Number(maxSeconds) || 900) / 60);
  return `${touch ? STATIC.dropTouch : STATIC.dropDesktop} · ${STATIC.formats} · 最长 ${limitMin} 分钟`;
}

// 「<文件名> · 3:47」 (floor)
export function fileLine(name, seconds) {
  return `${name} · ${mmss(Math.floor(Number(seconds) || 0))}`;
}

export const progress = Object.freeze({
  downloadLink: (doneBytes, totalBytes, s) => (totalBytes
    ? `正在下载链接 · ${formatMB(doneBytes)} / ${formatMB(totalBytes)} · ${s}s`
    : `正在下载链接 · ${formatMB(doneBytes)} · ${s}s`),
  decoding: (s) => `正在解码音频 · ${s}s`,
  downloadModel: (i, n, doneBytes, totalBytes, s) => `正在下载模型 ${i}/${n} · ${formatMB(doneBytes)} / ${formatMB(totalBytes)} · ${s}s`,
  verify: (s) => `正在校验模型 · ${s}s`,
  init: (label, s) => `正在初始化（${label}）· ${s}s`,
  separating: (i, n, label, s) => (label
    ? `分离中 ${i}/${n} 段 · ${label} · ${s}s`
    : `分离中 ${i}/${n} 段 · ${s}s`),
  finalize: (s) => `正在合成 · ${s}s`,
  encoding: (v, i, s) => `正在编码 MP3 · 人声 ${v}% · 伴奏 ${i}% · ${s}s`,
  done: (s) => `用时 ${s}s`,
  encodingButton: (pct) => `MP3 编码中 ${pct}%`,
});

export const ERROR_COPY = Object.freeze({
  LOGIN_FAILED: '账号或密码错误',
  UNSUPPORTED: '当前浏览器不支持 WebAssembly SIMD，无法运行。请使用 iOS 16.4 及以上的 Safari，或桌面 Chrome / Edge。',
  TOO_LONG: (d) => `文件超过 ${Math.round((d.maxSeconds ?? 900) / 60)} 分钟（当前 ${mmss(Math.ceil(d.seconds))}）。请裁剪后重试。`,
  TOO_LARGE: '文件超过 200 MB。请裁剪后重试。',
  DECODE: '无法解码该文件。请转换为 MP3 或 WAV 后重试。',
  URL_PLATFORM: '暂不支持平台页面链接，仅支持直接指向音频文件的链接。',
  URL_INVALID: '链接无效。请粘贴以 http(s):// 开头的音频文件直链。',
  URL_FETCH: '链接无法下载。请下载后用本地上传。',
  URL_STATUS: (d) => `链接返回 ${d.status}。请检查链接，或下载后用本地上传。`,
  URL_NOT_AUDIO: '链接返回的是网页而不是音频。请下载后用本地上传。',
  URL_TOO_LARGE: '链接文件超过 200 MB。请下载后裁剪再上传。',
  MODEL_DOWNLOAD: (d) => `模型下载失败（第 ${d.chunkIndex + 1}/${d.chunkCount} 块）。请检查网络后重试。`,
  MODEL_HASH: '模型校验失败。请刷新页面重试。',
  MANIFEST: '模型清单无效。请刷新页面重试。',
  SESSION: '模型初始化失败。请刷新页面重试。',
  OOM: '内存不足，分离中断。请使用较短的音频重试。',
  GPU_ONLY_MODEL: 'GPU 不可用，高质量模型无法运行。请改用「标准」模型。',
  MP3: 'MP3 编码失败。请下载 WAV。',
  CANCELLED: '已取消。',
});

export const DEFAULT_ERROR_COPY = '分离失败。请刷新页面重试。';

export function codeToCopy(code, detail = {}) {
  const entry = ERROR_COPY[code];
  if (entry === undefined) return DEFAULT_ERROR_COPY;
  return typeof entry === 'function' ? entry(detail ?? {}) : entry;
}

// Every static string (for the forbidden-phrase scan).
export function allStaticStrings() {
  const out = Object.values(STATIC).slice();
  for (const v of Object.values(ERROR_COPY)) if (typeof v === 'string') out.push(v);
  out.push(DEFAULT_ERROR_COPY);
  return out;
}
