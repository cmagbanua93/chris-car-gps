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
  const c = { moving: 0, idle: 0, parked: 0, offline: 0 };
  state.vehicles.forEach((v) => { c[v.status] = (c[v.status] || 0) + 1; });
  const label = { moving: 'Moving', idle: 'Idling', parked: 'Parked', offline: 'Offline' };
  $('#tiles').innerHTML = Object.entries(c).map(([k, n]) => `<div class="tile"><b style="color:var(--${k})">${n}</b><span>${label[k]}</span></div>`).join('');
}

function renderCars() {
  if (!state.vehicles.length) {
    $('#cars').innerHTML = `<p class="muted">Waiting for the first update from your GPS accounts…</p>`;
    return;
  }
  const order = { moving: 0, idle: 1, parked: 2, offline: 3 };
  const list = [...state.vehicles].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  $('#cars').innerHTML = list.map((v) => {
    const s = v.sensors || {};
    const t = today[v.id];
    const ign = s.ignition == null ? '—' : s.ignition ? 'On' : 'Off';
    const eng = engineLine(v);
    const pv = s.powerV ?? v.carVoltage;
    const power = pv != null ? `${pv} V` : '—';
    return `<div class="car ${selected === v.id ? 'sel' : ''}" data-id="${esc(v.id)}">
      <div class="row"><div><h3>${esc(v.name)}</h3><div class="plate">${esc(v.plate && v.plate !== v.name ? v.plate + ' · ' : '')}${esc(v.source)}</div></div>
      <span class="pill ${v.status}">${pillText(v)}</span></div>
      ${eng ? `<div class="engine ${eng.cls}">${eng.html}</div>` : ''}
      <div class="stats">
        <div class="stat"><b>${Math.round(v.speed)} km/h</b>Speed</div>
        <div class="stat"><b>${ign}</b>Engine</div>
        <div class="stat"><b>${power}</b>Car battery</div>
        <div class="stat"><b>${t && !t.error ? t.distanceKm.toFixed(1) + ' km' : '—'}</b>Today</div>
        <div class="stat"><b>${t && !t.error ? dur(t.drivingSec) : '—'}</b>Driving today</div>
        <div class="stat"><b>${ago(v.serverTime || v.trackerTime)}</b>Last update</div>
      </div>
      ${v.address ? `<div class="addr">${esc(v.address)}</div>` : ''}
      ${detailsHtml(v)}
    </div>`;
  }).join('');
  document.querySelectorAll('.car').forEach((el) => el.addEventListener('click', (ev) => { if (ev.target.closest('details')) return; focusCar(el.dataset.id); }));
  document.querySelectorAll('details.more').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openDetails.add(d.dataset.id); else openDetails.delete(d.dataset.id); }));
}

