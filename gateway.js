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
    console.log('[CEK] modul pemeriksa cookie tidak ada:', e.message);
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
// Uji sekarang: proxy dimatikan. Browser memakai internet Codespace.
// geoip=true tanpa proxy = timezone/locale mengikuti IP mesin, bukan IP Cheap Proxy.
// Kembalikan proxy: FORCE_DIRECT=0 lalu restart.
const PAKSA_TANPA_PROXY = String(process.env.FORCE_DIRECT ?? '1') !== '0';

function initialProxyMode() {
    if (PAKSA_TANPA_PROXY) return 'none';
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
    if (PAKSA_TANPA_PROXY) {
        setMode('none', null, `\n[NETWORK] Proxy dimatikan. Internet Codespace, geoip mengikuti IP mesin.`);
        return;
    }
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
    if (!PAKSA_TANPA_PROXY && proxyMode === 'cheap' && CHEAP_PROXY_HOST && CHEAP_PROXY_PORT) {
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
        camoufoxOpts.geoip = true;
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

const MAX_PARALLEL = 5;

/**
 * Index Redis = nomor cookie yang baru saja dipakai tugas (bukan yang baru dicek).
 * Pemeriksa cookie hanya mengisi daftar di memori. Gateway yang menulis index,
 * tepat saat cookie diambil dari depan daftar, sebelum browser tugas dibuka.
 */
async function catatIndexDipakai(index) {
    const n = parseInt(index, 10);
    if (!Number.isFinite(n) || n < 1) return;
    const raw = await redis.get('global_chatgpt_index');
    const cur0 = parseInt(raw, 10);
    const current = Number.isFinite(cur0) && cur0 > 0 ? cur0 : 0;
    if (n > current) {
        await redis.set('global_chatgpt_index', n);
        console.log(`[COOKIE] index ${current} â†’ ${n} (dipakai tugas sekarang)`);
    }
}

function reserveWorker() {
    jumlahTugasAktif++;
}

function releaseWorker() {
    if (jumlahTugasAktif > 0) jumlahTugasAktif--;
    console.log(`[GATEWAY] ðŸ“‰ Tugas selesai. Pekerja Aktif Tersisa: ${jumlahTugasAktif}`);
}

function pasangPemeriksa() {
    if (!poolBrowser || typeof poolBrowser.setDeps !== 'function') return;
    poolBrowser.setDeps({
        redis,
        launchGatewayBrowser,
        chatgptModule,
        MAX_COOKIES,
        getActive: () => jumlahTugasAktif,
        reserveWorker,
        releaseWorker,
        commitIndex: catatIndexDipakai,
    });
}

async function kerjakanDenganBrowserBaru(action, prompt, isThinkingMode, translatedFiles, sesi) {
    let browser = null;
    let context = null;
    try {
        const launched = await launchGatewayBrowser();
        browser = launched.browser;
        context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies(sesi.cookies);
        console.log(`[GATEWAY] browser baru fingerprint baru cookie=${sesi.id}`);
        const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context, {
            cookieId: sesi.id,
        });
        return { hasil, label: launched.label };
    } finally {
        const tutupContext = context;
        const tutupBrowser = browser;
        setImmediate(() => {
            if (tutupContext) tutupContext.close().catch(() => {});
            if (tutupBrowser) tutupBrowser.close().catch(() => {});
        });
    }
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
            healthy: poolBrowser && poolBrowser.snapshot ? poolBrowser.snapshot() : null,
            maxParallel: MAX_PARALLEL,
            activeWorkers: jumlahTugasAktif,
        });
    } catch (e) {
        res.json({ status: 'ok', proxyMode, activeWorkers: jumlahTugasAktif });
    }
});

app.post('/api/generate', async (req, res) => {
    if (isRetiring) return res.status(503).json({ error: "Sistem estafet aktif. Silakan request ulang." });

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

    let reserved = false;
    try {
        if (!poolBrowser || typeof poolBrowser.takeNext !== 'function') {
            throw new Error('pemeriksa cookie belum siap');
        }
        const activeUrl = await redis.get('active_gateway_url') || `http://localhost:${PORT}`;
        const sesi = await poolBrowser.takeNext();
        reserved = true;
        console.log(`[GATEWAY] tugas memakai ${sesi.id} â€” daftar sehat tersisa dicek ulang di [CEK]`);
        const out = await kerjakanDenganBrowserBaru(action, prompt, isThinkingMode, translatedFiles, sesi);
        res.json({
            status: 'success',
            worker: sesi.id,
            network: out.label,
            text: out.hasil.text,
            fileUrls: (out.hasil.files || []).map(f => `${activeUrl}/files/${f}`),
        });
    } catch (error) {
        console.error(`[GATEWAY] âŒ TUGAS GAGAL: ${error.message}`);
        if (!res.headersSent) res.status(500).json({ status: 'failed', error: error.message });
    } finally {
        if (reserved && poolBrowser && typeof poolBrowser.releaseWorker === 'function') poolBrowser.releaseWorker();
        translatedFiles.forEach(file => { if (fs.existsSync(file)) fs.unlinkSync(file); });
    }
});

async function publikasikanSaatSatuSehat(activeUrl) {
    console.log(`\n[SYSTEM] Menunggu 1 cookie sehat, lalu tautan Cloudflare dipublikasikan. Tanpa tes chat.`);
    const batas = Date.now() + 20 * 60 * 1000;
    while (Date.now() < batas) {
        const snap = poolBrowser && typeof poolBrowser.snapshot === 'function' ? poolBrowser.snapshot() : null;
        const pertama = snap && Array.isArray(snap.list) ? snap.list[0] : null;
        if (pertama) {
            await redis.set('active_gateway_url', activeUrl);
            console.log(`[SYSTEM] 🟢 TAUTAN CLOUDFLARE DIBUKA. Slot 1 = cookie #${pertama}. Vercel dialihkan ke mesin ini.`);
            return;
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    console.log(`[SYSTEM] ⚠️ Belum ada cookie sehat. URL Cloudflare DITAHAN. Codespace lama tetap pegang rute.\n`);
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

    console.log(`[ESTAFET] 📡 Menunggu mesin penerus mempublikasikan tautan Cloudflare...`);
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
    pasangPemeriksa();
    if (poolBrowser && typeof poolBrowser.start === 'function') {
        poolBrowser.start(folderHasil).catch((e) => console.error('[CEK] start gagal:', e.message));
    }

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

                console.log(`[SYSTEM] 🔍 Terowongan Tertangkap: ${activeUrl}`);
                console.log(`[SYSTEM] 🛑 Menahan publikasi sampai ada 1 cookie sehat...`);

                const SHIFT_DURATION_MS = parseInt(process.env.SHIFT_DURATION_MS || String(30 * 60 * 1000), 10);
                setTimeout(jalankanProtokolEstafet, SHIFT_DURATION_MS);

                await publikasikanSaatSatuSehat(activeUrl);
            }
        });

        cf.on('close', () => {
            if (!urlFound) console.log(`[SYSTEM] âŒ Cloudflare terputus secara tak wajar.`);
        });
    } catch (err) {
        console.error(`[SYSTEM] âŒ Gagal menjalankan Cloudflare:`, err.message);
    }
});
