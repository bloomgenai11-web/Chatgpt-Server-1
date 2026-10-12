/**
 * pool_browser.js
 * - Boot slot: langkah sama seperti chatgpt.js (goto â†’ stepShot â†’ profil â†’ composer) lalu HOLD page
 * - Saat tugas: JANGAN goto ulang. Pakai page yang sudah READY â†’ suntik prompt / mode / upload â†’ radar
 */
const path = require('path');
const fs = require('fs');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
// Timeout cek sesi (login/signup vs composer) â€” 15 detik, lalu cookie berikutnya
const SESI_TIMEOUT_MS = parseInt(process.env.POOL_SESI_TIMEOUT_MS || '15000', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || String(SESI_TIMEOUT_MS), 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '5000', 10);
const BOOT_GAP_MS = parseInt(process.env.POOL_BOOT_GAP_MS || '4000', 10);
const READY_REFRESH_MS = parseInt(process.env.POOL_READY_REFRESH_MS || String(5 * 60 * 1000), 10);

let deps = {
  launchGatewayBrowser: null,
  dapatkanSesiCookie: null,
  chatgptModule: null,
};
 
const slots = [];
let started = false;

function setDeps(d) {
  deps = { ...deps, ...d };
}

async function stepShot(page, folderHasil, label) {
  try {
    if (!folderHasil || !page) return;
    const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const fp = path.join(folderHasil, `pool_${Date.now()}_${safe}.png`);
    await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
    console.log(`[POOL] ðŸ“¸ ${label} â†’ ${path.basename(fp)}`);
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
          txt === 'çŸ¥é“äº†' ||
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
          t.includes('ä¸ªæ€§åŒ–') ||
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

/** Node-side: klik area kosong saat pending. Refresh halaman hanya tiap 5 menit, hanya saat READY. */
function startKeepAlivePopupGuard(slot) {
  stopKeepAlivePopupGuard(slot);
  const tick = async () => {
    if (slot.state !== 'ready' || slot.refreshing || !slot.page) return;
    try {
      if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return;
      await klikAreaKosong(slot.page);
    } catch (_) {}
  };
  slot._keepAliveTimer = setInterval(tick, 8000);
  slot._refreshTimer = setInterval(() => {
    refreshReadySlot(slot).catch((e) => console.log(`[POOL] slot#${slot.id} refresh error: ${e.message}`));
  }, READY_REFRESH_MS);
}
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

async function refreshReadySlot(slot) {
  if (!slot || slot.state !== 'ready' || slot.refreshing || !slot.page) return;
  slot.refreshing = true;
  console.log(`[POOL] slot#${slot.id} refresh 5 menit (ready, bukan saat tugas)`);
  try {
    await slot.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await slot.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await klikAreaKosong(slot.page);
    await tungguSesiValid(slot.page, SESI_TIMEOUT_MS);
    await tungguComposerSiap(slot.page, 20000);
    console.log(`[POOL] slot#${slot.id} refresh selesai, tetap READY`);
  } catch (e) {
    console.log(`[POOL] slot#${slot.id} refresh gagal (${e.message}) â€” cookie lain`);
    slot.refreshing = false;
    slot.state = 'dead';
    destroySlot(slot)
      .then(() => bootSlotLoop(slot, null))
      .catch((err) => console.error(`[POOL] rebuild setelah refresh:`, err.message));
    return;
  }
  slot.refreshing = false;
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
  console.log(`[POOL] ðŸ” Cek sesi (max ${limit}ms; login/signup = invalid)...`);
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
      console.log(`[POOL] âœ… Sesi OK ${Date.now() - t0}ms`);
      return;
    }
    if (Date.now() - lastLog > 2500) {
      lastLog = Date.now();
      console.log(`[POOL] sesiâ€¦ ${Date.now() - t0}ms`);
    }
    await page.waitForTimeout(400);
  }
  const auth2 = await deteksiLoginAtauSignup(page);
  if (auth2.hit) throw new Error('COOKIE_INVALID: ' + auth2.via);
  // Jangan paksa lanjut â€” anggap cookie tidak aktif
  throw new Error('COOKIE_INVALID: sesi timeout ' + limit + 'ms (composer tidak siap)');
}

async function tungguComposerSiap(page, timeoutMs) {
  console.log('[POOL] â³ Menunggu kolom teks (composer) siap...');
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
  console.log('[POOL] âœ… Composer siap');
}

