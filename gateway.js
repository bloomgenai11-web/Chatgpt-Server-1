const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { launchCamoufox } = require('./camoufox_launch');
const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const chatgptModule = require('./platforms/chatgpt');
let poolBrowser = null;
try { poolBrowser = require('./pool_browser'); } catch (e) {
    console.log('[POOL] modul tidak ada — cold start only:', e.message);
}

const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24']);
process.env.DISPLAY = ':99';

const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '0', 10);
const PROXY_VERSION = parseInt(process.env.PROXY_VERSION || '5', 10);

// Layer 1 (browser): Cheap Proxy HTTP + auth
// Env: CHEAP_PROXY_* (preferred) atau legacy BD_PROXY_* / BRIGHTDATA_* sebagai alias baca saja
const CHEAP_PROXY_HOST = process.env.CHEAP_PROXY_HOST || process.env.BD_PROXY_HOST || process.env.BRIGHTDATA_HOST || '';
const CHEAP_PROXY_PORT = parseInt(process.env.CHEAP_PROXY_PORT || process.env.BD_PROXY_PORT || process.env.BRIGHTDATA_PORT || '0', 10);
const CHEAP_PROXY_USER = process.env.CHEAP_PROXY_USER || process.env.BD_PROXY_USER || process.env.BRIGHTDATA_USER || '';
const CHEAP_PROXY_PASS = process.env.CHEAP_PROXY_PASS || process.env.BD_PROXY_PASS || process.env.BRIGHTDATA_PASS || '';

// Alias internal agar sisa kode yang masih menyebut BD_* tidak putus (nilai = cheap)
const BD_PROXY_HOST = CHEAP_PROXY_HOST;
const BD_PROXY_PORT = CHEAP_PROXY_PORT;
const BD_PROXY_USER = CHEAP_PROXY_USER;
const BD_PROXY_PASS = CHEAP_PROXY_PASS;

// Layer static tidak dipakai di tier baru (cheap → none). Tetap parse env agar tidak error jika ada.
const STATIC_PROXY_HOST = process.env.STATIC_PROXY_HOST || '';
const STATIC_PROXY_PORT = parseInt(process.env.STATIC_PROXY_PORT || '0', 10);
const STATIC_PROXY_USER = process.env.STATIC_PROXY_USER || '';
const STATIC_PROXY_PASS = process.env.STATIC_PROXY_PASS || '';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const { startDeadman } = require('./qstash_deadman');

function ghHeaders(pat) {
    return {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gateway-estafet',
    };
}

const SHIFTS_PER_PAT = parseInt(process.env.SHIFTS_PER_PAT || '24', 10);

const MAX_COOKIES = parseInt(process.env.MAX_COOKIES || '300', 10);
const PORT = 3001;
const app = express();

app.use(cors());
app.use(express.json({ limit: '500mb' }));

const folderHasil = path.join(__dirname, 'hasil_media');
const folderTemp = path.join(__dirname, 'temp_uploads');
if (!fs.existsSync(folderHasil)) fs.mkdirSync(folderHasil);
if (!fs.existsSync(folderTemp)) fs.mkdirSync(folderTemp);
app.use('/files', express.static(folderHasil));

// =====================================================================
// RADAR PROXY (2 layer — Cheap Proxy)
// cheap  = CHEAP_PROXY_* HTTP+auth (primary untuk browser Camoufox)
// none   = direct Codespace (fallback jika cheap mati / tidak dikonfigurasi)
// Launch: opsi proxy Playwright. Logika lain (cookie, pool, QC, estafet) tidak diubah.
// =====================================================================
function initialProxyMode() {
    if (CHEAP_PROXY_HOST && CHEAP_PROXY_PORT) return 'cheap';
    return 'none';
}
let proxyMode = initialProxyMode();

