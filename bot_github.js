const { Camoufox } = require('./camoufox_compat');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// ====================== CONFIG (.env) ======================
const HEADLESS = process.env.HEADLESS !== 'false';
const OUTPUT_FILE = path.join(__dirname, 'github_accounts.txt');

// Proxy untuk GitHub saja (Smartproxy / residential). AtomicMail = tanpa proxy.
// Prioritas: BOT_PROXY_* ; fallback PROXY_* (legacy)
const BOT_PROXY_HOST = process.env.BOT_PROXY_HOST || process.env.PROXY_HOST || '';
const BOT_PROXY_PORT = parseInt(process.env.BOT_PROXY_PORT || process.env.PROXY_PORT || '0', 10);
const BOT_PROXY_USER = process.env.BOT_PROXY_USER || '';
const BOT_PROXY_PASS = process.env.BOT_PROXY_PASS || '';
const BOT_PROXY_TYPE = (process.env.BOT_PROXY_TYPE || 'socks5').toLowerCase(); // socks5 | http
const BOT_PROXY_VERSION = parseInt(process.env.BOT_PROXY_VERSION || '5', 10);

const REDIS_QUEUE_KEY = process.env.REDIS_QUEUE_KEY || 'atomicmail:accounts';
const MAX_PAT_STOCK = 3; // bot hanya isi jika stok PAT < 3
const SHIFTS_PER_PAT = parseInt(process.env.SHIFTS_PER_PAT || '24', 10); // 24 × 30 menit = 12 jam
const GATE_POLL_MS = 30000;
const IDLE_TIMEOUT_MINUTES = 240;
// ===========================================================

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function randomString(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function randomPassword() {
  return 'Gh1!' + randomString(12);
}

function randomUsername() {
  const bases = ['dev', 'code', 'neo', 'byte', 'pixel', 'fox', 'wolf', 'sky', 'core'];
  return bases[Math.floor(Math.random() * bases.length)] + Math.floor(1000 + Math.random() * 9000);
}

/**
 * Stok PAT = Redis LIST (bukan JSON string).
 * Bot hanya: LLEN (hitung) + RPUSH (suntik belakang).
 * Gateway: LRANGE / LINDEX + LREM (hapus).
 */
async function getPatStockCount() {
  try {
    const n = await redis.llen('github_pats');
    return typeof n === 'number' ? n : 0;
  } catch {
    return 0;
  }
}

/** Suntik PAT langsung di belakang — tidak baca/salin seluruh list */
async function appendPatToRedis(pat) {
  if (!pat || !String(pat).startsWith('ghp_')) return false;
  try {
    const len = await redis.rpush('github_pats', String(pat).trim());
    console.log(`[PAT] ✅ RPUSH github_pats. Total sekarang: ${len}`);
    // kuota shift default 4 (hash terpisah, ditulis sekali)
    try {
      const shifts = (await redis.get('pat_shift_quota')) || {};
      const obj = typeof shifts === 'object' && shifts !== null ? shifts : {};
      if (obj[pat] === undefined) {
        obj[pat] = SHIFTS_PER_PAT;
        await redis.set('pat_shift_quota', obj);
      }
    } catch {}
    return true;
  } catch (e) {
    console.log('[PAT] ❌ Gagal RPUSH:', e.message);
    return false;
  }
}

/**
 * Proxy Playwright-format untuk browser GitHub saja (auth user/pass).
 * Satu browser = satu sesi proxy = satu fingerprint Camoufox.
 * AtomicMail TIDAK memakai ini.
 */
function buildGithubProxyOption() {
  if (!BOT_PROXY_HOST || !BOT_PROXY_PORT) return undefined;
  const scheme = BOT_PROXY_TYPE === 'socks5' ? 'socks5' : 'http';
  const opt = {
    server: `${scheme}://${BOT_PROXY_HOST}:${BOT_PROXY_PORT}`,
  };
  if (BOT_PROXY_USER) opt.username = BOT_PROXY_USER;
  if (BOT_PROXY_PASS) opt.password = BOT_PROXY_PASS;
  return opt;
}

function buildGithubBasePrefs() {
  return {
    'webgl.force-enabled': true,
    'webgl.disabled': false,
    'webgl.osmesa': true,
    'layers.acceleration.force-enabled': true,
    'dom.maxHardwareConcurrency': 8,
    'pdfjs.disabled': true,
    'browser.helperApps.neverAsk.saveToDisk': 'application/pdf,image/webp',
  };
}

/** Error: IP/proxy jelek — email dikembalikan ke antrian, coba lagi fingerprint+IP baru */
class BadIpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadIpError';
    this.code = 'BAD_IP';
  }
}

