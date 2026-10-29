/**
 * pool_browser.js
 * - Boot slot: sewa cookie bebas (TANPA INCR Redis), validasi sesi, simpan ke slot, tutup browser.
 * - Satu cookie tidak boleh dipegang dua slot / dua browser.
 * - Index Redis hanya maju saat tugas nyata commit â€” dan tidak meloncat melewati sewa yang masih hidup.
 * - Tugas: acquire slot â†’ pakai cookies tersimpan â†’ tutup browser tugas â†’ lepas sewa â†’ boot slot lagi.
 */
const path = require('path');
const fs = require('fs');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '3', 10); // mode pengujian default 3
// Timeout cek sesi (login/signup vs composer) Ã¢â‚¬â€ 15 detik, lalu cookie berikutnya
const SESI_TIMEOUT_MS = parseInt(process.env.POOL_SESI_TIMEOUT_MS || '15000', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || String(SESI_TIMEOUT_MS), 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '5000', 10);
const BOOT_GAP_MS = parseInt(process.env.POOL_BOOT_GAP_MS || '4000', 10);
let poolFolder = null;

let deps = {
  launchGatewayBrowser: null,
  dapatkanSesiCookie: null,   // consume (maju index) â€” jangan dipakai di boot pool
  peekSesiCookie: null,       // claim cookie bebas TANPA maju index
  consumeSesiCookie: null,    // sama dengan dapatkanSesiCookie
  releaseCookieLease: null,
  chatgptModule: null,
  MAX_COOKIES: 300,
};
 
const slots = [];
let started = false;

/** Log bertag [POOL_N] agar slot tidak campur di log paralel */
(function patchPoolConsole() {
  if (global.__poolLogPatched) return;
  global.__poolLogPatched = true;
  const orig = console.log.bind(console);
  console.log = (...a) => {
    if (a.length && typeof a[0] === 'string' && a[0].includes('[POOL]') && global.__poolSlotTag) {
      const tag = global.__poolSlotTag;
      if (!a[0].includes(tag)) {
        a = a.slice();
        a[0] = a[0].replace(/\[POOL\]/g, tag);
      }
    }
    return orig(...a);
  };
})();

function poolLog(slotOrId, ...args) {
  const id = (slotOrId && typeof slotOrId === 'object') ? slotOrId.id : slotOrId;
  const tag = id != null ? `[POOL_${id}]` : '[POOL]';
  if (args.length && typeof args[0] === 'string') {
    let s = args[0];
    if (s.includes('[POOL]')) s = s.replace(/\[POOL\]/g, tag);
    else if (!s.startsWith(tag)) s = tag + ' ' + s;
    args = [s, ...args.slice(1)];
  } else {
    args = [tag, ...args];
  }
  console.log(...args);
}


function setDeps(d) {
  deps = { ...deps, ...d };
}

async function stepShot(page, folderHasil, label) {
  try {
    if (!folderHasil || !page) return;
    const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const fp = path.join(folderHasil, `pool_${Date.now()}_${safe}.png`);
    await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
    console.log(`[POOL] Ã°Å¸â€œÂ¸ ${label} Ã¢â€ â€™ ${path.basename(fp)}`);
  } catch (_) {}
}

async function installPopupKiller(page) {
  await page.addInitScript(() => {
    const dismissPopups = () => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (
          txt === 'got it' ||
          txt === 'Ã§Å¸Â¥Ã©Ââ€œÃ¤Âºâ€ ' ||
          txt === 'okay' ||
          txt === 'ok' ||
          txt === 'stay logged out' ||
          txt === 'continue'
        ) {
          try { btn.click(); } catch (e) {}
        }
      }
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        const t = d.innerText || '';
        if (
          t.includes('More relevant') ||
          t.includes('personalized replies') ||
          t.includes('Ã¤Â¸ÂªÃ¦â‚¬Â§Ã¥Å’â€“') ||
          t.includes('already uploaded')
        ) {
          const gotIt = Array.from(d.querySelectorAll('button')).find((b) =>
            /^\s*got it\s*$/i.test((b.textContent || '').trim())
          );
          if (gotIt) {
            try { gotIt.click(); } catch (e) {}
          } else {
            try { d.remove(); } catch (e) {}
          }
        }
      });
    };
    if (!window.__poolPopupKillerInstalled) {
      window.__poolPopupKillerInstalled = true;
      const observer = new MutationObserver(() => dismissPopups());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setInterval(dismissPopups, 800);
    }
    dismissPopups();
  });
}

