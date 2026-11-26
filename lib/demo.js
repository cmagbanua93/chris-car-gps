import { engineTimeline } from './engine.js';
// Fake data source so the dashboard can be tried before any real login is configured.
// Three cars drive loops around Cebu.

const LOOPS = [
  { name: 'Demo Van', plate: 'DEMO 001', center: [10.2433, 123.7885], r: 0.012 }, // Minglanilla
  { name: 'Demo Car', plate: 'DEMO 002', center: [10.2700, 123.8500], r: 0.010 }, // Talisay
  { name: 'Demo SUV', plate: 'DEMO 003', center: [10.3157, 123.8854], r: 0.015 }, // Cebu City
];

export class DemoSource {
  constructor() {
    this.id = 'demo';
    this.name = 'Demo';
    this.t0 = Date.now();
    this.lastError = null;
    this.loggedIn = true;
  }

  pos(i, t) {
    const L = LOOPS[i];
    const phase = ((t - this.t0) / 1000 / 600 + i / 3) * 2 * Math.PI; // one loop per 10 min
    return [L.center[0] + L.r * Math.sin(phase), L.center[1] + L.r * Math.cos(phase)];
  }

  async live() {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    return LOOPS.map((L, i) => {
      // car 3 parks for 5 of every 15 minutes, car 2 idles sometimes
      const { parked, idle } = this.state(i, now);
      const [lat, lng] = parked ? this.pos(i, Math.floor(now / 900000) * 900000) : this.pos(i, now);
      const speed = parked || idle ? 0 : Math.round(25 + 20 * Math.abs(Math.sin(now / 50000 + i)) + (i === 0 && minute % 20 === 0 ? 50 : 0));
      return {
        id: `demo:${i}`,
        source: 'Demo',
        imei: String(i),
        name: L.name,
        plate: L.plate,
        lat, lng, speed,
        angle: Math.round(((now / 1000 / 600) * 360 + i * 120) % 360),
        altitude: 20,
        trackerTime: now - 5000,
        serverTime: now - 4000,
        address: '',
        odometerKm: 12000 + i * 3000,
        providerStatus: '',
        sensors: { ignition: !parked, powerV: parked ? 12.4 : 13.8, batteryV: 4.1, extra: [] },
        gsm: 4,
        satellites: 9,
      };
    });
  }

  state(i, t) {
    const minute = Math.floor(t / 60000);
    const parked = i === 2 && minute % 15 < 5;
    const idle = i === 1 && minute % 10 < 4;
    return { parked, idle };
  }

  async history(imei, from, to) {
    const i = Number(imei);
    const route = [];
    for (let t = Math.max(from.getTime(), to.getTime() - 8 * 3600000); t <= Math.min(to.getTime(), Date.now()); t += 30000) {
      const { parked, idle } = this.state(i, t);
      const [lat, lng] = parked ? this.pos(i, Math.floor(t / 900000) * 900000) : this.pos(i, t);
      route.push([t, lat, lng, parked || idle ? 0 : 35, !parked]);
    }
    const engine = engineTimeline(route);
    return {
      route,
      stops: [],
      engine,
      ignitionSource: 'demo',
      summary: { distanceKm: route.length * 0.25, topSpeed: 62, avgSpeed: 30, drivingSec: route.filter((p) => p[3] > 0).length * 30, stoppedSec: 0, idleSec: engine.idleSec, engineSec: engine.engineOnSec },
    };
  }
}
