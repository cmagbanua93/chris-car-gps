// Unified car dashboard: reads live data from each GPS provider account and serves one dashboard.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GpsServerClient } from './lib/gpsserver.js';
import { DemoSource } from './lib/demo.js';
import { openStore } from './lib/store.js';
import { AlertEngine } from './lib/alerts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const cfg = {
  port: num(env.PORT, 3000),
  pollSeconds: Math.max(20, num(env.POLL_SECONDS, 30)), // never faster than every 20 s
  offlineMinutes: num(env.OFFLINE_MINUTES, 60),
  speedLimit: num(env.SPEED_LIMIT_KMH, 80),
  powerCutV: num(env.POWER_CUT_VOLTS, 9),
  nightStart: num(env.NIGHT_START_HOUR, 0),
  nightEnd: num(env.NIGHT_END_HOUR, 5),
  tzOffset: env.TZ_OFFSET || '+08:00',
  timeZone: env.TIME_ZONE || 'Asia/Manila',
  zones: parseZones(env.ZONES),
  // Which tracker input is the ignition, per car, when the provider has no Engine sensor: "KBJ 4803=di1;GBE 9707=di2"
  ignitionParams: Object.fromEntries((env.IGNITION_PARAMS || '').split(';').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x[0] && x[1])),
  idleAlertMinutes: num(env.IDLE_ALERT_MINUTES, 10),
  idleMinSeconds: num(env.IDLE_MIN_SECONDS, 120), // "Home:10.24,123.79,300;Office:10.31,123.89,200"
  dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
  keepDays: num(env.KEEP_DAYS, 365),
  password: env.DASHBOARD_PASSWORD || '',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: env.TELEGRAM_CHAT_ID || '',
};

function parseZones(s) {
  if (!s) return [];
  return s.split(';').map((z) => {
    const [name, rest = ''] = z.split(':');
    const [lat, lng, r] = rest.split(',').map(Number);
    return { name: name.trim(), lat, lng, radiusM: r || 200 };
  }).filter((z) => z.name && Number.isFinite(z.lat) && Number.isFinite(z.lng));
}

const log = { info: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), ...a) };

// Sources: SOURCE_1_NAME / SOURCE_1_URL / SOURCE_1_USERNAME / SOURCE_1_PASSWORD, then SOURCE_2_..., etc.
const sources = [];
for (let i = 1; i <= 10; i++) {
  const url = env[`SOURCE_${i}_URL`];
  if (!url) continue;
  if (!env[`SOURCE_${i}_USERNAME`] || !env[`SOURCE_${i}_PASSWORD`]) {
    console.warn(`SOURCE_${i} (${url}) has no username/password yet, skipping it.`);
    continue;
  }
  sources.push(new GpsServerClient({
    id: `s${i}`,
    name: env[`SOURCE_${i}_NAME`] || new URL(url).hostname,
    baseUrl: url,
    username: env[`SOURCE_${i}_USERNAME`] || '',
    password: env[`SOURCE_${i}_PASSWORD`] || '',
    tzOffset: cfg.tzOffset,
    log,
    ignitionOverrides: cfg.ignitionParams,
  }));
}
const demo = sources.length === 0 || env.DEMO === '1';
if (demo) sources.push(new DemoSource());
if (!demo && !cfg.password) {
  console.error('DASHBOARD_PASSWORD must be set when real GPS accounts are configured.');
  process.exit(1);
}

const store = openStore(path.join(cfg.dataDir, 'dashboard.db'));
const vehicles = new Map(); // id -> latest normalised vehicle
const sourceState = new Map(); // source id -> { ok, error, lastPoll }

const alerts = new AlertEngine(cfg, (a) => {
  log.info('ALERT', a.kind, a.message);
  store.addAlert(a);
  notify(a).catch((e) => log.warn('notify failed', e.message));
});

async function notify(a) {
  if (!cfg.telegramToken || !cfg.telegramChat) return;
  await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: cfg.telegramChat, text: `🚗 ${a.message}\nhttps://maps.google.com/?q=${a.lat},${a.lng}` }),
    signal: AbortSignal.timeout(15000),
  });
}

function statusOf(v) {
  const seen = v.serverTime || v.trackerTime;
  if (!seen || Date.now() - seen > cfg.offlineMinutes * 60000) return 'offline';
  if (v.speed > 3) return 'moving';
  if (v.sensors?.ignition) return 'idle';
  return 'parked';
}

// Engine state per car: on/off, since when, and how long it has been idling.
const engineState = new Map();
const ignitionChecked = new Set();
const engineHint = new Map(); // vehicle id -> what today's history says about the last engine switch
function trackEngine(v) {
  const ign = v.sensors?.ignition;
  const t = v.trackerTime || Date.now();
  let e = engineState.get(v.id);
  if (ign === null || ign === undefined) { v.engine = { on: null }; return; }
  if (!e) {
    const hint = engineHint.get(v.id);
    const since = hint && hint.lastOn === ign ? hint.lastT : null;
    const idleSince = hint && ign && hint.idleStart && Date.now() - hint.idleEnd < 5 * 60000 ? hint.idleStart : null;
    e = { on: ign, since, idleSince };
    engineState.set(v.id, e);
  }
  else if (e.on !== ign) { e.on = ign; e.since = t; e.idleSince = null; }
  const idling = ign && v.speed <= 3;
  if (idling && !e.idleSince) e.idleSince = t;
  if (!idling) e.idleSince = null;
  v.engine = { ...e };
}

