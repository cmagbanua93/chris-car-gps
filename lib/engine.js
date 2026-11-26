// Engine (ignition) logic: work out which tracker input is the ignition wire,
// and turn a route into idle periods and engine on/off events.

const DI = ['acc', 'di1', 'di2', 'di3', 'di4'];

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
