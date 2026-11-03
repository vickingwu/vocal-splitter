// site/mp3-worker.js — classic worker: one stem → CBR 320 kbps MP3 with lamejs (design §11). Input is fed in 73,728-sample
// blocks; progress every >= 2 %; one concatenated Uint8Array is posted back with its buffer transferred.
importScripts('vendor/lamejs/lame.min.js');

var BLOCK = 73728;

self.onmessage = function (ev) {
  var data = ev.data || {};
  var left = data.left, right = data.right;
  try {
    if (!(left instanceof Int16Array) || !(right instanceof Int16Array) || left.length !== right.length) {
      throw new Error('mp3-worker: expected two equal-length Int16Array channels');
    }
    var enc = new lamejs.Mp3Encoder(2, 44100, 320);
    var parts = [];
    var total = 0;
    var n = left.length;
    var lastPct = -2;
    for (var i = 0; i < n; i += BLOCK) {
      var out = enc.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
      if (out.length) {
        var u = new Uint8Array(out.buffer, out.byteOffset, out.length).slice();
        parts.push(u);
        total += u.length;
      }
      var pct = Math.floor(100 * Math.min(i + BLOCK, n) / n);
      if (pct - lastPct >= 2) { lastPct = pct; self.postMessage({ type: 'progress', fraction: pct / 100 }); }
    }
    var fl = enc.flush();
    if (fl.length) {
      var f = new Uint8Array(fl.buffer, fl.byteOffset, fl.length).slice();
      parts.push(f);
      total += f.length;
    }
    var bytes = new Uint8Array(total);
    var off = 0;
    for (var k = 0; k < parts.length; k++) { bytes.set(parts[k], off); off += parts[k].length; }
    parts = null;
    self.postMessage({ type: 'done', bytes: bytes }, [bytes.buffer]);
  } catch (e) {
    self.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
};