/** Ready + refresh 5 menit dimatikan. Slot hanya menyimpan PAT, browser sudah ditutup. */
function startKeepAlivePopupGuard(_slot) {}
function stopKeepAlivePopupGuard(slot) {
  if (slot && slot._keepAliveTimer) {
    clearInterval(slot._keepAliveTimer);
    slot._keepAliveTimer = null;
  }
  if (slot && slot._refreshTimer) {
    clearInterval(slot._refreshTimer);
    slot._refreshTimer = null;
  }
}

async function refreshReadySlot(_slot) {
  return;
}

async function deteksiLoginAtauSignup(page) {
  return page.evaluate(() => {
    const texts = [];
    document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40) texts.push(t);
    });
    const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
    for (const t of texts) {
      if (/^(log\s*in|sign\s*up|create\s*account|masuk|daftar)$/i.test(t.trim())) {
        return { hit: true, via: 'btn:' + t };
      }
    }
    if (/log in or sign up/i.test(body)) return { hit: true, via: 'body-auth' };
    if (document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')) {
      return { hit: true, via: 'testid' };
    }
    return { hit: false, via: '' };
  });
}

async function klikAreaKosong(page) {
  try {
    const vp = page.viewportSize() || { width: 1920, height: 1080 };
    await page.mouse.click(Math.floor(vp.width * 0.92), Math.floor(vp.height * 0.5), { delay: 40 });
    await page.waitForTimeout(120);
    await page.mouse.click(Math.floor(vp.width * 0.5), Math.floor(vp.height * 0.92), { delay: 40 });
    await page.waitForTimeout(150);
  } catch (_) {}
}

/** Cookie invalid jika Login/Sign up. Timeout = COOKIE_INVALID (tidak dipaksa lanjut). */
async function tungguSesiValid(page, timeoutMs) {
  const limit = timeoutMs || SESI_TIMEOUT_MS;
  console.log(`[POOL] Ã°Å¸â€Â Cek sesi (max ${limit}ms; login/signup = invalid)...`);
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < limit) {
    const auth = await deteksiLoginAtauSignup(page);
    if (auth.hit) throw new Error('COOKIE_INVALID: ' + auth.via);

    const composer = await page.evaluate(() => {
      const a = document.querySelector('#prompt-textarea');
      if (a) {
        const st = window.getComputedStyle(a);
        if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
      }
      return !!(
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('div.ProseMirror[contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"][aria-label="Ask ChatGPT"]')
      );
    }).catch(() => false);
    if (composer) {
      console.log(`[POOL] Ã¢Å“â€¦ Sesi OK ${Date.now() - t0}ms`);
      return;
    }
    if (Date.now() - lastLog > 2500) {
      lastLog = Date.now();
      console.log(`[POOL] sesiÃ¢â‚¬Â¦ ${Date.now() - t0}ms`);
    }
    await page.waitForTimeout(400);
  }
  const auth2 = await deteksiLoginAtauSignup(page);
  if (auth2.hit) throw new Error('COOKIE_INVALID: ' + auth2.via);
  // Jangan paksa lanjut Ã¢â‚¬â€ anggap cookie tidak aktif
  throw new Error('COOKIE_INVALID: sesi timeout ' + limit + 'ms (composer tidak siap)');
}

async function tungguComposerSiap(page, timeoutMs) {
  console.log('[POOL] Ã¢ÂÂ³ Menunggu kolom teks (composer) siap...');
  await page.waitForFunction(() => {
    const a = document.querySelector('#prompt-textarea');
    if (a) {
      const st = window.getComputedStyle(a);
      if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
    }
    return !!(
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][aria-label="Ask ChatGPT"]')
    );
  }, { timeout: timeoutMs });
  console.log('[POOL] Ã¢Å“â€¦ Composer siap');
}

