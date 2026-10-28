const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { AsyncLocalStorage } = require('async_hooks');

/** Tag log per task. ALS supaya request paralel tidak saling timpa nomor. */
const _als = new AsyncLocalStorage();
function setChatgptLogCtx({ cookieId, poolSlot } = {}) {
    const ctx = {
        cookieId: cookieId ? String(cookieId) : '',
        poolSlot: poolSlot != null && poolSlot !== '' ? String(poolSlot) : '',
    };
    const store = _als.getStore();
    if (store) Object.assign(store, ctx);
    else _als.enterWith(ctx);
}
function chatgptTag() {
    const _logCtx = _als.getStore() || { cookieId: '', poolSlot: '' };
    const parts = [];
    if (_logCtx.cookieId) {
        const m = String(_logCtx.cookieId).match(/(\d+)\s*$/);
        parts.push(m ? ('CHATGPT_' + m[1]) : _logCtx.cookieId);
    }
    if (_logCtx.poolSlot) parts.push('P' + _logCtx.poolSlot);
    return parts.length ? '[' + parts.join('|') + '] ' : '';
}

(function patchChatgptConsole() {
    if (global.__chatgptLogPatched) return;
    global.__chatgptLogPatched = true;
    const _orig = console.log.bind(console);
    const _err = console.error.bind(console);
    function stamp(args) {
        if (!args.length || typeof args[0] !== 'string') return args;
        if (!args[0].includes('[CHATGPT]')) return args;
        const tag = chatgptTag().trim();
        if (!tag) return args;
        // Hindari double-tag
        if (args[0].includes(tag)) return args;
        const out = args.slice();
        out[0] = out[0].replace('[CHATGPT]', tag.trim());
        return out;
    }
    console.log = (...a) => _orig(...stamp(a));
    console.error = (...a) => {
        if (a.length && typeof a[0] === 'string' && a[0].includes('[CHATGPT]')) {
            return _err(...stamp(a));
        }
        return _err(...a);
    };
})();

