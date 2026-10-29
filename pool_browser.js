/**
 * 5 browser Camoufox hidup terus.
 * Boot hanya sampai Start Voice, lalu menunggu tugas.
 * Tugas lanjut di page yang sama (tanpa step 1-3, tanpa browser baru).
 * Refresh 5 menit: page.reload/goto, browser dan fingerprint tetap.
 * Cookie baru hanya setelah cookie yang sedang dipegang selesai dipakai tugas,
 * dan hanya kalau tidak ada slot lain yang cookienya belum pernah mengerjakan tugas.
 */
const POOL_SIZE = 5;
const REFRESH_MS = 5 * 60 * 1000;

let deps = {};
let slots = [];
let started = false;
let poolFolder = null;
let heavyChain = Promise.resolve();

function setDeps(d) {
  deps = { ...deps, ...d };
}

function poolLog(slot, msg) {
  const id = slot && slot.id != null ? slot.id : '?';
  console.log(`[POOL_${id}] ${msg}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function heavy(fn) {
  const run = heavyChain.then(() => fn(), () => fn());
  heavyChain = run.then(() => {}, () => {});
  return run;
}

function pageAlive(slot) {
  try {
    if (!slot || !slot.page || !slot.context || !slot.browser) return false;
    if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return false;
    return true;
  } catch (_) {
    return false;
  }
}

async function installPopupKiller(page) {
  await page.addInitScript(() => {
    const dismissPopups = () => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (txt === 'got it' || txt === 'okay' || txt === 'ok' || txt === 'stay logged out' || txt === 'continue') {
          try { btn.click(); } catch (e) {}
        }
      }
    };
    if (!window.__poolPopupKillerInstalled) {
      window.__poolPopupKillerInstalled = true;
      const observer = new MutationObserver(() => dismissPopups());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setInterval(dismissPopups, 800);
    }
    dismissPopups();
  }).catch(() => {});
}

async function closeQuiet(slot) {
  const page = slot.page;
  const context = slot.context;
  const browser = slot.browser;
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  try { if (page) await page.close().catch(() => {}); } catch (_) {}
  try { if (context) await context.close().catch(() => {}); } catch (_) {}
  try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
}

async function pasangSampaiSiap(slot) {
  if (!deps.reserveCookie) throw new Error('reserveCookie belum di-set');
  if (!deps.chatgptModule || typeof deps.chatgptModule.persiapkanHalaman !== 'function') {
    throw new Error('chatgpt.persiapkanHalaman belum ada');
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= 8; attempt++) {
    const sesi = await deps.reserveCookie('pool:' + slot.id);
    slot.cookieIndex = sesi.index;
    slot.cookieId = sesi.id;
    slot.cookies = sesi.cookies;
    slot.usedForTask = false;
    try {
      await slot.context.clearCookies().catch(() => {});
      await slot.context.addCookies(sesi.cookies);
      poolLog(slot, `step 1-3 cookie=${sesi.id} (index Redis tidak ditulis)`);
      await heavy(() => deps.chatgptModule.persiapkanHalaman(slot.page, poolFolder, {
        cookieId: sesi.id,
        poolSlot: slot.id,
      }));
      return;
    } catch (e) {
      lastErr = e;
      poolLog(slot, `${sesi.id} gagal disiapkan (${e.message}) â€” buang dari sesi ini, index Redis tidak maju`);
      if (deps.markCookieInvalid) await deps.markCookieInvalid(sesi.index);
      else if (deps.releaseReservation) await deps.releaseReservation(sesi.index);
      slot.cookieIndex = null;
      slot.cookieId = null;
      slot.cookies = null;
    }
  }
  throw lastErr || new Error('gagal memasang cookie pool');
}

async function bootSlot(slot) {
  slot.state = 'booting';
  slot.usedForTask = false;
  poolLog(slot, 'meluncurkan browser (fingerprint slot ini, sekali)');
  try {
    if (slot.browser) await closeQuiet(slot);
    if (!deps.launchGatewayBrowser) throw new Error('launchGatewayBrowser belum di-set');
    const launched = await deps.launchGatewayBrowser();
    slot.browser = launched.browser;
    slot.label = launched.label;
    slot.context = await slot.browser.newContext({ acceptDownloads: true });
    slot.page = await slot.context.newPage();
    await installPopupKiller(slot.page);
    await pasangSampaiSiap(slot);
    slot.state = 'ready';
    slot.readyAt = Date.now();
    slot.usedForTask = false;
    poolLog(slot, `HIDUP cookie=${slot.cookieId} net=${slot.label} â€” menunggu tugas, browser tidak ditutup`);
  } catch (e) {
    poolLog(slot, 'boot gagal: ' + e.message);
    await closeQuiet(slot);
    slot.state = 'dead';
    await sleep(/tidak ada cookie/.test(e.message || '') ? 30000 : 5000);
    return bootSlot(slot);
  }
}

async function rotateClaimed(slot) {
  const oldId = slot.cookieId;
  const oldIndex = slot.cookieIndex;
  poolLog(slot, `cookie ${oldId || '-'} sudah dipakai tugas â€” ganti cookie, browser tetap`);
  if (oldIndex && deps.releaseReservation) await deps.releaseReservation(oldIndex);
  slot.cookieIndex = null;
  slot.cookieId = null;
  slot.cookies = null;
  slot.usedForTask = false;
  try {
    if (!pageAlive(slot)) {
      slot.state = 'booting';
      await bootSlot(slot);
      return;
    }
    await pasangSampaiSiap(slot);
    slot.state = 'ready';
    slot.readyAt = Date.now();
    slot.usedForTask = false;
    poolLog(slot, `siap cookie=${slot.cookieId} â€” browser dan fingerprint tetap`);
  } catch (e) {
    poolLog(slot, 'ganti cookie gagal: ' + e.message);
    slot.state = 'dead';
    await closeQuiet(slot);
    await sleep(3000);
    return bootSlot(slot);
  }
}

async function refreshSlot(slot) {
  slot.state = 'refreshing';
  poolLog(slot, `refresh 5 menit cookie=${slot.cookieId} â€” browser dan fingerprint sama`);
  try {
    await heavy(() => deps.chatgptModule.persiapkanHalaman(slot.page, poolFolder, {
      cookieId: slot.cookieId,
      poolSlot: slot.id,
    }));
    if (slot.state === 'refreshing') {
      slot.state = 'ready';
      slot.readyAt = Date.now();
      poolLog(slot, 'refresh selesai, menunggu tugas');
    }
  } catch (e) {
    poolLog(slot, 'refresh gagal: ' + e.message);
    if (/COOKIE_INVALID/.test(e.message || '')) {
      if (deps.markCookieInvalid && slot.cookieIndex) await deps.markCookieInvalid(slot.cookieIndex);
      slot.state = 'rotating';
      await rotateClaimed(slot);
      return;
    }
    if (slot.state === 'refreshing') {
      if (pageAlive(slot)) {
        slot.state = 'ready';
      } else {
        slot.state = 'dead';
        bootSlot(slot).catch((err) => poolLog(slot, 'relaunch: ' + err.message));
      }
    }
  }
}

function tickRefresh() {
  for (const slot of slots) {
    if (slot.state !== 'ready') continue;
    if (!slot.readyAt || Date.now() - slot.readyAt < REFRESH_MS) continue;
    refreshSlot(slot).catch((e) => poolLog(slot, 'refresh error: ' + e.message));
    break;
  }
}

async function takeSlot() {
  if (!started || !slots.length) return null;
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const busy = slots.filter((s) => s.state === 'busy').length;
    if (busy >= slots.length) return null;

    const fresh = slots
      .filter((s) => s.state === 'ready' && !s.usedForTask && pageAlive(s))
      .sort((a, b) => (a.cookieIndex || 0) - (b.cookieIndex || 0));
    if (fresh[0]) {
      fresh[0].state = 'busy';
      poolLog(fresh[0], `tugas masuk cookie=${fresh[0].cookieId} â€” lanjut tanpa step 1-3`);
      return fresh[0];
    }

    const pending = slots.some((s) => s.state === 'booting' || s.state === 'refreshing' || s.state === 'rotating' || s.state === 'dead');
    if (pending) {
      await sleep(300);
      continue;
    }

    const spent = slots
      .filter((s) => s.state === 'ready' && s.usedForTask && pageAlive(s))
      .sort((a, b) => (a.cookieIndex || 0) - (b.cookieIndex || 0));
    if (spent[0]) {
      spent[0].state = 'rotating';
      await rotateClaimed(spent[0]);
      continue;
    }

    await sleep(300);
  }
  return null;
}

async function runTaskOnSlot(slot, args) {
  if (!slot || !slot.page) throw new Error('slot pool tidak punya page');
  try {
    const hasil = await deps.chatgptModule.eksekusiChatGPT(
      args.action || 'CHAT',
      args.prompt || '',
      !!args.isThinkingMode,
      args.translatedFiles || [],
      args.folderHasil || poolFolder,
      slot.context,
      {
        page: slot.page,
        holdPage: true,
        siapVoice: true,
        cookieId: slot.cookieId,
        poolSlot: slot.id,
      }
    );
    slot.usedForTask = true;
    slot.state = 'ready';
    slot.readyAt = Date.now();
    poolLog(slot, `tugas selesai. Browser tetap hidup. Cookie ${slot.cookieId} tidak langsung diganti.`);
    return hasil;
  } catch (e) {
    slot.usedForTask = true;
    if (/COOKIE_INVALID/.test(e.message || '')) {
      slot.state = 'rotating';
      rotateClaimed(slot).catch((err) => poolLog(slot, 'rotate: ' + err.message));
    } else if (!pageAlive(slot)) {
      slot.state = 'dead';
      bootSlot(slot).catch((err) => poolLog(slot, 'relaunch: ' + err.message));
    } else {
      slot.state = 'ready';
      slot.readyAt = Date.now();
    }
    throw e;
  }
}

async function startPool(folderHasil) {
  if (started) {
    console.log('[POOL] sudah hidup, skip');
    return;
  }
  started = true;
  poolFolder = folderHasil || null;
  slots = [];
  console.log('[POOL] start 5 browser HIDUP. Pool tidak menulis index Redis. Refresh tiap 5 menit, fingerprint tetap.');
  for (let i = 1; i <= POOL_SIZE; i++) {
    slots.push({
      id: i,
      state: 'dead',
      browser: null,
      context: null,
      page: null,
      cookieId: null,
      cookieIndex: null,
      cookies: null,
      usedForTask: false,
      readyAt: 0,
      label: '',
    });
  }
  for (const slot of slots) {
    await bootSlot(slot);
  }
  console.log('[POOL] 5 browser menunggu tugas:', poolStats());
  setInterval(tickRefresh, 20000);
}

function poolStats() {
  const c = { ready: 0, busy: 0, booting: 0, refreshing: 0, rotating: 0, dead: 0 };
  for (const s of slots) {
    if (c[s.state] === undefined) c[s.state] = 0;
    c[s.state] += 1;
  }
  return c;
}

function isPoolReady() {
  return started && slots.some((s) => s.state === 'ready' && pageAlive(s));
}

module.exports = {
  setDeps,
  startPool,
  takeSlot,
  runTaskOnSlot,
  poolStats,
  isPoolReady,
  POOL_SIZE,
};
