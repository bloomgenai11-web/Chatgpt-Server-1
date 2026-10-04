/**
 * camoufox_launch.js — WORK EKOSISTEM-FIX
 * Hanya Camoufox. Tidak ada playwright-core / launchOptions / stock Firefox.
 */
const { Camoufox } = require('camoufox-js');

function isUnknownPropertyError(err) {
  return /Unknown property|Invalid type for property/i.test(String((err && err.message) || err || ''));
}

async function launchCamoufox(opts = {}) {
  const common = {
    headless: opts.headless !== false,
    proxy: opts.proxy,
    firefoxUserPrefs: opts.firefoxUserPrefs,
    geoip: opts.geoip,
    width: opts.width,
    height: opts.height,
    i_know_what_im_doing: true,
    humanize: false,
    block_images: false,
  };

  // 1) normal
  try {
    return await Camoufox({ ...opts, i_know_what_im_doing: true });
  } catch (e) {
    if (!isUnknownPropertyError(e)) throw e;
    console.log(`[camoufox_launch] ${e.message} → retry config:{}`);
  }

  // 2) kosongkan config fingerprint (hindari BrowserForge keys yang ditolak binary)
  try {
    return await Camoufox({ ...common, config: {} });
  } catch (e2) {
    if (!isUnknownPropertyError(e2)) throw e2;
    console.log(`[camoufox_launch] ${e2.message} → retry tanpa geoip`);
  }

  // 3) minimal absolut
  return Camoufox({
    headless: common.headless,
    proxy: common.proxy,
    firefoxUserPrefs: common.firefoxUserPrefs,
    i_know_what_im_doing: true,
    config: {},
  });
}

module.exports = { launchCamoufox, isUnknownPropertyError };