// Once per car: find the ignition input and when the engine last switched, from today's history.
async function primeEngine(src, v) {
  if (ignitionChecked.has(v.id) || !src.detectIgnition) return;
  ignitionChecked.add(v.id);
  try {
    await src.detectIgnition(v.imei);
    const h = await getHistory(v.id, todayStr());
    const last = h.engine?.events?.at(-1);
    const lastIdle = h.engine?.idle?.at(-1);
    engineHint.set(v.id, { lastT: last?.t ?? null, lastOn: last ? last.kind === 'engine_on' : null, idleStart: lastIdle?.start, idleEnd: lastIdle?.end });
    engineState.delete(v.id); // rebuild from the hint on the next poll
  } catch (err) {
    ignitionChecked.delete(v.id);
    log.warn(`[${src.id}] engine check for ${v.name} failed: ${err.message}`);
  }
}

async function pollSource(src) {
  const st = sourceState.get(src.id) || {};
  try {
    const list = await src.live();
    for (const v of list) {
      primeEngine(src, v);
      trackEngine(v);
      v.status = statusOf(v);
      vehicles.set(v.id, v);
      store.savePosition(v);
      alerts.check(v, v.status);
    }
    Object.assign(st, { ok: true, error: null, lastPoll: Date.now(), count: list.length });
  } catch (e) {
    Object.assign(st, { ok: false, error: e.message, lastPoll: Date.now() });
    log.warn(`[${src.id}] poll failed: ${e.message}`);
    // Still re-check offline status for this source's cars.
    for (const v of vehicles.values()) if (v.id.startsWith(src.id + ':')) { v.status = statusOf(v); alerts.check(v, v.status); }
  }
  sourceState.set(src.id, st);
}

function schedule(src, i) {
  // Spread the sources out so they aren't polled at the same instant, plus a little jitter.
  const run = async () => {
    await pollSource(src);
    setTimeout(run, cfg.pollSeconds * 1000 + Math.random() * 3000);
  };
  setTimeout(run, i * 2000);
}
sources.forEach(schedule);
setInterval(() => store.prune(cfg.keepDays), 6 * 3600000);

// History cache, so repeated views don't reload multi-MB responses from the providers.
const histCache = new Map();
async function getHistory(id, dateStr) {
  const [srcId, imei] = id.split(':');
  const src = sources.find((s) => s.id === srcId);
  if (!src) throw new Error('unknown vehicle');
  const from = new Date(`${dateStr}T00:00:00${cfg.tzOffset}`);
  const to = new Date(from.getTime() + 86400000 - 1000);
  if (Number.isNaN(from.getTime())) throw new Error('bad date');
  const isToday = to.getTime() > Date.now();
  const key = `${id}|${dateStr}`;
  const hit = histCache.get(key);
  if (hit && (!isToday || Date.now() - hit.at < 10 * 60000)) return hit.data;
  const data = await src.history(imei, from, to, { idleMinSec: cfg.idleMinSeconds });
  histCache.set(key, { at: Date.now(), data });
  if (histCache.size > 200) histCache.delete(histCache.keys().next().value);
  return data;
}

function todayStr() {
  return new Date(Date.now() + offsetMs()).toISOString().slice(0, 10);
}
function offsetMs() {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(cfg.tzOffset) || ['', '+', '08', '00'];
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
}

// ---- HTTP ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function authorized(req) {
  if (!cfg.password) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass = ''] = Buffer.from(h.slice(6), 'base64').toString().split(/:(.*)/s);
  const a = Buffer.from(pass), b = Buffer.from(cfg.password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, { ok: true });
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Car dashboard"' });
    return res.end('Sign in required');
  }
  try {
    if (url.pathname === '/api/state') {
      return send(res, 200, {
        demo,
        now: Date.now(),
        config: { idleAlertMinutes: cfg.idleAlertMinutes, speedLimit: cfg.speedLimit, offlineMinutes: cfg.offlineMinutes, zones: cfg.zones, timeZone: cfg.timeZone, pollSeconds: cfg.pollSeconds, today: todayStr() },
        sources: sources.map((s) => ({ id: s.id, name: s.name, ...(sourceState.get(s.id) || {}) })),
        vehicles: [...vehicles.values()].map((v) => ({ ...v, status: statusOf(v) })),
      });
    }
    if (url.pathname === '/api/alerts') {
      const since = Number(url.searchParams.get('since')) || Date.now() - 7 * 86400000;
      return send(res, 200, store.alerts(since));
    }
    if (url.pathname === '/api/history') {
      const id = url.searchParams.get('id') || '';
      const date = url.searchParams.get('date') || todayStr();
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) return send(res, 400, { error: 'bad date' });
      try {
        return send(res, 200, { source: 'provider', ...(await getHistory(id, date)) });
      } catch (e) {
        // Fall back to our own saved positions if the provider can't answer.
        const from = Date.parse(`${date}T00:00:00${cfg.tzOffset}`);
        const rows = store.positions(id, from, from + 86400000);
        if (!rows.length) throw e;
        return send(res, 200, { source: 'local', error: e.message, route: rows.map((r) => [r.t, r.lat, r.lng, r.speed]), stops: [], summary: null });
      }
    }
    if (url.pathname === '/api/today') {
      const date = todayStr();
      const out = {};
      for (const v of vehicles.values()) {
        try { out[v.id] = (await getHistory(v.id, date)).summary; } catch (e) { out[v.id] = { error: e.message }; }
      }
      return send(res, 200, out);
    }
    // static files
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(__dirname, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    log.warn('request failed', url.pathname, e.message);
    return send(res, 502, { error: e.message });
  }
});

server.listen(cfg.port, () => log.info(`Car dashboard on :${cfg.port} (${demo ? 'demo data' : sources.length + ' GPS accounts'})`));
