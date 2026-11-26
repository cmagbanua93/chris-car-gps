// Engine (ignition) logic: work out which tracker input is the ignition wire,
// and turn a route into idle periods and engine on/off events.

const DI = ['acc', 'di1', 'di2', 'di3', 'di4'];
export const VOLTAGE_ON = Number(process.env.ENGINE_ON_VOLTS || 13.4);

// Find an analog input that looks like a 12 V car battery (most readings between 11 and 15.5 V).
export function detectVoltageParam(points) {
  for (const k of ['ai1', 'ai2', 'ai3', 'ai4', 'ext_volt', 'power']) {
    const vals = points.map((p) => Number(p[4]?.[k])).filter(Number.isFinite);
    if (vals.length < 20) continue;
    const car = vals.filter((v) => v >= 11 && v <= 15.5).length;
    if (car / vals.length > 0.9) return k;
  }
  return null;
}

// Look at route points [t, lat, lng, speed, params] and guess which digital input follows the engine.
// The ignition wire is on (1) whenever the car is really driving, and off for some of the parked time.
export function detectIgnitionParam(points) {
  let best = null;
  for (const k of DI) {
    let movingOn = 0, moving = 0, stillOff = 0, still = 0, seen = 0;
    for (const p of points) {
      const raw = p[4]?.[k];
      if (raw === undefined || raw === '') continue;
      seen++;
      const on = String(raw) === '1';
      if (p[3] > 10) { moving++; if (on) movingOn++; } else { still++; if (!on) stillOff++; }
    }
    if (seen < 20 || moving < 5 || stillOff === 0) continue;
    const score = movingOn / moving;
    if (score >= 0.9 && (!best || score > best.score)) best = { param: k, score, moving, stillOff, still };
  }
  return best;
}

// route: [[t, lat, lng, speed, ign(true/false/null)], ...] sorted by time.
export function engineTimeline(route, { idleMinSec = 120, idleSpeed = 3, gapSec = 900 } = {}) {
  const idle = [];
  const events = [];
  let cur = null; // current idle run
  let onSec = 0, offSec = 0;
  for (let i = 0; i < route.length; i++) {
    const [t, lat, lng, speed, ign] = route[i];
    const next = route[i + 1];
    const dt = next ? Math.min((next[0] - t) / 1000, gapSec) : 0;
    if (ign === true) onSec += dt; else if (ign === false) offSec += dt;
    const prev = route[i - 1];
    if (prev && prev[4] !== null && ign !== null && prev[4] !== ign) {
      events.push({ t, lat, lng, kind: ign ? 'engine_on' : 'engine_off' });
    }
    const isIdle = ign === true && speed < idleSpeed;
    if (isIdle) {
      if (!cur) cur = { start: t, end: t, lat, lng };
      cur.end = next ? Math.min(next[0], t + gapSec * 1000) : t;
    } else if (cur) {
      cur.end = t;
      if ((cur.end - cur.start) / 1000 >= idleMinSec) idle.push(cur);
      cur = null;
    }
  }
  if (cur && (cur.end - cur.start) / 1000 >= idleMinSec) idle.push(cur);
  for (const p of idle) p.seconds = Math.round((p.end - p.start) / 1000);
  // Engine-off periods: from each engine_off to the next engine_on (or end of data).
  const offPeriods = [];
  events.forEach((e, i) => {
    if (e.kind !== 'engine_off') return;
    const on = events.slice(i + 1).find((x) => x.kind === 'engine_on');
    const end = on ? on.t : route.at(-1)[0];
    offPeriods.push({ start: e.t, end, seconds: Math.round((end - e.t) / 1000), lat: e.lat, lng: e.lng, ongoing: !on });
  });
  return {
    idle,
    events,
    offPeriods,
    idleSec: idle.reduce((s, p) => s + p.seconds, 0),
    engineOnSec: Math.round(onSec),
    engineOffSec: Math.round(offSec),
  };
}

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b[1] - a[1]) * r, dLng = (b[2] - a[2]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Turn a route [[t, lat, lng, speed, ign], ...] into a list like the provider's history panel:
// start, then alternating parked / driving periods, each with its duration.
export function buildTimeline(route, { minStopSec = 60, stopSpeed = 3 } = {}) {
  if (!route.length) return [];
  // 1. runs of still / moving points
  let runs = [];
  for (let i = 0; i < route.length; i++) {
    const still = route[i][3] < stopSpeed;
    const last = runs.at(-1);
    if (last && last.still === still) last.end = i; else runs.push({ still, start: i, end: i });
  }
  const tEnd = (run) => (route[run.end + 1] || route[run.end])[0];
  // 2. short stops (traffic lights etc.) count as driving
  runs.forEach((r) => { if (r.still && (tEnd(r) - route[r.start][0]) / 1000 < minStopSec && runs.length > 1) r.still = false; });
  const merged = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && last.still === r.still) last.end = r.end; else merged.push({ ...r });
  }
  // 3. describe each period
  const items = [{ kind: 'start', t: route[0][0], lat: route[0][1], lng: route[0][2] }];
  for (const r of merged) {
    const start = route[r.start][0];
    const end = tEnd(r);
    const item = { kind: r.still ? 'parked' : 'drive', t: start, end, seconds: Math.round((end - start) / 1000), lat: route[r.start][1], lng: route[r.start][2], from: r.start, to: r.end };
    if (r.still) {
      let on = 0, known = 0;
      for (let i = r.start; i <= r.end; i++) {
        const dt = ((route[i + 1] || route[i])[0] - route[i][0]) / 1000;
        if (route[i][4] !== null && route[i][4] !== undefined) { known += dt; if (route[i][4]) on += dt; }
      }
      item.engineOnSec = known ? Math.round(on) : null;
    } else {
      let m = 0, top = 0;
      for (let i = r.start; i <= r.end; i++) {
        if (i > r.start) m += distM(route[i - 1], route[i]);
        top = Math.max(top, route[i][3]);
      }
      if (route[r.end + 1]) m += distM(route[r.end], route[r.end + 1]);
      item.km = Math.round(m / 100) / 10;
      item.topSpeed = Math.round(top);
    }
    items.push(item);
  }
  return items;
}
