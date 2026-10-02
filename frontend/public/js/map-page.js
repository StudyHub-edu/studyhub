/* ============================================================================
 * StudyHub — Map / Find Your Learning Destination
 * Real Leaflet map (OpenStreetMap tiles, no API key needed), real institution
 * data from public.institutions (extended by supabase/map_schema.sql), real
 * Haversine distance, and real Google Maps directions links (no key needed
 * either — that's just a URL scheme Google Maps supports natively).
 * ========================================================================== */

const TYPE_COLOR = { school: "#7c53e0", college: "#4d7cff", library: "#3ed3a3", institute: "#e2505f", university: "#4d7cff", other: "#8992ab" };
const TYPE_LABEL = { school: "School", college: "College", institute: "Institute", library: "Library", university: "University", other: "Institution" };
const TYPE_ICON_PATH = {
  school: '<path d="M12 3 2.5 7.8 12 12.6l9.5-4.8L12 3Z"/><path d="M6 10.4v5.1c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-5.1"/>',
  college: '<path d="M12 3 2.5 7.8 12 12.6l9.5-4.8L12 3Z"/><path d="M6 10.4v5.1c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-5.1"/><path d="M21.5 7.8v6"/>',
  institute: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4Z"/>',
  library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/>',
  university: '<path d="M12 3 2.5 7.8 12 12.6l9.5-4.8L12 3Z"/><path d="M6 10.4v5.1c0 1.6 2.7 2.9 6 2.9s6-1.3 6-2.9v-5.1"/>',
  other: '<path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/>',
};
const FACILITY_ICON = {
  Library: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/>',
  Laboratories: '<path d="M9 3h6M10 3v6l-5.5 9a1.8 1.8 0 0 0 1.6 2.7h11.8a1.8 1.8 0 0 0 1.6-2.7L14 9V3"/>',
  "Computer Lab": '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  Classrooms: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4Z"/>',
  Cafeteria: '<path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8Z"/><path d="M6 1v3M10 1v3M14 1v3"/>',
  "Wi-Fi": '<path d="M5 13a10 10 0 0 1 14 0M8.5 16.5a5 5 0 0 1 7 0"/><circle cx="12" cy="20" r="1"/>',
};
let map, userMarker, routeLine;
let routeRequestId = 0;
let lastGeocodeAt = 0;
const instMarkers = {};
let me = null;
let userLoc = { lat: 27.7017, lng: 85.3206, label: "Kathmandu, Nepal" }; // sensible default center
let institutions = [];
let selectedId = null;
let currentType = "";
let currentMode = "driving";
let mySavedIds = new Set();
let extraDestinations = [];

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ----------------------------------------------------------- distance math */

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
/* ------------------------------------------------------------------- boot */

(async () => {
  const session = await requireAuth();
  if (!session) return;
  me = session.user.id;
  const profile = await loadIdentity(session);
  document.getElementById("back-link").href = profile?.role === "admin" ? "admin-dashboard.html" : profile?.role === "teacher" ? "teacher-dashboard.html" : "dashboard.html";

  initMap();
  wireControls();
  detectLocation();
  await loadMySaves();
  await loadInstitutions();
})();

/* -------------------------------------------------------------------- map */

function initMap() {
  map = L.map("leaflet-map", { zoomControl: false }).setView([userLoc.lat, userLoc.lng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "&copy; OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(map);
  placeUserMarker();
}

function dotIcon(color, size = 16) {
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function placeUserMarker() {
  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([userLoc.lat, userLoc.lng], { icon: dotIcon("#4d7cff", 20), zIndexOffset: 1000 }).addTo(map);
}

function detectLocation() {
  const input = document.getElementById("my-location-input");
  input.value = userLoc.label;
  setMapStatus("");
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: "Your current location" };
      input.value = userLoc.label;
      placeUserMarker();
      map.setView([userLoc.lat, userLoc.lng], 14);
      renderResults();
      if (selectedId) selectInstitution(selectedId);
    },
    () => setMapStatus("Location access was unavailable. Enter a starting place and press Enter, or keep the Kathmandu fallback.", true),
    { timeout: 6000 }
  );
}

/* ----------------------------------------------------------------- data */

async function loadMySaves() {
  try {
    const { data, error } = await supabase.from("saved_institutions").select("institution_id").eq("user_id", me);
    if (error) throw error;
    mySavedIds = new Set((data || []).map((r) => r.institution_id));
  } catch (err) { console.debug("[Map] saves:", err.message); }
}

