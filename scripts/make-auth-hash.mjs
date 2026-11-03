// scripts/make-auth-hash.mjs — print SALT_HEX / HASH_HEX for site/auth.mjs (design §23.3).
// Password: process.env.VS_PASS or argv[2]. Never printed, never written anywhere.
// Usage: VS_PASS=<pw> node scripts/make-auth-hash.mjs [--salt <32 hex>]
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 200000;
const args = process.argv.slice(2);
let saltHex = null;
let pw = process.env.VS_PASS;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--salt') { saltHex = args[++i]; continue; }
  if (pw === undefined && !args[i].startsWith('--')) pw = args[i];
}
if (typeof pw !== 'string' || pw.length === 0) {
  console.error('usage: VS_PASS=<password> node scripts/make-auth-hash.mjs [--salt <32 hex chars>]');
  process.exit(2);
}
if (saltHex !== null && !/^[0-9a-f]{32}$/i.test(saltHex)) {
  console.error('--salt must be 32 hex chars (16 bytes)');
  process.exit(2);
}
const salt = saltHex ? Buffer.from(saltHex, 'hex') : randomBytes(16);
const hash = pbkdf2Sync(Buffer.from(pw, 'utf8'), salt, ITERATIONS, 32, 'sha256');
process.stdout.write(`export const SALT_HEX = '${salt.toString('hex')}';\n`);
process.stdout.write(`export const HASH_HEX = '${hash.toString('hex')}';\n`);
