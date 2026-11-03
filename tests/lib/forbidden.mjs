// tests/lib/forbidden.mjs — brief §1.10 forbidden-phrase list (shared by copy.test.mjs and scripts/copy_scan.mjs) and the
// render guard of design §12.3 item 4 (no undefined/NaN/null/[object/${ may ever reach a rendered UI string).
export const FORBIDDEN = Object.freeze([
  /免责/, /仅供/, /个人使用/, /感谢/, /由.{0,12}提供/, /成功/, /已就绪/, /放心/, /请注意/, /欢迎/, /登录成功/,
]);

export const RENDER_GUARD = /undefined|NaN|null|\[object |\$\{/;

// → [{ pattern, match }] for every forbidden pattern found in `text`
export function findForbidden(text) {
  const hits = [];
  for (const re of FORBIDDEN) {
    const m = re.exec(String(text));
    if (m) hits.push({ pattern: re.source, match: m[0] });
  }
  return hits;
}
