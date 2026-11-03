// site/src/ui/wake.mjs — screen wake lock wrapper (design §22.5). Never throws: rejections are recorded as status
// 'rejected', a missing API as 'unsupported'. Re-requests the lock on visibilitychange → visible while a job is active.
export function createWakeLock({ navigatorLike = {}, documentLike = null } = {}) {
  let sentinel = null;
  let active = false;
  let status = 'idle';
  const supported = !!(navigatorLike.wakeLock && typeof navigatorLike.wakeLock.request === 'function');

  async function request() {
    if (!supported) { status = 'unsupported'; return status; }
    try {
      const s = await navigatorLike.wakeLock.request('screen');
      if (!active) { try { await s.release?.(); } catch { /* ignore */ } return status; }   // released while requesting
      sentinel = s;
      status = 'acquired';
      if (typeof s.addEventListener === 'function') s.addEventListener('release', () => { if (sentinel === s) sentinel = null; });
    } catch {
      status = 'rejected';
    }
    return status;
  }

  function onVisibility() {
    if (!active) return;
    const vis = documentLike && documentLike.visibilityState;
    if (vis === 'visible' && sentinel === null) request();
  }

  if (documentLike && typeof documentLike.addEventListener === 'function') documentLike.addEventListener('visibilitychange', onVisibility);

  return {
    async acquire() { active = true; return request(); },
    async release() {
      active = false;
      const s = sentinel;
      sentinel = null;
      if (s) { try { await s.release?.(); } catch { /* ignore */ } }
      if (status === 'acquired') status = 'released';
      return status;
    },
    get status() { return status; },
    get active() { return active; },
  };
}
