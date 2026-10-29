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
    console.log('[POOL] modul tidak ada â€” cold start only:', e.message);
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

// Layer static tidak dipakai di tier baru (cheap â†’ none). Tetap parse env agar tidak error jika ada.
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
// RADAR PROXY (2 layer â€” Cheap Proxy)
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
        setMode('none', null, `\n[NETWORK] Cheap Proxy tidak ada â†’ internet Codespace (tanpa proxy).`);
        return;
    }
    const auth = CHEAP_PROXY_USER
        ? `${encodeURIComponent(CHEAP_PROXY_USER)}:${encodeURIComponent(CHEAP_PROXY_PASS)}@`
        : '';
    const cheapUrl = `http://${auth}${CHEAP_PROXY_HOST}:${CHEAP_PROXY_PORT}`;
    curlViaProxy(cheapUrl, (ip) => {
        if (ip) {
            setMode('cheap', ip, `\n[NETWORK] âœ… Cheap Proxy ON (IP: ${ip}).`);
            return;
        }
        setMode('none', null, `\n[NETWORK] âš ï¸ Cheap Proxy bermasalah â†’ internet Codespace (tanpa proxy).`);
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
            setMode('brightdata', ip, `\n[NETWORK] âš ï¸ L1 mati â†’ L2 Bright Data ISP ON (IP: ${ip})`);
            return;
        }
        tryStaticFallback();
    });
}