async function loadInstitutions() {
  const list = document.getElementById("results-list");
  list.innerHTML = `<div class="skeleton" style="height:80px;border-radius:12px;margin-bottom:8px;"></div>`.repeat(4);
  try {
    const { data, error } = await supabase
      .from("institutions")
      .select("id, name, type, city, address, latitude, longitude, facilities, cover_photo_url");
    if (error) throw error;
    institutions = (data || []).map((row) => ({
      ...row,
      latitude: row.latitude == null ? null : Number(row.latitude),
      longitude: row.longitude == null ? null : Number(row.longitude),
    }));
    plotMarkers();
    renderResults();
    const firstNearbyInstitution = filteredSorted().find(hasCoordinates);
    if (firstNearbyInstitution) await selectInstitution(firstNearbyInstitution.id);
  } catch (err) {
    console.debug("[Map] institutions:", err.message);
    list.innerHTML = `<div class="empty-state"><p>Couldn't load institutions right now.</p></div>`;
  }
}

function plotMarkers() {
  Object.values(instMarkers).forEach((m) => map.removeLayer(m));
  institutions.filter(hasCoordinates).forEach((inst) => {
    const marker = L.marker([inst.latitude, inst.longitude], { icon: dotIcon(TYPE_COLOR[inst.type] || TYPE_COLOR.other) }).addTo(map);
    marker.on("click", () => selectInstitution(inst.id));
    instMarkers[inst.id] = marker;
  });
}

/* -------------------------------------------------------------- results */

function filteredSorted() {
  const q = document.getElementById("search-input").value.trim().toLowerCase();
  const sortBy = document.getElementById("sort-select").value;
  let rows = institutions.filter((i) => (!currentType || i.type === currentType) && (!q || i.name.toLowerCase().includes(q) || (i.city || "").toLowerCase().includes(q)));
  rows = rows.map((i) => ({ ...i, distanceKm: hasCoordinates(i) ? haversineKm(userLoc, { lat: i.latitude, lng: i.longitude }) : null }));
  if (sortBy === "name") rows.sort((a, b) => a.name.localeCompare(b.name));
  else rows.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  return rows;
}

function renderResults() {
  const list = document.getElementById("results-list");
  const rows = filteredSorted();
  if (!rows.length) {
    list.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg><p>${institutions.length ? "No institutions match your search." : "No mapped institutions yet."}</p></div>`;
    return;
  }
  list.innerHTML = rows
    .map((i) => {
      const distanceText = i.distanceKm == null ? "Location not mapped yet" : `${i.distanceKm.toFixed(1)} km straight-line`;
      return `
      <div class="inst-row ${i.id === selectedId ? "is-selected" : ""}" data-id="${i.id}">
        <span class="inst-row__icon" style="background:${TYPE_COLOR[i.type] || TYPE_COLOR.other}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TYPE_ICON_PATH[i.type] || TYPE_ICON_PATH.other}</svg></span>
        <div class="inst-row__body">
          <div class="inst-row__title">${escapeHtml(i.name)} <span class="inst-row__type-tag">${TYPE_LABEL[i.type] || "Institution"}</span></div>
          <div class="inst-row__meta">
            <span>${distanceText}</span>
          </div>
        </div>
        <button type="button" class="inst-row__go" data-go="${i.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
          Go
        </button>
      </div>`;
    })
    .join("");

  list.querySelectorAll(".inst-row").forEach((row) => {
    row.addEventListener("click", (e) => { if (!e.target.closest("[data-go]")) selectInstitution(row.dataset.id); });
  });
  list.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const inst = institutions.find((item) => item.id === btn.dataset.go);
      if (!inst) return;
      if (hasCoordinates(inst)) openDirections(inst.id);
      else await selectInstitution(inst.id);
    });
  });
}

/* --------------------------------------------------------------- select */

async function selectInstitution(id) {
  selectedId = id;
  const inst = institutions.find((i) => i.id === id);
  if (!inst) return;

  if (!hasCoordinates(inst)) {
    setMapStatus(`Looking up the map location for ${inst.name}…`);
    try {
      const match = await geocodePlace([inst.name, inst.city, inst.address].filter(Boolean).join(", "));
      if (selectedId !== id) return;
      inst.latitude = Number(match.lat);
      inst.longitude = Number(match.lon);
      plotMarkers();
      setMapStatus("Location found for this visit. Ask your admin to save verified coordinates for future visits.");
    } catch (error) {
      setMapStatus(`Could not find a map location for ${inst.name}. Add an address or verified coordinates in Supabase.`, true);
      renderResults();
      return;
    }
  } else {
    setMapStatus("");
  }

  map.setView([inst.latitude, inst.longitude], 15, { animate: true });
  renderResults();
  renderDetail(inst);
  drawRoute(inst);

  document.getElementById("detail-panel").classList.add("is-open");
}

async function drawRoute(inst) {
  const requestId = ++routeRequestId;
  if (routeLine) map.removeLayer(routeLine);
  const summary = document.getElementById("route-summary");
  if (currentMode === "transit") {
    summary.textContent = "Transit route calculation is provided by Google Maps. Use Get Directions below.";
    return;
  }

  summary.textContent = "Calculating road route…";
  const router = currentMode === "walking"
    ? "https://routing.openstreetmap.de/routed-foot/route/v1/driving"
    : currentMode === "bicycling"
      ? "https://routing.openstreetmap.de/routed-bike/route/v1/driving"
      : "https://routing.openstreetmap.de/routed-car/route/v1/driving";
  const coordinates = `${userLoc.lng},${userLoc.lat};${inst.longitude},${inst.latitude}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${router}/${coordinates}?overview=full&geometries=geojson`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Routing service returned ${response.status}.`);
    const result = await response.json();
    const route = result.routes?.[0];
    if (result.code !== "Ok" || !route) throw new Error("No route was found.");
    if (requestId !== routeRequestId) return;

    const path = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    routeLine = L.polyline(path, { color: "#2563eb", weight: 5, opacity: 0.9 }).addTo(map);
    const minutes = Math.max(1, Math.round(route.duration / 60));
    summary.textContent = `${currentMode === "walking" ? "Walking" : currentMode === "bicycling" ? "Cycling" : "Driving"} route: ${(route.distance / 1000).toFixed(1)} km · about ${minutes} min`;
    map.fitBounds(routeLine.getBounds().pad(0.15), { maxZoom: 15 });
  } catch (error) {
    if (requestId !== routeRequestId) return;
    const directKm = haversineKm(userLoc, { lat: inst.latitude, lng: inst.longitude });
    summary.textContent = `Road route unavailable (${error.name === "AbortError" ? "request timed out" : "routing service error"}). Straight-line distance: ${directKm.toFixed(1)} km. Try Get Directions.`;
    console.debug("[Map] route:", error.message);
  } finally {
    clearTimeout(timeout);
  }
}

