// Local SQLite store (Node's built-in node:sqlite). Keeps our own copy of positions and alerts,
// so history survives even if a provider deletes old data.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS positions (
      vehicle TEXT NOT NULL, t INTEGER NOT NULL, lat REAL, lng REAL, speed REAL,
      ignition INTEGER, power REAL, battery REAL,
      PRIMARY KEY (vehicle, t)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, vehicle TEXT NOT NULL,
      name TEXT, kind TEXT NOT NULL, message TEXT NOT NULL, lat REAL, lng REAL
    );
    CREATE INDEX IF NOT EXISTS alerts_t ON alerts (t);
  `);
  const insPos = db.prepare('INSERT OR IGNORE INTO positions VALUES (?,?,?,?,?,?,?,?)');
  const insAlert = db.prepare('INSERT INTO alerts (t, vehicle, name, kind, message, lat, lng) VALUES (?,?,?,?,?,?,?)');
  const listAlerts = db.prepare('SELECT * FROM alerts WHERE t >= ? ORDER BY t DESC LIMIT ?');
  const posRange = db.prepare('SELECT t, lat, lng, speed FROM positions WHERE vehicle = ? AND t BETWEEN ? AND ? ORDER BY t');
  const prune = db.prepare('DELETE FROM positions WHERE t < ?');

  return {
    savePosition(v) {
      if (!v.trackerTime) return;
      const s = v.sensors || {};
      insPos.run(v.id, v.trackerTime, v.lat, v.lng, v.speed,
        s.ignition == null ? null : s.ignition ? 1 : 0, s.powerV ?? null, s.batteryV ?? null);
    },
    addAlert(a) {
      insAlert.run(a.t, a.vehicle, a.name, a.kind, a.message, a.lat ?? null, a.lng ?? null);
    },
    alerts(sinceMs, limit = 200) { return listAlerts.all(sinceMs, limit); },
    positions(vehicle, from, to) { return posRange.all(vehicle, from, to); },
    prune(days) { prune.run(Date.now() - days * 86400000); },
  };
}
