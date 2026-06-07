// ──────────────────────────────────────────────
//  Referencias al DOM
// ──────────────────────────────────────────────
const csvFileInput         = document.getElementById('csvFile');
const csvText              = document.getElementById('csvText');
const parseButton          = document.getElementById('parseButton');
const generateButton       = document.getElementById('generateButton');
const downloadButton       = document.getElementById('downloadButton');
const exportPdfButton      = document.getElementById('exportPdfButton');
const exportJpgButton      = document.getElementById('exportJpgButton');
const directionSelect      = document.getElementById('directionSelect');
const closePolygonCheckbox = document.getElementById('closePolygon');
const utmZoneSelect        = document.getElementById('utmZone');
const utmHemisphereSelect  = document.getElementById('utmHemisphere');
const outputPanel          = document.getElementById('outputPanel');
const tableWrapper         = document.getElementById('tableWrapper');
const statusMsg            = document.getElementById('statusMsg');

let parsedPoints = [];

// ──────────────────────────────────────────────
//  Utilidades
// ──────────────────────────────────────────────

function showStatus(message, type = 'ok') {
  statusMsg.textContent = message;
  statusMsg.className   = `status-msg ${type}`;
  statusMsg.hidden      = false;
}

function formatNumber(value, decimals = 3) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '';
}

// ── DMS con carry correcto ──
function toDMS(decimalDegrees) {
  let degrees    = Math.floor(decimalDegrees);
  const mRaw     = (decimalDegrees - degrees) * 60;
  let minutes    = Math.floor(mRaw);
  let seconds    = Math.round((mRaw - minutes) * 60);
  if (seconds === 60) { seconds = 0; minutes++; }
  if (minutes === 60) { minutes = 0; degrees++; }
  return `${degrees}°${String(minutes).padStart(2,'0')}'${String(seconds).padStart(2,'0')}"`;
}

function azimuthToRumbo(az) {
  const a = (az + 360) % 360;
  if (a <= 90)  return `N ${toDMS(a)} E`;
  if (a <= 180) return `S ${toDMS(180 - a)} E`;
  if (a <= 270) return `S ${toDMS(a - 180)} W`;
  return               `N ${toDMS(360 - a)} W`;
}

// ──────────────────────────────────────────────
//  Parseo CSV
// ──────────────────────────────────────────────

function parseCsvText(text) {
  const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('El CSV está vacío.');

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  for (const k of ['id','n','e']) {
    if (!headers.includes(k)) throw new Error(`Falta la columna "${k}" en el encabezado.`);
  }

  const iId = headers.indexOf('id');
  const iN  = headers.indexOf('n');
  const iE  = headers.indexOf('e');
  const iZ  = headers.indexOf('z');

  return lines.slice(1).map((line, idx) => {
    const c  = line.split(',').map(v => v.trim());
    const id = c[iId] || '';
    const n  = parseFloat(c[iN]);
    const e  = parseFloat(c[iE]);
    const z  = iZ !== -1 ? parseFloat(c[iZ]) : NaN;

    if (!id)             throw new Error(`Fila ${idx+2}: id vacío.`);
    if (Number.isNaN(n)) throw new Error(`Fila ${idx+2}: coordenada N inválida.`);
    if (Number.isNaN(e)) throw new Error(`Fila ${idx+2}: coordenada E inválida.`);

    const pt = { id, n, e };
    if (!Number.isNaN(z)) pt.z = z;
    return pt;
  });
}

// ──────────────────────────────────────────────
//  Cálculo de segmentos y área
// ──────────────────────────────────────────────

function calculateSegment(from, to, index) {
  const dN  = to.n - from.n;
  const dE  = to.e - from.e;
  const dist = Math.hypot(dN, dE);
  const az   = (Math.atan2(dE, dN) * 180 / Math.PI + 360) % 360;
  return { line:`L${index}`, from:from.id, to:to.id, deltaN:dN, deltaE:dE, distance:dist, azimuth:az, rumbo:azimuthToRumbo(az) };
}

function computeSegments(points, close) {
  const segs = [];
  for (let i = 0; i < points.length - 1; i++) segs.push(calculateSegment(points[i], points[i+1], i+1));
  if (close && points.length > 2) segs.push(calculateSegment(points[points.length-1], points[0], segs.length+1));
  return segs;
}

