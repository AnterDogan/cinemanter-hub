#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const SERVICES = [
  { id: 'plex', check: 'https://plex.tv' },
  { id: 'audiobookshelf', check: 'https://audiobookshelf.demxane.com' },
  { id: 'immich', check: 'https://immich.demxane.com' },
  { id: 'swiparr', check: 'https://swiparr.demxane.com' },
  { id: 'seerr', check: 'https://seerr.demxane.com' },
  { id: 'hearr', check: 'https://hearr.demxane.com' },
  { id: 'barroque', check: 'https://barroque.demxane.com' },
  { id: 'obscurr', check: 'https://obscurr.demxane.com' },
  { id: 'sonarr', check: 'https://sonarr.demxane.com' },
  { id: 'radarr', check: 'https://radarr.demxane.com' },
  { id: 'sabnzbd', check: 'https://sab.demxane.com' },
  { id: 'portainer', check: 'https://portainer.demxane.com' },
  { id: 'homeassistant', check: 'https://ha.demxane.com' },
];

const DATA_FILE = path.join(__dirname, '..', 'uptime.json');
const CHECK_INTERVAL = 60_000;
const HOUR_MS = 3_600_000;
const HISTORY_HOURS = 24;

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveData(data) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, DATA_FILE);
}

function checkUrl(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: 5000, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function runChecks() {
  const data = loadData();
  const currentSlot = Math.floor(Date.now() / HOUR_MS);
  const cutoff = currentSlot - HISTORY_HOURS;

  const results = await Promise.allSettled(
    SERVICES.map(async (service) => {
      const online = await checkUrl(service.check);
      return { id: service.id, online };
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { id, online } = result.value;

    if (!data[id]) data[id] = { history: [] };
    const svc = data[id];
    svc.online = online;
    svc.lastCheck = new Date().toISOString();
    if (online) svc.lastSeen = svc.lastCheck;

    const entries = svc.history;
    const last = entries[entries.length - 1];

    if (last && last.t === currentSlot) {
      if (!online) last.s = 0;
    } else {
      entries.push({ t: currentSlot, s: online ? 1 : 0 });
    }

    svc.history = entries.filter(e => e.t > cutoff);
  }

  data._lastCheck = new Date().toISOString();
  saveData(data);

  const onlineCount = SERVICES.filter(s => data[s.id]?.online).length;
  console.log(`[${new Date().toISOString()}] ${onlineCount}/${SERVICES.length} online`);
}

runChecks();
setInterval(runChecks, CHECK_INTERVAL);
console.log(`demxane monitor gestartet — pruefe ${SERVICES.length} services alle 60s`);
