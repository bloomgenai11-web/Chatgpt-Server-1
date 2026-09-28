/**
 * qstash_deadman.js
 * Dipanggil dari gateway.js:
 *   const { startDeadman } = require('./qstash_deadman');
 *   startDeadman(redis);
 *
 * Delay 4 menit. Reset (cancel + publish baru) tiap 3,5 menit.
 * ~822 pesan QStash/hari → muat free 1000.
 */

const QSTASH_URL = (process.env.QSTASH_URL || '').replace(/\/$/, '');
const QSTASH_TOKEN = process.env.QSTASH_TOKEN || '';
const WATCHDOG_URL = (process.env.WATCHDOG_URL || '').replace(/\/$/, '');
const DELAY = process.env.QSTASH_DELAY || '4m';
const RESET_MS = parseInt(process.env.QSTASH_RESET_MS || String(3.5 * 60 * 1000), 10);

async function cancelMessage(id) {
  if (!id) return;
  await fetch(`${QSTASH_URL}/v2/messages/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${QSTASH_TOKEN}` },
  }).catch(() => {});
}

async function publishDeadman() {
  const dest = WATCHDOG_URL.endsWith('/spawn') ? WATCHDOG_URL : `${WATCHDOG_URL}/spawn`;
  const res = await fetch(`${QSTASH_URL}/v2/publish/${dest}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${QSTASH_TOKEN}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': DELAY,
      'Upstash-Retries': '1',
    },
    body: JSON.stringify({ reason: 'deadman', ts: Date.now() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `QStash HTTP ${res.status}`);
  return data.messageId;
}

async function resetDeadman(redis) {
  if (!QSTASH_URL || !QSTASH_TOKEN || !WATCHDOG_URL) {
    console.log('[DEADMAN] Skip: QSTASH_URL / QSTASH_TOKEN / WATCHDOG_URL belum di .env');
    return;
  }
  const oldId = await redis.get('qstash_deadman_id');
  if (oldId) await cancelMessage(String(oldId));
  const id = await publishDeadman();
  if (id) await redis.set('qstash_deadman_id', id);
  console.log(`[DEADMAN] Hitung mundur ${DELAY} dimulai ulang (id=${id})`);
}

function startDeadman(redis) {
  resetDeadman(redis).catch((e) => console.error('[DEADMAN]', e.message));
  setInterval(() => {
    resetDeadman(redis).catch((e) => console.error('[DEADMAN]', e.message));
  }, RESET_MS);
}

module.exports = { startDeadman, resetDeadman };
