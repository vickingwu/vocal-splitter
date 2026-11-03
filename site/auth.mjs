// site/auth.mjs — login gate constants + functions (design §23.3). The password itself is not in
// this file, in any test, fixture, README, commit message or log; only its PBKDF2-SHA-256 hash is.
// Regenerate SALT_HEX / HASH_HEX with `npm run auth:hash` (reads VS_PASS from the shell).
export const USERNAME = 'MQ';
export const ITERATIONS = 200000;
export const SALT_HEX = 'cd54678b693ab8d53b1932f45338ed42';
export const HASH_HEX = '5ddb977b3934af60053c2d4b64b8deba8422ae27061a3c4f6600b8dd6d40fa2f';
export const SESSION_KEY = 'vs-session';

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export async function deriveHex(password, saltHex = SALT_HEX, iterations = ITERATIONS, subtle = globalThis.crypto.subtle) {
  const key = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

// Fixed-time over the longer length; differing lengths → false after the loop.
export function constantTimeEqualHex(a, b) {
  const n = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Order (design_accepted DA-3): type checks → length 1..256 → userOk → exactly ONE derivation
// (on 'x' when the username is wrong, same cost either way) → combined result.
export async function verifyCredentials(username, password, subtle) {
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  if (password.length === 0 || password.length > 256) return false;
  const userOk = username.trim().toLowerCase() === USERNAME.toLowerCase();
  const hex = await deriveHex(userOk ? password : 'x', SALT_HEX, ITERATIONS, subtle);
  return userOk && constantTimeEqualHex(hex, HASH_HEX);
}

export function newSessionToken(getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)) {
  return bytesToHex(getRandomValues(new Uint8Array(32)));
}
export function hasSession(storage) {
  try { return /^[0-9a-f]{64}$/.test(storage.getItem(SESSION_KEY) ?? ''); } catch { return false; }
}
export function storeSession(storage, token) {
  try { storage.setItem(SESSION_KEY, token); } catch (e) { console.warn('[vs] session not persisted', e); }
}
export function clearSession(storage) {
  try { storage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