function curlViaProxy(proxyUrl, cb) {
    exec(`curl -s --max-time 12 -x "${proxyUrl}" https://api.ipify.org`, (error, stdout) => {
        if (error || !stdout || !String(stdout).trim()) cb(null);
        else cb(String(stdout).trim());
    });
}

function setMode(mode, ip, logLine) {
    if (logLine && proxyMode !== mode) console.log(logLine);
    proxyMode = mode;
    const healthy = mode === 'none' ? '0' : '1';
    redis.set('proxy_healthy', healthy).catch(() => {});
    redis.set('proxy_mode', mode).catch(() => {});
    if (ip) redis.set('proxy_current_ip', ip).catch(() => {});
}

function monitorProxy() {
    if (!CHEAP_PROXY_HOST || !CHEAP_PROXY_PORT) {
        setMode('none', null, `\n[NETWORK] Cheap Proxy tidak ada → internet Codespace (tanpa proxy).`);
        return;
    }
    const auth = CHEAP_PROXY_USER
        ? `${encodeURIComponent(CHEAP_PROXY_USER)}:${encodeURIComponent(CHEAP_PROXY_PASS)}@`
        : '';
    const cheapUrl = `http://${auth}${CHEAP_PROXY_HOST}:${CHEAP_PROXY_PORT}`;
    curlViaProxy(cheapUrl, (ip) => {
        if (ip) {
            setMode('cheap', ip, `\n[NETWORK] ✅ Cheap Proxy ON (IP: ${ip}).`);
            return;
        }
        setMode('none', null, `\n[NETWORK] ⚠️ Cheap Proxy bermasalah → internet Codespace (tanpa proxy).`);
    });
}

function tryBrightDataFallback() {
    if (!BD_PROXY_HOST || !BD_PROXY_PORT) {
        return tryStaticFallback();
    }
    const auth = BD_PROXY_USER
        ? `${encodeURIComponent(BD_PROXY_USER)}:${encodeURIComponent(BD_PROXY_PASS)}@`
        : '';
    const bdUrl = `http://${auth}${BD_PROXY_HOST}:${BD_PROXY_PORT}`;
    curlViaProxy(bdUrl, (ip) => {
        if (ip) {
            setMode('brightdata', ip, `\n[NETWORK] ⚠️ L1 mati → L2 Bright Data ISP ON (IP: ${ip})`);
            return;
        }
        tryStaticFallback();
    });
}

function tryStaticFallback() {
    if (!STATIC_PROXY_HOST || !STATIC_PROXY_PORT) {
        setMode('none', null, `\n[NETWORK] ⚠️ Semua proxy mati → lokal Codespace.`);
        return;
    }
    const auth = STATIC_PROXY_USER
        ? `${STATIC_PROXY_USER}:${STATIC_PROXY_PASS}@`
        : '';
    const staticUrl = `http://${auth}${STATIC_PROXY_HOST}:${STATIC_PROXY_PORT}`;
    curlViaProxy(staticUrl, (ip) => {
        if (ip) {
            setMode('static', ip, `\n[NETWORK] ⚠️ L2 gagal → L3 STATIC Webshare ON (IP: ${ip})`);
        } else {
            setMode('none', null, `\n[NETWORK] ⚠️ Semua proxy mati → lokal Codespace.`);
        }
    });
}

const CAMOUFOX_BASE_PREFS = {
    'webgl.force-enabled': true,
    'webgl.disabled': false,
    'webgl.osmesa': true,
    'layers.acceleration.force-enabled': true,
    'dom.maxHardwareConcurrency': 8,
    'pdfjs.disabled': true,
    'browser.helperApps.neverAsk.saveToDisk': 'application/pdf,image/webp',
};

/**
 * Launch Camoufox — HTTP proxy Playwright (Cheap Proxy → none).
 * localtonet SOCKS TIDAK dipakai di browser (Unable to find the proxy server).
 * Opt-in eksperimen: GATEWAY_USE_LOCALTONET=true
 */
