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
      const parked = i === 2 && minute % 15 < 5;
      const idle = i === 1 && minute % 10 < 2;
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

  async history(imei, from, to) {
    const i = Number(imei);
    const route = [];
    const step = 60000;
    for (let t = Math.max(from.getTime(), to.getTime() - 8 * 3600000); t <= Math.min(to.getTime(), Date.now()); t += step) {
      const [lat, lng] = this.pos(i, t);
      route.push([t, lat, lng, 30]);
    }
    const km = route.length * 0.5;
    return {
      route,
      stops: route.length > 60 ? [{ lat: route[60][1], lng: route[60][2], start: route[60][0], end: route[60][0] + 1800000, duration: '30 min' }] : [],
      summary: { distanceKm: km, topSpeed: 62, avgSpeed: 30, drivingSec: route.length * 60, stoppedSec: 1800, idleSec: 300, engineSec: route.length * 60 + 300 },
    };
  }
}
