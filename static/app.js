const $ = (s) => document.querySelector(s);

const PALETTE = [
  "#4cc9f0", "#f72585", "#ffd166", "#06d6a0", "#ef476f", "#118ab2",
  "#fb8500", "#8338ec", "#2a9d8f", "#e63946", "#457b9d", "#ff70a6",
  "#70e000", "#9d4edd", "#00b4d8", "#f4a261",
];

const METRICS = {
  speed: { label: "Velocità (km/h)", short: "Velocità", conv: (v) => v * 3.6, color: "#4c9df0" },
  pace: { label: "Passo (min/km)", short: "Passo", color: "#a3e635", fmt: (v) => fmtPace(v) },
  hr: { label: "Frequenza cardiaca (bpm)", short: "HR", color: "#ef476f", fmt: (v) => String(Math.round(v)) },
  hrpace: { label: "Efficienza EF (velocità m/min ÷ FC, più alto = meglio)", short: "Efficienza", color: "#f472b6", fmt: (v) => v.toFixed(2) },
  cadence: { label: "Cadenza (rpm)", short: "Cadenza", color: "#9d4edd", fmt: (v) => String(Math.round(v)) },
  altitude: { label: "Altitudine (m)", short: "Altitudine", color: "#06d6a0" },
  power: { label: "Potenza (W)", short: "Potenza", color: "#fb8500", fmt: (v) => String(Math.round(v)) },
  temp: { label: "Temperatura (°C)", short: "Temperatura", color: "#00b4d8" },
  gradient: { label: "Pendenza (%)", short: "Pendenza", color: "#ffd166" },
  profile: { label: "Profilo quota (m)", short: "Quota", color: "#9aa7b4", fmt: (v) => `${Math.round(v)} m`, area: true },
};

const ACTIVITY_DASH = [[], [7, 4], [2, 3], [10, 3, 2, 3], [5, 2], [3, 3], [12, 4], [1, 3]];

const state = {
  activities: [],
  segments: [],
  status: null,
  activity: null,
  track: null,
  segment: { startIdx: null, endIdx: null },
  picking: null,
  map: null,
  layers: {},
  passLayers: {},
  results: [],
  selected: new Set(),
  lastSearch: null,
  currentSegmentId: null,
  sliceCache: {},
  profileCache: null,
  compareAdded: new Set(),
  availableMetrics: [],
  metricEnabled: { speed: true },
  defaultSports: { compare: "", analysis: "", trend: "" },
  tab: "analysis",
  layout: "vertical",
  xAxis: "dist",
  compareSingle: false,
  trendSort: localStorage.getItem("sf-trend-sort") || "date_asc",
  trend: { available: [], enabled: {} },
  trendCache: {},
  trendChart: null,
  trendRange: null,
  trendRangeAll: null,
  analysis: { available: [], enabled: {}, xAxis: "dist", single: false, slice: null, baseIdx: null },
  analysisTimer: null,
  resultsBaseIdx: null,
  charts: [],
  hoverX: null,
  zoom: null,
  dragZoom: null,
  chartCfg: { height: 250, gap: 18, xScale: 100, yScale: 100, font: 11 },
  csTimer: null,
  scanTimer: null,
  source: localStorage.getItem("sf-source") || "local",
  compareSort: localStorage.getItem("sf-compare-sort") || "time",
  compareDateFrom: "",
  compareDateTo: "",
  maxChartKey: null,
  segmentFromZoom: false,
  preZoomSegment: null,
  panelFrac: {
    split: parseFloat(localStorage.getItem("sf-panel-split")) || 0.5,
    vertical: parseFloat(localStorage.getItem("sf-panel-vertical")) || 0.54,
  },
  garmin: { status: null, timer: null },
};

function toast(msg, ms = 4000) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), ms);
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      if (j.detail) msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function dashSwatchSvg(dash, color) {
  const d = dash && dash.length ? dash.join(" ") : "none";
  return `<svg width="26" height="10" class="dash-swatch"><line x1="1" y1="5" x2="25" y2="5" stroke="${color}" stroke-width="2.5" stroke-dasharray="${d}" stroke-linecap="round"/></svg>`;
}

