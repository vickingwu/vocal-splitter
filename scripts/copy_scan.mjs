// scripts/copy_scan.mjs <files…> — scans text files for the brief §1.10 forbidden phrases (tests/lib/forbidden.mjs).
// Prints file:line: <pattern> for every hit and exits 1 when anything was found (M5 runs it over README.md and ../REPORT.md).
import fs from 'node:fs';
import { FORBIDDEN } from '../tests/lib/forbidden.mjs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/copy_scan.mjs <file> [file…]');
  process.exit(2);
}
let hits = 0;
for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`${file}: ${e.message}`); process.exitCode = 2; continue; }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of FORBIDDEN) {
      if (re.test(line)) { hits++; console.log(`${file}:${i + 1}: ${re.source}`); }
    }
  });
}
if (hits > 0) { console.log(`${hits} hit(s)`); process.exit(1); }
console.log(`ok: ${files.length} file(s), no forbidden phrases`);