const openDetails = new Set();
function bars(n, max = 5) {
  if (n == null) return '—';
  const lvl = Math.max(0, Math.min(max, Math.round(n)));
  return `<span class="bars" title="${n} of ${max}">${Array.from({ length: max }, (_, i) => `<i class="${i < lvl ? 'on' : ''}" style="height:${4 + i * 3}px"></i>`).join('')}</span>`;
}
function detailsHtml(v) {
  const rows = [];
  if (v.sim) rows.push(['Tracker SIM', `<a href="tel:${esc(v.sim)}">${esc(v.sim)}</a> · <a href="sms:${esc(v.sim)}">SMS</a>`]);
  if (v.plate && v.plate !== v.name) rows.push(['Plate', esc(v.plate)]);
  if (v.group) rows.push(['Group', esc(v.group)]);
  if (v.odometerKm) rows.push(['Odometer', `${Math.round(v.odometerKm).toLocaleString()} km`]);
  rows.push(['GSM signal', bars(v.gsm)]);
  if (v.satellites != null) rows.push(['GPS satellites', String(v.satellites)]);
  if (v.trackerBatteryV != null) rows.push(['Tracker battery', `${v.trackerBatteryV} V${v.trackerBatteryV < 3.7 ? ' <span class="tag off">low</span>' : ''}`]);
  rows.push(['Engine signal', esc(v.ignitionSource || '—')]);
  rows.push(['Tracker', `${esc(v.protocol || 'GPS')} · IMEI ${esc(v.imei)}`]);
  rows.push(['Provider', esc(v.source)]);
  const days = (v.dailyKm || []).slice().reverse();
  const max = Math.max(1, ...days.map((d) => d.km));
  const chart = days.length ? `<div class="daykm">${days.map((d) => `<div class="dk"><div class="dkbar" style="height:${Math.round((d.km / max) * 40)}px" title="${d.km} km"></div><b>${d.km}</b><span>${d.day}</span></div>`).join('')}</div><div class="muted" style="text-align:center">km per day (date of month), last ${days.length} days</div>` : '';
  return `<details class="more" data-id="${esc(v.id)}" ${openDetails.has(v.id) ? 'open' : ''}><summary>Car details</summary>
    <dl>${rows.map(([k, val]) => `<dt>${k}</dt><dd>${val}</dd>`).join('')}</dl>${chart}</details>`;
}

function pillText(v) {
  if (v.status === 'idle') return 'Idling';
  if (v.status === 'parked') return v.engine?.on === false ? 'Engine off' : 'Parked';
  return v.status === 'moving' ? 'Moving' : 'Offline';
}

function engineLine(v) {
  const e = v.engine || {};
  const est = /estimated/.test(v.ignitionSource || '') ? ' <span class="muted">(estimated)</span>' : '';
  if (e.on === null || e.on === undefined) return v.status === 'offline' ? null : { cls: 'muted', html: 'Engine on/off is not reported by this tracker' };
  if (e.on && e.idleSince) {
    const min = Math.max(1, Math.round((Date.now() - e.idleSince) / 60000));
    const warn = min >= (state.config.idleAlertMinutes || 10);
    return { cls: warn ? 'warn' : 'idle', html: `Idling with engine on for <b>${dur(min * 60)}</b>${warn ? ' (left running?)' : ''}${est}` };
  }
  if (e.on) return { cls: 'on', html: `Engine on${e.since ? ` since ${esc(fmtTime(e.since))}` : ''}${est}` };
  return { cls: 'off', html: `Engine off${e.since ? ` since ${esc(fmtTime(e.since))} · ${dur((Date.now() - e.since) / 1000)}` : ''}${est}` };
}

const STATUS_COLOR = { moving: '#1f9d55', idle: '#d98c00', parked: '#4a6fa5', offline: '#9aa1ad' };
// Top-down car, nose pointing up; rotated to the heading so it turns like the car icon in Google Maps navigation.
function carSvg(color, angle) {
  return `<div class="carmark" style="transform: rotate(${angle}deg)"><svg viewBox="0 0 40 40" width="40" height="40">
    <rect x="11" y="3" width="18" height="34" rx="7" fill="${color}" stroke="#fff" stroke-width="2"/>
    <path d="M13.5 13 Q20 9.5 26.5 13 L25 18 Q20 16.5 15 18 Z" fill="#cfe3ff" opacity=".95"/>
    <path d="M15 29 Q20 30.5 25 29 L26 33 Q20 35 14 33 Z" fill="#cfe3ff" opacity=".8"/>
    <rect x="13" y="19" width="14" height="9" rx="2" fill="#000" opacity=".12"/>
    <circle cx="14.5" cy="5.8" r="1.4" fill="#fff6b0"/><circle cx="25.5" cy="5.8" r="1.4" fill="#fff6b0"/>
  </svg></div>`;
}
function icon(v) {
  return L.divIcon({ className: '', html: carSvg(STATUS_COLOR[v.status] || '#4a6fa5', v.angle || 0), iconSize: [40, 40], iconAnchor: [20, 20] });
}

