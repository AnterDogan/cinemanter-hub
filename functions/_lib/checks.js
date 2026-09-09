// Gemeinsame Helfer für /api/status und /api/push:
// Dienste prüfen (von Cloudflare aus), Ergebnisse und Verlauf in D1 ablegen.

export const HOUR_MS = 3_600_000;
export const HISTORY_HOURS = 24;
export const CHECK_TIMEOUT_MS = 8_000;

export async function loadServices(env, request) {
  const res = await env.ASSETS.fetch(new URL('/services.json', request.url));
  if (!res.ok) throw new Error('services.json nicht lesbar');
  const data = await res.json();
  return data.services;
}

export async function getState(db, key) {
  const row = await db.prepare('SELECT value FROM state WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}

export function setStateStmt(db, key, value) {
  return db
    .prepare('INSERT INTO state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3')
    .bind(key, JSON.stringify(value), Date.now());
}

async function checkPlex(env) {
  if (!env.PLEX_TOKEN) return { online: false, detail: 'kein PLEX_TOKEN hinterlegt' };
  const res = await fetch('https://plex.tv/api/v2/resources?includeHttps=1', {
    headers: {
      Accept: 'application/json',
      'X-Plex-Token': env.PLEX_TOKEN,
      'X-Plex-Client-Identifier': 'demxane-hub',
      'X-Plex-Product': 'demxane',
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) return { online: false, code: res.status, detail: 'plex.tv antwortet nicht' };
  const list = await res.json();
  const server = list.find((r) => r.owned && String(r.provides || '').includes('server'));
  if (!server) return { online: false, detail: 'kein eigener Server im Plex-Konto' };
  return { online: !!server.presence, detail: server.name };
}

async function checkUrl(url) {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { 'User-Agent': 'demxane-hub-monitor/1.0' },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    cf: { cacheTtl: 0 },
  });
  // Body nicht lesen, nur den Status: 2xx/3xx/4xx heisst "antwortet", 5xx heisst "kaputt".
  return { online: res.status < 500, code: res.status };
}

async function checkOne(service, env) {
  const t0 = Date.now();
  let result;
  try {
    result = service.check === 'plex' ? await checkPlex(env) : await checkUrl(service.check || service.url);
  } catch (err) {
    result = { online: false, detail: err.name === 'TimeoutError' ? 'Zeitüberschreitung' : String(err.message || err) };
  }
  return { id: service.id, ms: Date.now() - t0, ...result };
}

// Prüft alle Dienste, aktualisiert Momentaufnahme und Stundenverlauf in D1.
export async function runChecks(env, request) {
  const db = env.DB;
  const services = await loadServices(env, request);
  const results = await Promise.all(services.map((s) => checkOne(s, env)));

  const now = new Date();
  const nowIso = now.toISOString();
  const slot = Math.floor(now.getTime() / HOUR_MS);
  const prev = (await getState(db, 'services')) || { items: {} };

  const items = {};
  for (const r of results) {
    const before = prev.items?.[r.id] || {};
    items[r.id] = {
      online: r.online,
      code: r.code ?? null,
      ms: r.ms,
      detail: r.detail ?? null,
      lastCheck: nowIso,
      lastSeen: r.online ? nowIso : before.lastSeen || null,
    };
  }

  const current = await db.prepare('SELECT service, up FROM checks WHERE slot = ?').bind(slot).all();
  const currentMap = Object.fromEntries((current.results || []).map((row) => [row.service, row.up]));

  const stmts = [];
  for (const r of results) {
    const up = r.online ? 1 : 0;
    if (!(r.id in currentMap)) {
      stmts.push(db.prepare('INSERT INTO checks (slot, service, up) VALUES (?, ?, ?)').bind(slot, r.id, up));
    } else if (currentMap[r.id] === 1 && up === 0) {
      // Eine Stunde gilt als gestört, sobald eine Prüfung darin fehlschlägt.
      stmts.push(db.prepare('UPDATE checks SET up = 0 WHERE slot = ? AND service = ?').bind(slot, r.id));
    }
  }
  stmts.push(db.prepare('DELETE FROM checks WHERE slot < ?').bind(slot - HISTORY_HOURS - 1));
  const snapshot = { checkedAt: nowIso, items };
  stmts.push(setStateStmt(db, 'services', snapshot));
  await db.batch(stmts);
  return snapshot;
}

export async function getHistory(db) {
  const slot = Math.floor(Date.now() / HOUR_MS);
  const rows = await db
    .prepare('SELECT slot, service, up FROM checks WHERE slot > ? ORDER BY slot')
    .bind(slot - HISTORY_HOURS)
    .all();
  const history = {};
  for (const row of rows.results || []) {
    (history[row.service] ||= []).push({ t: row.slot, s: row.up });
  }
  return history;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}