function renderDetail(inst) {
  document.getElementById("detail-empty").hidden = true;
  const content = document.getElementById("detail-content");
  content.hidden = false;

  const distanceKm = haversineKm(userLoc, { lat: inst.latitude, lng: inst.longitude });
  const isSaved = mySavedIds.has(inst.id);
  const facilities = Array.isArray(inst.facilities) ? inst.facilities : [];

  content.innerHTML = `
    <div class="detail-photo" style="${inst.cover_photo_url ? `background-image:url('${escapeHtml(inst.cover_photo_url)}')` : ""}">
      <button type="button" class="detail-photo__close" id="detail-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="detail-name-row">
      <h2>${escapeHtml(inst.name)}</h2>
    </div>
    <div class="detail-type-row">
      <span class="inst-row__icon" style="width:24px;height:24px;background:${TYPE_COLOR[inst.type] || TYPE_COLOR.other}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;">${TYPE_ICON_PATH[inst.type] || TYPE_ICON_PATH.other}</svg></span>
      ${TYPE_LABEL[inst.type] || "Institution"}
    </div>
    <div class="detail-section-title">Facilities</div>
    ${facilities.length ? `
    <div class="facilities-grid">
      ${facilities.map((f) => `<div class="facility-chip"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${FACILITY_ICON[f] || FACILITY_ICON.Classrooms}</svg><span>${escapeHtml(f)}</span></div>`).join("")}
    </div>` : `<p class="detail-no-facilities">Facility information has not been added yet.</p>`}

    <div class="detail-addr-row">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.6 7-12a7 7 0 1 0-14 0c0 5.4 7 12 7 12Z"/><circle cx="12" cy="9" r="2.5"/></svg>
      ${escapeHtml(inst.address || inst.city || "Location on map")} · ${distanceKm.toFixed(1)} km straight-line
    </div>
    <div class="route-summary" id="route-summary" role="status" aria-live="polite">Select a travel mode to calculate a route.</div>

    <div class="detail-section-title">Quick Actions</div>
    <div class="detail-actions-row">
      <button type="button" class="detail-action-btn is-primary" id="detail-directions"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 11l19-9-9 19-2-8-8-2Z"/></svg>Get Directions</button>
      <button type="button" class="detail-action-btn ${isSaved ? "is-saved" : ""}" id="detail-save"><svg viewBox="0 0 24 24" fill="${isSaved ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2"><path d="M6 3h12v18l-6-4-6 4V3Z"/></svg>${isSaved ? "Saved" : "Save"}</button>
      <button type="button" class="detail-action-btn" id="detail-share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.6 6.8-3.2M8.6 13.4l6.8 3.2"/></svg>Share</button>
    </div>

    <div class="detail-promo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13Z"/></svg>
      <div>Explore more institutions, classes and resources on StudyHub.
        <a href="dashboard.html">View all &rarr;</a>
      </div>
    </div>
  `;

  document.getElementById("detail-close").addEventListener("click", () => {
    document.getElementById("detail-panel").classList.remove("is-open");
  });
  document.getElementById("detail-directions").addEventListener("click", () => openDirections(inst.id));
  document.getElementById("detail-save").addEventListener("click", () => toggleSave(inst.id));
  document.getElementById("detail-share").addEventListener("click", () => shareInstitution(inst));
}

