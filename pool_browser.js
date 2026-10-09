/**
 * pool_browser.js
 * - Boot slot: langkah sama seperti chatgpt.js (goto → stepShot → profil → composer) lalu HOLD page
 * - Saat tugas: JANGAN goto ulang. Pakai page yang sudah READY → suntik prompt / mode / upload → radar
 */
const path = require('path');
const fs = require('fs');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || '90000', 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '5000', 10);
const BOOT_GAP_MS = parseInt(process.env.POOL_BOOT_GAP_MS || '4000', 10);

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
    console.log(`[POOL] 📸 ${label} → ${path.basename(fp)}`);
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
          txt === '知道了' ||
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
          t.includes('个性化') ||
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

/** Node-side: tetap klik Got it selama slot READY (pending tunggu tugas) */
function startKeepAlivePopupGuard(slot) {
  stopKeepAlivePopupGuard(slot);
  const tick = async () => {
    if (slot.state !== 'ready' || !slot.page) return;
    try {
      if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return;
      const clicked = await slot.page.evaluate(() => {
        let n = 0;
        document.querySelectorAll('button').forEach((b) => {
          const t = (b.textContent || '').trim().toLowerCase();
          if (t === 'got it' || t === 'okay' || t === 'ok' || t === 'continue' || t === 'stay logged out') {
            try { b.click(); n++; } catch (e) {}
          }
        });
        document.querySelectorAll('[role="dialog"]').forEach((d) => {
          const text = d.innerText || '';
          if (text.includes('More relevant') || text.includes('personalized replies') || text.includes('个性化')) {
            const gotIt = Array.from(d.querySelectorAll('button')).find((b) =>
              /^\s*got it\s*$/i.test((b.textContent || '').trim())
            );
            if (gotIt) {
              try { gotIt.click(); n++; } catch (e) {}
            }
          }
        });
        return n;
      });
      if (clicked > 0) {
        console.log(`[POOL] slot#${slot.id} keep-alive: klik popup x${clicked}`);
      }
    } catch (_) {
      // page navigasi / transient — abaikan
    }
  };
  slot._keepAliveTimer = setInterval(tick, 1000);
  tick();
}

function stopKeepAlivePopupGuard(slot) {
  if (slot && slot._keepAliveTimer) {
    clearInterval(slot._keepAliveTimer);
    slot._keepAliveTimer = null;
  }
}

/** Deteksi profil — selaras chatgpt.js + soft btn+composer */
async function tungguProfilSiap(page, timeoutMs) {
  console.log('[POOL] 👤 Menunggu profil sidebar siap...');
  const t0 = Date.now();
  let ok = false;
  let lastLog = 0;

  while (Date.now() - t0 < timeoutMs) {
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'got it' || t === 'okay' || t === 'ok' || t === 'continue') {
          try { b.click(); } catch (e) {}
        }
      });
    }).catch(() => {});

    const info = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="accounts-profile-button"]');
      const img = btn && (
        btn.querySelector('img[alt="Profile image"]') ||
        btn.querySelector('img[src*="auth0.com/avatars"]') ||
        btn.querySelector('img[src^="http"]')
      );
      const src = img ? (img.getAttribute('src') || img.currentSrc || '') : '';
      const aria = btn ? (btn.getAttribute('aria-label') || '') : '';
      let sidebarName = '';
      const upgradeBtn = Array.from(document.querySelectorAll('button, a, span')).find((el) =>
        /^(Upgrade|Tingkatkan)$/i.test((el.textContent || '').trim())
      );
      if (upgradeBtn) {
        let root = upgradeBtn.closest('div');
        for (let i = 0; i < 6 && root; i++) {
          const t = (root.innerText || '').replace(/\s+/g, ' ').trim();
          if (/\b(Free|Plus|Pro|Team|Bebas)\b/i.test(t) && t.length < 80) {
            sidebarName = t;
            break;
          }
          root = root.parentElement;
        }
      }
      const ariaHasName =
        aria &&
        !/^(open profile menu|buka menu profil)$/i.test(aria.trim()) &&
        aria.trim().length > 5;
      const composer = !!(
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('div.ProseMirror[contenteditable="true"]')
      );
      return {
        hasBtn: !!btn,
        hasImg: !!(src && src.startsWith('http')),
        ariaHasName,
        sidebarName: sidebarName.slice(0, 80),
        composer,
      };
    }).catch(() => ({ hasBtn: false, hasImg: false, ariaHasName: false, sidebarName: '', composer: false }));

    // Hanya profil via sidebar yang diterima (Free/Plus/Pro/Team/Bebas di dekat Upgrade)
    if (info.sidebarName && /\b(Free|Plus|Pro|Team|Bebas)\b/i.test(info.sidebarName)) {
      ok = true;
      console.log(`[POOL] ✅ Profil via sidebar ${Date.now() - t0}ms`);
      break;
    }

    if (Date.now() - lastLog > 2500) {
      lastLog = Date.now();
      console.log(`[POOL] profil… ${Date.now() - t0}ms hasBtn=${info.hasBtn} sidebar=${!!info.sidebarName} composer=${info.composer}`);
    }
    await page.waitForTimeout(300);
  }

  if (!ok) throw new Error('PROFIL_TIMEOUT');
}

