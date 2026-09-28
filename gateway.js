const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { Camoufox } = require('camoufox-js');
const { Redis } = require('@upstash/redis');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const chatgptModule = require('./platforms/chatgpt');

const xvfb = spawn('Xvfb', [':99', '-screen', '0', '1280x800x24']);
process.env.DISPLAY = ':99';

const PROXY_HOST = process.env.PROXY_HOST || '';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '0', 10);
const PROXY_VERSION = parseInt(process.env.PROXY_VERSION || '5', 10);

const STATIC_PROXY_HOST = process.env.STATIC_PROXY_HOST || '';
const STATIC_PROXY_PORT = parseInt(process.env.STATIC_PROXY_PORT || '0', 10);
const STATIC_PROXY_USER = process.env.STATIC_PROXY_USER || '';
const STATIC_PROXY_PASS = process.env.STATIC_PROXY_PASS || '';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const { startDeadman } = require('./qstash_deadman');

const MAX_COOKIES = 150;
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
// RADAR PROXY
// Pola sistem awal: Camoufox SOCKS HANYA via firefoxUserPrefs.
// JANGAN kirim opsi `proxy:` Playwright untuk SOCKS — itu yang memicu
// Firefox "Unable to find the proxy server".
// Start optimistic (seperti isProxyHealthy = true di sistem awal).
// =====================================================================
let proxyMode = PROXY_HOST && PROXY_PORT ? 'primary' : (STATIC_PROXY_HOST && STATIC_PROXY_PORT ? 'static' : 'none');

function curlViaProxy(proxyUrl, cb) {
    exec(`curl -s --max-time 12 -x "${proxyUrl}" https://api.ipify.org`, (error, stdout) => {
        if (error || !stdout || !String(stdout).trim()) cb(null);
        else cb(String(stdout).trim());
    });
}

function monitorProxy() {
    if (PROXY_HOST && PROXY_PORT) {
        const primaryUrl = `socks5h://${PROXY_HOST}:${PROXY_PORT}`;
        return curlViaProxy(primaryUrl, (ip) => {
            if (ip) {
                if (proxyMode !== 'primary') {
                    console.log(`\n[NETWORK] ✅ PROXY PULIH! SOCKS5 Aktif (IP: ${ip}).`);
                }
                proxyMode = 'primary';
                redis.set('proxy_healthy', '1').catch(() => {});
                redis.set('proxy_current_ip', ip).catch(() => {});
                redis.set('proxy_mode', 'primary').catch(() => {});
                return;
            }
            tryStaticFallback();
        });
    }
    tryStaticFallback();
}

