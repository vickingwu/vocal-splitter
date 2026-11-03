// site/src/ui/device.mjs — the single iOS switch (design §22.1; design_accepted DA-5: no wasmTierKey — resolveModelId
// reads `lowMemory` only). Pure: takes the navigator fields as an object, never reads globals.
export function devicePolicy({ userAgent = '', maxTouchPoints = 0, platform = '' } = {}) {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  const touchPoints = typeof maxTouchPoints === 'number' && Number.isFinite(maxTouchPoints) ? maxTouchPoints : 0;
  void platform;
  const isIOS = /iPhone|iPad|iPod/.test(ua)
    || (/Macintosh/.test(ua) && touchPoints > 1);   // iPadOS "desktop" UA presents as Macintosh with touch
  const touch = touchPoints > 0;
  return {
    isIOS,
    touch,
    lowMemory: isIOS,                      // the only low-memory platform in scope; Android keeps desktop rules
    maxSeconds: isIOS ? 360 : 900,         // 6 min on iOS, 15 min elsewhere
    keepWorkerAfterResult: !isIOS,         // iOS: terminate the worker after `result` so ORT's memory is gone before encoding
    parallelEncode: !isIOS,                // iOS: encode the two stems one after the other
  };
}
