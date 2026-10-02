/* ============================================================================
 * StudyHub — full Map page (Leaflet + OpenStreetMap, no API key needed)
 * ========================================================================== */

const PLACE_COLORS = { school: "#3a63d8", college: "#7c53e0", university: "#1f9e64", other: "#8992ab" };
let allPlaces = [];
let map, markers = [];

function renderList(places) {
  const el = document.getElementById("places-list");
  if (!places.length) return renderEmptyState(el, { message: "No places match your search." });

  el.innerHTML = places
    .map(
      (p) => `
    <div class="list-row" data-place-id="${p.id}">
      <span class="list-row__icon" style="background:${PLACE_COLORS[p.type] || PLACE_COLORS.other}22;color:${PLACE_COLORS[p.type] || PLACE_COLORS.other}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z"/></svg>
      </span>
      <div class="list-row__body">
        <div class="list-row__title">${escapeHtml(p.name)}</div>
        <div class="list-row__meta">${escapeHtml(p.type)}${p.city ? " • " + escapeHtml(p.city) : ""}</div>
      </div>
    </div>`
    )
    .join("");

  el.querySelectorAll("[data-place-id]").forEach((row) =>
    row.addEventListener("click", () => {
      const place = places.find((p) => p.id === row.dataset.placeId);
      if (place && place.latitude && place.longitude) map.setView([place.latitude, place.longitude], 15);
    })
  );
}

function renderMarkers(places) {
  markers.forEach((m) => map.removeLayer(m));
  markers = [];
  places
    .filter((p) => p.latitude && p.longitude)
    .forEach((p) => {
      const marker = L.circleMarker([p.latitude, p.longitude], {
        radius: 8,
        color: "#fff",
        weight: 2,
        fillColor: PLACE_COLORS[p.type] || PLACE_COLORS.other,
        fillOpacity: 1,
      })
        .addTo(map)
        .bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${escapeHtml(p.type)}${p.city ? " • " + escapeHtml(p.city) : ""}`);
      markers.push(marker);
    });
}

function applyFilters() {
  const search = document.getElementById("search-box").value.trim().toLowerCase();
  const type = document.getElementById("type-filter").value;
  const filtered = allPlaces.filter((p) => {
    const matchesType = !type || p.type === type;
    const matchesSearch = !search || p.name.toLowerCase().includes(search) || (p.city || "").toLowerCase().includes(search);
    return matchesType && matchesSearch;
  });
  renderList(filtered);
  renderMarkers(filtered);
}

async function loadPlaces() {
  try {
    const { data, error } = await supabase.from("institutions").select("id, name, type, city, latitude, longitude").limit(500);
    if (error) throw error;
    allPlaces = data || [];

    map = L.map("full-map", { scrollWheelZoom: true }).setView([27.7172, 85.324], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    const withCoords = allPlaces.filter((p) => p.latitude && p.longitude);
    if (withCoords.length) {
      const bounds = L.latLngBounds(withCoords.map((p) => [p.latitude, p.longitude]));
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    applyFilters();
  } catch (err) {
    if (!isMissingTable(err)) console.debug("[Map] load failed:", err.message);
    document.getElementById("full-map").innerHTML =
      '<div class="empty-state" style="height:100%;justify-content:center;"><p>Map data isn\'t available yet.</p></div>';
    renderEmptyState(document.getElementById("places-list"), { message: "No places available yet." });
  }
}

(async () => {
  const session = await requireAuth();
  if (!session) return;

  await loadIdentity(session);

  document.getElementById("search-box").addEventListener("input", applyFilters);
  document.getElementById("type-filter").addEventListener("change", applyFilters);
  loadPlaces();
})();