function chatgptLog(...args) {
    if (args.length && typeof args[0] === 'string') {
        args[0] = args[0].replace(/\[CHATGPT\]/g, '[CHATGPT] ' + chatgptTag().trimEnd()).replace(/\[CHATGPT\] \[/g, '[CHATGPT] [');
        // Normalize: [CHATGPT] [cookie] message
        if (args[0].startsWith('[CHATGPT]') && chatgptTag()) {
            const tag = chatgptTag().trim();
            if (!args[0].includes(tag)) {
                args[0] = args[0].replace('[CHATGPT]', '[CHATGPT] ' + tag);
            }
        }
    }
    console.log(...args);
}

// =====================================================================
// ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“ FUNGSI SEDOT NATIVE (Menggunakan Context Playwright)
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
// ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒâ€šÃ‚Â¸ STEP SHOT (dari Script 2)
// =====================================================================
async function stepShot(page, folderHasil, label) {
    try {
        if (!folderHasil) return;
        const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
        const fp = path.join(folderHasil, `step_${Date.now()}_${safe}.png`);
        await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
        console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒâ€šÃ‚Â¸ ${label} ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ ${path.basename(fp)}`);
    } catch (_) {}
}

// =====================================================================
// ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“Ãƒâ€šÃ‚Â¤ TUNGGU PROFIL SIAP (dari Script 2)
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
 * - Ada Login/Sign up ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ cookie invalid ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ throw COOKIE_INVALID
 * - Composer siap / tidak ada auth wall ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ lanjut
 */
async function tungguSesiValid(page, timeoutMs = 45000) {
    console.log('[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã‚ÂÃƒâ€šÃ‚Â Cek sesi (login/signup = cookie invalid)...');
    const t0 = Date.now();
    let lastLog = 0;

    while (Date.now() - t0 < timeoutMs) {
        const auth = await deteksiLoginAtauSignup(page);
        if (auth.hit) {
            console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€¦Ã¢â‚¬â„¢ Auth wall: ${auth.via}`);
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
            console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Sesi OK (composer ada, tanpa login wall) ${Date.now() - t0}ms`);
            return;
        }

        if (Date.now() - lastLog > 2500) {
            lastLog = Date.now();
            console.log(`[CHATGPT] sesiÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ ${Date.now() - t0}ms (tunggu composer / cek auth)`);
        }
        await page.waitForTimeout(400);
    }

    // Timeout: cek auth sekali lagi
    const auth2 = await deteksiLoginAtauSignup(page);
    if (auth2.hit) {
        throw new Error('COOKIE_INVALID: terdeteksi Login/Sign up (' + auth2.via + ')');
    }
    // Tidak ada auth wall ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â biarkan tungguComposerSiap yang memutuskan
    console.log('[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡ ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Timeout cek sesi tanpa auth wall ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â lanjut ke composer');
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
// ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€šÃ‚Â³ TUNGGU COMPOSER SIAP (dari Script 2)
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
        // UI penuh: placeholder "Ask ChatGPT" / "Tanyakan apa saja" ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â contenteditable di form utama
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
    console.log('[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€šÃ‚Â³ Menunggu kolom teks (composer) siap...');
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
    console.log('[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Composer siap');
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
 * Sinyal tombol composer ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â hanya elemen TERLIHAT (abaikan salinan hidden).
 * Dari HTML nyata (ID + EN):
 *   send_ready : #composer-submit-button[data-testid=send-button]  aria "Kirim perintah" | "Send" | "Send prompt"
 *   processing : #composer-submit-button[data-testid=stop-button]  aria "Hentikan jawaban" | "Stop"
 *   uploading  : tombol submit ber-spinner (lampiran belum selesai) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â nanti berganti jadi Stop
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
        const composerKosong = () => {
            const nodes = Array.from(document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]'));
            const el = nodes.find((n) => {
                const r = n.getBoundingClientRect();
                return r.width > 20 && r.height > 8;
            });
            if (!el) return false;
            const t = (el.innerText || el.value || '').replace(/[\u200b\u00a0]/g, '').trim();
            return t.length === 0;
        };
        const meta = (b) => {
            const r = b.getBoundingClientRect();
            return {
                id: b.id || '',
                testid: b.getAttribute('data-testid') || '',
                aria: (b.getAttribute('aria-label') || '').trim(),
                spin: !!(
                    b.querySelector('.animate-spin, [class*="animate-spin"]') ||
                    b.getAttribute('aria-busy') === 'true'
                ),
                right: r.right,
                w: r.width,
                h: r.height,
                inForm: !!b.closest('form'),
                plus: b.id === 'composer-plus-btn' ||
                    b.getAttribute('data-testid') === 'composer-plus-btn' ||
                    b.getAttribute('data-composer-navigation-target') === 'add-context',
                submitId: b.id === 'composer-submit-button',
                typeSubmit: (b.getAttribute('type') || '').toLowerCase() === 'submit',
                busy: b.getAttribute('aria-busy') === 'true',
                disabled: !!b.disabled || b.getAttribute('aria-disabled') === 'true',
                // Ikon ini sama di semua bahasa. Yang berubah hanya aria-label.
                // Hash file svg (icons-XXXX.svg) dan class Icon-XXXX boleh berubah; nama ikon tidak.
                iconVoice: Array.from(b.querySelectorAll('use')).some((u) => {
                    const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
                    return h.includes('codex-icon-voice');
                })
            };
        };
        const list = Array.from(document.querySelectorAll('button')).filter(terlihat).map(meta);
        const kosong = composerKosong();
        const isStop = (x) =>
            x.testid === 'stop-button' ||
            /^hentikan jawaban$/i.test(x.aria) ||
            /^stop$/i.test(x.aria);
        const isSend = (x) =>
            !isStop(x) && (
                x.testid === 'send-button' ||
                (x.submitId && !kosong) ||
                /^kirim perintah$/i.test(x.aria) ||
                /^kirim$/i.test(x.aria) ||
                /^send prompt$/i.test(x.aria) ||
                /^send$/i.test(x.aria) ||
                /^send message$/i.test(x.aria)
            );
        const isVoiceAria = (x) =>
            /^(mulai suara|start voice)$/i.test(x.aria) ||
            /voice|suara|microphone|mikrofon|dictate|dictation/i.test(x.aria);
        const stop = list.find(isStop);
        const send = list.find(isSend);
        let voice = list.find((x) => !x.plus && !isStop(x) && !isSend(x) && x.iconVoice);
        let via = voice ? 'icon' : '';
        if (!voice) {
            voice = list.find((x) => !x.plus && !isStop(x) && !isSend(x) && isVoiceAria(x));
            if (voice) via = 'aria';
        }
        // Cadangan terakhir: kolom kosong, tombol bulat paling kanan, bukan plus dan bukan submit.
        if (!voice && !stop && !send && kosong) {
            const calon = list.filter((x) =>
                x.inForm && !x.plus && !x.submitId &&
                x.w >= 16 && x.w <= 64 && x.h >= 16 && x.h <= 64
            );
            calon.sort((a, b) => b.right - a.right);
            if (calon[0]) {
                voice = calon[0];
                via = 'struktur';
            }
        }
        // Lampiran belum selesai: tombol submit berputar, aria-busy, disabled.
        // Tidak punya id Kirim/Stop dan labelnya beda tiap bahasa
        // ("File upload pending" / "Pengunggahan file tertunda"). Jangan pakai teks.
        const isUpload = (x) =>
            !x.plus && !isStop(x) && x.inForm && x.spin && (x.busy || x.disabled) &&
            (x.typeSubmit || x.submitId || x.testid === 'send-button' || x.testid === 'composer-submit-button');
        const upload = !stop && list.find(isUpload);
        const isCopy = (x) =>
            x.testid === 'copy-turn-action-button' ||
            /^salin respons$/i.test(x.aria) ||
            /^copy$/i.test(x.aria) ||
            /^copy response$/i.test(x.aria) ||
            /^copy message$/i.test(x.aria);
        const copyCount = list.filter(isCopy).length;
        let status = 'unknown';
        if (stop) status = 'processing';
        else if (upload) status = 'uploading';
        else if (send) status = 'send_ready';
        else if (voice) status = 'idle';
        if (status === 'uploading') via = 'aria-busy';
        const top = stop || upload || send || voice || {};
        return {
            status,
            aria: top.aria || '',
            testid: top.testid || '',
            copyCount,
            voice: !!voice,
            stop: !!stop,
            via
        };
    }).catch(() => ({ status: 'unknown', aria: '', testid: '', copyCount: 0, voice: false, stop: false, via: '' }));
}

async function tungguStartVoice(page, timeoutMs = 45000) {
    console.log('[CHATGPT] ðŸ‘ Menunggu Start Voice / Mulai Suara sebelum upload/aksi...');
    const t0 = Date.now();
    let lastLog = 0;
    while (Date.now() - t0 < timeoutMs) {
        const st = await bacaStatusTombolComposer(page);
        if (st.status === 'idle' && st.voice) {
            console.log(`[CHATGPT] âœ… Composer idle (${Date.now() - t0}ms) via=${st.via || '?'} aria="${st.aria}"`);
            return st;
        }
        // send_ready juga berarti composer siap input (kadang voice diganti kirim kosong)
        // Paneer minta khusus Start Voice â€” jangan anggap send_ready cukup.
        if (Date.now() - lastLog > 2500) {
            lastLog = Date.now();
            console.log(`[CHATGPT] tunggu voiceâ€¦ ${Date.now() - t0}ms status=${st.status} voice=${st.voice} aria="${st.aria}"`);
        }
        await page.waitForTimeout(400);
    }
    throw new Error('TIMEOUT: Start Voice / Mulai Suara tidak muncul dalam ' + timeoutMs + 'ms');
}

/** Tutup dialog "which image" tanpa Escape â€” Escape bisa melepas pill Buat gambar. */
async function tutupDialogPengganggu(page) {
    await page.evaluate(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
        for (const d of dialogs) {
            const t = (d.innerText || '').toLowerCase();
            if (!/which image do you like|gambar mana yang|which response|which answer/.test(t)) continue;
            const btn = Array.from(d.querySelectorAll('button')).find((b) => {
                const label = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
                return /skip|lewati|not now|nanti|close|tutup|batal|cancel|later/.test(label);
            });
            if (btn) {
                try { btn.click(); } catch (e) {}
            }
        }
    }).catch(() => {});
}

/**
 * Klik koordinat nyata (mouse), bukan locator.click.
 * locator.click sering timeout padahal elemen sudah ketemu.
 */
async function klikDiTitik(page, cari) {
    const box = await page.evaluate(cari).catch(() => null);
    if (!box || !Number.isFinite(box.x) || !Number.isFinite(box.y)) return '';
    await page.mouse.click(box.x, box.y, { delay: 40 });
    return box.label || 'mouse';
}

async function klikSendAtauEnter(page) {
    const how = await klikDiTitik(page, () => {
        const terlihat = (el) => {
            if (!el || !el.isConnected) return false;
            if (el.getAttribute('aria-hidden') === 'true') return false;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return false;
            const cs = window.getComputedStyle(el);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
        };
        const buttons = Array.from(document.querySelectorAll('button')).filter(terlihat);
        const cocok = (b) => {
            const testid = b.getAttribute('data-testid') || '';
            const aria = (b.getAttribute('aria-label') || '').trim();
            if (testid === 'stop-button' || /^stop$/i.test(aria) || /^hentikan jawaban$/i.test(aria)) return false;
            return b.id === 'composer-submit-button' ||
                testid === 'send-button' ||
                /^kirim perintah$/i.test(aria) ||
                /^kirim$/i.test(aria) ||
                /^send prompt$/i.test(aria) ||
                /^send message$/i.test(aria) ||
                /^send$/i.test(aria);
        };
        const list = buttons.filter(cocok);
        list.sort((a, b) => {
            const skor = (el) => (el.id === 'composer-submit-button' ? 2 : 0) + (el.getAttribute('data-testid') === 'send-button' ? 1 : 0);
            return skor(b) - skor(a);
        });
        const btn = list[0];
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            label: 'mouse:' + (btn.getAttribute('aria-label') || btn.id || 'send')
        };
    });
    if (how) {
        await page.waitForTimeout(500);
        return how;
    }
    const pending = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('form button'));
        return buttons.some((b) => {
            if (b.id === 'composer-plus-btn') return false;
            const type = (b.getAttribute('type') || '').toLowerCase();
            const busy = b.getAttribute('aria-busy') === 'true' || b.disabled || b.getAttribute('aria-disabled') === 'true';
            const spin = !!b.querySelector('[class*="animate-spin"]') || b.getAttribute('aria-busy') === 'true';
            return type === 'submit' && busy && spin;
        });
    }).catch(() => false);
    if (pending) return 'upload-pending';
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    return 'enter';
}

async function kirimTerkonfirmasi(page, promptTeks) {
    const cup = (promptTeks || '').trim().slice(0, 48);
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
        const st = await bacaStatusTombolComposer(page);
        // Stop, ATAU spinner upload (prompt masih di kolom sampai lampiran selesai, lalu jadi Stop sendiri).
        if (st.status === 'processing' || st.status === 'uploading' || st.stop) {
            if (st.status === 'uploading') console.log(`[CHATGPT] Kirim diterima: upload tertunda via=${st.via} aria="${st.aria}"`);
            return true;
        }
        const masihDiKolom = await page.evaluate((cuplikan) => {
            if (!cuplikan) return false;
            const nodes = Array.from(document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]'));
            return nodes.some((el) => ((el.innerText || el.value || '').trim()).includes(cuplikan));
        }, cup).catch(() => false);
        // Prompt sudah keluar dari kolom = kirim terjadi, meski tombol belum sempat berganti jadi Stop.
        if (!masihDiKolom) return true;
        await page.waitForTimeout(400);
    }
    return false;
}

// =====================================================================
// ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€šÃ‚Â§Ãƒâ€šÃ‚Â¹ NUX memory (Got it / Mengerti) ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â minimal, tidak mengganggu composer


// =====================================================================
// ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€¦Ã‚Â¡ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ EKSEKUTOR UTAMA CHATGPT (HIBRIDA MURNI)
// =====================================================================
/**
 * @param {object} [options]
 * @param {import('playwright').Page} [options.page] - page pool yang sudah READY (skip goto/sesi/composer boot)
 * @param {boolean} [options.holdPage] - jangan tutup page di finally (default true jika options.page)
 */
async function eksekusiChatGPT(tipeTugas, promptTeks, isThinkingMode, fileInputData, folderHasil, context, options = {}) {
    return _als.run({ cookieId: '', poolSlot: '' }, () => _eksekusiChatGPTImpl(
        tipeTugas, promptTeks, isThinkingMode, fileInputData, folderHasil, context, options
    ));
}

async function _eksekusiChatGPTImpl(tipeTugas, promptTeks, isThinkingMode, fileInputData, folderHasil, context, options = {}) {
    let fileTersimpanArray = [];
    let arrayFile = Array.isArray(fileInputData) ? fileInputData : (fileInputData ? [fileInputData] : []);
    const validFiles = arrayFile.filter(f => fs.existsSync(f));

    // Prefix log: cookie_chatgpt_N dan/atau pool#M
    setChatgptLogCtx({
        cookieId: (options && (options.cookieId || options.cookieKey || options.worker)) || '',
        poolSlot: (options && (options.poolSlot != null ? options.poolSlot : options.slotId)) ?? '',
    });
    if (String(tipeTugas || '').toUpperCase() === 'GAMBAR') {
        const raw = String(promptTeks || '').trim();
        promptTeks = /^\[create image\]/i.test(raw) ? raw : `[Create Image] ${raw}`.trim();
        console.log(`[CHATGPT] Mode gambar tanpa klik plus. Prompt diawali [Create Image]`);
    }

    if (chatgptTag()) {
        console.log(`[CHATGPT] ${chatgptTag()}task=${tipeTugas} thinking=${!!isThinkingMode} files=${validFiles.length}`);
    }

    const existingPage = options && options.page ? options.page : null;
    const holdPage = existingPage ? (options.holdPage !== false) : false;
    let page = existingPage;

    if (!page) {
        page = await context.newPage();
        // setViewportSize HANG di Camoufox headless+Xvfb Codespace (proven smoke test).
        // Window size sudah dari launch Camoufox (width/height). Jangan panggil ini.
        // await page.setViewportSize({ width: 1920, height: 1080 });

        // ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€¦Ã¢â‚¬â„¢Ãƒâ€¦Ã‚Â¸ SISTEM PEMBUNUH POP-UP OTONOM (selalu nyala, termasuk memory NUX)
        await page.addInitScript(() => {
            const dismissPopups = () => {
                const btns = document.querySelectorAll('button');
                for (const btn of btns) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    if (
                        txt === 'got it' ||
                        txt === 'ÃƒÆ’Ã‚Â§Ãƒâ€¦Ã‚Â¸Ãƒâ€šÃ‚Â¥ÃƒÆ’Ã‚Â©Ãƒâ€šÃ‚ÂÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã‚Â¤Ãƒâ€šÃ‚ÂºÃƒÂ¢Ã¢â€šÂ¬ ' ||
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
                        t.includes('ÃƒÆ’Ã‚Â¤Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚ÂªÃƒÆ’Ã‚Â¦ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â§ÃƒÆ’Ã‚Â¥Ãƒâ€¦Ã¢â‚¬â„¢ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“') ||
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
            console.log(`\n[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€¦Ã¢â‚¬â„¢Ãƒâ€šÃ‚Â Membuka ChatGPT...`);
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
            // 3) Composer siap ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ baru ketik prompt
            // ---------------------------------------------------------
            await tungguComposerSiap(page, 60000);
            await stepShot(page, folderHasil, '03_composer_ready');
            await klikAreaKosong(page);
            await page.waitForTimeout(400);
        } else {
            // Pool: page sudah HOLD. Jangan goto / jangan New chat.
            console.log(`\n[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡Ãƒâ€šÃ‚Â¡ Lanjut di page pool (tanpa goto)...`);
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
            await tutupDialogPengganggu(page);
        }

        // Upaya pertama: composer kosong, tunggu Start Voice.
        // Upaya ulang: draft masih di kolom, tombolnya Kirim/Send â€” jangan tunggu suara 45 detik.
        if (upayaKirim === 1) {
            await tungguStartVoice(page, 45000);
            await stepShot(page, folderHasil, '03b_start_voice_ready');
        } else {
            console.log('[CHATGPT] Upaya ulang: lewati tunggu Start Voice (draft membuat tombol tetap Kirim/Send)');
            await tutupDialogPengganggu(page);
        }

        if (isThinkingMode) {
            console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€šÃ‚Â§  Mengaktifkan Thinking Mode...`);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForTimeout(800);
        }

        // =================================================================
        // ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸Ãƒâ€¦Ã¢â‚¬â„¢Ãƒâ€¦Ã‚Â¸ LOGIKA PELAMPIRAN DUAL-CORE (BERDASARKAN CHATGPT_1 DAN CHATGPT_2)
        // =================================================================
        if (validFiles.length > 0) {
            console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒâ€¦Ã‚Â½ Memproses ${validFiles.length} File...`);
            
            // Pemisahan Jenis File
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'];
            const imageFiles = validFiles.filter(f => imageExtensions.includes(path.extname(f).toLowerCase()));
            const docFiles = validFiles.filter(f => !imageExtensions.includes(path.extname(f).toLowerCase()));

            // -----------------------------------------------------------------
            // JURUS 1: UPLOAD DOKUMEN (Menggunakan logika murni chatgpt_2.js)
            // -----------------------------------------------------------------
            if (docFiles.length > 0) {
                console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾ Mengunggah Dokumen (Mode chatgpt_2.js)...`);
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
                        console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡ ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Menggunakan Injeksi Clipboard untuk Dokumen...`);
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
                } catch (e) { console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€¦Ã¢â‚¬â„¢ Error Dokumen: ${e.message}`); }
            }

            // -----------------------------------------------------------------
            // JURUS 2: UPLOAD GAMBAR (Menggunakan logika murni chatgpt_1.js)
            // -----------------------------------------------------------------
            if (imageFiles.length > 0) {
                console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“Ãƒâ€šÃ‚Â¼ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Mengunggah Gambar (Mode chatgpt_1.js)...`);
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
                        console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡ ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Menggunakan Injeksi Clipboard untuk Gambar...`);
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
                } catch (e) { console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€¦Ã¢â‚¬â„¢ Error Gambar: ${e.message}`); }
            }

            // Pantau lampiran (dari Script 2)
            console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€šÃ‚Â³ Menunggu visualisasi file di layar...`);
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
                console.log('[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Lampiran terdeteksi');
                await stepShot(page, folderHasil, '04_attachment_ok');
            } catch (e) {
                console.log('[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡ ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Timeout pantau lampiran:', e.message);
                await stepShot(page, folderHasil, '04_attachment_timeout');
            }

        }


        // JANGAN klikAreaKosong di antara suntik dan send ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â itu menghilangkan fokus composer
        console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡Ãƒâ€šÃ‚Â¡ Menyuntikkan Prompt...`);
        await suntikPromptKeComposer(page, promptTeks);
        await page.waitForTimeout(400);

        const sinyalSebelumKirim = await bacaStatusTombolComposer(page);
        copyAwal = sinyalSebelumKirim.copyCount || 0;
        console.log(`[CHATGPT] Mengirim tugas... btn=${sinyalSebelumKirim.status} aria="${sinyalSebelumKirim.aria}" copyAwal=${copyAwal}`);
        let how = '';
        for (let klik = 1; klik <= 3 && !terkirim; klik++) {
            await tutupDialogPengganggu(page);
            how = await klikSendAtauEnter(page);
            console.log(`[CHATGPT] Send method: ${how} (klik ${klik}/3)`);
            terkirim = await kirimTerkonfirmasi(page, promptTeks);
            if (!terkirim) console.log('[CHATGPT] Kirim belum terkonfirmasi, klik lagi...');
        }
        if (!terkirim) {
            console.log('[CHATGPT] Kirim belum terjadi (masih tombol Kirim / prompt masih di kolom). Tidak masuk radar.');
            try {
                if (folderHasil) {
                    const fp = path.join(folderHasil, `fail_send_${Date.now()}.png`);
                    await page.screenshot({ path: fp, fullPage: true }).catch(() => {});
                    console.log(`[CHATGPT] SS gagal kirim â†’ ${path.basename(fp)}`);
                }
            } catch (_) {}
            continue;
        }
        console.log('[CHATGPT] Kirim terkonfirmasi');
        await stepShot(page, folderHasil, '08_after_send');
        }
        if (!terkirim) throw new Error('SEND_GAGAL: tombol Kirim tidak mengirim tugas');

        // Radar: selesai saat tombol suara kembali (Mulai Suara / Start Voice).
        // Jangan tunggu tombol Salin ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â di page pool aria/testid salin sering tidak cocok
        // padahal jawaban sudah terlihat. Selama Hentikan jawaban / stop ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬ ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ masih proses.
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
        console.log(`[CHATGPT] ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒâ€¦  Baseline radar roles=${baseline.assistantRoles} legacy=${baseline.legacyAssist} textLen=${baselineTextLen} turns=${baseline.turnKeys || 0} gambar=${jumlahGambarAwal}`);

        console.log('\n[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€šÃ‚Â³ Mulai radar (selesai = Mulai Suara / Start Voice, lalu ambil teks terlihat)...');
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
                        return { status: 'done', images: uniqueImageUrls, text: '', via: 'gallery', textLen: 0 };
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
                    console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Radar done via=${state.via || '?'} len=${state.textLen || 0} btn=${btnSt.status} aria="${btnSt.aria}" copy=${btnSt.copyCount}`);
                    hasilEktraksi = state.status === 'done' ? state : { ...state, status: 'done', text: state.text || null };
                    break;
                }
            } else if (state.status === 'error') {
                throw new Error(state.msg);
            } else if (state.status === 'force_refresh') {
                console.log(`\n[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡Ãƒâ€šÃ‚Â¡ ${state.msg}`);
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
            console.log(`\n[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã¢â‚¬Å“ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ Mengunduh ${hasilEktraksi.images.length} gambar buatan AI...`);
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
                    console.log(`[CHATGPT] ÃƒÆ’Ã‚Â¢Ãƒâ€¦Ã‚Â¡ ÃƒÆ’Ã‚Â¯Ãƒâ€šÃ‚Â¸Ãƒâ€šÃ‚Â Gagal unduh gambar: ${e.message}`);
                }
            }
        } 

        if (tipeTugas === 'GAMBAR') {
            if (!fileTersimpanArray.length) throw new Error('GAMBAR: hasil gambar tidak tersimpan');
            return { text: '', files: fileTersimpanArray };
        }
        return { text: hasilEktraksi.text, files: fileTersimpanArray };

    } catch (err) {
        console.log(`\n[CHATGPT ÃƒÆ’Ã‚Â¢Ãƒâ€šÃ‚ÂÃƒâ€¦Ã¢â‚¬â„¢ CRITICAL ERROR]:`, err.message);
        try {
            const errFilePath = path.join(folderHasil, `error_trace_${Date.now()}.png`);
            await page.screenshot({ path: errFilePath, fullPage: true }).catch(()=>{});
            console.log(`ÃƒÆ’Ã‚Â°Ãƒâ€¦Ã‚Â¸ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒâ€šÃ‚Â¸ FOTO BUKTI ERROR DISIMPAN DI: ${errFilePath}`);
        } catch (screenshotErr) {}
        throw err;
    } finally {
        if (!holdPage && page) {
            await page.close().catch(()=>{});
        }
    }
}

module.exports = { eksekusiChatGPT, setChatgptLogCtx };
