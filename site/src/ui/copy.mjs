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
  smallModel: '小模型',
  importModel: '导入模型文件',
  importMismatch: '文件与清单不匹配',
});

const MB = 1024 * 1024;

// 「27 KB/s」 below 0.1 MB/s, 「0.3 MB/s」 otherwise
export function formatRate(bytesPerSec) {
  const b = Math.max(0, Number(bytesPerSec) || 0);
  if (b < 0.1 * MB) return `${Math.round(b / 1024)} KB/s`;
  return `${(b / MB).toFixed(1)} MB/s`;
}

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

// 「WebGPU」 | 「WASM · 8 线程」 | 「WASM · 1 线程 · 小模型」 (small = the threads rule resolved the standard tier to wasmLow)
export function backendLabel(name, threads, small = false) {
  if (name === 'webgpu') return 'WebGPU';
  return `WASM · ${Math.max(1, Number(threads) || 1)} 线程${small ? ` · ${STATIC.smallModel}` : ''}`;
}

// 「运行方式：WebGPU」 | 「运行方式：WASM · 8 线程」 | 「运行方式：WASM · 1 线程 · 小模型」
export function backendLine(name, threads, small = false) {
  return STATIC.backendPrefix + backendLabel(name, threads, small);
}

// 「已导入：高质量（213 MB）」 | 「已导入：标准（64 MB）；1 个文件与清单不匹配」 | 「文件与清单不匹配」
export function importResult(imported, mismatched) {
  const parts = (imported ?? []).map((m) => `已导入：${m.displayName}（${formatMB(m.bytes)}）`);
  if (mismatched > 0) parts.push(parts.length ? `${mismatched} 个${STATIC.importMismatch}` : STATIC.importMismatch);
  return parts.join('；');
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
  // 「正在下载模型 · 61 MB / 219 MB · 0.3 MB/s · 预计剩余 8:40」; Tier 2 prefixes 「文件 1/2 · 」; speed/ETA appear once measured
  downloadModel: ({ doneBytes, totalBytes, bytesPerSec = null, etaSec = null, fileIndex = 0, fileCount = 1 }) => {
    let s = '正在下载模型';
    if (fileCount > 1) s += ` · 文件 ${fileIndex + 1}/${fileCount}`;
    s += ` · ${formatMB(doneBytes)} / ${formatMB(totalBytes)}`;
    if (bytesPerSec !== null && bytesPerSec !== undefined) s += ` · ${formatRate(bytesPerSec)}`;
    if (etaSec !== null && etaSec !== undefined && Number.isFinite(etaSec)) s += ` · 预计剩余 ${mmss(Math.ceil(etaSec))}`;
    return s;
  },
  importing: (doneBytes, totalBytes) => `正在导入 · ${formatMB(doneBytes)} / ${formatMB(totalBytes)}`,
  verify: (s) => `正在校验模型 · ${s}s`,
  init: (label, s) => `正在初始化（${label}）· ${s}s`,
  // 「分离中 17/69 段 · 已用 3:05 · 预计剩余 9:40」, with the backend label before 已用 when given (WASM · 1 线程)
  separating: (i, n, label, s, etaSec = null) => {
    let out = `分离中 ${i}/${n} 段`;
    if (label) out += ` · ${label}`;
    out += ` · 已用 ${mmss(s)}`;
    if (etaSec !== null && etaSec !== undefined && Number.isFinite(etaSec)) out += ` · 预计剩余 ${mmss(Math.ceil(etaSec))}`;
    return out;
  },
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
  // 「模型下载失败（已保存 61 MB / 219 MB，刷新后继续）」 — the saved parts survive a reload and are not fetched again
  MODEL_DOWNLOAD: (d) => (Number.isFinite(d.bytesTotal) && d.bytesTotal > 0
    ? `模型下载失败（已保存 ${formatMB(d.bytesSaved ?? 0)} / ${formatMB(d.bytesTotal)}，刷新后继续）`
    : '模型下载失败。请检查网络后重试。'),
  MODEL_HASH: '模型校验失败。请刷新页面重试。',
  // the import wrote nothing: Cache Storage and IndexedDB both refused (private mode, quota) — the files were not kept
  IMPORT_STORE: '导入失败：浏览器存储不可用，文件未保存。',
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
