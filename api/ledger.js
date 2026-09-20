/* 旅行记账本 —— 唯一的后端接口
 *
 * 同一个文件两种跑法：
 *   - Vercel：当成 Serverless Function（/api/ledger）
 *   - Render / 本地：server.js 直接 import 这里的 handler 起一个长驻服务
 *
 * 数据存在 Postgres（Neon），没配 DATABASE_URL 时会退到内存，
 * 内存模式仅供本地试玩，重启即丢，接口会在 ping 里明确告知。
 */

const MAX_SNAPSHOTS = 5;   // 每个账本保留的历史版本数
const MAX_BYTES = 2 * 1024 * 1024;

let mode = null;           // 'neon' | 'memory'
let sql = null;
const mem = { ledgers: new Map(), snaps: [], seq: 1 };

async function init() {
  if (mode) return mode;
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) { mode = 'memory'; return mode; }
  const mod = await import('@neondatabase/serverless');
  sql = mod.neon(url);
  await sql`SELECT 1`;
  mode = 'neon';
  return mode;
}
function dbMode() { return mode || ((process.env.DATABASE_URL || '').trim() ? 'neon' : 'memory'); }

/* ---------------- 存储层：neon / memory 两套实现 ---------------- */

async function getLedger(id) {
  if (mode === 'neon') {
    const rows = await sql`SELECT data FROM ledgers WHERE id = ${id} LIMIT 1`;
    return rows.length ? rows[0].data : null;
  }
  return mem.ledgers.has(id) ? mem.ledgers.get(id) : null;
}

async function putLedger(id, data, exists) {
  const now = Date.now();
  const raw = JSON.stringify(data);
  if (mode === 'neon') {
    if (exists) await sql`UPDATE ledgers SET data = ${raw}::jsonb, updated_at = ${now} WHERE id = ${id}`;
    else await sql`INSERT INTO ledgers (id, data, updated_at) VALUES (${id}, ${raw}::jsonb, ${now})`;
    return;
  }
  mem.ledgers.set(id, data);
}

async function addSnapshot(id, data) {
  const now = Date.now();
  const raw = JSON.stringify(data);
  if (mode === 'neon') {
    await sql`INSERT INTO ledger_snapshots (ledger_id, data, saved_at) VALUES (${id}, ${raw}::jsonb, ${now})`;
    return;
  }
  mem.snaps.push({ id: mem.seq++, ledger_id: id, data: data, saved_at: now });
}

async function trimSnapshots(id, keep) {
  if (mode === 'neon') {
    await sql`
      DELETE FROM ledger_snapshots s
      USING (
        SELECT id, row_number() OVER (ORDER BY saved_at DESC, id DESC) AS rn
        FROM ledger_snapshots WHERE ledger_id = ${id}
      ) t
      WHERE s.id = t.id AND t.rn > ${keep}`;
    return;
  }
  const own = mem.snaps.filter(s => s.ledger_id === id)
    .sort((a, b) => (b.saved_at - a.saved_at) || (b.id - a.id));
  const drop = new Set(own.slice(keep).map(s => s.id));
  mem.snaps = mem.snaps.filter(s => !drop.has(s.id));
}

async function listSnapshots(id, limit) {
  if (mode === 'neon') {
    return await sql`
      SELECT id, saved_at, data FROM ledger_snapshots
      WHERE ledger_id = ${id} ORDER BY saved_at DESC, id DESC LIMIT ${limit}`;
  }
  return mem.snaps.filter(s => s.ledger_id === id)
    .sort((a, b) => (b.saved_at - a.saved_at) || (b.id - a.id))
    .slice(0, limit);
}

async function getSnapshot(ledgerId, snapId) {
  if (mode === 'neon') {
    const rows = await sql`
      SELECT data FROM ledger_snapshots WHERE id = ${snapId} AND ledger_id = ${ledgerId} LIMIT 1`;
    return rows.length ? rows[0].data : null;
  }
  const s = mem.snaps.find(x => x.id === snapId && x.ledger_id === ledgerId);
  return s ? s.data : null;
}

async function countSnapshots(id) {
  if (mode === 'neon') {
    const rows = await sql`SELECT count(*)::int AS n FROM ledger_snapshots WHERE ledger_id = ${id}`;
    return rows.length ? rows[0].n : 0;
  }
  return mem.snaps.filter(s => s.ledger_id === id).length;
}

