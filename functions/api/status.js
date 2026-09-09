// GET /api/status
// Liefert Momentaufnahme der Dienste, 24h-Verlauf und die zuletzt gemeldete Auslastung des Mini.
// Sind die Dienst-Prüfungen älter als drei Minuten (Mini meldet sich nicht), wird direkt neu geprüft.

import { getState, getHistory, runChecks, json } from '../_lib/checks.js';

const STALE_MS = 3 * 60 * 1000;

export async function onRequestGet({ env, request }) {
  const db = env.DB;
  let [host, services] = await Promise.all([getState(db, 'host'), getState(db, 'services')]);

  const age = services ? Date.now() - Date.parse(services.checkedAt) : Infinity;
  if (!(age < STALE_MS)) {
    try {
      services = await runChecks(env, request);
    } catch (err) {
      services = services || null;
      console.error('runChecks fehlgeschlagen:', err);
    }
  }

  const history = await getHistory(db);
  return json({ now: new Date().toISOString(), host, services, history });
}