function tryStaticFallback() {
    if (!STATIC_PROXY_HOST || !STATIC_PROXY_PORT) {
        if (proxyMode !== 'none') {
            console.log(`\n[NETWORK] ⚠️ PROXY MATI! Rute dialihkan ke jaringan lokal Codespace.`);
        }
        proxyMode = 'none';
        redis.set('proxy_healthy', '0').catch(() => {});
        redis.set('proxy_mode', 'none').catch(() => {});
        return;
    }
    const auth = STATIC_PROXY_USER
        ? `${STATIC_PROXY_USER}:${STATIC_PROXY_PASS}@`
        : '';
    const staticUrl = `http://${auth}${STATIC_PROXY_HOST}:${STATIC_PROXY_PORT}`;
    curlViaProxy(staticUrl, (ip) => {
        if (ip) {
            if (proxyMode !== 'static') {
                console.log(`\n[NETWORK] ⚠️ localtonet mati → STATIC Webshare ON (IP: ${ip})`);
            }
            proxyMode = 'static';
            redis.set('proxy_healthy', '1').catch(() => {});
            redis.set('proxy_current_ip', ip).catch(() => {});
            redis.set('proxy_mode', 'static').catch(() => {});
        } else {
            if (proxyMode !== 'none') {
                console.log(`\n[NETWORK] ⚠️ PROXY MATI! Rute dialihkan ke jaringan lokal Codespace.`);
            }
            proxyMode = 'none';
            redis.set('proxy_healthy', '0').catch(() => {});
            redis.set('proxy_mode', 'none').catch(() => {});
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
 * Launch Camoufox seperti sistem awal.
 * primary SOCKS: firefoxUserPrefs saja (tanpa proxy:)
 * static HTTP+auth: opsi proxy Playwright saja (Firefox prefs tidak support HTTP auth)
 * none: network.proxy.type = 0 (direct)
 */
async function launchGatewayBrowser() {
    const prefs = { ...CAMOUFOX_BASE_PREFS };
    let label = 'Local';
    let gunakanProxy = false;
    const camoufoxOpts = {
        headless: true,
        width: 1280,
        height: 720,
    };

    if (proxyMode === 'primary' && PROXY_HOST && PROXY_PORT) {
        Object.assign(prefs, {
            'network.proxy.type': 1,
            'network.proxy.socks': PROXY_HOST,
            'network.proxy.socks_port': PROXY_PORT,
            'network.proxy.socks_version': PROXY_VERSION || 5,
            'network.proxy.socks_remote_dns': true,
            'network.dns.disableIPv6': true,
        });
        camoufoxOpts.geoip = true;
        camoufoxOpts.firefoxUserPrefs = prefs;
        label = 'Proxy';
        gunakanProxy = true;
    } else if (proxyMode === 'static' && STATIC_PROXY_HOST && STATIC_PROXY_PORT) {
        camoufoxOpts.geoip = true;
        camoufoxOpts.firefoxUserPrefs = prefs;
        camoufoxOpts.proxy = {
            server: `http://${STATIC_PROXY_HOST}:${STATIC_PROXY_PORT}`,
        };
        if (STATIC_PROXY_USER) camoufoxOpts.proxy.username = STATIC_PROXY_USER;
        if (STATIC_PROXY_PASS) camoufoxOpts.proxy.password = STATIC_PROXY_PASS;
        label = 'Static';
        gunakanProxy = true;
    } else {
        prefs['network.proxy.type'] = 0;
        camoufoxOpts.geoip = false;
        camoufoxOpts.firefoxUserPrefs = prefs;
        label = 'Local';
        gunakanProxy = false;
    }

    const browser = await Camoufox(camoufoxOpts);
    return { browser, label, gunakanProxy };
}

setInterval(monitorProxy, 30000);
monitorProxy();

let isRetiring = false;
let jumlahTugasAktif = 0;

async function dapatkanSesiCookie() {
    let index = await redis.incr('global_chatgpt_index');
    if (index > MAX_COOKIES) {
        await redis.set('global_chatgpt_index', 1);
        index = 1;
    }
    const cookieKey = `cookie_chatgpt_${index}`;
    const rawData = await redis.get(cookieKey);
    if (!rawData) throw new Error(`[REDIS] Data tidak ditemukan: ${cookieKey}`);

    const formattedCookies = Object.entries(rawData).map(([key, value]) => ({
        name: key, value: String(value), domain: '.chatgpt.com', path: '/', secure: true, sameSite: 'Lax'
    }));

    return { id: cookieKey, cookies: formattedCookies };
}

app.post('/api/generate', async (req, res) => {
    if (isRetiring) return res.status(503).json({ error: "Sistem estafet aktif. Silakan request ulang." });

    jumlahTugasAktif++;

    const { action = 'CHAT', prompt, isThinkingMode = false, fileArray = [] } = req.body;
    let translatedFiles = [];

    if (fileArray && fileArray.length > 0) {
        fileArray.forEach((fileObj, index) => {
            const matches = fileObj.base64.match(/^data:(.+);base64,(.+)$/);
            if (matches && matches.length === 3) {
                const buffer = Buffer.from(matches[2], 'base64');
                let originalExt = path.extname(fileObj.name);
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
        const sesi = await dapatkanSesiCookie();
        console.log(`[GATEWAY] 🚀 Meluncurkan tugas | Pekerja Aktif: ${jumlahTugasAktif} | Akun: ${sesi.id} | net=${proxyMode}`);

        const launched = await launchGatewayBrowser();
        browser = launched.browser;
        context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies(sesi.cookies);

        const hasil = await chatgptModule.eksekusiChatGPT(action, prompt, isThinkingMode, translatedFiles, folderHasil, context);

        const activeUrl = await redis.get('active_gateway_url') || `http://localhost:${PORT}`;
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
    console.log(`\n[SYSTEM-DEMO] 🚀 Memulai tes Quality Control (Demo Request) ke ChatGPT...`);
    let browser, context;
    try {
        const sesi = await dapatkanSesiCookie();
        const launched = await launchGatewayBrowser();
        browser = launched.browser;
        console.log(`[SYSTEM-DEMO] net=${launched.label} mode=${proxyMode}`);

        context = await browser.newContext({ acceptDownloads: true });
        await context.addCookies(sesi.cookies);

        const promptDemo = 'Berikan satu kalimat sapaan selamat datang yang sangat lucu, sedikit nyeleneh, dan penuh semangat untuk Bosku.';
        const hasil = await chatgptModule.eksekusiChatGPT('CHAT', promptDemo, false, [], folderHasil, context);

        console.log(`\n======================================================`);
        console.log(`🎉 [DEMO SUKSES] Sistem Otomasi 100% Sehat!`);
        console.log(`🤖 Pesan dari ChatGPT: "${hasil.text}"`);

        if (activeUrl) {
            await redis.set('active_gateway_url', activeUrl);
            console.log(`[SYSTEM] 🟢 TAUTAN CLOUDFLARE DIBUKA: Vercel sekarang dialihkan ke mesin ini!`);
        }
        console.log(`======================================================\n`);
    } catch (error) {
        console.error(`\n[SYSTEM-DEMO] ❌ Gagal menjalankan tes QC: ${error.message}`);
        console.log(`[SYSTEM-DEMO] ⚠️ URL Cloudflare DITAHAN. Codespace lama masih memegang kendali rute.\n`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
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
            if (patShifts[pat] === undefined) patShifts[pat] = 4;
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
                headers: { Authorization: `Bearer ${nextPat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            });
            if (checkRes.ok) {
                const checkData = await checkRes.json();
                if (checkData.codespaces && checkData.codespaces.length > 0) {
                    console.log(`[ESTAFET] 🧹 Bersihkan ${checkData.codespaces.length} codespace usang...`);
                    for (let cs of checkData.codespaces) {
                        await fetch(`https://api.github.com/user/codespaces/${cs.name}`, {
                            method: 'DELETE',
                            headers: { Authorization: `Bearer ${nextPat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
                        });
                    }
                }
            }

            const repoRes = await fetch(`https://api.github.com/repos/${repoFullName}`, {
                headers: { Authorization: `Bearer ${nextPat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
            });
            if (!repoRes.ok) throw new Error('Gagal akses Repo. PAT flagged/dicabut atau tidak bisa dihidupkan.');
            const repoData = await repoRes.json();

            const createRes = await fetch('https://api.github.com/user/codespaces', {
                method: 'POST',
                headers: { Authorization: `Bearer ${nextPat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
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

            patShifts[nextPat] = (patShifts[nextPat] || 4) - 1;
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
                                headers: { Authorization: `Bearer ${myPat}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
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