function computeArea(points) {
  if (points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i+1) % points.length;
    s += points[i].e * points[j].n - points[j].e * points[i].n;
  }
  return Math.abs(s) / 2;
}

// ──────────────────────────────────────────────
//  Proyección UTM
// ──────────────────────────────────────────────

function utmToLatLon(e, n, zone, north) {
  if (typeof proj4 === 'undefined') return { lat:n, lon:e };
  try {
    const [lon, lat] = proj4(`+proj=utm +zone=${zone} +datum=WGS84 ${north?'':'+south'}`, '+proj=longlat +datum=WGS84 +no_defs', [e, n]);
    return { lat, lon };
  } catch { return { lat:n, lon:e }; }
}

function projectPointsIfUtm(points) {
  const zone = utmZoneSelect.value;
  if (!zone) return points;
  const north = utmHemisphereSelect.value === 'N';
  return points.map(p => { const {lat,lon} = utmToLatLon(p.e, p.n, parseInt(zone,10), north); return {...p, lat, lon}; });
}

// ──────────────────────────────────────────────
//  MAPA EN CANVAS  (pantalla + exportación)
//  Dibuja: polígono, puntos, etiquetas de ID,
//  distancia y rumbo sobre cada segmento.
// ──────────────────────────────────────────────

/**
 * Calcula la transformación (escala + offset) para que los puntos
 * quepan centrados dentro de (canvasW x canvasH) con padding dado.
 */
function computeTransform(coords, canvasW, canvasH, padding) {
  const xs = coords.map(c => c[0]);
  const ys = coords.map(c => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  const drawW = canvasW - padding * 2;
  const drawH = canvasH - padding * 2;
  const scale = Math.min(drawW / rangeX, drawH / rangeY);

  const offX = padding + (drawW - rangeX * scale) / 2;
  const offY = padding + (drawH - rangeY * scale) / 2;

  // En canvas Y crece hacia abajo; en coordenadas topográficas N crece hacia arriba
  const toCanvas = ([x, y]) => [
    offX + (x - minX) * scale,
    offY + (maxY - y) * scale   // espejo vertical
  ];

  return { toCanvas, scale, minX, maxX, minY, maxY, offX, offY };
}

/**
 * Dibuja el mapa completo (polígono + puntos + etiquetas + distancias)
 * en un canvas ya creado.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array} points  – puntos originales (con .n/.e/.id)
 * @param {Array} segments
 * @param {boolean} closePolygon
 * @param {number} [padding=40]
 */
// ──────────────────────────────────────────────
//  Flecha de Norte
// ──────────────────────────────────────────────
function drawNorthArrow(ctx, x, y, size) {
  ctx.save();
  ctx.translate(x, y);

  // Círculo exterior
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, Math.PI * 2);
  ctx.strokeStyle = '#333';
  ctx.lineWidth   = 1.2;
  ctx.fillStyle   = 'rgba(255,255,255,0.88)';
  ctx.fill();
  ctx.stroke();

  // Flecha: mitad superior negra, mitad inferior blanca con borde
  const tip  = -size * 0.72;
  const base =  size * 0.72;
  const wing =  size * 0.28;

  // Mitad izquierda (negra)
  ctx.beginPath();
  ctx.moveTo(0, tip);
  ctx.lineTo(-wing, base * 0.3);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fillStyle = '#222';
  ctx.fill();

  // Mitad derecha (blanca con borde)
  ctx.beginPath();
  ctx.moveTo(0, tip);
  ctx.lineTo(wing, base * 0.3);
  ctx.lineTo(0, 0);
  ctx.closePath();
  ctx.fillStyle   = '#fff';
  ctx.strokeStyle = '#333';
  ctx.lineWidth   = 0.8;
  ctx.fill();
  ctx.stroke();

  // Parte inferior
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-wing, base * 0.3);
  ctx.lineTo(0, base);
  ctx.lineTo(wing, base * 0.3);
  ctx.closePath();
  ctx.fillStyle   = '#888';
  ctx.fill();

  // Letra N
  ctx.font        = `bold ${Math.round(size * 0.55)}px Inter, system-ui, sans-serif`;
  ctx.fillStyle   = '#111';
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('N', 0, -size * 1.22);

  ctx.restore();
}