async function launchGatewayBrowser() {
    const prefs = { ...CAMOUFOX_BASE_PREFS };
    let label = 'Local';
    let gunakanProxy = false;
    const camoufoxOpts = {
        headless: true,
        width: 1280,
        height: 720,
        firefoxUserPrefs: prefs,
    };

    // ChatGPT 2 jalur: Cheap Proxy, atau internet Codespace jika cheap bermasalah.
    if (proxyMode === 'cheap' && CHEAP_PROXY_HOST && CHEAP_PROXY_PORT) {
        camoufoxOpts.geoip = true;
        camoufoxOpts.proxy = {
            server: `http://${CHEAP_PROXY_HOST}:${CHEAP_PROXY_PORT}`,
        };
        if (CHEAP_PROXY_USER) camoufoxOpts.proxy.username = CHEAP_PROXY_USER;
        if (CHEAP_PROXY_PASS) camoufoxOpts.proxy.password = CHEAP_PROXY_PASS;
        label = 'CheapProxy';
        gunakanProxy = true;
    } else {
        prefs['network.proxy.type'] = 0;
        camoufoxOpts.geoip = false;
        camoufoxOpts.firefoxUserPrefs = prefs;
        label = 'Codespace';
        gunakanProxy = false;
    }

    console.log(`[GATEWAY] launch browser net=${label} (proxyMode radar=${proxyMode})`);
    // Hindari BrowserForge navigator.product error TANPA camoufox_safe:
    // i_know_what_im_doing + biarkan fingerprint default OS firefox saja
    const browser = await launchCamoufox({
        ...camoufoxOpts,
        block_images: false,
        humanize: false,
    });
    return { browser, label, gunakanProxy };
}

setInterval(monitorProxy, 30000);
monitorProxy();

let isRetiring = false;
let jumlahTugasAktif = 0;

/**
 * Index cookie GLOBAL di Redis: key `global_chatgpt_index` (1..MAX_COOKIES).
 * Nilai = index cookie TERAKHIR yang sudah di-CONSUME untuk tugas nyata.
 * Cookie berikutnya untuk tugas = index+1 (wrap ke 1).
 *
 * - consumeSesiCookie()     : INCR & ambil (cold start / QC / tugas tanpa pool)
 * - peekSesiCookie(offset)  : baca calon index+offset TANPA INCR (pool validasi)
 * - commitSesiIndex(index)  : set index ke N jika N > current (setelah pool pakai cookie N)
 *
 * Pool TIDAK boleh INCR saat boot. 10 slot = peek offset 1..10 dari current.
 * Codespace ganti → index Redis sama → akun yang hanya di-cek pool tidak terlompati.
 */
function formatCookiePayload(rawData, cookieKey, index) {
    return {
        id: cookieKey,
        index: index,
        cookies: Object.entries(rawData).map(([key, value]) => ({
            name: key, value: String(value), domain: '.chatgpt.com', path: '/', secure: true, sameSite: 'Lax'
        })),
    };
}