/* ---------------- 工具 ---------------- */

function sanitize(d, code) {
  const out = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
  out.v = 1;
  out.code = code;
  if (!Array.isArray(out.members)) out.members = [];
  if (!Array.isArray(out.expenses)) out.expenses = [];
  return out;
}

/* 显示成北京时间，避免服务器时区造成的困惑 */
function fmtTime(ts) {
  return new Date(Number(ts) + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
function visibleCount(d) {
  const es = (d && Array.isArray(d.expenses)) ? d.expenses : [];
  return es.filter(e => !e || !e.deleted).length;
}
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

/* ---------------- 业务：口令校验 + 各操作 ---------------- */

async function check(id, code) {
  const cur = await getLedger(id);
  if (!cur) return { err: 'not_found' };
  if (String(cur.code || '').toUpperCase() !== code) return { err: 'bad_code' };
  return { cur: cur };
}

async function dispatch(body) {
  const op = String(body.op || '');
  const id = String(body.id || '').trim();
  const code = String(body.code || '').trim().toUpperCase();

  if (op === 'ping') return { ok: true, db: dbMode(), keep: MAX_SNAPSHOTS };
  if (!op) return { ok: false, err: 'no_op' };
  if (!id || !code) return { ok: false, err: 'bad_input' };

  if (op === 'create') {
    if (await getLedger(id)) return { ok: false, err: 'exists' };
    await putLedger(id, sanitize(body.data, code), false);
    return { ok: true };
  }

  if (op === 'load') {
    const r = await check(id, code);
    if (r.err) return { ok: false, err: r.err };
    return { ok: true, data: r.cur };
  }

  if (op === 'save') {
    const r = await check(id, code);
    if (r.err) return { ok: false, err: r.err };
    if (JSON.stringify(body.data || {}).length > MAX_BYTES) return { ok: false, err: 'bad_input' };
    await addSnapshot(id, r.cur);
    await putLedger(id, sanitize(body.data, code), true);
    await trimSnapshots(id, MAX_SNAPSHOTS);
    return { ok: true };
  }

  if (op === 'history') {
    const r = await check(id, code);
    if (r.err) return { ok: false, err: r.err };
    const rows = await listSnapshots(id, 20);
    return {
      ok: true,
      items: rows.map(x => ({
        id: x.id, at: fmtTime(x.saved_at),
        n: visibleCount(x.data), name: x.data && x.data.name
      }))
    };
  }

  if (op === 'restore') {
    const r = await check(id, code);
    if (r.err) return { ok: false, err: r.err };
    const snapId = Number(body.snap);
    if (!snapId) return { ok: false, err: 'bad_input' };
    const snap = await getSnapshot(id, snapId);
    if (!snap) return { ok: false, err: 'not_found' };
    await addSnapshot(id, r.cur);      // 先把当前也存一份，恢复本身不会丢东西
    await putLedger(id, sanitize(snap, code), true);
    await trimSnapshots(id, MAX_SNAPSHOTS);
    return { ok: true, data: snap };
  }

  if (op === 'prune') {
    const r = await check(id, code);
    if (r.err) return { ok: false, err: r.err };
    const keep = clamp(Number(body.keep) || MAX_SNAPSHOTS, 0, 50);
    const had = await countSnapshots(id);
    await trimSnapshots(id, keep);
    const kept = await countSnapshots(id);
    return { ok: true, had: had, deleted: Math.max(0, had - kept), kept: kept };
  }

  return { ok: false, err: 'no_op' };
}

/* ---------------- HTTP 入口 ---------------- */

async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
    if (typeof req.body === 'object') return req.body;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, err: 'no_op', message: '请用 POST' });
    return;
  }
  try {
    await init();
  } catch (e) {
    res.status(200).json({ ok: false, err: 'no_db', message: String((e && e.message) || e).slice(0, 200) });
    return;
  }
  let body = {};
  try { body = await readJson(req); } catch (e) { body = {}; }
  try {
    res.status(200).json(await dispatch(body));
  } catch (e) {
    res.status(200).json({ ok: false, err: 'server_error', message: String((e && e.message) || e).slice(0, 200) });
  }
}