/** Disalin dari chatgpt.js Ã¢â‚¬â€ fokus nyata + insertText / keyboard */
async function suntikPromptKeComposer(page, promptTeks) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    };
    const list = [];
    const add = (el) => {
      if (visible(el)) list.push(el);
    };
    add(document.querySelector('#prompt-textarea'));
    add(document.querySelector('[data-testid="prompt-textarea"]'));
    document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"]').forEach(add);
    document.querySelectorAll('textarea').forEach(add);
    if (!list.length) return null;
    list.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
    const el = list[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 24) };
  });

  if (clicked) {
    await page.mouse.click(clicked.x, clicked.y, { delay: 30 });
    await page.waitForTimeout(150);
  }

  const ok = await page.evaluate((teks) => {
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    };
    const list = [];
    const add = (el) => {
      if (visible(el)) list.push(el);
    };
    add(document.querySelector('#prompt-textarea'));
    add(document.querySelector('[data-testid="prompt-textarea"]'));
    document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"]').forEach(add);
    document.querySelectorAll('textarea').forEach(add);
    if (!list.length) return false;
    list.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
    const el = list[0];
    el.focus();
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, teks);
    } catch (e) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = teks;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.textContent = teks;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: teks }));
      }
    }
    return (el.innerText || el.textContent || el.value || '').trim().length > 0;
  }, promptTeks);

  if (!ok) {
    await page.keyboard.type(promptTeks, { delay: 8 });
  }
  return true;
}

/** Disalin dari chatgpt.js + marker UI baru (Stop / Working) */
async function klikSendAtauEnter(page) {
  const isGenerating = async () => {
    return page.evaluate(() => {
      return !!(
        document.querySelector('button[aria-label="Stop"]') ||
        document.querySelector('[role="status"][aria-label="Working"]') ||
        document.querySelector('[data-testid="stop-button"]') ||
        document.querySelector('.result-streaming')
      );
    }).catch(() => false);
  };

  // 1) Enter di composer (paling andal di UI lingkaran biru)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  if (await isGenerating()) return 'enter';

  // 2) Klik send Ã¢â‚¬â€ berbagai selector
  const locs = [
    page.locator('[data-testid="send-button"]'),
    page.getByRole('button', { name: /send prompt|kirim perintah|^send$|^kirim$/i }),
    page.locator('button[aria-label*="Send" i]'),
    page.locator('button[aria-label*="Kirim" i]'),
    // Tombol bulat composer (sering tanpa teks) Ã¢â‚¬â€ primary di kanan composer
    page.locator('form button.bg-composer-primary, button[class*="composer"][class*="rounded-full"]').last(),
  ];
  for (const loc of locs) {
    try {
      if (!(await loc.count())) continue;
      const btn = loc.first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ timeout: 2500, force: true });
      await page.waitForTimeout(400);
      if (await isGenerating()) return 'click';
    } catch (_) {}
  }

  // 3) Enter sekali lagi
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  if (await isGenerating()) return 'enter-retry';
  return 'enter-retry';
}

async function destroySlot(slot) {
  stopKeepAlivePopupGuard(slot);
  const { page, context, browser } = slot;
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  slot.cookieId = null;
  slot.cookieIndex = null;
  slot.readyAt = null;
  slot.state = 'dead';
  try { if (page) await page.close().catch(() => {}); } catch (_) {}
  try { if (context) await context.close().catch(() => {}); } catch (_) {}
  try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
}

/**
 * Boot sampai profil+composer Ã¢â‚¬â€ page TETAP HIDUP (HOLD).
 * folderHasil untuk stepShot (opsional).
 */