/** Error: email bermasalah — sudah di-LPOP, jangan dikembalikan */
class BadEmailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BadEmailError';
    this.code = 'BAD_EMAIL';
  }
}

async function ambilAkunDariRedis() {
  const raw = await redis.lpop(REDIS_QUEUE_KEY);
  if (!raw) return null;
  const str = typeof raw === 'string' ? raw : String(raw);
  if (!str.includes(':')) return null;
  const [email, ...rest] = str.split(':');
  return { email: email.trim(), password: rest.join(':').trim() };
}

/** Kembalikan email ke antrian (depan) karena IP jelek */
async function kembalikanEmailKeAntrian(email, password) {
  const item = `${email}:${password}`;
  try {
    await redis.lpush(REDIS_QUEUE_KEY, item);
    console.log(`[Redis] ↩️ Email dikembalikan ke antrian (BAD_IP): ${email}`);
  } catch (e) {
    console.log(`[Redis] ❌ Gagal kembalikan email: ${e.message}`);
  }
}

async function sisaAntrianRedis() {
  try {
    return await redis.llen(REDIS_QUEUE_KEY);
  } catch {
    return -1;
  }
}

// ---------------- Human typing ----------------
async function humanType(page, selector, text) {
  const el = page.locator(selector);
  await el.waitFor({ state: 'visible', timeout: 10000 });
  await el.click({ delay: 50 });
  await el.fill('');
  await page.waitForTimeout(200);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 45 + Math.random() * 80 });
  }
  await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    if (!input) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    input.dispatchEvent(new Event('focusout', { bubbles: true }));
  }, selector);
  await page.waitForTimeout(800 + Math.random() * 500);
}

