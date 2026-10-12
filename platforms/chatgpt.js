const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// =====================================================================
// ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ¢â‚¬Ëœ FUNGSI SEDOT NATIVE (Menggunakan Context Playwright)
// =====================================================================
async function sedotNative(urlTarget, destPath, context) {
    const cookiesArray = await context.cookies();
    const cookieStr = cookiesArray.map(c => `${c.name}=${c.value}`).join('; ');
    
    return new Promise((resolve, reject) => {
        const lib = urlTarget.startsWith('https') ? https : http;
        const req = lib.get(urlTarget, { 
            headers: { 
                'Cookie': cookieStr, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 
                'Referer': 'https://chatgpt.com/'
            } 
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                sedotNative(res.headers.location, destPath, context).then(resolve).catch(reject);
            } else if (res.statusCode === 200 || res.statusCode === 206) {
                const file = fs.createWriteStream(destPath);
                res.pipe(file); file.on('finish', () => { file.close(); resolve(true); });
            } else { reject(new Error(`HTTP Status ${res.statusCode}`)); }
        });
        req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
}

// =====================================================================
// ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¸ STEP SHOT (dari Script 2)
// =====================================================================
async function stepShot(page, folderHasil, label) {
    try {
        if (!folderHasil) return;
        const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
        const fp = path.join(folderHasil, `step_${Date.now()}_${safe}.png`);
        await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
        console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¸ ${label} ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ ${path.basename(fp)}`);
    } catch (_) {}
}

// =====================================================================
// ÃƒÂ°Ã…Â¸Ã¢â‚¬ËœÃ‚Â¤ TUNGGU PROFIL SIAP (dari Script 2)
// =====================================================================
async function deteksiLoginAtauSignup(page) {
    return page.evaluate(() => {
        const texts = [];
        document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
            const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 40) texts.push(t);
        });
        const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
        const joined = texts.join(' | ').toLowerCase();
        const bodyL = body.toLowerCase();

        const patterns = [
            /^log\s*in$/i,
            /^sign\s*up$/i,
            /^sign\s*up\s*\/?\s*log\s*in$/i,
            /^create\s*account$/i,
            /^masuk$/i,
            /^daftar$/i,
            /^log\s*in\s*\/\s*sign\s*up$/i,
        ];
        for (const t of texts) {
            for (const re of patterns) {
                if (re.test(t.trim())) return { hit: true, via: 'btn:' + t };
            }
        }
        // Auth wall umum di chatgpt.com
        if (/log in or sign up/i.test(body) || /welcome to chatgpt/i.test(body) && /log in/i.test(body)) {
            return { hit: true, via: 'body-auth-wall' };
        }
        // data-testid auth
        if (document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')) {
            return { hit: true, via: 'testid-auth' };
        }
        return { hit: false, via: '' };
    });
}

/**
 * Validasi sesi cookie: BUKAN lewat profil.
 * - Ada Login/Sign up ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ cookie invalid ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ throw COOKIE_INVALID
 * - Composer siap / tidak ada auth wall ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ lanjut
 */
async function tungguSesiValid(page, timeoutMs = 45000) {
    console.log('[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬ÂÃ‚Â Cek sesi (login/signup = cookie invalid)...');
    const t0 = Date.now();
    let lastLog = 0;

    while (Date.now() - t0 < timeoutMs) {
        const auth = await deteksiLoginAtauSignup(page);
        if (auth.hit) {
            console.log(`[CHATGPT] ÃƒÂ¢Ã‚ÂÃ…â€™ Auth wall: ${auth.via}`);
            throw new Error('COOKIE_INVALID: terdeteksi tombol/halaman Login atau Sign up (' + auth.via + ')');
        }

        // Composer muncul = sesi cukup untuk lanjut (tanpa wajib profil)
        const composer = await page.evaluate(() => {
            const a = document.querySelector('#prompt-textarea');
            if (a) {
                const st = window.getComputedStyle(a);
                if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
            }
            return !!(
                document.querySelector('[data-testid="prompt-textarea"]') ||
                document.querySelector('div.ProseMirror[contenteditable="true"]')
            );
        }).catch(() => false);

        if (composer) {
            console.log(`[CHATGPT] ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Sesi OK (composer ada, tanpa login wall) ${Date.now() - t0}ms`);
            return;
        }

        if (Date.now() - lastLog > 2500) {
            lastLog = Date.now();
            console.log(`[CHATGPT] sesiÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ ${Date.now() - t0}ms (tunggu composer / cek auth)`);
        }
        await page.waitForTimeout(400);
    }

    // Timeout: cek auth sekali lagi
    const auth2 = await deteksiLoginAtauSignup(page);
    if (auth2.hit) {
        throw new Error('COOKIE_INVALID: terdeteksi Login/Sign up (' + auth2.via + ')');
    }
    // Tidak ada auth wall ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â biarkan tungguComposerSiap yang memutuskan
    console.log('[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Timeout cek sesi tanpa auth wall ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â lanjut ke composer');
}

/** Klik nyata di area kosong (pinggir kanan tengah / bawah tengah) untuk menutup NUX/overlay */
async function klikAreaKosong(page) {
    try {
        const vp = page.viewportSize() || { width: 1920, height: 1080 };
        // Tengah-kanan (bukan di atas dialog tengah)
        const x1 = Math.floor(vp.width * 0.92);
        const y1 = Math.floor(vp.height * 0.50);
        // Bawah-tengah
        const x2 = Math.floor(vp.width * 0.50);
        const y2 = Math.floor(vp.height * 0.92);

        await page.mouse.click(x1, y1, { delay: 40 });
        await page.waitForTimeout(120);
        await page.mouse.click(x2, y2, { delay: 40 });
        await page.waitForTimeout(150);
    } catch (_) {}
}

// =====================================================================
// ÃƒÂ¢Ã‚ÂÃ‚Â³ TUNGGU COMPOSER SIAP (dari Script 2)
// =====================================================================
/** Cari elemen composer di semua varian UI ChatGPT */
function composerFinderScript() {
    return (() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        const candidates = [];
        const push = (el, how) => { if (el && visible(el)) candidates.push({ el, how }); };

        push(document.querySelector('#prompt-textarea'), 'id');
        push(document.querySelector('[data-testid="prompt-textarea"]'), 'testid');
        document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"].ProseMirror').forEach((el) => push(el, 'prose'));
        // UI penuh: placeholder "Ask ChatGPT" / "Tanyakan apa saja" ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â contenteditable di form utama
        document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
            const ph = (el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || '').toLowerCase();
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            if (/ask chatgpt|tanyakan|message|pesan|prompt/i.test(ph + ' ' + al)) push(el, 'ph');
            else if (visible(el) && el.closest('form')) push(el, 'form-ce');
        });
        // textarea biasa
        document.querySelectorAll('textarea').forEach((el) => {
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            if (/ask|tanya|message|chatgpt/i.test(ph) || el.id === 'prompt-textarea') push(el, 'textarea');
        });

        if (!candidates.length) return null;
        // prioritaskan yang di tengah bawah viewport (composer utama)
        candidates.sort((a, b) => {
            const rb = b.el.getBoundingClientRect();
            const ra = a.el.getBoundingClientRect();
            return (rb.y + rb.height) - (ra.y + ra.height);
        });
        return candidates[0].how;
    })();
}

async function tungguComposerSiap(page, timeoutMs = 60000) {
    console.log('[CHATGPT] ÃƒÂ¢Ã‚ÂÃ‚Â³ Menunggu kolom teks (composer) siap...');
    await page.waitForFunction(() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        if (visible(document.querySelector('#prompt-textarea'))) return true;
        if (visible(document.querySelector('[data-testid="prompt-textarea"]'))) return true;
        if (document.querySelector('div.ProseMirror[contenteditable="true"]')) return true;
        for (const el of document.querySelectorAll('[contenteditable="true"]')) {
            if (!visible(el)) continue;
            const ph = (el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            if (/ask|tanya|message|chatgpt|prompt/i.test(ph) || el.closest('form')) return true;
        }
        for (const el of document.querySelectorAll('textarea')) {
            if (visible(el)) return true;
        }
        // UI "Ask ChatGPT" pill: ada tombol mic/send di bar yang sama
        if (document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Kirim" i]')) {
            if (document.querySelector('[contenteditable="true"], textarea')) return true;
        }
        return false;
    }, { timeout: timeoutMs });
    console.log('[CHATGPT] ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Composer siap');
}

async function suntikPromptKeComposer(page, promptTeks) {
    // Klik nyata ke area composer dulu (aktifkan focus di UI penuh)
    const clicked = await page.evaluate(() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        const list = [];
        const add = (el) => { if (visible(el)) list.push(el); };
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
        const add = (el) => { if (visible(el)) list.push(el); };
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
        // Fallback keyboard type
        await page.keyboard.type(promptTeks, { delay: 8 });
    }
    return true;
}

/**
 * Sinyal tombol composer ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â hanya elemen TERLIHAT (abaikan salinan hidden).
 * Dari HTML nyata (ID + EN):
 *   send_ready : #composer-submit-button[data-testid=send-button]  aria "Kirim perintah" | "Send" | "Send prompt"
 *   processing : #composer-submit-button[data-testid=stop-button]  aria "Hentikan jawaban" | "Stop"
 *   uploading  : tombol submit ber-spinner (lampiran belum selesai) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â nanti berganti jadi Stop
 *   idle       : aria "Mulai Suara" | "Start Voice"  (bukan #composer-submit-button)
 * Selesai tugas = idle (suara) DAN tombol salin baru:
 *   [data-testid=copy-turn-action-button] aria "Salin respons" | "Copy"
 */
async function bacaStatusTombolComposer(page) {
    return page.evaluate(() => {
        const terlihat = (el) => {
            if (!el || !el.isConnected) return false;
            if (el.closest('[hidden]')) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) return false;
            let p = el;
            while (p && p !== document.documentElement) {
                if (p.hasAttribute && p.hasAttribute('hidden')) return false;
                const cs = window.getComputedStyle(p);
                if (cs.display === 'none' || cs.visibility === 'hidden') return false;
                p = p.parentElement;
            }
            return true;
        };
        const meta = (b) => ({
            id: b.id || '',
            testid: b.getAttribute('data-testid') || '',
            aria: (b.getAttribute('aria-label') || '').trim(),
            spin: !!(
                b.querySelector('.animate-spin, [class*="animate-spin"]') ||
                b.getAttribute('aria-busy') === 'true'
            )
        });
        const list = Array.from(document.querySelectorAll('button')).filter(terlihat).map(meta);
        const isStop = (x) =>
            x.testid === 'stop-button' ||
            /^hentikan jawaban$/i.test(x.aria) ||
            /^stop$/i.test(x.aria);
        const isSend = (x) =>
            !isStop(x) && (
                x.testid === 'send-button' ||
                /^kirim perintah$/i.test(x.aria) ||
                /^kirim$/i.test(x.aria) ||
                /^send prompt$/i.test(x.aria) ||
                /^send$/i.test(x.aria) ||
                /^send message$/i.test(x.aria)
            );
        const isVoice = (x) =>
            /^mulai suara$/i.test(x.aria) ||
            /^start voice$/i.test(x.aria);
        const isCopy = (x) =>
            x.testid === 'copy-turn-action-button' ||
            /^salin respons$/i.test(x.aria) ||
            /^copy$/i.test(x.aria) ||
            /^copy response$/i.test(x.aria) ||
            /^copy message$/i.test(x.aria);
        const stop = list.find(isStop);
        const send = list.find(isSend);
        const voice = list.find(isVoice);
        const upload = !stop && list.find((x) =>
            x.spin && (x.id === 'composer-submit-button' || x.testid === 'composer-submit-button') && !isSend(x) && !isVoice(x)
        );
        const copyCount = list.filter(isCopy).length;
        let status = 'unknown';
        if (stop) status = 'processing';
        else if (upload) status = 'uploading';
        else if (send) status = 'send_ready';
        else if (voice) status = 'idle';
        const top = stop || upload || send || voice || {};
        return {
            status,
            aria: top.aria || '',
            testid: top.testid || '',
            copyCount,
            voice: !!voice,
            stop: !!stop
        };
    }).catch(() => ({ status: 'unknown', aria: '', testid: '', copyCount: 0, voice: false, stop: false }));
}

async function klikSendAtauEnter(page) {
    const sels = [
        'button[type="submit"][aria-label="Kirim"]',
        'button[aria-label="Kirim"]',
        'button[aria-label="Kirim perintah"]',
        'button[data-testid="send-button"]',
        '#composer-submit-button[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send message"]'
    ];
    for (const sel of sels) {
        try {
            const loc = page.locator(sel).last();
            if (!(await loc.count().catch(() => 0))) continue;
            await loc.click({ timeout: 3000, force: true });
            await page.waitForTimeout(450);
            return 'click:' + sel;
        } catch (_) {}
    }

    const evalClick = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const btn = buttons.find((b) => {
            const testid = b.getAttribute('data-testid') || '';
            const aria = (b.getAttribute('aria-label') || '').trim();
            if (testid === 'stop-button') return false;
            return testid === 'send-button' ||
                aria === 'Kirim' ||
                aria === 'Kirim perintah' ||
                aria === 'Send prompt' ||
                aria === 'Send message' ||
                aria === 'Send';
        });
        if (!btn) return false;
        btn.click();
        return true;
    }).catch(() => false);
    if (evalClick) {
        await page.waitForTimeout(450);
        return 'eval-click';
    }

    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    return 'enter';
}

async function kirimTerkonfirmasi(page, promptTeks) {
    const cup = (promptTeks || '').trim().slice(0, 48);
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
        const st = await bacaStatusTombolComposer(page);
        if (st.status === 'processing' || st.status === 'uploading' || st.stop) return true;
        const masihDiKolom = await page.evaluate((cuplikan) => {
            if (!cuplikan) return false;
            const nodes = Array.from(document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]'));
            return nodes.some((el) => ((el.innerText || el.value || '').trim()).includes(cuplikan));
        }, cup).catch(() => false);
        if (!masihDiKolom && st.status !== 'send_ready') return true;
        await page.waitForTimeout(400);
    }
    return false;
}

// =====================================================================
// ÃƒÂ°Ã…Â¸Ã‚Â§Ã‚Â¹ NUX memory (Got it / Mengerti) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â minimal, tidak mengganggu composer


// =====================================================================
// ÃƒÂ°Ã…Â¸Ã…Â¡Ã¢â€šÂ¬ EKSEKUTOR UTAMA CHATGPT (HIBRIDA MURNI)
// =====================================================================
/**
 * @param {object} [options]
 * @param {import('playwright').Page} [options.page] - page pool yang sudah READY (skip goto/sesi/composer boot)
 * @param {boolean} [options.holdPage] - jangan tutup page di finally (default true jika options.page)
 */
async function eksekusiChatGPT(tipeTugas, promptTeks, isThinkingMode, fileInputData, folderHasil, context, options = {}) {
    let fileTersimpanArray = [];
    let arrayFile = Array.isArray(fileInputData) ? fileInputData : (fileInputData ? [fileInputData] : []);
    const validFiles = arrayFile.filter(f => fs.existsSync(f));

    const existingPage = options && options.page ? options.page : null;
    const holdPage = existingPage ? (options.holdPage !== false) : false;
    let page = existingPage;

    if (!page) {
        page = await context.newPage();
        await page.setViewportSize({ width: 1920, height: 1080 });

        // ÃƒÂ°Ã…Â¸Ã…â€™Ã…Â¸ SISTEM PEMBUNUH POP-UP OTONOM (selalu nyala, termasuk memory NUX)
        await page.addInitScript(() => {
            const dismissPopups = () => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    if (
                        txt === 'got it' ||
                        txt === 'ÃƒÂ§Ã…Â¸Ã‚Â¥ÃƒÂ©Ã‚ÂÃ¢â‚¬Å“ÃƒÂ¤Ã‚ÂºÃ¢â‚¬ ' ||
                        txt === 'okay' ||
                        txt === 'ok' ||
                        txt === 'stay logged out' ||
                        txt === 'continue'
                    ) {
                        try { btn.click(); } catch (e) {}
                    }
                    if (
                        btn.querySelector('svg') &&
                        (btn.getAttribute('aria-label') === 'Close' || btn.getAttribute('aria-label') === 'Tutup')
                    ) {
                        try { btn.click(); } catch (e) {}
                    }
                }

                document.querySelectorAll('[role="dialog"]').forEach((d) => {
                    const t = d.innerText || '';
                    if (
                        t.includes('More relevant') ||
                        t.includes('personalized replies') ||
                        t.includes('ÃƒÂ¤Ã‚Â¸Ã‚ÂªÃƒÂ¦Ã¢â€šÂ¬Ã‚Â§ÃƒÂ¥Ã…â€™Ã¢â‚¬â€œ') ||
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

            const observer = new MutationObserver(() => dismissPopups());
            observer.observe(document.documentElement, { childList: true, subtree: true });
            setInterval(dismissPopups, 800);
            dismissPopups();
        });
    }

    try {
        if (!existingPage) {
            // ---------------------------------------------------------
            // 1) Navigasi (cold start only)
            // ---------------------------------------------------------
            console.log(`\n[CHATGPT] ÃƒÂ°Ã…Â¸Ã…â€™Ã‚Â Membuka ChatGPT...`);
            await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(()=>{});
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await stepShot(page, folderHasil, '01_after_goto');

            await klikAreaKosong(page);

            // ---------------------------------------------------------
            // 2) Validasi cookie: Login/Sign up = invalid
            // ---------------------------------------------------------
            await tungguSesiValid(page, 45000);
            await stepShot(page, folderHasil, '02_after_session');
            await klikAreaKosong(page);

            // ---------------------------------------------------------
            // 3) Composer siap ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ baru ketik prompt
            // ---------------------------------------------------------
            await tungguComposerSiap(page, 60000);
            await stepShot(page, folderHasil, '03_composer_ready');
            await klikAreaKosong(page);
            await page.waitForTimeout(400);
        } else {
            // Pool: page sudah HOLD. Jangan goto / jangan New chat.
            console.log(`\n[CHATGPT] ÃƒÂ¢Ã…Â¡Ã‚Â¡ Lanjut di page pool (tanpa goto)...`);
            await tungguComposerSiap(page, 15000).catch(() => {});
            await page.waitForTimeout(300);
        }

        let copyAwal = 0;
        let terkirim = false;
        for (let upayaKirim = 1; upayaKirim <= 2 && !terkirim; upayaKirim++) {
        if (upayaKirim > 1) {
            console.log('[CHATGPT] Prompt masih di kolom. Refresh halaman lalu ulang proses...');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await klikAreaKosong(page);
            await tungguComposerSiap(page, 30000);
        }

        if (isThinkingMode) {
            console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã‚Â§  Mengaktifkan Thinking Mode...`);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForTimeout(800);
        }

        // =================================================================
        // ÃƒÂ°Ã…Â¸Ã…â€™Ã…Â¸ LOGIKA PELAMPIRAN DUAL-CORE (BERDASARKAN CHATGPT_1 DAN CHATGPT_2)
        // =================================================================
        if (validFiles.length > 0) {
            console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…Â½ Memproses ${validFiles.length} File...`);
            
            // Pemisahan Jenis File
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'];
            const imageFiles = validFiles.filter(f => imageExtensions.includes(path.extname(f).toLowerCase()));
            const docFiles = validFiles.filter(f => !imageExtensions.includes(path.extname(f).toLowerCase()));

            // -----------------------------------------------------------------
            // JURUS 1: UPLOAD DOKUMEN (Menggunakan logika murni chatgpt_2.js)
            // -----------------------------------------------------------------
            if (docFiles.length > 0) {
                console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã¢â‚¬Å¾ Mengunggah Dokumen (Mode chatgpt_2.js)...`);
                try {
                    try {
                        await page.locator('#composer-plus-btn, [data-testid="composer-plus-btn"]').click({ timeout: 3000 });
                        await page.waitForTimeout(500); 
                    } catch(e) {}

                    await page.evaluate(() => {
                        document.querySelectorAll('input[type="file"]').forEach(input => {
                            input.removeAttribute('accept'); 
                            input.removeAttribute('capture');
                        });
                    });

                    let nativeDocUploaded = false;
                    const fileInputs = await page.locator('input[type="file"]').all();
                    
                    for (let i = 0; i < fileInputs.length; i++) {
                        try { 
                            await fileInputs[i].setInputFiles(docFiles, { force: true }); 
                            nativeDocUploaded = true;
                        } catch (e) {}
                    }

                    if (!nativeDocUploaded) {
                        console.log(`[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Menggunakan Injeksi Clipboard untuk Dokumen...`);
                        await page.evaluate(() => {
                            const oldInput = document.getElementById('hacker-doc-input');
                            if (oldInput) oldInput.remove();
                            const input = document.createElement('input');
                            input.type = 'file'; input.multiple = true; input.id = 'hacker-doc-input'; input.style.display = 'none'; document.body.appendChild(input);
                        });
                        
                        const hackerInput = page.locator('#hacker-doc-input');
                        await hackerInput.setInputFiles(docFiles, { force: true });
                        
                        await page.evaluate(() => {
                            const input = document.getElementById('hacker-doc-input');
                            if (input && input.files.length > 0) {
                                const target = document.querySelector('#prompt-textarea');
                                if (target) {
                                    target.focus();
                                    const dt = new DataTransfer(); 
                                    for(let i = 0; i < input.files.length; i++) dt.items.add(input.files[i]);
                                    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                                }
                            }
                        });
                    }
                } catch (e) { console.log(`[CHATGPT] ÃƒÂ¢Ã‚ÂÃ…â€™ Error Dokumen: ${e.message}`); }
            }

            // -----------------------------------------------------------------
            // JURUS 2: UPLOAD GAMBAR (Menggunakan logika murni chatgpt_1.js)
            // -----------------------------------------------------------------
            if (imageFiles.length > 0) {
                console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬â€œÃ‚Â¼ÃƒÂ¯Ã‚Â¸Ã‚Â Mengunggah Gambar (Mode chatgpt_1.js)...`);
                try {
                    let nativeImgUploaded = false;
                    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(()=>{});
                    const fileInputs = await page.locator('input[type="file"]').all();
                    
                    for (const input of fileInputs) {
                        try { 
                            await input.setInputFiles(imageFiles); 
                            nativeImgUploaded = true; 
                            break; // PENTING: Sesuai chatgpt_1.js
                        } catch (e) {}
                    }

                    if (!nativeImgUploaded) {
                        console.log(`[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Menggunakan Injeksi Clipboard untuk Gambar...`);
                        await page.evaluate(() => {
                            const oldInput = document.getElementById('hacker-image-input');
                            if (oldInput) oldInput.remove();
                            const input = document.createElement('input');
                            input.type = 'file'; input.multiple = true; input.id = 'hacker-image-input'; input.style.display = 'none'; document.body.appendChild(input);
                        });
                        
                        const hackerInput = page.locator('#hacker-image-input');
                        await hackerInput.setInputFiles(imageFiles);
                        
                        await page.evaluate(() => {
                            const input = document.getElementById('hacker-image-input');
                            if (input && input.files.length > 0) {
                                const target = document.querySelector('#prompt-textarea');
                                if (target) {
                                    target.focus();
                                    const dt = new DataTransfer(); 
                                    for(let i = 0; i < input.files.length; i++) dt.items.add(input.files[i]);
                                    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                                }
                            }
                        });
                    }
                } catch (e) { console.log(`[CHATGPT] ÃƒÂ¢Ã‚ÂÃ…â€™ Error Gambar: ${e.message}`); }
            }

            // Pantau lampiran (dari Script 2)
            console.log(`[CHATGPT] ÃƒÂ¢Ã‚ÂÃ‚Â³ Menunggu visualisasi file di layar...`);
            try {
                await page.waitForFunction((expected) => {
                    const body = (document.body.innerText || '').toLowerCase();
                    if (body.includes('uploading')) return false;

                    const removeBtns = document.querySelectorAll(
                        'button[aria-label*="Remove" i], button[aria-label*="Hapus" i], button[aria-label*="remove file" i]'
                    );
                    if (removeBtns.length >= expected) return true;

                    const thumbs = document.querySelectorAll(
                        'img[src*="blob:"], img[alt*="attachment" i], div[data-testid*="file-thumbnail" i], div[class*="file-thumbnail"]'
                    );
                    if (thumbs.length >= expected) return true;

                    const composer =
                        document.querySelector('#prompt-textarea')?.closest('form') ||
                        document.querySelector('[data-testid="send-button"]')?.closest('form');
                    if (composer) {
                        const chips = composer.querySelectorAll('[data-testid*="file"], [class*="attachment"], [class*="thumbnail"]');
                        if (chips.length >= expected) return true;
                    }
                    return false;
                }, validFiles.length, { timeout: 45000 });
                console.log('[CHATGPT] ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Lampiran terdeteksi');
                await stepShot(page, folderHasil, '04_attachment_ok');
            } catch (e) {
                console.log('[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Timeout pantau lampiran:', e.message);
                await stepShot(page, folderHasil, '04_attachment_timeout');
            }

        }


        // JANGAN klikAreaKosong di antara suntik dan send ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â itu menghilangkan fokus composer
        console.log(`[CHATGPT] ÃƒÂ¢Ã…Â¡Ã‚Â¡ Menyuntikkan Prompt...`);
        await suntikPromptKeComposer(page, promptTeks);
        await page.waitForTimeout(400);

        if (tipeTugas === 'GAMBAR') {
            console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ Mengaktifkan Mode Generasi Gambar...`);
            try {
                const plusSels = [
                    '[data-testid="composer-plus-btn"]',
                    '#composer-plus-btn',
                    'button[data-composer-navigation-target="add-context"]',
                    'button[aria-label="Add files and more"]',
                    'button[aria-label="Tambahkan file dan lainnya"]'
                ];
                let plusTerbuka = false;
                for (const sel of plusSels) {
                    const loc = page.locator(sel).first();
                    if (!(await loc.count().catch(() => 0))) continue;
                    if (!(await loc.isVisible().catch(() => false))) continue;
                    await loc.click({ timeout: 4000, force: true });
                    plusTerbuka = true;
                    console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã…Â½Ã‚Â¨ Plus dibuka via ${sel}`);
                    break;
                }
                if (!plusTerbuka) throw new Error('tombol plus/add-context tidak ketemu');
                const menu = page.locator('button[data-list-navigation-item="true"], [role="menuitem"]').filter({ hasText: /buat gambar|create image/i }).first();
                await menu.waitFor({ state: 'attached', timeout: 8000 });
                await menu.click({ force: true, timeout: 4000 });
                console.log('[CHATGPT] Mode gambar diklik: Buat gambar');
                let pill = false;
                const pillMulai = Date.now();
                while (Date.now() - pillMulai < 4000) {
                    pill = await page.evaluate(() => !!document.querySelector('[data-system-hint-type="picture_v2"], span[data-inline-selection-pill][data-system-hint-label="Buat gambar"], span[data-inline-selection-pill][data-system-hint-label="Create image"]'));
                    if (pill) break;
                    await page.waitForTimeout(200);
                }
                if (!pill) throw new Error('pill picture_v2 tidak muncul di kolom prompt');
                console.log('[CHATGPT] Pill picture_v2 terpasang');
            } catch (err) {
                console.log(`[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Peringatan aktivasi mode gambar: ${err.message}`);
            }
        }


        const sinyalSebelumKirim = await bacaStatusTombolComposer(page);
        copyAwal = sinyalSebelumKirim.copyCount || 0;
        console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã…Â¡Ã¢â€šÂ¬ Mengirim tugas... btn=${sinyalSebelumKirim.status} aria="${sinyalSebelumKirim.aria}" copyAwal=${copyAwal}`);
        const how = await klikSendAtauEnter(page);
        console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¤ Send method: ${how}`);
        terkirim = await kirimTerkonfirmasi(page, promptTeks);
        if (!terkirim) {
            console.log('[CHATGPT] Kirim belum terjadi (masih tombol Kirim / prompt masih di kolom). Tidak masuk radar.');
            continue;
        }
        console.log('[CHATGPT] Kirim terkonfirmasi');
        await stepShot(page, folderHasil, '08_after_send');
        }
        if (!terkirim) throw new Error('SEND_GAGAL: tombol Kirim tidak mengirim tugas');

        // Radar: selesai saat tombol suara kembali (Mulai Suara / Start Voice).
        // Jangan tunggu tombol Salin ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â di page pool aria/testid salin sering tidak cocok
        // padahal jawaban sudah terlihat. Selama Hentikan jawaban / stop ÃƒÂ¢Ã¢â‚¬ Ã¢â‚¬â„¢ masih proses.
        const baseline = await page.evaluate(() => {
            const genImages = Array.from(document.querySelectorAll(
                '[data-testid="generated-image-gallery"] img, [class*="generated-image-preview"] img, img[src*="backend-api/estuary"]'
            )).filter((img) => {
                if (img.closest('.group\\/message-image')) return false;
                const src = img.currentSrc || img.src || '';
                if (!src || /auth0|oaistatic|use-case-icons|avatar/i.test(src)) return false;
                const r = img.getBoundingClientRect();
                return r.width > 40 && r.height > 40;
            });

            // Scope ketat: jangan naik ke parent sampai sidebar/seluruh page
            const scopeOf = (el) => {
                if (!el) return null;
                return (
                    el.closest('[data-turn-key]') ||
                    el.closest('[data-testid^="conversation-turn"]') ||
                    el.closest('article') ||
                    el.closest('.group.flex.min-w-0.flex-col') ||
                    el.closest('.group') ||
                    el.parentElement
                );
            };
            const cleanText = (root) => {
                if (!root) return '';
                return (root.innerText || '')
                    .replace(/^ChatGPT said:\s*/i, '')
                    .replace(/^You said:\s*/i, '')
                    .trim();
            };

            let assistantRoles = 0;
            let baselineText = '';
            document.querySelectorAll('[data-conversation-role="assistant"]').forEach((h) => {
                const root = scopeOf(h);
                const t = cleanText(root);
                // Header kosong / cuma "ChatGPT said:" tidak dihitung
                if (t.length > 15) {
                    assistantRoles++;
                    baselineText = t;
                }
            });
            let legacyAssist = 0;
            document.querySelectorAll('[data-message-author-role="assistant"]').forEach((el) => {
                const t = cleanText(el);
                if (t.length > 15) {
                    legacyAssist++;
                    baselineText = t;
                }
            });
            const turnKeys = document.querySelectorAll('[data-turn-key]').length;
            return {
                jumlahBubbleAwal: Math.max(assistantRoles, legacyAssist),
                jumlahGambarAwal: genImages.length,
                assistantRoles,
                legacyAssist,
                baselineTextLen: baselineText.length,
                baselineText: baselineText.slice(0, 240),
                turnKeys
            };
        });
        const jumlahBubbleAwal = baseline.jumlahBubbleAwal;
        const jumlahGambarAwal = baseline.jumlahGambarAwal;
        const baselineTextLen = baseline.baselineTextLen || 0;
        const baselineTextSnap = baseline.baselineText || '';
        console.log(`[CHATGPT] ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã…  Baseline radar roles=${baseline.assistantRoles} legacy=${baseline.legacyAssist} textLen=${baselineTextLen} turns=${baseline.turnKeys || 0} gambar=${jumlahGambarAwal}`);

        console.log('\n[CHATGPT] ÃƒÂ¢Ã‚ÂÃ‚Â³ Mulai radar (selesai = Mulai Suara / Start Voice, lalu ambil teks terlihat)...');
        let hasilEktraksi = null;
        let waktuMulai = Date.now();
        let lastTextLen = 0;
        let stableTicks = 0;

        while (Date.now() - waktuMulai < 300000) {
            const btnSt = await bacaStatusTombolComposer(page);
            if (btnSt.status === 'processing' || btnSt.status === 'uploading') {
                if ((Date.now() - waktuMulai) % 6000 < 1400) {
                    console.log(`[CHATGPT] radar loading via=${btnSt.status} aria="${btnSt.aria}" testid="${btnSt.testid}"`);
                }
                await page.waitForTimeout(1000);
                continue;
            }

            // Selesai = composer kembali ke Mulai Suara / Start Voice.
            // Tombol salin tidak wajib (di pool copy sering tetap 0 meski jawaban sudah ada).
            const selesaiSinyal = btnSt.status === 'idle' && btnSt.voice;
            if (!selesaiSinyal) {
                if ((Date.now() - waktuMulai) % 8000 < 1400) {
                    console.log(`[CHATGPT] radar wait btn=${btnSt.status} aria="${btnSt.aria}" copy=${btnSt.copyCount || 0}/${copyAwal} voice=${btnSt.voice}`);
                }
                await page.waitForTimeout(1000);
                continue;
            }

            const state = await page.evaluate((args) => {
                const { bAwal, gAwal, mode, tAwal, tSnap, btnStatus, prompt } = args;
                const bodyText = (document.body.innerText || '').toLowerCase();
                if (bodyText.includes("you've reached our limit") || bodyText.includes('batas penggunaan')) {
                    return { status: 'error', msg: 'LIMIT_AKUN_TERCAPAI' };
                }

                // Hanya ekstrak saat tombol idle/send_ready/unknown (bukan Stop/uploading)
                // isGenerating sudah difilter di luar lewat btnStatus
                if (btnStatus === 'processing' || btnStatus === 'uploading') {
                    return { status: 'loading', via: 'composer:' + btnStatus };
                }

                // A/B image skip
                const isDoubleText = Array.from(document.querySelectorAll('p')).some(p => (p.innerText || '').includes('Which image do you like more?'));
                const skipSpans = Array.from(document.querySelectorAll('span')).filter(s => (s.innerText || '').trim().toLowerCase() === 'skip');
                if (isDoubleText && skipSpans.length > 0) {
                    const skipBtn = skipSpans[0].closest('button');
                    if (skipBtn) { skipBtn.click(); return { status: 'force_refresh', msg: 'A/B Test dilewati.' }; }
                }

                const getGenImages = () => Array.from(document.querySelectorAll(
                    '[data-testid="generated-image-gallery"] img, [class*="generated-image-preview"] img, [class*="imagegen-image"] img, img[src*="backend-api/estuary"], img[src*="oaiusercontent"]'
                )).filter((img) => {
                    if (img.closest('.group\\/message-image')) return false;
                    const src = img.currentSrc || img.src || '';
                    if (!src || /auth0|oaistatic|use-case-icons|avatar/i.test(src)) return false;
                    const r = img.getBoundingClientRect();
                    return r.width > 40 && r.height > 40;
                });

                const galleryMasihLoading = () => !!(
                    document.querySelector('[data-testid="image-gen-loading-game-board"]') ||
                    document.querySelector('[aria-label*="while your image is generating"]') ||
                    (document.querySelector('[data-testid="generated-image-gallery"]') && getGenImages().length === 0)
                );

                const extractAssistantText = () => {
                    const boxes = Array.from(document.querySelectorAll('[data-markdown-text-style="assistant-message"]'));
                    const texts = boxes.map((n) => (n.innerText || '').trim()).filter((t) => t.length > 0);
                    if (texts.length) return { text: texts[texts.length - 1], count: texts.length, via: 'markdown-assistant' };
                    const legacy = Array.from(document.querySelectorAll('[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"]'));
                    if (legacy.length) {
                        const last = legacy[legacy.length - 1];
                        const t = (last.innerText || '').replace(/^ChatGPT said:\s*/i, '').trim();
                        if (t) return { text: t, count: legacy.length, via: 'legacy-role' };
                    }
                    return { text: '', count: 0, via: 'none' };
                };

                const textAfterPrompt = () => {
                    const main = document.querySelector('main') || document.body;
                    const lines = (main.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
                    const p = (prompt || '').trim();
                    if (!p) return '';
                    let idx = -1;
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (lines[i] === p) { idx = i; break; }
                    }
                    if (idx < 0) return '';
                    const stopAt = [
                        'Tanya ChatGPT',
                        'Ask ChatGPT',
                        'Message ChatGPT',
                        'ChatGPT bisa membuat kesalahan',
                        'ChatGPT can make mistakes'
                    ];
                    const out = [];
                    for (let i = idx + 1; i < lines.length; i++) {
                        if (stopAt.some((m) => lines[i].includes(m))) break;
                        out.push(lines[i]);
                    }
                    return out.join('\n').trim();
                };

                if (mode === 'GAMBAR') {
                    if (galleryMasihLoading()) return { status: 'waiting', phase: 'gambar-loading' };
                    const allGenImages = getGenImages();
                    if (allGenImages.length > gAwal) {
                        let uniqueImageUrls = [...new Set(allGenImages.slice(gAwal).map((img) => img.currentSrc || img.src))];
                        if (uniqueImageUrls.length > 1 || isDoubleText) uniqueImageUrls = [uniqueImageUrls[uniqueImageUrls.length - 1]];
                        const caption = extractAssistantText();
                        return { status: 'done', images: uniqueImageUrls, text: caption.text || null, via: 'gallery', textLen: (caption.text || '').length };
                    }
                    const extracted = extractAssistantText();
                    if (extracted.text.length > 10 && extracted.text.slice(0, 240) !== (tSnap || '')) {
                        return { status: 'done', text: `ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Peringatan (Gambar gagal dibuat AI):\n${extracted.text}`, images: [], via: extracted.via, textLen: extracted.text.length };
                    }
                    return { status: 'waiting', phase: 'gambar' };
                }

                // CHAT: hanya markdown asisten. Jangan seret prompt / tombol Edit.
                let extracted = extractAssistantText();
                if (!extracted.text) {
                    const vis = textAfterPrompt();
                    const bersih = vis.split('\n').map((line) => line.trim()).filter((line) => {
                        if (!line) return false;
                        if (line === (prompt || '').trim()) return false;
                        if (/^(edit|chatgpt said:?|you said:?|salin respons|copy|bagikan|share)$/i.test(line)) return false;
                        return true;
                    }).join('\n').trim();
                    if (bersih.length > 0) extracted = { text: bersih, count: 1, via: 'visible-after-prompt' };
                }
                const tBase = typeof tAwal === 'number' ? tAwal : 0;
                const snap = typeof tSnap === 'string' ? tSnap : '';
                const textChanged =
                    extracted.text.length > 15 &&
                    extracted.text.slice(0, 240) !== snap &&
                    (snap === '' || extracted.text.length !== tBase || !extracted.text.startsWith(snap.slice(0, 40)));
                const hasNew =
                    extracted.count > bAwal ||
                    (bAwal === 0 && extracted.text.length > 15) ||
                    (extracted.text.length > tBase + 10) ||
                    textChanged;
                if ((hasNew && extracted.text.length > 0) || (extracted.via === 'visible-after-prompt' && extracted.text.length > 0)) {
                    return {
                        status: 'done',
                        text: extracted.text,
                        images: [...new Set(getGenImages().map(img => img.src))],
                        via: extracted.via,
                        textLen: extracted.text.length,
                        count: extracted.count
                    };
                }

                return {
                    status: 'waiting',
                    textLen: extracted.text.length,
                    count: extracted.count,
                    via: extracted.via
                };
            }, {
                bAwal: jumlahBubbleAwal,
                gAwal: jumlahGambarAwal,
                mode: tipeTugas,
                tAwal: baselineTextLen,
                tSnap: baselineTextSnap,
                btnStatus: btnSt.status,
                prompt: promptTeks
            });

            if (state.status === 'loading') {
                stableTicks = 0;
            } else if (state.status === 'done' || (state.images && state.images.length)) {
                // Sinyal selesai: Mulai Suara / Start Voice, teks jawaban sudah terbaca
                if (state.textLen && state.textLen !== lastTextLen) {
                    lastTextLen = state.textLen;
                    stableTicks = 0;
                } else {
                    stableTicks++;
                }
                if (stableTicks >= 1) {
                    console.log(`[CHATGPT] ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Radar done via=${state.via || '?'} len=${state.textLen || 0} btn=${btnSt.status} aria="${btnSt.aria}" copy=${btnSt.copyCount}`);
                    hasilEktraksi = state.status === 'done' ? state : { ...state, status: 'done', text: state.text || null };
                    break;
                }
            } else if (state.status === 'error') {
                throw new Error(state.msg);
            } else if (state.status === 'force_refresh') {
                console.log(`\n[CHATGPT] ÃƒÂ¢Ã…Â¡Ã‚Â¡ ${state.msg}`);
                break;
            } else {
                if ((Date.now() - waktuMulai) % 8000 < 1600) {
                    console.log(`[CHATGPT] radar wait btn=${btnSt.status} count=${state.count || 0} len=${state.textLen || 0} via=${state.via || '?'}`);
                }
            }

            await page.waitForTimeout(1200);
        }

        if (!hasilEktraksi && tipeTugas === 'GAMBAR') {
            hasilEktraksi = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll(
                    '[data-testid="generated-image-gallery"] img, [class*="generated-image-preview"] img, img[src*="backend-api/estuary"]'
                )).filter((img) => {
                    const src = img.currentSrc || img.src || '';
                    if (!src || /auth0|oaistatic|avatar/i.test(src)) return false;
                    const r = img.getBoundingClientRect();
                    return r.width > 40 && r.height > 40;
                });
                if (!imgs.length) return null;
                const boxes = Array.from(document.querySelectorAll('[data-markdown-text-style="assistant-message"]'));
                const caption = boxes.length ? (boxes[boxes.length - 1].innerText || '').trim() : null;
                return {
                    status: 'done',
                    text: caption,
                    images: [imgs[imgs.length - 1].currentSrc || imgs[imgs.length - 1].src],
                    via: 'gallery-final'
                };
            });
        }

        if (!hasilEktraksi) throw new Error("TIMEOUT: ChatGPT gagal memuat respon.");

        if (hasilEktraksi.images && hasilEktraksi.images.length > 0) {
            console.log(`\n[CHATGPT] ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¦ Mengunduh ${hasilEktraksi.images.length} gambar buatan AI...`);
            for (let i = 0; i < hasilEktraksi.images.length; i++) {
                const imgUrl = hasilEktraksi.images[i];
                const fileName = `chatgpt_IMG_${Date.now()}_${i + 1}.webp`;
                const dest = path.join(folderHasil, fileName);
                try {
                    if (/^blob:|^data:/i.test(imgUrl)) {
                        const dataUrl = await page.evaluate(async (u) => {
                            if (String(u).startsWith('data:')) return u;
                            const r = await fetch(u);
                            const blob = await r.blob();
                            return await new Promise((resolve, reject) => {
                                const fr = new FileReader();
                                fr.onload = () => resolve(typeof fr.result === 'string' ? fr.result : '');
                                fr.onerror = () => reject(new Error('FileReader'));
                                fr.readAsDataURL(blob);
                            });
                        }, imgUrl);
                        const m = String(dataUrl || '').match(/^data:[^;]+;base64,(.+)$/);
                        if (!m || !m[1]) throw new Error('blob bukan base64');
                        fs.writeFileSync(dest, Buffer.from(m[1], 'base64'));
                        console.log('[CHATGPT] Gambar via blob FileReader');
                    } else {
                        await sedotNative(imgUrl, dest, context);
                    }
                    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) fileTersimpanArray.push(fileName);
                } catch (e) {
                    console.log(`[CHATGPT] ÃƒÂ¢Ã…Â¡ ÃƒÂ¯Ã‚Â¸Ã‚Â Gagal unduh gambar: ${e.message}`);
                }
            }
        } 

        if (tipeTugas === 'GAMBAR') {
            if (!fileTersimpanArray.length) throw new Error('GAMBAR: hasil gambar tidak tersimpan');
            return { text: '', files: fileTersimpanArray };
        }
        return { text: hasilEktraksi.text, files: fileTersimpanArray };

    } catch (err) {
        console.log(`\n[CHATGPT ÃƒÂ¢Ã‚ÂÃ…â€™ CRITICAL ERROR]:`, err.message);
        try {
            const errFilePath = path.join(folderHasil, `error_trace_${Date.now()}.png`);
            await page.screenshot({ path: errFilePath, fullPage: true }).catch(()=>{});
            console.log(`ÃƒÂ°Ã…Â¸Ã¢â‚¬Å“Ã‚Â¸ FOTO BUKTI ERROR DISIMPAN DI: ${errFilePath}`);
        } catch (screenshotErr) {}
        throw err;
    } finally {
        if (!holdPage && page) {
            await page.close().catch(()=>{});
        }
    }
}

module.exports = { eksekusiChatGPT };