function renderMarkers() {
  const seen = new Set();
  for (const v of state.vehicles) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lng)) continue;
    seen.add(v.id);
    let m = markers.get(v.id);
    const popup = `<b>${esc(v.name)}</b><br>${Math.round(v.speed)} km/h · ${pillText(v)}<br>${esc(fmtTime(v.trackerTime))}<br><a href="https://maps.google.com/?q=${v.lat},${v.lng}" target="_blank" rel="noopener">Open in Google Maps</a>`;
    if (!m) {
      m = L.marker([v.lat, v.lng], { icon: icon(v) }).addTo(map).bindTooltip(v.name, { permanent: true, direction: 'top', offset: [0, -18], className: 'lbl' });
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
  if (!$('#hDate').value) setDate(state.config.today, false);
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
      <div class="stat"><b>${h.engine ? dur(s.idleSec) : '—'}</b>Idling (engine on)</div>
      <div class="stat"><b>${(h.timeline || []).filter((x) => x.kind === 'parked').length}</b>Times parked</div></div>` : '')
      + (h.ignitionSource && /estimated/.test(h.ignitionSource) ? `<p class="muted">Engine on/off for this car is ${esc(h.ignitionSource)}.</p>` : '')
      + (h.engine ? `<div class="summary">
        <div class="stat"><b>${dur(h.engine.engineOnSec)}</b>Engine on</div>
        <div class="stat"><b>${h.engine.events.filter((e) => e.kind === 'engine_off').length}</b>Times turned off</div>
        <div class="stat"><b>${h.engine.idle.length}</b>Idle periods</div></div>` : (h.ignitionSource ? `<p class="muted">Engine on/off: ${esc(h.ignitionSource)}.</p>` : ''))
      + (h.source === 'local' ? `<div class="err">Provider didn't answer (${esc(h.error)}). Showing positions saved by this dashboard.</div>` : '')
      + (!track.length ? '<p class="muted">No movement recorded on this day.</p>' : '');
    if (track.length) {
      const line = L.polyline(track.map((p) => [p[1], p[2]]), { color: '#2f6fde', weight: 4, opacity: 0.8 }).addTo(histLayer);
      L.circleMarker([track[0][1], track[0][2]], { radius: 6, color: '#1f9d55', fillOpacity: 1 }).addTo(histLayer).bindTooltip('Start');
      L.circleMarker([track.at(-1)[1], track.at(-1)[2]], { radius: 6, color: '#d64545', fillOpacity: 1 }).addTo(histLayer).bindTooltip('End');
      map.fitBounds(line.getBounds().pad(0.15));
      $('#hSlider').max = track.length - 1; $('#hSlider').value = 0;
      $('#hPlayer').hidden = false;
      playMarker = L.marker([track[0][1], track[0][2]], { icon: L.divIcon({ className: '', html: carSvg('#d98c00', 0), iconSize: [40, 40], iconAnchor: [20, 20] }), zIndexOffset: 1000 }).addTo(histLayer);
      showPoint(0);
    } else $('#hPlayer').hidden = true;
    // Engine-off points on the map
    (h.engine?.offPeriods || []).forEach((p) => L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', html: '<div class="marker offmark">⏻</div>', iconSize: [24, 24], iconAnchor: [12, 12] }) })
      .addTo(histLayer).bindTooltip(`Engine off at ${fmtTime(p.start)} for ${dur(p.seconds)}${p.ongoing ? ' (still off)' : ''}`));
    renderTimeline(h);
  } catch (e) {
    $('#hSummary').innerHTML = `<div class="err">Couldn't load history: ${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false; btn.textContent = 'Show trips';
  }
}
const ICONS = {
  start: '<span class="ti ti-start">▶</span>',
  parked: '<span class="ti ti-park">P</span>',
  drive: '<span class="ti ti-drive"><svg viewBox="0 0 24 24" width="22" height="22"><circle cx="5" cy="5" r="0" /><path d="M5 5 C 9 9, 9 13, 13 15 S 18 18, 19 19" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3"/><path d="M2 2 L8 8 M8 2 L2 8" stroke="#d64545" stroke-width="2.4"/><path d="M16 16 L22 22 M22 16 L16 22" stroke="#7cb342" stroke-width="2.4"/></svg></span>',
};
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
const longDur = (sec) => {
  sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : '', !h && s ? `${s} s` : ''].filter(Boolean).join(' ') || '0 s';
};
let segLayer = null;
function renderTimeline(h) {
  const items = h.timeline || [];
  if (!items.length) { $('#hStops').innerHTML = ''; return; }
  let parkNo = 0;
  items.forEach((it) => {
    if (it.kind !== 'parked') return;
    parkNo++;
    L.marker([it.lat, it.lng], { icon: L.divIcon({ className: '', html: `<div class="pmark">P</div>`, iconSize: [22, 26], iconAnchor: [11, 26] }) })
      .addTo(histLayer).bindTooltip(`Parked ${clock(it.t)} · ${longDur(it.seconds)}`);
  });
  const rows = items.map((it, i) => {
    let extra = '';
    if (it.kind === 'parked' && it.engineOnSec != null) {
      if (it.engineOnSec >= 60) {
        const all = it.engineOnSec >= it.seconds - 60;
        extra = all ? `<span class="tag idle">Idling the whole time (engine on)</span>`
          : `<span class="tag idle">Idle ${longDur(it.engineOnSec)}</span> <span class="tag off">Engine off ${longDur(it.seconds - it.engineOnSec)}</span>`;
      } else extra = `<span class="tag off">Engine off ${longDur(it.seconds)}</span>`;
    }
    if (it.kind === 'drive') extra = `<span class="muted">${it.km} km · max ${it.topSpeed} km/h</span>`;
    const durTxt = it.kind === 'start' ? '' : longDur(it.seconds);
    return `<div class="tl" data-i="${i}">
      ${ICONS[it.kind]}
      <span class="tl-time">${esc(dateOf(it.t))} ${esc(clock(it.t))}</span>
      <span class="tl-dur">${esc(durTxt)}</span>
      <div class="tl-extra">${extra}</div>
    </div>`;
  }).join('');
  $('#hStops').innerHTML = `<div class="tl-head">Information</div>${rows}`;
  document.querySelectorAll('.tl').forEach((el) => el.addEventListener('click', () => {
    document.querySelectorAll('.tl').forEach((x) => x.classList.toggle('sel', x === el));
    const it = items[+el.dataset.i];
    if (segLayer) { histLayer.removeLayer(segLayer); segLayer = null; }
    if (it.kind === 'drive') {
      const pts = track.filter((p) => p[0] >= it.t && p[0] <= it.end).map((p) => [p[1], p[2]]);
      if (pts.length > 1) { segLayer = L.polyline(pts, { color: '#d64545', weight: 6 }).addTo(histLayer); map.fitBounds(segLayer.getBounds().pad(0.2)); }
    } else map.setView([it.lat, it.lng], 17);
    const idx = track.findIndex((p) => p[0] >= it.t);
    if (idx >= 0) { $('#hSlider').value = idx; showPoint(idx); }
  }));
}

function showPoint(i) {
  const p = track[i]; if (!p || !playMarker) return;
  playMarker.setLatLng([p[1], p[2]]);
  const q = track[Math.min(i + 1, track.length - 1)];
  if (q && (q[1] !== p[1] || q[2] !== p[2])) {
    const r = Math.PI / 180, y = Math.sin((q[2] - p[2]) * r) * Math.cos(q[1] * r), x = Math.cos(p[1] * r) * Math.sin(q[1] * r) - Math.sin(p[1] * r) * Math.cos(q[1] * r) * Math.cos((q[2] - p[2]) * r);
    const el = playMarker.getElement()?.querySelector('.carmark');
    if (el) el.style.transform = `rotate(${(Math.atan2(y, x) / r + 360) % 360}deg)`;
  }
  $('#hTime').textContent = `${fmtTime(p[0])} · ${Math.round(p[3])} km/h${p[4] === true ? ' · engine on' : p[4] === false ? ' · engine off' : ''}`;
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

// ---------- date picker ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let calMonth = null; // [year, monthIndex]
const pad = (n) => String(n).padStart(2, '0');
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
function todayYmd() { return state.config.today || new Date().toISOString().slice(0, 10); }
function setDate(v, load = true) {
  $('#hDate').value = v;
  const [y, m, d] = v.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
  $('#hDateText').textContent = v === todayYmd() ? `Today, ${MONTHS[m - 1].slice(0, 3)} ${d}` : `${wd}, ${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
  $('#hNext').disabled = v >= todayYmd();
  if (load && $('#hCar').value) loadHistory();
}
function shiftDate(days) {
  const [y, m, d] = $('#hDate').value.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const v = t.toISOString().slice(0, 10);
  if (v <= todayYmd()) setDate(v);
}
function renderCal() {
  const [y, m] = calMonth;
  const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const sel = $('#hDate').value, today = todayYmd();
  let cells = '';
  for (let i = 0; i < first; i++) cells += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const v = ymd(y, m, d);
    cells += `<button type="button" data-v="${v}" class="${v === sel ? 'sel' : ''} ${v === today ? 'today' : ''}" ${v > today ? 'disabled' : ''}>${d}</button>`;
  }
  const nextDisabled = ymd(y, m + 1 > 11 ? 0 : m + 1, 1) > today && (y > Number(today.slice(0, 4)) || m >= Number(today.slice(5, 7)) - 1);
  $('#cal').innerHTML = `<div class="cal-head"><button type="button" class="icon" data-nav="-1" aria-label="Previous month">‹</button>
      <b>${MONTHS[m]} ${y}</b><button type="button" class="icon" data-nav="1" aria-label="Next month" ${nextDisabled ? 'disabled' : ''}>›</button></div>
    <div class="cal-grid">${['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((w) => `<i>${w}</i>`).join('')}${cells}</div>
    <div class="cal-quick"><button type="button" data-q="0">Today</button><button type="button" data-q="-1">Yesterday</button><button type="button" data-q="-6">7 days ago</button></div>`;
}
function openCal() {
  const [y, m] = ($('#hDate').value || todayYmd()).split('-').map(Number);
  calMonth = [y, m - 1];
  renderCal();
  $('#cal').hidden = false;
}
$('#hDateBtn').addEventListener('click', (e) => { e.stopPropagation(); if ($('#cal').hidden) openCal(); else $('#cal').hidden = true; });
$('#cal').addEventListener('click', (e) => {
  e.stopPropagation();
  const b = e.target.closest('button'); if (!b || b.disabled) return;
  if (b.dataset.nav) { let [y, m] = calMonth; m += Number(b.dataset.nav); if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } calMonth = [y, m]; renderCal(); return; }
  if (b.dataset.q) { const [y, m, d] = todayYmd().split('-').map(Number); setDate(new Date(Date.UTC(y, m - 1, d + Number(b.dataset.q))).toISOString().slice(0, 10)); $('#cal').hidden = true; return; }
  if (b.dataset.v) { setDate(b.dataset.v); $('#cal').hidden = true; }
});
document.addEventListener('click', () => { $('#cal').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#cal').hidden = true; });
$('#hPrev').addEventListener('click', () => shiftDate(-1));
$('#hNext').addEventListener('click', () => shiftDate(1));

// ---------- alerts ----------
const KIND = { offline: 'Offline', speeding: 'Speeding', night_use: 'Night use', power_cut: 'Power cut', idle_long: 'Left running' };
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
