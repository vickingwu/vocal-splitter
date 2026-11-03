// tests/lib/b64.mjs — Float32Array / Uint8Array ↔ base64 for page.evaluate transfers (design §16.C). Node side here; the
// browser-side encoder is the function returned by pageEncoderSource() and is evaluated inside the page.
export function f32ToB64(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
}

export function b64ToF32(s) {
  const buf = Buffer.from(s, 'base64');
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

export function b64ToU8(s) {
  const buf = Buffer.from(s, 'base64');
  return new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function u8ToB64(u8) {
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
}

// Browser-side: a Uint8Array view → base64 string in 32 KiB pieces (String.fromCharCode.apply limits).
export function pageBytesToB64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
