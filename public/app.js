/* global L */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let state = { vehicles: [], sources: [], config: {} };
let today = {};
let selected = null;
let tz = 'Asia/Manila';
const markers = new Map();

const map = L.map('map', { zoomControl: true }).setView([10.3, 123.85], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
const histLayer = L.layerGroup().addTo(map);
const zoneLayer = L.layerGroup().addTo(map);
let fitted = false;

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('en-PH', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');
const ago = (ms) => {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};
const dur = (sec) => {
  if (!sec) return '0 min';
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
};

async function api(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// ---------- live ----------
async function refresh() {
  try {
    state = await api('api/state');
    tz = state.config.timeZone || tz;
    $('#demoBadge').hidden = !state.demo;
    renderSources();
    renderTiles();
    renderCars();
    renderMarkers();
    renderZones();
    fillCarSelect();
  } catch (e) {
    $('#sources').innerHTML = `<span class="src bad"><span class="dot"></span>Dashboard server unreachable</span>`;
  }
}

function renderSources() {
  $('#sources').innerHTML = state.sources.map((s) => {
    const bad = s.ok === false;
    const tip = bad ? `Problem: ${s.error}` : s.lastPoll ? `Updated ${ago(s.lastPoll)}` : 'Connecting…';
    return `<span class="src ${bad ? 'bad' : ''}" title="${esc(tip)}"><span class="dot"></span>${esc(s.name)}</span>`;
  }).join('');
}

function renderTiles() {
  const c = { moving: 0, idle: 0, stopped: 0, offline: 0 };
  state.vehicles.forEach((v) => c[v.status]++);
  $('#tiles').innerHTML = Object.entries(c).map(([k, n]) => `<div class="tile"><b style="color:var(--${k})">${n}</b><span>${k}</span></div>`).join('');
}

function renderCars() {
  if (!state.vehicles.length) {
    $('#cars').innerHTML = `<p class="muted">Waiting for the first update from your GPS accounts…</p>`;
    return;
  }
  const order = { moving: 0, idle: 1, stopped: 2, offline: 3 };
  const list = [...state.vehicles].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  $('#cars').innerHTML = list.map((v) => {
    const s = v.sensors || {};
    const t = today[v.id];
    const ign = s.ignition == null ? '—' : s.ignition ? 'On' : 'Off';
    const power = s.powerV != null ? `${s.powerV} V` : '—';
    return `<div class="car ${selected === v.id ? 'sel' : ''}" data-id="${esc(v.id)}">
      <div class="row"><div><h3>${esc(v.name)}</h3><div class="plate">${esc(v.plate && v.plate !== v.name ? v.plate + ' · ' : '')}${esc(v.source)}</div></div>
      <span class="pill ${v.status}">${v.status}</span></div>
      <div class="stats">
        <div class="stat"><b>${Math.round(v.speed)} km/h</b>Speed</div>
        <div class="stat"><b>${ign}</b>Ignition</div>
        <div class="stat"><b>${power}</b>Car battery</div>
        <div class="stat"><b>${t && !t.error ? t.distanceKm.toFixed(1) + ' km' : '—'}</b>Today</div>
        <div class="stat"><b>${t && !t.error ? dur(t.drivingSec) : '—'}</b>Driving today</div>
        <div class="stat"><b>${ago(v.serverTime || v.trackerTime)}</b>Last update</div>
      </div>
      ${v.address ? `<div class="addr">${esc(v.address)}</div>` : ''}
    </div>`;
  }).join('');
  document.querySelectorAll('.car').forEach((el) => el.addEventListener('click', () => focusCar(el.dataset.id)));
}

function icon(v) {
  return L.divIcon({
    className: '',
    html: `<div class="marker ${v.status}" style="transform: rotate(${v.status === 'moving' ? v.angle : 0}deg)">${v.status === 'moving' ? '➤' : '●'}</div>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function renderMarkers() {
  const seen = new Set();
  for (const v of state.vehicles) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
    seen.add(v.id);
    let m = markers.get(v.id);
    const popup = `<b>${esc(v.name)}</b><br>${Math.round(v.speed)} km/h · ${v.status}<br>${esc(fmtTime(v.trackerTime))}<br><a href="https://maps.google.com/?q=${v.lat},${v.lng}" target="_blank" rel="noopener">Open in Google Maps</a>`;
    if (!m) {
      m = L.marker([v.lat, v.lng], { icon: icon(v) }).addTo(map).bindTooltip(v.name, { permanent: true, direction: 'top', offset: [0, -14], className: 'lbl' });
      m.on('click', () => focusCar(v.id));
      markers.set(v.id, m);
    } else {
      m.setLatLng([v.lat, v.lng]).setIcon(icon(v));
    }
    m.bindPopup(popup);
  }
  for (const [id, m] of markers) if (!seen.has(id)) { map.removeLayer(m); markers.delete(id); }
  if (!fitted && markers.size) {
    map.fitBounds(L.latLngBounds([...markers.values()].map((m) => m.getLatLng())).pad(0.3), { maxZoom: 15 });
    fitted = true;
  }
}

let zonesDrawn = false;
function renderZones() {
  if (zonesDrawn) return;
  zonesDrawn = true;
  for (const z of state.config.zones || []) {
    L.circle([z.lat, z.lng], { radius: z.radiusM, color: '#2f6fde', weight: 1, fillOpacity: 0.06 }).addTo(zoneLayer).bindTooltip(z.name);
  }
}

function focusCar(id) {
  selected = id;
  const m = markers.get(id);
  if (m) { map.setView(m.getLatLng(), Math.max(map.getZoom(), 15)); m.openPopup(); }
  renderCars();
}

async function loadToday() {
  try { today = await api('api/today'); renderCars(); } catch { /* summaries are optional */ }
}

// ---------- history ----------
function fillCarSelect() {
  const sel = $('#hCar');
  const cur = sel.value;
  const opts = state.vehicles.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`).join('');
  if (sel.dataset.opts !== opts) { sel.innerHTML = opts; sel.dataset.opts = opts; if (cur) sel.value = cur; }
  if (!$('#hDate').value) $('#hDate').value = state.config.today;
}

let track = [], playTimer = null, playMarker = null;
async function loadHistory() {
  const id = $('#hCar').value, date = $('#hDate').value;
  if (!id || !date) return;
  const btn = $('#hLoad');
  btn.disabled = true; btn.textContent = 'Loading…';
  histLayer.clearLayers(); stopPlay();
  try {
    const h = await api(`api/history?id=${encodeURIComponent(id)}&date=${date}`);
    track = h.route.filter((p) => Number.isFinite(p[1]) && Number.isFinite(p[2]));
    const s = h.summary;
    $('#hSummary').innerHTML = (s ? `<div class="summary">
      <div class="stat"><b>${s.distanceKm.toFixed(1)} km</b>Distance</div>
      <div class="stat"><b>${dur(s.drivingSec)}</b>Driving</div>
      <div class="stat"><b>${s.topSpeed} km/h</b>Top speed</div>
      <div class="stat"><b>${s.avgSpeed} km/h</b>Average</div>
      <div class="stat"><b>${dur(s.idleSec)}</b>Idling</div>
      <div class="stat"><b>${h.stops.length}</b>Stops</div></div>` : '')
      + (h.source === 'local' ? `<div class="err">Provider didn't answer (${esc(h.error)}). Showing positions saved by this dashboard.</div>` : '')
      + (!track.length ? '<p class="muted">No movement recorded on this day.</p>' : '');
    if (track.length) {
      const line = L.polyline(track.map((p) => [p[1], p[2]]), { color: '#2f6fde', weight: 4, opacity: 0.8 }).addTo(histLayer);
      L.circleMarker([track[0][1], track[0][2]], { radius: 6, color: '#1f9d55', fillOpacity: 1 }).addTo(histLayer).bindTooltip('Start');
      L.circleMarker([track.at(-1)[1], track.at(-1)[2]], { radius: 6, color: '#d64545', fillOpacity: 1 }).addTo(histLayer).bindTooltip('End');
      map.fitBounds(line.getBounds().pad(0.15));
      $('#hSlider').max = track.length - 1; $('#hSlider').value = 0;
      $('#hPlayer').hidden = false;
      playMarker = L.circleMarker([track[0][1], track[0][2]], { radius: 8, color: '#fff', weight: 3, fillColor: '#d98c00', fillOpacity: 1 }).addTo(histLayer);
      showPoint(0);
    } else $('#hPlayer').hidden = true;
    h.stops.forEach((st, i) => L.marker([st.lat, st.lng], { icon: L.divIcon({ className: '', html: `<div class="marker stopped" style="width:22px;height:22px;font-size:11px">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
      .addTo(histLayer).bindTooltip(`Stop ${i + 1}: ${fmtTime(st.start)} · ${st.duration}`));
    $('#hStops').innerHTML = h.stops.map((st, i) => `<div class="stop" data-lat="${st.lat}" data-lng="${st.lng}"><b>Stop ${i + 1}</b> · ${esc(st.duration)}<div class="muted">${esc(fmtTime(st.start))} to ${esc(fmtTime(st.end))}</div></div>`).join('');
    document.querySelectorAll('.stop').forEach((el) => el.addEventListener('click', () => map.setView([+el.dataset.lat, +el.dataset.lng], 17)));
  } catch (e) {
    $('#hSummary').innerHTML = `<div class="err">Couldn't load history: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Show trips';
  }
}
function showPoint(i) {
  const p = track[i]; if (!p || !playMarker) return;
  playMarker.setLatLng([p[1], p[2]]);
  $('#hTime').textContent = `${fmtTime(p[0])} · ${Math.round(p[3])} km/h`;
}
function stopPlay() { clearInterval(playTimer); playTimer = null; $('#hPlay').textContent = '▶'; }
$('#hPlay').addEventListener('click', () => {
  if (playTimer) return stopPlay();
  $('#hPlay').textContent = '❚❚';
  const step = Math.max(1, Math.round(track.length / 600));
  playTimer = setInterval(() => {
    const s = $('#hSlider');
    const i = Math.min(+s.value + step, track.length - 1);
    s.value = i; showPoint(i);
    if (i >= track.length - 1) stopPlay();
  }, 50);
});
$('#hSlider').addEventListener('input', (e) => showPoint(+e.target.value));
$('#hLoad').addEventListener('click', loadHistory);

// ---------- alerts ----------
const KIND = { offline: 'Offline', speeding: 'Speeding', night_use: 'Night use', power_cut: 'Power cut' };
async function loadAlerts() {
  try {
    const list = await api('api/alerts');
    const lastSeen = Number(localStorageGet('alertsSeen')) || 0;
    const unseen = list.filter((a) => a.t > lastSeen).length;
    $('#alertCount').hidden = !unseen; $('#alertCount').textContent = unseen;
    $('#alerts').innerHTML = list.length ? list.map((a) => {
      const k = a.kind.split(':')[0];
      const label = KIND[k] || (k === 'zone_exit' ? 'Left zone' : k === 'zone_enter' ? 'Arrived' : k);
      return `<div class="alert" data-lat="${a.lat}" data-lng="${a.lng}"><div class="kind ${k}">${esc(label)}</div>${esc(a.message)}<div class="muted">${esc(fmtTime(a.t))}</div></div>`;
    }).join('') : '<p class="muted">No alerts in the last 7 days.</p>';
    document.querySelectorAll('.alert').forEach((el) => el.addEventListener('click', () => { if (+el.dataset.lat) map.setView([+el.dataset.lat, +el.dataset.lng], 16); }));
  } catch { /* ignore */ }
}
function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// ---------- tabs ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  ['cars', 'history', 'alerts'].forEach((n) => { $(`#tab-${n}`).hidden = n !== t.dataset.tab; });
  if (t.dataset.tab !== 'history') { histLayer.clearLayers(); stopPlay(); }
  if (t.dataset.tab === 'alerts') { localStorageSet('alertsSeen', Date.now()); $('#alertCount').hidden = true; }
}));

refresh().then(loadToday);
loadAlerts();
setInterval(refresh, 15000);
setInterval(loadAlerts, 60000);
setInterval(loadToday, 10 * 60000);
