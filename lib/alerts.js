// Alert rules, checked each time fresh positions arrive.
// Each rule fires once when the condition starts, not on every poll.

export function distanceM(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function localHour(ms, tzOffset) {
  const m = /^([+-])(\d\d):?(\d\d)$/.exec(tzOffset) || ['', '+', '08', '00'];
  const off = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return new Date(ms + off * 60000).getUTCHours();
}

export class AlertEngine {
  constructor(cfg, onAlert) {
    this.cfg = cfg;
    this.onAlert = onAlert;
    this.state = new Map(); // vehicle id -> { flags }
  }

  flag(v, key, active, makeMsg) {
    const st = this.state.get(v.id) || {};
    this.state.set(v.id, st);
    if (st[key] === undefined) { st[key] = active; return; } // first sight: learn, don't alert
    if (active && !st[key]) this.onAlert({ t: Date.now(), vehicle: v.id, name: v.name, kind: key, message: makeMsg(), lat: v.lat, lng: v.lng });
    st[key] = active;
  }

  check(v, status) {
    const c = this.cfg;
    const label = v.plate && v.plate !== v.name ? `${v.name} (${v.plate})` : v.name;
    this.flag(v, 'offline', status === 'offline', () => `${label} stopped reporting. Last seen ${new Date(v.serverTime || v.trackerTime).toLocaleString('en-PH', { timeZone: c.timeZone })}.`);
    if (status === 'offline') return;
    this.flag(v, 'speeding', v.speed > c.speedLimit, () => `${label} is going ${Math.round(v.speed)} km/h (limit ${c.speedLimit}).`);
    const h = localHour(v.trackerTime || Date.now(), c.tzOffset);
    const night = c.nightStart > c.nightEnd ? (h >= c.nightStart || h < c.nightEnd) : (h >= c.nightStart && h < c.nightEnd);
    this.flag(v, 'night_use', night && (v.sensors.ignition === true || v.speed > 5), () => `${label} is in use at night (${h}:00).`);
    if (v.sensors.powerV != null) {
      this.flag(v, 'power_cut', v.sensors.powerV < c.powerCutV, () => `${label} lost main power (${v.sensors.powerV} V). The tracker may have been unplugged.`);
    }
    for (const z of c.zones) {
      const inside = distanceM([v.lat, v.lng], [z.lat, z.lng]) <= z.radiusM;
      this.flag(v, `zone_exit:${z.name}`, !inside, () => `${label} left ${z.name}.`);
      this.flag(v, `zone_enter:${z.name}`, inside, () => `${label} arrived at ${z.name}.`);
    }
  }
}