/* --------------------------------------------------------------- actions */

function openDirections(id) {
  const inst = institutions.find((i) => i.id === id);
  if (!inst) return;
  const params = new URLSearchParams({
    api: "1",
    origin: `${userLoc.lat},${userLoc.lng}`,
    destination: `${inst.latitude},${inst.longitude}`,
    travelmode: currentMode === "bicycling" ? "bicycling" : currentMode === "transit" ? "transit" : currentMode === "walking" ? "walking" : "driving",
  });
  if (extraDestinations.length) params.set("waypoints", extraDestinations.join("|"));
  window.open(`https://www.google.com/maps/dir/?${params.toString()}`, "_blank", "noopener");
}

async function toggleSave(id) {
  const isSaved = mySavedIds.has(id);
  try {
    if (isSaved) {
      await supabase.from("saved_institutions").delete().eq("user_id", me).eq("institution_id", id);
      mySavedIds.delete(id);
    } else {
      await supabase.from("saved_institutions").insert({ user_id: me, institution_id: id });
      mySavedIds.add(id);
    }
    const inst = institutions.find((i) => i.id === id);
    if (inst) renderDetail(inst);
  } catch (err) { console.debug("[Map] save:", err.message); }
}

function shareInstitution(inst) {
  const url = `https://www.google.com/maps/search/?api=1&query=${inst.latitude},${inst.longitude}`;
  if (navigator.share) {
    navigator.share({ title: inst.name, text: `${inst.name} on StudyHub`, url }).catch(() => {});
  } else {
    navigator.clipboard?.writeText(url);
  }
}

/* ---------------------------------------------------------------- wiring */

function wireControls() {
  document.querySelectorAll(".transport-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".transport-tab").forEach((t) => t.classList.remove("is-active"));
      tab.classList.add("is-active");
      currentMode = tab.dataset.mode;
      renderResults();
      if (selectedId) selectInstitution(selectedId);
    });
  });

  document.querySelectorAll(".inst-filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".inst-filter-chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentType = chip.dataset.type;
      renderResults();
    });
  });

  document.getElementById("search-input").addEventListener("input", debounce(renderResults, 250));
  document.getElementById("search-btn").addEventListener("click", renderResults);
  document.getElementById("sort-select").addEventListener("change", renderResults);
  document.getElementById("locate-btn").addEventListener("click", detectLocation);
  document.getElementById("my-location-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setOriginFromAddress();
    }
  });
  document.getElementById("locate-map-btn").addEventListener("click", () => map.setView([userLoc.lat, userLoc.lng], 14));
  document.getElementById("zoom-in-btn").addEventListener("click", () => map.zoomIn());
  document.getElementById("zoom-out-btn").addEventListener("click", () => map.zoomOut());

  document.getElementById("add-dest-btn").addEventListener("click", () => {
    const val = prompt("Add another destination (address or place name):");
    if (val && val.trim()) {
      extraDestinations.push(val.trim());
      alert(`Added "${val.trim()}" as a stop. It'll be included next time you tap Get Directions.`);
    }
  });
}

function hasCoordinates(inst) {
  return Number.isFinite(inst.latitude) && Number.isFinite(inst.longitude);
}

function setMapStatus(message, isError = false) {
  const status = document.getElementById("map-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

async function geocodePlace(place) {
  const delay = 1000 - (Date.now() - lastGeocodeAt);
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  lastGeocodeAt = Date.now();
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", `${place}, Nepal`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Place lookup returned ${response.status}.`);
  const results = await response.json();
  if (!results.length) throw new Error("No location found.");
  return results[0];
}

async function setOriginFromAddress() {
  const input = document.getElementById("my-location-input");
  const place = input.value.trim();
  if (!place) {
    setMapStatus("Type a starting place, then press Enter.", true);
    return;
  }
  setMapStatus("Looking up starting place…");
  try {
    const result = await geocodePlace(place);
    userLoc = { lat: Number(result.lat), lng: Number(result.lon), label: result.display_name };
    input.value = result.display_name;
    placeUserMarker();
    map.setView([userLoc.lat, userLoc.lng], 14);
    renderResults();
    setMapStatus("");
    if (selectedId) await selectInstitution(selectedId);
  } catch (error) {
    setMapStatus(`Could not find that place: ${error.message}`, true);
  }
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
