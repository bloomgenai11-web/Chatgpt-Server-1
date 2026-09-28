/**
 * qstash_deadman.js
 * Gateway: const { startDeadman } = require('./qstash_deadman');
 *
 * Nama file HARUS qstash_deadman.js (bukan qtash_...).
 *
 * Delay 4 menit. Reset (cancel + publish) tiap 3,5 menit.
 */

function cleanToken(raw) {
  return String(raw || '')
    .trim()
    .replace(/^QSTASH_TOKEN\s*=\s*/i, '')
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

const QSTASH_URL = (process.env.QSTASH_URL || 'https://qstash.upstash.io').replace(/\/$/, '');
const QSTASH_TOKEN = cleanToken(process.env.QSTASH_TOKEN);
const WATCHDOG_URL = (process.env.WATCHDOG_URL || '').replace(/\/$/, '');
const DELAY = process.env.QSTASH_DELAY || '4m';
const RESET_MS = parseInt(process.env.QSTASH_RESET_MS || String(3.5 * 60 * 1000), 10);

function destUrl() {
  if (!WATCHDOG_URL) return '';
  return WATCHDOG_URL.endsWith('/spawn') ? WATCHDOG_URL : `${WATCHDOG_URL}/spawn`;
}

async function cancelMessage(id) {
  if (!id) return;
  const res = await fetch(`${QSTASH_URL}/v2/messages/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${QSTASH_TOKEN}` },
  }).catch(() => null);
  if (res && !res.ok && res.status !== 404) {
    const t = await res.text().catch(() => '');
    console.log(`[DEADMAN] cancel HTTP ${res.status} ${t.slice(0, 160)}`);
  }
}

async function publishDeadman() {
  const dest = destUrl();
  if (!dest) throw new Error('WATCHDOG_URL kosong');
  const url = `${QSTASH_URL}/v2/publish/${dest}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': DELAY,
      'Upstash-Retries': '1',
      'Upstash-Method': 'POST',
    },
    body: JSON.stringify({ reason: 'deadman', ts: Date.now() }),
  });
  const raw = await res.text();
  let data = {};
  try { data = JSON.parse(raw); } catch { data = { raw }; }
  if (!res.ok) {
    throw new Error(`QStash HTTP ${res.status} ${raw.slice(0, 240)}`);
  }
  const id = data.messageId || data.message_id;
  if (!id) throw new Error('QStash tidak mengembalikan messageId: ' + raw.slice(0, 200));
  return id;
}

async function resetDeadman(redis) {
  if (!QSTASH_TOKEN || !WATCHDOG_URL) {
    console.log('[DEADMAN] Skip: QSTASH_TOKEN / WATCHDOG_URL belum di .env');
    return;
  }
  if (QSTASH_TOKEN.includes('QSTASH_TOKEN=') || QSTASH_TOKEN.startsWith('"')) {
    console.log('[DEADMAN] Token masih format rusak. Di .env harus: QSTASH_TOKEN=eyJ...  (tanpa nama variabel diulang, tanpa kutip)');
  }
  const oldId = await redis.get('qstash_deadman_id');
  if (oldId) await cancelMessage(String(oldId));
  const id = await publishDeadman();
  await redis.set('qstash_deadman_id', id);
  console.log(`[DEADMAN] OK countdown ${DELAY} id=${id} dest=${destUrl()}`);
}

function startDeadman(redis) {
  console.log(`[DEADMAN] init url=${QSTASH_URL} token_len=${QSTASH_TOKEN.length} dest=${destUrl() || '(kosong)'}`);
  resetDeadman(redis).catch((e) => console.error('[DEADMAN]', e.message));
  setInterval(() => {
    resetDeadman(redis).catch((e) => console.error('[DEADMAN]', e.message));
  }, RESET_MS);
}

module.exports = { startDeadman, resetDeadman };
