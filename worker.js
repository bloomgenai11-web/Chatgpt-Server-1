/**
 * Cloudflare Worker — worker.js  (versi ua-3-work)
 * WORK EKOSISTEM — selaras bot_github (SHIFTS_PER_PAT default 24) + gateway deadman.
 *
 * Deploy: Cloudflare Workers (bukan Codespace runtime).
 * Secrets wajib di dashboard CF:
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   CODESPACE_TARGET_REPO   (owner/repo)
 * Opsional:
 *   SHIFTS_PER_PAT          (default 24 — sama bot/gateway)
 *
 * Endpoint:
 *   GET  /         → spawn worker ok | ua-3-work
 *   GET  /ua-test  → tes GitHub + User-Agent
 *   POST /spawn    → emergency create Codespace (dipanggil QStash deadman)
 *
 * Redis keys (sama ekosistem):
 *   github_pats (LIST), current_active_pat, pat_shift_quota
 *
 * JANGAN LREM current dulu kalau itu PAT terakhir — dipakai untuk spawn.
 * LREM current lama hanya setelah PAT LAIN sukses, atau 401.
 */

const VERSION = 'ua-3-work';

function ghHeaders(pat) {
  const h = new Headers();
  h.set('Accept', 'application/vnd.github+json');
  h.set('X-GitHub-Api-Version', '2022-11-28');
  h.set('User-Agent', 'github-spawn-1/ua-3-work');
  if (pat) h.set('Authorization', 'Bearer ' + pat);
  return h;
}

async function redisCmd(env, ...cmd) {
  const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cmd),
  });
  const data = await res.json();
  if (data.error) throw new Error('Redis: ' + data.error);
  return data.result;
}

function asString(v) {
  if (v == null) return '';
  return String(v).trim();
}

