// tests/lib/fixtures.mjs — fixture and reference-stem paths (design §16.B).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const taskRoot = path.resolve(repoRoot, '..');
export const evidenceDir = path.join(taskRoot, 'evidence');

export function fixturePath(name) {
  return path.join(repoRoot, 'tests', 'fixtures', name);
}

export function refDir() {
  return process.env.VS_REF_DIR ? path.resolve(process.env.VS_REF_DIR) : path.join(evidenceDir, 'ref');
}

// → { vocals, instrumental } absolute paths of audio-separator's stems for `modelId`; throws REF_MISSING naming the expected path.
export function referenceStems(modelId, base = 'clip25') {
  const dir = path.join(refDir(), modelId);
  const pick = (stem) => {
    const prefix = `${base}_(${stem})_`;
    const expected = path.join(dir, `${prefix}*.wav`);
    if (!fs.existsSync(dir)) { const e = new Error(`REF_MISSING: ${expected}`); e.code = 'REF_MISSING'; e.expected = expected; throw e; }
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.toLowerCase().endsWith('.wav'));
    if (!hit) { const e = new Error(`REF_MISSING: ${expected}`); e.code = 'REF_MISSING'; e.expected = expected; throw e; }
    return path.join(dir, hit);
  };
  return { vocals: pick('Vocals'), instrumental: pick('Instrumental') };
}

// Model chunk files present for `modelId`? (parity tests skip loudly when absent)
export function modelChunksPresent(manifest, modelId) {
  const m = manifest.models[modelId];
  if (!m) return false;
  const files = [m.files.model, m.files.externalData].filter(Boolean);
  return files.every((f) => f.chunks.every((c) => fs.existsSync(path.join(repoRoot, 'site', ...c.path.split('/')))));
}

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, 'site', 'models', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
}

// Read/merge/write a JSON evidence file (PowerShell-written files may carry a BOM).
export function mergeEvidenceJson(fileName, patch) {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = path.join(evidenceDir, fileName);
  let current = {};
  if (fs.existsSync(file)) {
    try { current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { current = {}; }
  }
  const merged = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}
