import { detectIgnitionParam, engineTimeline } from './engine.js';
// Client for GPS-Server.net based tracking sites (Expedite GPS Tracker, Vectras WTrackLite, ...).
// It signs in like the web page does and calls the same JSON endpoints the map uses.
// Nothing here changes anything on the provider: only read commands are sent.

const UA = 'Mozilla/5.0 (compatible; CarDashboard/1.0)';

export class GpsServerClient {
  constructor({ id, name, baseUrl, username, password, tzOffset = '+08:00', log = console, ignitionOverrides }) {
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/map\.php$/, '');
    this.username = username;
    this.password = password;
    this.tzOffset = tzOffset;
    this.log = log;
    this.cookies = new Map();
    this.loggedIn = false;
    this.loginFailures = 0;
    this.nextLoginAt = 0;
    this.objects = {}; // imei -> settings (name, plate, sensors)
    this.lastError = null;
    this.ignitionOverrides = ignitionOverrides || {}; // name/plate/imei -> param
    this.ignition = {}; // imei -> { param, how }
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  storeCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async post(path, params, { timeoutMs = 30000 } = {}) {
    const res = await fetch(`${this.baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        Cookie: this.cookieHeader(),
        Referer: `${this.baseUrl}/map.php`,
      },
      body: new URLSearchParams(params),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    this.storeCookies(res);
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) throw new SessionError('redirected (session expired)');
    if (!res.ok) throw new Error(`${path} HTTP ${res.status}`);
    let json;
    try { json = JSON.parse(text); } catch {
      // A logged-out session usually gets HTML or an empty body back.
      throw new SessionError(`${path} did not return JSON`);
    }
    return json;
  }

  async login() {
    if (Date.now() < this.nextLoginAt) throw new Error('waiting before next sign-in attempt');
    this.cookies.clear();
    // Open the sign-in page first so the server hands out a session cookie.
    const page = await fetch(`${this.baseUrl}/index.php`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    this.storeCookies(page);
    await page.text();
    let ok = false;
    let detail = '';
    try {
      const r = await this.post('func/connect.php', { cmd: 'login', username: this.username, password: this.password, remember_me: 'false' });
      ok = r === true || r?.success === true || r === 'OK';
      detail = typeof r === 'object' ? (r.text || r.title || '') : String(r);
    } catch (e) {
      detail = e.message;
    }
    if (!ok) {
      this.loginFailures++;
      // Back off: 1, 2, 4 ... up to 60 minutes, so we never hammer the sign-in page.
      const waitMin = Math.min(60, 2 ** (this.loginFailures - 1));
      this.nextLoginAt = Date.now() + waitMin * 60000;
      this.loggedIn = false;
      throw new Error(`sign-in failed (${detail || 'unknown reason'}); next try in ${waitMin} min`);
    }
    this.loginFailures = 0;
    this.loggedIn = true;
    this.log.info?.(`[${this.id}] signed in`);
    await this.loadObjects();
  }

  async call(path, params, opts) {
    if (!this.loggedIn) await this.login();
    try {
      return await this.post(path, params, opts);
    } catch (e) {
      if (!(e instanceof SessionError)) throw e;
      this.loggedIn = false;
      await this.login();
      return await this.post(path, params, opts);
    }
  }

  async loadObjects() {
    const r = await this.post('func/settings.objects.php', { cmd: 'object_data_get' });
    const data = r?.data ?? r ?? {};
    this.objects = {};
    for (const [imei, o] of Object.entries(data)) {
      this.objects[imei] = {
        name: o.name || imei,
        plate: o.plate_number || '',
        sensors: Object.values(o.sensors || {}).map((s) => ({
          name: s.name, type: s.type, param: s.param, resultType: s.result_type, formula: s.formula, units: s.units,
        })),
      };
      const meta = this.objects[imei];
      const override = this.ignitionOverrides[meta.name] || this.ignitionOverrides[meta.plate] || this.ignitionOverrides[imei];
      const acc = meta.sensors.find((x) => x.type === 'acc' || /engine|ignition|acc/i.test(x.name || ''));
      if (override) this.ignition[imei] = { param: override, how: 'setting' };
      else if (acc) this.ignition[imei] = { param: acc.param, how: 'provider sensor' };
    }
  }

  // For cars without an engine sensor set up at the provider, learn the ignition input from recent history.
  async detectIgnition(imei) {
    if (this.ignition[imei]) return this.ignition[imei];
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86400000);
    const raw = await this.rawRoute(imei, from, to);
    const pts = raw.map((p) => [this.parseTime(p[0]), 0, 0, Number(p[5]) || 0, p[6] || {}]);
    const best = detectIgnitionParam(pts);
    const name = this.objects[imei]?.name || imei;
    if (best) {
      this.ignition[imei] = { param: best.param, how: `learned from history (${Math.round(best.score * 100)}% match)` };
      this.log.info?.(`[${this.id}] ${name}: ignition looks like ${best.param} (${JSON.stringify(best)})`);
    } else {
      this.ignition[imei] = { param: null, how: 'not reported by this tracker' };
      this.log.info?.(`[${this.id}] ${name}: no ignition input found in ${pts.length} points`);
      // Summarise every reported value split by moving / not moving, to see what the tracker sends.
      const sum = {};
      for (const p of pts) {
        const m = p[3] > 10 ? 'mv' : 'st';
        for (const [k, v] of Object.entries(p[4])) {
          if (/^(lac|cell_id|mcc|mnc|odo|gprs_ip\d|hdop|gsmlev|gpslev)$/.test(k)) continue;
          const key = String(v).length > 6 ? 'n' : String(v);
          sum[k] ??= {}; sum[k][key + '/' + m] = (sum[k][key + '/' + m] || 0) + 1;
        }
      }
      for (const [k, v] of Object.entries(sum)) {
        const keys = Object.keys(v);
        this.log.info?.(`[${this.id}] ${name} param ${k}: ${keys.length > 12 ? keys.length + ' distinct' : JSON.stringify(v)}`);
      }
    }
    return this.ignition[imei];
  }

  ignitionOf(imei, params) {
    const p = this.ignition[imei]?.param;
    if (!p || params?.[p] === undefined) return null;
    return String(params[p]) === '1';
  }

  async rawRoute(imei, from, to) {
    const fmt = (d) => new Date(d.getTime() + offsetMinutes(this.tzOffset) * 60000).toISOString().slice(0, 19).replace('T', ' ');
    const r = await this.call('func/history.php', {
      cmd: 'route_data_get', imei, dtf: fmt(from), dtt: fmt(to), min_stop_duration: '5',
    }, { timeoutMs: 90000 });
    this._lastHistory = r?.data ?? {};
    return this._lastHistory.route || [];
  }

  parseTime(s) {
    if (!s || s.startsWith('0000')) return null;
    const t = Date.parse(s.replace(' ', 'T') + this.tzOffset);
    return Number.isNaN(t) ? null : t;
  }

  // Live positions of all vehicles on this account, normalised.
  async live() {
    const r = await this.call('func/objects.php', { cmd: 'object_location_data_get' });
    const data = r?.data ?? {};
    const out = [];
    for (const [imei, o] of Object.entries(data)) {
      const loc = Array.isArray(o.location) ? o.location[0] : o.location;
      if (!loc) continue;
      const meta = this.objects[imei] || { name: imei, plate: '', sensors: [] };
      const params = loc.params || {};
      out.push({
        id: `${this.id}:${imei}`,
        source: this.name,
        imei,
        name: meta.name,
        plate: meta.plate,
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        speed: Number(loc.speed) || 0,
        angle: Number(loc.angle) || 0,
        altitude: Number(loc.altitude) || 0,
        trackerTime: this.parseTime(loc.dt_tracker),
        serverTime: this.parseTime(loc.dt_server),
        address: o.address || '',
        odometerKm: Number(o.odometer) || null,
        providerStatus: o.status_string || o.status || '',
        sensors: withIgnition(readSensors(meta.sensors, params), this.ignitionOf(imei, params)),
        ignitionSource: this.ignition[imei]?.how || 'checking…',
        gsm: params.gsmlev != null ? Number(params.gsmlev) : null,
        satellites: params.gpslev != null ? Number(params.gpslev) : null,
      });
    }
    return out;
  }

  // Route, stops, drives, engine timeline and summary for one vehicle between two Date objects.
  async history(imei, from, to, engineOpts) {
    await this.detectIgnition(imei).catch(() => {});
    const rawPts = await this.rawRoute(imei, from, to);
    const d = this._lastHistory;
    const route = rawPts.map((p) => [this.parseTime(p[0]), Number(p[1]), Number(p[2]), Number(p[5]) || 0, this.ignitionOf(imei, p[6])]);
    const engine = this.ignition[imei]?.param ? engineTimeline(route, engineOpts) : null;
    const stops = (d.stops || []).map((s) => {
      // stop rows hold lat/lng as strings and start/end times as dates
      const dates = s.filter((v) => typeof v === 'string' && /^\d{4}-\d\d-\d\d /.test(v));
      const nums = s.filter((v) => typeof v === 'string' && /^-?\d+\.\d+$/.test(v)).map(Number);
      return { lat: nums[0], lng: nums[1], start: this.parseTime(dates[0]), end: this.parseTime(dates[1]), duration: s.find((v) => typeof v === 'string' && /\d+ (s|min|h)/.test(v)) || '' };
    }).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
    return {
      route,
      stops,
      engine,
      ignitionSource: this.ignition[imei]?.how || null,
      summary: {
        distanceKm: Number(d.route_length) || 0,
        topSpeed: Number(d.top_speed) || 0,
        avgSpeed: Number(d.avg_speed) || 0,
        drivingSec: Number(d.drives_duration_time) || 0,
        stoppedSec: Number(d.stops_duration_time) || 0,
        idleSec: engine ? engine.idleSec : Number(d.engine_idle_time) || 0,
        engineSec: engine ? engine.engineOnSec : Number(d.engine_work_time) || 0,
      },
    };
  }
}

function withIgnition(sensors, ign) {
  if (ign !== null && ign !== undefined) sensors.ignition = ign;
  return sensors;
}

export class SessionError extends Error {}

function offsetMinutes(off) {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(off) || ['', '+', '00', '00'];
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// Applies the provider's own sensor setup (e.g. "Engine" on di2, "Power Supply" on ai3 with (x/1024)*48).
export function readSensors(sensors, params) {
  const out = { ignition: null, powerV: null, batteryV: null, extra: [] };
  for (const s of sensors) {
    const raw = params[s.param];
    if (raw === undefined) continue;
    let value;
    if (s.resultType === 'logic') value = String(raw) === '1';
    else value = round(applyFormula(s.formula, Number(raw)), 2);
    const n = (s.name || '').toLowerCase();
    if (s.type === 'acc' || /engine|ignition|acc/.test(n)) out.ignition = Boolean(value);
    else if (/batt/.test(n)) out.batteryV = value;
    else if (/power|ext/.test(n)) out.powerV = value;
    else out.extra.push({ name: s.name, value, units: s.units || '' });
  }
  if (out.powerV === null && params.ext_pwr !== undefined) out.extra.push({ name: 'External power', value: params.ext_pwr, units: '' });
  return out;
}

function applyFormula(formula, x) {
  if (!formula) return x;
  const f = String(formula).replace(/\s+/g, '');
  if (!/^[0-9x+\-*/().]+$/i.test(f)) return x; // only plain arithmetic is evaluated
  try {
    const v = Function('x', `return (${f.replace(/X/g, 'x')});`)(x);
    return Number.isFinite(v) ? v : x;
  } catch { return x; }
}

const round = (v, d) => (typeof v === 'number' ? Math.round(v * 10 ** d) / 10 ** d : v);