async function tungguComposerSiap(page, timeoutMs) {
  console.log('[POOL] ⏳ Menunggu kolom teks (composer) siap...');
  await page.waitForFunction(() => {
    const a = document.querySelector('#prompt-textarea');
    if (a) {
      const st = window.getComputedStyle(a);
      if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
    }
    return !!(
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('div.ProseMirror[contenteditable="true"]')
    );
  }, { timeout: timeoutMs });
  console.log('[POOL] ✅ Composer siap');
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
 * Boot sampai profil+composer — page TETAP HIDUP (HOLD).
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
    console.log(`\n[POOL] 🌐 Membuka ChatGPT...`);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await stepShot(page, folderHasil, '01_after_goto');

    await tungguProfilSiap(page, PROFIL_TIMEOUT_MS);
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
  slot.page = page; // HOLD — jangan ditutup
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
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) — cookie lain dalam ${REBUILD_DELAY_MS}ms`);
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
  const slot = slots.find((s) => s.state === 'ready' && slotPageAlive(s));
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
 * Kerjakan tugas di PAGE YANG SUDAH READY — tanpa goto / tanpa cek profil ulang.
 * Logika tugas disalin ringkas dari chatgpt.js (thinking, gambar mode, upload, prompt, send, radar, download).
 */
async function runTaskOnSlot(slot, { action, prompt, isThinkingMode, translatedFiles, folderHasil }) {
  if (!slot || slot.state !== 'busy') throw new Error('slot tidak busy');
  const page = slot.page;
  const context = slot.context;
  if (!page || !context) throw new Error('slot page/context hilang');

  const tipeTugas = action || 'CHAT';
  const promptTeks = prompt || '';
  const validFiles = (translatedFiles || []).filter((f) => fs.existsSync(f));
  let fileTersimpanArray = [];

  try {
    // Pastikan masih di chatgpt + composer hidup
    const url = page.url();
    if (!/chatgpt\.com/i.test(url)) {
      throw new Error('page tidak di chatgpt.com — rebuild');
    }

    // Bersihkan popup yang sempat muncul saat pending
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'got it' || t === 'okay' || t === 'ok' || t === 'continue') {
          try { b.click(); } catch (e) {}
        }
      });
    }).catch(() => {});

    // Composer harus ada
    await page.waitForSelector('#prompt-textarea, [data-testid="prompt-textarea"], div.ProseMirror[contenteditable="true"]', {
      state: 'visible',
      timeout: 15000,
    });

    if (isThinkingMode) {
      console.log(`[POOL] 🧠 Thinking Mode...`);
      await page.keyboard.press('Control+Shift+M');
      await page.waitForTimeout(800);
    }

    if (tipeTugas === 'GAMBAR') {
      console.log(`[POOL] 🎨 Mode Generasi Gambar...`);
      try {
        const plusBtnSelector = '[data-testid="composer-plus-btn"], #composer-plus-btn';
        await page.waitForSelector(plusBtnSelector, { state: 'visible', timeout: 5000 });
        const plusBox = await page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          if (!btn) return null;
          const rect = btn.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }, plusBtnSelector);
        if (plusBox) await page.mouse.click(plusBox.x, plusBox.y);
        else await page.click(plusBtnSelector);
        await page.waitForTimeout(1500);
        const imgMenuBox = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span'));
          const targetSpan = spans.find(
            (s) =>
              s.textContent.trim().toLowerCase() === 'buat gambar' ||
              s.textContent.trim().toLowerCase() === 'create image'
          );
          if (!targetSpan) return null;
          const clickableDiv =
            targetSpan.closest('.__menu-item') ||
            targetSpan.closest('div[tabindex="0"]') ||
            targetSpan.parentElement;
          const rect = clickableDiv.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        if (imgMenuBox) {
          await page.mouse.move(imgMenuBox.x, imgMenuBox.y, { steps: 5 });
          await page.waitForTimeout(200);
          await page.mouse.click(imgMenuBox.x, imgMenuBox.y);
        }
        await page.waitForTimeout(800);
      } catch (err) {
        console.log(`[POOL] ⚠️ mode gambar: ${err.message}`);
      }
    }

    // Upload (sama JURUS chatgpt.js)
    if (validFiles.length > 0) {
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'];
      const imageFiles = validFiles.filter((f) => imageExtensions.includes(path.extname(f).toLowerCase()));
      const docFiles = validFiles.filter((f) => !imageExtensions.includes(path.extname(f).toLowerCase()));

      if (docFiles.length > 0) {
        console.log(`[POOL] 📄 Upload dokumen ${docFiles.length}...`);
        try {
          await page.locator('#composer-plus-btn, [data-testid="composer-plus-btn"]').click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(400);
          await page.evaluate(() => {
            document.querySelectorAll('input[type="file"]').forEach((input) => {
              input.removeAttribute('accept');
              input.removeAttribute('capture');
            });
          });
          const fileInputs = await page.locator('input[type="file"]').all();
          for (const input of fileInputs) {
            try {
              await input.setInputFiles(docFiles, { force: true });
            } catch (_) {}
          }
        } catch (e) {
          console.log(`[POOL] ❌ doc: ${e.message}`);
        }
      }

      if (imageFiles.length > 0) {
        console.log(`[POOL] 🖼️ Upload gambar ${imageFiles.length}...`);
        try {
          await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(() => {});
          const fileInputs = await page.locator('input[type="file"]').all();
          for (const input of fileInputs) {
            try {
              await input.setInputFiles(imageFiles);
              break;
            } catch (_) {}
          }
        } catch (e) {
          console.log(`[POOL] ❌ img: ${e.message}`);
        }
      }
      await page.waitForTimeout(1500);
    }

    // Baseline
    const { jumlahBubbleAwal, jumlahGambarAwal } = await page.evaluate(() => {
      const genImages = Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter((img) => {
        if (img.closest('.group\\/message-image')) return false;
        const altText = (img.getAttribute('alt') || '').toLowerCase();
        return img.closest('.group\\/imagegen-image') || altText.includes('generated') || altText.includes('dibuat');
      });
      return {
        jumlahBubbleAwal: document.querySelectorAll('[data-message-author-role="assistant"], .markdown.prose').length,
        jumlahGambarAwal: genImages.length,
      };
    });

    console.log(`[POOL] ⚡ Menyuntikkan Prompt...`);
    const textarea = page.locator('#prompt-textarea');
    await textarea.focus().catch(() => {});
    await page.evaluate((teks) => {
      const inputBox = document.querySelector('#prompt-textarea');
      if (inputBox) document.execCommand('insertText', false, teks);
    }, promptTeks);
    await page.waitForTimeout(800);

    console.log(`[POOL] ⏳ Menunggu tombol Send siap...`);
    await page.waitForFunction(() => {
      const sendBtn = document.querySelector('[data-testid="send-button"]');
      if (!sendBtn) return false;
      return !(sendBtn.disabled || sendBtn.hasAttribute('disabled') || sendBtn.getAttribute('aria-disabled') === 'true');
    }, { timeout: 120000 }).catch(() => {});

    console.log(`[POOL] 🚀 Mengirim tugas...`);
    await page.evaluate(() => {
      const sendBtn = document.querySelector('[data-testid="send-button"]');
      if (sendBtn) sendBtn.click();
    });
    await stepShot(page, folderHasil, '08_after_send');

    // Radar (subset chatgpt.js)
    console.log('\n[POOL] ⏳ Radar DOM...');
    let hasilEktraksi = null;
    const waktuMulai = Date.now();
    while (Date.now() - waktuMulai < 300000) {
      const state = await page.evaluate((args) => {
        const { bAwal, gAwal, mode } = args;
        if (
          document.body.innerText.toLowerCase().includes("you've reached our limit") ||
          document.body.innerText.toLowerCase().includes('batas penggunaan')
        ) {
          return { status: 'error', msg: 'LIMIT_AKUN_TERCAPAI' };
        }
        if (document.querySelector('[data-testid="stop-button"]') || document.querySelector('.result-streaming')) {
          return { status: 'loading' };
        }
        const getGenImages = () =>
          Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter((img) => {
            if (img.closest('.group\\/message-image')) return false;
            return (
              img.closest('.group\\/imagegen-image') ||
              (img.getAttribute('alt') || '').toLowerCase().includes('generated') ||
              (img.getAttribute('alt') || '').toLowerCase().includes('dibuat')
            );
          });

        if (mode === 'GAMBAR') {
          const allGenImages = getGenImages();
          if (allGenImages.length > gAwal) {
            const newestImage = allGenImages[allGenImages.length - 1];
            const container =
              newestImage.closest('.group\\/imagegen-image') ||
              newestImage.parentElement.parentElement.parentElement;
            const actionButtons = container ? container.querySelectorAll('button') : [];
            if (actionButtons.length >= 2) {
              let uniqueImageUrls = [...new Set(allGenImages.slice(gAwal).map((img) => img.src))];
              if (uniqueImageUrls.length > 1) uniqueImageUrls = [uniqueImageUrls[0]];
              return { status: 'done', images: uniqueImageUrls, text: null };
            }
          }
        } else {
          const messages = Array.from(
            document.querySelectorAll('[data-message-author-role="assistant"], .markdown.prose')
          );
          if (messages.length > bAwal) {
            const lastMessage = messages[messages.length - 1];
            const parentBlock =
              lastMessage.closest('[data-testid^="conversation-turn"]') ||
              lastMessage.parentElement.parentElement;
            const actionButtons = parentBlock ? parentBlock.querySelectorAll('button') : [];
            if (actionButtons.length >= 2 && !document.querySelector('.result-streaming')) {
              const textContainer = lastMessage.querySelector('.markdown.prose') || lastMessage;
              const finalTxt = textContainer.innerText.trim();
              return { status: 'done', text: finalTxt, images: [] };
            }
          }
        }
        return { status: 'waiting' };
      }, { bAwal: jumlahBubbleAwal, gAwal: jumlahGambarAwal, mode: tipeTugas });

      if (state.status === 'done') {
        hasilEktraksi = state;
        break;
      }
      if (state.status === 'error') throw new Error(state.msg);
      await page.waitForTimeout(2000);
    }

    if (!hasilEktraksi) throw new Error('TIMEOUT: ChatGPT gagal memuat respon.');

    // Download gambar jika ada
    if (hasilEktraksi.images && hasilEktraksi.images.length > 0 && folderHasil) {
      const https = require('https');
      const http = require('http');
      for (let i = 0; i < hasilEktraksi.images.length; i++) {
        const imgUrl = hasilEktraksi.images[i];
        const fileName = `chatgpt_IMG_${Date.now()}_${i + 1}.webp`;
        const dest = path.join(folderHasil, fileName);
        try {
          const cookiesArray = await context.cookies();
          const cookieStr = cookiesArray.map((c) => `${c.name}=${c.value}`).join('; ');
          await new Promise((resolve, reject) => {
            const lib = imgUrl.startsWith('https') ? https : http;
            const req = lib.get(
              imgUrl,
              {
                headers: {
                  Cookie: cookieStr,
                  'User-Agent': 'Mozilla/5.0',
                  Referer: 'https://chatgpt.com/',
                },
              },
              (res) => {
                if (res.statusCode === 200 || res.statusCode === 206) {
                  const file = fs.createWriteStream(dest);
                  res.pipe(file);
                  file.on('finish', () => {
                    file.close();
                    resolve(true);
                  });
                } else reject(new Error('HTTP ' + res.statusCode));
              }
            );
            req.on('error', reject);
            req.setTimeout(30000, () => {
              req.destroy();
              reject(new Error('Timeout'));
            });
          });
          if (fs.existsSync(dest)) fileTersimpanArray.push(fileName);
        } catch (_) {}
      }
    }

    return {
      hasil: { text: hasilEktraksi.text, files: fileTersimpanArray },
      cookieId: slot.cookieId,
    };
  } finally {
    // Setelah tugas: rebuild slot (page bekas chat tidak di-hold ulang)
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas → rebuild`);
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