async function bootSlotOnce(slot, folderHasil) {
  // Pool HANYA sewa cookie bebas (tidak INCR global_chatgpt_index).
  // Bukan current+slotId â€” rumus itu menabrak slot lain setelah index bergeser.
  const peekFn = deps.peekSesiCookie || deps.dapatkanSesiCookie;
  if (!deps.launchGatewayBrowser || !peekFn) {
    throw new Error('pool deps belum di-set (butuh launchGatewayBrowser + peekSesiCookie)');
  }

  slot.state = 'booting';
  global.__poolSlotTag = `[POOL_${slot.id}]`;
  console.log(`[POOL] slot#${slot.id} booting (sewa cookie bebas, index tidak maju)...`);
  await destroySlot(slot);
  slot.state = 'booting';

  const sesi = await peekFn({ exclude: slot.failIds || [] });
  console.log(`[POOL] slot#${slot.id} sewa cookie=${sesi.id} idx=${sesi.index} (tidak dipakai slot/tugas lain)`);
  slot.cookieIndex = sesi.index;
  slot.cookieId = sesi.id;

  const launched = await deps.launchGatewayBrowser();
  const browser = launched.browser;
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies(sesi.cookies);
  const page = await context.newPage();
  // setViewportSize HANG di Camoufox headless+Xvfb Codespace â€” jangan panggil.
  await installPopupKiller(page);

  try {
    console.log(`\n[POOL] Ã°Å¸Å’Â Membuka ChatGPT...`);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await stepShot(page, folderHasil, '01_after_goto');

    await klikAreaKosong(page);
    await tungguSesiValid(page, SESI_TIMEOUT_MS);
    await klikAreaKosong(page);
    await stepShot(page, folderHasil, '02_after_profile');

    await tungguComposerSiap(page, 60000);
    await stepShot(page, folderHasil, '03_composer_ready');
    await page.waitForTimeout(500);
  } catch (e) {
    try { await page.close().catch(() => {}); } catch (_) {}
    try { await context.close().catch(() => {}); } catch (_) {}
    try { await browser.close().catch(() => {}); } catch (_) {}
    if (deps.releaseCookieLease) deps.releaseCookieLease(sesi.id);
    slot.cookieId = null;
    slot.cookieIndex = null;
    slot.failIds = slot.failIds || [];
    if (!slot.failIds.includes(sesi.id)) slot.failIds.push(sesi.id);
    throw e;
  }

  slot.cookies = sesi.cookies;
  slot.readyAt = Date.now();
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  slot.state = 'ready';
  slot.failIds = [];
  try { await page.close().catch(() => {}); } catch (_) {}
  try { await context.close().catch(() => {}); } catch (_) {}
  try { await browser.close().catch(() => {}); } catch (_) {}
  console.log(`[POOL] slot#${slot.id} PAT sehat disimpan cookie=${sesi.id} net=${launched.label} â€” browser ditutup, sewa tetap dipegang`);
}

async function bootSlotLoop(slot, folderHasil) {
  for (;;) {
    if (slot.state === 'busy') return;
    try {
      await bootSlotOnce(slot, folderHasil);
      return;
    } catch (e) {
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) â€” cookie lain dalam ${REBUILD_DELAY_MS}ms`);
      if (String(e.message).includes('tidak ada cookie bebas')) slot.failIds = [];
      await destroySlot(slot);
      await new Promise((r) => setTimeout(r, REBUILD_DELAY_MS));
    }
  }
}

async function bootAllSequential(folderHasil) {
  for (const slot of slots) {
    if (slot.state === 'ready' || slot.state === 'busy') continue;
    await bootSlotLoop(slot, folderHasil);
    await new Promise((r) => setTimeout(r, BOOT_GAP_MS));
  }
  console.log(`[POOL] boot batch selesai:`, poolStats());
}

function acquireReadySlot() {
  const held = new Set();
  for (const s of slots) {
    if (!s.cookieId) continue;
    if (s.state !== 'ready' && s.state !== 'busy') continue;
    if (held.has(s.cookieId) && s.state === 'ready') {
      console.log(`[POOL] slot#${s.id} cookie ${s.cookieId} dobel â€” tidak diberikan, isi ulang`);
      s.failIds = [s.cookieId];
      if (deps.releaseCookieLease) deps.releaseCookieLease(s.cookieId);
      s.state = 'dead';
      s.cookies = null;
      s.cookieId = null;
      enqueueBoot(s, poolFolder);
      continue;
    }
    held.add(s.cookieId);
  }
  const slot = slots.find((s) => s.state === 'ready' && s.cookies && s.cookies.length && s.cookieId);
  if (!slot) return null;
  slot.state = 'busy';
  return slot;
}

let bootChain = Promise.resolve();

