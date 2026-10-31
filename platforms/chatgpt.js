/**
 * Pemeriksa cookie. Bukan pool browser.
 * Tidak ada browser standby. Satu per satu: buka, cek sehat, tutup.
 * Daftar sehat maksimal 10, urut dari kecil ke besar, hanya di memori.
 * Redis index dibaca sekali saat mulai. Tidak ditulis oleh pemeriksa.
 */
const path = require('path');

const TARGET = 10;
const MIN_BEFORE_WORK = 1;
const PAUSE_AT = 5;
const WAIT_MS = 20 * 60 * 1000;

let deps = {};
let folder = null;
let healthy = [];
let nextScan = 1;
let scanning = false;
let started = false;
let scanExhausted = false;
let gateOpen = false;
let bootIndex = 0;
let taking = false;
let cekTerbuka = false;

function setDeps(d) { deps = d || {}; }

function listText() {
  return healthy.map((x) => x.index).join(', ') || '-';
}

function logList(why) {
  console.log(`[CEK] ${why} | sehat ${healthy.length}/${TARGET}: ${listText()} | berikutnya=#${nextScan}`);
}

function snapshot() {
  return {
    bootIndex,
    nextScan,
    gateOpen,
    target: TARGET,
    minBeforeWork: MIN_BEFORE_WORK,
    list: healthy.map((x) => x.index),
  };
}

function formatCookie(rawData, index) {
  let data = rawData;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { data = null; }
  }
  if (!data || typeof data !== 'object') return null;
  const cookies = Object.entries(data).map(([key, value]) => ({
    name: key,
    value: String(value),
    domain: '.chatgpt.com',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  }));
  if (!cookies.length) return null;
  return { id: `cookie_chatgpt_${index}`, index, cookies };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function checkOnce(item) {
  let browser = null;
  let context = null;
  let page = null;
  try {
    const launched = await deps.launchGatewayBrowser();
    browser = launched.browser;
    context = await browser.newContext({ acceptDownloads: true });
    await context.addCookies(item.cookies);
    page = await context.newPage();
    await deps.chatgptModule.persiapkanHalaman(page, folder, {
      cookieId: item.id,
      skipShots: true,
    });
    return true;
  } catch (e) {
    if (page) {
      const shot = path.join(folder, `cek_fail_${item.index}_${Date.now()}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    }
    throw e;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

function aktif() {
  return typeof deps.getActive === 'function' ? deps.getActive() : 0;
}

async function cookieSehat(index) {
  const raw = await deps.redis.get(`cookie_chatgpt_${index}`);
  const item = formatCookie(raw, index);
  if (!item) {
    console.log(`[CEK] #${index} tidak ada data — lewati`);
    return null;
  }
  let last = null;
  let attempt = 1;
  let tungguLog = 0;
  while (attempt <= 2) {
    while (aktif() >= PAUSE_AT) {
      const now = Date.now();
      if (now - tungguLog > 8000) {
        tungguLog = now;
        console.log(`[CEK] ${aktif()} tugas sedang jalan — pemeriksaan cookie ditunda`);
      }
      await sleep(500);
    }
    cekTerbuka = true;
    try {
      if (aktif() >= PAUSE_AT) continue;
      console.log(`[CEK] cek #${index} percobaan ${attempt}/2`);
      await checkOnce(item);
      console.log(`[CEK] #${index} SEHAT`);
      return item;
    } catch (e) {
      last = e;
      attempt += 1;
      const invalid = /COOKIE_INVALID/.test(e.message || '');
      console.log(`[CEK] #${index} gagal: ${e.message}`);
      if (invalid) break;
    } finally {
      cekTerbuka = false;
    }
  }
  console.log(`[CEK] #${index} tidak masuk daftar (${last ? last.message : 'gagal'})`);
  return null;
}

function poke() {
  if (scanning || scanExhausted) return;
  if (healthy.length >= TARGET) return;
  scanning = true;
  scanLoop().catch((e) => {
    console.error('[CEK] scan berhenti:', e.message);
    scanning = false;
  });
}

async function scanLoop() {
  try {
    const max = deps.MAX_COOKIES || 300;
    let scanned = 0;
    while (healthy.length < TARGET && scanned < max) {
      const index = nextScan;
      scanned += 1;
      nextScan = index >= max ? 1 : index + 1;
      const item = await cookieSehat(index);
      if (!item) continue;
      healthy.push(item);
      gateOpen = true;
      logList(`tambah #${item.index}`);
      if (aktif() < 5) await sleep(700);
    }
    if (scanned >= max) {
      scanExhausted = true;
      if (healthy.length > 0) gateOpen = true;
      console.log(`[CEK] satu putaran #1–#${max} selesai. Sehat: ${listText()}`);
    }
  } finally {
    scanning = false;
    if (healthy.length < TARGET && !scanExhausted) poke();
  }
}

async function start(folderHasil) {
  if (started) return;
  started = true;
  folder = folderHasil;
  const raw = await deps.redis.get('global_chatgpt_index');
  const n = parseInt(raw, 10);
  bootIndex = Number.isFinite(n) && n > 0 ? n : 0;
  const max = deps.MAX_COOKIES || 300;
  nextScan = bootIndex >= max ? 1 : bootIndex + 1;
  console.log(`[CEK] redis index=${bootIndex} dibaca sekali. Cek satu per satu mulai #${nextScan}${bootIndex >= max ? ' (putar dari #' + max + ' ke #1)' : ''}. Slot dipakai begitu ada 1 sehat. Browser langsung ditutup.`);
  poke();
}

/**
 * Ambil cookie paling kecil di daftar.
 * Menunggu kalau daftar kosong atau 5 tugas sedang jalan.
 * Slot pertama langsung boleh dipakai. Tidak menolak.
 * Index Redis ditulis lewat deps.commitIndex sebelum browser tugas dibuka.
 */
async function takeNext() {
  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < WAIT_MS) {
    if (healthy.length >= MIN_BEFORE_WORK) gateOpen = true;
    if (scanExhausted && healthy.length > 0) gateOpen = true;

    const active = aktif();
    if (!taking && gateOpen && healthy.length > 0 && active < 5 && !cekTerbuka) {
      taking = true;
      const item = healthy.shift();
      try {
        if (deps.commitIndex) await deps.commitIndex(item.index);
        if (deps.reserveWorker) deps.reserveWorker();
      } catch (e) {
        healthy.unshift(item);
        taking = false;
        throw e;
      }
      taking = false;
      logList(`pakai #${item.index} untuk tugas`);
      poke();
      return item;
    }

    if (scanExhausted && healthy.length === 0) {
      throw new Error('[CEK] tidak ada cookie sehat tersisa');
    }

    const now = Date.now();
    if (now - lastLog > 8000) {
      lastLog = now;
      if (!gateOpen) console.log(`[CEK] gateway menunggu daftar awal ${healthy.length}/${MIN_BEFORE_WORK} (antre, tidak ditolak)`);
      else if (active >= 5) console.log(`[CEK] 5 tugas sedang jalan — permintaan ini menunggu slot`);
      else if (cekTerbuka) console.log(`[CEK] pemeriksaan cookie sedang jalan — permintaan menunggu browser itu selesai`);
      else console.log(`[CEK] daftar kosong — menunggu pemeriksaan cookie berikutnya`);
    }
    poke();
    await sleep(400);
  }
  throw new Error('[CEK] menunggu cookie sehat lebih dari 20 menit');
}

function releaseWorker() {
  if (deps.releaseWorker) deps.releaseWorker();
  poke();
}

module.exports = { setDeps, start, takeNext, releaseWorker, snapshot };