function tryStaticFallback() {
    if (!STATIC_PROXY_HOST || !STATIC_PROXY_PORT) {
        setMode('none', null, `\n[NETWORK] âš ï¸ Semua proxy mati â†’ lokal Codespace.`);
        return;
    }
    const auth = STATIC_PROXY_USER
        ? `${STATIC_PROXY_USER}:${STATIC_PROXY_PASS}@`
        : '';
    const staticUrl = `http://${auth}${STATIC_PROXY_HOST}:${STATIC_PROXY_PORT}`;
    curlViaProxy(staticUrl, (ip) => {
        if (ip) {
            setMode('static', ip, `\n[NETWORK] âš ï¸ L2 gagal â†’ L3 STATIC Webshare ON (IP: ${ip})`);
        } else {
            setMode('none', null, `\n[NETWORK] âš ï¸ Semua proxy mati â†’ lokal Codespace.`);
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
 * Launch Camoufox â€” HTTP proxy Playwright (Cheap Proxy â†’ none).
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
 *
 * Satu cookie = satu browser. Sewa ada di memori proses (bukan Redis):
 * pool boot, cold start, dan QC memanggil claimFreeCookie().
 * Slot lain tidak boleh mengambil nomor yang masih disewa.
 * Redis TIDAK maju saat pool hanya memeriksa. Maju saat tugas sukses (commit),
 * dan tidak meloncat melewati cookie yang masih disewa slot lain.
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

/** cookie_chatgpt_N yang sedang dipegang sebuah browser (pool siap, tugas, atau QC). */
const cookieLeases = new Set();
/** Sudah dipakai tugas nyata. Tidak boleh di-roll lagi, meski sewanya sudah lepas. */
const cookieSpent = new Set();
const SPENT_KEY = 'chatgpt_cookie_spent';

async function loadSpentCookies() {
    try {
        const raw = await redis.get(SPENT_KEY);
        const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : []);
        for (const id of arr || []) cookieSpent.add(String(id));
        if (cookieSpent.size) console.log(`[COOKIE] spent tersimpan ${cookieSpent.size} (tidak di-roll)`);
    } catch (e) {
        console.log('[COOKIE] load spent gagal: ' + e.message);
    }
}

async function persistSpent() {
    await redis.set(SPENT_KEY, JSON.stringify([...cookieSpent]));
}

/** Geser index melewati deretan cookie yang sudah habis. Lubang yang baru disewa (belum tugas) tidak dilewati. */
async function advanceIndexPastSpent() {
    let current = await getCurrentCookieIndex();
    let advanced = current;
    let next = wrapIndex((current || 0) + 1);
    for (let guard = 0; guard < MAX_COOKIES; guard++) {
        if (!cookieSpent.has(cookieKeyOf(next))) break;
        advanced = next;
        next = wrapIndex(advanced + 1);
        if (next === advanced) break;
    }
    if (advanced && advanced !== current) {
        await redis.set('global_chatgpt_index', advanced);
        console.log(`[COOKIE] commit index ${current} â†’ ${advanced} (lewati yang sudah habis)`);
    }
}

async function markCookieSpent(id) {
    if (!id || cookieSpent.has(id)) return;
    cookieSpent.add(id);
    console.log(`[COOKIE] habis dipakai ${id} (tidak di-roll, spent=${cookieSpent.size})`);
    try { await persistSpent(); } catch (e) { console.log('[COOKIE] simpan spent gagal: ' + e.message); }
    try { await advanceIndexPastSpent(); } catch (e) { console.log('[COOKIE] geser index gagal: ' + e.message); }
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

function cookieKeyOf(index) {
    return `cookie_chatgpt_${index}`;
}

/** Ada sewa di antara current dan n (n sendiri tidak dihitung). */
function leasedBetween(current, n) {
    if (!current || current === n) return false;
    let i = wrapIndex(current + 1);
    for (let guard = 0; guard < MAX_COOKIES && i !== n; guard++) {
        if (cookieLeases.has(cookieKeyOf(i))) return true;
        i = wrapIndex(i + 1);
    }
    return false;
}

function releaseCookieLease(id) {
    if (!id) return;
    if (cookieLeases.delete(id)) {
        console.log(`[COOKIE] lepas ${id} (sewa aktif=${cookieLeases.size})`);
    }
}

/**
 * Ambil cookie bebas berikutnya setelah index Redis.
 * exclude: id yang baru gagal di slot ini, jangan diambil lagi pada percobaan ini.
 * advanceRedis: geser index hanya jika tidak ada sewa di depannya.
 */
async function claimFreeCookie({ exclude = [], advanceRedis = false } = {}) {
    const skip = new Set(exclude || []);
    const current = await getCurrentCookieIndex();
    for (let step = 1; step <= MAX_COOKIES; step++) {
        const index = wrapIndex(current + step);
        const cookieKey = cookieKeyOf(index);
        if (cookieSpent.has(cookieKey)) {
            console.log(`[COOKIE] lewati ${cookieKey} â€” sudah dipakai tugas, tidak di-roll`);
            continue;
        }
        if (cookieLeases.has(cookieKey)) {
            console.log(`[COOKIE] lewati ${cookieKey} â€” sedang dipakai browser lain`);
            continue;
        }
        if (skip.has(cookieKey) || skip.has(index)) continue;
        const rawData = await redis.get(cookieKey);
        if (!rawData) continue;
        cookieLeases.add(cookieKey);
        if (advanceRedis && !leasedBetween(current, index)) {
            await redis.set('global_chatgpt_index', index);
            console.log(`[COOKIE] consume index ${current} â†’ ${index}`);
        }
        console.log(`[COOKIE] sewa ${cookieKey} (sewa aktif=${cookieLeases.size})`);
        return formatCookiePayload(rawData, cookieKey, index);
    }
    throw new Error('[COOKIE] tidak ada cookie bebas â€” semua sedang disewa browser lain');
}

/** Cold start / QC: sewa cookie berikutnya. Index Redis maju hanya jika tidak menabrak sewa pool. */
async function consumeSesiCookie() {
    return claimFreeCookie({ advanceRedis: true });
}

/**
 * Pool boot. Offset angka lama (current+slotId) TIDAK dipakai lagi â€”
 * itu yang membuat dua slot memegang cookie yang sama setelah index bergeser.
 */
async function peekSesiCookie(arg = 1) {
    const exclude = (arg && typeof arg === 'object' && Array.isArray(arg.exclude)) ? arg.exclude : [];
    return claimFreeCookie({ exclude, advanceRedis: false });
}

/**
 * Setelah tugas benar-benar memakai cookie N.
 * Tidak meloncat melewati cookie yang masih disewa slot/tugas lain.
 */
async function commitSesiIndex(index) {
    const n = parseInt(index, 10);
    if (!Number.isFinite(n) || n < 1) return;
    await markCookieSpent(cookieKeyOf(n));
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

    const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_TASKS || '3', 10);
    if (jumlahTugasAktif >= MAX_CONCURRENT) {
        return res.status(429).json({
            status: 'failed',
            error: `sibuk: ${jumlahTugasAktif}/${MAX_CONCURRENT} browser tugas aktif`,
        });
    }

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
    let poolSlot = null;
    let leasedId = null;
    try {
        const activeUrl = await redis.get('active_gateway_url') || `http://localhost:${PORT}`;

        // Slot pool = PAT sehat yang sudah ditutup. Jalur tugas tetap launch biasa.
        // Cookie slot sudah disewa sejak boot â€” tidak boleh disewa browser lain.
        if (poolBrowser && typeof poolBrowser.acquireReadySlot === 'function') {
            poolSlot = poolBrowser.acquireReadySlot();
        }
        if (poolSlot && poolSlot.cookies) {
            try {
                const sesi = { id: poolSlot.cookieId, index: poolSlot.cookieIndex, cookies: poolSlot.cookies };
                leasedId = sesi.id;
                console.log(`[GATEWAY] âš¡ Pool slot#${poolSlot.id} cookie=${sesi.id} | net=${proxyMode}`);
                const launched = await launchGatewayBrowser();
                browser = launched.browser;
                context = await browser.newContext({ acceptDownloads: true });
                await context.addCookies(sesi.cookies);
                const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context, {
                    cookieId: sesi.id,
                    poolSlot: poolSlot.id,
                });
                // Commit dulu, sewa masih dipegang, supaya isi-ulang slot tidak mengambil nomor ini
                // dan tidak meloncat melewati cookie yang masih disewa slot lain.
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
                console.error(`[GATEWAY] âš ï¸ Pool slot gagal, TIDAK cold-start (hindari browser kedua): ${poolErr.message}`);
                if (context) await context.close().catch(() => {});
                if (browser) await browser.close().catch(() => {});
                context = null;
                browser = null;
                throw poolErr;
            }
        }

        // Cold start â€” hanya jika tidak ada slot. Cookie di-sewa, tidak boleh sama dengan pool.
        const sesi = await dapatkanSesiCookie();
        leasedId = sesi.id;
        console.log(`[GATEWAY] ðŸš€ Meluncurkan tugas | Pekerja Aktif: ${jumlahTugasAktif} | Akun: ${sesi.id} | net=${proxyMode}`);

        const launched = await launchGatewayBrowser();
        browser = launched.browser;
        context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies(sesi.cookies);

        const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context, {
            cookieId: sesi.id,
        });

        if (sesi.index) await commitSesiIndex(sesi.index);
        res.json({
            status: 'success',
            worker: sesi.id,
            network: launched.label,
            text: hasil.text,
            fileUrls: hasil.files.map(f => `${activeUrl}/files/${f}`),
        });
    } catch (error) {
        console.error(`[GATEWAY] âŒ TUGAS GAGAL: ${error.message}`);
        res.status(500).json({ status: 'failed', error: error.message });
    } finally {
        jumlahTugasAktif--;
        console.log(`[GATEWAY] ðŸ“‰ Tugas selesai. Pekerja Aktif Tersisa: ${jumlahTugasAktif}`);

        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        // Browser tugas sudah tutup. Baru lepas sewa, lalu pool boleh boot cookie lain.
        if (leasedId) {
            await markCookieSpent(leasedId);
            releaseCookieLease(leasedId);
        }
        if (poolSlot && typeof poolBrowser.releaseSlot === 'function') {
            // Jangan langsung membuka lagi akun yang baru saja dipakai tugas ini.
            poolSlot.failIds = leasedId ? [leasedId] : [];
            poolBrowser.releaseSlot(poolSlot);
        }
        translatedFiles.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    }
});