// ──────────────────────────────────────────────
//  Retícula UTM
//  Calcula un intervalo "bonito" y dibuja las
//  líneas de cuadrícula con sus etiquetas.
// ──────────────────────────────────────────────
function drawGrid(ctx, points, W, H, padding) {
  // Extensión en coordenadas originales (N, E)
  const ns = points.map(p => p.n);
  const es = points.map(p => p.e);
  const minN = Math.min(...ns), maxN = Math.max(...ns);
  const minE = Math.min(...es), maxE = Math.max(...es);
  const rangeN = maxN - minN || 1;
  const rangeE = maxE - minE || 1;
  const range  = Math.max(rangeN, rangeE);

  // Intervalo bonito: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000…
  const rawStep = range / 4;
  const mag  = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const nice = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
  const step = nice * mag;

  // Reutilizar el mismo transform que el mapa principal
  // (el canvas usa [E, N] → [x, y] con espejo vertical igual que toCanvas)
  // Reconstruimos la transformación en espacio E/N
  const rawStep2 = step; // alias para claridad
  const drawW = W - padding * 2;
  const drawH = H - padding * 2;
  const scaleX = drawW / (rangeE || 1);
  const scaleY = drawH / (rangeN || 1);
  const sc = Math.min(scaleX, scaleY);

  const offX = padding + (drawW - rangeE * sc) / 2;
  const offY = padding + (drawH - rangeN * sc) / 2;

  // [E, N] → [canvasX, canvasY]  (espejo en Y igual que computeTransform)
  const toC = (e, n) => [
    offX + (e - minE) * sc,
    offY + (maxN - n) * sc
  ];

  const startN = Math.floor(minN / step) * step;
  const startE = Math.floor(minE / step) * step;
  const endN   = Math.ceil(maxN  / step) * step;
  const endE   = Math.ceil(maxE  / step) * step;

  const gridFs = Math.max(9, Math.min(11, W / 70));
  ctx.save();
  ctx.font        = `${gridFs}px Inter, system-ui, sans-serif`;
  ctx.fillStyle   = '#1a6b45';
  ctx.strokeStyle = 'rgba(60,140,100,0.30)';
  ctx.lineWidth   = 0.8;
  ctx.setLineDash([4, 4]);

  // Formato de etiqueta compacto
  const fmtLabel = (val) => {
    const s = Math.round(val).toString();
    // Para valores grandes: separar últimos 3 dígitos con apóstrofe
    return s.length > 5 ? s.slice(0, -3) + "'" + s.slice(-3) : s;
  };

  // Líneas horizontales (N constante → y constante en canvas)
  for (let n = startN; n <= endN + step * 0.01; n += step) {
    const [, y] = toC(minE, n);
    if (y < padding * 0.4 || y > H - padding * 0.2) continue;

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`N ${fmtLabel(n)}`, 3, y - 2);
  }

  // Líneas verticales (E constante → x constante en canvas)
  for (let e = startE; e <= endE + step * 0.01; e += step) {
    const [x] = toC(e, minN);
    if (x < padding * 0.4 || x > W - padding * 0.2) continue;

    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();

    // Etiqueta rotada en la parte inferior
    ctx.save();
    ctx.translate(x + 2, H - 3);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`E ${fmtLabel(e)}`, 0, 0);
    ctx.restore();
  }

  ctx.setLineDash([]);
  ctx.restore();
}

