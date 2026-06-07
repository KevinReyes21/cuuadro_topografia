const csvFileInput = document.getElementById('csvFile');
const csvText = document.getElementById('csvText');
const parseButton = document.getElementById('parseButton');
const generateButton = document.getElementById('generateButton');
const downloadButton = document.getElementById('downloadButton');
const exportPdfButton = document.getElementById('exportPdfButton');
const exportJpgButton = document.getElementById('exportJpgButton');
const directionSelect = document.getElementById('directionSelect');
const closePolygonCheckbox = document.getElementById('closePolygon');
const utmZoneSelect = document.getElementById('utmZone');
const utmHemisphereSelect = document.getElementById('utmHemisphere');
const outputPanel = document.getElementById('outputPanel');
const tableWrapper = document.getElementById('tableWrapper');

let parsedPoints = [];

function parseCsvText(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw new Error('El CSV está vacío.');
  }

  const headers = lines[0].split(',').map((header) => header.trim().toLowerCase());
  const expected = ['id', 'n', 'e'];

  for (const key of expected) {
    if (!headers.includes(key)) {
      throw new Error('Falta la columna `' + key + '` en el encabezado.');
    }
  }

  const idIndex = headers.indexOf('id');
  const nIndex = headers.indexOf('n');
  const eIndex = headers.indexOf('e');

  return lines.slice(1).map((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim());
    const id = cells[idIndex] || '';
    const n = parseFloat(cells[nIndex]);
    const e = parseFloat(cells[eIndex]);

    if (!id) {
      throw new Error(`Fila ${index + 2}: id vacío.`);
    }
    if (Number.isNaN(n)) {
      throw new Error(`Fila ${index + 2}: coordenada N inválida.`);
    }
    if (Number.isNaN(e)) {
      throw new Error(`Fila ${index + 2}: coordenada E inválida.`);
    }

    return { id, n, e };
  });
}

function formatNumber(value, decimals = 3) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '';
}

function toDMS(decimalDegrees) {
  const degrees = Math.floor(decimalDegrees);
  const minutesRaw = (decimalDegrees - degrees) * 60;
  const minutes = Math.floor(minutesRaw);
  const seconds = Math.round((minutesRaw - minutes) * 60);
  return `${degrees}°${String(minutes).padStart(2, '0')}'${String(seconds).padStart(2, '0')}"`;
}

function azimuthToRumbo(azimuth) {
  const angle = (azimuth + 360) % 360;

  if (angle <= 90) {
    return `N ${toDMS(angle)} E`;
  }
  if (angle <= 180) {
    return `S ${toDMS(180 - angle)} E`;
  }
  if (angle <= 270) {
    return `S ${toDMS(angle - 180)} W`;
  }
  return `N ${toDMS(360 - angle)} W`;
}

function calculateSegment(from, to, index) {
  const deltaN = to.n - from.n;
  const deltaE = to.e - from.e;
  const distance = Math.hypot(deltaN, deltaE);
  const azimuth = (Math.atan2(deltaE, deltaN) * 180) / Math.PI;
  const normalizedAzimuth = (azimuth + 360) % 360;

  return {
    line: `L${index}`,
    from: from.id,
    to: to.id,
    deltaN,
    deltaE,
    distance,
    azimuth: normalizedAzimuth,
    rumbo: azimuthToRumbo(normalizedAzimuth)
  };
}

function computeSegments(points, closePolygon) {
  const segments = [];

  for (let i = 0; i < points.length - 1; i += 1) {
    segments.push(calculateSegment(points[i], points[i + 1], i + 1));
  }

  if (closePolygon && points.length > 2) {
    segments.push(calculateSegment(points[points.length - 1], points[0], segments.length + 1));
  }

  return segments;
}

function utmToLatLon(easting, northing, zoneNumber, isNorthern) {
  if (typeof proj4 === 'undefined') {
    console.warn('proj4 not loaded; returning original coords');
    return { lat: northing, lon: easting };
  }

  const utmProj = `+proj=utm +zone=${zoneNumber} +datum=WGS84 ${isNorthern ? '' : '+south'}`;
  const wgs84 = '+proj=longlat +datum=WGS84 +no_defs';

  try {
    const transformer = proj4(utmProj, wgs84);
    const [lon, lat] = transformer([easting, northing]);
    return { lat, lon };
  } catch (err) {
    console.error('Conversion error:', err);
    return { lat: northing, lon: easting };
  }
}