async function getCurrentCookieIndex() {
    const raw = await redis.get('global_chatgpt_index');
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

function wrapIndex(n) {
    let x = ((n - 1) % MAX_COOKIES) + 1;
    if (x < 1) x = 1;
    return x;
}

/** Ambil cookie berikutnya dan MAJUKAN global_chatgpt_index. */
async function consumeSesiCookie() {
    let index = await redis.incr('global_chatgpt_index');
    if (index > MAX_COOKIES) {
        await redis.set('global_chatgpt_index', 1);
        index = 1;
    }
    const cookieKey = `cookie_chatgpt_${index}`;
    const rawData = await redis.get(cookieKey);
    if (!rawData) throw new Error(`[REDIS] Data tidak ditemukan: ${cookieKey}`);
    return formatCookiePayload(rawData, cookieKey, index);
}

/**
 * Peek calon cookie: offset 1 = next setelah current (default).
 * offset 2..POOL_SIZE = slot berikutnya, tanpa menyentuh global_chatgpt_index.
 */
async function peekSesiCookie(offset = 1) {
    const off = Math.max(1, parseInt(offset, 10) || 1);
    const current = await getCurrentCookieIndex();
    const index = wrapIndex(current + off);
    const cookieKey = `cookie_chatgpt_${index}`;
    const rawData = await redis.get(cookieKey);
    if (!rawData) throw new Error(`[REDIS] Data tidak ditemukan: ${cookieKey}`);
    return formatCookiePayload(rawData, cookieKey, index);
}

/**
 * Setelah pool (atau jalur lain) benar-benar memakai cookie index N untuk tugas,
 * commit supaya cold-start berikutnya tidak mengulang N.
 * Hanya maju (tidak mundur) agar tidak menabrak konsumsi paralel.
 */
async function commitSesiIndex(index) {
    const n = parseInt(index, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const current = await getCurrentCookieIndex();
    // Sederhana: set ke N jika N "di depan" current dalam ring, atau current masih 0.
    // Untuk ring 1..MAX: jika belum pernah consume, set N; jika N > current tanpa wrap, set N;
    // jika wrap (N < current) biarkan current (konsumen lain sudah lebih maju) kecuali current=0.
    if (current === 0 || n >= current) {
        await redis.set('global_chatgpt_index', n);
        console.log(`[COOKIE] commit index ${current} → ${n}`);
    } else {
        // N < current bisa berarti wrap-around leg — jangan mundurkan pointer
        console.log(`[COOKIE] commit skip (N=${n} < current=${current})`);
    }
}

/** Alias jalur tugas / QC = consume. */
async function dapatkanSesiCookie() {
    return consumeSesiCookie();
}


// Daftar SS kegagalan terbaru (dashboard Vercel)
app.get('/api/failures', (req, res) => {
    try {
        const files = fs.readdirSync(folderHasil)
            .filter((f) => /^(fail_|error_trace_)/i.test(f) && /\.png$/i.test(f))
            .map((f) => {
                const st = fs.statSync(path.join(folderHasil, f));
                return { name: f, url: `/files/${f}`, mtime: st.mtimeMs, size: st.size };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, 40);
        res.json({ status: 'ok', files });
    } catch (e) {
        res.status(500).json({ status: 'failed', error: e.message });
    }
});

app.get('/api/health', async (req, res) => {
    try {
        const mode = await redis.get('proxy_mode').catch(() => null);
        const ip = await redis.get('proxy_current_ip').catch(() => null);
        res.json({
            status: 'ok',
            proxyMode: mode || proxyMode,
            proxyIp: ip || null,
            poolSize: parseInt(process.env.POOL_SIZE || '3', 10),
            activeWorkers: jumlahTugasAktif,
        });
    } catch (e) {
        res.json({ status: 'ok', proxyMode, activeWorkers: jumlahTugasAktif });
    }
});

app.post('/api/generate', async (req, res) => {
    if (isRetiring) return res.status(503).json({ error: "Sistem estafet aktif. Silakan request ulang." });

    jumlahTugasAktif++;

    const { action = 'CHAT', prompt, isThinkingMode = false, fileArray = [] } = req.body;
    let translatedFiles = [];

    if (fileArray && fileArray.length > 0) {
        fileArray.forEach((fileObj, index) => {
            const matches = fileObj.base64 && fileObj.base64.match(/^data:(.+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                let originalExt = path.extname(fileObj.name || '');
                if (!originalExt) originalExt = '.bin';

                const safeName = `upload_${Date.now()}_${index}${originalExt}`;
                const tempFilePath = path.join(folderTemp, safeName);
                fs.writeFileSync(tempFilePath, buffer);
                translatedFiles.push(tempFilePath);
            }
        });
    }

    let browser, context;
    try {
        const activeUrl = await redis.get('active_gateway_url') || `http://localhost:${PORT}`;

        // Slot pool = PAT sehat yang sudah ditutup. Jalur tugas tetap launch biasa.
        let poolSlot = null;
        if (poolBrowser && typeof poolBrowser.acquireReadySlot === 'function') {
            poolSlot = poolBrowser.acquireReadySlot();
        }
        if (poolSlot && poolSlot.cookies) {
            try {
                const sesi = { id: poolSlot.cookieId, index: poolSlot.cookieIndex, cookies: poolSlot.cookies };
                console.log(`[GATEWAY] ⚡ Pool slot#${poolSlot.id} cookie=${sesi.id} | net=${proxyMode}`);
                const launched = await launchGatewayBrowser();
                browser = launched.browser;
                context = await browser.newContext({ acceptDownloads: true });
                await context.addCookies(sesi.cookies);
                const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context, {
                    cookieId: sesi.id,
                    poolSlot: poolSlot.id,
                });
                // Cookie pool dipakai tugas nyata → commit index (jangan dilewati di codespace berikutnya)
                if (sesi.index) await commitSesiIndex(sesi.index);
                res.json({
                    status: 'success',
                    worker: sesi.id,
                    network: launched.label,
                    text: hasil.text,
                    fileUrls: (hasil.files || []).map(f => `${activeUrl}/files/${f}`),
                });
                return;
            } catch (poolErr) {
                console.error(`[GATEWAY] ⚠️ Pool gagal, cold start: ${poolErr.message}`);
                if (context) await context.close().catch(() => {});
                if (browser) await browser.close().catch(() => {});
                context = null;
                browser = null;
            } finally {
                if (typeof poolBrowser.releaseSlot === 'function') poolBrowser.releaseSlot(poolSlot);
            }
        }

        // Cold start — jalur utama (sama seperti gateway asli)
        const sesi = await dapatkanSesiCookie();
        console.log(`[GATEWAY] 🚀 Meluncurkan tugas | Pekerja Aktif: ${jumlahTugasAktif} | Akun: ${sesi.id} | net=${proxyMode}`);

        const launched = await launchGatewayBrowser();
        browser = launched.browser;
        context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies(sesi.cookies);

        const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context, {
            cookieId: sesi.id,
        });

        res.json({
            status: 'success',
            worker: sesi.id,
            network: launched.label,
            text: hasil.text,
            fileUrls: hasil.files.map(f => `${activeUrl}/files/${f}`),
        });
    } catch (error) {
        console.error(`[GATEWAY] ❌ TUGAS GAGAL: ${error.message}`);
        res.status(500).json({ status: 'failed', error: error.message });
    } finally {
        jumlahTugasAktif--;
        console.log(`[GATEWAY] 📉 Tugas selesai. Pekerja Aktif Tersisa: ${jumlahTugasAktif}`);

        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        translatedFiles.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    }
});

async function jalankanDemoAwal(activeUrl) {
    const MAX_QC_TRIES = parseInt(process.env.QC_MAX_TRIES || '3', 10);
    const QC_RETRY_MS = parseInt(process.env.QC_RETRY_MS || '10000', 10);

    console.log(`\n[SYSTEM-DEMO] 🚀 Tes QC ChatGPT (maks ${MAX_QC_TRIES} kali, jeda ${QC_RETRY_MS / 1000}s)...`);

    const promptDemo = 'Berikan satu kalimat sapaan selamat datang yang sangat lucu, sedikit nyeleneh, dan penuh semangat untuk Bosku.';

    for (let attempt = 1; attempt <= MAX_QC_TRIES; attempt++) {
        let browser;
        let context;
        let sesi;
        try {
            if (attempt > 1) {
                console.log(`[SYSTEM-DEMO] ↻ Coba lagi ${attempt}/${MAX_QC_TRIES} (cookie baru + proxy)...`);
                monitorProxy();
                await new Promise((r) => setTimeout(r, QC_RETRY_MS));
            }

            // Setiap percobaan ambil cookie berikutnya (index Redis naik).
            // Cookie kadaluarsa tidak dipakai berulang di 3x QC.
            try {
                sesi = await dapatkanSesiCookie();
            } catch (e) {
                console.error(`[SYSTEM-DEMO] ❌ Gagal ambil cookie attempt ${attempt}: ${e.message}`);
                if (attempt >= MAX_QC_TRIES) {
                    console.log(`[SYSTEM-DEMO] ⚠️ URL Cloudflare DITAHAN.\n`);
                    return;
                }
                continue;
            }

            const launched = await launchGatewayBrowser();
            browser = launched.browser;
            console.log(`[SYSTEM-DEMO] percobaan ${attempt}/${MAX_QC_TRIES} net=${launched.label} mode=${proxyMode} akun=${sesi.id}`);

            context = await browser.newContext({ acceptDownloads: true });
            await context.addCookies(sesi.cookies);

            const hasil = await chatgptModule.eksekusiChatGPT('CHAT', promptDemo, false, [], folderHasil, context, {
                cookieId: sesi.id,
            });

            console.log(`\n======================================================`);
            console.log(`🎉 [DEMO SUKSES] Percobaan ${attempt}/${MAX_QC_TRIES} — sistem sehat.`);
            console.log(`🤖 Pesan dari ChatGPT: "${hasil.text}"`);

            if (activeUrl) {
                await redis.set('active_gateway_url', activeUrl);
                console.log(`[SYSTEM] 🟢 TAUTAN CLOUDFLARE DIBUKA: Vercel dialihkan ke mesin ini.`);
            }
            console.log(`======================================================\n`);

            // Setelah QC sukses + URL publik: nyalakan pool (opsional, tidak mengganggu QC)
            if (poolBrowser && typeof poolBrowser.setDeps === 'function') {
                try {
                    poolBrowser.setDeps({
                        launchGatewayBrowser,
                        dapatkanSesiCookie,
                        peekSesiCookie,
                        consumeSesiCookie,
                        commitSesiIndex,
                        chatgptModule,
                        MAX_COOKIES,
                    });
                    console.log(`[POOL] QC sukses — mengaktifkan pool browser...`);
                    poolBrowser.startPool(folderHasil).catch((e) => console.error('[POOL] start gagal:', e.message));
                } catch (e) {
                    console.error('[POOL] init gagal:', e.message);
                }
            }
            return;
        } catch (error) {
            console.error(`[SYSTEM-DEMO] ❌ Percobaan ${attempt}/${MAX_QC_TRIES} gagal: ${error.message}`);
            if (attempt >= MAX_QC_TRIES) {
                console.log(`[SYSTEM-DEMO] ⚠️ QC gagal ${MAX_QC_TRIES}x. URL Cloudflare DITAHAN. Codespace lama tetap pegang rute.\n`);
            }
        } finally {
            if (context) await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
        }
    }
}

async function jalankanProtokolEstafet() {
    console.log(`\n[ESTAFET] ⏰ Waktu shift habis. Memulai protokol rotasi Ping-Pong...`);

    const repoFullName = (
        process.env.CODESPACE_TARGET_REPO ||
        process.env.GITHUB_REPOSITORY ||
        ''
    ).trim();

    if (!repoFullName || !repoFullName.includes('/')) {
        console.error('[ESTAFET] ❌ Set CODESPACE_TARGET_REPO=owner/repo di .env (atau pastikan GITHUB_REPOSITORY ada).');
        return;
    }

    let isSuccess = false;
    let nextPat = null;
    const ESTAFET_WAIT_MS = 30000;

    let rawMyPat0 = await redis.get('current_active_pat');
    let myPat = (typeof rawMyPat0 === 'string' ? rawMyPat0 : '').trim();

    while (!isSuccess) {
        let rawMyPat = await redis.get('current_active_pat');
        myPat = (typeof rawMyPat === 'string' ? rawMyPat : myPat).trim();

        let rawPats = await redis.lrange('github_pats', 0, -1);
        if (!Array.isArray(rawPats)) rawPats = [];
        rawPats = rawPats.map(p => String(p).trim()).filter(Boolean);

        let patShifts = await redis.get('pat_shift_quota') || {};
        if (typeof patShifts !== 'object' || patShifts === null) patShifts = {};
        for (const pat of rawPats) {
            if (patShifts[pat] === undefined) patShifts[pat] = SHIFTS_PER_PAT;
        }

        let validPats = rawPats.filter(pat => (patShifts[pat] || 0) > 0);
        let candidates = validPats.filter(pat => pat !== myPat);
        if (candidates.length === 0) candidates = validPats.slice();

        if (candidates.length === 0) {
            console.log(`[ESTAFET] ⏳ Stok PAT kosong / semua ban. Mesin ini TETAP bekerja, menunggu bot_github menambah PAT...`);
            await new Promise(r => setTimeout(r, ESTAFET_WAIT_MS));
            continue;
        }

        nextPat = candidates[0];
        console.log(`[ESTAFET] 🔄 Coba bangunkan penerus dengan PAT: ${nextPat.substring(0, 8)}... (sisa kandidat: ${candidates.length})`);

        try {
            const checkRes = await fetch('https://api.github.com/user/codespaces', {
                headers: ghHeaders(nextPat)
            });
            if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (checkData.codespaces && checkData.codespaces.length > 0) {
                    console.log(`[ESTAFET] 🧹 Bersihkan ${checkData.codespaces.length} codespace usang...`);
                    for (let cs of checkData.codespaces) {
                        await fetch(`https://api.github.com/user/codespaces/${cs.name}`, {
                            method: 'DELETE',
                            headers: ghHeaders(nextPat)
                        });
                    }
                }
            }

            const repoRes = await fetch(`https://api.github.com/repos/${repoFullName}`, {
                headers: ghHeaders(nextPat)
            });
            if (!repoRes.ok) throw new Error('Gagal akses Repo. PAT flagged/dicabut atau tidak bisa dihidupkan.');
            const repoData = await repoRes.json();

            const createRes = await fetch('https://api.github.com/user/codespaces', {
                method: 'POST',
                headers: { ...ghHeaders(nextPat), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repository_id: repoData.id,
                    idle_timeout_minutes: 240
                })
            });
            if (!createRes.ok) {
                const errTxt = await createRes.text();
                throw new Error(`API Error (tidak bisa dihidupkan): ${errTxt}`);
            }

            console.log(`[ESTAFET] ✅ Penerus sukses dipesan, sedang booting!`);
            isSuccess = true;

            patShifts[nextPat] = (patShifts[nextPat] || SHIFTS_PER_PAT) - 1;
            await redis.set('pat_shift_quota', patShifts);
            await redis.set('current_active_pat', nextPat.trim());

            if (patShifts[nextPat] <= 0) {
                await redis.lrem('github_pats', 1, nextPat);
                delete patShifts[nextPat];
                await redis.set('pat_shift_quota', patShifts);
                console.log(`[ESTAFET] PAT ${nextPat.substring(0, 8)}... kuota habis → LREM`);
            }
        } catch (err) {
            console.error(`[ESTAFET] ❌ PAT ${nextPat.substring(0, 8)}... gagal dihidupkan: ${err.message}`);
            console.log(`[ESTAFET] ⚠️ LREM PAT ini dari stok, mesin tetap bekerja, cari pengganti lain...`);
            await redis.lrem('github_pats', 1, nextPat);
            delete patShifts[nextPat];
            await redis.set('pat_shift_quota', patShifts);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    console.log(`[ESTAFET] 📡 Menunggu mesin penerus menyelesaikan QC dan mengambil alih rute Cloudflare...`);
    const oldUrl = await redis.get('active_gateway_url');

    const pantauPengambilalihan = setInterval(async () => {
        const currentUrl = await redis.get('active_gateway_url');

        if (currentUrl && currentUrl !== oldUrl) {
            clearInterval(pantauPengambilalihan);
            console.log(`\n[ESTAFET] 🔄 PENGAMBILALIHAN BERHASIL! Rute tugas telah berpindah.`);

            isRetiring = true;
            console.log(`[ESTAFET] 🛑 Menolak tugas baru. Menunggu ${jumlahTugasAktif} tugas tersisa diselesaikan...`);

            let batasWaktuTunggu = 60;

            const cekSisaTugas = setInterval(async () => {
                batasWaktuTunggu--;
                if (jumlahTugasAktif === 0 || batasWaktuTunggu <= 0) {
                    clearInterval(cekSisaTugas);

                    if (batasWaktuTunggu <= 0) console.log(`[ESTAFET] ⚠️ Waktu habis! Memaksa pembersihan tugas yang nyangkut.`);
                    console.log(`[ESTAFET] 🪦 Memulai penghancuran diri (Self-Destruct)...`);

                    try {
                        const currentCodespaceName = process.env.CODESPACE_NAME;
                        if (currentCodespaceName && myPat) {
                            const delRes = await fetch(`https://api.github.com/user/codespaces/${currentCodespaceName}`, {
                                method: 'DELETE',
                                headers: ghHeaders(myPat)
                            });
                            console.log(`[ESTAFET] Laporan Status Hancur Diri: HTTP ${delRes.status}`);
                        }
                    } catch (e) {
                        console.error(`[ESTAFET] Kesalahan saat memanggil API Hancur Diri: ${e.message}`);
                    }
                    process.exit(0);
                }
            }, 5000);
        }
    }, 10000);
}

app.listen(PORT, async () => {
    console.log(`🚀 API Gateway Camoufox menyala di Port ${PORT}`);

    const rawMyPat = await redis.get('current_active_pat');
    const myPat = (typeof rawMyPat === 'string' ? rawMyPat : '').trim();

    if (!myPat) {
        const first = await redis.lindex('github_pats', 0);
        if (first) await redis.set('current_active_pat', String(first).trim());
    }

    startDeadman(redis);

    console.log(`[SYSTEM] 🚇 Memulai inisiasi Cloudflare Tunnel seketika...`);
    const cloudflaredPath = path.join(__dirname, 'cloudflared');
    try {
        if (!fs.existsSync(cloudflaredPath)) {
            console.log(`[SYSTEM] ⬇️ Mengunduh Cloudflared...`);
            require('child_process').execSync(`wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O "${cloudflaredPath}" && chmod +x "${cloudflaredPath}"`);
        }

        const cf = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${PORT}`]);
        let urlFound = false;

        cf.stderr.on('data', async (data) => {
            const match = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && !urlFound) {
                urlFound = true;
                const activeUrl = match[0];

                console.log(`[SYSTEM] 🔎 Terowongan Tertangkap: ${activeUrl}`);
                console.log(`[SYSTEM] 🛑 Menahan publikasi URL ke Vercel sampai QC Test selesai...`);

                const SHIFT_DURATION_MS = parseInt(process.env.SHIFT_DURATION_MS || String(30 * 60 * 1000), 10);
                setTimeout(jalankanProtokolEstafet, SHIFT_DURATION_MS);

                await jalankanDemoAwal(activeUrl);
            }
        });

        cf.on('close', () => {
            if (!urlFound) console.log(`[SYSTEM] ❌ Cloudflare terputus secara tak wajar.`);
        });
    } catch (err) {
        console.error(`[SYSTEM] ❌ Gagal menjalankan Cloudflare:`, err.message);
    }
});
