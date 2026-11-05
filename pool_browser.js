/**
 * Pemeriksa cookie. Bukan pool browser.
 * Tidak ada browser standby. Satu per satu: buka, cek sehat, tutup.
 * Daftar sehat maksimal 10, urut dari kecil ke besar, hanya di memori.
 * Isi cookie dibaca dari Redis utama satu kali, lalu disimpan di memori
 * selama masih menunggu tugas atau percobaan kedua. Dibuang setelah
 * dipakai tugas, mati, atau gagal. Putaran berikutnya membaca Redis lagi.
 * global_chatgpt_index dibaca dari Redis kedua (redisIndex), sekali saat mulai.
 * Pemeriksa tidak menggeser index.
 * Cookie kadaluarsa masuk list redis utama chatgpt_cookie_mati, tanpa nomor ganda.
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
const simpanan = new Map();

function setDeps(d) { deps = d || {}; }

function listText() {
  return healthy.map((x) => x.index).join(', ') || '-';
}

function logList(why) {
  console.log(`[CEK] ${why} | sehat ${healthy.length}/${TARGET}: ${listText()} | memori=${simpanan.size} | berikutnya=#${nextScan}`);
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

function dbIndex() {
  return deps.redisIndex || deps.redis;
}

async function ambilCookie(index) {
  if (simpanan.has(index)) {
    console.log(`[CEK] #${index} dari memori, Redis tidak dibaca`);
    return simpanan.get(index);
  }
  const raw = await deps.redis.get(`cookie_chatgpt_${index}`);
  const item = formatCookie(raw, index);
  if (!item) {
    console.log(`[CEK] #${index} tidak ada data — lewati`);
    return null;
  }
  simpanan.set(index, item);
  console.log(`[CEK] #${index} dibaca Redis 1 kali, disimpan di memori`);
  return item;
}

function buangCookie(index, alasan) {
  if (!simpanan.delete(index)) return;
  console.log(`[CEK] #${index} dibuang dari memori (${alasan})`);
}

const KUNCI_MATI = 'chatgpt_cookie_mati';

async function catatCookieMati(index, alasan) {
  const n = parseInt(index, 10);
  if (!Number.isFinite(n) || n < 1 || !deps.redis) return;
  const nomor = String(n);
  try {
    const daftar = await deps.redis.lrange(KUNCI_MATI, 0, -1);
    const ada = Array.isArray(daftar) && daftar.some((x) => String(x) === nomor);
    if (ada) {
      console.log(`[CEK] #${nomor} sudah ada di chatgpt_cookie_mati — tidak ditambahkan`);
      return;
    }
    await deps.redis.rpush(KUNCI_MATI, nomor);
    console.log(`[CEK] #${nomor} masuk chatgpt_cookie_mati (${alasan})`);
  } catch (e) {
    console.log(`[CEK] #${nomor} gagal catat redis: ${e.message}`);
  }
}

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
  const item = await ambilCookie(index);
  if (!item) return null;
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
      console.log(`[CEK] cek #${index} percobaan ${attempt}/2 (memori)`);
      await checkOnce(item);
      console.log(`[CEK] #${index} SEHAT, tetap di memori sampai ada tugas`);
      return item;
    } catch (e) {
      last = e;
      attempt += 1;
      const invalid = /COOKIE_INVALID/.test(e.message || '');
      console.log(`[CEK] #${index} gagal: ${e.message}`);
      if (invalid) {
        await catatCookieMati(index, e.message);
        buangCookie(index, 'kadaluarsa');
        break;
      }
    } finally {
      cekTerbuka = false;
    }
  }
  buangCookie(index, 'gagal cek');
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
      if (healthy.some((x) => x.index === index)) {
        console.log(`[CEK] #${index} sudah di daftar sehat, Redis tidak dibaca`);
        continue;
      }
      const item = await cookieSehat(index);
      if (!item) continue;
      healthy.push(item);
      gateOpen = true;
      logList(`tambah #${item.index}`);
      if (aktif() < 5) await sleep(700);
    }
    if (scanned >= max && healthy.length < TARGET) {
      console.log(`[CEK] satu putaran #1–#${max} selesai. Sehat: ${listText()}. Memori=${simpanan.size}`);
      console.log('[CEK] jeda 60s. Cookie yang sudah dibuang baru dibaca lagi dari Redis pada putaran ini.');
      await sleep(60000);
    }
  } finally {
    scanning = false;
    if (healthy.length < TARGET) poke();
  }
}

async function start(folderHasil) {
  if (started) return;
  started = true;
  folder = folderHasil;
  const raw = await dbIndex().get('global_chatgpt_index');
  const n = parseInt(raw, 10);
  bootIndex = Number.isFinite(n) && n > 0 ? n : 0;
  const max = deps.MAX_COOKIES || 300;
  nextScan = bootIndex >= max ? 1 : bootIndex + 1;
  const sumber = deps.redisIndex ? 'Redis kedua' : 'Redis utama';
  console.log(`[CEK] index=${bootIndex} dibaca sekali dari ${sumber}. Cek satu per satu mulai #${nextScan}${bootIndex >= max ? ' (putar dari #' + max + ' ke #1)' : ''}. Isi cookie dari Redis utama, sekali, lalu di memori. Slot dipakai begitu ada 1 sehat.`);
  poke();
}

/**
 * Ambil cookie paling kecil di daftar.
 * Menunggu kalau daftar kosong atau 5 tugas sedang jalan.
 * Slot pertama langsung boleh dipakai. Tidak menolak.
 * Index Redis ditulis lewat deps.commitIndex sebelum browser tugas dibuka.
 */
async function takeNext(deadlineMs) {
  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < WAIT_MS) {
    if (deadlineMs && Date.now() >= deadlineMs) {
      throw new Error('TIMEOUT_5MENIT: tugas belum selesai dalam 5 menit');
    }
    if (healthy.length >= MIN_BEFORE_WORK) gateOpen = true;
    if (scanExhausted && healthy.length > 0) gateOpen = true;

    const active = aktif();
    if (!taking && gateOpen && healthy.length > 0 && active < 5 && !cekTerbuka) {
      if (deadlineMs && Date.now() >= deadlineMs) {
        throw new Error('TIMEOUT_5MENIT: tugas belum selesai dalam 5 menit');
      }
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
      buangCookie(item.index, 'diserahkan ke tugas');
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

module.exports = { setDeps, start, takeNext, releaseWorker, snapshot, catatCookieMati };