async function jalankanDemoAwal(activeUrl) {
    const MAX_QC_TRIES = parseInt(process.env.QC_MAX_TRIES || '3', 10);
    const QC_RETRY_MS = parseInt(process.env.QC_RETRY_MS || '10000', 10);

    console.log(`\n[SYSTEM-DEMO] ðŸš€ Tes QC ChatGPT (maks ${MAX_QC_TRIES} kali, jeda ${QC_RETRY_MS / 1000}s)...`);

    const promptDemo = 'Berikan satu kalimat sapaan selamat datang yang sangat lucu, sedikit nyeleneh, dan penuh semangat untuk Bosku.';

    for (let attempt = 1; attempt <= MAX_QC_TRIES; attempt++) {
        let browser;
        let context;
        let sesi;
        try {
            if (attempt > 1) {
                console.log(`[SYSTEM-DEMO] â†» Coba lagi ${attempt}/${MAX_QC_TRIES} (cookie baru + proxy)...`);
                monitorProxy();
                await new Promise((r) => setTimeout(r, QC_RETRY_MS));
            }

            // Setiap percobaan ambil cookie berikutnya (index Redis naik).
            // Cookie kadaluarsa tidak dipakai berulang di 3x QC.
            try {
                sesi = await dapatkanSesiCookie();
            } catch (e) {
                console.error(`[SYSTEM-DEMO] âŒ Gagal ambil cookie attempt ${attempt}: ${e.message}`);
                if (attempt >= MAX_QC_TRIES) {
                    console.log(`[SYSTEM-DEMO] âš ï¸ URL Cloudflare DITAHAN.\n`);
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
            console.log(`ðŸŽ‰ [DEMO SUKSES] Percobaan ${attempt}/${MAX_QC_TRIES} â€” sistem sehat.`);
            console.log(`ðŸ¤– Pesan dari ChatGPT: "${hasil.text}"`);

            if (activeUrl) {
                await redis.set('active_gateway_url', activeUrl);
                console.log(`[SYSTEM] ðŸŸ¢ TAUTAN CLOUDFLARE DIBUKA: Vercel dialihkan ke mesin ini.`);
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
                        releaseCookieLease,
                        chatgptModule,
                        MAX_COOKIES,
                    });
                    console.log(`[POOL] QC sukses â€” mengaktifkan pool browser...`);
                    poolBrowser.startPool(folderHasil).catch((e) => console.error('[POOL] start gagal:', e.message));
                } catch (e) {
                    console.error('[POOL] init gagal:', e.message);
                }
            }
            return;
        } catch (error) {
            console.error(`[SYSTEM-DEMO] âŒ Percobaan ${attempt}/${MAX_QC_TRIES} gagal: ${error.message}`);
            if (attempt >= MAX_QC_TRIES) {
                console.log(`[SYSTEM-DEMO] âš ï¸ QC gagal ${MAX_QC_TRIES}x. URL Cloudflare DITAHAN. Codespace lama tetap pegang rute.\n`);
            }
        } finally {
            if (context) await context.close().catch(() => {});
            if (browser) await browser.close().catch(() => {});
            if (sesi && sesi.id) {
                await markCookieSpent(sesi.id);
                releaseCookieLease(sesi.id);
            }
        }
    }
}

