// site/src/ui/dom.mjs — element lookup and render helpers for app.mjs (design §12.2). No state lives here.
import { STATIC, backendLine as backendLineCopy, dropZoneHint, fileLine as fileLineCopy } from './copy.mjs';

const IDS = {
  login: 'login', loginUser: 'login-user', loginPass: 'login-pass', loginSubmit: 'login-submit', loginError: 'login-error',
  app: 'app', logout: 'logout',
  dropZone: 'drop-zone', dropHint: 'drop-hint', fileName: 'file-name', fileInput: 'file-input',
  urlInput: 'url-input', urlLoad: 'url-load',
  modelSelect: 'model-select', denoise: 'denoise', backendLine: 'backend-line',
  start: 'start', cancel: 'cancel',
  progress: 'progress', keepAwake: 'keep-awake', error: 'error',
  resultVocals: 'result-vocals', resultInst: 'result-inst',
  audioVocals: 'audio-vocals', audioInst: 'audio-inst',
  dlVocalsMp3: 'dl-vocals-mp3', dlVocalsWav: 'dl-vocals-wav', dlInstMp3: 'dl-inst-mp3', dlInstWav: 'dl-inst-wav',
};

export function lookup(doc = document) {
  const els = {};
  for (const [k, id] of Object.entries(IDS)) {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    els[k] = el;
  }
  els.audio = { vocals: els.audioVocals, instrumental: els.audioInst };
  els.dl = { vocals: { mp3: els.dlVocalsMp3, wav: els.dlVocalsWav }, instrumental: { mp3: els.dlInstMp3, wav: els.dlInstWav } };
  return els;
}

export function showApp(els) { els.login.hidden = true; els.app.hidden = false; }

// Every control disabled (state `unsupported`, design_accepted DA-5).
export function disableAllControls(els) {
  for (const el of [els.fileInput, els.urlInput, els.urlLoad, els.modelSelect, els.denoise, els.start, els.cancel,
    els.dlVocalsMp3, els.dlVocalsWav, els.dlInstMp3, els.dlInstWav]) {
    if (el.tagName === 'A') el.setAttribute('aria-disabled', 'true'); else el.disabled = true;
  }
  els.dropZone.setAttribute('aria-disabled', 'true');
  els.dropZone.tabIndex = -1;
}

export function setInputsBusy(els, busy) {
  els.fileInput.disabled = busy;
  els.urlInput.disabled = busy;
  els.urlLoad.disabled = busy;
  if (busy) els.dropZone.setAttribute('aria-disabled', 'true'); else els.dropZone.removeAttribute('aria-disabled');
}

export function setText(el, text) { el.textContent = text ?? ''; }
export function setProgress(els, text) { setText(els.progress, text); }
export function setError(els, text) { setText(els.error, text); }
export function setLoginError(els, text) { setText(els.loginError, text); }
export function setKeepAwake(els, visible) { els.keepAwake.hidden = !visible; }
export function setCancelVisible(els, visible) { els.cancel.hidden = !visible; }
export function setStartEnabled(els, enabled) { els.start.disabled = !enabled; }
export function setBackendLine(els, backend, threads) { setText(els.backendLine, backend ? backendLineCopy(backend, threads) : ''); }
export function setDropHint(els, maxSeconds, touch) { setText(els.dropHint, dropZoneHint(maxSeconds, touch)); }

export function setFileLine(els, name, duration) {
  if (!name) { setText(els.fileName, ''); return; }
  setText(els.fileName, duration === null || duration === undefined ? name : fileLineCopy(name, duration));
}

export function setModelOptions(els, hq) {
  const current = els.modelSelect.value;
  els.modelSelect.textContent = '';
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; els.modelSelect.appendChild(o); };
  add('standard', STATIC.standard);
  if (hq) add('hq', STATIC.hq);
  els.modelSelect.value = hq && current === 'hq' ? 'hq' : 'standard';
}

export function setPlayer(audio, url) {
  if (url) { audio.src = url; return; }
  audio.removeAttribute('src');
  try { audio.load(); } catch { /* ignore */ }
}

export function setDownload(anchor, { enabled, filename, label }) {
  if (enabled) {
    anchor.removeAttribute('aria-disabled');
    anchor.setAttribute('download', filename);
  } else {
    anchor.setAttribute('aria-disabled', 'true');
    anchor.removeAttribute('download');
    anchor.setAttribute('href', '#');
  }
  if (label !== undefined) setText(anchor, label);
}

export function disableDownloads(els) {
  setDownload(els.dlVocalsMp3, { enabled: false, label: STATIC.dlMp3 });
  setDownload(els.dlInstMp3, { enabled: false, label: STATIC.dlMp3 });
  setDownload(els.dlVocalsWav, { enabled: false, label: STATIC.dlWav });
  setDownload(els.dlInstWav, { enabled: false, label: STATIC.dlWav });
}

export function disableMp3Downloads(els) {
  setDownload(els.dlVocalsMp3, { enabled: false, label: STATIC.dlMp3 });
  setDownload(els.dlInstMp3, { enabled: false, label: STATIC.dlMp3 });
}