function projectPointsIfUtm(points) {
  const zone = utmZoneSelect.value;
  if (!zone) return points; // no projection

  const hemisphere = utmHemisphereSelect.value === 'N';
  return points.map((p) => {
    const { lat, lon } = utmToLatLon(p.e, p.n, parseInt(zone), hemisphere);
    return { ...p, lat, lon };
  });
}

function clearLeafletMap(container) {
  if (!container) return;
  const map = container._leaflet_map;
  if (map) {
    try { map.remove(); } catch (e) {}
    container._leaflet_map = null;
  }
}

function renderMapInContainer(container, points, segments, closePolygon) {
  if (!container || typeof L === 'undefined') return;
  clearLeafletMap(container);

  // project points if UTM zone is selected
  const projectedPoints = projectPointsIfUtm(points);
  const useUtm = utmZoneSelect.value !== '';

  let map;
  const coordKey1 = useUtm ? 'lat' : 'n';
  const coordKey2 = useUtm ? 'lon' : 'e';

  if (useUtm) {
    map = L.map(container, { zoomControl: true, attributionControl: false });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19,
      crossOrigin: true
    }).addTo(map);
  } else {
    map = L.map(container, { crs: L.CRS.Simple, zoomControl: true, attributionControl: false });
  }

  if (!projectedPoints || projectedPoints.length === 0) {
    container._leaflet_map = map;
    return map;
  }

  const minC1 = Math.min(...projectedPoints.map((p) => p[coordKey1]));
  const maxC1 = Math.max(...projectedPoints.map((p) => p[coordKey1]));
  const minC2 = Math.min(...projectedPoints.map((p) => p[coordKey2]));
  const maxC2 = Math.max(...projectedPoints.map((p) => p[coordKey2]));

  const southWest = [minC1, minC2];
  const northEast = [maxC1, maxC2];
  const bounds = L.latLngBounds(southWest, northEast);
  map.fitBounds(bounds.pad(0.15));

  // draw polyline using the original point order
  if (projectedPoints.length > 1) {
    const lineCoords = projectedPoints.map((p) => [p[coordKey1], p[coordKey2]]);
    L.polyline(lineCoords, { color: '#111', weight: 2 }).addTo(map);
  }

  // draw points as circleMarkers
  projectedPoints.forEach((p) => {
    const marker = L.circleMarker([p[coordKey1], p[coordKey2]], {
      radius: 6,
      color: '#111',
      weight: 2,
      fillColor: '#ffffff',
      fillOpacity: 1
    }).addTo(map);
    let tooltipText = `${p.id}`;
    if (useUtm) {
      tooltipText += `\nLat:${formatNumber(p.lat, 5)} Lon:${formatNumber(p.lon, 5)}`;
      tooltipText += `\nUTM N:${formatNumber(p.n, 3)} E:${formatNumber(p.e, 3)}`;
    } else {
      tooltipText += `\nN:${formatNumber(p.n, 3)} E:${formatNumber(p.e, 3)}`;
    }
    marker.bindTooltip(tooltipText, { direction: 'top' });
  });

  container._leaflet_map = map;
  return map;
}

