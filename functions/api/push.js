// POST /api/push
// Der Mini schickt jede Minute seine Auslastung hierher (Authorization: Bearer PUSH_TOKEN).
// Bei jedem Eingang werden zusätzlich alle Dienste von Cloudflare aus geprüft.

import { runChecks, setStateStmt, json } from '../_lib/checks.js';

const MAX_BODY = 64 * 1024;

function tokenMatches(header, expected) {
  if (!header || !expected) return false;
  const enc = new TextEncoder();
  const a = enc.encode(header);
  const b = enc.encode(`Bearer ${expected}`);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function onRequestPost({ env, request }) {
  if (!tokenMatches(request.headers.get('Authorization'), env.PUSH_TOKEN)) {
    return json({ error: 'nicht erlaubt' }, 401);
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) return json({ error: 'zu gross' }, 413);

  let host;
  try {
    host = JSON.parse(raw);
  } catch {
    return json({ error: 'kein gültiges JSON' }, 400);
  }
  if (!host || typeof host !== 'object' || Array.isArray(host)) return json({ error: 'Objekt erwartet' }, 400);

  host.receivedAt = new Date().toISOString();
  await setStateStmt(env.DB, 'host', host).run();

  let online = null;
  let total = null;
  let error = null;
  try {
    const snapshot = await runChecks(env, request);
    const items = Object.values(snapshot.items);
    total = items.length;
    online = items.filter((i) => i.online).length;
  } catch (err) {
    error = String(err.message || err);
    console.error('runChecks fehlgeschlagen:', err);
  }

  return json({ ok: true, receivedAt: host.receivedAt, online, total, error });
}
