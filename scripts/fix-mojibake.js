#!/usr/bin/env node
/**
 * Fix UTF-8 mojibake in JSON data files.
 * Mojibake occurs when UTF-8 text is incorrectly decoded as Latin-1, producing
 * garbled sequences like "ÃÂÃÂÃÂ¢" instead of "•" (bullet) or "—" (em dash).
 *
 * Run: node scripts/fix-mojibake.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SAVEPOINT_DIR = path.join(DATA_DIR, 'savepoints');

// Detect common mojibake patterns
const MOJIBAKE_PATTERN = /\u00C3|\u00C2|ÃÂ|Ã¢|Ã©|Ã¨|Ã |â€|€™|ð|ÿ|Ã|â¢|ÃÂ¢|Â|[\u0080-\u0083]/;

// Direct replacements for Zoom/calendar mojibake (exact byte sequences)
// Triple-encoded bullet • (U+2022): E2 80 A2 -> â€¢ -> ÃÂ¢ÃÂÃÂ¢ (with control chars)
// "Â " (C2 A0) = UTF-8 bytes for nbsp misinterpreted as Latin-1
// Long "ÃÂ" sequences = triple-encoded nbsp or bullets
const MOJIBAKE_REPLACEMENTS = [
  [/\u00C3\u0083\u00C2\u00A2\u00C3\u0082\u00C2\u0080\u00C3\u0082\u00C2\u00A2/g, '\u2022'],
  [/\u00C3\u0082\u00C2\u00A2\u00C3\u0082\u00C2\u0080\u00C3\u0082\u00C2\u00A2/g, '\u2022'],
  [/\u00E2\u0080\u00A2/g, '\u2022'],
  [/\u00E2\u00A2/g, '\u2022'],
  [/\u00C3\u00A2\u00C2\u0080\u00C2\u00A2/g, '\u2022'],
  [/\u00C2\u00A0/g, '\u00A0'],  // Â + nbsp -> single nbsp (UTF-8 C2 A0 mojibake)
  [/\u00C2[\u0020\u00A0]\u00E2\u0080\u00A2/g, '\u2022'],  // Â â€¢ -> •
  [/\u00C2[\u0020\u00A0]\u2022/g, '\u2022'],  // Â • (already bullet) -> •
  [/\u00C2[\u0020\u00A0]/g, '\u2022 '],  // Â + space/nbsp -> bullet (Zoom list items)
  [/\u00C2\u00A2?\u2022/g, '\u2022'],   // Â¢• or Â• (residual) -> bullet
  [/\u00C2\u20AC?\u2022/g, '\u2022'],   // Â€• or Â• (residual) -> bullet
  [/\u00C2[\u0080-\u00BF]/g, '\u2022 '],  // Â + any continuation (Zoom bullet mojibake) -> bullet
  [/\u00C2\u2022/g, '\u2022'],            // Â• (Â + bullet) -> bullet
  [/\u00C2[\u00A2\u20AC]/g, '\u2022'],   // Â¢ Â€ (standalone) -> bullet
  [/\u00C3[\u0082\u0083]\u00C2[\u0082\u0083]/g, '\u2022 '],  // Ã82Â82, Ã83Â83 etc (4-char Zoom bullet) -> bullet
  [/\u00C3\u00C2/g, '\u2022 '],  // each ÃÂ -> bullet (Zoom list items)
  [/\u00C3\u00C3\u0082/g, '\u2022 '],  // ÃÃ + control (Zoom bullet) -> bullet
  [/\u00C3\u00C3/g, '\u2022 '],  // each ÃÃ -> bullet
  [/\u00C3\u0082/g, '\u2022 '],  // Ã + control (residual) -> bullet
  [/\u00C3\u2022/g, '\u2022'],   // Ã + bullet (stray Ã) -> bullet
  [/\u00C3[\u0020\u00A0]/g, '\u2022 '],  // Ã + space/nbsp -> bullet
  [/\u00C3.\u2022/g, '\u2022'],  // Ã + any char + bullet (Ã€•, Ã°•, etc) -> bullet
  [/\u00C3\u00B0/g, '\u2022 '],  // Ã° (eth mojibake) -> bullet
  [/\u00C3[\u0091\u0094\u0084\u00BF\u00B7]/g, '\u2022 '],  // Ã + control/¿/· (residual) -> bullet
  [/\u00C3[\u0080-\u00BF]/g, '\u2022 '],  // any Ã + continuation byte -> bullet (catch-all)
  [/\u00C3\u00A2\u2022/g, '\u2022'],  // Ã¢• (bullet variant) -> bullet
  [/\u00C3\u00A2[\u00C2\u0080\u0020\u00A0]?/g, '\u2022 '],  // Ã¢Â, Ã¢ , etc -> bullet
  [/\u00C3\u00A2\u00C2\u20AC\u00C2/g, "'"],  // Ã¢Â€Â -> apostrophe (smart quote mojibake)
  [/\u00C3\u00AF\u00C2\u00BF\u00C2\u00BD/g, ''],  // Ã¯Â¿Â½ (U+FFFD mojibake) -> remove
  [/ï¿½+/g, ''],  // Replacement char mojibake -> remove
  [/\u00C2\u0082/g, ''],  // Â‚ (stray C2 82) -> remove
  [/\uFFFD+/g, ''],  // Replacement char -> remove
  [/[\u0082\u0083]\u00C2[\u0082\u0083]?/g, ''],  // control+Â -> remove
  [/\u00C2[\u0082\u0083]/g, ''],  // Â+control -> remove
  [/\u00A0\u00C2\u00A0/g, '\u00A0'],  // nbsp+Â+nbsp -> nbsp
  [/\u0020\u00C2\u0020/g, ' '],  // space+Â+space -> space
  [/\u2022\s*\u00C2\s*\u2022/g, '\u2022 \u2022'],  // bullet Â bullet -> bullet bullet
  [/\u00A0\u00C2(?=\s|\u2022)/g, '\u00A0'],
  [/\u00A0\u00C3[\u0082\u0083]?\u00A0/g, '\u00A0'],  // nbsp+Ã+optional+nbsp -> nbsp
  [/\u2022\s*\u00C3[\u0082\u0083]?\s*\u2022/g, '\u2022 \u2022'],
  [/\u00C3\u0083/g, ''],  // Ã + 83 (double C3) -> remove
];

function fixMojibake(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  // Always fix these regardless of pattern
  result = result.replace(/\n\u0022 (\d)/g, '\n\u2022 $1');
  result = result.replace(/\u00C2&nbsp;/g, '&nbsp;');
  if (!MOJIBAKE_PATTERN.test(str) && !str.includes('\u00C3') && !str.includes('\u00C2')) return result;
  for (const [re, replacement] of MOJIBAKE_REPLACEMENTS) {
    result = result.replace(re, replacement);
  }
  // Skip latin1->utf8 decode: it can corrupt already-fixed text (e.g. bullets)
  // Rely on direct replacements above
  for (const [re, replacement] of MOJIBAKE_REPLACEMENTS) {
    result = result.replace(re, replacement);
  }
  return result;
}

function walkAndFix(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map(item => walkAndFix(item));
  }
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      result[k] = fixMojibake(v);
    } else {
      result[k] = walkAndFix(v);
    }
  }
  return result;
}

function main() {
  const rootFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => path.join(DATA_DIR, f));
  const savepointFiles = fs.existsSync(SAVEPOINT_DIR)
    ? fs.readdirSync(SAVEPOINT_DIR).filter(f => f.endsWith('.json')).map(f => path.join(SAVEPOINT_DIR, f))
    : [];
  const allFiles = [...rootFiles, ...savepointFiles];
  let totalFixed = 0;
  for (const fp of allFiles) {
    const raw = fs.readFileSync(fp, 'utf-8');
    const data = JSON.parse(raw);
    const fixed = walkAndFix(data);
    const fixedStr = JSON.stringify(fixed, null, 2);
    if (fixedStr !== raw) {
      fs.writeFileSync(fp, fixedStr, 'utf-8');
      console.log('Fixed:', path.relative(DATA_DIR, fp) || path.basename(fp));
      totalFixed++;
    }
  }
  if (totalFixed === 0) {
    console.log('No mojibake found in data files.');
  } else {
    console.log(`Cleaned ${totalFixed} file(s).`);
  }
}

main();