function enqueueBoot(slot, folderHasil) {
  bootChain = bootChain
    .then(() => bootSlotLoop(slot, folderHasil))
    .catch((e) => console.error(`[POOL] rebuild slot#${slot.id}:`, e.message));
  return bootChain;
}
function releaseSlot(slot) {
  if (!slot) return;
  const id = slot.id;
  slot.state = 'dead';
  slot.cookies = null;
  slot.cookieId = null;
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  console.log(`[POOL] slot#${id} PAT terpakai â†’ isi slot lagi (antri, 1 boot)`);
  enqueueBoot(slot, poolFolder);
}

function slotPageAlive(slot) {
  try {
    if (!slot.page || !slot.context || !slot.browser) return false;
    if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Kerjakan tugas di PAGE YANG SUDAH READY.
 * Langkah task (thinking / gambar / upload / suntik / send / radar / download)
 * = IDENTIK chatgpt.js lewat eksekusiChatGPT(..., { page, holdPage: true }).
 * Pool hanya mengatur: HOLD page, acquire, rebuild setelah selesai.
 */
async function runTaskOnSlot(slot, { action, prompt, isThinkingMode, translatedFiles, folderHasil }) {
  if (!slot || slot.state !== 'busy') throw new Error('slot tidak busy');
  global.__poolSlotTag = `[POOL_${slot.id}]`;
  const page = slot.page;
  const context = slot.context;
  if (!page || !context) throw new Error('slot page/context hilang');
  if (!deps.chatgptModule || typeof deps.chatgptModule.eksekusiChatGPT !== 'function') {
    throw new Error('pool deps.chatgptModule belum di-set');
  }

  try {
    const url = page.url();
    if (!/chatgpt\.com/i.test(url)) {
      throw new Error('page tidak di chatgpt.com Ã¢â‚¬â€ rebuild');
    }

    // Keep-alive off selama tugas (hindari klik di tengah send/radar)
    stopKeepAlivePopupGuard(slot);

    console.log(`[POOL] slot#${slot.id} Ã¢â€ â€™ chatgpt.js eksekusi (page held)`);
    const hasil = await deps.chatgptModule.eksekusiChatGPT(
      action || 'CHAT',
      prompt || '',
      !!isThinkingMode,
      translatedFiles || [],
      folderHasil,
      context,
      { page, holdPage: true, cookieId: slot.cookieId, poolSlot: slot.id }
    );

    return {
      hasil: { text: hasil && hasil.text, files: (hasil && hasil.files) || [] },
      cookieId: slot.cookieId,
    };
  } finally {
    // Setelah tugas: rebuild slot (page bekas chat tidak di-hold ulang)
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas Ã¢â€ â€™ rebuild`);
    slot.state = 'dead';
    const fh = folderHasil;
    destroySlot(slot)
      .then(() => enqueueBoot(slot, fh))
      .catch((e) => console.error(`[POOL] rebuild slot#${id}:`, e.message));
  }
}

async function startPool(folderHasil) {
  if (started) {
    console.log('[POOL] sudah started, skip');
    return;
  }
  if (!deps.launchGatewayBrowser || !(deps.peekSesiCookie || deps.dapatkanSesiCookie)) {
    console.error('[POOL] start ditolak: deps belum di-set (launch + peekSesiCookie)');
    return;
  }
  started = true;
  poolFolder = folderHasil || null;
  console.log(`[POOL] start size=${POOL_SIZE} | sewa cookie eksklusif (index Redis tidak maju saat boot, MAX=${deps.MAX_COOKIES || '?'})`);
  for (let i = 0; i < POOL_SIZE; i++) {
    slots.push({
      id: i + 1,
      state: 'dead',
      browser: null,
      context: null,
      page: null,
      cookieId: null,
      cookieIndex: null,
      cookies: null,
      failIds: [],
      readyAt: null,
      refreshing: false,
      task: null,
    });
  }
  await bootAllSequential(folderHasil);
}

function poolStats() {
  const c = { ready: 0, busy: 0, booting: 0, dead: 0 };
  for (const s of slots) {
    if (c[s.state] !== undefined) c[s.state]++;
  }
  return c;
}

function isPoolReady() {
  return started && slots.some((s) => s.state === 'ready' && s.cookies && s.cookies.length);
}

module.exports = {
  setDeps,
  startPool,
  acquireReadySlot,
  releaseSlot,
  runTaskOnSlot,
  poolStats,
  isPoolReady,
  POOL_SIZE,
};
