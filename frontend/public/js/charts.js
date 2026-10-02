/* ============================================================================
 * StudyHub — tiny inline SVG charts (no chart library, no network request)
 * Used by teacher-dashboard.js and admin-dashboard.js.
 * ========================================================================== */

/**
 * Renders a simple multi-series line chart into `el`.
 * series: [{ name, color, values: number[] }], labels: string[] (x-axis)
 */
function renderLineChart(el, { labels, series, height = 200 }) {
  const width = el.clientWidth || 480;
  const padL = 28, padR = 8, padT = 10, padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const maxVal = Math.max(1, ...series.flatMap((s) => s.values));
  const stepX = labels.length > 1 ? innerW / (labels.length - 1) : 0;
  const y = (v) => padT + innerH - (v / maxVal) * innerH;
  const x = (i) => padL + i * stepX;

  const gridLines = [0, 0.5, 1].map((f) => {
    const gy = padT + innerH * (1 - f);
    return `<line x1="${padL}" y1="${gy}" x2="${width - padR}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>
      <text x="0" y="${gy + 4}" font-size="10" fill="var(--text-faint)">${Math.round(maxVal * f)}</text>`;
  }).join("");

  const xLabels = labels.map((l, i) => `<text x="${x(i)}" y="${height - 4}" font-size="10" fill="var(--text-faint)" text-anchor="middle">${l}</text>`).join("");

  const paths = series.map((s) => {
    const d = s.values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(v)}`).join(" ");
    const dots = s.values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${s.color}"/>`).join("");
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>${dots}`;
  }).join("");

  el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${gridLines}${paths}${xLabels}</svg>`;
}

/**
 * Renders a donut chart into `el`. slices: [{ label, value, color }]
 * Draws the ring only — pair it with your own HTML legend for values/labels.
 */
function renderDonutChart(el, slices, { size = 160, thickness = 22 } = {}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const arcs = slices.map((s) => {
    const frac = s.value / total;
    const dash = frac * circumference;
    const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${thickness}"
      stroke-dasharray="${dash} ${circumference - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})" />`;
    offset += dash;
    return circle;
  }).join("");

  el.innerHTML = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${arcs}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="20" font-weight="700" fill="var(--text)" font-family="var(--font-display)">${total.toLocaleString()}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10" fill="var(--text-faint)">Total</text>
  </svg>`;
}
