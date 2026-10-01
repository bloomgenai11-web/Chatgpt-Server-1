/**
 * camoufox_safe.js
 * BrowserForge mengisi navigator.product dll; binary Camoufox bisa menolak
 * ("Unknown property navigator.product in config").
 *
 * Patch properties.json + skip unknown keys di validateConfig, lalu wrap Camoufox.
 */
const fs = require('fs');
const path = require('path');

const EXTRA_PROPS = [
  { property: 'navigator.product', type: 'str' },
  { property: 'navigator.productSub', type: 'str' },
  { property: 'navigator.buildID', type: 'str' },
  { property: 'navigator.globalPrivacyControl', type: 'bool' },
  { property: 'navigator.cookieEnabled', type: 'bool' },
  { property: 'navigator.onLine', type: 'bool' },
];

function walkFiles(dir, depth, acc) {
  if (!dir || depth > 6) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') walkFiles(p, depth + 1, acc);
    else if (e.isFile()) acc.push(p);
  }
}

function patchPropertiesJson() {
  const roots = [
    process.env.CAMOUFOX_INSTALL_DIR,
    path.join(process.env.HOME || '', '.cache/camoufox'),
    path.join(process.env.XDG_CACHE_HOME || '', 'camoufox'),
    '/home/node/.cache/camoufox',
    '/root/.cache/camoufox',
  ].filter(Boolean);
  try { roots.push(path.dirname(require.resolve('camoufox-js/package.json'))); } catch {}

  const files = [];
  for (const r of roots) walkFiles(r, 0, files);
  let n = 0;
  for (const f of files) {
    if (path.basename(f) !== 'properties.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(data)) continue;
      const have = new Set(data.map((x) => x && x.property).filter(Boolean));
      let changed = false;
      for (const row of EXTRA_PROPS) {
        if (!have.has(row.property)) {
          data.push(row);
          have.add(row.property);
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(f, JSON.stringify(data, null, 2));
        n += 1;
      }
    } catch {}
  }
  if (n) console.log(`[Camoufox] properties.json dilengkapi (${n} file)`);
}

function patchValidateConfigOnDisk() {
  let pkg;
  try { pkg = path.dirname(require.resolve('camoufox-js/package.json')); } catch { return; }
  const files = [];
  walkFiles(pkg, 0, files);
  for (const f of files) {
    if (!/\.(js|cjs|mjs)$/.test(f)) continue;
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    if (!src.includes('Unknown property') || !/validateConfig/.test(src)) continue;
    if (src.includes('__GROK_SKIP_UNKNOWN__')) continue;

    let next = src.replace(
      /if\s*\(\s*!expectedType\s*\)\s*\{[\s\S]{0,400}?throw new UnknownProperty\([^;]+;[\s\S]{0,80}?\}/,
      '{ /* __GROK_SKIP_UNKNOWN__ */ delete configMap[key]; continue; }'
    );
    if (next === src && src.includes('throw new UnknownProperty')) {
      next = src.replace(
        /throw new UnknownProperty\((?:`Unknown property \$\{key\} in config`|'Unknown property '[^)]+|[^)]+)\)\s*;?/,
        '{ /* __GROK_SKIP_UNKNOWN__ */ if (configMap && typeof key === "string") delete configMap[key]; continue; }'
      );
    }
    if (next !== src) {
      fs.writeFileSync(f, next);
      console.log('[Camoufox] disk-patch', path.relative(pkg, f));
    }
  }
}

try { patchPropertiesJson(); } catch (e) { console.log('[Camoufox] properties.json:', e.message); }
try { patchValidateConfigOnDisk(); } catch (e) { console.log('[Camoufox] disk-patch:', e.message); }

const { Camoufox: CamoufoxOrig } = require('camoufox-js');

/**
 * Wrapper minimal: hanya patch crash + i_know_what_im_doing.
 * TIDAK force os — biarkan BrowserForge pool penuh seperti script awal.
 * Caller boleh override os / fingerprint options.
 */
async function Camoufox(opts = {}) {
  return CamoufoxOrig({
    ...opts,
    i_know_what_im_doing: true,
  });
}

function isCamoufoxConfigError(err) {
  const m = String((err && err.message) || err || '');
  return /Unknown property|Invalid type for property|NonFirefoxFingerprint|InvalidOS/i.test(m);
}

module.exports = { Camoufox, isCamoufoxConfigError };