function fmtDuration(s) {
  if (s == null || !isFinite(s)) return "—";
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtDist(m) {
  if (m == null || !isFinite(m)) return "—";
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  return `${Math.round(m)} m`;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtSpeed(mps) {
  if (mps == null || !isFinite(mps)) return "—";
  return `${(mps * 3.6).toFixed(1)} km/h`;
}

const WEEKDAYS_IT = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

function activityLabel(startTime, fallback) {
  const d = startTime ? new Date(startTime) : null;
  if (!d || isNaN(d)) return (fallback || "").replace(/\.fit$/i, "") || "—";
  const wd = WEEKDAYS_IT[d.getDay()];
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${wd}_${dd}_${mm}_${d.getFullYear()}`;
}

const SPORT_ALIASES = {
  running: ["run", "trail_running", "treadmill_running", "track_running", "corsa"],
  cycling: [
    "bike", "biking", "road_biking", "mountain_biking", "gravel_cycling", "virtual_ride",
    "indoor_cycling", "e_bike_fitness", "e_bike_mountain", "commuting", "bici",
    "ciclismo indoor", "ciclismo virtuale",
  ],
  walking: ["casual_walking", "speed_walking", "camminata"],
  hiking: ["mountaineering", "escursionismo", "alpinismo"],
  swimming: ["lap_swimming", "open_water_swimming", "nuoto"],
};

const SPORT_LABELS = {
  running: "Corsa",
  cycling: "Bici",
  walking: "Camminata",
  hiking: "Escursionismo",
  swimming: "Nuoto",
  multi_sport: "Multi sport",
  fitness_equipment: "Indoor / fitness",
  generic: "Generico",
  generico: "Generico",
  other: "Altro",
};

function sportKey(sport) {
  const s = String(sport || "").trim().toLowerCase();
  if (!s) return "";
  for (const [key, aliases] of Object.entries(SPORT_ALIASES)) {
    if (key === s || aliases.includes(s)) return key;
  }
  return s;
}

function sportLabel(sport) {
  const key = sportKey(sport);
  return SPORT_LABELS[key] || sport || key;
}

/* ---------------- MAP ---------------- */

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([45.5, 9.2], 11);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);
  state.layers.source = L.layerGroup().addTo(state.map);
  state.layers.passes = L.layerGroup().addTo(state.map);
  state.layers.segment = L.layerGroup().addTo(state.map);
  state.layers.cursor = L.layerGroup().addTo(state.map);
  state.map.on("click", onMapClick);
}

function segIcon(color, text) {
  return L.divIcon({
    className: "seg-marker",
    html: `<span style="background:${color}">${text}</span>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function latlngsFrom(data, fromIdx, toIdx) {
  const pts = [];
  const a = fromIdx == null ? 0 : Math.max(0, fromIdx);
  const b = toIdx == null ? data.lat.length - 1 : Math.min(data.lat.length - 1, toIdx);
  for (let i = a; i <= b; i++) {
    if (data.lat[i] != null && data.lon[i] != null) pts.push([data.lat[i], data.lon[i]]);
  }
  return pts;
}

function drawSourceTrack() {
  state.layers.source.clearLayers();
  if (!state.track) return;
  const pts = latlngsFrom(state.track);
  if (!pts.length) return;
  L.polyline(pts, { color: "#4cc9f0", weight: 3, opacity: 0.8 }).addTo(state.layers.source);
  state.map.fitBounds(L.polyline(pts).getBounds(), { padding: [30, 30] });
}

/* ---------------- ACTIVITIES ---------------- */

async function loadStatus() {
  state.status = await api("/api/status");
  const s = state.status.scan;
  if (s && s.running) {
    pollScan();
    return;
  }
  setScanRunning(false);
  if (s && !s.running && s.finished_at) {
    const parts = [];
    parts.push(`${s.indexed || 0} nuovi`);
    parts.push(`${s.updated || 0} aggiornati`);
    parts.push(`${s.skipped || 0} invariati`);
    if (s.removed) parts.push(`${s.removed} rimossi`);
    if (s.failed) parts.push(`${s.failed} errori`);
    if (s.error) parts.push(`errore: ${s.error}`);
    $("#scan-status").textContent = `Ultima scansione: ${parts.join(", ")}`;
  }
}

async function loadActivities() {
  state.activities = await api("/api/activities");
  renderSportFilter();
  renderActivities();
}

function renderSportFilter() {
  const sel = $("#activity-sport");
  if (!sel) return;
  const saved = sel.value || localStorage.getItem("sf-sport-filter") || "";
  const labels = new Map();
  for (const a of state.activities) {
    const key = sportKey(a.sport);
    if (!key) continue;
    if (!labels.has(key)) labels.set(key, sportLabel(a.sport));
  }
  const order = ["running", "cycling", "walking", "hiking", "swimming"];
  const entries = [...labels.entries()].sort((x, y) => {
    const ix = order.indexOf(x[0]);
    const iy = order.indexOf(y[0]);
    if (ix !== -1 || iy !== -1) return (ix === -1 ? 99 : ix) - (iy === -1 ? 99 : iy);
    return x[1].localeCompare(y[1], "it");
  });
  sel.innerHTML = '<option value="">Tutti gli sport</option>';
  for (const [key, label] of entries) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
}

function renderActivities() {
  const list = $("#activity-list");
  list.innerHTML = "";
  const filter = $("#activity-filter").value.trim().toLowerCase();
  const sport = $("#activity-sport") ? $("#activity-sport").value : "";
  const items = state.activities.filter((a) => {
    if (sport && sportKey(a.sport) !== sport) return false;
    return (
      !filter ||
      `${a.filename} ${a.sport || ""} ${a.start_time || ""} ${activityLabel(a.start_time, a.filename)}`.toLowerCase().includes(filter)
    );
  });
  $("#activity-count").textContent = `${items.length}/${state.activities.length}`;
  for (const a of items) {
    const li = document.createElement("li");
    li.className = "activity" + (state.activity && state.activity.id === a.id ? " active" : "") + (a.error ? " error" : "");
    const title = document.createElement("div");
    title.className = "a-title";
    title.textContent = activityLabel(a.start_time, a.filename);
    const sub = document.createElement("div");
    sub.className = "a-sub";
    sub.textContent = `${a.sport || "—"} · ${fmtDist(a.distance_m)} · ${fmtDuration(a.duration_s)}`;
    li.title = a.filename;
    li.appendChild(title);
    li.appendChild(sub);
    if (a.error) {
      const e = document.createElement("div");
      e.className = "a-err";
      e.textContent = `errore: ${a.error}`;
      li.appendChild(e);
    } else if (!a.has_gps) {
      const e = document.createElement("div");
      e.className = "a-err";
      e.textContent = "nessun dato GPS";
      li.appendChild(e);
    }
    li.onclick = () => selectActivity(a.id);
    list.appendChild(li);
  }
}

async function selectActivity(id, opts = {}) {
  const meta = state.activities.find((a) => a.id === id);
  if (!meta) return;
  state.activity = meta;
  try {
    state.track = await api(`/api/activities/${id}/track`);
  } catch (e) {
    toast(`Impossibile caricare la traccia: ${e.message}`);
    return;
  }
  if (!opts.keepSegment) {
    state.segment = { startIdx: null, endIdx: null };
    state.results = [];
    state.resultsBaseIdx = null;
    state.selected = new Set();
    state.lastSearch = null;
    state.currentSegmentId = null;
    state.picking = null;
    renderResults();
    drawPasses();
  }
  renderActivities();
  drawSourceTrack();
  resetAnalysis();
  if (!opts.keepSegment) updateSegmentUI();
  if (!meta.has_gps) toast("Questa attività non contiene punti GPS");
}

/* ---------------- SEGMENT ---------------- */

function nearestTrackIdx(lat, lon) {
  const t = state.track;
  if (!t) return null;
  let best = -1;
  let bestD = Infinity;
  const cos = Math.cos((lat * Math.PI) / 180);
  for (let i = 0; i < t.lat.length; i++) {
    const la = t.lat[i];
    const lo = t.lon[i];
    if (la == null || lo == null) continue;
    const dy = (la - lat) * 111320;
    const dx = (lo - lon) * 111320 * cos;
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? { idx: best, dist: bestD } : null;
}

function onMapClick(e) {
  if (!state.picking || !state.track) return;
  const snap = nearestTrackIdx(e.latlng.lat, e.latlng.lng);
  if (!snap || snap.dist > 100) {
    toast("Clicca più vicino alla traccia dell'attività");
    return;
  }
  if (state.picking === "start") {
    state.segment.startIdx = snap.idx;
    state.segment.endIdx = null;
    state.picking = "end";
    toast("Ora clicca il punto di FINE");
  } else {
    state.segment.endIdx = snap.idx;
    state.picking = null;
  }
  normalizeSegmentOrder();
  updateSegmentUI();
}

function normalizeSegmentOrder() {
  const s = state.segment;
  if (s.startIdx != null && s.endIdx != null && s.startIdx > s.endIdx) {
    const tmp = s.startIdx;
    s.startIdx = s.endIdx;
    s.endIdx = tmp;
  }
}

function clearSegment() {
  state.segment = { startIdx: null, endIdx: null };
  state.picking = null;
  state.results = [];
  state.resultsBaseIdx = null;
  state.selected = new Set();
  state.lastSearch = null;
  state.currentSegmentId = null;
  renderResults();
  drawPasses();
  updateSegmentUI();
}

function nudge(which, delta) {
  const t = state.track;
  if (!t) return;
  const key = which === "start" ? "startIdx" : "endIdx";
  if (state.segment[key] == null) return;
  state.segment[key] = Math.max(0, Math.min(t.lat.length - 1, state.segment[key] + delta));
  normalizeSegmentOrder();
  updateSegmentUI();
}

function updateSegmentUI(opts = {}) {
  if (!opts.keepZoom) {
    if (state.zoom) {
      resetZoomState();
      applyZoomToCharts();
    }
    state.segmentFromZoom = false;
    state.preZoomSegment = null;
  }
  const t = state.track;
  const s = state.segment;
  const has = t && s.startIdx != null && s.endIdx != null;
  $("#btn-save-segment").disabled = !has;
  $("#btn-search").disabled = !has;
  $("#btn-recalc").classList.toggle("hidden", !state.currentSegmentId);
  if (!t) {
    $("#seg-info").textContent = "Seleziona un'attività dalla lista, poi clicca \"Seleziona sulla mappa\" e indica inizio e fine sulla traccia.";
    $("#seg-fine").classList.add("hidden");
    drawSegment();
    updateSlider();
    scheduleAnalysisRefresh();
    return;
  }
  if (!has) {
    $("#seg-info").textContent = state.picking
      ? `Clicca il punto di ${state.picking === "start" ? "INIZIO" : "FINE"} sulla mappa.`
      : "Clicca \"Seleziona sulla mappa\" e indica inizio e fine sulla traccia.";
    $("#seg-fine").classList.add("hidden");
  } else {
    const d = t.dist[s.endIdx] - t.dist[s.startIdx];
    const dur = t.t[s.endIdx] - t.t[s.startIdx];
    const saved = state.currentSegmentId ? ` · <span class="ok">segmento salvato #${state.currentSegmentId}</span>` : "";
    $("#seg-info").innerHTML = `Lunghezza <b>${fmtDist(d)}</b> · ${s.endIdx - s.startIdx + 1} punti · durata sorgente ${fmtDuration(dur)}${saved}`;
    $("#seg-fine").classList.remove("hidden");
  }
  drawSegment();
  updateSlider();
  scheduleAnalysisRefresh();
}

function updateSlider() {
  const wrap = $("#range-wrap");
  const t = state.track;
  if (!t || !t.t.length) {
    wrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  const n = t.t.length;
  const s = state.segment;
  const si = s.startIdx == null ? 0 : s.startIdx;
  const ei = s.endIdx == null ? n - 1 : s.endIdx;
  const total = t.t[n - 1] || 1;
  const pf = (total > 0 ? t.t[si] / total : 0) * 100;
  const pe = (total > 0 ? t.t[ei] / total : 1) * 100;
  $("#rs-handle-start").style.left = pf + "%";
  $("#rs-handle-end").style.left = pe + "%";
  $("#rs-fill").style.left = pf + "%";
  $("#rs-fill").style.width = Math.max(0, pe - pf) + "%";
  $("#rs-start-label").textContent = fmtDuration(t.t[si]);
  $("#rs-end-label").textContent = fmtDuration(t.t[ei]);
  const has = s.startIdx != null && s.endIdx != null;
  $("#rs-info").textContent = has
    ? `${fmtDuration(t.t[ei] - t.t[si])} · ${fmtDist(t.dist[ei] - t.dist[si])}`
    : "trascina gli estremi per isolare un segmento";
}

function initRangeSlider() {
  const slider = $("#range-slider");
  const fill = $("#rs-fill");
  const handles = { start: $("#rs-handle-start"), end: $("#rs-handle-end") };
  let drag = null;
  let moveDrag = null;

  const fracFromEvent = (e) => {
    const rect = slider.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const idxFromValue = (target) => {
    const t = state.track.t;
    const n = t.length;
    if (n < 2) return 0;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(t[lo - 1] - target) <= Math.abs(t[lo] - target)) return lo - 1;
    return lo;
  };

  const idxFromFrac = (f) => {
    const t = state.track.t;
    const n = t.length;
    if (n < 2) return 0;
    return idxFromValue(f * t[n - 1]);
  };

  const apply = (which, idx) => {
    const n = state.track.t.length;
    const s = state.segment;
    if (which === "start") {
      const end = s.endIdx == null ? n - 1 : s.endIdx;
      s.startIdx = Math.max(0, Math.min(idx, end - 1));
      if (s.endIdx == null) s.endIdx = n - 1;
    } else {
      const start = s.startIdx == null ? 0 : s.startIdx;
      s.endIdx = Math.max(start + 1, Math.min(idx, n - 1));
      if (s.startIdx == null) s.startIdx = 0;
    }
    normalizeSegmentOrder();
    updateSegmentUI();
  };

  const beginDrag = (which, e) => {
    if (!state.track) return;
    drag = which;
    handles[which].classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const beginMove = (e) => {
    const t = state.track.t;
    const s = state.segment;
    if (s.startIdx == null || s.endIdx == null) return;
    moveDrag = {
      startFrac: fracFromEvent(e),
      startT: t[s.startIdx],
      endT: t[s.endIdx],
    };
    fill.classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const moveSelection = (e) => {
    const t = state.track.t;
    const last = t[t.length - 1] || 1;
    const deltaT = (fracFromEvent(e) - moveDrag.startFrac) * last;
    const dur = moveDrag.endT - moveDrag.startT;
    let startT = moveDrag.startT + deltaT;
    let endT = moveDrag.endT + deltaT;
    if (startT < t[0]) {
      startT = t[0];
      endT = startT + dur;
    }
    if (endT > last) {
      endT = last;
      startT = endT - dur;
    }
    const i1 = idxFromValue(startT);
    const i2 = idxFromValue(endT);
    const s = state.segment;
    s.startIdx = Math.min(i1, i2);
    s.endIdx = Math.max(i1, i2);
    updateSegmentUI();
  };

  handles.start.addEventListener("pointerdown", (e) => beginDrag("start", e));
  handles.end.addEventListener("pointerdown", (e) => beginDrag("end", e));

  slider.addEventListener("pointermove", (e) => {
    if (!state.track) return;
    if (drag) apply(drag, idxFromFrac(fracFromEvent(e)));
    else if (moveDrag) moveSelection(e);
  });

  const stop = () => {
    if (drag) {
      handles[drag].classList.remove("dragging");
      drag = null;
    }
    if (moveDrag) {
      fill.classList.remove("dragging");
      moveDrag = null;
    }
  };
  slider.addEventListener("pointerup", stop);
  slider.addEventListener("pointercancel", stop);

  slider.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("rs-handle") || !state.track) return;
    const s = state.segment;
    if (e.target.classList.contains("rs-fill") && s.startIdx != null && s.endIdx != null) {
      beginMove(e);
      return;
    }
    const t = state.track.t;
    const n = t.length;
    const idx = idxFromFrac(fracFromEvent(e));
    const si = s.startIdx == null ? 0 : s.startIdx;
    const ei = s.endIdx == null ? n - 1 : s.endIdx;
    const which = Math.abs(idx - si) <= Math.abs(idx - ei) ? "start" : "end";
    drag = which;
    handles[which].classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    apply(which, idx);
  });
}

function drawSegment() {
  state.layers.segment.clearLayers();
  const t = state.track;
  const s = state.segment;
  if (!t) return;
  const hasStart = s.startIdx != null;
  const hasEnd = s.endIdx != null;
  if (!hasStart && !hasEnd) return;
  if (hasStart && hasEnd) {
    const pts = latlngsFrom(t, s.startIdx, s.endIdx);
    if (pts.length) L.polyline(pts, { color: "#ffd166", weight: 6, opacity: 0.95 }).addTo(state.layers.segment);
  }

  const mk = (idx, kind, color, label) => {
    const lat = t.lat[idx];
    const lon = t.lon[idx];
    if (lat == null || lon == null) return;
    const marker = L.marker([lat, lon], { draggable: true, icon: segIcon(color, label) });
    let prev = null;
    marker.on("dragstart", () => { prev = marker.getLatLng(); });
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      const snap = nearestTrackIdx(ll.lat, ll.lng);
      if (!snap || snap.dist > 150) {
        toast("Punto troppo lontano dalla traccia");
        if (prev) marker.setLatLng(prev);
        return;
      }
      state.segment[kind] = snap.idx;
      normalizeSegmentOrder();
      updateSegmentUI();
    });
    marker.addTo(state.layers.segment);
  };
  if (hasStart) mk(s.startIdx, "startIdx", "#06d6a0", "A");
  if (hasEnd) mk(s.endIdx, "endIdx", "#ef476f", "B");
}

/* ---------------- SEARCH ---------------- */

function currentParams() {
  return {
    strategy: $("#opt-strategy").value,
    tolerance_m: parseFloat($("#opt-tolerance").value) || 25,
    direction: $("#opt-direction").value,
    coverage_min: (parseFloat($("#opt-coverage").value) || 80) / 100,
    length_tol: (parseFloat($("#opt-length-tol").value) || 25) / 100,
    same_sport: $("#opt-same-sport").checked,
    check_heading: $("#opt-heading").checked,
    heading_tol_deg: 45,
  };
}

function applyParamsToControls(p) {
  if (!p) return;
  if (p.strategy) $("#opt-strategy").value = p.strategy;
  if (p.tolerance_m != null) $("#opt-tolerance").value = p.tolerance_m;
  if (p.direction) $("#opt-direction").value = p.direction;
  if (p.coverage_min != null) {
    $("#opt-coverage").value = Math.round(p.coverage_min > 1 ? p.coverage_min : p.coverage_min * 100);
  }
  if (p.length_tol != null) {
    $("#opt-length-tol").value = Math.round(p.length_tol > 1 ? p.length_tol : p.length_tol * 100);
  }
  if (p.same_sport != null) $("#opt-same-sport").checked = !!p.same_sport;
  if (p.check_heading != null) $("#opt-heading").checked = !!p.check_heading;
}

async function runSearch() {
  const s = state.segment;
  if (!state.activity || s.startIdx == null || s.endIdx == null) return;
  const body = {
    activity_id: state.activity.id,
    start_idx: s.startIdx,
    end_idx: s.endIdx,
    ...currentParams(),
  };
  if (state.currentSegmentId) body.save_segment_id = state.currentSegmentId;
  $("#search-status").textContent = "Ricerca in corso...";
  $("#btn-search").disabled = true;
  try {
    const res = await api("/api/segment/search", { method: "POST", body: JSON.stringify(body) });
    applySearchResult(res);
    switchTab("compare");
    $("#search-status").textContent = `${res.results.length} passaggi trovati su ${res.scanned} attività analizzate (${res.candidates} candidate)`;
    if (state.currentSegmentId) await loadSegments();
  } catch (e) {
    $("#search-status").textContent = "";
    toast(`Errore ricerca: ${e.message}`);
  } finally {
    $("#btn-search").disabled = false;
  }
}

async function saveSegment() {
  const s = state.segment;
  if (!state.activity || s.startIdx == null || s.endIdx == null) return;
  const len = state.track.dist[s.endIdx] - state.track.dist[s.startIdx];
  const defName = `${activityLabel(state.activity.start_time, state.activity.filename)} ${fmtDist(len)}`;
  const name = prompt("Nome del segmento:", defName);
  if (name == null) return;
  $("#search-status").textContent = "Salvataggio e ricerca...";
  try {
    const res = await api("/api/segments", {
      method: "POST",
      body: JSON.stringify({
        name,
        activity_id: state.activity.id,
        start_idx: s.startIdx,
        end_idx: s.endIdx,
        params: currentParams(),
      }),
    });
    state.currentSegmentId = res.segment_id;
    applySearchResult(res.search);
    updateSegmentUI();
    switchTab("compare");
    $("#search-status").textContent = `Segmento salvato: ${res.search.results.length} passaggi`;
    await loadSegments();
    toast(`Segmento salvato (${res.search.results.length} passaggi)`);
  } catch (e) {
    $("#search-status").textContent = "";
    toast(`Errore salvataggio: ${e.message}`);
  }
}

function normalizeResult(r) {
  return {
    activity_id: r.activity_id,
    filename: r.filename || r.name || `#${r.activity_id}`,
    start_time: r.start_time,
    duration_s: r.duration_s,
    segment_distance_m: r.segment_distance_m != null ? r.segment_distance_m : r.distance_m,
    avg_speed_mps: r.avg_speed_mps,
    avg_hr: r.avg_hr,
    coverage: r.coverage,
    d_start_m: r.d_start_m,
    d_end_m: r.d_end_m,
    pass_start_idx: r.pass_start_idx,
    pass_end_idx: r.pass_end_idx,
    pass_number: r.pass_number || null,
    pass_count: r.pass_count || null,
    is_best: !!r.is_best,
    is_activity_best: !!r.is_activity_best,
    reversed: !!r.reversed,
    is_source: state.activity && r.activity_id === state.activity.id,
  };
}

function assignPassNumbers(results) {
  const groups = new Map();
  results.forEach((r) => {
    if (!groups.has(r.activity_id)) groups.set(r.activity_id, []);
    groups.get(r.activity_id).push(r);
  });
  groups.forEach((list) => {
    list.sort((a, b) => a.pass_start_idx - b.pass_start_idx);
    list.forEach((r, i) => {
      r.pass_number = i + 1;
      r.pass_count = list.length;
    });
  });
}

function computeResultFlags(results) {
  let bestDur = Infinity;
  let bestIdx = -1;
  const perAct = new Map();
  results.forEach((r, i) => {
    if (r.duration_s < bestDur) {
      bestDur = r.duration_s;
      bestIdx = i;
    }
    const cur = perAct.get(r.activity_id);
    if (!cur || r.duration_s < cur.dur) perAct.set(r.activity_id, { dur: r.duration_s, idx: i });
  });
  results.forEach((r, i) => {
    r.is_best = i === bestIdx;
    const act = perAct.get(r.activity_id);
    r.is_activity_best = !!act && act.idx === i;
  });
}

function resultLabel(r) {
  const base = activityLabel(r.start_time, r.filename);
  return r.pass_count > 1 ? `${base}_${r.pass_number}` : base;
}

function applySearchResult(res) {
  state.results = (res.results || []).map(normalizeResult);
  state.resultsBaseIdx = state.segment.startIdx == null ? 0 : state.segment.startIdx;
  assignPassNumbers(state.results);
  computeResultFlags(state.results);
  state.selected = new Set(state.results.map((_, i) => i));
  state.lastSearch = res.scanned != null ? res : null;
  if (res.params) applyParamsToControls(res.params);
  renderResults();
  drawPasses();
  resetCompare();
  resetTrend();
  if (state.tab === "compare") refreshCompare();
  if (state.tab === "trend") refreshTrend();
}

function renderResults() {
  const tbody = $("#results-table tbody");
  tbody.innerHTML = "";
  const details = $("#results-details");
  if (!state.results.length) {
    details.classList.add("hidden");
    return;
  }
  details.classList.remove("hidden");
  const best = state.results.find((r) => r.is_best);
  let txt = `${state.results.length} passaggi`;
  if (state.lastSearch) txt += ` · ${state.lastSearch.scanned} attività analizzate`;
  if (best) txt += ` · miglior tempo ${fmtDuration(best.duration_s)}`;
  $("#results-summary").textContent = `Risultati ricerca: ${txt}`;
  $("#results-count").textContent = txt;

  state.results.forEach((r, i) => {
    const tr = document.createElement("tr");
    if (r.is_best) tr.classList.add("best");
    const tdCb = document.createElement("td");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = state.selected.has(i);
    cb.onchange = () => {
      if (cb.checked) state.selected.add(i);
      else state.selected.delete(i);
    };
    tdCb.appendChild(cb);

    const tdName = document.createElement("td");
    tdName.innerHTML = `${escapeHtml(resultLabel(r))}${r.is_source ? '<span class="badge src">sorgente</span>' : ""}${r.is_best ? '<span class="badge best">best</span>' : ""}${r.is_activity_best && r.pass_count > 1 && !r.is_best ? '<span class="badge ab">best att.</span>' : ""}${r.reversed ? '<span class="badge rev">inverso</span>' : ""}`;

    const tdDate = document.createElement("td");
    tdDate.textContent = fmtDate(r.start_time);

    const tdDur = document.createElement("td");
    tdDur.textContent = fmtDuration(r.duration_s);

    const tdDist = document.createElement("td");
    tdDist.textContent = fmtDist(r.segment_distance_m);

    const tdSpeed = document.createElement("td");
    tdSpeed.textContent = fmtSpeed(r.avg_speed_mps);

    const tdHr = document.createElement("td");
    tdHr.textContent = r.avg_hr != null ? Math.round(r.avg_hr) : "—";

    const tdMatch = document.createElement("td");
    if (r.coverage != null) tdMatch.textContent = `cov. ${Math.round(r.coverage * 100)}%`;
    else if (r.d_start_m != null) tdMatch.textContent = `${Math.round(r.d_start_m)} / ${Math.round(r.d_end_m)} m`;
    else tdMatch.textContent = "—";

    tr.append(tdCb, tdName, tdDate, tdDur, tdDist, tdSpeed, tdHr, tdMatch);
    tr.onclick = (ev) => {
      if (ev.target.tagName === "INPUT") return;
      zoomToPass(i);
    };
    tbody.appendChild(tr);
  });
}

async function drawPasses() {
  state.layers.passes.clearLayers();
  state.passLayers = {};
  const jobs = state.results.map(async (r, i) => {
    try {
      const data = await api(
        `/api/activities/${r.activity_id}/track?from_idx=${r.pass_start_idx}&to_idx=${r.pass_end_idx}&max_points=1500`
      );
      const pts = latlngsFrom(data);
      if (!pts.length) return;
      const dash = ACTIVITY_DASH[i % ACTIVITY_DASH.length];
      const line = L.polyline(pts, {
        color: PALETTE[i % PALETTE.length],
        weight: r.is_best ? 5 : 3,
        opacity: 0.85,
        dashArray: dash.length ? dash.join(" ") : null,
      });
      line.addTo(state.layers.passes);
      state.passLayers[i] = line;
    } catch (_) { /* ignore */ }
  });
  await Promise.all(jobs);
}

function zoomToPass(i) {
  const line = state.passLayers[i];
  if (line) state.map.fitBounds(line.getBounds(), { padding: [30, 30] });
}

/* ---------------- SAVED SEGMENTS ---------------- */

async function loadSegments() {
  state.segments = await api("/api/segments");
  renderSegments();
}

function renderSegments() {
  const list = $("#segments-list");
  list.innerHTML = "";
  $("#segments-count").textContent = state.segments.length ? String(state.segments.length) : "";
  if (!state.segments.length) {
    list.innerHTML = '<li class="muted pad">Nessun segmento salvato</li>';
    return;
  }
  for (const s of state.segments) {
    const li = document.createElement("li");
    li.className = "segment" + (state.currentSegmentId === s.id ? " active" : "");
    const info = document.createElement("div");
    info.className = "s-info";
    info.innerHTML = `<div class="s-title">${escapeHtml(s.name)}</div><div class="a-sub">${fmtDist(s.length_m)} · ${s.match_count} passaggi${s.start_time ? " · " + fmtDate(s.start_time) : ""}</div>`;
    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "\u00d7";
    del.title = "Elimina segmento";
    del.onclick = async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Eliminare il segmento "${s.name}"?`)) return;
      await api(`/api/segments/${s.id}`, { method: "DELETE" });
      if (state.currentSegmentId === s.id) state.currentSegmentId = null;
      await loadSegments();
      updateSegmentUI();
    };
    li.append(info, del);
    li.onclick = () => loadSavedSegment(s.id);
    list.appendChild(li);
  }
}

async function loadSavedSegment(id) {
  let seg;
  try {
    seg = await api(`/api/segments/${id}`);
  } catch (e) {
    toast(`Errore caricamento segmento: ${e.message}`);
    return;
  }
  state.currentSegmentId = seg.id;
  applyParamsToControls(seg.params);
  await selectActivity(seg.activity_id, { keepSegment: true });
  if (!state.activity || state.activity.id !== seg.activity_id || !state.track) {
    toast("Attività sorgente non disponibile: il segmento non può essere caricato");
    return;
  }
  const n = state.track.lat.length;
  state.segment.startIdx = Math.max(0, Math.min(seg.start_idx, n - 1));
  state.segment.endIdx = Math.max(0, Math.min(seg.end_idx, n - 1));
  normalizeSegmentOrder();
  updateSegmentUI();
  applySearchResult({ results: seg.results, params: seg.params });
  renderSegments();
  switchTab("compare");
  toast(`Segmento "${seg.name}": ${seg.results.length} passaggi salvati`);
}

/* ---------------- COMPARE ---------------- */

const METRIC_ORDER = ["speed", "pace", "hr", "hrpace", "cadence", "altitude", "power", "temp", "gradient", "profile"];
const MAX_COMPARE = 5;

function metricsAvailableFor(indices) {
  const byId = new Map(state.activities.map((a) => [a.id, a]));
  const avail = new Set();
  for (const i of indices) {
    const r = state.results[i];
    if (!r) continue;
    const a = byId.get(r.activity_id);
    if (!a) continue;
    if (a.has_speed) {
      avail.add("speed");
      avail.add("pace");
    }
    if (a.has_hr) avail.add("hr");
    if (a.has_speed && a.has_hr) avail.add("hrpace");
    if (a.has_cadence) avail.add("cadence");
    if (a.has_altitude) {
      avail.add("altitude");
      avail.add("gradient");
    }
    if (a.has_power) avail.add("power");
    if (a.has_temp) avail.add("temp");
  }
  if (state.activity && state.activity.has_altitude) avail.add("profile");
  return avail;
}

function defaultMetricKeys(sport, available) {
  const key = sportKey(sport);
  const pref = key === "running" ? ["pace", "hr"] : key === "cycling" ? ["speed", "hr"] : ["speed", "pace"];
  return pref.filter((m) => available.includes(m));
}

function ensureDefaultMetrics(available, enabled, sport, slot) {
  if (!available.length) return;
  const key = sportKey(sport);
  const changed = state.defaultSports[slot] !== key;
  if (changed) state.defaultSports[slot] = key;
  else if (available.some((m) => enabled[m])) return;
  if (changed) for (const m of Object.keys(enabled)) enabled[m] = false;
  let any = false;
  for (const m of defaultMetricKeys(key, available)) {
    enabled[m] = true;
    any = true;
  }
  if (!any) enabled[available[0]] = true;
}

function resetCompare() {
  resetZoomState();
  state.compareAdded = new Set(state.results.slice(0, MAX_COMPARE).map((_, i) => i));
  state.sliceCache = {};
  state.profileCache = null;
  const avail = metricsAvailableFor(state.results.map((_, i) => i));
  state.availableMetrics = METRIC_ORDER.filter((m) => avail.has(m));
  const prev = state.metricEnabled || {};
  state.metricEnabled = {};
  for (const m of state.availableMetrics) state.metricEnabled[m] = prev[m] === true;
  ensureDefaultMetrics(state.availableMetrics, state.metricEnabled, state.activity && state.activity.sport, "compare");
  renderCompareList();
  renderMetricChips();
  renderLegend();
}

async function fetchSlice(i) {
  if (state.sliceCache[i]) return state.sliceCache[i];
  const r = state.results[i];
  const fields = "speed,hr,cadence,altitude,power,temp";
  const data = await api(
    `/api/activities/${r.activity_id}/track?from_idx=${r.pass_start_idx}&to_idx=${r.pass_end_idx}&fields=${fields}&gradient=1`
  );
  if (r.reversed) {
    const len = r.segment_distance_m || 0;
    const dur = r.duration_s || 0;
    for (const k of Object.keys(data)) {
      if (Array.isArray(data[k])) data[k] = data[k].slice().reverse();
    }
    data.dist = data.dist.map((v) => (v == null ? null : len - v));
    data.t = data.t.map((v) => (v == null ? null : dur - v));
  }
  const slice = {
    result: r,
    color: PALETTE[i % PALETTE.length],
    dash: ACTIVITY_DASH[i % ACTIVITY_DASH.length],
    data,
    label: `${resultLabel(r)} (${fmtDuration(r.duration_s)})`,
    order: i,
  };
  state.sliceCache[i] = slice;
  return slice;
}

function addedSlices() {
  return [...state.compareAdded]
    .sort((a, b) => a - b)
    .map((i) => state.sliceCache[i])
    .filter(Boolean);
}

async function ensureCompareProfile() {
  const s = state.segment;
  if (!state.activity || !state.track || s.startIdx == null || s.endIdx == null) return null;
  const key = `${state.activity.id}:${s.startIdx}:${s.endIdx}`;
  if (state.profileCache && state.profileCache.key === key) return state.profileCache.slice;
  const data = await api(
    `/api/activities/${state.activity.id}/track?from_idx=${s.startIdx}&to_idx=${s.endIdx}&fields=altitude`
  );
  const slice = {
    result: { activity_id: state.activity.id, duration_s: 0, is_best: false, is_source: true },
    color: "#9aa7b4",
    dash: [],
    data,
    label: `${activityLabel(state.activity.start_time, state.activity.filename)} · Quota`,
  };
  state.profileCache = { key, slice };
  return slice;
}

async function refreshCompare() {
  renderCompareList();
  if (!state.results.length) {
    renderMetricChips();
    renderLegend();
    renderCharts();
    return;
  }
  const jobs = [...state.compareAdded].map((i) => fetchSlice(i).catch(() => null));
  await Promise.all(jobs);
  if (state.metricEnabled.profile && state.results.length) {
    try {
      await ensureCompareProfile();
    } catch (_) { /* ignore */ }
  }
  if (state.tab !== "compare") return;
  renderMetricChips();
  renderLegend();
  renderCharts();
}

async function openCompare() {
  if (!state.results.length) {
    toast("Esegui prima una ricerca sul segmento");
    return;
  }
  const sel = [...state.selected].sort((a, b) => a - b).slice(0, MAX_COMPARE);
  const idxs = sel.length ? sel : state.results.slice(0, MAX_COMPARE).map((_, i) => i);
  state.compareAdded = new Set(idxs);
  switchTab("compare");
}

async function toggleCompare(i, on) {
  if (on) {
    if (state.compareAdded.has(i)) return;
    if (state.compareAdded.size >= MAX_COMPARE) {
      toast(`Massimo ${MAX_COMPARE} attività a confronto: deselezionane una per aggiungerne altre`);
      renderCompareList();
      return;
    }
    state.compareAdded.add(i);
  } else {
    state.compareAdded.delete(i);
  }
  renderCompareList();
  if (on) {
    try {
      await fetchSlice(i);
    } catch (e) {
      state.compareAdded.delete(i);
      renderCompareList();
      toast(`Errore caricamento dati: ${e.message}`);
      return;
    }
  }
  renderLegend();
  renderMetricChips();
  renderCharts();
}

function compareRows(sortOverride) {
  const sort = sortOverride || state.compareSort;
  const from = state.compareDateFrom ? new Date(`${state.compareDateFrom}T00:00:00`).getTime() : null;
  const to = state.compareDateTo ? new Date(`${state.compareDateTo}T23:59:59`).getTime() : null;
  const rows = state.results.map((r, i) => ({ r, i }));
  const filtered = rows.filter(({ r }) => {
    if (from == null && to == null) return true;
    const t = r.start_time ? new Date(r.start_time).getTime() : NaN;
    if (!isFinite(t)) return false;
    if (from != null && t < from) return false;
    if (to != null && t > to) return false;
    return true;
  });
  if (sort === "date_desc" || sort === "date_asc") {
    const mul = sort === "date_desc" ? -1 : 1;
    filtered.sort((a, b) => {
      const ta = a.r.start_time ? new Date(a.r.start_time).getTime() : 0;
      const tb = b.r.start_time ? new Date(b.r.start_time).getTime() : 0;
      return mul * (ta - tb);
    });
  } else {
    filtered.sort((a, b) => (a.r.duration_s || 0) - (b.r.duration_s || 0));
  }
  return filtered;
}

function renderCompareList() {
  const has = state.results.length > 0;
  $("#compare-empty").classList.toggle("hidden", has);
  $("#compare-layout").classList.toggle("hidden", !has);
  if (!has) return;
  $("#compare-count").textContent = `${state.compareAdded.size}/${state.results.length}`;
  const list = $("#compare-list");
  list.innerHTML = "";
  const rows = compareRows();
  if (!rows.length) {
    list.innerHTML = '<li class="muted pad">Nessuna attività con i filtri attuali</li>';
    return;
  }
  for (const { r, i } of rows) {
    const added = state.compareAdded.has(i);
    const li = document.createElement("li");
    if (added) li.classList.add("added");
    if (r.is_best) li.classList.add("best");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = added;
    cb.onchange = () => toggleCompare(i, cb.checked);
    const sw = document.createElement("span");
    sw.className = "dash-swatch-wrap";
    sw.innerHTML = dashSwatchSvg(ACTIVITY_DASH[i % ACTIVITY_DASH.length], PALETTE[i % PALETTE.length]);
    const name = document.createElement("span");
    name.className = "c-name";
    name.innerHTML = `${escapeHtml(resultLabel(r))}${r.is_source ? '<span class="badge src">sorgente</span>' : ""}${r.is_best ? '<span class="badge best">best</span>' : ""}${r.is_activity_best && r.pass_count > 1 && !r.is_best ? '<span class="badge ab">best att.</span>' : ""}${r.reversed ? '<span class="badge rev">inverso</span>' : ""}`;
    const info = document.createElement("span");
    info.className = "c-info";
    info.textContent = `${fmtDuration(r.duration_s)} · ${fmtSpeed(r.avg_speed_mps)}`;
    li.append(cb, sw, name, info);
    li.onclick = (ev) => {
      if (ev.target === cb) return;
      toggleCompare(i, !state.compareAdded.has(i));
    };
    list.appendChild(li);
  }
}

function renderMetricChips() {
  const box = $("#metric-chips");
  box.innerHTML = "";
  if (!state.availableMetrics.length) {
    box.innerHTML = '<span class="muted">Nessun attributo disponibile</span>';
    return;
  }
  for (const m of state.availableMetrics) {
    const def = METRICS[m] || { label: m, short: m };
    const b = document.createElement("button");
    b.className = "chip" + (state.metricEnabled[m] ? " active" : "");
    b.textContent = def.short || def.label;
    b.title = def.label;
    b.onclick = async () => {
      state.metricEnabled[m] = !state.metricEnabled[m];
      if (m === "profile" && state.metricEnabled[m] && state.tab === "compare") {
        try {
          await ensureCompareProfile();
        } catch (_) { /* ignore */ }
      }
      renderMetricChips();
      renderCharts();
    };
    box.appendChild(b);
  }
}

function renderLegend() {
  const box = $("#compare-legend");
  box.innerHTML = "";
  for (const sl of addedSlices()) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const sw = document.createElement("span");
    sw.className = "dash-swatch-wrap";
    sw.innerHTML = dashSwatchSvg(sl.dash || [], "#e8edf2");
    item.appendChild(sw);
    item.appendChild(document.createTextNode(sl.label + (sl.result.is_best ? " ★" : "")));
    box.appendChild(item);
  }
}

const syncCursorPlugin = {
  id: "syncCursor",
  afterDatasetsDraw(chart) {
    const x = state.hoverX;
    if (x == null || !chart.scales.x) return;
    const px = chart.scales.x.getPixelForValue(x);
    const area = chart.chartArea;
    if (px < area.left || px > area.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(232, 237, 242, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, area.top);
    ctx.lineTo(px, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function nearestIndexByX(arr, x) {
  if (!arr || !arr.length) return -1;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1].x - x) <= Math.abs(arr[lo].x - x)) return lo - 1;
  return lo;
}

let hoverRaf = null;

function onChartHover(chart, event) {
  if (state.dragZoom) return;
  const rect = chart.canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const area = chart.chartArea;
  if (mx < area.left || mx > area.right) {
    clearHover();
    return;
  }
  const xVal = chart.scales.x.getValueForPixel(mx);
  if (xVal == null || !isFinite(xVal)) return;
  state.hoverX = xVal;
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = null;
    syncHover();
  });
}

function activeSlices() {
  if (state.tab === "analysis") return state.analysis.slice ? [state.analysis.slice] : [];
  return addedSlices();
}

function updateCursorDots() {
  const layer = state.layers.cursor;
  if (!layer) return;
  layer.clearLayers();
  if (state.hoverX == null) return;
  const xKey = state.tab === "analysis" ? state.analysis.xAxis : state.xAxis;
  for (const sl of activeSlices()) {
    const arr = xKey === "dist" ? sl.data.dist : sl.data.t;
    const idx = nearestIdx(arr, state.hoverX);
    if (idx == null || idx < 0) continue;
    const lat = sl.data.lat ? sl.data.lat[idx] : null;
    const lon = sl.data.lon ? sl.data.lon[idx] : null;
    if (lat == null || lon == null) continue;
    L.circleMarker([lat, lon], {
      radius: 6,
      color: "#08131a",
      weight: 2,
      fillColor: sl.color,
      fillOpacity: 1,
      interactive: false,
    }).addTo(layer);
  }
}

function syncHover() {
  if (state.hoverX == null) return;
  for (const ch of state.charts) {
    const elements = [];
    ch.data.datasets.forEach((ds, di) => {
      const idx = nearestIndexByX(ds.data, state.hoverX);
      if (idx >= 0) elements.push({ datasetIndex: di, index: idx });
    });
    if (!elements.length) continue;
    ch.setActiveElements(elements);
    const hasTooltip = !(ch.options.plugins && ch.options.plugins.tooltip && ch.options.plugins.tooltip.enabled === false);
    if (hasTooltip) {
      const meta = ch.getDatasetMeta(elements[0].datasetIndex);
      const pt = meta.data[elements[0].index];
      ch.tooltip.setActiveElements(elements, { x: pt ? pt.x : 0, y: pt ? pt.y : 0 });
    }
    ch.update("none");
  }
  updateCursorDots();
  for (const ch of state.charts) updateSingleValues(ch, state.hoverX);
}

function clearHover() {
  state.hoverX = null;
  for (const ch of state.charts) {
    ch.setActiveElements([]);
    const hasTooltip = !(ch.options.plugins && ch.options.plugins.tooltip && ch.options.plugins.tooltip.enabled === false);
    if (hasTooltip) ch.tooltip.setActiveElements([], { x: 0, y: 0 });
    ch.update("none");
  }
  updateCursorDots();
  for (const ch of state.charts) updateSingleValues(ch, null);
}

function zoomOverlay() {
  let el = document.getElementById("zoom-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "zoom-overlay";
    document.body.appendChild(el);
  }
  return el;
}

function startZoomDrag(chart, e) {
  if (e.button !== 0) return;
  const area = chart.chartArea;
  const rect = chart.canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) return;
  state.dragZoom = {
    startX: e.clientX,
    rectLeft: rect.left,
    rectRight: rect.right,
    rectTop: rect.top + area.top,
    rectBottom: rect.top + area.bottom,
  };
  chart.canvas.setPointerCapture(e.pointerId);
  e.preventDefault();
}

function moveZoomDrag(e) {
  const dz = state.dragZoom;
  if (!dz) return;
  const el = zoomOverlay();
  const left = Math.max(Math.min(dz.startX, e.clientX), dz.rectLeft);
  const right = Math.min(Math.max(dz.startX, e.clientX), dz.rectRight);
  if (right - left < 2) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  el.style.left = left + "px";
  el.style.top = dz.rectTop + "px";
  el.style.width = right - left + "px";
  el.style.height = dz.rectBottom - dz.rectTop + "px";
}

function endZoomDrag(chart, e) {
  const dz = state.dragZoom;
  state.dragZoom = null;
  zoomOverlay().style.display = "none";
  if (!dz) return;
  const rect = chart.canvas.getBoundingClientRect();
  const x1 = Math.max(Math.min(dz.startX, e.clientX), dz.rectLeft) - rect.left;
  const x2 = Math.min(Math.max(dz.startX, e.clientX), dz.rectRight) - rect.left;
  if (Math.abs(x2 - x1) < 10) return;
  const v1 = chart.scales.x.getValueForPixel(x1);
  const v2 = chart.scales.x.getValueForPixel(x2);
  if (v1 == null || v2 == null || !isFinite(v1) || !isFinite(v2)) return;
  setZoom(Math.min(v1, v2), Math.max(v1, v2));
}

function cancelZoomDrag() {
  state.dragZoom = null;
  zoomOverlay().style.display = "none";
}

function setZoom(min, max) {
  state.zoom = { min, max };
  state.hoverX = null;
  applyZoomToCharts();
  updateZoomUI();
  syncSegmentFromZoom(min, max);
}

function nearestIdx(arr, value) {
  if (!arr || !arr.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(arr[lo - 1] - value) <= Math.abs(arr[lo] - value)) return lo - 1;
  return lo;
}

function zoomBaseIndex() {
  const base = state.tab === "analysis" ? state.analysis.baseIdx : state.resultsBaseIdx;
  if (base != null) return base;
  return state.segment.startIdx == null ? 0 : state.segment.startIdx;
}

function syncSegmentFromZoom(zmin, zmax) {
  const t = state.track;
  if (!t || !t.t.length) return;
  const xKey = state.tab === "analysis" ? state.analysis.xAxis : state.xAxis;
  const arr = xKey === "dist" ? t.dist : t.t;
  const baseIdx = zoomBaseIndex();
  const base = arr[baseIdx] || 0;
  const i1 = nearestIdx(arr, base + zmin);
  const i2 = nearestIdx(arr, base + zmax);
  if (i1 == null || i2 == null) return;
  const lo = Math.min(i1, i2);
  const hi = Math.max(i1, i2);
  if (hi - lo < 1) return;
  if (lo === state.segment.startIdx && hi === state.segment.endIdx) return;
  if (!state.segmentFromZoom) {
    state.preZoomSegment = { startIdx: state.segment.startIdx, endIdx: state.segment.endIdx };
    state.segmentFromZoom = true;
  }
  state.segment.startIdx = lo;
  state.segment.endIdx = hi;
  updateSegmentUI({ keepZoom: true });
  if (state.tab === "compare" && state.results.length) {
    $("#search-status").textContent = "Zoom applicato al segmento: premi \"Cerca passaggi\" per aggiornare i risultati";
  }
}

function applyZoomToCharts() {
  for (const ch of state.charts) {
    const xs = ch.options.scales ? ch.options.scales.x : null;
    if (!xs) continue;
    if (state.zoom) {
      xs.min = state.zoom.min;
      xs.max = state.zoom.max;
    } else {
      delete xs.min;
      delete xs.max;
    }
    ch.update("none");
  }
}

function resetZoomState() {
  state.zoom = null;
  state.hoverX = null;
  updateZoomUI();
}

function clearZoom() {
  resetZoomState();
  applyZoomToCharts();
  if (!state.segmentFromZoom) return;
  const prev = state.preZoomSegment;
  state.segmentFromZoom = false;
  state.preZoomSegment = null;
  if (state.tab === "analysis" && prev) {
    state.segment = { startIdx: prev.startIdx, endIdx: prev.endIdx };
    updateSegmentUI({ keepZoom: true });
  }
}

function updateZoomUI() {
  const btn = $("#btn-zoom-reset");
  if (!btn) return;
  const active = !!state.zoom;
  btn.classList.toggle("hidden", !active);
  if (active) {
    const xKey = state.tab === "analysis" ? state.analysis.xAxis : state.xAxis;
    const unit = xKey === "dist" ? "m" : "s";
    btn.textContent = `Rimuovi zoom (${Math.round(state.zoom.min)}–${Math.round(state.zoom.max)} ${unit})`;
  }
}

function xAxisTitle(xKey) {
  return xKey === "dist" ? "Distanza dall'inizio (m)" : "Tempo relativo (s)";
}

function fmtPace(minPerKm) {
  if (minPerKm == null || !isFinite(minPerKm)) return "—";
  const total = Math.round(minPerKm * 60);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

function paceFromSpeeds(speeds) {
  const n = speeds ? speeds.length : 0;
  const out = new Array(n).fill(null);
  if (!n) return out;
  const win = 9;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    const a = Math.max(0, i - win);
    const b = Math.min(n - 1, i + win);
    for (let j = a; j <= b; j++) {
      const v = speeds[j];
      if (v != null && v > 0.2) {
        sum += v;
        cnt++;
      }
    }
    if (cnt >= 3) {
      const avg = sum / cnt;
      out[i] = avg > 0.5 ? 1000 / avg / 60 : null;
    }
  }
  return out;
}

function ratioPaceHr(sl) {
  if (!sl.hrpaceCache) {
    const pace = metricValues(sl, "pace");
    const hr = sl.data.hr || [];
    const out = new Array(pace.length).fill(null);
    for (let i = 0; i < pace.length; i++) {
      const p = pace[i];
      const h = hr[i];
      if (p != null && p > 0 && h != null && h > 0) {
        const speedMmin = 1000 / p;
        out[i] = speedMmin / h;
      }
    }
    sl.hrpaceCache = out;
  }
  return sl.hrpaceCache;
}

function metricValues(sl, metric) {
  if (metric === "pace") {
    if (!sl.paceCache) sl.paceCache = paceFromSpeeds(sl.data.speed || []);
    return sl.paceCache;
  }
  if (metric === "hrpace") {
    return ratioPaceHr(sl);
  }
  if (metric === "profile") {
    return sl.data.altitude || [];
  }
  return sl.data[metric] || [];
}

function metricSeries(sl, metric) {
  if (!sl) return [];
  return metricValues(sl, metric);
}

function hasProfileData(sl) {
  return !!(sl && sl.data && sl.data.altitude && sl.data.altitude.some((v) => v != null));
}

function metricHasData(metric, slices) {
  if (metric === "pace") {
    return slices.some((sl) => sl.data.speed && sl.data.speed.some((v) => v != null && v > 0.5));
  }
  if (metric === "hrpace") {
    return slices.some(
      (sl) =>
        sl.data.speed &&
        sl.data.speed.some((v) => v != null && v > 0.5) &&
        sl.data.hr &&
        sl.data.hr.some((v) => v != null)
    );
  }
  return slices.some((sl) => sl.data[metric] && sl.data[metric].some((v) => v != null));
}

function chartDataset(sl, metric, xKey, axisId, withMetricLabel) {
  const def = METRICS[metric] || { label: metric };
  const xs = xKey === "dist" ? sl.data.dist : sl.data.t;
  const ys = metricSeries(sl, metric);
  const pts = [];
  for (let i = 0; i < xs.length; i++) {
    let y = ys[i];
    if (y == null || xs[i] == null) continue;
    if (def.conv) y = def.conv(y);
    if (y == null || !isFinite(y)) continue;
    pts.push({ x: xs[i], y });
  }
  const ds = {
    metric,
    label: withMetricLabel ? `${sl.label} · ${def.short || def.label}` : sl.label,
    data: pts,
    borderColor: def.color || sl.color,
    backgroundColor: def.color || sl.color,
    borderWidth: sl.result && sl.result.is_best ? 3.2 : 1.8,
    borderDash: sl.dash || [],
    pointRadius: 0,
    tension: def.area ? 0.05 : 0.15,
    spanGaps: true,
    yAxisID: axisId,
  };
  if (def.area) {
    ds.fill = "origin";
    ds.backgroundColor = "rgba(154, 167, 180, 0.32)";
    ds.borderColor = def.color;
    ds.borderWidth = 1.2;
    ds.borderDash = [];
  }
  return ds;
}

function chartOptions(xKey, scales, sortByDataset, useTooltip = true) {
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false, axis: "x" },
    scales,
    plugins: {
      legend: { display: false },
      tooltip: useTooltip
        ? {
            itemSort: sortByDataset ? (a, b) => a.datasetIndex - b.datasetIndex : (a, b) => b.parsed.y - a.parsed.y,
            callbacks: {
              title: (items) =>
                state.hoverX != null
                  ? `${Math.round(state.hoverX)} ${xKey === "dist" ? "m" : "s"}`
                  : items.length
                    ? `${Math.round(items[0].parsed.x)} ${xKey === "dist" ? "m" : "s"}`
                    : "",
              label: (item) => {
                const def = METRICS[item.dataset.metric] || {};
                const v = item.parsed.y;
                return `${item.dataset.label}: ${def.fmt ? def.fmt(v) : v.toFixed(1)}`;
              },
            },
          }
        : { enabled: false },
    },
  };
}

function attachHover(chart) {
  chart.canvas.addEventListener("mousemove", (e) => onChartHover(chart, e));
  chart.canvas.addEventListener("mouseleave", clearHover);
  chart.canvas.addEventListener("pointerdown", (e) => startZoomDrag(chart, e));
  chart.canvas.addEventListener("pointermove", moveZoomDrag);
  chart.canvas.addEventListener("pointerup", (e) => endZoomDrag(chart, e));
  chart.canvas.addEventListener("pointercancel", cancelZoomDrag);
  chart.canvas.addEventListener("dblclick", clearZoom);
}

function fmtMetricValue(def, v) {
  if (v == null || !isFinite(v)) return "—";
  return def.fmt ? def.fmt(v) : v.toFixed(1);
}

function meanFinite(values) {
  let sum = 0;
  let count = 0;
  for (const v of values || []) {
    if (v == null || !isFinite(v)) continue;
    sum += v;
    count++;
  }
  return count ? sum / count : null;
}

function metricAverage(sl, metric) {
  if (metric === "pace") {
    const speeds = (sl.data.speed || []).filter((v) => v != null && v > 0.5);
    if (!speeds.length) return null;
    const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    return avg > 0.5 ? 1000 / avg / 60 : null;
  }
  if (metric === "hrpace") {
    const speeds = (sl.data.speed || []).filter((v) => v != null && v > 0.5);
    const hr = (sl.data.hr || []).filter((v) => v != null && v > 0);
    if (!speeds.length || !hr.length) return null;
    const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const avgHr = hr.reduce((a, b) => a + b, 0) / hr.length;
    return avgHr > 0 ? (avgSpeed * 60) / avgHr : null;
  }
  return meanFinite(metricValues(sl, metric));
}

function svgExpand() {
  return '<svg viewBox="0 0 16 16"><path d="M6.5 1.5H1.5v5M9.5 1.5h5v5M6.5 14.5h-5v-5M9.5 14.5h5v-5"/></svg>';
}

function svgCollapse() {
  return '<svg viewBox="0 0 16 16"><path d="M1.5 6.5h5v-5M14.5 6.5h-5v-5M1.5 9.5h5v5M14.5 9.5h-5v5"/></svg>';
}

function makeChartChips(ctx) {
  if (!ctx || !ctx.available.length) return null;
  const box = document.createElement("div");
  box.className = "metric-chips chart-chips";
  for (const m of ctx.available) {
    const def = METRICS[m] || { label: m, short: m };
    const b = document.createElement("button");
    b.className = "chip" + (ctx.enabled[m] ? " active" : "");
    b.title = def.label || m;
    const dot = document.createElement("i");
    dot.className = "chip-dot";
    dot.style.background = def.color || "#4cc9f0";
    b.append(dot, document.createTextNode(def.short || def.label || m));
    b.onclick = (e) => {
      e.stopPropagation();
      ctx.toggle(m);
    };
    box.appendChild(b);
  }
  return box;
}

function makeChartHead(titleText, withHoverMode, chipCtx) {
  const head = document.createElement("div");
  head.className = "chart-head";
  const title = document.createElement("h4");
  title.textContent = titleText;
  head.appendChild(title);
  if (withHoverMode) {
    const mode = document.createElement("span");
    mode.className = "chart-hover-mode muted";
    mode.textContent = "medie";
    head.appendChild(mode);
  }
  const chips = makeChartChips(chipCtx);
  if (chips) head.appendChild(chips);
  const btn = document.createElement("button");
  btn.className = "chart-max";
  btn.title = "Ingrandisci";
  btn.innerHTML = svgExpand();
  head.appendChild(btn);
  return head;
}

function layoutValuesPanel(chart) {
  const panel = chart._valuesPanel;
  if (!panel || !chart.chartArea) return;
  const area = chart.chartArea;
  panel.style.paddingTop = Math.round(Math.max(0, area.top)) + "px";
  panel.style.paddingBottom = Math.round(Math.max(0, chart.height - area.bottom)) + "px";
}

const valuesAlignPlugin = {
  id: "valuesAlign",
  afterUpdate(chart) {
    if (chart._valuesPanel) layoutValuesPanel(chart);
  },
};

function chartMaxKey(chart) {
  if (chart._trend) return `${state.tab}:trend`;
  const metric = chart._single ? "single" : chart.data.datasets[0] ? chart.data.datasets[0].metric : "";
  return `${state.tab}:${metric}`;
}

function restoreChartMax(wrap, chart) {
  if (!state.maxChartKey || state.maxChartKey !== chartMaxKey(chart)) return;
  wrap.classList.add("chart-max");
  const btn = wrap.querySelector(".chart-max");
  if (btn) {
    btn.innerHTML = svgCollapse();
    btn.title = "Riduci";
  }
  requestAnimationFrame(() => {
    chart.resize();
    if (chart._valuesPanel) layoutValuesPanel(chart);
  });
}

function closeChartMax(wrap) {
  if (!wrap || !wrap.classList.contains("chart-max")) return;
  wrap.classList.remove("chart-max");
  state.maxChartKey = null;
  const btn = wrap.querySelector(".chart-max");
  if (btn) {
    btn.innerHTML = svgExpand();
    btn.title = "Ingrandisci";
  }
  for (const c of state.charts) {
    if (c.canvas.closest(".chart-wrap") === wrap) {
      c.resize();
      if (c._valuesPanel) layoutValuesPanel(c);
    }
  }
}

function toggleChartMax(chart) {
  if (!chart || !chart.canvas || !chart.canvas.isConnected) return;
  const wrap = chart.canvas.closest(".chart-wrap");
  if (!wrap) return;
  if (wrap.classList.contains("chart-max")) {
    closeChartMax(wrap);
    return;
  }
  document.querySelectorAll(".chart-wrap.chart-max").forEach((w) => closeChartMax(w));
  wrap.classList.add("chart-max");
  state.maxChartKey = chartMaxKey(chart);
  const btn = wrap.querySelector(".chart-max");
  if (btn) {
    btn.innerHTML = svgCollapse();
    btn.title = "Riduci";
  }
  setTimeout(() => {
    chart.resize();
    if (chart._valuesPanel) layoutValuesPanel(chart);
  }, 40);
}

function wireChartMax(wrap, chart) {
  const btn = wrap.querySelector(".chart-max");
  if (btn) {
    btn.onclick = (e) => {
      e.stopPropagation();
      toggleChartMax(chart);
    };
  }
}

const MAX_PANEL_VALUES = 10;

function fitValuesFont(vals, spans) {
  const row = vals.closest(".rv-row");
  const rowH = row ? row.clientHeight : 60;
  let size = Math.round(Math.min(30, Math.max(12, rowH * 0.34)));
  if (spans.length > 1) {
    const shrink = rowH > 320 ? 0.93 : 0.86;
    size = Math.round(size * Math.pow(shrink, spans.length - 1));
  }
  size = Math.max(10, size);
  vals.style.fontSize = size + "px";
  if (!spans.length) return;
  const avail = vals.clientWidth || 120;
  const widest = Math.max(...spans.map((s) => s.span.getBoundingClientRect().width));
  if (widest > avail && widest > 0) {
    size = Math.max(10, Math.floor((size * avail) / widest));
    vals.style.fontSize = size + "px";
  }
  const dotSize = Math.max(5, Math.round(size * 0.5));
  for (const s of spans) {
    s.dot.style.width = dotSize + "px";
    s.dot.style.height = dotSize + "px";
  }
}

function updateSingleValues(chart, hoverX) {
  const info = chart._single;
  if (!info) return;
  if (info.mode) info.mode.textContent = hoverX == null ? "medie" : "al cursore";
  info.metrics.forEach((m, i) => {
    const def = METRICS[m] || {};
    const vals = info.rows[i].vals;
    vals.innerHTML = "";
    const entries = [];
    const dataSlices = m === "profile" ? (info.profile ? [info.profile] : []) : info.slices;
    dataSlices.forEach((sl) => {
      let y = null;
      if (hoverX == null) {
        y = metricAverage(sl, m);
      } else {
        const arr = info.xKey === "dist" ? sl.data.dist : sl.data.t;
        const idx = nearestIdx(arr, hoverX);
        if (idx != null) {
          const raw = metricSeries(sl, m)[idx];
          y = raw == null ? null : raw;
        }
      }
      if (y == null || !isFinite(y)) return;
      if (def.conv) y = def.conv(y);
      if (y == null || !isFinite(y)) return;
      entries.push({ sl, y });
    });
    const spans = [];
    entries.slice(0, MAX_PANEL_VALUES).forEach(({ sl, y }) => {
      const span = document.createElement("span");
      span.className = "rv-val" + (hoverX == null ? " avg" : "");
      span.title = `${sl.label}: ${fmtMetricValue(def, y)}`;
      const dot = document.createElement("i");
      dot.className = "rv-dot";
      dot.style.background = def.color || sl.color;
      span.append(dot, document.createTextNode(fmtMetricValue(def, y)));
      vals.appendChild(span);
      spans.push({ span, dot });
    });
    if (entries.length > MAX_PANEL_VALUES) {
      const more = document.createElement("span");
      more.className = "rv-more";
      more.textContent = `+${entries.length - MAX_PANEL_VALUES}`;
      vals.appendChild(more);
    }
    fitValuesFont(vals, spans);
  });
}

function bandsPlugin(bands) {
  return {
    id: "singleBands",
    afterDatasetsDraw(chart) {
      const area = chart.chartArea;
      const m = bands.length;
      if (!area || m < 1) return;
      const h = (area.bottom - area.top) / m;
      const ctx = chart.ctx;
      ctx.save();
      if (m > 1) {
        ctx.strokeStyle = "rgba(139, 152, 165, 0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        for (let i = 1; i < m; i++) {
          const y = area.top + h * i;
          ctx.beginPath();
          ctx.moveTo(area.left, y);
          ctx.lineTo(area.right, y);
          ctx.stroke();
        }
      }
      ctx.font = `${state.chartCfg.font}px 'Segoe UI', sans-serif`;
      bands.forEach((band, i) => {
        const def = METRICS[band.metric] || { short: band.metric };
        const top = area.top + h * i;
        const topVal = band.reversed ? band.lo : band.hi;
        const botVal = band.reversed ? band.hi : band.lo;
        ctx.fillStyle = "rgba(232, 237, 242, 0.75)";
        ctx.textBaseline = "top";
        ctx.fillText(`${def.short || band.metric}  ${fmtMetricValue(def, topVal)}`, area.left + 6, top + 4);
        ctx.fillStyle = "rgba(139, 152, 165, 0.85)";
        ctx.textBaseline = "bottom";
        ctx.fillText(fmtMetricValue(def, botVal), area.left + 6, top + h - 4);
      });
      ctx.restore();
    },
  };
}

function buildCharts(container, slices, enabled, xKey, single, profileSlice, chipCtx) {
  const charts = [];
  container.innerHTML = "";
  if (!slices.length) {
    container.innerHTML = '<div class="muted pad">Nessun dato da mostrare.</div>';
    return charts;
  }
  if (!enabled.length) {
    container.innerHTML = '<div class="muted pad">Seleziona almeno un attributo da mostrare.</div>';
    return charts;
  }
  const cfg = state.chartCfg;
  const fontCfg = { size: cfg.font };
  const baseH = Math.max(80, Math.round((cfg.height * cfg.yScale) / 100));
  container.style.width = cfg.xScale === 100 ? "" : cfg.xScale + "%";
  const xScale = () => ({
    type: "linear",
    bounds: "data",
    min: state.zoom ? state.zoom.min : undefined,
    max: state.zoom ? state.zoom.max : undefined,
    title: { display: true, text: xAxisTitle(xKey), font: fontCfg },
    ticks: { color: "#8b98a5", font: fontCfg },
    grid: { color: "#2b3540" },
  });
  const yScale = (reverse) => ({
    reverse: !!reverse,
    title: { display: false },
    ticks: { color: "#8b98a5", font: fontCfg },
    grid: { color: "#2b3540" },
  });
  const createBody = (wrap) => {
    const body = document.createElement("div");
    body.className = "chart-body";
    const holder = document.createElement("div");
    holder.className = "chart-canvas-holder";
    const canvas = document.createElement("canvas");
    holder.appendChild(canvas);
    body.appendChild(holder);
    wrap.appendChild(body);
    return { body, canvas };
  };

  if (single) {
    const list = enabled.slice();
    const count = list.length;
    const wrap = document.createElement("div");
    wrap.className = "chart-wrap single";
    wrap.style.height = Math.round(baseH * 2) + "px";
    wrap.style.marginBottom = cfg.gap + "px";
    wrap.appendChild(makeChartHead("Tutte le metriche", true, chipCtx));
    const { body, canvas } = createBody(wrap);
    const panel = document.createElement("div");
    panel.className = "chart-values";
    body.appendChild(panel);
    container.appendChild(wrap);

    const scales = { x: xScale() };
    const datasets = [];
    const bands = [];
    list.forEach((m, i) => {
      const def = METRICS[m] || { label: m };
      const reversed = m === "pace";
      const dataSlices = m === "profile" ? (profileSlice ? [profileSlice] : []) : slices;
      let mn = Infinity;
      let mx = -Infinity;
      dataSlices.forEach((sl) => {
        const ys = metricSeries(sl, m);
        for (const v of ys) {
          if (v == null) continue;
          const val = def.conv ? def.conv(v) : v;
          if (val == null || !isFinite(val)) continue;
          if (val < mn) mn = val;
          if (val > mx) mx = val;
        }
      });
      if (!isFinite(mn) || !isFinite(mx)) {
        mn = 0;
        mx = 1;
      }
      if (mx - mn < 1e-9) {
        mn -= 0.5;
        mx += 0.5;
      }
      const pad = (mx - mn) * 0.12;
      const lo = mn - pad;
      const hi = mx + pad;
      const span = hi - lo;
      const axisId = "y-" + m;
      if (reversed) {
        scales[axisId] = { display: false, reverse: true, min: lo - span * i, max: lo - span * i + span * count };
      } else {
        scales[axisId] = { display: false, min: lo - span * (count - 1 - i), max: hi + span * i };
      }
      bands.push({ metric: m, lo: mn, hi: mx, reversed });
      dataSlices.forEach((sl) => datasets.push(chartDataset(sl, m, xKey, axisId, true)));
    });
    const chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      plugins: [syncCursorPlugin, bandsPlugin(bands), valuesAlignPlugin],
      options: chartOptions(xKey, scales, true, false),
    });
    const rows = list.map((m) => {
      const def = METRICS[m] || {};
      const row = document.createElement("div");
      row.className = "rv-row";
      const name = document.createElement("span");
      name.className = "rv-name";
      name.textContent = def.short || m;
      const vals = document.createElement("span");
      vals.className = "rv-vals";
      row.append(name, vals);
      panel.appendChild(row);
      return { row, vals };
    });
    chart._valuesPanel = panel;
    chart._single = { metrics: list, slices, profile: profileSlice, xKey, rows, mode: wrap.querySelector(".chart-hover-mode") };
    wireChartMax(wrap, chart);
    attachHover(chart);
    layoutValuesPanel(chart);
    updateSingleValues(chart, null);
    restoreChartMax(wrap, chart);
    charts.push(chart);
    return charts;
  }

  for (const metric of enabled) {
    const def = METRICS[metric] || { label: metric };
    const dataSlices = metric === "profile" ? (profileSlice ? [profileSlice] : []) : slices;
    if (!dataSlices.length) continue;
    const wrap = document.createElement("div");
    wrap.className = "chart-wrap";
    wrap.style.height = baseH + "px";
    wrap.style.marginBottom = cfg.gap + "px";
    wrap.appendChild(makeChartHead(def.label, true, null));
    const { body, canvas } = createBody(wrap);
    const panel = document.createElement("div");
    panel.className = "chart-values";
    const row = document.createElement("div");
    row.className = "rv-row";
    const name = document.createElement("span");
    name.className = "rv-name";
    name.textContent = def.short || metric;
    name.title = def.label || metric;
    const vals = document.createElement("span");
    vals.className = "rv-vals";
    row.append(name, vals);
    panel.appendChild(row);
    body.appendChild(panel);
    container.appendChild(wrap);
    const datasets = dataSlices.map((sl) => chartDataset(sl, metric, xKey, "y", false));
    const chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      plugins: [syncCursorPlugin, valuesAlignPlugin],
      options: chartOptions(xKey, { x: xScale(), y: yScale(metric === "pace") }, false, false),
    });
    chart._valuesPanel = panel;
    chart._single = {
      metrics: [metric],
      slices: dataSlices,
      profile: metric === "profile" ? dataSlices[0] : null,
      xKey,
      rows: [{ row, vals }],
      mode: wrap.querySelector(".chart-hover-mode"),
    };
    wireChartMax(wrap, chart);
    attachHover(chart);
    layoutValuesPanel(chart);
    updateSingleValues(chart, null);
    restoreChartMax(wrap, chart);
    charts.push(chart);
  }
  return charts;
}

function renderCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  clearHover();
  const stale = $("#analysis-charts");
  if (stale) stale.innerHTML = "";
  const container = $("#charts");
  if (!state.results.length) {
    container.innerHTML = '<div class="muted pad">Esegui prima una ricerca sul segmento.</div>';
    return;
  }
  const slices = addedSlices();
  if (!slices.length) {
    container.innerHTML = '<div class="muted pad">Aggiungi almeno una traccia dall\'elenco a sinistra.</div>';
    return;
  }
  const profileSlice = state.profileCache ? state.profileCache.slice : null;
  const enabled = state.availableMetrics.filter((m) => {
    if (!state.metricEnabled[m]) return false;
    if (m === "profile") return hasProfileData(profileSlice);
    return metricHasData(m, slices);
  });
  if (!enabled.length) {
    container.innerHTML = '<div class="muted pad">Seleziona almeno un attributo da mostrare.</div>';
    return;
  }
  state.charts = buildCharts(container, slices, enabled, state.xAxis, state.compareSingle, profileSlice, {
    available: state.availableMetrics,
    enabled: state.metricEnabled,
    toggle: async (m) => {
      state.metricEnabled[m] = !state.metricEnabled[m];
      if (m === "profile" && state.metricEnabled[m]) {
        try {
          await ensureCompareProfile();
        } catch (_) { /* ignore */ }
      }
      renderMetricChips();
      renderCharts();
    },
  });
}

/* ---------------- TREND (andamento parametri) ---------------- */

const TREND_FETCH_FIELDS = ["cadence", "power", "temp", "altitude", "gradient"];

let trendToken = 0;

function trendAvailableMetrics(indices) {
  const set = metricsAvailableFor(indices);
  return METRIC_ORDER.filter((m) => m !== "profile" && set.has(m));
}

function resetTrend() {
  state.trendCache = {};
  state.trendRange = null;
  state.trendRangeAll = null;
  const avail = trendAvailableMetrics(state.results.map((_, i) => i));
  state.trend.available = avail;
  for (const m of Object.keys(state.trend.enabled)) {
    if (!avail.includes(m)) delete state.trend.enabled[m];
  }
  ensureDefaultMetrics(state.trend.available, state.trend.enabled, state.activity && state.activity.sport, "trend");
}

function destroyTrendChart() {
  trendToken++;
  if (state.trendChart) {
    state.trendChart.destroy();
    state.trendChart = null;
  }
}

async function fetchTrendSlice(i) {
  if (state.trendCache[i]) return state.trendCache[i];
  const r = state.results[i];
  const data = await api(
    `/api/activities/${r.activity_id}/track?from_idx=${r.pass_start_idx}&to_idx=${r.pass_end_idx}&fields=altitude,gradient,cadence,power,temp&max_points=600`
  );
  state.trendCache[i] = data;
  return data;
}

function trendValue(r, metric, slice) {
  if (metric === "speed") return r.avg_speed_mps;
  if (metric === "pace") {
    const s = r.avg_speed_mps;
    return s != null && s > 0.5 ? 1000 / s / 60 : null;
  }
  if (metric === "hr") return r.avg_hr;
  if (metric === "hrpace") {
    const s = r.avg_speed_mps;
    return s != null && s > 0.5 && r.avg_hr > 0 ? (s * 60) / r.avg_hr : null;
  }
  if (!slice) return null;
  return metricAverage({ data: slice }, metric);
}

function renderTrendChips() {
  const box = $("#trend-chips");
  box.innerHTML = "";
  if (!state.trend.available.length) {
    box.innerHTML = '<span class="muted">Nessun attributo disponibile</span>';
    return;
  }
  for (const m of state.trend.available) {
    const def = METRICS[m] || { label: m, short: m };
    const b = document.createElement("button");
    b.className = "chip" + (state.trend.enabled[m] ? " active" : "");
    b.title = def.label || m;
    const dot = document.createElement("i");
    dot.className = "chip-dot";
    dot.style.background = def.color || "#4cc9f0";
    b.append(dot, document.createTextNode(def.short || def.label || m));
    b.onclick = () => {
      state.trend.enabled[m] = !state.trend.enabled[m];
      refreshTrend();
    };
    box.appendChild(b);
  }
}

const trendCursorPlugin = {
  id: "trendCursor",
  afterDatasetsDraw(chart) {
    const idx = chart.$hoverIdx;
    if (idx == null || !chart.scales.x) return;
    const px = chart.scales.x.getPixelForValue(idx);
    const area = chart.chartArea;
    if (px < area.left || px > area.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = "rgba(232, 237, 242, 0.5)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(px, area.top);
    ctx.lineTo(px, area.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function drawTrendChart(rows, enabled) {
  const container = $("#trend-charts");
  container.innerHTML = "";
  const cfg = state.chartCfg;
  const fontCfg = { size: cfg.font };
  container.style.width = cfg.xScale === 100 ? "" : cfg.xScale + "%";

  const series = new Map();
  for (const m of enabled) {
    const def = METRICS[m] || { label: m, short: m };
    const data = [];
    rows.forEach(({ r, i }, rowIdx) => {
      let v = trendValue(r, m, state.trendCache[i]);
      if (v == null || !isFinite(v)) return;
      if (def.conv) v = def.conv(v);
      if (v == null || !isFinite(v)) return;
      data.push({ x: rowIdx, y: v, i, activity: r });
    });
    if (data.length) series.set(m, data);
  }
  if (!series.size) {
    container.innerHTML = '<div class="muted pad">Nessun dato disponibile per gli attributi scelti.</div>';
    return false;
  }

  const labels = rows.map(({ r }) => resultLabel(r));
  const used = [...series.keys()];
  const yAxisFor = (m) => (used.length === 1 ? "y" : `y-${m}`);
  const wrap = document.createElement("div");
  wrap.className = "chart-wrap trend";
  wrap.style.height = Math.max(240, Math.round((cfg.height * cfg.yScale) / 100)) + "px";
  wrap.style.marginBottom = cfg.gap + "px";
  const head = makeChartHead("Andamento parametri", true, {
    available: state.trend.available,
    enabled: state.trend.enabled,
    toggle: (m) => {
      state.trend.enabled[m] = !state.trend.enabled[m];
      refreshTrend();
    },
  });
  wrap.appendChild(head);
  const body = document.createElement("div");
  body.className = "chart-body";
  const holder = document.createElement("div");
  holder.className = "chart-canvas-holder";
  const canvas = document.createElement("canvas");
  holder.appendChild(canvas);
  body.appendChild(holder);
  const panel = document.createElement("div");
  panel.className = "chart-values";
  const panelRows = used.map((m) => {
    const def = METRICS[m] || {};
    const row = document.createElement("div");
    row.className = "rv-row";
    const name = document.createElement("span");
    name.className = "rv-name";
    name.textContent = def.short || m;
    name.title = def.label || m;
    const vals = document.createElement("span");
    vals.className = "rv-vals";
    row.append(name, vals);
    panel.appendChild(row);
    return { row, vals };
  });
  body.appendChild(panel);
  wrap.appendChild(body);
  container.appendChild(wrap);

  const datasets = used.map((m) => {
    const def = METRICS[m] || { label: m, short: m };
    return {
      metric: m,
      label: def.short || def.label || m,
      data: series.get(m),
      borderColor: def.color || "#4cc9f0",
      backgroundColor: def.color || "#4cc9f0",
      borderWidth: 1.6,
      pointRadius: rows.length > 48 ? 3 : rows.length > 24 ? 4 : 5,
      pointHoverRadius: 7,
      pointBorderColor: "#08131a",
      pointBorderWidth: 1,
      showLine: true,
      tension: 0.28,
      spanGaps: true,
      xAxisID: "x",
      yAxisID: yAxisFor(m),
    };
  });

  const scales = {
    x: {
      type: "linear",
      min: -0.5,
      max: Math.max(0.5, rows.length - 0.5),
      ticks: {
        color: "#8b98a5",
        font: fontCfg,
        stepSize: 1,
        autoSkip: true,
        maxRotation: 45,
        padding: 4,
        callback: (v) => {
          const idx = Math.round(v);
          return labels[idx] != null ? labels[idx] : "";
        },
      },
      grid: { color: "#2b3540" },
    },
  };
  used.forEach((m, idx) => {
    const def = METRICS[m] || { label: m, short: m };
    scales[yAxisFor(m)] = {
      type: "linear",
      bounds: "data",
      position: "left",
      title: { display: true, text: def.label || m, font: fontCfg, color: def.color || "#8b98a5" },
      ticks: { color: "#8b98a5", font: fontCfg },
      grid: { color: "#2b3540", drawOnChartArea: idx === 0 },
    };
  });

  const chart = new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: { datasets },
    plugins: [valuesAlignPlugin, trendCursorPlugin],
    options: {
      animation: false,
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", intersect: false, axis: "x" },
      scales,
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      },
      onClick: (_evt, elements) => {
        if (!elements.length) return;
        const raw = elements[0].element.$context.raw;
        if (raw && raw.i != null) zoomToPass(raw.i);
      },
    },
  });
  chart._trend = true;
  chart._valuesPanel = panel;
  chart._trendValues = { metrics: used, series, labels, rows: panelRows, mode: head.querySelector(".chart-hover-mode") };
  state.trendChart = chart;
  wireChartMax(wrap, chart);
  attachTrendHover(chart);
  layoutValuesPanel(chart);
  applyTrendRange();
  updateTrendValues(chart, null);
  restoreChartMax(wrap, chart);
  return true;
}

function updateTrendValues(chart, hoverX) {
  const info = chart._trendValues;
  if (!info) return;
  if (info.mode) {
    if (hoverX == null) {
      info.mode.textContent = "medie";
    } else {
      const idx = Math.max(0, Math.min(info.labels.length - 1, Math.round(hoverX)));
      info.mode.textContent = `al cursore · ${info.labels[idx] || ""}`;
    }
  }
  info.metrics.forEach((m, i) => {
    const def = METRICS[m] || {};
    const vals = info.rows[i].vals;
    vals.innerHTML = "";
    const pts = info.series.get(m) || [];
    let value = null;
    let title = def.label || m;
    if (hoverX == null) {
      const range = state.trendRange;
      const from = range ? range.from : -Infinity;
      const to = range ? range.to : Infinity;
      const vis = pts.filter((p) => p.x >= from && p.x <= to);
      value = meanFinite(vis.map((p) => p.y));
      if (value != null) title = `${def.label || m} · media su ${vis.length} attività`;
    } else {
      const idx = nearestIndexByX(pts, hoverX);
      if (idx >= 0) {
        value = pts[idx].y;
        title = `${resultLabel(pts[idx].activity)}: ${fmtMetricValue(def, value)}`;
      }
    }
    if (value == null || !isFinite(value)) return;
    const span = document.createElement("span");
    span.className = "rv-val" + (hoverX == null ? " avg" : "");
    span.title = title;
    const dot = document.createElement("i");
    dot.className = "rv-dot";
    dot.style.background = def.color || "#4cc9f0";
    span.append(dot, document.createTextNode(fmtMetricValue(def, value)));
    vals.appendChild(span);
  });
}

function attachTrendHover(chart) {
  let raf = null;
  const apply = (xVal) => {
    const els = [];
    if (xVal != null) {
      chart.data.datasets.forEach((ds, di) => {
        const idx = nearestIndexByX(ds.data, xVal);
        if (idx >= 0) els.push({ datasetIndex: di, index: idx });
      });
    }
    const maxIdx = chart._trendValues ? chart._trendValues.labels.length - 1 : -1;
    chart.$hoverIdx =
      xVal == null || maxIdx < 0 ? null : Math.max(0, Math.min(maxIdx, Math.round(xVal)));
    chart.setActiveElements(els);
    chart.update("none");
    updateTrendValues(chart, xVal);
  };
  chart.canvas.addEventListener("mousemove", (e) => {
    const rect = chart.canvas.getBoundingClientRect();
    const area = chart.chartArea;
    const mx = e.clientX - rect.left;
    let xVal = null;
    if (area && mx >= area.left && mx <= area.right) {
      const v = chart.scales.x.getValueForPixel(mx);
      if (v != null && isFinite(v)) xVal = v;
    }
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = null;
      apply(xVal);
    });
  });
  chart.canvas.addEventListener("mouseleave", () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    apply(null);
  });
}

function trendRowsKey(rows) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  return [
    rows.length,
    first ? first.i : "",
    first ? resultLabel(first.r) : "",
    last ? last.i : "",
    last ? resultLabel(last.r) : "",
  ].join("|");
}

function updateTrendRangeUI(show) {
  const rows = state.trendRangeAll || [];
  const total = rows.length;
  const wrap = $("#trend-range-wrap");
  const visible = show !== false && total >= 3;
  wrap.classList.toggle("hidden", !visible);
  if (!visible) return;
  const last = total - 1;
  const range = state.trendRange || { from: 0, to: last };
  const from = Math.max(0, Math.min(range.from, last));
  const to = Math.max(from, Math.min(range.to, last));
  const pf = (from / last) * 100;
  const pe = (to / last) * 100;
  $("#trs-handle-start").style.left = pf + "%";
  $("#trs-handle-end").style.left = pe + "%";
  $("#trs-fill").style.left = pf + "%";
  $("#trs-fill").style.width = Math.max(0, pe - pf) + "%";
  $("#trs-start-label").textContent = resultLabel(rows[from].r);
  $("#trs-end-label").textContent = resultLabel(rows[to].r);
  $("#trs-info").textContent = `${to - from + 1}/${total} attività`;
}

function applyTrendRange() {
  const chart = state.trendChart;
  if (!chart || !chart._trendValues) return;
  const last = Math.max(0, (state.trendRangeAll || []).length - 1);
  const range = state.trendRange;
  const from = Math.max(0, Math.min(range ? range.from : 0, last));
  const to = Math.max(from, Math.min(range ? range.to : last, last));
  const xs = chart.options.scales.x;
  xs.min = from - 0.5;
  xs.max = to + 0.5;
  for (const ds of chart.data.datasets) {
    const scale = chart.options.scales[ds.yAxisID];
    if (!scale) continue;
    let mn = Infinity;
    let mx = -Infinity;
    for (const p of ds.data) {
      if (p.x < from || p.x > to) continue;
      if (p.y < mn) mn = p.y;
      if (p.y > mx) mx = p.y;
    }
    if (isFinite(mn) && isFinite(mx)) {
      if (mx - mn < 1e-9) {
        mn -= 0.5;
        mx += 0.5;
      }
      const pad = (mx - mn) * 0.12;
      scale.min = mn - pad;
      scale.max = mx + pad;
    } else {
      delete scale.min;
      delete scale.max;
    }
  }
  chart.update("none");
}

function scheduleTrendRangeApply() {
  if (scheduleTrendRangeApply.raf) return;
  scheduleTrendRangeApply.raf = requestAnimationFrame(() => {
    scheduleTrendRangeApply.raf = null;
    applyTrendRange();
    updateTrendValues(state.trendChart, null);
  });
}

function setTrendRange(from, to) {
  const rows = state.trendRangeAll || [];
  const last = Math.max(0, rows.length - 1);
  from = Math.max(0, Math.min(from, last));
  to = Math.max(from, Math.min(to, last));
  const key = state.trendRange ? state.trendRange.key : trendRowsKey(rows);
  state.trendRange = { from, to, key };
  updateTrendRangeUI(true);
  scheduleTrendRangeApply();
}

function initTrendRangeSlider() {
  const slider = $("#trend-range-slider");
  const fill = $("#trs-fill");
  const handles = { start: $("#trs-handle-start"), end: $("#trs-handle-end") };
  let drag = null;
  let moveDrag = null;

  const fracFromEvent = (e) => {
    const rect = slider.getBoundingClientRect();
    if (!rect.width) return 0;
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  };

  const idxFromFrac = (f) => {
    const total = (state.trendRangeAll || []).length;
    if (total < 2) return 0;
    return Math.max(0, Math.min(total - 1, Math.round(f * (total - 1))));
  };

  const current = () => {
    const last = Math.max(0, (state.trendRangeAll || []).length - 1);
    const r = state.trendRange;
    return { from: r ? r.from : 0, to: r ? r.to : last };
  };

  const applyHandle = (which, idx) => {
    const cur = current();
    if (which === "start") setTrendRange(Math.min(idx, cur.to), cur.to);
    else setTrendRange(cur.from, Math.max(idx, cur.from));
  };

  const beginDrag = (which, e) => {
    if (!state.trendChart) return;
    drag = which;
    handles[which].classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const beginMove = (e) => {
    const cur = current();
    moveDrag = { startFrac: fracFromEvent(e), from: cur.from, to: cur.to };
    fill.classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const moveSelection = (e) => {
    const total = (state.trendRangeAll || []).length;
    if (total < 2) return;
    const delta = Math.round((fracFromEvent(e) - moveDrag.startFrac) * (total - 1));
    let from = moveDrag.from + delta;
    let to = moveDrag.to + delta;
    if (from < 0) {
      to -= from;
      from = 0;
    }
    if (to > total - 1) {
      from -= to - (total - 1);
      to = total - 1;
    }
    setTrendRange(from, to);
  };

  handles.start.addEventListener("pointerdown", (e) => beginDrag("start", e));
  handles.end.addEventListener("pointerdown", (e) => beginDrag("end", e));

  slider.addEventListener("pointermove", (e) => {
    if (drag) applyHandle(drag, idxFromFrac(fracFromEvent(e)));
    else if (moveDrag) moveSelection(e);
  });

  const stop = () => {
    if (drag) {
      handles[drag].classList.remove("dragging");
      drag = null;
    }
    if (moveDrag) {
      fill.classList.remove("dragging");
      moveDrag = null;
    }
  };
  slider.addEventListener("pointerup", stop);
  slider.addEventListener("pointercancel", stop);

  slider.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("rs-handle")) return;
    if (e.target.classList.contains("rs-fill")) {
      beginMove(e);
      return;
    }
    const total = (state.trendRangeAll || []).length;
    if (total < 2) return;
    const idx = idxFromFrac(fracFromEvent(e));
    const cur = current();
    const which = Math.abs(idx - cur.from) <= Math.abs(idx - cur.to) ? "start" : "end";
    drag = which;
    handles[which].classList.add("dragging");
    slider.setPointerCapture(e.pointerId);
    applyHandle(which, idx);
  });

  $("#trs-reset").onclick = () => setTrendRange(0, (state.trendRangeAll || []).length - 1);
}

async function refreshTrend() {
  destroyTrendChart();
  const token = trendToken;
  const container = $("#trend-charts");
  const hasResults = state.results.length > 0;
  $("#trend-empty").classList.toggle("hidden", hasResults);
  $("#trend-layout").classList.toggle("hidden", !hasResults);
  $("#trend-info").textContent = "";
  if (!hasResults) {
    container.innerHTML = "";
    return;
  }
  const rows = compareRows(state.trendSort);
  const rk = trendRowsKey(rows);
  if (!state.trendRange || state.trendRange.key !== rk) {
    state.trendRange = { from: 0, to: Math.max(0, rows.length - 1), key: rk };
  } else {
    const last = Math.max(0, rows.length - 1);
    state.trendRange.from = Math.max(0, Math.min(state.trendRange.from, last));
    state.trendRange.to = Math.max(state.trendRange.from, Math.min(state.trendRange.to, last));
  }
  state.trendRangeAll = rows;
  renderTrendChips();
  const enabled = state.trend.available.filter((m) => state.trend.enabled[m]);
  if (!rows.length) {
    updateTrendRangeUI(false);
    container.innerHTML = '<div class="muted pad">Nessuna attività con i filtri attuali.</div>';
    return;
  }
  if (!enabled.length) {
    updateTrendRangeUI(false);
    container.innerHTML = '<div class="muted pad">Seleziona almeno un attributo da mostrare.</div>';
    return;
  }
  const need = rows.filter(({ i }) => enabled.some((m) => TREND_FETCH_FIELDS.includes(m)) && !state.trendCache[i]);
  if (need.length) {
    let done = 0;
    $("#trend-info").textContent = `Caricamento dati 0/${need.length}...`;
    await Promise.all(
      need.map(async ({ i }) => {
        try {
          await fetchTrendSlice(i);
        } catch (_) { /* ignore */ }
        done++;
        if (token === trendToken) $("#trend-info").textContent = `Caricamento dati ${done}/${need.length}...`;
      })
    );
    if (token !== trendToken) return;
  }
  const drawn = drawTrendChart(rows, enabled);
  updateTrendRangeUI(drawn);
  if (drawn) $("#trend-info").textContent = `${rows.length} attività · passa il cursore per i valori, clicca per centrare il passaggio sulla mappa`;
}

/* ---------------- SINGLE ACTIVITY ANALYSIS ---------------- */

function analysisMetricsAvailable() {
  const a = state.activity;
  const avail = new Set();
  if (!a) return avail;
  if (a.has_speed) {
    avail.add("speed");
    avail.add("pace");
  }
  if (a.has_hr) avail.add("hr");
  if (a.has_speed && a.has_hr) avail.add("hrpace");
  if (a.has_cadence) avail.add("cadence");
  if (a.has_altitude) {
    avail.add("altitude");
    avail.add("gradient");
    avail.add("profile");
  }
  if (a.has_power) avail.add("power");
  if (a.has_temp) avail.add("temp");
  return avail;
}

function resetAnalysis() {
  const avail = analysisMetricsAvailable();
  state.analysis.available = METRIC_ORDER.filter((m) => avail.has(m));
  const prev = state.analysis.enabled || {};
  state.analysis.enabled = {};
  for (const m of state.analysis.available) state.analysis.enabled[m] = prev[m] === true;
  ensureDefaultMetrics(state.analysis.available, state.analysis.enabled, state.activity && state.activity.sport, "analysis");
  state.analysis.slice = null;
  state.analysis.baseIdx = null;
  renderAnalysisChips();
}

function renderAnalysisChips() {
  const box = $("#analysis-chips");
  box.innerHTML = "";
  if (!state.analysis.available.length) {
    box.innerHTML = '<span class="muted">Nessun attributo disponibile</span>';
    return;
  }
  for (const m of state.analysis.available) {
    const def = METRICS[m] || { label: m, short: m };
    const b = document.createElement("button");
    b.className = "chip" + (state.analysis.enabled[m] ? " active" : "");
    b.textContent = def.short || def.label;
    b.title = def.label;
    b.onclick = () => {
      state.analysis.enabled[m] = !state.analysis.enabled[m];
      renderAnalysisChips();
      renderAnalysisCharts();
    };
    box.appendChild(b);
  }
}

function analysisRange() {
  const t = state.track;
  if (!t || !t.t.length) return null;
  const s = state.segment;
  const full = s.startIdx == null || s.endIdx == null;
  return { si: full ? 0 : s.startIdx, ei: full ? t.t.length - 1 : s.endIdx, full };
}

function renderAnalysisHeader() {
  const el = $("#analysis-info");
  const a = state.activity;
  const r = analysisRange();
  if (!a || !state.track || !r) {
    el.textContent = "Seleziona un'attività e un segmento (sulla mappa o con il selettore temporale).";
    return;
  }
  const dur = state.track.t[r.ei] - state.track.t[r.si];
  const dist = state.track.dist[r.ei] - state.track.dist[r.si];
  const range = r.full
    ? "intera attività"
    : `da ${fmtDuration(state.track.t[r.si])} a ${fmtDuration(state.track.t[r.ei])}`;
  el.innerHTML = `<b>${escapeHtml(activityLabel(a.start_time, a.filename))}</b> · ${range} · ${fmtDist(dist)} · ${fmtDuration(dur)} · ${r.ei - r.si + 1} punti`;
}

async function refreshAnalysis() {
  resetZoomState();
  renderAnalysisHeader();
  const container = $("#analysis-charts");
  const r = analysisRange();
  const has = !!(state.activity && state.track && r);
  $("#analysis-empty").classList.toggle("hidden", has);
  $("#analysis-layout").classList.toggle("hidden", !has);
  if (!has) {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    clearHover();
    container.innerHTML = "";
    return;
  }
  const fields = "speed,hr,cadence,altitude,power,temp";
  state.analysis.baseIdx = r.si;
  try {
    const data = await api(
      `/api/activities/${state.activity.id}/track?from_idx=${r.si}&to_idx=${r.ei}&fields=${fields}&gradient=1`
    );
    const dur = state.track.t[r.ei] - state.track.t[r.si];
    state.analysis.slice = {
      result: {
        activity_id: state.activity.id,
        filename: state.activity.filename,
        duration_s: dur,
        is_best: false,
        is_source: true,
      },
      color: "#4cc9f0",
      dash: [],
      data,
      label: `${activityLabel(state.activity.start_time, state.activity.filename)} (${fmtDuration(dur)})`,
    };
  } catch (e) {
    toast(`Errore caricamento dati: ${e.message}`);
    return;
  }
  if (state.tab !== "analysis") return;
  renderAnalysisChips();
  renderAnalysisCharts();
}

function renderAnalysisCharts() {
  state.charts.forEach((c) => c.destroy());
  state.charts = [];
  clearHover();
  const stale = $("#charts");
  if (stale) stale.innerHTML = "";
  const container = $("#analysis-charts");
  const sl = state.analysis.slice;
  if (!sl) {
    container.innerHTML = '<div class="muted pad">Seleziona un segmento per vedere i grafici.</div>';
    return;
  }
  const profileSlice = hasProfileData(sl) ? sl : null;
  const enabled = state.analysis.available.filter((m) => {
    if (!state.analysis.enabled[m]) return false;
    if (m === "profile") return hasProfileData(profileSlice);
    return metricHasData(m, [sl]);
  });
  if (!enabled.length) {
    container.innerHTML = '<div class="muted pad">Seleziona almeno un attributo da mostrare.</div>';
    return;
  }
  state.charts = buildCharts(container, [sl], enabled, state.analysis.xAxis, state.analysis.single, profileSlice, {
    available: state.analysis.available,
    enabled: state.analysis.enabled,
    toggle: (m) => {
      state.analysis.enabled[m] = !state.analysis.enabled[m];
      renderAnalysisChips();
      renderAnalysisCharts();
    },
  });
}

function scheduleAnalysisRefresh() {
  if (state.tab !== "analysis") return;
  clearTimeout(state.analysisTimer);
  state.analysisTimer = setTimeout(() => {
    if (state.tab === "analysis") refreshAnalysis();
  }, 250);
}

/* ---------------- SCAN ---------------- */

async function startScan(force) {
  try {
    const res = await api(`/api/scan?force=${force ? "true" : "false"}`, { method: "POST" });
    if (!res.started) toast("Scansione già in corso");
    pollScan();
  } catch (e) {
    toast(`Errore scansione: ${e.message}`);
  }
}

function setScanRunning(running, st) {
  const box = $("#scan-box");
  if (!box) return;
  box.classList.toggle("hidden", !running);
  if (!running) {
    $("#scan-bar-fill").style.width = "0%";
    return;
  }
  const total = (st && st.total) || 0;
  const done = (st && st.done) || 0;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  $("#scan-bar-fill").style.width = pct + "%";
  $("#scan-text").textContent = `Indicizzo ${done}/${total}${st && st.current ? " · " + st.current : ""}`;
}

function pollScan() {
  clearInterval(state.scanTimer);
  state.scanTimer = setInterval(async () => {
    let st;
    try {
      st = await api("/api/scan/status");
    } catch (_) {
      return;
    }
    if (st.running) {
      setScanRunning(true, st);
      return;
    }
    clearInterval(state.scanTimer);
    setScanRunning(false);
    const parts = [`${st.indexed || 0} nuovi`, `${st.updated || 0} aggiornati`, `${st.skipped || 0} invariati`];
    if (st.removed) parts.push(`${st.removed} rimossi`);
    if (st.failed) parts.push(`${st.failed} errori`);
    if (st.error) parts.push(`errore: ${st.error}`);
    $("#scan-status").textContent = `Ultima scansione: ${parts.join(", ")}`;
    await loadActivities();
    await loadStatus();
  }, 400);
}

/* ---------------- GARMIN ---------------- */

function setIfIdle(sel, value, prop) {
  const el = $(sel);
  if (!el) return;
  prop = prop || "value";
  if (document.activeElement !== el && el[prop] !== value) el[prop] = value;
}

async function setSource(mode) {
  mode = mode === "garmin" ? "garmin" : "local";
  state.source = mode;
  localStorage.setItem("sf-source", mode);
  document.querySelectorAll("#source-switch button").forEach((b) => {
    b.classList.toggle("active", b.dataset.source === mode);
  });
  $("#local-actions").classList.toggle("hidden", mode !== "local");
  $("#scan-status").classList.toggle("hidden", mode !== "local");
  $("#garmin-status").classList.toggle("hidden", mode !== "garmin");
  if (mode !== "local") $("#scan-box").classList.add("hidden");
  $("#garmin-actions").classList.toggle("hidden", mode !== "garmin");
  if (mode === "garmin") {
    let st = await refreshGarmin();
    if (st && !st.logged_in && st.token_saved && !st.login_error) {
      startGarminPolling();
      for (let i = 0; i < 8 && st && !st.logged_in && !st.login_error; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        st = await refreshGarmin();
      }
    }
    if (st && !st.logged_in) openSettingsPanel();
  }
}

async function refreshGarmin() {
  let st;
  try {
    st = await api("/api/garmin/status");
  } catch (e) {
    toast(`Garmin: ${e.message}`);
    return null;
  }
  renderGarmin(st);
  return st;
}

function garminIsBusy(st) {
  return st.login_state === "connecting" || st.login_state === "mfa" || !!(st.sync && st.sync.running);
}

function renderGarmin(st) {
  state.garmin.status = st;
  const sync = st.sync || {};
  const el = $("#garmin-status");
  if (sync.running) {
    const phase = sync.phase === "indexing" ? "Indicizzo" : "Scarico";
    el.textContent = `${phase} ${sync.done}/${sync.total}${sync.current ? " · " + sync.current : ""}`;
  } else if (st.login_state === "connecting") {
    el.textContent = "Connessione a Garmin...";
  } else if (st.login_state === "mfa" || st.mfa_pending) {
    el.textContent = "In attesa del codice MFA...";
  } else {
    el.textContent = "";
  }
  updateGarminForm(st);
  updateGarminProgress(sync);
  if (garminIsBusy(st)) startGarminPolling();
  else stopGarminPolling();
}

function updateGarminForm(st) {
  const mfa = st.mfa_pending || st.login_state === "mfa";
  $("#gp-mfa").classList.toggle("hidden", !mfa);
  $("#gp-login").classList.toggle("hidden", st.logged_in);
  $("#gp-account").classList.toggle("hidden", !st.logged_in);
  const last = st.last_sync ? ` · ultima sincronizzazione ${fmtDate(st.last_sync)}` : "";
  $("#gp-user").textContent = st.logged_in
    ? `Connesso come ${st.display_name || st.email || "utente Garmin"}${st.synced ? ` · ${st.synced} attività scaricate` : ""}${last}`
    : "";
  setIfIdle("#gp-email", st.email || "", "value");
  setIfIdle("#gp-auto", !!st.auto_sync, "checked");
  setIfIdle("#gp-gps", !!st.gps_only, "checked");
  setIfIdle("#gp-sport", st.sport || "", "value");
  const msg = $("#gp-msg");
  if (!st.available) {
    msg.textContent = "Libreria garminconnect non installata: esegui pip install -r requirements.txt.";
  } else if (st.login_state === "error" && st.login_error) {
    msg.textContent = st.login_error;
  } else if (mfa) {
    msg.textContent = "Inserisci il codice di verifica ricevuto da Garmin.";
  } else {
    msg.textContent = "";
  }
  if (st.logged_in) $("#gp-password").value = "";
}

function updateGarminProgress(sync) {
  const wrap = $("#gp-progress");
  const running = !!(sync && sync.running);
  wrap.classList.toggle("hidden", !running);
  if (!running) return;
  const total = sync.total || 0;
  const pct = total ? Math.min(100, Math.round(((sync.done || 0) / total) * 100)) : 0;
  $("#gp-progress-fill").style.width = pct + "%";
  $("#gp-progress-text").textContent = `${sync.message || ""}${total ? ` (${sync.done || 0}/${total})` : ""}`;
}

function openSettingsPanel() {
  $("#app-settings-backdrop").classList.remove("hidden");
  $("#app-settings-panel").classList.remove("hidden");
  openPopups.set($("#app-settings-panel"), null);
  refreshGarmin();
}

function closeSettingsPanel() {
  hidePopup($("#app-settings-panel"));
  $("#app-settings-backdrop").classList.add("hidden");
}

function startGarminPolling() {
  if (state.garmin.timer) return;
  state.garmin.timer = setInterval(async () => {
    let st;
    try {
      st = await api("/api/garmin/status");
    } catch (_) {
      return;
    }
    const prev = state.garmin.status;
    const prevLogin = prev ? prev.login_state : null;
    const prevRunning = !!(prev && prev.sync && prev.sync.running);
    renderGarmin(st);
    if ((prevLogin === "connecting" || prevLogin === "mfa") && st.login_state === "logged_in") {
      toast(`Connesso a Garmin${st.display_name ? " come " + st.display_name : ""}`);
    }
    if ((prevLogin === "connecting" || prevLogin === "mfa") && st.login_state === "error") {
      toast(`Garmin: ${st.login_error || "accesso non riuscito"}`);
    }
    if (prevRunning && !(st.sync && st.sync.running)) {
      if (st.sync && st.sync.phase === "done") {
        toast(`Garmin: ${st.sync.message || "sincronizzazione completata"}`);
        loadActivities();
        loadStatus();
      } else if (st.sync && st.sync.phase === "error") {
        toast(`Garmin: ${st.sync.error || "errore di sincronizzazione"}`);
      }
    }
  }, 1000);
}

function stopGarminPolling() {
  clearInterval(state.garmin.timer);
  state.garmin.timer = null;
}

/* ---------------- UI BINDINGS ---------------- */

function switchTab(name) {
  state.tab = name;
  resetZoomState();
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $("#tab-compare").classList.toggle("hidden", name !== "compare");
  $("#tab-analysis").classList.toggle("hidden", name !== "analysis");
  $("#tab-trend").classList.toggle("hidden", name !== "trend");
  if (name !== "trend") destroyTrendChart();
  if (name === "compare") refreshCompare();
  if (name === "analysis") refreshAnalysis();
  if (name === "trend") refreshTrend();
}

function updateBubble() {
  const bubble = $("#map-bubble");
  const hidden = $("#content").classList.contains("map-hidden");
  bubble.classList.toggle("hidden", !(state.layout === "popup" && hidden));
}

function showMap() {
  $("#content").classList.remove("map-hidden");
  const btn = $("#btn-map-toggle");
  btn.classList.add("active");
  btn.title = "Nascondi mappa";
  updateBubble();
  setTimeout(() => state.map.invalidateSize(), 60);
}

function hideMap() {
  $("#content").classList.add("map-hidden");
  const btn = $("#btn-map-toggle");
  btn.classList.remove("active");
  btn.title = "Mostra mappa";
  updateBubble();
  setTimeout(() => state.map.invalidateSize(), 60);
}

function toggleMap() {
  if ($("#content").classList.contains("map-hidden")) showMap();
  else hideMap();
  setTimeout(() => state.charts.forEach((c) => c.resize()), 60);
}

function renderLayoutButtons() {
  document.querySelectorAll("#layout-buttons .icon-toggle").forEach((b) => {
    b.classList.toggle("active", b.dataset.layout === state.layout);
  });
}

function applyPanelFrac() {
  const content = $("#content");
  const bottom = $("#bottom");
  if (!content || !bottom) return;
  if (state.layout === "split") {
    content.style.gridTemplateColumns = `${(state.panelFrac.split * 100).toFixed(2)}% 5px minmax(0, 1fr)`;
    bottom.style.flexBasis = "";
  } else if (state.layout === "vertical") {
    content.style.gridTemplateColumns = "";
    bottom.style.flexBasis = `${((1 - state.panelFrac.vertical) * 100).toFixed(2)}%`;
  } else {
    content.style.gridTemplateColumns = "";
    bottom.style.flexBasis = "";
  }
}

function schedulePanelRefresh() {
  if (schedulePanelRefresh.raf) return;
  schedulePanelRefresh.raf = requestAnimationFrame(() => {
    schedulePanelRefresh.raf = null;
    state.map.invalidateSize();
    state.charts.forEach((c) => c.resize());
    repositionOpenPopups();
  });
}

function initPanelResize() {
  const resizer = $("#panel-resizer");
  const content = $("#content");
  const mapWrap = $("#map-wrap");
  const topbar = $("#topbar");
  let drag = null;
  const clamp = (v) => Math.min(0.85, Math.max(0.15, v));

  resizer.addEventListener("pointerdown", (e) => {
    if (state.layout !== "split" && state.layout !== "vertical") return;
    drag = true;
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add(state.layout === "split" ? "resizing-col" : "resizing-row");
    e.preventDefault();
  });

  resizer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const cr = content.getBoundingClientRect();
    let frac;
    if (state.layout === "split") {
      frac = (e.clientX - cr.left) / cr.width;
      state.panelFrac.split = clamp(frac);
      localStorage.setItem("sf-panel-split", String(state.panelFrac.split));
    } else {
      const tb = topbar.getBoundingClientRect();
      const avail = cr.height - tb.height;
      const mapRect = mapWrap.getBoundingClientRect();
      frac = avail > 0 ? (e.clientY - mapRect.top) / avail : state.panelFrac.vertical;
      state.panelFrac.vertical = clamp(frac);
      localStorage.setItem("sf-panel-vertical", String(state.panelFrac.vertical));
    }
    applyPanelFrac();
    savePrefs({ panelFrac: state.panelFrac }, 500);
    schedulePanelRefresh();
  });

  const stop = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("resizing-col", "resizing-row");
    schedulePanelRefresh();
  };
  resizer.addEventListener("pointerup", stop);
  resizer.addEventListener("pointercancel", stop);
}

function setLayout(mode) {
  state.layout = mode;
  const content = $("#content");
  content.classList.remove("layout-vertical", "layout-split", "layout-popup");
  content.classList.add("layout-" + mode);
  renderLayoutButtons();
  localStorage.setItem("sf-layout", mode);
  const wrap = $("#map-wrap");
  if (mode === "popup") {
    if (!wrap.style.width) {
      wrap.style.left = "32px";
      wrap.style.top = "16px";
      wrap.style.width = "46%";
      wrap.style.height = "58%";
    }
    showMap();
  } else {
    wrap.style.left = "";
    wrap.style.top = "";
    wrap.style.width = "";
    wrap.style.height = "";
  }
  applyPanelFrac();
  savePrefs({ layout: mode }, 400);
  updateBubble();
  setTimeout(() => {
    state.map.invalidateSize();
    state.charts.forEach((c) => c.resize());
    repositionOpenPopups();
  }, 80);
}

function initSidebarResize() {
  const resizer = $("#sidebar-resizer");
  const sidebar = $("#sidebar");
  let drag = null;
  resizer.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, w: sidebar.getBoundingClientRect().width };
    resizer.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
    e.preventDefault();
  });
  resizer.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = Math.min(640, Math.max(200, drag.w + (e.clientX - drag.x)));
    sidebar.style.width = w + "px";
    localStorage.setItem("sf-sidebar-width", String(Math.round(w)));
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = null;
        state.map.invalidateSize();
      });
    }
  });
  const stop = () => {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("resizing");
    state.map.invalidateSize();
  };
  resizer.addEventListener("pointerup", stop);
  resizer.addEventListener("pointercancel", stop);
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle("sidebar-collapsed");
  localStorage.setItem("sf-sidebar-hidden", collapsed ? "1" : "0");
  const btn = $("#btn-sidebar-toggle");
  btn.innerHTML = collapsed ? "&#8250;" : "&#8249;";
  btn.title = collapsed ? "Mostra selettore attività" : "Nascondi selettore attività";
  setTimeout(() => {
    if (state.map) state.map.invalidateSize();
    state.charts.forEach((c) => c.resize());
  }, 60);
}

function initMapPopup() {
  const wrap = $("#map-wrap");
  const bar = $("#map-popup-bar");
  const grip = $("#map-popup-grip");
  let drag = null;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  const start = (mode) => (e) => {
    if (state.layout !== "popup") return;
    if (mode === "move" && e.target.closest("button")) return;
    const cr = $("#content").getBoundingClientRect();
    const r = wrap.getBoundingClientRect();
    drag = {
      mode,
      x: e.clientX,
      y: e.clientY,
      left: r.left - cr.left,
      top: r.top - cr.top,
      w: r.width,
      h: r.height,
    };
    (mode === "move" ? bar : grip).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  bar.addEventListener("pointerdown", start("move"));
  grip.addEventListener("pointerdown", start("resize"));

  const move = (e) => {
    if (!drag || state.layout !== "popup") return;
    const cr = $("#content").getBoundingClientRect();
    if (drag.mode === "move") {
      wrap.style.left = clamp(drag.left + (e.clientX - drag.x), 0, Math.max(0, cr.width - drag.w)) + "px";
      wrap.style.top = clamp(drag.top + (e.clientY - drag.y), 0, Math.max(0, cr.height - drag.h)) + "px";
    } else {
      wrap.style.width = clamp(drag.w + (e.clientX - drag.x), 280, Math.max(280, cr.width - drag.left)) + "px";
      wrap.style.height = clamp(drag.h + (e.clientY - drag.y), 200, Math.max(200, cr.height - drag.top)) + "px";
    }
    if (!move._raf) {
      move._raf = requestAnimationFrame(() => {
        move._raf = null;
        state.map.invalidateSize();
      });
    }
  };
  bar.addEventListener("pointermove", move);
  grip.addEventListener("pointermove", move);
  const stop = () => {
    drag = null;
  };
  bar.addEventListener("pointerup", stop);
  grip.addEventListener("pointerup", stop);
  bar.addEventListener("pointercancel", stop);
  grip.addEventListener("pointercancel", stop);
}

function loadChartCfg() {
  try {
    const raw = localStorage.getItem("sf-chart-cfg");
    if (raw) {
      const parsed = JSON.parse(raw);
      for (const k of Object.keys(state.chartCfg)) {
        if (typeof parsed[k] === "number" && isFinite(parsed[k])) state.chartCfg[k] = parsed[k];
      }
    }
  } catch (e) { /* ignore */ }
}

function saveChartCfg() {
  localStorage.setItem("sf-chart-cfg", JSON.stringify(state.chartCfg));
}

function syncChartCfgUI() {
  const map = { height: "cs-height", gap: "cs-gap", xScale: "cs-xscale", yScale: "cs-yscale", font: "cs-font" };
  for (const key of Object.keys(map)) {
    const input = $("#" + map[key]);
    const val = $("#" + map[key] + "-val");
    if (input) input.value = state.chartCfg[key];
    if (val) val.textContent = state.chartCfg[key];
  }
}

function scheduleChartCfgApply() {
  clearTimeout(state.csTimer);
  state.csTimer = setTimeout(() => {
    if (state.tab === "compare") renderCharts();
    else if (state.tab === "analysis") renderAnalysisCharts();
    else if (state.tab === "trend") refreshTrend();
  }, 150);
}

const prefTimers = {};

function savePrefs(values, delay = 250) {
  if (!values || !Object.keys(values).length) return;
  const key = Object.keys(values).join("|");
  clearTimeout(prefTimers[key]);
  prefTimers[key] = setTimeout(() => {
    delete prefTimers[key];
    api("/api/preferences", { method: "POST", body: JSON.stringify(values) }).catch(() => {});
  }, delay);
}

async function loadPrefs() {
  let prefs;
  try {
    prefs = await api("/api/preferences");
  } catch (_) {
    return;
  }
  if (!prefs || typeof prefs !== "object") return;
  if (prefs.chartCfg && typeof prefs.chartCfg === "object") {
    for (const k of Object.keys(state.chartCfg)) {
      const v = prefs.chartCfg[k];
      if (typeof v === "number" && isFinite(v)) state.chartCfg[k] = v;
    }
    localStorage.setItem("sf-chart-cfg", JSON.stringify(state.chartCfg));
  }
  if (prefs.search && typeof prefs.search === "object") {
    state.searchParams = prefs.search;
    applyParamsToControls(prefs.search);
  }
  if (typeof prefs.compareSort === "string") {
    state.compareSort = prefs.compareSort;
    localStorage.setItem("sf-compare-sort", prefs.compareSort);
    const sel = $("#cmp-sort");
    if (sel) sel.value = state.compareSort;
  }
  if (typeof prefs.layout === "string" && ["vertical", "split", "popup"].includes(prefs.layout)) {
    localStorage.setItem("sf-layout", prefs.layout);
  }
  if (prefs.panelFrac && typeof prefs.panelFrac === "object") {
    if (typeof prefs.panelFrac.split === "number") state.panelFrac.split = prefs.panelFrac.split;
    if (typeof prefs.panelFrac.vertical === "number") state.panelFrac.vertical = prefs.panelFrac.vertical;
  }
}

const openPopups = new Map();

function positionPopup(panel, anchor) {
  if (!panel || !anchor) return;
  const ar = anchor.getBoundingClientRect();
  const estH = panel.scrollHeight || 320;
  panel.style.position = "fixed";
  panel.style.zIndex = "5000";
  panel.style.right = "auto";
  panel.style.overflowY = "auto";
  panel.style.overflowX = "hidden";
  const w = Math.min(panel.offsetWidth || 340, window.innerWidth - 16);
  panel.style.width = w + "px";
  const left = Math.max(8, Math.min(ar.right - w, window.innerWidth - w - 8));
  const spaceBelow = window.innerHeight - 8 - (ar.bottom + 6);
  const spaceAbove = ar.top - 14;
  let top = ar.bottom + 6;
  let maxH = spaceBelow;
  if (spaceBelow < Math.min(estH, 240) && spaceAbove > spaceBelow) {
    top = Math.max(8, ar.top - 6 - Math.min(estH, spaceAbove));
    maxH = spaceAbove;
  }
  panel.style.maxHeight = Math.max(160, maxH) + "px";
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

function hidePopup(panel) {
  if (!panel) return;
  panel.classList.add("hidden");
  openPopups.delete(panel);
  if (panel.id === "app-settings-panel") $("#app-settings-backdrop").classList.add("hidden");
}

function togglePopup(panel, anchor) {
  if (!panel) return;
  if (panel.classList.contains("hidden")) {
    panel.classList.remove("hidden");
    positionPopup(panel, anchor);
    openPopups.set(panel, anchor);
  } else {
    hidePopup(panel);
  }
}

function repositionOpenPopups() {
  for (const [panel, anchor] of openPopups) positionPopup(panel, anchor);
}

function closeAllPopups() {
  for (const panel of [...openPopups.keys()]) hidePopup(panel);
}

function bindPopups() {
  document.querySelectorAll(".popup-close").forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = btn.dataset.close;
      if (id) hidePopup(document.getElementById(id));
    };
  });
  window.addEventListener("resize", repositionOpenPopups);
}

function bindChartSettings() {
  const map = { height: "cs-height", gap: "cs-gap", xScale: "cs-xscale", yScale: "cs-yscale", font: "cs-font" };
  for (const key of Object.keys(map)) {
    const input = $("#" + map[key]);
    if (!input) continue;
    input.addEventListener("input", () => {
      state.chartCfg[key] = parseInt(input.value, 10);
      const val = $("#" + map[key] + "-val");
      if (val) val.textContent = input.value;
      saveChartCfg();
      savePrefs({ chartCfg: state.chartCfg });
      scheduleChartCfgApply();
    });
  }
  $("#cs-reset").onclick = () => {
    state.chartCfg = { height: 250, gap: 18, xScale: 100, yScale: 100, font: 11 };
    saveChartCfg();
    savePrefs({ chartCfg: state.chartCfg }, 0);
    syncChartCfgUI();
    scheduleChartCfgApply();
  };
}

function bindSearchSettings() {
  const ids = ["#opt-strategy", "#opt-tolerance", "#opt-direction", "#opt-coverage", "#opt-length-tol", "#opt-same-sport", "#opt-heading"];
  for (const sel of ids) {
    const el = $(sel);
    if (!el) continue;
    const evt = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
    el.addEventListener(evt, () => {
      state.searchParams = currentParams();
      savePrefs({ search: state.searchParams });
    });
  }
  const reset = $("#search-reset");
  if (reset) {
    reset.onclick = () => {
      state.searchParams = {
        strategy: "endpoints",
        tolerance_m: 25,
        direction: "same",
        coverage_min: 0.8,
        length_tol: 0.25,
        same_sport: true,
        check_heading: true,
        heading_tol_deg: 45,
      };
      applyParamsToControls(state.searchParams);
      savePrefs({ search: state.searchParams }, 0);
    };
  }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

  document.querySelectorAll("#source-switch button").forEach((b) => {
    b.onclick = () => setSource(b.dataset.source);
  });
  $("#btn-app-settings").onclick = (e) => {
    e.stopPropagation();
    const panel = $("#app-settings-panel");
    if (panel.classList.contains("hidden")) openSettingsPanel();
    else closeSettingsPanel();
  };
  $("#app-settings-close").addEventListener("click", closeSettingsPanel);
  $("#app-settings-backdrop").onclick = closeSettingsPanel;
  $("#gp-login-btn").onclick = async () => {
    const email = $("#gp-email").value.trim();
    const password = $("#gp-password").value;
    if (!email || !password) {
      toast("Inserisci email e password Garmin");
      return;
    }
    $("#gp-msg").textContent = "";
    try {
      await api("/api/garmin/login", { method: "POST", body: JSON.stringify({ email, password }) });
      $("#gp-password").value = "";
      startGarminPolling();
    } catch (e) {
      toast(`Garmin: ${e.message}`);
    }
  };
  $("#gp-password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#gp-login-btn").click();
  });
  $("#gp-mfa-btn").onclick = async () => {
    const code = $("#gp-mfa-code").value.trim();
    if (!code) {
      toast("Inserisci il codice MFA");
      return;
    }
    try {
      await api("/api/garmin/mfa", { method: "POST", body: JSON.stringify({ code }) });
      $("#gp-mfa-code").value = "";
    } catch (e) {
      toast(`Garmin: ${e.message}`);
    }
  };
  $("#gp-mfa-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#gp-mfa-btn").click();
  });
  $("#btn-garmin-sync").onclick = async () => {
    const st = state.garmin.status;
    if (!st || !st.logged_in) {
      openSettingsPanel();
      toast("Accedi prima a Garmin Connect");
      return;
    }
    try {
      const res = await api("/api/garmin/sync", { method: "POST", body: JSON.stringify({ mode: "incremental" }) });
      if (!res.started) toast("Sincronizzazione già in corso");
      else {
        toast("Sincronizzazione nuove attività avviata");
        startGarminPolling();
      }
    } catch (e) {
      toast(`Garmin: ${e.message}`);
    }
  };
  $("#gp-bulk").onclick = async () => {
    const from = $("#gp-from").value || null;
    const to = $("#gp-to").value || null;
    try {
      const res = await api("/api/garmin/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "bulk", start_date: from, end_date: to }),
      });
      if (!res.started) toast("Sincronizzazione già in corso");
      else {
        toast("Import storico Garmin avviato");
        startGarminPolling();
      }
    } catch (e) {
      toast(`Garmin: ${e.message}`);
    }
  };
  $("#gp-cancel").onclick = async () => {
    try {
      await api("/api/garmin/sync/cancel", { method: "POST" });
    } catch (_) { /* ignore */ }
  };
  $("#gp-logout").onclick = async () => {
    if (!confirm("Disconnettere l'account Garmin? I file FIT già scaricati restano.")) return;
    try {
      await api("/api/garmin/logout", { method: "POST" });
      toast("Disconnesso da Garmin Connect");
      refreshGarmin();
    } catch (e) {
      toast(e.message);
    }
  };
  $("#gp-auto").onchange = async () => {
    try {
      await api("/api/garmin/settings", { method: "POST", body: JSON.stringify({ auto_sync: $("#gp-auto").checked }) });
    } catch (e) {
      toast(e.message);
    }
  };
  $("#gp-gps").onchange = async () => {
    try {
      await api("/api/garmin/settings", { method: "POST", body: JSON.stringify({ gps_only: $("#gp-gps").checked }) });
    } catch (e) {
      toast(e.message);
    }
  };
  $("#gp-sport").onchange = async () => {
    try {
      await api("/api/garmin/settings", { method: "POST", body: JSON.stringify({ sport: $("#gp-sport").value }) });
    } catch (e) {
      toast(e.message);
    }
  };
  $("#gp-reset").onclick = async () => {
    try {
      await api("/api/garmin/settings", { method: "POST", body: JSON.stringify({ auto_sync: true, gps_only: true, sport: "" }) });
      refreshGarmin();
      toast("Impostazioni Garmin ripristinate");
    } catch (e) {
      toast(`Garmin: ${e.message}`);
    }
  };

  $("#btn-scan").onclick = () => startScan(false);
  $("#btn-force").onclick = () => {
    if (confirm("Reindicizzare tutti i file FIT da zero? Le attività verranno rilette.")) startScan(true);
  };
  $("#btn-map-toggle").onclick = toggleMap;
  $("#btn-zoom-reset").onclick = clearZoom;
  document.querySelectorAll("#layout-buttons .icon-toggle").forEach((b) => {
    b.onclick = () => setLayout(b.dataset.layout);
  });
  $("#map-popup-close").onclick = hideMap;
  $("#map-bubble").onclick = showMap;
  initSidebarResize();
  $("#btn-sidebar-toggle").onclick = toggleSidebar;
  initPanelResize();
  initMapPopup();
  bindChartSettings();
  bindSearchSettings();
  bindPopups();
  $("#activity-filter").oninput = renderActivities;
  $("#activity-sport").onchange = () => {
    localStorage.setItem("sf-sport-filter", $("#activity-sport").value);
    renderActivities();
  };

  $("#btn-pick").onclick = () => {
    if (!state.track) {
      toast("Prima seleziona un'attività dalla lista");
      return;
    }
    if (!state.activity.has_gps) {
      toast("Questa attività non contiene punti GPS");
      return;
    }
    showMap();
    state.segment = { startIdx: null, endIdx: null };
    state.results = [];
    state.resultsBaseIdx = null;
    state.selected = new Set();
    state.lastSearch = null;
    state.currentSegmentId = null;
    state.picking = "start";
    renderResults();
    drawPasses();
    updateSegmentUI();
    toast("Clicca il punto di INIZIO sulla traccia");
  };
  $("#rs-reset").onclick = clearSegment;
  $("#btn-search").onclick = runSearch;
  $("#btn-recalc").onclick = runSearch;
  $("#btn-save-segment").onclick = saveSegment;

  initRangeSlider();
  initTrendRangeSlider();
  $("#compare-single").onchange = () => {
    state.compareSingle = $("#compare-single").checked;
    renderCharts();
  };
  $("#analysis-x-axis").onchange = () => {
    state.analysis.xAxis = $("#analysis-x-axis").value;
    resetZoomState();
    renderAnalysisCharts();
  };
  $("#analysis-single").onchange = () => {
    state.analysis.single = $("#analysis-single").checked;
    renderAnalysisCharts();
  };
  $("#btn-analysis-search").onclick = () => {
    if (state.segment.startIdx == null || state.segment.endIdx == null) {
      toast("Seleziona un segmento con il selettore temporale o sulla mappa");
      return;
    }
    runSearch();
  };

  document.querySelectorAll("[data-nudge]").forEach((b) => {
    const [which, delta] = b.dataset.nudge.split(":");
    b.onclick = () => nudge(which, parseInt(delta, 10));
  });

  $("#btn-sel-all").onclick = () => {
    state.selected = new Set(state.results.map((_, i) => i));
    renderResults();
  };
  $("#btn-sel-none").onclick = () => {
    state.selected = new Set();
    renderResults();
  };
  $("#btn-compare").onclick = openCompare;
  $("#btn-trend").onclick = () => {
    if (!state.results.length) {
      toast("Esegui prima una ricerca sul segmento");
      return;
    }
    switchTab("trend");
  };
  $("#trend-sort").value = state.trendSort;
  $("#trend-sort").onchange = () => {
    state.trendSort = $("#trend-sort").value;
    localStorage.setItem("sf-trend-sort", state.trendSort);
    refreshTrend();
  };
  $("#btn-cmp-all").onclick = async () => {
    state.compareAdded = new Set(compareRows().slice(0, MAX_COMPARE).map(({ i }) => i));
    await refreshCompare();
  };
  $("#btn-compare-tools").onclick = (e) => {
    e.stopPropagation();
    togglePopup($("#compare-tools-panel"), $("#btn-compare-tools"));
  };
  document.addEventListener("click", (e) => {
    const panel = $("#compare-tools-panel");
    if (!panel || panel.classList.contains("hidden")) return;
    if (!e.target.closest(".cmp-tools")) hidePopup(panel);
  });
  $("#cmp-sort").value = state.compareSort;
  $("#cmp-sort").onchange = () => {
    state.compareSort = $("#cmp-sort").value;
    localStorage.setItem("sf-compare-sort", state.compareSort);
    savePrefs({ compareSort: state.compareSort }, 0);
    renderCompareList();
  };
  $("#cmp-date-from").onchange = () => {
    state.compareDateFrom = $("#cmp-date-from").value;
    renderCompareList();
  };
  $("#cmp-date-to").onchange = () => {
    state.compareDateTo = $("#cmp-date-to").value;
    renderCompareList();
  };
  $("#cmp-tools-reset").onclick = () => {
    state.compareDateFrom = "";
    state.compareDateTo = "";
    state.compareSort = "time";
    localStorage.setItem("sf-compare-sort", "time");
    savePrefs({ compareSort: "time" }, 0);
    $("#cmp-date-from").value = "";
    $("#cmp-date-to").value = "";
    $("#cmp-sort").value = "time";
    renderCompareList();
  };
  $("#btn-cmp-none").onclick = () => {
    state.compareAdded = new Set();
    renderCompareList();
    renderLegend();
    renderCharts();
  };
  $("#x-axis").onchange = () => {
    state.xAxis = $("#x-axis").value;
    resetZoomState();
    renderCharts();
  };

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (openPopups.size) {
      closeAllPopups();
      return;
    }
    const maxWrap = document.querySelector(".chart-wrap.chart-max");
    if (maxWrap) {
      closeChartMax(maxWrap);
      return;
    }
    if (state.picking) {
      state.picking = null;
      updateSegmentUI();
    }
  });
}

/* ---------------- INIT ---------------- */

async function init() {
  initMap();
  bindEvents();
  const savedW = parseInt(localStorage.getItem("sf-sidebar-width") || "", 10);
  if (savedW) $("#sidebar").style.width = savedW + "px";
  if (localStorage.getItem("sf-sidebar-hidden") === "1") toggleSidebar();
  await loadPrefs();
  setLayout(localStorage.getItem("sf-layout") || "vertical");
  loadChartCfg();
  syncChartCfgUI();
  updateZoomUI();
  try {
    await loadStatus();
    await loadActivities();
    await loadSegments();
  } catch (e) {
    toast(`Impossibile contattare il server: ${e.message}`);
    return;
  }
  await setSource(state.source);
  refreshGarmin();
  if (state.source === "local" && state.status && state.status.activities === 0 && state.status.scan && !state.status.scan.running) {
    startScan(false);
  }
}

document.addEventListener("DOMContentLoaded", init);