/** Disalin dari chatgpt.js â€” fokus nyata + insertText / keyboard */
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

  // 2) Klik send â€” berbagai selector
  const locs = [
    page.locator('[data-testid="send-button"]'),
    page.getByRole('button', { name: /send prompt|kirim perintah|^send$|^kirim$/i }),
    page.locator('button[aria-label*="Send" i]'),
    page.locator('button[aria-label*="Kirim" i]'),
    // Tombol bulat composer (sering tanpa teks) â€” primary di kanan composer
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
  slot.readyAt = null;
  slot.state = 'dead';
  try { if (page) await page.close().catch(() => {}); } catch (_) {}
  try { if (context) await context.close().catch(() => {}); } catch (_) {}
  try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
}

/**
 * Boot sampai profil+composer â€” page TETAP HIDUP (HOLD).
 * folderHasil untuk stepShot (opsional).
 */
async function bootSlotOnce(slot, folderHasil) {
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    throw new Error('pool deps belum di-set');
  }

  slot.state = 'booting';
  console.log(`[POOL] slot#${slot.id} booting (cara gateway)...`);
  await destroySlot(slot);

  const sesi = await deps.dapatkanSesiCookie();
  console.log(`[POOL] slot#${slot.id} cookie=${sesi.id}`);

  const launched = await deps.launchGatewayBrowser();
  const browser = launched.browser;
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies(sesi.cookies);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await installPopupKiller(page);

  try {
    console.log(`\n[POOL] ðŸŒ Membuka ChatGPT...`);
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
    throw e;
  }

  slot.browser = browser;
  slot.context = context;
  slot.page = page; // HOLD â€” jangan ditutup
  slot.cookieId = sesi.id;
  slot.readyAt = Date.now();
  slot.state = 'ready';
  startKeepAlivePopupGuard(slot);
  console.log(`[POOL] slot#${slot.id} READY cookie=${sesi.id} net=${launched.label} (page held, popup guard on)`);
}

async function bootSlotLoop(slot, folderHasil) {
  for (;;) {
    if (slot.state === 'busy') return;
    try {
      await bootSlotOnce(slot, folderHasil);
      return;
    } catch (e) {
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) â€” cookie lain dalam ${REBUILD_DELAY_MS}ms`);
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
  const slot = slots.find((s) => s.state === 'ready' && !s.refreshing && slotPageAlive(s));
  if (!slot) return null;
  stopKeepAlivePopupGuard(slot);
  slot.state = 'busy';
  return slot;
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
  const page = slot.page;
  const context = slot.context;
  if (!page || !context) throw new Error('slot page/context hilang');
  if (!deps.chatgptModule || typeof deps.chatgptModule.eksekusiChatGPT !== 'function') {
    throw new Error('pool deps.chatgptModule belum di-set');
  }

  try {
    const url = page.url();
    if (!/chatgpt\.com/i.test(url)) {
      throw new Error('page tidak di chatgpt.com â€” rebuild');
    }

    // Keep-alive off selama tugas (hindari klik di tengah send/radar)
    stopKeepAlivePopupGuard(slot);

    console.log(`[POOL] slot#${slot.id} â†’ chatgpt.js eksekusi (page held)`);
    const hasil = await deps.chatgptModule.eksekusiChatGPT(
      action || 'CHAT',
      prompt || '',
      !!isThinkingMode,
      translatedFiles || [],
      folderHasil,
      context,
      { page, holdPage: true }
    );

    return {
      hasil: { text: hasil && hasil.text, files: (hasil && hasil.files) || [] },
      cookieId: slot.cookieId,
    };
  } finally {
    // Setelah tugas: rebuild slot (page bekas chat tidak di-hold ulang)
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas â†’ rebuild`);
    slot.state = 'dead';
    const fh = folderHasil;
    destroySlot(slot)
      .then(() => bootSlotLoop(slot, fh))
      .catch((e) => console.error(`[POOL] rebuild slot#${id}:`, e.message));
  }
}

async function startPool(folderHasil) {
  if (started) {
    console.log('[POOL] sudah started, skip');
    return;
  }
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    console.error('[POOL] start ditolak: deps belum di-set');
    return;
  }
  started = true;
  console.log(`[POOL] start size=${POOL_SIZE} (sequential, hold page setelah profil)`);
  for (let i = 0; i < POOL_SIZE; i++) {
    slots.push({
      id: i + 1,
      state: 'dead',
      browser: null,
      context: null,
      page: null,
      cookieId: null,
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
  return started && slots.some((s) => s.state === 'ready' && slotPageAlive(s));
}

module.exports = {
  setDeps,
  startPool,
  acquireReadySlot,
  runTaskOnSlot,
  poolStats,
  isPoolReady,
  POOL_SIZE,
};
