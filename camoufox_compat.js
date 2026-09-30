/**
 * camoufox_compat.js
 *
 * Error "Unknown property navigator.product in config":
 * camoufox-js (BrowserForge) mengisi key yang schema binary Camoufox
 * di cache BELUM kenal. Bukan kebocoran fingerprint.
 *
 * Beda dari camoufox_safe.js (yang merusak fingerprint):
 * - TIDAK menambah key ke properties.json binary (tidak inject spoof extra)
 * - TIDAK memaksa os: windows/macos
 * - TIDAK i_know_what_im_doing
 *
 * Hanya: di validator JS, key yang tidak ada di schema binary DIBUANG.
 * Binary lalu pakai nilai native-nya sendiri → fingerprint tetap konsisten.
 */
const fs = require('fs');
const path = require('path');

function walkFiles(dir, depth, acc) {
  if (!dir || depth > 5) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') walkFiles(p, depth + 1, acc);
    else if (e.isFile()) acc.push(p);
  }
}

function patchValidatorSkipUnknown() {
  let pkg;
  try { pkg = path.dirname(require.resolve('camoufox-js/package.json')); } catch { return; }
  const files = [];
  walkFiles(pkg, 0, files);
  for (const f of files) {
    if (!/\.(js|cjs|mjs)$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('Unknown property') || !/validateConfig/.test(src)) continue;
    if (src.includes('__COMPAT_SKIP_UNKNOWN__')) continue;

    let next = src.replace(
      /if\s*\(\s*!expectedType\s*\)\s*\{[\s\S]{0,400}?throw new UnknownProperty\([^;]+;[\s\S]{0,80}?\}/,
      '{ /* __COMPAT_SKIP_UNKNOWN__ */ delete configMap[key]; continue; }'
    );
    if (next === src && src.includes('throw new UnknownProperty')) {
      next = src.replace(
        /throw new UnknownProperty\((?:`Unknown property \$\{key\} in config`|'Unknown property '[^)]+|[^)]+)\)\s*;?/,
        '{ /* __COMPAT_SKIP_UNKNOWN__ */ if (configMap && typeof key === "string") delete configMap[key]; continue; }'
      );
    }
    if (next !== src) {
      fs.writeFileSync(f, next);
      console.log('[Camoufox] validator: skip unknown keys (tidak inject fingerprint)', path.relative(pkg, f));
    }
  }
}

try { patchValidatorSkipUnknown(); } catch (e) {
  console.log('[Camoufox] validator patch:', e.message);
}

const { Camoufox: CamoufoxOrig } = require('camoufox-js');

async function Camoufox(opts = {}) {
  return CamoufoxOrig(opts);
}

function isCamoufoxConfigError(err) {
  const m = String((err && err.message) || err || '');
  return /Unknown property|Invalid type for property|NonFirefoxFingerprint|InvalidOS/i.test(m);
}

module.exports = { Camoufox, isCamoufoxConfigError };