function buildPointTable(points, segments) {
  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  ['ID', 'N', 'E', 'Distancia', 'Rumbo'].forEach((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  points.forEach((point, index) => {
    const row = document.createElement('tr');
    const previousSegment = index > 0 ? segments[index - 1] : null;

    ['id', 'n', 'e'].forEach((key) => {
      const cell = document.createElement('td');
      cell.textContent = key === 'n' || key === 'e' ? formatNumber(point[key], 3) : point[key];
      row.appendChild(cell);
    });

    const distanceCell = document.createElement('td');
    distanceCell.textContent = previousSegment ? formatNumber(previousSegment.distance, 3) : '';
    row.appendChild(distanceCell);

    const rumboCell = document.createElement('td');
    rumboCell.textContent = previousSegment ? previousSegment.rumbo : '';
    row.appendChild(rumboCell);

    table.appendChild(row);
  });

  return table;
}

function buildSegmentsTable(segments) {
  const table = document.createElement('table');
  const headerRow = document.createElement('tr');
  ['Línea', 'Desde', 'Hasta', 'ΔN', 'ΔE', 'Distancia', 'Rumbo'].forEach((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  table.appendChild(headerRow);

  segments.forEach((segment) => {
    const row = document.createElement('tr');
    [segment.line, segment.from, segment.to].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });

    const deltaNCell = document.createElement('td');
    deltaNCell.textContent = formatNumber(segment.deltaN, 3);
    row.appendChild(deltaNCell);

    const deltaECell = document.createElement('td');
    deltaECell.textContent = formatNumber(segment.deltaE, 3);
    row.appendChild(deltaECell);

    const distanceCell = document.createElement('td');
    distanceCell.textContent = formatNumber(segment.distance, 3);
    row.appendChild(distanceCell);

    const rumboCell = document.createElement('td');
    rumboCell.textContent = segment.rumbo;
    row.appendChild(rumboCell);

    table.appendChild(row);
  });

  return table;
}

function updateOutput() {
  if (parsedPoints.length === 0) {
    outputPanel.hidden = true;
    return;
  }

  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') {
    points.reverse();
  }

  const closePolygon = closePolygonCheckbox.checked;
  const segments = computeSegments(points, closePolygon);

  tableWrapper.innerHTML = '';

  const pointsTitle = document.createElement('h3');
  pointsTitle.textContent = 'Cuadro de Puntos';
  tableWrapper.appendChild(pointsTitle);
  tableWrapper.appendChild(buildPointTable(points, segments));

  if (segments.length > 0) {
    const segmentsTitle = document.createElement('h3');
    segmentsTitle.textContent = 'Cuadro de Líneas';
    tableWrapper.appendChild(segmentsTitle);
    tableWrapper.appendChild(buildSegmentsTable(segments));

    if (closePolygon) {
      const totalLength = segments.reduce((sum, segment) => sum + segment.distance, 0);
      const summary = document.createElement('div');
      summary.className = 'summary';
      summary.textContent = `Perímetro total: ${formatNumber(totalLength, 3)} m`;
      tableWrapper.appendChild(summary);
    }
  }

  // render UI map
  const mapEl = document.getElementById('map');
  if (mapEl && typeof L !== 'undefined') {
    renderMapInContainer(mapEl, points, segments, closePolygon);
  }

  outputPanel.hidden = false;
}

function createExportLayout(points, segments, closePolygon) {
  // create offscreen container sized for capture
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-4000px';
  container.style.top = '0';
  container.style.width = '1400px';
  container.style.height = '1600px';
  container.style.background = '#ffffff';
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.padding = '18px';
  container.style.boxSizing = 'border-box';
  container.style.fontFamily = 'Inter, system-ui, sans-serif';

  const mapDiv = document.createElement('div');
  mapDiv.style.width = '100%';
  mapDiv.style.height = '75%';
  mapDiv.style.background = '#fff';
  mapDiv.style.border = '1px solid #dcdcdc';
  mapDiv.style.borderRadius = '8px';
  mapDiv.style.overflow = 'hidden';
  mapDiv.style.marginBottom = '16px';

  const tableDiv = document.createElement('div');
  tableDiv.style.width = '100%';
  tableDiv.style.height = '25%';
  tableDiv.style.overflow = 'hidden';
  tableDiv.style.background = '#fff';
  tableDiv.style.border = '1px solid #dcdcdc';
  tableDiv.style.borderRadius = '8px';
  tableDiv.style.padding = '12px';
  tableDiv.style.boxSizing = 'border-box';
  tableDiv.style.fontSize = '12px';
  tableDiv.style.lineHeight = '1.2';

  // build tables
  const pointsTitle = document.createElement('h3');
  pointsTitle.textContent = 'Cuadro de Puntos';
  const segmentsTitle = document.createElement('h3');
  segmentsTitle.textContent = 'Cuadro de Líneas';

  tableDiv.appendChild(pointsTitle);
  tableDiv.appendChild(buildPointTable(points, segments));
  if (segments.length > 0) {
    const separator = document.createElement('div');
    separator.style.height = '12px';
    tableDiv.appendChild(separator);
    tableDiv.appendChild(segmentsTitle);
    tableDiv.appendChild(buildSegmentsTable(segments));
  }

  container.appendChild(mapDiv);
  container.appendChild(tableDiv);
  document.body.appendChild(container);

  // render leaflet map into mapDiv if available
  if (typeof L !== 'undefined') {
    renderMapInContainer(mapDiv, points, segments, closePolygon);
  }

  return { container, mapDiv };
}

function createDownloadCsv(points, segments) {
  const headers = ['id', 'n', 'e', 'distancia', 'rumbo'];
  const rows = points.map((point, index) => {
    const segment = index > 0 ? segments[index - 1] : null;
    return [
      point.id,
      formatNumber(point.n, 3),
      formatNumber(point.e, 3),
      segment ? formatNumber(segment.distance, 3) : '',
      segment ? segment.rumbo : ''
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

function captureOutputCanvas() {
  return html2canvas(outputPanel, { scale: 2, backgroundColor: '#ffffff' });
}

async function exportPdf() {
  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') points.reverse();
  const closePolygon = closePolygonCheckbox.checked;
  const segments = computeSegments(points, closePolygon);

  const { container, mapDiv } = createExportLayout(points, segments, closePolygon);
  // allow leaflet tiles and markers to render
  await new Promise((r) => setTimeout(r, 500));
  const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const image = canvas.toDataURL('image/jpeg', 1.0);
  const pdf = new window.jspdf.jsPDF('p', 'mm', 'a4');
  const pageWidth = 210;
  const pageHeight = 297;
  const imgProps = pdf.getImageProperties(image);
  const imgWidth = pageWidth;
  const imgHeight = (imgProps.height * imgWidth) / imgProps.width;
  if (imgHeight > pageHeight) {
    pdf.addImage(image, 'JPEG', 0, 0, pageWidth, pageHeight);
  } else {
    pdf.addImage(image, 'JPEG', 0, 0, imgWidth, imgHeight);
  }
  pdf.save('cuadro_construccion.pdf');

  // cleanup
  clearLeafletMap(mapDiv);
  if (container && container.parentNode) container.parentNode.removeChild(container);
}

async function exportJpg() {
  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') points.reverse();
  const closePolygon = closePolygonCheckbox.checked;
  const segments = computeSegments(points, closePolygon);

  const { container, mapDiv } = createExportLayout(points, segments, closePolygon);
  await new Promise((r) => setTimeout(r, 500));
  const canvas = await html2canvas(container, { scale: 2, backgroundColor: '#ffffff', useCORS: true });
  const image = canvas.toDataURL('image/jpeg', 1.0);
  const link = document.createElement('a');
  link.href = image;
  link.download = 'cuadro_construccion.jpg';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  clearLeafletMap(mapDiv);
  if (container && container.parentNode) container.parentNode.removeChild(container);
}

parseButton.addEventListener('click', async () => {
  const file = csvFileInput.files[0];
  let rawText = csvText.value.trim();

  if (!rawText && file) {
    rawText = await file.text();
  }

  try {
    parsedPoints = parseCsvText(rawText);
    updateOutput();
    generateButton.disabled = false;
    downloadButton.disabled = false;
    exportPdfButton.disabled = false;
    exportJpgButton.disabled = false;
    alert('CSV leído correctamente. Ahora puedes generar o descargar el cuadro.');
  } catch (error) {
    parsedPoints = [];
    updateOutput();
    generateButton.disabled = true;
    downloadButton.disabled = true;
    alert(error.message);
  }
});

generateButton.addEventListener('click', () => {
  if (parsedPoints.length === 0) return;
  updateOutput();
  alert('Cuadro de construcción generado.');
});

exportPdfButton.addEventListener('click', async () => {
  if (parsedPoints.length === 0) return;
  await exportPdf();
});

exportJpgButton.addEventListener('click', async () => {
  if (parsedPoints.length === 0) return;
  await exportJpg();
});

downloadButton.addEventListener('click', () => {
  if (parsedPoints.length === 0) return;
  const points = parsedPoints.slice();
  if (directionSelect.value === 'reverse') {
    points.reverse();
  }
  const segments = computeSegments(points, closePolygonCheckbox.checked);
  const csvContent = createDownloadCsv(points, segments);

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cuadro_construccion.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
});