async function jalankanProtokolEstafet() {
    console.log(`\n[ESTAFET] â° Waktu shift habis. Memulai protokol rotasi Ping-Pong...`);

    const repoFullName = (
        process.env.CODESPACE_TARGET_REPO ||
        process.env.GITHUB_REPOSITORY ||
        ''
    ).trim();

    if (!repoFullName || !repoFullName.includes('/')) {
        console.error('[ESTAFET] âŒ Set CODESPACE_TARGET_REPO=owner/repo di .env (atau pastikan GITHUB_REPOSITORY ada).');
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
            console.log(`[ESTAFET] â³ Stok PAT kosong / semua ban. Mesin ini TETAP bekerja, menunggu bot_github menambah PAT...`);
            await new Promise(r => setTimeout(r, ESTAFET_WAIT_MS));
            continue;
        }

        nextPat = candidates[0];
        console.log(`[ESTAFET] ðŸ”„ Coba bangunkan penerus dengan PAT: ${nextPat.substring(0, 8)}... (sisa kandidat: ${candidates.length})`);

        try {
            const checkRes = await fetch('https://api.github.com/user/codespaces', {
                headers: ghHeaders(nextPat)
            });
            if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (checkData.codespaces && checkData.codespaces.length > 0) {
                    console.log(`[ESTAFET] ðŸ§¹ Bersihkan ${checkData.codespaces.length} codespace usang...`);
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

            console.log(`[ESTAFET] âœ… Penerus sukses dipesan, sedang booting!`);
            isSuccess = true;

            patShifts[nextPat] = (patShifts[nextPat] || SHIFTS_PER_PAT) - 1;
            await redis.set('pat_shift_quota', patShifts);
            await redis.set('current_active_pat', nextPat.trim());

            if (patShifts[nextPat] <= 0) {
                await redis.lrem('github_pats', 1, nextPat);
                delete patShifts[nextPat];
                await redis.set('pat_shift_quota', patShifts);
                console.log(`[ESTAFET] PAT ${nextPat.substring(0, 8)}... kuota habis â†’ LREM`);
            }
        } catch (err) {
            console.error(`[ESTAFET] âŒ PAT ${nextPat.substring(0, 8)}... gagal dihidupkan: ${err.message}`);
            console.log(`[ESTAFET] âš ï¸ LREM PAT ini dari stok, mesin tetap bekerja, cari pengganti lain...`);
            await redis.lrem('github_pats', 1, nextPat);
            delete patShifts[nextPat];
            await redis.set('pat_shift_quota', patShifts);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    console.log(`[ESTAFET] ðŸ“¡ Menunggu mesin penerus menyelesaikan QC dan mengambil alih rute Cloudflare...`);
    const oldUrl = await redis.get('active_gateway_url');

    const pantauPengambilalihan = setInterval(async () => {
        const currentUrl = await redis.get('active_gateway_url');

        if (currentUrl && currentUrl !== oldUrl) {
            clearInterval(pantauPengambilalihan);
            console.log(`\n[ESTAFET] ðŸ”„ PENGAMBILALIHAN BERHASIL! Rute tugas telah berpindah.`);

            isRetiring = true;
            console.log(`[ESTAFET] ðŸ›‘ Menolak tugas baru. Menunggu ${jumlahTugasAktif} tugas tersisa diselesaikan...`);

            let batasWaktuTunggu = 60;

            const cekSisaTugas = setInterval(async () => {
                batasWaktuTunggu--;
                if (jumlahTugasAktif === 0 || batasWaktuTunggu <= 0) {
                    clearInterval(cekSisaTugas);

                    if (batasWaktuTunggu <= 0) console.log(`[ESTAFET] âš ï¸ Waktu habis! Memaksa pembersihan tugas yang nyangkut.`);
                    console.log(`[ESTAFET] ðŸª¦ Memulai penghancuran diri (Self-Destruct)...`);

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
    console.log(`ðŸš€ API Gateway Camoufox menyala di Port ${PORT}`);
    await loadSpentCookies();

    const rawMyPat = await redis.get('current_active_pat');
    const myPat = (typeof rawMyPat === 'string' ? rawMyPat : '').trim();

    if (!myPat) {
        const first = await redis.lindex('github_pats', 0);
        if (first) await redis.set('current_active_pat', String(first).trim());
    }

    startDeadman(redis);

    console.log(`[SYSTEM] ðŸš‡ Memulai inisiasi Cloudflare Tunnel seketika...`);
    const cloudflaredPath = path.join(__dirname, 'cloudflared');
    try {
        if (!fs.existsSync(cloudflaredPath)) {
            console.log(`[SYSTEM] â¬‡ï¸ Mengunduh Cloudflared...`);
            require('child_process').execSync(`wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O "${cloudflaredPath}" && chmod +x "${cloudflaredPath}"`);
        }

        const cf = spawn(cloudflaredPath, ['tunnel', '--url', `http://localhost:${PORT}`]);
        let urlFound = false;

        cf.stderr.on('data', async (data) => {
            const match = data.toString().match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
            if (match && !urlFound) {
                urlFound = true;
                const activeUrl = match[0];

                console.log(`[SYSTEM] ðŸ”Ž Terowongan Tertangkap: ${activeUrl}`);
                console.log(`[SYSTEM] ðŸ›‘ Menahan publikasi URL ke Vercel sampai QC Test selesai...`);

                const SHIFT_DURATION_MS = parseInt(process.env.SHIFT_DURATION_MS || String(30 * 60 * 1000), 10);
                setTimeout(jalankanProtokolEstafet, SHIFT_DURATION_MS);

                await jalankanDemoAwal(activeUrl);
            }
        });

        cf.on('close', () => {
            if (!urlFound) console.log(`[SYSTEM] âŒ Cloudflare terputus secara tak wajar.`);
        });
    } catch (err) {
        console.error(`[SYSTEM] âŒ Gagal menjalankan Cloudflare:`, err.message);
    }
});