function parseQuota(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

async function dropPat(env, pat, quota, removed) {
  if (!pat) return quota;
  await redisCmd(env, 'LREM', 'github_pats', '1', pat);
  if (quota[pat] !== undefined) {
    delete quota[pat];
    await redisCmd(env, 'SET', 'pat_shift_quota', JSON.stringify(quota));
  }
  if (removed) removed.push(pat.substring(0, 12) + '...');
  return quota;
}

async function readBody(res) {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

async function createCodespace(pat, repoFullName) {
  const h = ghHeaders(pat);

  const listRes = await fetch('https://api.github.com/user/codespaces', { headers: h });
  if (listRes.status === 401) {
    return { ok: false, remove: true, status: 401, message: 'list 401 ' + (await readBody(listRes)) };
  }
  if (listRes.status === 403) {
    return { ok: false, remove: false, status: 403, message: 'list 403 ' + (await readBody(listRes)) };
  }
  if (listRes.ok) {
    const data = await listRes.json();
    const list = data.codespaces || [];
    for (let i = 0; i < list.length; i++) {
      await fetch('https://api.github.com/user/codespaces/' + list[i].name, {
        method: 'DELETE',
        headers: h,
      }).catch(function () {});
    }
  }

  const repoRes = await fetch('https://api.github.com/repos/' + repoFullName, { headers: h });
  if (repoRes.status === 401) {
    return { ok: false, remove: true, status: 401, message: 'repo 401 ' + (await readBody(repoRes)) };
  }
  if (repoRes.status === 403) {
    return { ok: false, remove: false, status: 403, message: 'repo 403 ' + (await readBody(repoRes)) };
  }
  if (!repoRes.ok) {
    return {
      ok: false,
      remove: false,
      status: repoRes.status,
      message: 'repo HTTP ' + repoRes.status + ' ' + (await readBody(repoRes)),
    };
  }
  const repo = await repoRes.json();

  const createH = ghHeaders(pat);
  createH.set('Content-Type', 'application/json');
  const createRes = await fetch('https://api.github.com/user/codespaces', {
    method: 'POST',
    headers: createH,
    body: JSON.stringify({
      repository_id: repo.id,
      idle_timeout_minutes: 240,
    }),
  });
  if (createRes.status === 401) {
    return { ok: false, remove: true, status: 401, message: 'create 401 ' + (await readBody(createRes)) };
  }
  if (createRes.status === 403) {
    return { ok: false, remove: false, status: 403, message: 'create 403 ' + (await readBody(createRes)) };
  }
  if (!createRes.ok) {
    return {
      ok: false,
      remove: false,
      status: createRes.status,
      message: 'create HTTP ' + createRes.status + ' ' + (await readBody(createRes)),
    };
  }
  const cs = await createRes.json();
  return { ok: true, codespace: cs.name || null };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '')) {
      return new Response('spawn worker ok | ' + VERSION, { status: 200 });
    }

    if (request.method === 'GET' && url.pathname === '/ua-test') {
      const res = await fetch('https://api.github.com/zen', { headers: ghHeaders(null) });
      const text = await res.text();
      return Response.json({
        worker: VERSION,
        github_status: res.status,
        github_body: text.slice(0, 200),
        ok_if_200: res.status === 200,
      });
    }

    if (request.method !== 'POST' || url.pathname !== '/spawn') {
      return new Response('not found', { status: 404 });
    }

    const repo = (env.CODESPACE_TARGET_REPO || '').trim();
    if (!repo.includes('/')) {
      return Response.json(
        { ok: false, worker: VERSION, error: 'CODESPACE_TARGET_REPO secret belum di-set (owner/repo)' },
        { status: 500 }
      );
    }

    let body = {};
    try {
      const ct = request.headers.get('content-type') || '';
      if (ct.includes('json')) body = await request.json();
    } catch (_) {}

    const dry = body.dry === true || url.searchParams.get('dry') === '1';
    const skipDropCurrent = body.skip_drop_current === true;

    const llen = Number(await redisCmd(env, 'LLEN', 'github_pats')) || 0;
    const current = asString(await redisCmd(env, 'GET', 'current_active_pat'));
    const newestPeek = asString(await redisCmd(env, 'LINDEX', 'github_pats', '-1'));

    if (dry) {
      return Response.json({
        ok: true,
        worker: VERSION,
        dry: true,
        repo,
        llen,
        current_prefix: current ? current.substring(0, 12) + '...' : null,
        newest_prefix: newestPeek ? newestPeek.substring(0, 12) + '...' : null,
        note: 'Tidak ada mutasi.',
      });
    }

    let quota = parseQuota(await redisCmd(env, 'GET', 'pat_shift_quota'));
    const removed = [];
    const skipped = [];
    const errors = [];

    let pats = await redisCmd(env, 'LRANGE', 'github_pats', '0', '-1');
    if (!Array.isArray(pats)) pats = [];
    pats = pats.map(asString).filter(Boolean);

    // Urutan: PAT paling baru dulu, KECUALI current. Current dicoba TERAKHIR
    // supaya stok 1 (current = satu-satunya PAT) tetap bisa spawn.
    const order = [];
    for (let i = pats.length - 1; i >= 0; i--) {
      if (pats[i] !== current) order.push(pats[i]);
    }
    if (current && pats.indexOf(current) !== -1) order.push(current);

    if (order.length === 0) {
      await redisCmd(env, 'SET', 'current_active_pat', '');
      return Response.json(
        { ok: false, worker: VERSION, reason: 'stok_kosong', llen_sisa: 0 },
        { status: 503 }
      );
    }

    for (let i = 0; i < order.length; i++) {
      const pat = order[i];
      const result = await createCodespace(pat, repo);

      if (result.ok) {
        const defaultShifts = parseInt(env.SHIFTS_PER_PAT || '24', 10);
        const left = (quota[pat] === undefined ? defaultShifts : Number(quota[pat])) - 1;
        quota[pat] = left;
        await redisCmd(env, 'SET', 'pat_shift_quota', JSON.stringify(quota));
        await redisCmd(env, 'SET', 'current_active_pat', pat);
        if (!skipDropCurrent && current && current !== pat) {
          quota = await dropPat(env, current, quota, removed);
        }
        if (left <= 0) quota = await dropPat(env, pat, quota, removed);
        return Response.json({
          ok: true,
          worker: VERSION,
          codespace: result.codespace,
          pat_prefix: pat.substring(0, 12) + '...',
          removed_401_or_old_current: removed,
          skipped_403: skipped,
        });
      }

      errors.push({
        pat_prefix: pat.substring(0, 12) + '...',
        status: result.status,
        message: result.message,
        removed: !!result.remove,
      });

      if (result.remove) {
        quota = await dropPat(env, pat, quota, removed);
        continue;
      }

      skipped.push({
        pat_prefix: pat.substring(0, 12) + '...',
        status: result.status,
        message: result.message,
      });
    }

    const left = Number(await redisCmd(env, 'LLEN', 'github_pats')) || 0;
    return Response.json(
      {
        ok: false,
        worker: VERSION,
        reason: left === 0 ? 'stok_kosong' : 'tidak_ada_pat_yang_berhasil',
        llen_sisa: left,
        removed_401_or_old_current: removed,
        skipped_403: skipped,
        errors,
      },
      { status: 503 }
    );
  },
};