async function waitForSuccess(page, selector, timeout = 15000) {
  try {
    await page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        return el.classList.contains('is-autocheck-successful') ||
               el.closest('auto-check')?.classList.contains('successed');
      },
      selector,
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

// ====================== ATOMICMAIL LOKAL (tanpa proxy) ======================
async function loginAtomicMailLocal(email, password) {
  console.log(`[AtomicMail/LOCAL] Login ${email}...`);
  const browser = await Camoufox({
    headless: HEADLESS,
    width: 1280,
    height: 720,
    geoip: false,
    firefoxUserPrefs: {
      'webgl.force-enabled': true,
      'network.proxy.type': 0,
    }
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('https://atomicmail.io/app/auth/sign-in', {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });
    await page.waitForSelector('input[name="username"]', { state: 'visible', timeout: 15000 });
    await page.locator('input[name="username"]').fill(email.split('@')[0]);
    await page.locator('[data-testid="login-submit"]').click();
    await page.waitForSelector('input[name="password"]', { state: 'visible', timeout: 10000 });
    await page.locator('input[name="password"]').fill(password);
    await page.locator('[data-testid="login-signin-button"]').click();
    await page.waitForSelector('[data-testid="email-list-item"]', {
      state: 'visible',
      timeout: 45000
    });
    console.log('[AtomicMail/LOCAL] Inbox siap');
    return { browser, page };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

async function ambilLinkVerifikasiGitHub(atomicPage, timeout = 90000) {
  console.log('[AtomicMail] Cari email GitHub...');
  const start = Date.now();
  let emailClicked = false;
  while (Date.now() - start < timeout) {
    emailClicked = await atomicPage.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[data-testid="email-list-item"]'));
      for (const item of items) {
        const text = (item.innerText || '').toLowerCase();
        if (text.includes('github') || text.includes('launch code')) {
          (item.querySelector('a') || item).click();
          return true;
        }
      }
      return false;
    });
    if (emailClicked) break;
    await atomicPage.waitForTimeout(1000);
  }
  if (!emailClicked) throw new Error('Email GitHub tidak ditemukan');

  await atomicPage.waitForTimeout(3500);
  console.log('[AtomicMail] Ekstrak link /confirm/...');

  let verifyUrl = null;
  const extractStart = Date.now();
  while (Date.now() - extractStart < 20000) {
    verifyUrl = await atomicPage.evaluate(() => {
      function deepQuery(selector, root = document) {
        const results = [];
        function search(node) {
          if (!node) return;
          if (node.querySelectorAll) {
            try { node.querySelectorAll(selector).forEach(el => results.push(el)); } catch (e) {}
          }
          if (node.shadowRoot) search(node.shadowRoot);
          if (node.children) for (const child of node.children) search(child);
        }
        search(root);
        return results;
      }
      const hrefs = deepQuery('a[href*="github.com"]').map(a => a.href);
      let best = hrefs.find(h =>
        h.includes('/account_verifications/confirm/') &&
        !h.includes('?') &&
        /\/confirm\/[a-f0-9\-]{36}\/\d+/.test(h)
      );
      if (!best) best = hrefs.find(h => h.includes('/account_verifications/confirm/'));
      if (!best) {
        function getAllText(node) {
          let text = '';
          if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
          if (node.shadowRoot) text += getAllText(node.shadowRoot);
          if (node.childNodes) for (const c of node.childNodes) text += getAllText(c);
          return text;
        }
        const m = getAllText(document.body).match(
          /https:\/\/github\.com\/account_verifications\/confirm\/[a-f0-9\-]{36}\/\d+/
        );
        if (m) best = m[0];
      }
      return best || null;
    });
    if (verifyUrl) break;
    await atomicPage.waitForTimeout(800);
  }
  if (!verifyUrl) throw new Error('Link confirm tidak ditemukan');
  verifyUrl = verifyUrl.split(/[\s"'<>]/)[0].replace(/[.,;)\]]+$/, '');
  console.log(`[AtomicMail] ✅ ${verifyUrl}`);
  return verifyUrl;
}

// ====================== MAIN FLOW ======================
async function buatSatuAkunGitHub(atomicEmail, atomicPassword) {
  console.log('\n🚀 Buat akun GitHub...');
  console.log(`📧 ${atomicEmail}`);

  const password = randomPassword();
  let username = randomUsername();

  // Satu akun = satu browser = satu sesi proxy = satu fingerprint Camoufox
  const proxyOpt = buildGithubProxyOption();
  const browser = await Camoufox({
    headless: HEADLESS,
    width: 1280,
    height: 720,
    geoip: !!proxyOpt,
    proxy: proxyOpt,
    firefoxUserPrefs: buildGithubBasePrefs()
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log('🌐 Cek IP proxy...');
    await page.goto('https://api.ipify.org', { waitUntil: 'domcontentloaded', timeout: 20000 });
    console.log(`✅ IP: ${await page.innerText('body')}`);

    console.log('🌐 github.com/signup...');
    try {
      await page.goto('https://github.com/signup', { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(2000);
    } catch (e) {
      throw new BadIpError(`Gagal buka signup (IP?): ${e.message}`);
    }

    // --- Fase email: gagal di sini = BAD_IP (kembalikan email, fingerprint+IP baru) ---
    console.log('✍️  email...');
    try {
      const emailEl = page.locator('#email');
      await emailEl.waitFor({ state: 'visible', timeout: 20000 });
      await humanType(page, '#email', atomicEmail);
      const emailOk = await waitForSuccess(page, '#email');
      console.log(emailOk ? '✅ email' : '⚠️ email (lanjut)');
    } catch (e) {
      throw new BadIpError(`Gagal isi/lihat kolom email (IP jelek?): ${e.message}`);
    }
    // Email sudah masuk kolom → kegagalan setelah ini = BAD_EMAIL

    console.log('✍️  password...');
    try {
      await humanType(page, '#password', password);
      console.log((await waitForSuccess(page, '#password')) ? '✅ password' : '⚠️ password');
    } catch (e) {
      throw new BadEmailError(`Gagal isi password: ${e.message}`);
    }

    console.log('✍️  username...');
    await humanType(page, '#login', username);
    if (!(await waitForSuccess(page, '#login'))) {
      for (let i = 1; i <= 6; i++) {
        const newUser = `${username}${i}`;
        await humanType(page, '#login', newUser);
        if (await waitForSuccess(page, '#login', 8000)) {
          username = newUser;
          break;
        }
      }
    }
    console.log(`✅ username: ${username}`);
    await page.waitForTimeout(2500);

    const createSelector = 'button.js-octocaptcha-form-submit[type="submit"]';
    await page.waitForFunction(
      (sel) => {
        const btn = document.querySelector(sel);
        return btn && !btn.hasAttribute('disabled') && !btn.disabled;
      },
      createSelector,
      { timeout: 45000 }
    );
    console.log('🖱️  Create account...');
    await page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (!btn) throw new Error('Tombol Create account tidak ditemukan');
      btn.scrollIntoView({ block: 'center' });
      btn.focus();
      btn.click();
    }, createSelector);
    await page.waitForTimeout(2500);

    console.log('⏳ Tunggu email verifikasi...');
    await page.waitForTimeout(15000);

    // AtomicMail lokal
    let atomicBrowser = null;
    let verifyUrl = null;
    try {
      const atomic = await loginAtomicMailLocal(atomicEmail, atomicPassword);
      atomicBrowser = atomic.browser;
      verifyUrl = await ambilLinkVerifikasiGitHub(atomic.page);
    } finally {
      if (atomicBrowser) await atomicBrowser.close().catch(() => {});
    }

    console.log('🔗 Buka link verifikasi...');
    await page.bringToFront();
    await page.goto(verifyUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(3000);
    console.log(`📍 ${page.url()}`);

    // Login ulang jika perlu
    if (page.url().includes('/login') || (await page.locator('#login_field').count()) > 0) {
      console.log('[Login] Isi form...');
      await page.waitForSelector('#login_field', { state: 'visible', timeout: 10000 });
      await page.fill('#login_field', atomicEmail);
      await page.waitForTimeout(400);
      await page.fill('#password', password);
      await page.waitForTimeout(400);
      await page.click('input[type="submit"][name="commit"], input.js-sign-in-button, button[type="submit"]');
      await page.waitForTimeout(4000);
    }

    // Idle timeout 240
    console.log(`\n========== IDLE TIMEOUT ${IDLE_TIMEOUT_MINUTES} ==========`);
    try {
      await page.goto('https://github.com/settings/codespaces', {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      await page.waitForTimeout(2000);
      const idleSelectors = [
        'input[name="user[codespaces_idle_timeout]"]',
        'input[id*="idle"]',
        'input[name*="idle_timeout"]',
        'input[type="number"]'
      ];
      let idleSet = false;
      for (const sel of idleSelectors) {
        if ((await page.locator(sel).count()) > 0) {
          await page.fill(sel, String(IDLE_TIMEOUT_MINUTES));
          idleSet = true;
          break;
        }
      }
      if (!idleSet) {
        idleSet = await page.evaluate((mins) => {
          const all = Array.from(document.querySelectorAll('label, h2, h3, div, span'));
          for (const el of all) {
            const t = (el.innerText || '').toLowerCase();
            if (t.includes('idle timeout') || t.includes('default idle')) {
              const input = el.parentElement?.querySelector('input') ||
                el.closest('form')?.querySelector('input[type="number"], input[type="text"]');
              if (input) {
                input.value = String(mins);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              }
            }
          }
          return false;
        }, IDLE_TIMEOUT_MINUTES);
      }
      if (idleSet) {
        await page.locator('button:has-text("Save"), button[type="submit"]').first().click().catch(() => {});
        await page.waitForTimeout(2000);
        console.log(`[Codespaces] ✅ Idle = ${IDLE_TIMEOUT_MINUTES}`);
      } else {
        console.log('[Codespaces] ⚠️ Input idle tidak ketemu');
      }
    } catch (e) {
      console.log('[Codespaces] ❌', e.message);
    }

    // PAT classic
    console.log('\n========== BUAT PAT ==========');
    let pat = null;
    try {
      await page.goto('https://github.com/settings/tokens/new', {
        waitUntil: 'networkidle',
        timeout: 45000
      });
      await page.waitForTimeout(2000);
      const noteSel = '#oauth_access_description, input[name="oauth_access[description]"]';
      await page.waitForSelector(noteSel, { state: 'visible', timeout: 10000 });
      await page.fill(noteSel, `codespace-${username}`);
      await page.waitForTimeout(300);
      try {
        await page.locator('text=No expiration').first().click({ timeout: 3000 }).catch(() => {});
        await page.selectOption('select#expiration, select[name*="expires"]', 'none').catch(() => {});
      } catch {}

      const scopes = ['codespace', 'repo', 'read:user', 'user:email', 'workflow'];
      for (const scope of scopes) {
        try {
          const cb = page.locator(`input[type="checkbox"][value="${scope}"]`).first();
          if ((await cb.count()) > 0) await cb.check({ force: true });
        } catch {}
      }
      await page.evaluate(() => {
        for (const label of document.querySelectorAll('label')) {
          const t = (label.innerText || '').toLowerCase();
          if (t.includes('codespace') || t.includes('full control of private repositories') || t.includes('repo')) {
            const input = label.querySelector('input[type="checkbox"]') ||
              document.getElementById(label.getAttribute('for'));
            if (input && !input.checked) input.click();
          }
        }
      });
      await page.waitForTimeout(800);
      await page.locator('button:has-text("Generate token"), button[type="submit"]').first().click();
      await page.waitForTimeout(3500);
      pat = await page.evaluate(() => {
        const el = document.querySelector('#new-oauth-token, code.user-select-all, input[readonly]');
        if (el) return el.value || el.innerText || el.textContent;
        const m = document.body.innerText.match(/ghp_[a-zA-Z0-9]{36,}/);
        return m ? m[0] : null;
      });
      if (pat) console.log(`[PAT] ✅ ${pat.substring(0, 15)}...`);
      else console.log('[PAT] ⚠️ tidak terambil otomatis');
    } catch (e) {
      console.log('[PAT] ❌', e.message);
    }

    if (pat) await appendPatToRedis(pat);

    const account = {
      email: atomicEmail,
      password,
      username,
      pat: pat || null,
      idle_timeout: IDLE_TIMEOUT_MINUTES,
      created_at: new Date().toISOString(),
      final_url: page.url()
    };
    fs.appendFileSync(OUTPUT_FILE, JSON.stringify(account) + '\n');
    console.log('\n✅ SELESAI');
    console.log(JSON.stringify(account, null, 2));
    return account;
  } catch (err) {
    console.error(`❌ ${err.message}`);
    const safe = atomicEmail.replace(/[^a-zA-Z0-9]/g, '_');
    await page.screenshot({ path: `error_${safe}.png` }).catch(() => {});
    // Pastikan tetap typed error ke main
    if (err instanceof BadIpError || err instanceof BadEmailError) throw err;
    // Error lain setelah email terisi → anggap BAD_EMAIL (email sudah di-LPOP)
    if (err.code === 'BAD_IP') throw err;
    throw new BadEmailError(err.message || String(err));
  } finally {
    if (!HEADLESS) {
      console.log('\nBrowser terbuka 15 detik...');
      await page.waitForTimeout(15000);
    }
    await browser.close().catch(() => {});
  }
}

async function main() {
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    console.error('❌ Isi UPSTASH_REDIS_* di .env');
    process.exit(1);
  }
  if (!BOT_PROXY_HOST || !BOT_PROXY_PORT) {
    console.error('❌ Isi BOT_PROXY_HOST / BOT_PROXY_PORT di .env (proxy khusus GitHub)');
    process.exit(1);
  }

  console.log(`[Bot proxy] ${BOT_PROXY_TYPE} ${BOT_PROXY_HOST}:${BOT_PROXY_PORT}` +
    (BOT_PROXY_USER ? ` user=${BOT_PROXY_USER}` : ''));
  console.log(`[Gate] PAT < ${MAX_PAT_STOCK} | tanpa batas IP | AtomicMail = lokal`);
  console.log(`[Email] Redis list: ${REDIS_QUEUE_KEY}`);
  console.log(`[Idle] ${IDLE_TIMEOUT_MINUTES} menit`);

  let index = 0;
  while (true) {
    // 1) stok PAT
    const patCount = await getPatStockCount();
    if (patCount >= MAX_PAT_STOCK) {
      console.log(`[GATE] PAT stok ${patCount} >= ${MAX_PAT_STOCK}. Tunggu...`);
      await new Promise(r => setTimeout(r, GATE_POLL_MS));
      continue;
    }

    // 2) antrian email
    const sisa = await sisaAntrianRedis();
    if (sisa === 0) {
      console.log('[Redis] Queue email kosong. Selesai.');
      break;
    }

    // 3) ambil email (tidak ada limit IP)
    const akun = await ambilAkunDariRedis();
    if (!akun) {
      console.log('[Redis] LPOP kosong. Selesai.');
      break;
    }

    index += 1;
    console.log(`\n========== #${index} | sisa email ${await sisaAntrianRedis()} | PAT ${patCount} ==========`);
    console.log(`📧 ${akun.email}`);

    try {
      // Satu panggilan = satu browser GitHub (proxy) + satu browser AtomicMail (lokal)
      // Browser ditutup di finally → fingerprint baru di percobaan berikutnya
      await buatSatuAkunGitHub(akun.email, akun.password);
    } catch (e) {
      if (e instanceof BadIpError || e.code === 'BAD_IP') {
        console.error(`[BAD_IP] ${akun.email} → ${e.message}`);
        console.log('[BAD_IP] Kembalikan email ke antrian, coba lagi dengan IP + fingerprint baru...');
        await kembalikanEmailKeAntrian(akun.email, akun.password);
        // jeda singkat lalu loop → LPOP email yang sama (atau antrean lain) + browser baru
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      // BAD_EMAIL atau lainnya: email sudah ter-LPOP, lanjut email berikutnya
      console.error(`[BAD_EMAIL/SKIP] ${akun.email} → ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 8000));
  }
}

main().catch(console.error);