function drawMapOnCanvas(canvas, points, segments, closePolygon, padding = 40) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  if (!points.length) return;

  // Usar coordenadas proyectadas si UTM activo
  const proj = projectPointsIfUtm(points);
  const useUtm = utmZoneSelect.value !== '';
  const coords = proj.map(p => useUtm ? [p.lon, p.lat] : [p.e, p.n]);

  // Incluir coords del segmento de cierre si aplica (ya está en segments)
  const { toCanvas, scale } = computeTransform(coords, W, H, padding);
  const canvasPts = coords.map(toCanvas);

  // ── Retícula de coordenadas (UTM si hay zona, o coordenadas locales N/E) ──
  drawGrid(ctx, points, W, H, padding);

  // ── Polígono / polilínea ──
  ctx.beginPath();
  ctx.moveTo(...canvasPts[0]);
  for (let i = 1; i < canvasPts.length; i++) ctx.lineTo(...canvasPts[i]);
  if (closePolygon && canvasPts.length > 2) ctx.closePath();
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth   = 2;
  ctx.stroke();

  // ── Etiquetas de distancia y rumbo sobre cada segmento ──
  const fontSize = Math.max(10, Math.min(13, W / 55));
  ctx.font      = `${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';

  segments.forEach((seg, i) => {
    const fromIdx = points.findIndex(p => p.id === seg.from);
    const toIdx   = points.findIndex(p => p.id === seg.to);
    if (fromIdx === -1 || toIdx === -1) return;

    const [x1, y1] = canvasPts[fromIdx];
    const [x2, y2] = canvasPts[toIdx];
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;

    // Perpendicular al segmento para desplazar la etiqueta
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const perpX = -dy / len, perpY = dx / len;
    const offset = fontSize * 1.1;
    const lx = mx + perpX * offset;
    const ly = my + perpY * offset;

    // Ángulo del segmento para rotar el texto
    let angle = Math.atan2(dy, dx);
    // Mantener texto legible (no cabeza abajo)
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

    const distLabel = `${formatNumber(seg.distance, 2)} m`;
    const rumboLabel = seg.rumbo;

    ctx.save();
    ctx.translate(lx, ly);
    ctx.rotate(angle);

    // Fondo semitransparente para legibilidad
    const pad = 2;
    const distW  = ctx.measureText(distLabel).width;
    const rumboW = ctx.measureText(rumboLabel).width;
    const boxW   = Math.max(distW, rumboW) + pad * 2;
    ctx.fillStyle = 'rgba(255,255,255,0.78)';
    ctx.fillRect(-boxW/2 - pad, -fontSize * 2 - pad, boxW + pad*2, fontSize * 2.4 + pad*2);

    ctx.fillStyle = '#1a6b8a';
    ctx.fillText(distLabel,  0, -fontSize * 0.9);
    ctx.fillStyle = '#444';
    ctx.fillText(rumboLabel, 0,  fontSize * 0.4);

    ctx.restore();
  });

  // ── Puntos (círculos) ──
  const r = Math.max(5, Math.min(8, scale * 0.04));
  canvasPts.forEach((cp, i) => {
    ctx.beginPath();
    ctx.arc(cp[0], cp[1], r, 0, Math.PI * 2);
    ctx.fillStyle   = '#ffffff';
    ctx.strokeStyle = '#1a1a1a';
    ctx.lineWidth   = 2;
    ctx.fill();
    ctx.stroke();
  });

  // ── Etiquetas de ID de cada punto ──
  const labelFont = Math.max(11, Math.min(14, W / 50));
  ctx.font      = `bold ${labelFont}px Inter, system-ui, sans-serif`;
  ctx.textAlign = 'left';

  points.forEach((pt, i) => {
    const [cx, cy] = canvasPts[i];
    const label = pt.id + (pt.z !== undefined ? `\nZ:${formatNumber(pt.z,2)}` : '');
    const lines  = label.split('\n');
    const boxW   = Math.max(...lines.map(l => ctx.measureText(l).width)) + 8;
    const boxH   = lines.length * (labelFont + 2) + 4;
    let lx = cx + r + 4, ly = cy - boxH / 2;

    // Evitar salirse del canvas
    if (lx + boxW > W - 4)  lx = cx - r - 4 - boxW;
    if (ly < 4)              ly = 4;
    if (ly + boxH > H - 4)  ly = H - 4 - boxH;

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(lx - 2, ly - 2, boxW, boxH);

    ctx.fillStyle = '#111';
    lines.forEach((line, li) => {
      ctx.fillText(line, lx, ly + labelFont + li * (labelFont + 2));
    });
  });

  // ── Flecha de Norte (esquina superior izquierda) ──
  const arrowSize = Math.max(18, Math.min(28, W / 28));
  drawNorthArrow(ctx, arrowSize + 6, arrowSize + 16, arrowSize);
}

/**
 * Crea o reutiliza un <canvas> dentro del contenedor dado y lo dibuja.
 */
function renderCanvasMap(container, points, segments, closePolygon) {
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    container.appendChild(canvas);
  }
  canvas.width  = container.clientWidth  || container.offsetWidth  || 600;
  canvas.height = container.clientHeight || container.offsetHeight || 500;
  drawMapOnCanvas(canvas, points, segments, closePolygon);
  return canvas;
}

// ──────────────────────────────────────────────
//  Tablas HTML
// ──────────────────────────────────────────────

function buildPointTable(points, segments, hasZ) {
  const table = document.createElement('table');
  const headers = ['ID', 'N', 'E'];
  if (hasZ) headers.push('Z');
  headers.push('Distancia (m)', 'Rumbo');

  const hr = document.createElement('tr');
  headers.forEach(t => { const th = document.createElement('th'); th.textContent = t; hr.appendChild(th); });
  table.appendChild(hr);

  points.forEach((pt, i) => {
    const row = document.createElement('tr');
    const seg = i < segments.length ? segments[i] : null;   // segmento saliente

    const vals = [pt.id, formatNumber(pt.n,3), formatNumber(pt.e,3)];
    if (hasZ) vals.push(pt.z !== undefined ? formatNumber(pt.z,3) : '—');
    vals.push(seg ? formatNumber(seg.distance,3) : '', seg ? seg.rumbo : '');

    vals.forEach(v => { const td = document.createElement('td'); td.textContent = v; row.appendChild(td); });
    table.appendChild(row);
  });
  return table;
}

function buildSegmentsTable(segments) {
  const table = document.createElement('table');
  const hr = document.createElement('tr');
  ['Línea','Desde','Hasta','ΔN','ΔE','Distancia (m)','Rumbo'].forEach(t => {
    const th = document.createElement('th'); th.textContent = t; hr.appendChild(th);
  });
  table.appendChild(hr);

  segments.forEach(seg => {
    const row = document.createElement('tr');
    [seg.line, seg.from, seg.to,
     formatNumber(seg.deltaN,3), formatNumber(seg.deltaE,3),
     formatNumber(seg.distance,3), seg.rumbo
    ].forEach(v => { const td = document.createElement('td'); td.textContent = v; row.appendChild(td); });
    table.appendChild(row);
  });
  return table;
}

// ──────────────────────────────────────────────
//  Renderizado principal (pantalla)
// ──────────────────────────────────────────────

function updateOutput() {
  if (!parsedPoints.length) { outputPanel.hidden = true; return; }

  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') points.reverse();
  const close    = closePolygonCheckbox.checked;
  const segments = computeSegments(points, close);
  const hasZ     = points.some(p => p.z !== undefined);

  tableWrapper.innerHTML = '';

  // ── Cuadro de Puntos ──
  const t1 = document.createElement('h3'); t1.textContent = 'Cuadro de Puntos';
  tableWrapper.appendChild(t1);
  tableWrapper.appendChild(buildPointTable(points, segments, hasZ));

  // ── Cuadro de Líneas ──
  if (segments.length) {
    const t2 = document.createElement('h3'); t2.textContent = 'Cuadro de Líneas';
    tableWrapper.appendChild(t2);
    tableWrapper.appendChild(buildSegmentsTable(segments));

    if (close) {
      const total = segments.reduce((s,sg) => s + sg.distance, 0);
      const area  = computeArea(points);
      const p = document.createElement('div'); p.className = 'summary';
      p.textContent = `Perímetro total: ${formatNumber(total,3)} m`;
      tableWrapper.appendChild(p);
      const a = document.createElement('div'); a.className = 'summary';
      a.textContent = `Área (Gauss): ${formatNumber(area,3)} m²  /  ${formatNumber(area/10000,4)} ha`;
      tableWrapper.appendChild(a);
    }
  }

  // ── Mapa Canvas ──
  const mapEl = document.getElementById('map');
  if (mapEl) renderCanvasMap(mapEl, points, segments, close);

  outputPanel.hidden = false;
}

// ──────────────────────────────────────────────
//  Exportación  (PDF / JPG)
//
//  Layout A4 landscape px @150dpi: 1754 × 1240 px  → usamos 1587 × 1122 (A4 @96dpi ×1.65)
//  Estructura:
//    ┌─────────────────────────────┐
//    │  Título                     │
//    ├──────────────┬──────────────┤
//    │  MAPA CANVAS │  Cuadro de   │
//    │  (60% ancho) │  Puntos      │
//    │              │  Cuadro de   │
//    │              │  Líneas      │
//    └──────────────┴──────────────┘
//
//  Si las tablas no caben, se escalan con CSS transform.
// ──────────────────────────────────────────────

async function buildExportContainer(points, segments, close) {
  const hasZ = points.some(p => p.z !== undefined);

  // ── Contenedor raíz (A4 landscape a 96dpi) ──
  const PW = 1123, PH = 794;   // px ≈ A4 landscape @96dpi

  const root = document.createElement('div');
  Object.assign(root.style, {
    position:   'fixed',
    left:       '-5000px',
    top:        '0',
    width:      PW + 'px',
    height:     PH + 'px',
    background: '#ffffff',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontSize:   '11px',
    color:      '#111',
    boxSizing:  'border-box',
    padding:    '18px',
    display:    'flex',
    flexDirection: 'column',
    gap:        '8px',
  });

  // ── Título ──
  const titleEl = document.createElement('div');
  Object.assign(titleEl.style, { fontWeight:'700', fontSize:'15px', borderBottom:'2px solid #111', paddingBottom:'6px', flexShrink:'0' });
  titleEl.textContent = 'Cuadro de Construcción';
  root.appendChild(titleEl);

  // ── Fila principal: mapa | tablas ──
  const row = document.createElement('div');
  Object.assign(row.style, { display:'flex', gap:'12px', flex:'1 1 0', minHeight:'0', overflow:'hidden' });
  root.appendChild(row);

  // ── Panel mapa (canvas) ──
  const mapPanel = document.createElement('div');
  const mapW = Math.round(PW * 0.60);
  Object.assign(mapPanel.style, {
    width:   mapW + 'px',
    flexShrink: '0',
    border:  '1px solid #ccc',
    borderRadius: '6px',
    overflow:'hidden',
    background:'#fff',
  });
  row.appendChild(mapPanel);

  // ── Panel tablas ──
  const tabPanel = document.createElement('div');
  Object.assign(tabPanel.style, {
    flex:       '1 1 0',
    overflow:   'hidden',
    display:    'flex',
    flexDirection:'column',
    gap:        '8px',
  });
  row.appendChild(tabPanel);

  // Cuadro de Puntos
  const t1 = document.createElement('div');
  t1.style.overflow = 'hidden';
  const h1 = document.createElement('div');
  Object.assign(h1.style, { fontWeight:'700', marginBottom:'4px' });
  h1.textContent = 'Cuadro de Puntos';
  t1.appendChild(h1);
  t1.appendChild(buildPointTable(points, segments, hasZ));
  tabPanel.appendChild(t1);

  // Cuadro de Líneas
  if (segments.length) {
    const t2 = document.createElement('div');
    t2.style.overflow = 'hidden';
    const h2 = document.createElement('div');
    Object.assign(h2.style, { fontWeight:'700', marginBottom:'4px' });
    h2.textContent = 'Cuadro de Líneas';
    t2.appendChild(h2);
    t2.appendChild(buildSegmentsTable(segments));
    tabPanel.appendChild(t2);

    if (close) {
      const total = segments.reduce((s,sg) => s + sg.distance, 0);
      const area  = computeArea(points);
      const info  = document.createElement('div');
      Object.assign(info.style, { fontWeight:'700', fontSize:'10px', marginTop:'4px' });
      info.innerHTML = `Perímetro: ${formatNumber(total,3)} m &nbsp;|&nbsp; Área (Gauss): ${formatNumber(area,3)} m² / ${formatNumber(area/10000,4)} ha`;
      tabPanel.appendChild(info);
    }
  }

  document.body.appendChild(root);

  // ── Dibujar canvas del mapa ──
  const canvas = document.createElement('canvas');
  canvas.width  = mapW - 2;
  canvas.height = PH - 60;   // descontar título + padding
  mapPanel.appendChild(canvas);
  drawMapOnCanvas(canvas, points, segments, close, 30);

  // ── Escalar tablas si se desbordan ──
  await new Promise(r => setTimeout(r, 80));  // permitir layout

  [t1, ...(segments.length ? [tabPanel.children[1]] : [])].forEach(panel => {
    const table = panel.querySelector('table');
    if (!table) return;
    const panelH = tabPanel.clientHeight / (segments.length ? 2 : 1) - 20;
    const panelW = tabPanel.clientWidth;
    const tH = table.scrollHeight;
    const tW = table.scrollWidth;
    const scaleX = tW > panelW ? panelW / tW : 1;
    const scaleY = tH > panelH ? panelH / tH : 1;
    const sc = Math.min(scaleX, scaleY);
    if (sc < 1) {
      table.style.transformOrigin = 'top left';
      table.style.transform       = `scale(${sc})`;
    }
  });

  return { root, canvas };
}

async function captureExport(format) {
  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') points.reverse();
  const close    = closePolygonCheckbox.checked;
  const segments = computeSegments(points, close);

  const { root, canvas } = await buildExportContainer(points, segments, close);

  try {
    await new Promise(r => setTimeout(r, 120));
    const shot = await html2canvas(root, { scale:2, backgroundColor:'#ffffff', useCORS:true, logging:false });

    if (format === 'pdf') {
      const img    = shot.toDataURL('image/jpeg', 0.97);
      const pdf    = new window.jspdf.jsPDF('l', 'mm', 'a4');  // landscape
      const pW     = 297, pH = 210;
      const iProps = pdf.getImageProperties(img);
      const iH     = (iProps.height * pW) / iProps.width;
      pdf.addImage(img, 'JPEG', 0, 0, pW, iH > pH ? pH : iH);
      pdf.save('cuadro_construccion.pdf');
    } else {
      const img  = shot.toDataURL('image/jpeg', 0.97);
      const link = document.createElement('a');
      link.href     = img;
      link.download = 'cuadro_construccion.jpg';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  } finally {
    if (root.parentNode) root.parentNode.removeChild(root);
  }
}

// ──────────────────────────────────────────────
//  Descarga CSV
// ──────────────────────────────────────────────

function createDownloadCsv(points, segments) {
  const hasZ = points.some(p => p.z !== undefined);
  const headers = hasZ ? ['id','n','e','z','distancia','rumbo'] : ['id','n','e','distancia','rumbo'];

  const rows = points.map((pt, i) => {
    const seg = i < segments.length ? segments[i] : null;
    const base = [pt.id, formatNumber(pt.n,3), formatNumber(pt.e,3)];
    if (hasZ) base.push(pt.z !== undefined ? formatNumber(pt.z,3) : '');
    base.push(seg ? formatNumber(seg.distance,3) : '', seg ? seg.rumbo : '');
    return base.join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

// ──────────────────────────────────────────────
//  Event listeners
// ──────────────────────────────────────────────

parseButton.addEventListener('click', async () => {
  const file = csvFileInput.files[0];
  let raw = csvText.value.trim();
  if (!raw && file) raw = await file.text();
  if (!raw) { showStatus('No hay CSV para leer.', 'error'); return; }

  try {
    parsedPoints = parseCsvText(raw);
    updateOutput();
    [generateButton, downloadButton, exportPdfButton, exportJpgButton].forEach(b => b.disabled = false);
    showStatus(`CSV leído: ${parsedPoints.length} puntos cargados.`, 'ok');
  } catch (err) {
    parsedPoints = [];
    updateOutput();
    [generateButton, downloadButton, exportPdfButton, exportJpgButton].forEach(b => b.disabled = true);
    showStatus(err.message, 'error');
  }
});

generateButton.addEventListener('click', () => {
  if (!parsedPoints.length) return;
  updateOutput();
  showStatus('Cuadro actualizado.', 'ok');
});

exportPdfButton.addEventListener('click', async () => {
  if (!parsedPoints.length) return;
  exportPdfButton.disabled = true;
  exportPdfButton.textContent = 'Generando PDF…';
  try    { await captureExport('pdf'); }
  finally { exportPdfButton.disabled = false; exportPdfButton.textContent = 'Exportar PDF'; }
});

exportJpgButton.addEventListener('click', async () => {
  if (!parsedPoints.length) return;
  exportJpgButton.disabled = true;
  exportJpgButton.textContent = 'Generando JPG…';
  try    { await captureExport('jpg'); }
  finally { exportJpgButton.disabled = false; exportJpgButton.textContent = 'Exportar JPG'; }
});

downloadButton.addEventListener('click', () => {
  if (!parsedPoints.length) return;
  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') points.reverse();
  const segments = computeSegments(points, closePolygonCheckbox.checked);
  const content  = createDownloadCsv(points, segments);
  const blob = new Blob([content], { type:'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'cuadro_construccion.csv';
  document.body.appendChild(link); link.click();
  document.body.removeChild(link); URL.revokeObjectURL(url);
});

// Redibujar el canvas si cambia zona UTM o sentido
[directionSelect, utmZoneSelect, utmHemisphereSelect, closePolygonCheckbox].forEach(el => {
  el.addEventListener('change', () => { if (parsedPoints.length) updateOutput(); });
});