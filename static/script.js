// Convert degrees (0-360) to cardinal direction text (Detailed)
function getWindDirectionText(degrees) {
    if (degrees === undefined || degrees === null || isNaN(degrees)) return 'N/A';
    if (degrees >= 337.5 || degrees < 22.5) return "N (North)";
    if (degrees >= 22.5 && degrees < 45) return "NNE (North-Northeast)";
    if (degrees >= 45 && degrees < 67.5) return "NE (Northeast)";
    if (degrees >= 67.5 && degrees < 90) return "ENE (East-Northeast)";
    if (degrees >= 90 && degrees < 112.5) return "E (East)";
    if (degrees >= 112.5 && degrees < 135) return "ESE (East-Southeast)";
    if (degrees >= 135 && degrees < 157.5) return "SE (Southeast)";
    if (degrees >= 157.5 && degrees < 180) return "SSE (South-Southeast)";
    if (degrees >= 180 && degrees < 202.5) return "S (South)";
    if (degrees >= 202.5 && degrees < 225) return "SSW (South-Southwest)";
    if (degrees >= 225 && degrees < 247.5) return "SW (Southwest)";
    if (degrees >= 247.5 && degrees < 270) return "WSW (West-Southwest)";
    if (degrees >= 270 && degrees < 292.5) return "W (West)";
    if (degrees >= 292.5 && degrees < 315) return "WNW (West-Northwest)";
    if (degrees >= 315 && degrees < 337.5) return "NW (Northwest)";
    return "NNW (North-Northwest)";
}

// Convert date to Spanish format: "13 de marzo del 2020"
function formatDateSpanish(date) {
    if (!date || isNaN(date)) return "";
    const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    return `${date.getDate()} de ${months[date.getMonth()]} del ${date.getFullYear()}`;
}

// Global attributes configuration
const contaminantAttributes = ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3'];
const meteorologicalAttributes = ['TEMP', 'PRES', 'DEWP', 'RAIN'];
const windAttributes = ['WSPM', 'WD'];
const allPossibleAttributes = [...contaminantAttributes, ...meteorologicalAttributes, ...windAttributes];

let map;
let lastInfoWindow = null;
let stationMeta = null;
let currentCountry = 'China';
let stations = []; // Dynamic station objects {id, name, file} for current country
let stationAbbreviations = {}; // Dynamic abbreviations
let stationDataFromTxt = []; // Raw data from stations.txt
let markerLayer = null;
let flowLayer = null;
let geoJsonLayer = null;
let mapAqiData = null;
let dimensionality = "pca2"; // Global dimensionality state
let currentFilename = 'China_1000.csv'; // Dataset global actual
let startDateFilter = null;
let endDateFilter = null;
let meteoDataCache = {}; // Cache: { country: { "stationId_YYYY-MM-DD": { TEMP, PRES, DEWP, WSPM } } }
let isProgrammaticSelection = false;
const getFusionPath = () => `NEW_MODEL_DCAE/fusion/data_unida/real_data_${dimensionality}/`;

// Carga y cachea los datos meteorológicos para un país, uniéndolos con las estaciones
async function loadMeteoForCountry(country) {
    if (meteoDataCache[country]) return; // Ya cargado
    const countryLower = country.toLowerCase();
    try {
        // 1. Leer station CSV para obtener IDs válidos
        const stationRows = await d3.csv(`NEW-DATA/DATA/Station/station_${countryLower}.csv`);
        const validStationIds = new Set(stationRows.map(r => String(r.station_id)));

        // 2. Leer meteo CSV
        const meteoRows = await d3.csv(`NEW-DATA/DATA/Meteo/meteorology_${countryLower}.csv`);

        // 3. Agrupar por (station_id, date) calculando promedios diarios
        const daily = {};
        meteoRows.forEach(r => {
            const stId = String(r.id);
            if (!validStationIds.has(stId)) return;
            // Parsear fecha desde formato '2019-01-01 00:00:00'
            const timeParts = (r.time || '').split(' ')[0].split('-');
            if (timeParts.length < 3) return;
            const dateKey = `${timeParts[0]}-${+timeParts[1]}-${+timeParts[2]}`;
            const cacheKey = `${stId}_${dateKey}`;
            if (!daily[cacheKey]) {
                daily[cacheKey] = { TEMP: 0, PRES: 0, DEWP: 0, WSPM: 0, RAIN: 0, WD: 0, count: 0 };
            }
            const e = daily[cacheKey];
            e.TEMP += isNaN(+r.temperature) ? 0 : +r.temperature;
            e.PRES += isNaN(+r.pressure) ? 0 : +r.pressure;
            e.DEWP += isNaN(+r.humidity) ? 0 : +r.humidity;  // approx
            e.WSPM += isNaN(+r.wind_speed) ? 0 : +r.wind_speed;
            e.RAIN += isNaN(+r.rain) ? 0 : +r.rain;
            // Solo WD si es número y > 0 (evitar promedio con error 0 si no es norte real)
            e.WD += isNaN(+r.wind_direction) ? 0 : +r.wind_direction;
            e.count += 1;
        });

        // 4. Calcular promedios
        const cache = {};
        Object.entries(daily).forEach(([key, v]) => {
            if (v.count === 0) return;
            cache[key] = {
                TEMP: v.TEMP / v.count,
                PRES: v.PRES / v.count,
                DEWP: v.DEWP / v.count,
                WSPM: v.WSPM / v.count,
                RAIN: v.RAIN, // precipitation is sum, was already summed
                WD: v.WD / v.count
            };
        });
        meteoDataCache[country] = cache;
        console.log(`[MeteoCache] ${country}: ${Object.keys(cache).length} registros diarios cargados.`);
    } catch (err) {
        console.error(`[MeteoCache] Error cargando datos meteorológicos para ${country}:`, err);
        meteoDataCache[country] = {};
    }
}

// Enriquecer puntos de datos con valores del cache de meteorología
function enrichWithMeteoCache(dataPoints, country) {
    const cache = meteoDataCache[country] || {};
    const meteoAttrs = ['TEMP', 'PRES', 'DEWP', 'WSPM', 'RAIN', 'WD'];
    return dataPoints.map(d => {
        // Construir fecha: soportar tanto d.date (Date obj / string) como d.year+d.month+d.day
        // Los datos de Fusion UMAP solo tienen year/month/day, NO tienen d.date.
        // Sin esta corrección, new Date(undefined) produce Invalid Date y todos los lookups fallan.
        const originalDate = d.date instanceof Date
            ? d.date
            : (d.date ? new Date(d.date) : new Date(+d.year, +d.month - 1, +d.day));
        // Recorrer un día (shift) según pedido del usuario: el clima de ayer afecta hoy
        const shiftedDate = d3.timeDay.offset(originalDate, 0);
        // Si el usuario quiere "aumentarlo un día", tal vez quiere que la data de CACHE 2019-01-01 
        // se asigne al dataPoint de 2019-01-02.
        // Entonces para el dataPoint de 2019-01-02, buscamos cacheKey de 2019-01-01.
        const lookupDate = d3.timeDay.offset(originalDate, -1);
        const dateKey = `${lookupDate.getFullYear()}-${lookupDate.getMonth() + 1}-${lookupDate.getDate()}`;

        const stId = String(d.station);
        const cacheKey = `${stId}_${dateKey}`;
        const meteo = cache[cacheKey];
        if (!meteo) return d;
        const enriched = Object.assign({}, d);
        meteoAttrs.forEach(attr => {
            if (meteo[attr] !== undefined) enriched[attr] = meteo[attr];
        });
        if (meteo.WD !== undefined) {
            enriched.WD = meteo.WD; // Uppercase para consistencia con otros atributos
            enriched.wd = meteo.WD; // Mantener lowercase para compatibilidad
        }
        return enriched;
    });
}

function isMeteorologicalAttribute(attr) {
    return ['TEMP', 'PRES', 'DEWP', 'WSPM', 'RAIN', 'WD'].includes(attr);
}

// --- AQI GLOBAL CONFIGURATION ---
const dailyLimits = {
    'PM2_5': 150,
    'PM10': 150,
    'CO': 4, // mg/m³
    'SO2': 150,
    'NO2': 80,
    'O3': 200
};
const aqiRanges = [[0, 50], [50, 100], [100, 150], [150, 200], [200, 300], [300, 400], [400, 600]];
const aqiColors = ['#00e400', '#ffff00', '#ff7e00', '#ff0000', '#99004c', '#800000'];
const meteorologicalColor = 'blue';

function getAQI_Index(value, attribute) {
    if (attribute === 'CO') value /= 1000;
    if (dailyLimits[attribute] && !isNaN(value)) {
        const limit = dailyLimits[attribute];
        const aqiIndex = aqiRanges.findIndex(range => value <= (limit * range[1]) / 100);
        return aqiIndex >= 0 ? aqiIndex + 1 : 6;
    }
    return 1;
}

function getAQIColor(value, attribute) {
    if (dailyLimits[attribute]) {
        const idx = getAQI_Index(value, attribute);
        return aqiColors[idx - 1] || aqiColors[5];
    }
    return meteorologicalColor; // Azul para meteorología
}

function getGlobalAQIColor(d) {
    // Determine overall AQI by taking the worst case across all contaminants
    const pollutants = ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3'];
    let maxIdx = 1;
    pollutants.forEach(p => {
        const val = +d[p.replace('.', '_')];
        if (!isNaN(val)) {
            const idx = getAQI_Index(val, p);
            if (idx > maxIdx) maxIdx = idx;
        }
    });
    return aqiColors[maxIdx - 1];
}

function getGlobalAQILevel(d) {
    const pollutants = ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3'];
    let maxIdx = 1;
    pollutants.forEach(p => {
        const val = +d[p.replace('.', '_')];
        if (!isNaN(val)) {
            const idx = getAQI_Index(val, p);
            if (idx > maxIdx) maxIdx = idx;
        }
    });
    return maxIdx;
}

const seasonColors = {
    'Spring': '#2ecc71',
    'Summer': '#e67e22',
    'Autumn': '#9b59b6',
    'Winter': '#3498db'
};

function getSeason(date) {
    const month = date.getMonth(); // Get month (0-11)
    const day = date.getDate(); // Get day (1-31)
    if ((month === 2 && day >= 20) || (month > 2 && month < 5) || (month === 5 && day <= 21)) {
        return 'Spring';
    } else if ((month === 5 && day >= 21) || (month > 5 && month < 8) || (month === 8 && day <= 22)) {
        return 'Summer';
    } else if ((month === 8 && day >= 23) || (month > 8 && month < 11) || (month === 11 && day <= 21)) {
        return 'Autumn';
    } else {
        return 'Winter';
    }
}

function normalizeValue(value, min, max) {
    if (min === max) return 0.5;
    return (value - min) / (max - min);
}
// --- END AQI CONFIGURATION ---

function getDimCols() {
    if (dimensionality === "pca2") return ["PCA1", "PCA2"];
    if (dimensionality === "tsne2") return ["TSNE1", "TSNE2"];
    return ["UMAP1", "UMAP2"];
}

// Helper unificado para actualizar todo el dashboard
async function updateAll(skipMap = false) {
    const selectedCity = document.querySelector('#city-checkboxes input[type="radio"]:checked')?.value || currentFilename;
    const visualizarTodo = document.getElementById('visualizar-todo').checked;

    // Sincronizar UI de fechas
    const startInput = document.getElementById('fecha-inicio');
    const endInput = document.getElementById('fecha-fin');
    const rangeEl = document.getElementById('fecha-rango');

    if (startInput) startInput.disabled = visualizarTodo;
    if (endInput) endInput.disabled = visualizarTodo;
    if (rangeEl) rangeEl.innerText = visualizarTodo ? "Visualizando todos los datos." : "";

    const startDate = visualizarTodo ? null : startInput?.value;
    const endDate = visualizarTodo ? null : endInput?.value;

    // Actualizar variables de filtro globales para d3.csv
    startDateFilter = startDate ? new Date(startDate) : null;
    endDateFilter = endDate ? new Date(endDate) : null;

    // Sincronizar inputs secundarios de fecha (los de Cluster)
    const sdSecondary = document.getElementById('start-date');
    const edSecondary = document.getElementById('end-date');
    if (sdSecondary && startDate) sdSecondary.value = startDate;
    if (edSecondary && endDate) edSecondary.value = endDate;

    // 1. Gráficas Radiales
    if (typeof updateChart === 'function') updateChart();

    // 2. UMAPs SVG
    if (typeof updateUMAP === 'function') await updateUMAP();

    // 3. Canvases de Distribución Temporal Global
    if (typeof loadAndUpdateCharts === 'function') loadAndUpdateCharts();

    // 4. Matriz de Correlación
    if (typeof updateCorrelationMatrix === 'function') updateCorrelationMatrix();

    // 5. Marcadores del Mapa
    if (typeof updateMapMarkers === 'function' && !skipMap) await updateMapMarkers();

    // 6. Serie de Tiempo
    if (typeof updateTimeSeriesChart === 'function') {
        updateTimeSeriesChart(selectedCity, startDate, endDate);
    }

    // 7. Theme River y Correlación New (Lógica de dateList)
    let dateList = [];
    if (!visualizarTodo && startDate && endDate) {
        const pStart = startDate.split('-');
        const pEnd = endDate.split('-');
        let s = new Date(+pStart[0], +pStart[1] - 1, +pStart[2]);
        let e = new Date(+pEnd[0], +pEnd[1] - 1, +pEnd[2]);
        for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
            const year = d.getFullYear();
            const month = d.getMonth() + 1;
            const day = d.getDate();
            dateList.push(`${year}-${month}-${day}`);
        }
    }

    if (typeof drawThemeRiver === 'function') {
        try {
            await drawThemeRiver(selectedCity, dateList);
        } catch (err) {
            console.error("Error en drawThemeRiver:", err);
        }
    }

    if (typeof updateCorrelationMatrixnew === 'function') {
        updateCorrelationMatrixnew(dateList);
    }

    // 8. Distribución Espacio Temporal Global
    if (typeof updateStationBarCharts === 'function') {
        updateStationBarCharts();
    }
}

const countryCenters = {
    "China": { lat: 35.8617, lng: 104.1954, zoom: 4, geojson: 'map/CHN.geo.json' },
    "USA": { lat: 37.0902, lng: -95.7129, zoom: 4, geojson: 'map/USA.geo.json' },
    "India": { lat: 20.5937, lng: 78.9629, zoom: 5, geojson: 'map/IND.geo.json' },
    "Peru": { lat: -9.19, lng: -75.0152, zoom: 6, geojson: 'map/PER.geo.json' }
};

async function loadStationsFromTxt() {
    try {
        const response = await fetch('NEW-DATA/stations.txt');
        const text = await response.text();
        const lines = text.split('\n').filter(line => line.trim() !== '' && !line.startsWith('id,'));
        stationDataFromTxt = lines.map(line => {
            // Handle possible quotes and commas in station names
            const matches = line.match(/(".*?"|[^,]+)(?=\s*,|\s*$)/g);
            if (!matches) return null;
            const values = matches.map(v => v.replace(/^"|"$/g, '').trim());

            // Format name: title case, replace hyphens with spaces
            let formattedName = (values[1] || "").replace(/-/g, ' ')
                .split(' ')
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(' ');

            return {
                id: values[0],
                name: formattedName,
                country: values[2],
                city: values[3],
                lat: parseFloat(values[4]),
                lng: parseFloat(values[5]),
                zona: values[6] || 'Urban'
            };
        }).filter(s => s !== null);
    } catch (err) {
        console.error("Error loading stations.txt:", err);
    }
}

function generateSeasons(minDate, maxDate) {
    const startYear = new Date(minDate).getFullYear();
    const endYear = new Date(maxDate).getFullYear();
    const allRanges = [];
    const seasonData = [
        { name: 'Invierno', startMonth: 0, startDay: 1, endMonth: 2, endDay: 19 },
        { name: 'Primavera', startMonth: 2, startDay: 20, endMonth: 5, endDay: 20 },
        { name: 'Verano', startMonth: 5, startDay: 21, endMonth: 8, endDay: 22 },
        { name: 'Otoño', startMonth: 8, startDay: 23, endMonth: 11, endDay: 21 },
        { name: 'Invierno', startMonth: 11, startDay: 22, endMonth: 11, endDay: 31 }
    ];

    for (let year = startYear; year <= endYear; year++) {
        seasonData.forEach(s => {
            const start = new Date(year, s.startMonth, s.startDay);
            const end = new Date(year, s.endMonth, s.endDay);
            if (start <= new Date(maxDate) && end >= new Date(minDate)) {
                allRanges.push({ season: s.name, start, end });
            }
        });
    }
    return allRanges.sort((a, b) => a.start - b.start);
}

async function loadStationMeta() {
    try {
        await loadStationsFromTxt();
        await loadMapAqiData();
        const response = await fetch('static/station_meta.json');
        stationMeta = await response.json();

        const countrySelect = document.getElementById('country-select');
        countrySelect.addEventListener('change', (e) => {
            populateCountryStations(e.target.value);
        });

        // Initial population
        populateCountryStations('China');
    } catch (err) {
        console.error("Error loading station metadata:", err);
    }
}

function getStationNameFromCity(cityStr) {
    if (!cityStr) return 'N/A';
    const parsedCityId = cityStr.replace('Data_', '').replace('.csv', '').split('_').pop();
    const allStationObjs = (stationMeta && stationMeta.stations) ? Object.values(stationMeta.stations).flat() : [];
    const stationObj = allStationObjs.find(s => String(s.id) === String(parsedCityId));
    return stationObj ? stationObj.name : cityStr.replace('Data_', '').replace('.csv', '');
}

function populateCountryStations(country) {
    if (!stationMeta) return;
    currentCountry = country;
    const countryStations = stationMeta.stations[country] || [];
    const range = stationMeta.ranges[country];
    const averagedFile = stationMeta.averaged_files[country];
    // Update global stations list for other charts
    stations = countryStations; // Now storing the full objects {id, name, file}
    stationAbbreviations = {};
    countryStations.forEach(s => {
        stationAbbreviations[s.name] = s.name.substring(0, 3).toUpperCase();
    });

    // Update map if it exists
    if (map && countryCenters[country]) {
        map.setView([countryCenters[country].lat, countryCenters[country].lng], countryCenters[country].zoom);
        loadCountryGeoJson(countryCenters[country].geojson);
    }

    const container = document.getElementById('city-checkboxes');
    container.innerHTML = '<h4>Distritos</h4>';

    countryStations.forEach((s, index) => {
        const label = document.createElement('label');
        const checked = index === 0 ? 'checked' : '';
        if (index === 0) currentFilename = s.file;

        const txtInfo = stationDataFromTxt.find(t => t.id === s.id);
        const displayName = txtInfo ? txtInfo.name : s.name;
        const sZona = txtInfo ? txtInfo.zona : "Urban";

        const zoneColor = (sZona === "Urban") ? "#2D6A4F" :
            (sZona === "Suburban") ? "#007bff" :
                (sZona === "Rural") ? "#f39c12" :
                    (sZona === "Traffic") ? "#e74c3c" : "#9b59b6";

        label.innerHTML = `<input type="radio" name="city" value="${s.file}" ${checked}> 
            <span style="display: inline-flex; align-items: center; margin-right: 8px; vertical-align: middle;">
                ${getZoneSvg(sZona, zoneColor, 20)}
            </span>
            ${displayName}`;

        label.querySelector('input').addEventListener('change', () => {
            if (isProgrammaticSelection) return;
            currentFilename = s.file;
            updateAll(true); // Actualiza gráficas pero NO refresca todos los marcadores (evita cerrar popup)

            // Zoom to station
            if (txtInfo && txtInfo.lat && txtInfo.lng) {
                map.setView([txtInfo.lat, txtInfo.lng], 12);
                if (s.marker) {
                    updateInfoWindowContent(s.marker, s);
                }
            }
        });

        container.appendChild(label);
    });

    if (range) {
        // Set all date filters
        const ids = ['fecha-inicio', 'fecha-fin', 'start-date', 'end-date'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.min = range.min;
                el.max = range.max;
                if (el.value < range.min || el.value > range.max) el.value = (id.includes('inicio') || id.includes('start')) ? range.min : range.max;
            }
        });
    }

    // Set averaged file as current for initial global view if needed, 
    // or just trigger initial load with first station
    if (averagedFile) {
        // Option: if we want global plots to start with country average
        // currentFilename = averagedFile; 
    }

    updateAll();
    createZoneLegend();
}

async function loadCountryGeoJson(url) {
    if (geoJsonLayer) map.removeLayer(geoJsonLayer);
    try {
        const response = await fetch(url);
        const data = await response.json();
        geoJsonLayer = L.geoJSON(data, {
            style: {
                color: "#2D6A4F",
                weight: 1.5,
                fillColor: "#2D6A4F",
                fillOpacity: 0.05
            }
        }).addTo(map);
    } catch (err) {
        console.error("Error loading GeoJSON:", err);
    }
}

// Call metadata loader when DOM ready or script starts
window.addEventListener('DOMContentLoaded', () => {
    initLeafletMap();
    loadStationMeta();

    // Disparar la carga inicial de datos una vez que el mapa esté listo
    if (document.getElementById('visualizar-todo')) {
        document.getElementById('visualizar-todo').checked = true;
        document.getElementById('visualizar-todo').dispatchEvent(new Event('change'));
    }
});




function initLeafletMap() {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false
    }).setView([35.8617, 104.1954], 4);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    // flowLayer = L.layerGroup().addTo(map); // Removido
}

function updateWindDirectionAndMarkers(station, map, position, iconUrl, selectedDate = null) {
    const visualizarTodo = document.getElementById('visualizar-todo').checked;
    const fechaInicioPredeterminada = new Date(2013, 2, 1);
    const fechaFinPredeterminada = new Date(2017, 1, 28);

    let fechaInicio, fechaFin;
    if (selectedDate) {
        fechaInicio = new Date(selectedDate);
        fechaFin = new Date(selectedDate);
    } else {
        fechaInicio = visualizarTodo ? fechaInicioPredeterminada : new Date(document.getElementById('fecha-inicio').value);
        fechaFin = visualizarTodo ? fechaFinPredeterminada : new Date(document.getElementById('fecha-fin').value);
    }

    const filteredData = (station.data || []).filter(entry => {
        const entryDate = new Date(entry.year, entry.month - 1, entry.day);
        return entryDate >= fechaInicio && entryDate <= fechaFin;
    });

    let totalWD = 0, count = 0;
    filteredData.forEach(entry => {
        const wd = parseFloat(entry.wd);
        if (!isNaN(wd)) { totalWD += wd; count++; }
    });

    const averageWD = count > 0 ? totalWD / count : 0;

    // Leaflet Marker
    const icon = L.icon({
        iconUrl: iconUrl,
        iconSize: [25, 25],
        iconAnchor: [12, 12]
    });

    const marker = L.marker([position.lat, position.lng], { icon: icon }).addTo(markerLayer);

    // Tooltip
    marker.bindTooltip(`<strong>${station.name}</strong>`, { direction: 'top', offset: [0, -10] });

    // Popup
    marker.on('click', () => {
        updateInfoWindowContent(marker, station);
    });

    station.marker = marker;
}



// Función para inicializar el mapa de Beijing con Google Maps
async function loadMapAqiData() {
    try {
        const response = await fetch('data/Data_Map_AQI_Day.csv');
        const csvData = await response.text();
        mapAqiData = parseCSV(csvData);
    } catch (err) {
        console.error("Error loading map AQI data:", err);
    }
}

async function updateMapMarkers() {
    if (!map) return;

    if (markerLayer) markerLayer.clearLayers();
    else markerLayer = L.layerGroup().addTo(map);

    // if (flowLayer) flowLayer.clearLayers();
    // else flowLayer = L.layerGroup().addTo(map);

    // Filtros de fecha
    const startInput = document.getElementById('fecha-inicio');
    const endInput = document.getElementById('fecha-fin');
    const visualizarTodo = document.getElementById('visualizar-todo').checked;

    const startDate = visualizarTodo ? null : (startInput?.value ? new Date(startInput.value) : null);
    const endDate = visualizarTodo ? null : (endInput?.value ? new Date(endInput.value) : null);

    const country = currentCountry;
    await loadMeteoForCountry(country);
    const meteoCache = meteoDataCache[country] || {};

    const rangeStr = (startDate && endDate) ? `${formatDateSpanish(startDate)} a ${formatDateSpanish(endDate)}` : "Rango Global";

    const markerPromises = stations.map(async s => {
        // Usar los metadatos de stationMeta si están disponibles
        const txtInfo = stationDataFromTxt.find(t => t.id === s.id);
        if (txtInfo) {
            s.lat = txtInfo.lat;
            s.lng = txtInfo.lng;
            s.name = txtInfo.name;
            s.zona = txtInfo.zona;
        }

        if (!s.lat || !s.lng) return;

        // Cargar data para calcular AQI promedio y viento
        try {
            const data = await loadStationData(s.file);
            const filtered = data.filter(d => {
                const date = new Date(+d.year, +d.month - 1, +d.day);
                if (!startDate || !endDate) return true;
                return date >= startDate && date <= endDate;
            });

            if (filtered.length === 0) return;

            let totalAQILevel = 0;
            let totalWSPM = 0;
            let totalSin = 0;
            let totalCos = 0;
            let mCount = 0;

            filtered.forEach(d => {
                // getGlobalAQILevel calcula el índice (1-6) basado en el MAX de contaminantes
                totalAQILevel += getGlobalAQILevel(d);

                const dateKey = `${+d.year}-${+d.month}-${+d.day}`;
                const cacheKey = `${s.id}_${dateKey}`;
                const meteo = meteoCache[cacheKey];
                if (meteo) {
                    totalWSPM += meteo.WSPM;
                    // Promedio vectorial para dirección del viento
                    const rad = meteo.WD * Math.PI / 180;
                    totalSin += Math.sin(rad);
                    totalCos += Math.cos(rad);
                    mCount++;
                }
            });

            const avgAQILevel = totalAQILevel / filtered.length;
            const avgWSPM = mCount > 0 ? totalWSPM / mCount : 0;

            let avgWD = 0;
            if (mCount > 0) {
                avgWD = Math.atan2(totalSin / mCount, totalCos / mCount) * 180 / Math.PI;
                if (avgWD < 0) avgWD += 360;
            }

            const icon = createCustomIcon(s.zona || "Urban", avgAQILevel, avgWD);
            const marker = L.marker([s.lat, s.lng], { icon: icon }).addTo(markerLayer);

            const aqiText = ["Excelente", "Bueno", "Moderado", "Pobre", "Insalubre", "Peligroso"][Math.round(avgAQILevel) - 1] || "N/A";


            marker.on('click', () => {
                updateInfoWindowContent(marker, s);
            });

            s.marker = marker;
            s.avgAQI = avgAQILevel;
            s.avgWSPM = avgWSPM;
            s.avgWD = avgWD;
        } catch (err) {
            console.error(`Error procesando marcador para estación ${s.name}:`, err);
        }
    });

    await Promise.all(markerPromises);

    // Generar el campo de flujo de viento (Opcional - Removido por pedido del usuario)
    /*
    const validStations = stations.filter(s => s.avgWD !== undefined && s.lat && s.lng);
    if (validStations.length > 0) {
        updateWindFlowField(validStations);
    }
    */
}

function updateWindFlowField(stationsWithMeteo) {
    if (!flowLayer) return;
    flowLayer.clearLayers();

    // 1. Obtener límites geográficos para la malla (grid)
    const lats = stationsWithMeteo.map(s => s.lat);
    const lngs = stationsWithMeteo.map(s => s.lng);

    const minLat = Math.min(...lats) - 0.4;
    const maxLat = Math.max(...lats) + 0.4;
    const minLng = Math.min(...lngs) - 0.4;
    const maxLng = Math.max(...lngs) + 0.4;

    // 2. Definir densidad de la malla (más densa 'apegada')
    const steps = 25; // 25x25 grid
    const latStep = (maxLat - minLat) / steps;
    const lngStep = (maxLng - minLng) / steps;

    for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps; j++) {
            const pLat = minLat + i * latStep;
            const pLng = minLng + j * lngStep;

            // 3. Filtrado por proximidad (solo mostrar flujo cerca de estaciones)
            let minDist = Infinity;
            stationsWithMeteo.forEach(s => {
                const dist = Math.sqrt(Math.pow(pLat - s.lat, 2) + Math.pow(pLng - s.lng, 2));
                if (dist < minDist) minDist = dist;
            });

            // Si está muy lejos de cualquier estación, no mostramos flecha (evitar extrapolación)
            if (minDist > 0.4) continue;

            let sumSin = 0;
            let sumCos = 0;
            let sumW = 0;

            stationsWithMeteo.forEach(s => {
                const dist = Math.sqrt(Math.pow(pLat - s.lat, 2) + Math.pow(pLng - s.lng, 2));
                if (dist < 0.001) {
                    const rad = s.avgWD * Math.PI / 180;
                    sumSin = Math.sin(rad);
                    sumCos = Math.cos(rad);
                    sumW = 1;
                    return;
                }
                // IDW con peso que decae rápido
                const weight = 1 / Math.pow(dist, 2);
                const rad = s.avgWD * Math.PI / 180;
                sumSin += Math.sin(rad) * weight;
                sumCos += Math.cos(rad) * weight;
                sumW += weight;
            });

            if (sumW > 0) {
                const interpWD = Math.atan2(sumSin / sumW, sumCos / sumW) * 180 / Math.PI;
                const finalWD = (interpWD + 360) % 360;

                // 4. Crear micro-flecha de flujo (Más grande y opaca)
                const flowIcon = L.divIcon({
                    className: 'field-flow-arrow',
                    html: `
                        <svg width="25" height="25" viewBox="0 0 100 100" style="overflow:visible">
                            <g transform="translate(50,50) rotate(${finalWD})">
                                <path d="M 0,18 L 0,-18" stroke="#00a8cc" stroke-width="8" stroke-linecap="round" opacity="0.35" />
                                <path d="M -10,0 L 0,-21 L 10,0" fill="none" stroke="#00a8cc" stroke-width="8" stroke-linecap="round" opacity="0.35" />
                            </g>
                        </svg>
                    `,
                    iconSize: [25, 25],
                    iconAnchor: [12.5, 12.5]
                });

                L.marker([pLat, pLng], { icon: flowIcon, interactive: false, zIndexOffset: -100 }).addTo(flowLayer);
            }
        }
    }
}

let stationRawDataCache = {};
async function loadStationData(file) {
    if (stationRawDataCache[file]) return stationRawDataCache[file];
    const data = await d3.csv(`${getFusionPath()}${file}`);
    stationRawDataCache[file] = data;
    return data;
}

let ColorAqiglobal = null;

function updateInfoWindowContent(marker, station) {
    const visualizarTodo = document.getElementById('visualizar-todo')?.checked ?? false;
    const startInput = document.getElementById('fecha-inicio');
    const endInput = document.getElementById('fecha-fin');

    const fechaInicio = visualizarTodo ? null : (startInput?.value ? new Date(startInput.value) : null);
    const fechaFin = visualizarTodo ? null : (endInput?.value ? new Date(endInput.value) : null);

    // Priorizar los promedios ya calculados en el objeto de la estación
    const avgAQI = station.avgAQI !== undefined ? station.avgAQI : 0;
    const avgWSPM = station.avgWSPM !== undefined ? station.avgWSPM : 0;
    const avgWD = station.avgWD !== undefined ? station.avgWD : 0;

    const windDirectionText = getWindDirectionText(avgWD);
    const aqiColor = aqiColors[Math.round(avgAQI) - 1] || '#ccc';
    const aqiLevelText = ["Excelente", "Bueno", "Moderado", "Pobre", "Insalubre", "Peligroso"][Math.round(avgAQI) - 1] || "N/A";

    const rangeStr = (fechaInicio && fechaFin) ? `${formatDateSpanish(fechaInicio)} a ${formatDateSpanish(fechaFin)}` : "Rango Global";

    const content = `
    <div style="font-family: inherit; padding: 10px; line-height:1.4; min-width:200px;">
        <strong style="font-size: 15px; color: #1a73e8; display: block; margin-bottom: 8px; border-bottom: 1px solid #eee; padding-bottom:4px;">${station.name}</strong>
        <div style="margin-bottom: 8px;">
            <strong>AQI (Máx):</strong> 
            <span style="background-color: ${aqiColor}; color: #000; padding: 2px 6px; border-radius: 4px; font-weight:bold; font-size:13px;">
                ${Math.round(avgAQI)}
            </span>
        </div>
        <p style="margin: 4px 0;"><strong>Velocidad Viento:</strong> ${avgWSPM.toFixed(2)} m/s</p>
        <p style="margin: 4px 0;"><strong>Dirección del viento:</strong> ${windDirectionText}</p>
        <p style="margin: 4px 0;"><strong>Zona:</strong> ${station.zona || "Urban"}</p>
        <div style="margin-top: 12px; padding-top: 8px; border-top: 1px solid #eee; font-size: 10px; color: #666; font-style: italic;">
            Periodo: ${rangeStr}
        </div>
    </div>`;

    marker.unbindPopup();
    marker.bindPopup(content, {
        maxWidth: 320,
        className: 'custom-station-popup',
        offset: [0, -35]
    }).openPopup();

    selectCityCheckbox(station.id);
}


function selectCityCheckbox(city) {
    const newCity = `Data_${city.charAt(0).toUpperCase() + city.slice(1)}.csv`;
    const checkbox = document.querySelector(`input[name="city"][value="${newCity}"]`);
    if (checkbox) {
        isProgrammaticSelection = true;
        checkbox.checked = true;
        isProgrammaticSelection = false;

        currentFilename = newCity;
        updateAll(true); // Actualiza gráficas sin recrear marcadores del mapa
    }
}

function calculateAverages(station, fechaInicio, fechaFin) {
    if (!station.data) return { averageAQI: 0, averageWSPM: 0, averageWD: 0 };

    const startDate = new Date(fechaInicio);
    const endDate = new Date(fechaFin);
    let totalAQI = 0, totalWSPM = 0, totalWD = 0, count = 0;

    station.data.forEach(entry => {
        const entryDate = new Date(entry.year, entry.month - 1, entry.day);
        if (entryDate >= startDate && entryDate <= endDate) {
            totalAQI += parseFloat(entry.AQI || 0);
            totalWSPM += parseFloat(entry.WSPM || 0);
            if (entry.wd) totalWD = parseFloat(entry.wd);
            count++;
        }
    });

    return {
        averageAQI: count ? totalAQI / count : 0,
        averageWSPM: count ? totalWSPM / count : 0,
        averageWD: totalWD
    };
}

function getZoneStyles(category) {
    const styles = {
        "Urban": { color: "#2D6A4F", shape: "triangle" },
        "Suburban": { color: "#007bff", shape: "square" },
        "Rural": { color: "#f39c12", shape: "star" },
        "Traffic": { color: "#e74c3c", shape: "circle" }
    };
    return styles[category] || { color: "#9b59b6", shape: "hexagon" };
}

function getZoneSvg(category, fillColor = "#666", size = 15, innerColor = "#eee", arrowDegrees = null) {
    let shape = "";
    const isMapIcon = arrowDegrees !== null && !isNaN(arrowDegrees);

    // Si es para el mapa (con flecha), bajamos el icono (150 alto)
    // Si es para UI (lista/leyenda), lo centramos normales (100 alto)
    const transform = isMapIcon ? "translate(10, 60) scale(0.8)" : "translate(10, 10) scale(0.8)";
    const viewBox = isMapIcon ? "0 0 100 150" : "0 0 100 100";
    const height = isMapIcon ? size * 1.5 : size;

    let innerPoint = `<circle cx="50" cy="50" r="12" fill="${innerColor}" stroke="white" stroke-width="3" transform="${transform}"/>`;

    if (category === "Urban") {
        shape = `<polygon points="50,15 85,85 15,85" fill="${fillColor}" stroke="black" stroke-width="5" transform="${transform}"/>`;
        innerPoint = `<circle cx="50" cy="62" r="12" fill="${innerColor}" stroke="white" stroke-width="3" transform="${transform}"/>`;
    } else if (category === "Suburban") {
        shape = `<rect x="15" y="15" width="70" height="70" fill="${fillColor}" stroke="black" stroke-width="5" transform="${transform}"/>`;
    } else if (category === "Rural") {
        shape = `<polygon points="50,5 63,38 98,38 70,59 81,92 50,72 19,92 30,59 2,38 37,38" fill="${fillColor}" stroke="black" stroke-width="5" transform="${transform}"/>`;
    } else if (category === "Traffic") {
        shape = `<circle cx="50" cy="50" r="40" fill="${fillColor}" stroke="black" stroke-width="5" transform="${transform}"/>`;
    } else {
        shape = `<polygon points="50,5 90,25 90,75 50,95 10,75 10,25" fill="${fillColor}" stroke="black" stroke-width="5" transform="${transform}"/>`;
    }

    let arrow = "";
    if (isMapIcon) {
        arrow = `<g transform="translate(50, 30) rotate(${arrowDegrees})">
                    <path d="M 0,18 L 0,-24" stroke="black" stroke-width="12" stroke-linecap="round" />
                    <path d="M -14,-7 L 0,-27 L 14,-7" fill="none" stroke="black" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" />
                    <path d="M 0,16 L 0,-22" stroke="#00a8cc" stroke-width="8" stroke-linecap="round" />
                    <path d="M -12,-6 L 0,-25 L 12,-6" fill="none" stroke="#00a8cc" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" />
                 </g>`;
    }

    return `<svg width="${size}" height="${height}" viewBox="${viewBox}" style="overflow: visible; vertical-align: middle;">
        ${shape}
        ${innerPoint}
        ${arrow}
    </svg>`;
}
function createCustomIcon(category, averageAQI_Level, windDegrees = null) {
    // averageAQI_Level is 1-6
    const aqiColor = aqiColors[Math.round(averageAQI_Level) - 1] || '#ccc';

    const style = getZoneStyles(category);
    const svgHtml = getZoneSvg(category, style.color, 30, aqiColor, windDegrees); // Ancho 30

    return L.divIcon({
        className: 'custom-div-icon',
        html: svgHtml,
        iconSize: [30, 45], // Altura ampliada (30 * 1.5)
        iconAnchor: [15, 45] // El ancla es el centro inferior del icono principal
    });
}


function createZoneLegend() {
    let legendContainer = document.getElementById('zone-legend');
    if (!legendContainer) {
        const dashboard = document.getElementById('dashboard');
        legendContainer = document.createElement('div');
        legendContainer.id = 'zone-legend';
        legendContainer.style.background = 'rgba(255,255,255,0.9)';
        legendContainer.style.padding = '8px';
        legendContainer.style.marginBottom = '10px';
        legendContainer.style.borderRadius = '5px';
        legendContainer.style.display = 'flex';
        legendContainer.style.flexDirection = 'column'; // Vertical list
        legendContainer.style.gap = '5px';
        legendContainer.style.border = '1px solid #ddd';
        legendContainer.style.fontSize = '11px';
        dashboard.insertBefore(legendContainer, dashboard.firstChild);
    }

    const zones = [
        { name: 'Urban (Urbana)', color: "#2D6A4F", category: "Urban" },
        { name: 'Suburban (Suburbana)', color: "#007bff", category: "Suburban" },
        { name: 'Rural (Intermedio)', color: "#f39c12", category: "Rural" },
        { name: 'Traffic (Tráfico)', color: "#e74c3c", category: "Traffic" }
    ];

    legendContainer.innerHTML = `<div style="font-weight:bold; color:#2D6A4F; margin-bottom:8px; border-bottom:1px solid #ddd; font-size:12px;">Leyenda de Zonas</div>` +
        zones.map(z => `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:5px;">
            ${getZoneSvg(z.category, z.color, 20)}
            <span style="font-size:11px;">${z.name}</span>
        </div>
    `).join('') +
        `<div style="font-size:9px; color:#666; margin-top:5px; border-top:1px solid #eee; padding-top:2px;">Centro del icono indica nivel AQI</div>`;
}

// Function to handle map updates when dates change
function updateStationInfoWindows() {
    // In Leaflet, popups are managed differently. We can just refresh markers if needed.
    // However, if a popup is open, we might want to update its content.
    const openPopup = map._popup;
    if (openPopup && openPopup._source && openPopup._source.stationData) {
        updateInfoWindowContent(openPopup._source, openPopup._source.stationData);
    }
}
// Función para seleccionar el checkbox de la ciudad correspondiente
function selectCityCheckbox(city) {
    const newCity = `Data_${city.charAt(0).toUpperCase() + city.slice(1)}.csv`;
    // console.log(newCity);
    const checkbox = document.querySelector(`input[name="city"][value="${newCity}"]`);
    if (checkbox) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));

    }
}
// Función para parsear CSV a objetos organizados por estación
function parseCSV(data) {
    const lines = data.split('\n');
    const headers = lines[0].split(',');
    const stations = {};

    for (let i = 1; i < lines.length; i++) {
        const currentline = lines[i].split(',');
        if (currentline.length === headers.length) {
            const entry = {};
            headers.forEach((header, index) => {
                entry[header.trim()] = currentline[index].trim();
            });

            const stationId = entry.stationId;
            if (!stations[stationId]) {
                stations[stationId] = {
                    stationId: stationId,
                    latitude: parseFloat(entry.latitude),
                    longitude: parseFloat(entry.longitude),
                    Notes: entry.Notes,
                    data: []
                };
            }
            stations[stationId].data.push(entry);
        }
    }

    return Object.values(stations);
}

///////////////GRAFICA  RADIAL DE SERIE TEMPORAL.


// Los listeners de distritos se gestionan en populateCountryStations


// Escuchar cambios en los checkboxes 
document.querySelectorAll('.options-chek input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updateAll);
});

// Escuchar cambios en el rango de fechas
document.getElementById('fecha-inicio').addEventListener('change', updateAll);
document.getElementById('fecha-fin').addEventListener('change', updateAll);

document.getElementById('visualizar-todo').addEventListener('change', updateAll);

// El estado inicial se gestiona en el evento DOMContentLoaded al inicio del script


// Modificar la función updateChart para la gráfica radial
function updateChart() {
    const selectedCities = Array.from(document.querySelectorAll('#city-checkboxes input[type="radio"]:checked'))
        .map(cb => cb.value);
    const selectedAttributes = Array.from(document.querySelectorAll('.options-chek input[type="checkbox"]:checked'))
        .map(cb => cb.value);

    const startDate = document.getElementById('fecha-inicio').value;
    const endDate = document.getElementById('fecha-fin').value;

    if (selectedCities.length === 0 || selectedAttributes.length === 0) return;

    selectedCities.forEach(selectedCity => {
        d3.csv(`${getFusionPath()}${selectedCity}`).then(data => {
            // ENRIQUECER CON DATOS METEOROLÓGICOS (CRUCIAL PARA PRES Y RAIN)
            const country = currentCountry;
            data = enrichWithMeteoCache(data, country);

            const visualizarTodo = document.getElementById('visualizar-todo').checked;
            if (!visualizarTodo && startDate && endDate) {
                const s = new Date(startDate);
                const e = new Date(endDate);
                data = data.filter(d => {
                    const date = new Date(d.year, d.month - 1, d.day);
                    return date >= s && date <= e;
                });
            }

            const parsedData = d3.groups(data, d => `${d.year}-${d.month}-${d.day}`).map(([date, entries]) => {
                const avg = {};
                selectedAttributes.forEach(attr => {
                    const values = entries.map(d => {
                        const val = +d[attr.replace('.', '_')];
                        return isNaN(val) ? +d[attr] : val;
                    }).filter(v => {
                        const isInvalidVal = (attr === 'PRES' || attr === 'DEWP') && v === 0;
                        return !isNaN(v) && isFinite(v) && !isInvalidVal;
                    });

                    // IMPORTANTE: Si no hay valores, usar NaN para que la línea no baje a 0 (Sincronizado con Serie de Tiempo)
                    avg[attr] = values.length > 0 ? d3.mean(values) : NaN;
                });
                avg.date = date;
                avg.year = entries[0].year;
                avg.month = entries[0].month;
                avg.day = entries[0].day;
                return avg;
            });

            drawRadialChart(parsedData, selectedAttributes);
        });
    });
}
// Colores definidos para cada atributo (Sincronizado con Serie de Tiempo y Meteorología)
const attributeColors = {
    'PM2_5': '#FF0000',
    'PM10': '#FF9900',
    'SO2': '#FFD700',
    'NO2': '#d500f1',
    'CO': '#00CED1',
    'O3': '#0000FF',
    'TEMP': '#008000',
    'PRES': '#8B0000',
    'DEWP': '#4B0082',
    'RAIN': '#1E90FF',
    'WSPM': '#7f8c8d',
    'WD': '#95a5a6'
};

function drawRadialChart(data, attributes) {
    d3.select('#chart-view-radial').html("");
    const width = 500;
    const height = 490;
    const radius = Math.min(width, height) / 2 - 40;

    // Crear el SVG y el grupo principal
    const svg = d3.select('#chart-view-radial')
        .append('svg')
        .attr('width', width)
        .attr('height', height);

    const chartGroup = svg.append('g')
        .attr('transform', `translate(${width / 2}, ${height / 2})`);

    // Escala para los ángulos
    const angleScale = d3.scaleLinear().domain([0, data.length]).range([0, -2 * Math.PI]);

    // Obtener los valores máximos de cada atributo
    const maxValues = attributes.map(attr => d3.max(data, d => d[attr]));
    const centralHoleRadius = 30;
    const ringWidth = (radius - centralHoleRadius) / attributes.length;

    // Definir los colores para las estaciones
    const seasonColors = {
        'Spring': '#2ca25f',
        'Summer': '#d95f0e',
        'Autumn': '#7570b3',
        'Winter': '#1f78b4',
        'YearRound': '#6a3d9a'
    };

    // Función para obtener la estación en base a la fecha
    function getSeason(month, day) {
        if ((month === 3 && day >= 20) || (month > 3 && month < 6) || (month === 6 && day <= 21)) {
            return 'Spring';
        } else if ((month === 6 && day >= 21) || (month > 6 && month < 9) || (month === 9 && day <= 22)) {
            return 'Summer';
        } else if ((month === 9 && day >= 22) || (month > 9 && month < 12) || (month === 12 && day <= 21)) {
            return 'Autumn';
        } else {
            return 'Winter';
        }
    }

    attributes.forEach((attr, index) => {
        // Calcular min y max para cada atributo (Zoom de fluctuaciones)
        const attrValues = data.map(d => d[attr]).filter(v => !isNaN(v));
        let minVal = d3.min(attrValues) || 0;
        let maxVal = d3.max(attrValues) || 1;

        // Ajuste especial para PRES: No empezar en 0 para ver fluctuaciones igual que en Serie de Tiempo
        if (attr === 'PRES' && minVal > 900) {
            // Mantener rango estrecho para maximizar visualización de cambios
        } else if (['RAIN', 'CO', 'SO2', 'NO2', 'PM2_5', 'PM10', 'O3'].includes(attr)) {
            minVal = 0; // Para contaminantes y lluvia empezamos en 0
        }

        let radialScale;
        if (attr === 'RAIN' || attr === 'PRECIPITACION') {
            // Escala raíz cuadrada para lluvia para ver mejor valores pequeños igual que en drawRadialChart2
            radialScale = d3.scaleSqrt()
                .domain([minVal, maxVal])
                .range([centralHoleRadius + index * ringWidth, centralHoleRadius + (index + 1) * ringWidth]);
        } else {
            radialScale = d3.scaleLinear()
                .domain([minVal, maxVal])
                .range([centralHoleRadius + index * ringWidth, centralHoleRadius + (index + 1) * ringWidth]);
        }

        chartGroup.append("circle").attr("cx", 0).attr("cy", 0)
            .attr("r", radialScale(maxVal)).attr("fill", "none")
            .attr("stroke", "#000").attr("stroke-width", 1)
            .attr("stroke-dasharray", "3,3");

        const line = d3.lineRadial()
            .angle((d, j) => angleScale(j))
            .radius(d => radialScale(d[attr]))
            .defined(d => !isNaN(d[attr])); // Saltar puntos sin datos

        // Color para la línea
        const lineColor = attributeColors[attr] || '#000';  // Si no está definido, asigna un color por defecto

        chartGroup.append('path').datum(data)
            .attr('fill', 'none')
            .attr('stroke', lineColor)
            .attr('stroke-width', 1.5)
            .attr('d', line);

        chartGroup.append('text')
            .attr('x', 0)
            .attr('y', -radialScale(maxValues[index]) - 10)
            .attr('dy', '-0.5em')
            .attr('text-anchor', 'middle')
            .attr('font-size', '14px')
            .attr('font-weight', 'bold')
            .text(attr);

        data.forEach((d, i) => {
            const season = getSeason(+d.month, +d.day);
            const seasonColor = seasonColors[season];
            const startAngle = angleScale(i);
            const endAngle = angleScale(i + 1);
            const pathArc = d3.arc()
                .innerRadius(centralHoleRadius + index * ringWidth)
                .outerRadius(radialScale(maxValues[index]))
                .startAngle(startAngle)
                .endAngle(endAngle);

            chartGroup.append('path')
                .attr('d', pathArc)
                .attr('fill', seasonColor)
                .attr('opacity', 0.3);
        });
    });

    // // Funcionalidad de zoom
    // const zoom = d3.zoom()
    //               .scaleExtent([0.5, 5])  // Rango de escala permitido
    //               .on('zoom', (event) => {
    //                   chartGroup.attr('transform', event.transform);
    //               });

    // svg.call(zoom);  // Aplica el zoom al SVG

    // Agregar etiquetas dinámicas de tiempo (meses o días)
    const timeSpan = (new Date(data[data.length - 1].date) - new Date(data[0].date)) / (1000 * 60 * 60 * 24);
    const isMonthly = timeSpan > 30;
    const isYearly = timeSpan > 365;

    const displayedLabels = new Set();  // Para evitar etiquetas repetidas

    data.forEach((d, i) => {
        const angle = angleScale(i);
        const x = Math.sin(angle) * (radius + 10);
        const y = -Math.cos(angle) * (radius + 10);

        let label;
        let labelKey;
        if (isYearly) {
            label = d3.timeFormat('%Y')(new Date(d.date));
            labelKey = `year-${label}`;
        } else if (isMonthly) {
            label = d3.timeFormat('%b')(new Date(d.date)); // Mes
            labelKey = `month-${label}`;
        } else {
            label = d3.timeFormat('%d %b')(new Date(d.date)); // Día y Mes
            labelKey = `day-${label}`;
        }

        // Mostrar solo si la etiqueta aún no se ha agregado
        if (!displayedLabels.has(labelKey)) {
            chartGroup.append('text')
                .attr('x', x)
                .attr('y', y)
                .attr('dy', '0.35em')
                .attr('text-anchor', 'middle')
                .attr('font-size', '10px')
                .text(label);
            displayedLabels.add(labelKey);  // Marca la etiqueta como mostrada
        }
    });
}


// GRAFICAS RADIALES POR SELECCION EN LA GRAFICA DE DISTRIBUCION
function updateRadialChartWithSelection(selectionData, fechaInicio, fechaFin) {
    if (!selectionData || selectionData.length === 0) return;

    // Obtener atributos chequeados
    const attributes = Array.from(document.querySelectorAll('.options-chek input[type="checkbox"]:checked'))
        .map(cb => cb.value);
    // Si no hay atributos checkeados, usar los contaminantes por defecto
    const activeAttrs = attributes.length > 0
        ? attributes
        : ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3', 'TEMP', 'PRES', 'DEWP', 'RAIN', 'WSPM', 'WD'];

    // Enriquecer con Datos Meteorológicos (FUNDAMENTAL para que PRES y RAIN existan en la selección)
    selectionData = enrichWithMeteoCache(selectionData, currentCountry);

    // Usar directamente los datos ya en memoria
    // Agrupar por fecha usando el objeto Date (no las strings year/month/day)
    const aggregatedData = d3.groups(selectionData, d => {
        const date = d.date instanceof Date ? d.date : new Date(+d.year, +d.month - 1, +d.day);
        return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
    }).map(([dateKey, entries]) => {
        const avg = { date: dateKey };
        activeAttrs.forEach(attr => {
            const key = attr.replace('.', '_');
            const values = entries
                .map(d => d[key] !== undefined ? +d[key] : (d[attr] !== undefined ? +d[attr] : NaN))
                .filter(v => {
                    const isInvalidZero = (attr === 'PRES' || attr === 'DEWP') && v === 0;
                    return !isNaN(v) && isFinite(v) && !isInvalidZero;
                });
            avg[attr] = values.length > 0 ? d3.mean(values) : NaN;
        });
        return avg;
    });

    if (aggregatedData.length === 0) {
        console.warn('updateRadialChartWithSelection: no aggregated data');
        return;
    }

    drawRadialChart2(aggregatedData, activeAttrs, fechaInicio, fechaFin);
}


function drawRadialChart2(data, attributes, fechaInicio, fechaFin) {

    d3.select('#chart-view-radial').html("");
    const width = 500;
    const height = 490;
    const radius = Math.min(width, height) / 2 - 40;
    const svg = d3.select('#chart-view-radial')
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2}, ${height / 2})`);

    const centralHoleRadius = 30;
    const ringWidth = (radius - centralHoleRadius) / attributes.length;

    // Tooltip para mostrar información
    const tooltip = d3.select("body").append("div")
        .style("position", "absolute")
        .style("background", "#f9f9f9")
        .style("padding", "10px")
        .style("border", "1px solid #ccc")
        .style("border-radius", "5px")
        .style("box-shadow", "0px 0px 10px rgba(0, 0, 0, 0.1)")
        .style("display", "none")
        .style("pointer-events", "none")
        .style("font-size", "12px");

    const seasonColors = {
        'Spring': '#2ca25f',
        'Summer': '#d95f0e',
        'Autumn': '#7570b3',
        'Winter': '#1f78b4',
        'YearRound': '#6a3d9a'
    };


    // Obtener rango completo de fechas
    const dateExtent = d3.extent(data, d => new Date(d.date));
    const fullDateRange = d3.timeDay.range(dateExtent[0], d3.timeDay.offset(dateExtent[1], 1));

    // Escala angular para cubrir todas las fechas
    const angleScale = d3.scaleTime().domain(dateExtent).range([0, -2 * Math.PI]);

    // Dibujar fondo por estaciones
    const generateSeasonRanges = (year) => [
        { season: 'Spring', start: new Date(year, 2, 20), end: new Date(year, 5, 21) },
        { season: 'Summer', start: new Date(year, 5, 21), end: new Date(year, 8, 22) },
        { season: 'Autumn', start: new Date(year, 8, 23), end: new Date(year, 11, 21) },
        { season: 'Winter', start: new Date(year, 11, 21), end: new Date(year + 1, 2, 20) }
    ];

    const allSeasonRanges = [];
    for (let year = dateExtent[0].getFullYear() - 1; year <= dateExtent[1].getFullYear() + 1; year++) {
        allSeasonRanges.push(...generateSeasonRanges(year));
    }

    allSeasonRanges.forEach(({ season, start, end }) => {
        if (start < dateExtent[0]) start = dateExtent[0];
        if (end > dateExtent[1]) end = dateExtent[1];
        if (start >= end) return;

        const startAngle = angleScale(start);
        const endAngle = angleScale(end);

        svg.append('path')
            .attr('d', d3.arc()
                .innerRadius(centralHoleRadius)
                .outerRadius(radius)
                .startAngle(startAngle)
                .endAngle(endAngle))
            .attr('fill', seasonColors[season])
            .attr('opacity', 0.3)
            .attr('class', `season-${season.replace(/\s+/g, '-')}`) // Clase específica para la estación
            .on("click", function (event) {
                const clickedSeason = season;
                const selectedDates = data.filter(d => getSeason(new Date(d.date)) === clickedSeason)
                    .map(d => d.date);

                // Verificar si hay fechas seleccionadas
                if (selectedDates.length === 0) {
                    // console.log(`No hay datos para la estación ${clickedSeason}.`);
                    return; // No hacer nada si no hay datos
                }

                // console.log(`Fechas en la estación ${clickedSeason}:`, selectedDates);

                // Limpiar selecciones previas
                svg.selectAll('path').classed('selected', false);

                // Resaltar la selección
                svg.selectAll(`.season-${clickedSeason.replace(/\s+/g, '-')}`).classed('selected', true);

                // Obtener la ciudad seleccionada
                const selectedCity = document.querySelector('#city-checkboxes input[type="radio"]:checked').value;

                // Actualizar la gráfica de series temporales con las fechas seleccionadas
                updateTimeSeriesChart(selectedCity, fechaInicio, fechaFin, selectedDates);
                // console.log(selectedDates)
                updateCorrelationMatrixnew(selectedDates);
                drawThemeRiver(selectedCity, selectedDates); // Riverplot basado en fechas
                // plotUMAP(filteredData, fechaInicio, fechaFin); // UMAP con datos filtrados

                // console.log("datos",selectedData)
                console.log("Fecha incio", fechaInicio)
                console.log("fecha fin", fechaFin)


            });
    });

    // Agregar líneas de corte en el 31 de diciembre de cada año
    const years = d3.timeYear.range(dateExtent[0], d3.timeYear.offset(dateExtent[1], 1));
    years.forEach(year => {
        const dec31 = new Date(year, 11, 31);
        const dec31Angle = angleScale(dec31);

        svg.append('line')
            .attr('x1', Math.sin(dec31Angle) * centralHoleRadius)
            .attr('y1', -Math.cos(dec31Angle) * centralHoleRadius)
            .attr('x2', Math.sin(dec31Angle) * radius)
            .attr('y2', -Math.cos(dec31Angle) * radius)
            .attr('stroke', '#000')
            .attr('stroke-width', 2)
            .attr('stroke-dasharray', '4,4');
    });

    // Obtener valores de rango por atributo
    const attrRanges = attributes.map(attr => {
        const values = data.map(d => d[attr]).filter(v => {
            const isInvalidZero = (attr === 'PRES' || attr === 'DEWP' || attr === 'BAR') && v === 0;
            return v !== null && !isNaN(v) && !isInvalidZero;
        });
        return values.length > 0 ? d3.extent(values) : [0, 1];
    });

    attributes.forEach((attr, index) => {
        let [minVal, maxVal] = attrRanges[index];

        // Ajuste especial para PRES (Presión): No empezar en 0 para ver fluctuaciones
        // Sincronizar con Serie de Tiempo: El rango debe ocupar todo el espacio disponible del anillo
        if (attr === 'PRES' && minVal > 900) {
            // No agregamos padding extra para que las fluctuaciones sean máximas como en la serie temporal
            minVal = minVal;
            maxVal = maxVal;
        } else if (attr === 'RAIN' || attr === 'PRECIPITACION') {
            // Para lluvia, solemos empezar en 0
            minVal = 0;
        } else {
            // Pollutants and others: start at 0
            minVal = 0;
        }

        let radialScale;
        if (attr === 'RAIN' || attr === 'PRECIPITACION') {
            // Escala raíz cuadrada para lluvia para ver mejor valores pequeños (0.5, 1.0, etc)
            radialScale = d3.scaleSqrt()
                .domain([minVal, maxVal])
                .range([centralHoleRadius + index * ringWidth, centralHoleRadius + (index + 1) * ringWidth]);
        } else {
            radialScale = d3.scaleLinear()
                .domain([minVal, maxVal])
                .range([centralHoleRadius + index * ringWidth, centralHoleRadius + (index + 1) * ringWidth]);
        }

        // Círculos de referencia
        svg.append("circle")
            .attr("cx", 0).attr("cy", 0)
            .attr("r", radialScale(maxVal))
            .attr("fill", "none")
            .attr("stroke", "#000")
            .attr("stroke-width", 1)
            .attr("stroke-dasharray", "3,3");

        // Dibujar datos
        let previousDate = null;
        data.forEach((d, i) => {
            const date = new Date(d.date);
            const value = d[attr];

            // Si el valor es NaN, no dibujamos punto ni línea
            if (isNaN(value)) {
                previousDate = null;
                return;
            }

            const angle = angleScale(date);
            const radiusValue = radialScale(value);

            const x = Math.sin(angle) * radiusValue;
            const y = -Math.cos(angle) * radiusValue;

            const circle = svg.append('circle')
                .attr('cx', x)
                .attr('cy', y)
                .attr('r', 1.5) // Puntos más pequeños
                .attr('fill', attributeColors[attr])
                .on("mouseover", () => {
                    tooltip.style("display", "block")
                        .html(`<strong>Fecha:</strong> ${d3.timeFormat('%d/%m/%Y')(date)}<br><strong>${attr}:</strong> ${value.toFixed(2)}`);
                })
                .on("mousemove", (event) => {
                    tooltip.style("left", (event.pageX + 10) + "px")
                        .style("top", (event.pageY - 20) + "px");
                })
                .on("mouseout", () => {
                    tooltip.style("display", "none");
                });

            // Unir puntos si las fechas son consecutivas y existen valores
            if (previousDate) {
                const diffDays = (date - previousDate) / (1000 * 60 * 60 * 24);
                const prevValue = data[i - 1][attr];
                if (diffDays === 1 && !isNaN(prevValue) && !isNaN(value)) {
                    const prevRadius = radialScale(prevValue);
                    const prevAngle = angleScale(previousDate);
                    const prevX = Math.sin(prevAngle) * prevRadius;
                    const prevY = -Math.cos(prevAngle) * prevRadius;

                    svg.append('line')
                        .attr('x1', prevX)
                        .attr('y1', prevY)
                        .attr('x2', x)
                        .attr('y2', y)
                        .attr('stroke', attributeColors[attr])
                        .attr('stroke-width', 1);
                }
            }

            previousDate = date;
        });

        // Etiqueta del atributo
        svg.append('text')
            .attr('x', 0)
            .attr('y', -radialScale(maxVal) - 10)
            .attr('dy', '-0.5em')
            .attr('text-anchor', 'middle')
            .attr('font-size', '14px')
            .attr('font-weight', 'bold')
            .text(attr);
    });

    // Etiquetas de fechas alrededor del gráfico
    fullDateRange.forEach((date, i) => {
        const angle = angleScale(date);
        const x = Math.sin(angle) * (radius + 10);
        const y = -Math.cos(angle) * (radius + 10);

        let label = '';
        if (i % Math.ceil(fullDateRange.length / 10) === 0) {
            label = d3.timeFormat('%b %Y')(date); // Mes y año
        }
        svg.append('text')
            .attr('x', x)
            .attr('y', y)
            .attr('dy', '0.35em')
            .attr('text-anchor', 'middle')
            .attr('font-size', '10px')
            .text(label);
    });

    // // Agregar la funcionalidad de zoom
    // const zoom = d3.zoom()
    //                .scaleExtent([0.5, 5])  // Definir el rango de zoom
    //                .on('zoom', function(event) {
    //                    svg.attr('transform', event.transform);  // Aplicar el zoom
    //                });

    // svg.call(zoom);  // Llamar a la función de zoom
}




function getSeason(date) {
    const month = date.getMonth(); // Get month (0-11)
    const day = date.getDate(); // Get day (1-31)

    if ((month === 2 && day >= 20) || (month > 2 && month < 5) || (month === 5 && day <= 21)) {
        return 'Spring';
    } else if ((month === 5 && day >= 21) || (month > 5 && month < 8) || (month === 8 && day <= 22)) {
        return 'Summer';
    } else if ((month === 8 && day >= 23) || (month > 8 && month < 11) || (month === 11 && day <= 21)) {
        return 'Autumn';
    } else {
        return 'Winter';
    }
}



///////////////////////////////////////////////
// Funciones para la matriz de correlación

// Escuchar cambios en los checkboxes de atributos dentro de .options-chek-correlation
document.querySelectorAll('.options-chek-correlation input[type="checkbox"]').forEach(checkbox => {
    checkbox.addEventListener('change', updateCorrelationMatrix);
});

// Escuchar cambios en el rango de fechas
document.getElementById('fecha-inicio').addEventListener('change', updateCorrelationMatrix);
document.getElementById('fecha-fin').addEventListener('change', updateCorrelationMatrix);
// Función para calcular la matriz de correlación
function calculateCorrelationMatrix(data, selectedAttributes) {
    const matrix = [];

    // Normalizar los datos
    const normalizedData = normalizeData(data, selectedAttributes);

    // Iterar sobre cada par de atributos seleccionados
    for (let i = 0; i < selectedAttributes.length; i++) {
        const row = [];
        for (let j = 0; j < selectedAttributes.length; j++) {
            if (i === j) {
                row.push(1); // Correlación perfecta de un atributo consigo mismo
            } else {
                row.push(calculateCorrelation(normalizedData, selectedAttributes[i], selectedAttributes[j]));
            }
        }
        matrix.push(row);
    }

    return matrix;
}

// Función para normalizar los datos (z-score)
function normalizeData(data, selectedAttributes) {
    const means = {};
    const stdDevs = {};

    selectedAttributes.forEach(attr => {
        const values = data.map(d => +d[attr]).filter(v => !isNaN(v) && isFinite(v));
        if (values.length > 0) {
            const mean = d3.mean(values);
            const stdDev = d3.deviation(values) || 0;
            means[attr] = mean;
            stdDevs[attr] = stdDev;
        } else {
            means[attr] = 0;
            stdDevs[attr] = 0;
        }
    });

    return data.map(d => {
        const normalizedEntry = {};
        selectedAttributes.forEach(attr => {
            const mean = means[attr];
            const stdDev = stdDevs[attr];
            const val = +d[attr];
            if (isNaN(val) || !isFinite(val) || stdDev === 0) {
                normalizedEntry[attr] = 0;
            } else {
                normalizedEntry[attr] = (val - mean) / stdDev;
            }
        });
        return normalizedEntry;
    });
}

// Función para calcular la correlación entre dos atributos en los datos normalizados
function calculateCorrelation(data, attr1, attr2) {
    // Filtrar pares válidos (ambos deben ser números)
    const validData = data.filter(d =>
        d[attr1] !== null && !isNaN(d[attr1]) &&
        d[attr2] !== null && !isNaN(d[attr2])
    );

    const n = validData.length;
    if (n < 2) return 0;

    const mean1 = d3.mean(validData, d => d[attr1]);
    const mean2 = d3.mean(validData, d => d[attr2]);
    let numerator = 0;
    let denominator1 = 0;
    let denominator2 = 0;

    validData.forEach(d => {
        const x = d[attr1] - mean1;
        const y = d[attr2] - mean2;
        numerator += x * y;
        denominator1 += x * x;
        denominator2 += y * y;
    });

    if (denominator1 === 0 || denominator2 === 0) return 0;
    return numerator / Math.sqrt(denominator1 * denominator2);
}

// Función para calcular la matriz de distancias (de acuerdo a la correlación)
function calculateDistanceMatrix(correlationMatrix) {
    const numAttributes = correlationMatrix.length;
    const distanceMatrix = Array.from({ length: numAttributes }, () => Array(numAttributes).fill(0));

    for (let i = 0; i < numAttributes; i++) {
        for (let j = 0; j < numAttributes; j++) {
            // Convertir correlación a distancia usando la fórmula (1 - correlación)
            distanceMatrix[i][j] = Math.sqrt(2 * (1 - correlationMatrix[i][j]));
        }
    }

    return distanceMatrix;
}
function updateCorrelationMatrix() {
    const selectedAttributes = Array.from(document.querySelectorAll('.options-chek-correlation input[type="checkbox"]:checked'))
        .map(cb => cb.value);

    if (selectedAttributes.length === 0) return;

    // Obtener las ciudades seleccionadas
    const selectedCities = Array.from(document.querySelectorAll('#city-checkboxes input[type="radio"]:checked'))
        .map(cb => cb.value);

    // Verificar si "visualizar todo" está marcado
    const visualizarTodo = document.getElementById('visualizar-todo').checked;

    // Obtener el rango de fechas si "visualizar todo" no está seleccionado
    const startDate = document.getElementById('fecha-inicio').value;
    const endDate = document.getElementById('fecha-fin').value;

    selectedCities.forEach(selectedCity => {
        d3.csv(`${getFusionPath()}${selectedCity}`).then(data => {
            // ENRIQUECER CON DATOS METEOROLÓGICOS (CRUCIAL)
            const country = currentCountry;
            data = enrichWithMeteoCache(data, country);

            if (!visualizarTodo && startDate && endDate) {
                const s = new Date(startDate);
                const e = new Date(endDate);
                data = data.filter(d => {
                    const date = new Date(d.year, d.month - 1, d.day);
                    return date >= s && date <= e;
                });
            }

            const parsedData = d3.groups(data, d => `${d.year}-${d.month}-${d.day} ${d.hour}`).map(([datetime, entries]) => {
                const avg = {};
                selectedAttributes.forEach(attr => {
                    const values = entries.map(d => {
                        const val = +d[attr.replace('.', '_')];
                        return isNaN(val) ? +d[attr] : val;
                    }).filter(v => !isNaN(v) && isFinite(v));

                    avg[attr] = values.length > 0 ? d3.mean(values) : null;
                });
                return avg;
            });

            // Filtrar registros que tengan al menos algún dato válido
            const cleanData = parsedData.filter(d => Object.values(d).some(v => v !== null));

            const correlationMatrix = calculateCorrelationMatrix(cleanData, selectedAttributes);
            const matrizdistancia = calculateDistanceMatrix(correlationMatrix);
            const hierarchyData = buildHierarchy(selectedAttributes, matrizdistancia);

            // Crear o actualizar el dendrograma radial con los rangos de fecha y la ciudad
            createRadialDendrogram(hierarchyData, selectedAttributes, matrizdistancia, selectedCity,
                visualizarTodo ? 'Todos los datos' : `${startDate} a ${endDate}`);
        });
    });
}


// Función para construir la jerarquía (usando la matriz de distancia)
function buildHierarchy(attributes, distanceMatrix) {
    let clusters = attributes.map((attr, i) => ({
        name: attr,
        index: i,
        points: [i],  // Cada clúster empieza con un solo punto
        children: []
    }));

    let n = clusters.length;

    while (n > 1) {
        let minAverageDistance = Infinity;
        let a, b;

        // Encontrar el par de clústeres con la menor distancia promedio
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let sumDistance = 0;
                let count = 0;

                // Calcular la distancia promedio entre todos los pares de puntos en los clústeres i y j
                for (let pointI of clusters[i].points) {
                    for (let pointJ of clusters[j].points) {
                        sumDistance += distanceMatrix[pointI][pointJ];
                        count++;
                    }
                }

                const averageDistance = sumDistance / count;

                if (averageDistance < minAverageDistance) {
                    minAverageDistance = averageDistance;
                    a = i;
                    b = j;
                }
            }
        }

        // Crear un nuevo clúster combinando los clústeres a y b
        const newCluster = {
            name: clusters[a].name + '-' + clusters[b].name,
            distance: minAverageDistance,
            points: clusters[a].points.concat(clusters[b].points), // Unir puntos
            children: [clusters[a], clusters[b]]
        };

        // Actualizar la lista de clústeres
        clusters = clusters.filter((_, i) => i !== a && i !== b);
        clusters.push(newCluster);
        n--;
    }

    return clusters[0];  // Devolver la jerarquía final
}

function createRadialDendrogram(hierarchyData, selectedAttributes, distanceMatrix, selectedCity, dateRange) {
    // Verificar que los datos de entrada no sean undefined
    if (!hierarchyData || !selectedAttributes || !distanceMatrix || !selectedCity || !dateRange) {
        // console.error("Datos de entrada inválidos:", { hierarchyData, selectedAttributes, distanceMatrix, selectedCity, dateRange });
        return; // Salir de la función si los datos son inválidos
    }

    const width = 300;
    const height = 310;
    const clusterRadius = 90;

    const clusterLayout = d3.cluster().size([2 * Math.PI, clusterRadius]);

    const root = d3.hierarchy(hierarchyData);
    clusterLayout(root);

    // Configurar el gráfico
    const svg = d3.select('#chart-view-dendrogram')
        .html('')  // Limpiar el contenedor antes de redibujar
        .append('svg')
        .attr('width', width)
        .attr('height', height)
        .append('g')
        .attr('transform', `translate(${width / 2}, ${height / 2})`);

    // Crear el tooltip
    const tooltip = d3.select('body').append('div')
        .attr('class', 'tooltip')
        .style('position', 'absolute')
        .style('visibility', 'hidden')
        .style('background', 'rgba(0, 0, 0, 0.7)')
        .style('color', 'white')
        .style('padding', '5px')
        .style('border-radius', '5px');

    // Definir la escala de color
    const colorScale = d3.scaleLinear()
        .domain([0, d3.max(distanceMatrix.flat())]) // Rango de 0 a la distancia máxima
        .range(['red', 'blue']); // De rojo a azul

    // Dibujar los enlaces como líneas, sin áreas
    svg.selectAll('.link')
        .data(root.links())
        .enter().append('path')
        .attr('class', 'link')
        .attr('d', d3.linkRadial()
            .angle(d => d.x)
            .radius(d => d.y))
        .style('fill', 'none') // Eliminar área
        .style('stroke', d => {
            const attribute = d.target.data.name;
            return attribute && isMeteorologicalAttribute(attribute) ? 'blue' : '#ccc'; // Color azul para meteorología
        })
        .style('stroke-width', d => {
            const attribute = d.target.data.name;
            return attribute && isMeteorologicalAttribute(attribute) ? 2 : 1; // Grosor de línea
        })
        .style('stroke-dasharray', d => {
            const attribute = d.target.data.name;
            return attribute && isMeteorologicalAttribute(attribute) ? '5,5' : '0'; // Líneas discontinuas para meteorología
        });

    // Dibujar los nodos
    const node = svg.selectAll('.node')
        .data(root.descendants())
        .enter().append('g')
        .attr('class', 'node')
        .attr('transform', d => `rotate(${(d.x * 180 / Math.PI - 90)}) translate(${d.y}, 0)`);

    // Agregar círculo para los nodos
    node.append('circle')
        .attr('r', 5)
        .style('fill', d => {
            const distance = d.data.distance || 0;
            return colorScale(distance); // Aplicar el color basado en la distancia
        })
        .on('mouseover', (event, d) => {
            d3.select(event.currentTarget) // Seleccionar el círculo actual
                .transition() // Agregar una transición
                .duration(200) // Duración de la transición
                .attr('r', 8) // Aumentar el radio
                .style('stroke', 'yellow') // Cambiar el borde a amarillo
                .style('stroke-width', 2); // Grosor del borde

            // Mostrar el tooltip con la distancia del nodo, redondeada a dos decimales
            tooltip.html(`Distancia: ${(d.data.distance || 0).toFixed(2)}`)
                .style('visibility', 'visible')
                .style('left', `${event.pageX + 10}px`)
                .style('top', `${event.pageY - 20}px`);
        })

        .on('mouseout', (event) => {
            d3.select(event.currentTarget) // Seleccionar el círculo actual
                .transition() // Agregar una transición
                .duration(200) // Duración de la transición
                .attr('r', 5) // Volver al radio original
                .style('stroke', 'none'); // Quitar el borde

            // Ocultar el tooltip
            tooltip.style('visibility', 'hidden');
        })
        .on('click', (event, d) => {
            // Obtén la ciudad y el contaminante de los datos
            const contaminant = d.data.name;
            const startDate = dateRange.split(' a ')[0];
            const endDate = dateRange.split(' a ')[1];

            // Mostrar los datos en consola
            // console.log(`Ciudad: ${selectedCity}`);
            // console.log(`Contaminante: ${contaminant}`);
            // console.log(`Rango de fechas: ${startDate} a ${endDate}`);
            // updateTimeSeriesChart(selectedCity, startDate, endDate);

        });

    // Añadir los textos dinámicos según los atributos seleccionados
    node.append('text')
        .style('font-size', '14px')
        .style('font-weight', 'bold')
        .attr('dy', '.60em')
        .attr('text-anchor', d => d.x < Math.PI === !d.children ? 'start' : 'end')
        .attr('dx', d => d.x < Math.PI ? '10' : '-10')
        .attr('transform', d => d.x >= Math.PI ? 'rotate(180)' : null)
        .text(d => {
            const attributeIndex = d.data.index;
            return selectedAttributes.length > 0 ? selectedAttributes[attributeIndex] : d.data.name;
        });

    // Dibujar el triángulo rojo en el nodo raíz
    svg.append('polygon')
        .attr('points', `${-5},${-15} ${5},${-15} ${0},${-25}`)
        .attr('transform', `translate(0, -33) rotate(180)`)
        .style('fill', 'blue')
        .style('visibility', root.children ? 'visible' : 'hidden');
}


// Función para determinar si un atributo es meteorológico
function isMeteorologicalAttribute(attribute) {
    const meteorologicalAttributes = ['TEMP', 'PRES', 'DEWP', 'RAIN', 'WSPM', 'WD']; // Asegúrate de que estos sean los atributos correctos
    return meteorologicalAttributes.includes(attribute);
}


function updateTimeSeriesChart(selectedCity, startDate, endDate, selectedDates = null) {
    const container = d3.select('#serie-temporal');
    const margin = { top: 20, right: 10, bottom: 60, left: 50 };
    const width = 830 - margin.left - margin.right;
    const height = 360 - margin.top - margin.bottom;
    // console.log(startDate, endDate,);
    // Añadir y configurar el checkbox AQI
    // No duplicar listeners si el contenedor ya existe
    let aqiCheckboxContainer = container.select('#aqi-checkbox-container');
    if (aqiCheckboxContainer.empty()) {
        aqiCheckboxContainer = container.append('div')
            .attr('id', 'aqi-checkbox-container')
            .style('position', 'absolute')
            .style('right', '2%')
            .style('bottom', '87%')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '5px')
            .style('background-color', 'rgba(255, 255, 255, 0.8)')
            .style('padding', '5px')
            .style('border-radius', '4px')
            .style('z-index', '10');

        aqiCheckboxContainer.append('input')
            .attr('type', 'checkbox')
            .attr('id', 'aqi-size-toggle')
            .property('checked', localStorage.getItem('aqiCheckboxState') === 'true')
            .style('cursor', 'pointer')
            .on('change', function () {
                const checked = d3.select(this).property('checked');
                localStorage.setItem('aqiCheckboxState', checked);
                d3.select('#serie-temporal').selectAll('circle')
                    .transition().duration(300)
                    .attr('r', function () {
                        const attribute = d3.select(this).attr('class');
                        if (!checked) return 0;
                        return isMeteorologicalAttribute(attribute) ? 2 : 4;
                    });
            });

        aqiCheckboxContainer.append('label')
            .attr('for', 'aqi-size-toggle')
            .text('AQI')
            .style('font-weight', 'bold')
            .style('cursor', 'pointer');
    }

    let lineCheckboxContainer = container.select('#line-checkbox-container');
    if (lineCheckboxContainer.empty()) {
        lineCheckboxContainer = container.append('div')
            .attr('id', 'line-checkbox-container')
            .style('position', 'absolute')
            .style('right', '1.35%')
            .style('bottom', '80%')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '5px')
            .style('background-color', 'rgba(255, 255, 255, 0.8)')
            .style('padding', '5px')
            .style('border-radius', '4px')
            .style('z-index', '10');

        lineCheckboxContainer.append('input')
            .attr('type', 'checkbox')
            .attr('id', 'line-size-toggle')
            .property('checked', (localStorage.getItem('lineCheckboxState') || 'true') === 'true')
            .style('cursor', 'pointer')
            .on('change', function () {
                const checked = d3.select(this).property('checked');
                localStorage.setItem('lineCheckboxState', checked);
                d3.select('#serie-temporal').selectAll('path.line')
                    .transition().duration(300)
                    .style('opacity', function () {
                        const isSelected = d3.select(this).classed('selected');
                        return checked ? (isSelected ? 1 : 0.1) : 0;
                    });
            });

        lineCheckboxContainer.append('label')
            .attr('for', 'line-size-toggle')
            .text('Line')
            .style('font-weight', 'bold')
            .style('cursor', 'pointer');
    }



    const country = currentCountry;
    loadMeteoForCountry(country).then(() => {
        d3.csv(`${getFusionPath()}${selectedCity}`).then(data => {
            data = enrichWithMeteoCache(data, country);

            const attributeColors = {
                'PM2_5': '#FF0000', 'PM10': '#FF9900', 'SO2': '#FFD700', 'NO2': '#d500f1',
                'CO': '#00CED1', 'O3': '#0000FF', 'TEMP': '#008000', 'PRES': '#8B0000',
                'DEWP': '#4B0082', 'RAIN': '#1E90FF', 'WSPM': '#7f8c8d', 'WD': '#95a5a6'
            };

            const allTsAttributes = [...contaminantAttributes, ...meteorologicalAttributes];
            let selectedAttributes = JSON.parse(localStorage.getItem('selectedAttributes')) || ["PM2_5"];

            // Procesar dailyData
            const parsedData = d3.group(data, d => d3.timeFormat("%Y-%m-%d")(new Date(d.year, d.month - 1, d.day)));
            const dailyData = Array.from(parsedData, ([date, values]) => {
                const WSPMValues = values.map(v => +v.WSPM).filter(v => !isNaN(v));
                const averageWSPM = WSPMValues.length > 0 ? WSPMValues.reduce((a, b) => a + b, 0) / WSPMValues.length : null;
                return { date: new Date(date), WSPMValues, averageWSPM };
            });

            // Checkboxes internos
            let checkboxContainer = container.select('#checkbox-container');
            if (checkboxContainer.empty()) {
                checkboxContainer = container.append('div').attr('id', 'checkbox-container')
                    .style('display', 'flex').style('gap', '10px').style('flex-wrap', 'wrap')
                    .style('font-weight', 'bold').style('margin', '30px 0 10px 50px');
            } else {
                checkboxContainer.selectAll('*').remove();
            }

            checkboxContainer.selectAll('div')
                .data(allTsAttributes)
                .join('div').style('display', 'flex').style('align-items', 'center').style('gap', '5px')
                .each(function (attr) {
                    const div = d3.select(this);
                    div.append('input').attr('type', 'checkbox').attr('value', attr)
                        .property('checked', selectedAttributes.includes(attr))
                        .on('change', function () {
                            selectedAttributes = d3.selectAll('#checkbox-container input:checked').nodes().map(n => n.value);
                            localStorage.setItem('selectedAttributes', JSON.stringify(selectedAttributes));
                            drawChart(selectedAttributes, data, startDate, endDate, selectedDates, dailyData);
                        });
                    div.append('label').text(attr).style('cursor', 'pointer').style('color', attributeColors[attr]);
                });

            drawChart(selectedAttributes, data, startDate, endDate, selectedDates, dailyData);
        });
    });


    function drawChart(selectedAttributes, data, startDate, endDate, selectedDates, dailyData) {
        const containerId = 'chart-container';
        let chartContainer = container.select(`#${containerId}`);

        if (selectedAttributes.length === 0) {
            if (!chartContainer.empty()) chartContainer.selectAll('*').remove();
            return;
        }

        if (chartContainer.empty()) {
            chartContainer = container.append('div')
                .attr('id', containerId)
                .style('margin-bottom', '30px');
        }

        // Filtrar datos si startDate y endDate están definidos
        // Usar constructor local para evitar problemas de desfase horario (UTC vs Local)
        let filteredData = data.map(d => ({
            ...d,
            date: new Date(+d.year, +d.month - 1, +d.day),
            _dateKey: `${+d.year}-${+d.month}-${+d.day}`,
            value: allPossibleAttributes.reduce((acc, attribute) => {
                // Soporte para ambos nombres de CO (con punto o guion bajo)
                acc[attribute] = +d[attribute.replace('.', '_')] || +d[attribute];
                return acc;
            }, {})
        }));

        if (startDate && endDate) {
            let start, end;
            if (typeof startDate === 'string') {
                const startParts = startDate.split('-').map(Number);
                const endParts = String(endDate).split('-').map(Number);
                start = new Date(startParts[0], startParts[1] - 1, startParts[2]);
                end = new Date(endParts[0], endParts[1] - 1, endParts[2]);
            } else {
                start = startDate;
                end = endDate;
            }
            filteredData = filteredData.filter(d => d.date >= start && d.date <= end);
        }

        // Filtro para fechas duplicadas
        const uniqueDates = new Set();
        filteredData = filteredData.filter(d => {
            const formattedDate = d3.timeFormat("%Y-%m-%d")(d.date);
            if (uniqueDates.has(formattedDate)) {
                return false; // Ignorar duplicados
            }
            uniqueDates.add(formattedDate);
            return true; // Incluir fechas únicas
        });

        const selectedDateSet = selectedDates
            ? new Set(selectedDates.map(d => {
                // Normalizar a YYYY-M-D sin padding (quitar ceros si los hay)
                const parts = String(d).split('-');
                if (parts.length === 3) return `${+parts[0]}-${+parts[1]}-${+parts[2]}`;
                const parsed = new Date(d);
                return `${parsed.getFullYear()}-${parsed.getMonth() + 1}-${parsed.getDate()}`;
            }))
            : null;

        const averagedData = d3.groups(filteredData, d => d._dateKey)
            .map(([dateKey, values]) => ({
                date: values[0].date,
                value: allPossibleAttributes.reduce((acc, attribute) => {
                    let vals = values.map(v => v.value[attribute]);
                    // Filtro de ceros para meteorología para evitar errores de sensor/escala
                    if (isMeteorologicalAttribute(attribute) || windAttributes.includes(attribute)) {
                        // Ignorar ceros solo en PRES y DEWP (errores comunes)
                        // Para TEMP (0 es válido), RAIN (0 es seco), WSPM (0 es calma), WD (0 es N) mantenemos ceros
                        if (['PRES', 'DEWP'].includes(attribute)) {
                            const nonZero = vals.filter(v => v > 0);
                            vals = (nonZero.length > 0) ? nonZero : [NaN];
                        }
                    }
                    acc[attribute] = d3.mean(vals);
                    return acc;
                }, {}),
                isSelected: selectedDateSet ? selectedDateSet.has(dateKey) : true
            }));

        const minValues = {};
        const maxValues = {};
        selectedAttributes.forEach(attribute => {
            let values = averagedData.map(d => d.value[attribute]).filter(v => !isNaN(v));
            if (isMeteorologicalAttribute(attribute)) {
                const nonZero = values.filter(v => v > 0);
                if (nonZero.length > 0) values = nonZero;
            }
            minValues[attribute] = d3.min(values);
            maxValues[attribute] = d3.max(values);
        });

        const normalizedData = averagedData.map(d => {
            const normalizedValues = { ...d.value };
            selectedAttributes.forEach(attribute => {
                if (meteorologicalAttributes.includes(attribute) || contaminantAttributes.includes(attribute)) {
                    normalizedValues[attribute] = normalizeValue(
                        d.value[attribute],
                        minValues[attribute],
                        maxValues[attribute]
                    );
                }
            });
            return { ...d, normalizedValues };
        });

        const svg = chartContainer.select('svg');
        if (!svg.empty()) svg.remove();

        const chartSvg = chartContainer.append('svg')
            .attr('width', width + margin.left + margin.right)
            .attr('height', height + margin.top + margin.bottom)
            .append('g')
            .attr('transform', `translate(${margin.left}, ${margin.top})`);

        const xScale = d3.scaleTime()
            .domain(d3.extent(normalizedData, d => d.date))
            .range([0, width]);

        const yExtent = d3.extent(
            normalizedData.flatMap(d => selectedAttributes.map(attr => d.normalizedValues[attr]))
        );
        const yScale = d3.scaleLinear()
            .domain([Math.min(0, yExtent[0]), Math.max(1, yExtent[1])])
            .range([height, 0]);

        const xAxis = d3.axisBottom(xScale).tickFormat(d3.timeFormat("%d-%m-%Y"));
        const yAxis = d3.axisLeft(yScale);

        chartSvg.append('g')
            .attr('class', 'x-axis')
            .attr('transform', `translate(0, ${height})`)
            .call(xAxis)
            .selectAll("text")
            .style("text-anchor", "middle")
            .style('font-size', '10px')
            .attr("dx", "-34px")
            .attr("dy", "0px")
            .attr("transform", "rotate(-30)");

        chartSvg.append('g')
            .attr('class', 'y-axis')
            .call(yAxis)
            .style('font-size', '10px');

        // Agregar los rectángulos de fondo para las estaciones
        normalizedData.forEach(d => {
            const month = d.date.getMonth() + 1;
            const day = d.date.getDate();
            const season = getSeason(d.date);

            chartSvg.append('rect')
                .attr('x', xScale(d.date))
                .attr('y', 0)
                .attr('width', xScale(new Date(d.date.getTime() + 86400000)) - xScale(d.date))
                .attr('height', height)
                .attr('fill', seasonColors[season])
                .attr('opacity', 0.15);
        });

        const lineCheckbox = document.querySelector('#line-size-toggle');
        const showAllLines = lineCheckbox && lineCheckbox.checked;

        selectedAttributes.forEach(attribute => {
            const isMet = isMeteorologicalAttribute(attribute);
            if (!showAllLines && !isMet) return; // Forzar líneas para meteorología
            const lineData = normalizedData.filter(d => !isNaN(d.normalizedValues[attribute]));

            // Crear datos separados para las líneas seleccionadas y no seleccionadas
            const selectedLineData = lineData.filter(d => d.isSelected).map(d => ({
                x: xScale(d.date),
                y: yScale(d.normalizedValues[attribute]),
                date: d.date
            }));

            const unselectedLineData = lineData.map(d => ({
                x: xScale(d.date),
                y: yScale(d.normalizedValues[attribute]),
                date: d.date
            }));

            // Umbral de continuidad (por ejemplo, 1 día)
            const continuityThreshold = 1 * 24 * 60 * 60 * 1000; // 1 día en milisegundos

            // Función para dividir en segmentos continuos
            const divideIntoSegments = data => {
                const segments = [];
                let currentSegment = [];

                for (let i = 0; i < data.length; i++) {
                    if (currentSegment.length === 0) {
                        currentSegment.push(data[i]);
                    } else {
                        const lastPoint = currentSegment[currentSegment.length - 1];
                        const currentPoint = data[i];
                        if (currentPoint.date - lastPoint.date <= continuityThreshold) {
                            currentSegment.push(currentPoint);
                        } else {
                            segments.push(currentSegment);
                            currentSegment = [currentPoint];
                        }
                    }
                }
                if (currentSegment.length > 0) {
                    segments.push(currentSegment);
                }
                return segments;
            };

            // Dividir datos seleccionados en segmentos
            const selectedSegments = divideIntoSegments(selectedLineData);

            // Dibujar la línea continua para los datos no seleccionados con menor opacidad
            if (unselectedLineData.length > 1) {
                drawLine(chartSvg, unselectedLineData, attribute, attributeColors[attribute], 0.3); // Opacidad 0.3
            }

            // Dibujar las líneas para los segmentos seleccionados con opacidad completa
            selectedSegments.forEach(segment => {
                if (segment.length > 1) { // Asegúrate de que haya suficientes puntos para una línea
                    drawLine(chartSvg, segment, attribute, attributeColors[attribute], 1); // Opacidad completa
                }
            });
        });

        const tooltip = d3.select("body").append("div")
            .attr("class", "tooltip")
            .style("position", "absolute")
            .style("background-color", "white")
            .style("border", "1px solid #ccc")
            .style("padding", "8px")
            .style("border-radius", "4px")
            .style("box-shadow", "0px 2px 10px rgba(0, 0, 0, 0.2)")
            .style("pointer-events", "none")
            .style("opacity", 0);

        // Brush setup
        const brush = d3.brushX()
            .extent([[0, 0], [width, height]])
            .on("end", brushended);

        chartSvg.append("g")
            .attr("class", "brush")
            .call(brush);

        function brushended(event) {
            if (!event.selection) return; // Si no se ha seleccionado nada, no hacer nada

            const [x0, x1] = event.selection;
            const newDomain = [xScale.invert(x0), xScale.invert(x1)];

            // Actualizar las escalas y el gráfico
            xScale.domain(newDomain);

            // Llamar nuevamente a drawChart con los datos filtrados según el área seleccionada
            drawChart(selectedAttributes, data, newDomain[0], newDomain[1], selectedDates, dailyData);
        }

        // Reset the chart on double-click
        chartSvg.on("dblclick", function () {
            // En lugar de ir a null (rango completo de 2013-2017),
            // regresamos al rango que esté actualmente seleccionado en los filtros globales
            const globalStart = document.getElementById('fecha-inicio')?.value;
            const globalEnd = document.getElementById('fecha-fin')?.value;
            const visualizarTodo = document.getElementById('visualizar-todo')?.checked;

            const rStart = visualizarTodo ? null : globalStart;
            const rEnd = visualizarTodo ? null : globalEnd;

            drawChart(selectedAttributes, data, rStart, rEnd, selectedDates, dailyData);
        });
        // Dibujar los puntos
        selectedAttributes.forEach(attribute => {
            const lineData = normalizedData.filter(d => !isNaN(d.normalizedValues[attribute]));

            chartSvg.selectAll(`circle.${attribute}`)
                .data(lineData)
                .join('circle')
                .attr('class', attribute)
                .attr('cx', d => xScale(d.date))
                .attr('cy', d => yScale(d.normalizedValues[attribute]))
                .attr('r', d => {
                    const aqiCheckbox = document.querySelector('#aqi-size-toggle');
                    if (!aqiCheckbox || !aqiCheckbox.checked) return 0;
                    return isMeteorologicalAttribute(attribute) ? 2 : 4;
                })
                .attr('fill', d => getAQIColor(d.value[attribute], attribute))
                .attr('stroke', 'black')
                .attr('stroke-width', 0.5)
                .attr('opacity', d => d.isSelected ? 1 : 0.08)
                .on('mouseover', function (event, d) {
                    const [mouseX, mouseY] = d3.pointer(event);
                    const point = d3.select(this);

                    const windSpeed = d.value.WSPM !== undefined ? (+d.value.WSPM).toFixed(2) : 'No disponible';
                    const windDir = d.value.WD !== undefined ? getWindDirectionText(+d.value.WD) : 'No disponible';

                    // Transición para agrandar el punto seleccionado

                    // Transición para agrandar el punto seleccionado
                    point.transition()
                        .duration(200)
                        .attr('r', 10)
                        .style('stroke', 'cyan')
                        .style('stroke-width', 3);

                    // Actualiza el contenido del tooltip
                    tooltip.transition()
                        .duration(200)
                        .style('opacity', 1);

                    // Mapeo de atributos a sus unidades
                    const units = {
                        'PM2_5': 'µg/m³',
                        'PM10': 'µg/m³',
                        'SO2': 'µg/m³',
                        'NO2': 'µg/m³',
                        'CO': 'mg/m³',
                        'O3': 'µg/m³',
                        'TEMP': '°C',
                        'PRES': 'hPa',
                        'DEWP': '°C',
                        'RAIN': 'mm'
                    };

                    const selectedCity = document.querySelector('#city-checkboxes input[type="radio"]:checked')?.value || currentFilename;
                    const parsedCityId = selectedCity.replace('Data_', '').replace('.csv', '').split('_').pop();
                    const allStationObjs = (stationMeta && stationMeta.stations) ? Object.values(stationMeta.stations).flat() : [];
                    const stationObj = allStationObjs.find(s => String(s.id) === String(parsedCityId));
                    const stationName = stationObj ? stationObj.name : selectedCity.replace('Data_', '').replace('.csv', '');

                    tooltip.html(`
                        <strong>Estación:</strong> ${stationName}<br>
                        <strong>Contaminante:</strong> ${attribute}<br>
                        <strong>Fecha:</strong> ${d3.timeFormat("%d/%m/%Y")(d.date)}<br>
                        <strong>Concentración:</strong> ${d.value[attribute]?.toFixed(2)} ${units[attribute] || ''}<br>
                        <strong>Velocidad del viento:</strong> ${d.value.WSPM?.toFixed(2) || 'N/A'} m/s<br>
                        <strong>Dirección del viento:</strong> ${getWindDirectionText(d.value.WD || 0)}<br>
                    `);


                    // Obtener dimensiones del tooltip
                    const tooltipNode = tooltip.node();
                    const tooltipWidth = tooltipNode.offsetWidth;
                    const tooltipHeight = tooltipNode.offsetHeight;

                    // Calcular posición limitada dentro de los márgenes de la gráfica
                    let tooltipX = event.pageX;
                    let tooltipY = event.pageY;

                    // Limitar X dentro del área visible
                    if (tooltipX + tooltipWidth > width + margin.left) {
                        tooltipX = tooltipX - tooltipWidth - 10; // 10px de offset
                    }

                    // Limitar Y dentro del área visible
                    if (tooltipY + tooltipHeight > height + margin.top) {
                        tooltipY = tooltipY - tooltipHeight - 10; // 10px de offset
                    }

                    // Asegurar que no se salga por la izquierda o arriba
                    tooltipX = Math.max(margin.left, tooltipX);
                    tooltipY = Math.max(margin.top, tooltipY);

                    // Aplicar la posición calculada
                    tooltip.style('left', `${tooltipX}px`)
                        .style('top', `${tooltipY}px`)
                        .style('color', 'black');
                })

                .on('mouseout', function () {
                    const point = d3.select(this);
                    point.transition()
                        .duration(200)
                        .attr('r', 4)
                        .style('stroke', 'none')
                        .style('stroke-width', 0);

                    tooltip.transition()
                        .duration(200)
                        .style('opacity', 0);
                })
                .on('click', function (event, d) {


                    // Eliminar la ventana flotante previa, si existe
                    let floatingWindow = d3.select('#floating-window');
                    if (!floatingWindow.empty()) {
                        floatingWindow.remove();
                    }
                    // Obtener las coordenadas del mouse
                    const [mouseX, mouseY] = d3.pointer(event, svg.node());

                    // Limitar la posición de la ventana emergente dentro de los límites de la gráfica
                    const windowWidth = 400;
                    const windowHeight = 240;

                    const maxX = width + margin.left - windowWidth;
                    const maxY = height + margin.top - windowHeight;

                    const padding = 10;
                    const limitedX = Math.min(mouseX + margin.left + padding, maxX);
                    const limitedY = Math.min(mouseY + margin.top + padding, maxY);

                    // Crear nueva ventana flotante
                    floatingWindow = container.append('div')
                        .attr('id', 'floating-window')
                        .style('position', 'absolute')
                        .style('left', `${limitedX}px`)
                        .style('top', `${limitedY}px`)
                        .style('background-color', '#fff')
                        .style('border', '1px solid #ccc')
                        .style('padding', '10px')
                        .style('border-radius', '4px')
                        .style('box-shadow', '0px 4px 8px rgba(0, 0, 0, 0.1)')
                        .style('z-index', 1000);

                    // Botón para cerrar la ventana
                    floatingWindow.append('button')
                        .text('X')
                        .attr('class', 'close-button')
                        .style('position', 'absolute')
                        .style('top', '5px')
                        .style('right', '5px')
                        .style('border', 'none')
                        .style('background', 'transparent')
                        .style('font-size', '14px')
                        .style('cursor', 'pointer')
                        .on('click', () => floatingWindow.remove());


                    const selectedCity = document.querySelector('#city-checkboxes input[type="radio"]:checked').value;

                    // Título de la ventana emergente
                    floatingWindow.append('div')
                        .style('text-align', 'center')
                        .style('font-size', '14px')
                        .style('font-weight', 'bold')
                        .style('margin-bottom', '10px')
                        .text(`Serie temporal por hora de la fecha ${d3.timeFormat("%d-%m-%Y")(d.date)} `);



                    // Colores definidos para cada atributo
                    const attributeColors = {
                        'PM2_5': '#FF0000', // Rojo fuerte para reflejar peligro
                        'PM10': '#FF9900', // Naranja brillante para particulado
                        'SO2': '#FFD700', // Amarillo intenso para gases tóxicos
                        'NO2': '#d500f1', // Verde neón para contaminación visible
                        'CO': '#00CED1', // Turquesa vibrante para gas incoloro
                        'O3': '#0000FF', // Azul intenso para ozono
                        'TEMP': '#008000', // Rosa fuerte para variación térmica
                        'PRES': '#8B0000', // Rojo oscuro para presión atmosférica
                        'DEWP': '#4B0082', // Indigo para representar humedad
                        'RAIN': '#1E90FF'  // Azul cielo para lluvia
                    };


                    const units = {
                        'PM2_5': 'µg/m³',
                        'PM10': 'µg/m³',
                        'SO2': 'µg/m³',
                        'NO2': 'µg/m³',
                        'CO': 'mg/m³',
                        'O3': 'µg/m³',
                        'TEMP': '°C',
                        'PRES': 'hPa',
                        'DEWP': '°C',
                        'RAIN': 'mm'
                    };

                    // Crear checkboxes
                    const checkboxContainer = floatingWindow.append('div')
                        .style('display', 'flex')
                        .style('flex-direction', 'column');

                    const contaminants = ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3'];
                    const meteorologicalFactors = ['TEMP', 'PRES', 'DEWP', 'RAIN'];

                    const contaminantChecks = checkboxContainer.append('div')
                        .style('display', 'flex')
                        .style('font-size', '12px');

                    contaminants.forEach(contaminant => {
                        // Cambiar la condición para que el checkbox esté marcado si es el contaminante actual
                        const isChecked = contaminant === attribute; // Usar 'attribute' en lugar de 'currentContaminant'
                        contaminantChecks.append('label')
                            .style('margin-right', '10px')
                            .style('color', attributeColors[contaminant])
                            .text(contaminant)
                            .append('input')
                            .attr('type', 'checkbox')
                            .attr('value', contaminant)
                            .property('checked', isChecked)
                            .on('change', updateChart);
                    });

                    const meteorologicalChecks = checkboxContainer.append('div')
                        .style('display', 'flex')
                        .style('font-size', '12px');

                    meteorologicalFactors.forEach(factor => {
                        // Similar para factores meteorológicos
                        const isCheckedmet = factor === attribute;
                        meteorologicalChecks.append('label')
                            .style('margin-right', '10px')
                            .style('color', attributeColors[factor])
                            .text(factor)
                            .append('input')
                            .attr('type', 'checkbox')
                            .attr('value', factor)
                            .property('checked', isCheckedmet)
                            .on('change', updateChart);
                    });

                    function updateChart() {
                        const selectedContaminants = Array.from(floatingWindow.selectAll('input[type="checkbox"]:checked'))
                            .map(input => input.value);

                        d3.csv(`data/${selectedCity}`).then(hourlyData => {
                            const selectedDayData = hourlyData
                                .filter(row => {
                                    const rowDate = new Date(`${row.year}-${row.month}-${row.day}`);
                                    return rowDate.getTime() === d.date.getTime();
                                })
                                .map(row => {
                                    const data = {};
                                    selectedContaminants.forEach(contaminant => {
                                        data[contaminant] = +row[contaminant.replace('.', '_')] || NaN;
                                    });
                                    data.hour = +row.hour;
                                    return data;
                                });

                            // Normalización para visualización (sin alterar los valores reales)
                            const normalizedData = selectedDayData.map(d => {
                                const normalized = { hour: d.hour };
                                selectedContaminants.forEach(contaminant => {
                                    const values = selectedDayData.map(row => row[contaminant]).filter(v => !isNaN(v));
                                    const minValue = d3.min(values);
                                    const maxValue = d3.max(values);
                                    normalized[contaminant] = isNaN(d[contaminant])
                                        ? NaN
                                        : (d[contaminant] - minValue) / (maxValue - minValue);
                                });
                                return normalized;
                            });

                            floatingWindow.select('svg').remove();

                            const miniMargin = { top: 20, right: 20, bottom: 40, left: 50 };
                            const miniWidth = 400 - miniMargin.left - miniMargin.right;
                            const miniHeight = 200 - miniMargin.top - miniMargin.bottom;

                            const miniSvg = floatingWindow.append('svg')
                                .attr('width', miniWidth + miniMargin.left + miniMargin.right)
                                .attr('height', miniHeight + miniMargin.top + miniMargin.bottom)
                                .append('g')
                                .attr('transform', `translate(${miniMargin.left}, ${miniMargin.top})`);

                            const xMiniScale = d3.scaleLinear()
                                .domain([0, 23])
                                .range([0, miniWidth]);

                            const xMiniAxis = d3.axisBottom(xMiniScale).ticks(8).tickValues(d3.range(0, 24, 3)).tickFormat(d => `${d}:00`);
                            const yMiniScale = d3.scaleLinear().domain([0, 1]).range([miniHeight, 0]);

                            miniSvg.append('g')
                                .attr('transform', `translate(0, ${miniHeight})`)
                                .call(xMiniAxis)
                                .selectAll('text')
                                .style('text-anchor', 'end')
                                .attr('dx', '-0.5em')
                                .attr('dy', '-0.2em')
                                .attr('transform', 'rotate(-45)');

                            miniSvg.append('g').call(d3.axisLeft(yMiniScale));

                            selectedContaminants.forEach(contaminant => {
                                const line = d3.line()
                                    .defined(d => !isNaN(d[contaminant]))
                                    .x(d => xMiniScale(d.hour))
                                    .y(d => yMiniScale(d[contaminant]))
                                    .curve(d3.curveMonotoneX);


                                miniSvg.append('path')
                                    .datum(normalizedData)
                                    .attr('fill', 'none')
                                    .attr('stroke', attributeColors[contaminant])
                                    .attr('stroke-width', 1.5)
                                    .attr('d', line);

                                // Puntos en cada hora
                                miniSvg.selectAll(`.point-${contaminant}`)
                                    .data(selectedDayData)
                                    .enter()
                                    .append('circle')
                                    .attr('class', `point-${contaminant}`)
                                    .attr('cx', d => xMiniScale(d.hour))
                                    .attr('cy', (d, i) => yMiniScale(normalizedData[i][contaminant]))
                                    .attr('r', 3)
                                    .attr('fill', attributeColors[contaminant]);
                            });

                            // Línea vertical y valores dinámicos
                            const verticalLine = miniSvg.append('line')
                                .attr('y1', 0)
                                .attr('y2', miniHeight)
                                .attr('stroke', '#000')
                                .attr('stroke-dasharray', '4 2')
                                .attr('visibility', 'hidden');

                            const tooltip = floatingWindow.append('div')
                                .attr('id', 'tooltip')
                                .style('position', 'absolute')
                                .style('background', '#fff')
                                .style('border', '1px solid #ccc')
                                .style('padding', '5px')
                                .style('border-radius', '4px')
                                .style('box-shadow', '0px 4px 8px rgba(0, 0, 0, 0.1)')
                                .style('font-size', '10px') // Tamaño reducido de fuente
                                .style('line-height', '1.2')
                                .style('visibility', 'hidden');

                            miniSvg.append('rect')
                                .attr('width', miniWidth)
                                .attr('height', miniHeight)
                                .attr('fill', 'none')
                                .attr('pointer-events', 'all')
                                .on('mousemove', function (event) {
                                    const [mouseX, mouseY] = d3.pointer(event, this); // Obtener posición del mouse
                                    const hour = Math.round(xMiniScale.invert(mouseX)); // Hora más cercana
                                    const xPosition = xMiniScale(hour); // Posición exacta de la línea en el eje X

                                    // Actualizar posición de la línea vertical
                                    verticalLine.attr('x1', xPosition).attr('x2', xPosition).attr('visibility', 'visible');


                                    const modifiedDate2 = d3.timeDay.offset(d.date, -1);


                                    // Filtrar los datos de `dailyData` para encontrar la fecha seleccionada
                                    const selectedDate = d3.timeFormat("%Y-%m-%d")(modifiedDate2); // Formato de la fecha actual
                                    const matchingRecord = dailyData.find(record => {
                                        const recordDate = d3.timeFormat("%Y-%m-%d")(record.date); // Formatear la fecha del registro
                                        return recordDate === selectedDate;
                                    });

                                    // Extraer la velocidad del viento para la hora actual
                                    let windSpeed = 'No disponible';
                                    if (matchingRecord && matchingRecord.WSPMValues && matchingRecord.WSPMValues.length === 24) {
                                        windSpeed = `${matchingRecord.WSPMValues[hour]?.toFixed(2)} m/s`; // Velocidad específica de la hora
                                    }

                                    // Obtener datos de contaminantes para la hora seleccionada en `selectedDayData`
                                    const hourData = selectedDayData.find(d => d.hour === hour);

                                    if (hourData) {
                                        tooltip.style('visibility', 'visible')
                                            .style('left', `${xPosition + miniMargin.left}px`) // Ajustar al eje X del gráfico
                                            .style('top', `${yMiniScale(1) + miniMargin.top + 65}px`) // Justo encima del gráfico
                                            .html(
                                                selectedContaminants
                                                    .map(contaminant =>
                                                        `${contaminant}: ${hourData[contaminant]} ${units[contaminant]}`
                                                    )
                                                    .join('<br>') +
                                                `<br>Vel. del viento: ${windSpeed}` // Mostrar la velocidad del viento
                                            );
                                    } else {
                                        tooltip.style('visibility', 'hidden');
                                    }
                                })
                                .on('mouseout', () => {
                                    verticalLine.attr('visibility', 'hidden');
                                    tooltip.style('visibility', 'hidden');
                                });



                        });
                    }

                    updateChart();

                })
        });
    }



}

function drawLine(chartSvg, points, attribute, color, opacity = 1, isSelected = false) {
    const lineGenerator = d3.line()
        .x(d => d.x)
        .y(d => d.y)
        .defined(d => !isNaN(d.y) && d.y !== null)
        .curve(d3.curveMonotoneX);

    chartSvg.append('path')
        .data([points])
        .attr('class', `line ${attribute} ${isSelected ? 'selected' : 'not-selected'}`)
        .attr('d', lineGenerator(points))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2)
        .attr('opacity', opacity)
        .on('mouseover', function () {
            d3.select(this)
                .attr('stroke-width', 4);
        })
        .on('mouseout', function () {
            d3.select(this)
                .attr('stroke-width', 2);
        });
}


// Variable global para almacenar el contaminante seleccionado actualmente
let currentContaminant = null;

// Controlador unificado para todos los cambios de filtros globales (país/estación, fechas)
// Escuchar cambios globales de dimensionalidad


document.querySelectorAll('input[name="dimensionality"]').forEach(radio => {
    radio.addEventListener('change', (event) => {
        dimensionality = event.target.value;
        const vis = dimensionality.replace('2', '').toUpperCase(); // PCA, TSNE, or UMAP
        ["distribucion-global-graph1", "distribucion-global-graph2", "distribucion-global-graph3"].forEach(id => {
            if (selectionStates[id]) selectionStates[id].currentVisualization = vis;
        });
        updateAll();
    });
});

async function fetchData(selectedCity) {
    const response = await fetch(`${getFusionPath()}${selectedCity}`);
    const data = await response.text();
    return d3.csvParse(data, d => {
        const row = {
            year: +d.year,
            month: +d.month,
            day: +d.day,
            AQI: +d.AQI,
            Kmeans_3: +d.Kmeans_3,
            Kmeans_4: +d.Kmeans_4,
            Kmeans_6: +d.Kmeans_6,
            Kmeans_12: +d.Kmeans_12,
            PM2_5: +d.PM2_5,
            PM10: +d.PM10,
            SO2: +d.SO2,
            NO2: +d.NO2,
            CO: +d.CO,
            O3: +d.O3,
            TEMP: +d.TEMP,
            PRES: +d.PRES,
            DEWP: +d.DEWP,
            RAIN: +d.RAIN,
            WSPM: +d.WSPM,
            station: d.station,
            city: selectedCity
        };
        // Ensure PCA/TSNE/UMAP columns are present
        ["PCA1", "PCA2", "TSNE1", "TSNE2", "UMAP1", "UMAP2"].forEach(col => {
            if (d[col] !== undefined) row[col] = +d[col];
        });
        return row;
    });
}

async function fetchDataCont(selectedCity) {
    const response = await fetch(`${getFusionPath()}${selectedCity}`);
    const data = await response.text();
    return d3.csvParse(data, d => {
        const row = {
            year: +d.year,
            month: +d.month,
            day: +d.day,
            AQI: +d.AQI,
            Kmeans_3: +d.Kmeans_3,
            Kmeans_4: +d.Kmeans_4,
            Kmeans_6: +d.Kmeans_6,
            Kmeans_12: +d.Kmeans_12,
            city: d.city || selectedCity,
            station: d.station
        };
        ["PCA1", "PCA2", "TSNE1", "TSNE2", "UMAP1", "UMAP2"].forEach(col => {
            if (d[col] !== undefined) row[col] = +d[col];
        });
        return row;
    });
}

async function fetchDataMet(selectedCity) {
    const response = await fetch(`${getFusionPath()}${selectedCity}`);
    const data = await response.text();
    return d3.csvParse(data, d => {
        const row = {
            year: +d.year,
            month: +d.month,
            day: +d.day,
            AQI: +d.AQI,
            Kmeans_3: +d.Kmeans_3,
            Kmeans_4: +d.Kmeans_4,
            Kmeans_6: +d.Kmeans_6,
            Kmeans_12: +d.Kmeans_12,
            city: d.city || selectedCity,
            station: d.station
        };
        ["PCA1", "PCA2", "TSNE1", "TSNE2", "UMAP1", "UMAP2"].forEach(col => {
            if (d[col] !== undefined) row[col] = +d[col];
        });
        return row;
    });
}

async function updateUMAP() {
    // Obtener la ciudad seleccionada
    const selectedCity = document.querySelector('#city-checkboxes input[type="radio"]:checked')?.value || currentFilename;
    if (!selectedCity) {
        alert("Por favor, selecciona una ciudad.");
        return;
    }

    // Obtener las fechas seleccionadas
    const visualizarTodo = document.getElementById('visualizar-todo').checked;
    const fechaInicio = !visualizarTodo ? document.getElementById('fecha-inicio').value : null;
    const fechaFin = !visualizarTodo ? document.getElementById('fecha-fin').value : null;

    // Asegurar que el cache meteorológico esté cargado antes de plotear
    await loadMeteoForCountry(currentCountry);

    // Obtener y filtrar los datos (Optimizado: una sola carga para todo)
    const data = await fetchData(selectedCity);

    filterDataFusion = filterData(data, fechaInicio, fechaFin);
    filteredDataCont = filterDataFusion;
    filterDataMet = filterDataFusion;

    // Crear el gráfico
    plotUMAP(filterDataFusion, fechaInicio, fechaFin);
}

function filterData(data, startDate, endDate) {
    if (!startDate || !endDate) return data;
    const start = new Date(startDate);
    const end = new Date(endDate);
    return data.filter(d => {
        const date = new Date(d.year, d.month - 1, d.day);
        return date >= start && date <= end;
    });
}

let filteredDataCont = null; // Declaración global
let filterDataMet = null; // Declaración global
let filterDataFusion = null; // Declaración global

let isGraphLocked = false; // Inicialmente, la gráfica está desbloqueada.
let isGraphLocked2 = false; // Inicialmente, la gráfica está desbloqueada.
let isGraphLocked3 = false; // Inicialmente, la gráfica está desbloqueada.
let isGraphLocked_boton = true;
let isGraphLocked_boton2 = true;

function plotUMAP(data, fechaInicio, fechaFin) {

    d3.select("#umap-plot-fusion").selectAll("*").remove();


    // Colores para Kmeans_3
    const kmeans3Colors = {
        0: '#1b9e77',
        1: '#d95f02',
        2: '#7570b3',
    };

    // Colores para Kmeans_4
    const kmeans4Colors = {
        0: '#66c2a5',
        1: '#fc8d62',
        2: '#8da0cb',
        3: '#e78ac3',
    };

    // Colores para Kmeans_6
    const kmeans6Colors = {
        0: '#fdae61',
        1: '#fee08b',
        2: '#d73027',
        3: '#4575b4',
        4: '#313695',
        5: '#91bfdb',
    };

    // Colores para Kmeans_12
    const kmeans12Colors = {
        0: '#a6cee3',
        1: '#1f78b4',
        2: '#b2df8a',
        3: '#33a02c',
        4: '#fb9a99',
        5: '#e31a1c',
        6: '#fdbf6f',
        7: '#ff7f00',
        8: '#cab2d6',
        9: '#6a3d9a',
        10: '#ffff99',
        11: '#b15928',
    };

    // Colores para AQI
    const aqiColors = {
        1: '#00E400', // Bueno
        2: '#FFFF00', // Moderado
        3: '#FF7E00', // Insalubre
        4: '#FF0000', // Muy Insalubre
        5: '#99004c', // Malo
        6: '#800000', // Severo
    };

    // Función para actualizar la opacidad de los puntos del cluster seleccionado y agregar borde
    function updateClusterDisplay(clusterCount, selectedCluster, clusterColors) {
        const isTemporalFiltered = activeFilterData.length !== data.length;
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));
        const isClusterFiltered = selectedCluster !== null && !isNaN(selectedCluster);

        const selection = svg.selectAll("circle");
        selection
            .attr("fill", d => clusterColors[d[`Kmeans_${clusterCount}`]])
            .attr("opacity", d => {
                const inCluster = d[`Kmeans_${clusterCount}`] === selectedCluster;
                const inFilter = activeFilterDates.has(`${d.year}-${d.month}-${d.day}`);

                if (isClusterFiltered && isTemporalFiltered) {
                    return (inCluster && inFilter) ? 1 : 0.05;
                } else if (isClusterFiltered) {
                    return inCluster ? 1 : 0.05;
                } else if (isTemporalFiltered) {
                    return inFilter ? 1 : 0.05;
                } else {
                    return 1;
                }
            })
            .attr("stroke", d => {
                const inCluster = d[`Kmeans_${clusterCount}`] === selectedCluster;
                const inFilter = activeFilterDates.has(`${d.year}-${d.month}-${d.day}`);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? "black" : "none";
            })
            .attr("stroke-width", d => {
                const inCluster = d[`Kmeans_${clusterCount}`] === selectedCluster;
                const inFilter = activeFilterDates.has(`${d.year}-${d.month}-${d.day}`);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? 2 : 0;
            });

        selection.filter(d => {
            const inCluster = d[`Kmeans_${clusterCount}`] === selectedCluster;
            const inFilter = activeFilterDates.has(`${d.year}-${d.month}-${d.day}`);
            if (isClusterFiltered && isTemporalFiltered) return inCluster && inFilter;
            if (isClusterFiltered) return inCluster;
            if (isTemporalFiltered) return inFilter;
            return false;
        }).raise();
    }

    function updateAQIDisplay() {
        const isTemporalFiltered = activeFilterData.length !== data.length;
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        const selection = svg.selectAll("circle");
        selection
            .attr("fill", d => aqiColors[d.AQI] === undefined ? '#000000' : aqiColors[d.AQI])
            .attr("opacity", d => {
                if (!isTemporalFiltered) return 1;
                return activeFilterDates.has(`${d.year}-${d.month}-${d.day}`) ? 1 : 0.05;
            });

        if (isTemporalFiltered) {
            selection.filter(d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`)).raise();
        }
    }

    document.getElementById("cluster-3-btn").addEventListener("click", function () {
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])
            .attr("opacity", 1);

        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-3-select").value = "";
    });

    // Evento para el selector de cluster-12
    document.getElementById("cluster-12-btn").addEventListener("click", function () {
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");


        svg.selectAll("circle")
            .attr("fill", d => kmeans12Colors[d.Kmeans_12])
            .attr("opacity", 1);

        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").value = "";
    });

    // Evento para el botón de cluster-4
    document.getElementById("cluster-4-btn").addEventListener("click", function () {
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])
            .attr("opacity", 1);

        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-4-select").value = "";
    });

    // Evento para el botón de cluster-6
    document.getElementById("cluster-6-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked3) return; // Si la gráfica está bloqueada, salir de la función.


        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");

        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])
            .attr("opacity", 1);

        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-6-select").value = "";
    });

    let filteredClusterData = data;
    let filteredClusterData2 = data;
    let filteredClusterData3 = data;
    let filteredClusterData4 = data;
    let activeFilterData = data;  // Solo un filtro activo a la vez (estación, año o mes)
    let activeFilterData2 = data;
    let activeFilterData3 = data;
    let activeFilterData4 = data;

    // Evento para el selector de cluster-12
    document.getElementById("cluster-12-select").addEventListener("change", function () {
        if (isGraphLocked2 || isGraphLocked3) return;
        const val = this.value;
        const selectedCluster = val ? parseInt(val.replace('Cluster ', '')) - 1 : null;
        filteredClusterData4 = selectedCluster !== null ? data.filter(d => d.Kmeans_12 === selectedCluster) : data;
        updateVisualization4();
        updateClusterDisplay(12, selectedCluster, kmeans12Colors);
    });

    // Evento para el selector de cluster-3
    document.getElementById("cluster-3-select").addEventListener("change", function () {
        if (isGraphLocked2 || isGraphLocked3) return;
        const val = this.value;
        const selectedCluster = val ? parseInt(val.replace('Cluster ', '')) - 1 : null;
        filteredClusterData3 = selectedCluster !== null ? data.filter(d => d.Kmeans_3 === selectedCluster) : data;
        updateVisualization3();
        updateClusterDisplay(3, selectedCluster, kmeans3Colors);
    });

    // Evento para el selector de cluster-4
    document.getElementById("cluster-4-select").addEventListener("change", function () {
        if (isGraphLocked2 || isGraphLocked3) return;

        const val = this.value;
        const selectedCluster = val ? parseInt(val.replace('Cluster ', '')) - 1 : null;
        filteredClusterData = selectedCluster !== null ? data.filter(d => d.Kmeans_4 === selectedCluster) : data;

        updateVisualization();
        updateClusterDisplay(4, selectedCluster, kmeans4Colors);
    });




    // Evento para el selector de cluster-6
    document.getElementById("cluster-6-select").addEventListener("change", function () {
        if (isGraphLocked2) return;
        if (isGraphLocked3) return;

        const val = this.value;
        const selectedCluster = val ? parseInt(val.replace('Cluster ', '')) - 1 : null;
        filteredClusterData2 = selectedCluster !== null ? data.filter(d => d.Kmeans_6 === selectedCluster) : data;

        updateVisualization2();
        updateClusterDisplay(6, selectedCluster, kmeans6Colors);
    });

    // Evento para el botón AQI
    document.getElementById("aqi-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked3) return; // Si la gráfica está bloqueada, salir de la función.


        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        updateAQIDisplay(); // Actualiza la visualización de AQI
        updateButtonOpacity("aqi-btn");

    });

    // Función para actualizar la opacidad de los filtros
    function updateFilterOpacity(activeFilterId) {
        const filters = ["station-filter", "year-filter", "month-filter", "aqi-filter"];
        filters.forEach((filterId) => {
            const filterElement = document.getElementById(filterId);
            if (filterId === activeFilterId) {
                filterElement.classList.remove("dimmed");
            } else {
                filterElement.classList.add("dimmed");
            }
        });
    }


    // Función para determinar qué cluster está activo
    function getActiveClusterVisualizationFunction() {
        if (!document.getElementById("cluster-6-select").disabled) {
            return updateVisualization2; // Si cluster-6 está habilitado, usa updateVisualization2
        }
        if (!document.getElementById("cluster-4-select").disabled) {
            return updateVisualization; // Si cluster-4 está habilitado, usa updateVisualization
        }
        if (!document.getElementById("cluster-3-select").disabled) {
            return updateVisualization3; // Si cluster-3 está habilitado, usa updateVisualization3
        }
        if (!document.getElementById("cluster-12-select").disabled) {
            return updateVisualization4; // Si cluster-12 está habilitado, usa updateVisualization12
        }
    }

    document.getElementById('station-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked3) return;
        const selectedSeason = event.target.value;
        const filtered = filterDataBySeason(selectedSeason, data);
        activeFilterData = filtered;
        activeFilterData2 = filtered;
        activeFilterData3 = filtered;
        activeFilterData4 = filtered;
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('station-filter');
    });

    document.getElementById('year-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked3) return;
        const selectedYearVal = event.target.value;
        const selectedYear = selectedYearVal ? parseInt(selectedYearVal, 10) : null;
        const filtered = selectedYear ? data.filter(d => d.year === selectedYear) : data;
        activeFilterData = filtered;
        activeFilterData2 = filtered;
        activeFilterData3 = filtered;
        activeFilterData4 = filtered;
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('year-filter');
    });

    document.getElementById('month-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked3) return;
        const selectedMonth = event.target.value;
        const filtered = filterDataByMonth(selectedMonth, data);
        activeFilterData = filtered;
        activeFilterData2 = filtered;
        activeFilterData3 = filtered;
        activeFilterData4 = filtered;
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('month-filter');
    });

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization() {
        const isClusterFiltered = filteredClusterData.length !== data.length;
        const isTemporalFiltered = activeFilterData.length !== data.length;

        const clusterDates = new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        const selection = svg.selectAll("circle");

        selection
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])
            .attr("opacity", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates.has(dateKey);

                if (isClusterFiltered && isTemporalFiltered) {
                    return (inCluster && inFilter) ? 1 : 0.05;
                } else if (isClusterFiltered) {
                    return inCluster ? 1 : 0.05;
                } else if (isTemporalFiltered) {
                    return inFilter ? 1 : 0.05;
                } else {
                    return 1;
                }
            })
            .attr("stroke", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? "black" : "none";
            })
            .attr("stroke-width", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? 2 : 0;
            });

        // Raise selected points to the front
        selection.filter(d => {
            const dateKey = `${d.year}-${d.month}-${d.day}`;
            const inCluster = clusterDates.has(dateKey);
            const inFilter = activeFilterDates.has(dateKey);
            if (isClusterFiltered && isTemporalFiltered) return inCluster && inFilter;
            if (isClusterFiltered) return inCluster;
            if (isTemporalFiltered) return inFilter;
            return false;
        }).raise();

        const intersectionData = filteredClusterData.filter(d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`));
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization2() {
        const isClusterFiltered = filteredClusterData2.length !== data.length;
        const isTemporalFiltered = activeFilterData2.length !== data.length;

        const clusterDates = new Set(filteredClusterData2.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates2 = new Set(activeFilterData2.map(d => `${d.year}-${d.month}-${d.day}`));

        const selection = svg.selectAll("circle");

        selection
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])
            .attr("opacity", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates2.has(dateKey);

                if (isClusterFiltered && isTemporalFiltered) {
                    return (inCluster && inFilter) ? 1 : 0.05;
                } else if (isClusterFiltered) {
                    return inCluster ? 1 : 0.05;
                } else if (isTemporalFiltered) {
                    return inFilter ? 1 : 0.05;
                } else {
                    return 1;
                }
            })
            .attr("stroke", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates2.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? "black" : "none";
            })
            .attr("stroke-width", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates2.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? 2 : 0;
            });

        // Raise selected points to the front
        selection.filter(d => {
            const dateKey = `${d.year}-${d.month}-${d.day}`;
            const inCluster = clusterDates.has(dateKey);
            const inFilter = activeFilterDates2.has(dateKey);
            if (isClusterFiltered && isTemporalFiltered) return inCluster && inFilter;
            if (isClusterFiltered) return inCluster;
            if (isTemporalFiltered) return inFilter;
            return false;
        }).raise();

        const intersectionData = filteredClusterData2.filter(d => activeFilterDates2.has(`${d.year}-${d.month}-${d.day}`));
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    function updateVisualization3() {
        const isClusterFiltered = filteredClusterData3.length !== data.length;
        const isTemporalFiltered = activeFilterData3.length !== data.length;

        const clusterDates = new Set(filteredClusterData3.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates3 = new Set(activeFilterData3.map(d => `${d.year}-${d.month}-${d.day}`));

        const selection = svg.selectAll("circle");

        selection
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])
            .attr("opacity", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates3.has(dateKey);

                if (isClusterFiltered && isTemporalFiltered) {
                    return (inCluster && inFilter) ? 1 : 0.05;
                } else if (isClusterFiltered) {
                    return inCluster ? 1 : 0.05;
                } else if (isTemporalFiltered) {
                    return inFilter ? 1 : 0.05;
                } else {
                    return 1;
                }
            })
            .attr("stroke", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates3.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? "black" : "none";
            })
            .attr("stroke-width", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates3.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? 2 : 0;
            });

        // Raise selected points to the front
        selection.filter(d => {
            const dateKey = `${d.year}-${d.month}-${d.day}`;
            const inCluster = clusterDates.has(dateKey);
            const inFilter = activeFilterDates3.has(dateKey);
            if (isClusterFiltered && isTemporalFiltered) return inCluster && inFilter;
            if (isClusterFiltered) return inCluster;
            if (isTemporalFiltered) return inFilter;
            return false;
        }).raise();

        const intersectionData = filteredClusterData3.filter(d => activeFilterDates3.has(`${d.year}-${d.month}-${d.day}`));
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    function updateVisualization4() {
        const isClusterFiltered = filteredClusterData4.length !== data.length;
        const isTemporalFiltered = activeFilterData4.length !== data.length;

        const clusterDates = new Set(filteredClusterData4.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates4 = new Set(activeFilterData4.map(d => `${d.year}-${d.month}-${d.day}`));

        const selection = svg.selectAll("circle");

        selection
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])
            .attr("opacity", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates4.has(dateKey);

                if (isClusterFiltered && isTemporalFiltered) {
                    return (inCluster && inFilter) ? 1 : 0.05;
                } else if (isClusterFiltered) {
                    return inCluster ? 1 : 0.05;
                } else if (isTemporalFiltered) {
                    return inFilter ? 1 : 0.05;
                } else {
                    return 1;
                }
            })
            .attr("stroke", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates4.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? "black" : "none";
            })
            .attr("stroke-width", d => {
                const dateKey = `${d.year}-${d.month}-${d.day}`;
                const inCluster = clusterDates.has(dateKey);
                const inFilter = activeFilterDates4.has(dateKey);
                return (inCluster && inFilter && (isClusterFiltered || isTemporalFiltered)) ? 2 : 0;
            });

        // Raise selected points to the front
        selection.filter(d => {
            const dateKey = `${d.year}-${d.month}-${d.day}`;
            const inCluster = clusterDates.has(dateKey);
            const inFilter = activeFilterDates4.has(dateKey);
            if (isClusterFiltered && isTemporalFiltered) return inCluster && inFilter;
            if (isClusterFiltered) return inCluster;
            if (isTemporalFiltered) return inFilter;
            return false;
        }).raise();

        const intersectionData = filteredClusterData4.filter(d => activeFilterDates4.has(`${d.year}-${d.month}-${d.day}`));
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    // Función para manejar la actualización de gráficos
    function handleSelectionUpdate(filteredData, selectedDates, fechaInicio, fechaFin) {
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas seleccionadas.");
            return;
        }

        // console.log("Actualizando gráficos con fechas seleccionadas:", selectedDates);
        const cityFile = filteredData.length > 0 ? filteredData[0].city : null;

        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates);
        updateRadialChartWithSelection(filteredData, fechaInicio, fechaFin);

    }

    // Función para filtrar datos por estación
    function filterDataBySeason(season, data) {
        if (!season) return data;
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } }
        };

        const range = seasonRanges[season];
        if (!range) return data;

        return data.filter(d => {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            return season === 'Invierno'
                ? (date >= start || date <= end)
                : (date >= start && date <= end);
        });
    }

    // Función para filtrar datos por mes
    function filterDataByMonth(month, data) {
        if (!month) return data;
        const monthMapping = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };
        const monthNumber = monthMapping[month];
        if (!monthNumber) return data;
        return data.filter(d => d.month === monthNumber);
    }

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-fusion");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("width", "100%")
        .attr("height", "100%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none")
        .style("position", "relative")
        .style("border", "1px solid #ddd")
        .style("border-radius", "10px")
        .on("contextmenu", (event) => event.preventDefault());

    // Activar controles por defecto para la fusión
    enableClusterAndAQIControls();
    isGraphLocked = true;
    isGraphLocked_boton = false;
    d3.selectAll(".legend-item-pca, .reset-button-pca")
        .style("pointer-events", "all")
        .style("opacity", "1")
        .style("display", "block");
    function enableClusterAndAQIControls() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
    }

    function disableClusterAndAQIControls() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }

    // Grupo para aplicar zoom
    const g = svg.append("g");

    // Escalas
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height, 0]);

    // Colores según el nivel de AQI
    const colorScale = d3.scaleOrdinal()
        .domain([1, 2, 3, 4, 5, 6])
        .range(aqiColors);

    // Tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar puntos
    g.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 6)
        .attr("fill", d => getGlobalAQIColor(d))
        .attr("opacity", 1)
        .attr("stroke", "black")
        .attr("stroke-width", 0.5)
        // Agregar manejador para el filtro de estación

        .on("mouseover", function (event, d) {
            const calculatedAQI = getGlobalAQILevel(d);
            tooltip.style("visibility", "visible")
                .html(`
                    <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                    <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                    <strong>AQI:</strong> ${calculatedAQI}
                `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 1);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", 0.5);
        });

    function highlightSeason(season, data, svg, xScale, yScale) {
        // Definir rangos de fechas para cada estación
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } },
        };

        const range = seasonRanges[season];
        if (!range) return;

        function isInSeason(d) {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            if (season === 'Invierno') {
                return (
                    (date >= start && d.month >= 12) ||
                    (d.month <= 3 && date <= end)
                );
            }

            return date >= start && date <= end;
        }

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => isInSeason(d))
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }

    function highlightYear(year, data, svg, xScale, yScale) {
        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.year === year)
            .attr("stroke", "blue")
            .attr("stroke-width", 1)
            .attr("r", 8);
    }

    function highlightMonth(month, data, svg, xScale, yScale) {
        const months = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };

        const monthNumber = months[month];
        if (!monthNumber) return;

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.month === monthNumber)
            .attr("stroke", "blue")
            .attr("stroke-width", 1)
            .attr("r", 8);
    }
    // Variables para la selección
    let isDrawing = false;
    let points = [];
    let selectionLine; // Para almacenar la línea de selección

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);

    svg.on("mousedown", (event) => {
        if (event.button !== 2) return; // Solo activar con anticlick (botón derecho del mouse)

        // Limpiar la selección anterior
        if (selectionLine) {
            selectionLine.remove();
        }

        isDrawing = true;
        points = []; // Reiniciar puntos

        // Restaurar todos los puntos a su estado base antes de un nuevo lasso
        g.selectAll("circle")
            .attr("opacity", 1)
            .attr("r", 6)
            .attr("stroke", "black")
            .attr("stroke-width", 0.5);

        const [startX, startY] = d3.pointer(event, g.node());
        points.push([startX, startY]);

        // Crear línea inicial
        selectionLine = g.append("polyline")
            .attr("fill", "rgba(100, 100, 255, 0.3)")
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("points", points.join(" "));

        svg.on("mousemove", (event) => {
            if (!isDrawing) return;

            const [currentX, currentY] = d3.pointer(event, g.node());
            points.push([currentX, currentY]);
            selectionLine.attr("points", points.join(" "));
        });
    });

    svg.on("mouseup", () => {
        if (!isDrawing) return;

        isDrawing = false;

        // Unir el último punto con el primero
        points.push(points[0]); // Añadir el primer punto al final para cerrar el polígono
        selectionLine.attr("points", points.join(" ")); // Actualizar la línea para incluir el cierre

        // Filtrar los puntos seleccionados dentro del polígono
        // Los puntos del lasso se capturan en coordenadas de g.node() (post-zoom),
        // por eso la proyección de datos también debe hacerse con xScale/yScale puras
        // (que también viven en el mismo espacio de g antes de la transformación de zoom).
        const activeDimCols = getDimCols();
        const selectionData = data.filter(d => {
            const x = xScale(d[activeDimCols[0]]);
            const y = yScale(d[activeDimCols[1]]);
            return d3.polygonContains(points, [x, y]);
        });

        // Verificar si hay datos seleccionados
        if (selectionData.length === 0) {
            console.warn("No se seleccionaron puntos dentro del área.");
            return;
        }

        // Construir el arreglo de fechas seleccionadas
        const selectedDates = selectionData.map(d => `${d.year}-${d.month}-${d.day}`);

        // Verifica que haya fechas válidas en `selectedDates`
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas en los datos seleccionados.");
            return;
        }

        // Obtener el archivo de la ciudad seleccionada
        const cityFile = selectionData[0].city;

        // Llamar a las funciones con las fechas seleccionadas
        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates);
        updateRadialChartWithSelection(selectionData, fechaInicio, fechaFin);
        // Solo llamar si los contenedores existen en el DOM (pueden no estar en el layout actual)
        if (document.getElementById("umap-plot-contaminacion"))
            plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, selectedDates, "blue");
        if (document.getElementById("umap-plot-meteorologia"))
            plotUMAPmetCluster(filterDataMet, fechaInicio, fechaFin, selectedDates, "blue");

        // --- Dimming: difuminar NO seleccionados, mantener seleccionados ---
        const selectedSet = new Set(selectionData.map(d => `${d.year}-${d.month}-${d.day}-${d.station || ''}`));

        // 1. Difuminar TODOS los puntos
        g.selectAll("circle")
            .attr("opacity", 0.08)
            .attr("r", 6)
            .attr("stroke", "black")
            .attr("stroke-width", 0.5);

        // 2. Restaurar los seleccionados con opacidad completa y stroke negro fino original
        g.selectAll("circle")
            .filter(d => selectedSet.has(`${d.year}-${d.month}-${d.day}-${d.station || ''}`))
            .attr("opacity", 1)
            .attr("r", 6)
            .attr("stroke", "black")
            .attr("stroke-width", 0.5)
            .raise();
    });

    // Agregar la leyenda como botones
    const legendData = [
        { color: '#00E400', label: 'Bueno', AQI: 1 },
        { color: '#FFFF00', label: 'Moderado', AQI: 2 },
        { color: '#FF7E00', label: 'Insalubre', AQI: 3 },
        { color: '#FF0000', label: 'Muy Insalubre', AQI: 4 },
        { color: '#99004c', label: 'Malo', AQI: 5 },
        { color: '#800000', label: 'Severo', AQI: 6 },
    ];

    // Crear la leyenda como botones, asegurando que esté dentro del sidebar
    d3.select('.filter-sidebar').select('.legend-pca').remove();

    const legend = d3.select('.filter-sidebar').append('div')
        .attr('class', 'legend-pca filter-group')
        .style('display', 'flex')
        .style('flex-direction', 'column')
        .style('gap', '3px')
        .style('padding', '8px 0')
        .style('height', 'auto')
        .style('font-family', 'Arial, sans-serif')
        .style('font-weight', 'bold')
        .style('text-align', 'left');

    legendData.forEach((item, index) => {
        const legendButton = legend.append('button')
            .attr('class', 'legend-item-pca')
            .style('background-color', item.color)
            .style('padding', '4px 10px')
            .style('margin', '2px 0') // NEW: Vertical spacing
            .style('border-radius', '4px')
            .style('width', '100%')
            .style('min-width', '70px')
            .style('color', index > 3 ? 'white' : 'black')
            .style('border', 'none')
            .style('cursor', 'pointer')
            .style('font-weight', 'bold')
            .style('text-align', 'center')
            .style('font-size', '9px')
            .style('box-shadow', '0px 1px 3px rgba(0, 0, 0, 0.2)')
            .text(item.label);

        // Cambiar la opacidad y agregar borde en hover
        legendButton
            .on('mouseover', () => {
                legendButton.style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)');
            })
            .on('mouseout', () => {
                if (!legendButton.classed('selected')) {
                    legendButton.style('box-shadow', 'none');
                }
            });

        // Filtrar puntos al hacer clic
        legendButton.on('click', () => {
            // Quitar la sombra de todos los botones y restablecer tamaño
            if (isGraphLocked_boton) return; // Evitar interacción si está bloqueado

            legend.selectAll('button')
                .style('box-shadow', 'none')
                .style('transform', 'scale(1)')
                .style('opacity', '0.7')  // Reducir opacidad de los otros botones
                .classed('selected', false);

            // Agregar la clase 'selected' al botón clickeado para aplicar la sombra
            legendButton.style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)')
                .style('transform', 'scale(1.1)') // Hacer que el botón crezca un poco
                .style('opacity', '1')  // El botón seleccionado no pierde opacidad
                .classed('selected', true);

            const selectedAQI = index + 1; // AQI corresponde al índice + 1

            // Filtrar puntos en el gráfico UMAP
            svg.selectAll('circle')
                .attr('opacity', d => (getGlobalAQILevel(d) === selectedAQI ? 1 : 0.05));

            svg.selectAll('circle')
                .filter(d => getGlobalAQILevel(d) === selectedAQI)
                .raise();

            // Filtrar datos para otras visualizaciones
            const selectedData = data.filter(d => getGlobalAQILevel(d) === selectedAQI);
            const selectedDates = selectedData.map(d => `${d.year}-${d.month}-${d.day}`);

            // Actualizar otras gráficas con los datos seleccionados
            if (typeof updateTimeSeriesChart === 'function') updateTimeSeriesChart(selectedData[0]?.city, fechaInicio, fechaFin, selectedDates);
            if (typeof updateCorrelationMatrixnew === 'function') updateCorrelationMatrixnew(selectedDates);
            if (typeof drawThemeRiver === 'function') drawThemeRiver(selectedData[0]?.city, selectedDates);
            if (typeof updateRadialChartWithSelection === 'function') updateRadialChartWithSelection(selectedData, fechaInicio, fechaFin);
        });
    });

    // Agregar un botón para resetear el filtro
    legend.append('button')
        .attr('class', 'reset-button-pca')
        .style('background-color', '#ccc')
        .style('padding', '5px 10px')
        .style('margin', '5px 0 0 0')
        .style('border-radius', '4px')
        .style('width', '100%')
        .style('color', 'black')
        .style('border', 'none')
        .style('cursor', 'pointer')
        .style('font-size', '11px')
        .style('font-weight', 'bold')
        .style('box-shadow', '0px 1px 3px rgba(0, 0, 0, 0.2)')
        .text('Resetear')
        .on('mouseover', function () {
            d3.select(this).style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)');
        })
        .on('mouseout', function () {
            d3.select(this).style('box-shadow', 'none');
        })
        .on('click', () => {
            // Resetear opacidad de todos los puntos
            svg.selectAll('circle')
                .attr('opacity', 1);

            // Eliminar la sombra de todos los botones y quitar la clase 'selected'
            legend.selectAll('button')
                .style('box-shadow', 'none')
                .style('transform', 'scale(1)')
                .style('opacity', '1')  // Restaurar opacidad original
                .classed('selected', false);
            updateAll();
        });
}


function plotUMAPmetCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor) {
    // Salir silenciosamente si el contenedor no existe en el DOM
    if (!document.getElementById("umap-plot-meteorologia")) return;
    d3.select("#umap-plot-meteorologia").selectAll("*").remove();

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-meteorologia");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("transform", "translate(27, -185)") // Desplazamiento hacia la derecha y abajo
        .attr("width", "45%")
        .attr("height", "45%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none") // Fondo transparente
        .style("position", "relative") // Asegura que el desplazamiento funcione correctamente
        .style("border", "1px solid black") // Agrega un borde negro de 2px
        .style("border-radius", "10px") // Bordes redondeados
        .on("contextmenu", (event) => event.preventDefault());
    // Agregar título en la parte superior izquierda
    svg.append("text")
        .attr("x", 53) // Posición horizontal (izquierda)
        .attr("y", 30) // Posición vertical (arriba)
        .attr("font-size", "30px") // Tamaño de la fuente
        .attr("font-weight", "bold") // Negrita
        .attr("fill", "black") // Color del texto
        .text("Meteorologicos");

    // Agregar un checkbox al lado del título
    const checkbox = d3.select("#umap-plot-meteorologia")
        .append("input")
        .attr("type", "checkbox")
        .attr("id", "toggle-umap-meteorologia")
        .style("position", "absolute")
        .style("left", "47px") // Ajusta la posición respecto al contenedor
        .style("top", "225px") // Ajusta la posición respecto al contenedor
        .property("checked", false); // Inicia desmarcado
    // Escalas para los ejes
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([50, width - 50]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height - 50, 50]);

    // Crear el conjunto de fechas destacadas
    const clusterDateSet = new Set(clusterDates);
    // Crear tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar los puntos
    svg.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 5)
        .attr("fill", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? clusterColor : "steelblue") // Usar el color del cluster
        .attr("opacity", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.2) // Opacidad baja si no está en clusterDates
        .attr("stroke", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? "black" : "black") // Borde negro siempre
        .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.5)
        .on("mouseover", function (event, d) {
            tooltip.style("visibility", "visible")
                .html(`
                    <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                    <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                    <strong>AQI:</strong> ${d.AQI}
                `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 3);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0);
        });

    // Agregar zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            svg.selectAll("circle").attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);

    // Evento del checkbox
    d3.select("#toggle-umap-meteorologia").on("change", function () {
        const isChecked = d3.select(this).property("checked");

        // Limpiar el gráfico actual
        d3.select("#umap-plot-meteorologia").selectAll("*").remove();

        if (isChecked) {
            svg.style("border", "1px solid #ff6347"); // Borde resaltado con color
            enableClusterAndAQIControls3(); // Habilitar botones

            // Llamar a la nueva función cuando el checkbox está activado
            plotUMAPmet(data, fechaInicio, fechaFin);

        } else {
            svg.style("border", "1px solid black"); // Borde normal
            disableClusterAndAQIControls3(); // Deshabilitar botones

            // Volver a la función original cuando el checkbox está desactivado
            plotUMAPmetCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor);
        }
    });


    // Función para habilitar los controles de clusters y AQI
    function enableClusterAndAQIControls3() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");

    }

    // Función para deshabilitar los controles de clusters y AQI
    function disableClusterAndAQIControls3() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }
}


function plotUMAPfusionCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor) {
    // Limpiar el gráfico anterior
    d3.select("#umap-plot-fusion").selectAll("*").remove();
    // console.log("DGAAAAAAAAAAAAAAAAAAAA:")

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-fusion");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("transform", "translate(275, -390)") // Desplazamiento hacia la derecha y abajo
        .attr("width", "45%")
        .attr("height", "45%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none") // Fondo transparente
        .style("position", "relative") // Asegura que el desplazamiento funcione correctamente
        .style("border", "1px solid black") // Agrega un borde negro
        .style("border-radius", "10px") // Bordes redondeados
        .on("contextmenu", (event) => event.preventDefault());

    // Agregar título en la parte superior izquierda
    svg.append("text")
        .attr("x", 53) // Posición horizontal (izquierda)
        .attr("y", 30) // Posición vertical (arriba)
        .attr("font-size", "30px") // Tamaño de la fuente
        .attr("font-weight", "bold") // Negrita
        .attr("fill", "black") // Color del texto
        .text("Fusion de Datos");

    // Agregar un checkbox al lado del título
    d3.select("#umap-plot-fusion")
        .append("input")
        .attr("type", "checkbox")
        .attr("id", "toggle-umap-fusion")
        .style("position", "absolute")
        .style("left", "295px") // Ajusta la posición respecto al contenedor
        .style("top", "225px") // Ajusta la posición respecto al contenedor
        .property("checked", false); // Inicia desmarcado

    // Escalas para los ejes
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([50, width - 50]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height - 50, 50]);

    // Crear el conjunto de fechas destacadas
    const clusterDateSet = new Set(clusterDates);
    // Crear tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar los puntos
    svg.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 5)
        .attr("fill", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? clusterColor : "steelblue") // Usar el color del cluster
        .attr("opacity", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.2) // Opacidad baja si no está en clusterDates
        .attr("stroke", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? "black" : "black") // Borde negro siempre
        .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.5)
        .on("mouseover", function (event, d) {
            tooltip.style("visibility", "visible")
                .html(`
                    <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                    <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                    <strong>AQI:</strong> ${d.AQI}
                `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 3);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0);
        });

    // Agregar zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            svg.selectAll("circle").attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);
    // Evento del checkbox
    d3.select("#toggle-umap-fusion").on("change", function () {
        const isChecked = d3.select(this).property("checked");

        // Limpiar el gráfico actual
        d3.select("#umap-plot-fusion").selectAll("*").remove();

        if (isChecked) {
            svg.style("border", "1px solid #ff6347"); // Borde resaltado con color
            enableClusterAndAQIControls(); // Habilitar botones
            isGraphLocked = true;
            isGraphLocked_boton = false;
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "all")
                .style("opacity", "1")
                .style("display", "block");

            // Llamar a la nueva función cuando el checkbox está activado
            plotUMAP(data, fechaInicio, fechaFin);

        } else {
            svg.style("border", "1px solid black"); // Borde normal
            disableClusterAndAQIControls(); // Deshabilitar botones
            isGraphLocked = false;
            isGraphLocked_boton = true;
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "none")
                .style("opacity", "0.5");

            // Volver a la función original cuando el checkbox está desactivado
            plotUMAPfusionCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor);
        }
    });


    // Función para habilitar los controles de clusters y AQI
    function enableClusterAndAQIControls() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
    }

    // Función para deshabilitar los controles de clusters y AQI
    function disableClusterAndAQIControls() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }

}

function plotUMAPcontCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor) {
    // Salir silenciosamente si el contenedor no existe en el DOM
    if (!document.getElementById("umap-plot-contaminacion")) return;
    d3.select("#umap-plot-contaminacion").selectAll("*").remove();

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-contaminacion");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("transform", "translate(275, -190)") // Desplazamiento hacia la derecha y abajo
        .attr("width", "45%")
        .attr("height", "45%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none") // Fondo transparente
        .style("position", "relative")
        .style("border", "1px solid black") // Agrega un borde negro
        .style("border-radius", "10px")
        .on("contextmenu", (event) => event.preventDefault());

    // Agregar título
    svg.append("text")
        .attr("x", 53)
        .attr("y", 30)
        .attr("font-size", "30px")
        .attr("font-weight", "bold")
        .attr("fill", "black")
        .text("Contaminantes");

    // Agregar checkbox
    d3.select("#umap-plot-contaminacion")
        .append("input")
        .attr("type", "checkbox")
        .attr("id", "toggle-umap-contaminacion")
        .style("position", "absolute")
        .style("left", "295px")
        .style("top", "16px")
        .property("checked", false);

    // Escalas para los ejes
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([50, width - 50]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height - 50, 50]);

    // Conjunto de fechas destacadas
    const clusterDateSet = new Set(clusterDates);

    // Crear tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar los puntos
    svg.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 6)
        .attr("fill", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? clusterColor : "steelblue")
        .attr("opacity", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.2)
        .attr("stroke", "black")
        .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0.5)
        .on("mouseover", function (event, d) {
            tooltip.style("visibility", "visible")
                .html(`
                    <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                    <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                    <strong>AQI:</strong> ${d.AQI}
                `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 3);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0);
        });

    // Agregar zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            svg.selectAll("circle").attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);

    // Evento del checkbox
    d3.select("#toggle-umap-contaminacion").on("change", function () {
        const isChecked = d3.select(this).property("checked");

        // Limpiar el gráfico actual
        d3.select("#umap-plot-contaminacion").selectAll("*").remove();

        if (isChecked) {
            svg.style("border", "1px solid #ff6347");
            enableClusterAndAQIControls2();
            isGraphLocked2 = true;
            isGraphLocked_boton2 = false;
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "all")
                .style("opacity", "1")
                .style("display", "block");

            plotUMAPcont(data, fechaInicio, fechaFin);
        } else {
            svg.style("border", "1px solid black");
            disableClusterAndAQIControls2();
            isGraphLocked2 = false;
            isGraphLocked_boton2 = true;
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "none")
                .style("opacity", "0.5");

            plotUMAPcontCluster(data, fechaInicio, fechaFin, clusterDates, clusterColor);
        }
    });

    // Función para habilitar controles
    function enableClusterAndAQIControls2() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
    }

    // Función para deshabilitar controles
    function disableClusterAndAQIControls2() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }
}


function plotUMAPcont(data, fechaInicio, fechaFin) {
    // Limpiar el gráfico anterior
    d3.select("#umap-plot-contaminacion").selectAll("*").remove();
    // console.log("Fechas de entrada:", fechaInicio, fechaFin);

    // Colores para Kmeans_3
    const kmeans3Colors = {
        0: '#1b9e77',
        1: '#d95f02',
        2: '#7570b3',
    };

    // Colores para Kmeans_4
    const kmeans4Colors = {
        0: '#66c2a5',
        1: '#fc8d62',
        2: '#8da0cb',
        3: '#e78ac3',
    };

    // Colores para Kmeans_6
    const kmeans6Colors = {
        0: '#fdae61',
        1: '#fee08b',
        2: '#d73027',
        3: '#4575b4',
        4: '#313695',
        5: '#91bfdb',
    };

    // Colores para Kmeans_12
    const kmeans12Colors = {
        0: '#a6cee3',
        1: '#1f78b4',
        2: '#b2df8a',
        3: '#33a02c',
        4: '#fb9a99',
        5: '#e31a1c',
        6: '#fdbf6f',
        7: '#ff7f00',
        8: '#cab2d6',
        9: '#6a3d9a',
        10: '#ffff99',
        11: '#b15928',
    };

    // Colores para AQI
    const aqiColors = {
        1: '#00E400', // Bueno
        2: '#FFFF00', // Moderado
        3: '#FF7E00', // Insalubre
        4: '#FF0000', // Muy Insalubre
        5: '#99004c', // Malo
        6: '#800000', // Severo
    };

    // Función para actualizar la opacidad de los puntos del cluster seleccionado y agregar borde
    function updateClusterDisplay(clusterCount, selectedCluster, clusterColors) {
        svg.selectAll("circle")
            .attr("fill", d => clusterColors[d[`Kmeans_${clusterCount}`]]) // Relleno con el color del cluster
            .attr("opacity", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? 1 : 0.2) // Opacidad según selección
            .attr("stroke", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? "black" : "none") // Borde negro solo en el cluster seleccionado
            .attr("stroke-width", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? 1 : 0); // El borde negro tendrá grosor de 2 si está seleccionado, sino sin borde
    }

    function updateAQIDisplay() {
        // Obtener las fechas seleccionadas en los filtros activos
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => aqiColors[d.AQI] === undefined ? '#000000' : aqiColors[d.AQI]) // Color por AQI
            .attr("opacity", d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`) ? 1 : 0.1); // Opacar los no seleccionados
    }

    document.getElementById("cluster-3-btn").addEventListener("click", function () {
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked3) return; // Si la gráfica está bloqueada, salir de la función.

        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");


        svg.selectAll("circle")
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])
            .attr("opacity", 1);

        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-3-select").value = "";
    });

    document.getElementById("cluster-12-btn").addEventListener("click", function () {
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked3) return; // Si la gráfica está bloqueada, salir de la función.
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");


        svg.selectAll("circle")
            .attr("fill", d => kmeans12Colors[d.Kmeans_12])
            .attr("opacity", 1);

        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").value = "";
    });

    document.getElementById("cluster-4-btn").addEventListener("click", function () {
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked3) return; // Si la gráfica está bloqueada, salir de la función.


        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])
            .attr("opacity", 1);

        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-4-select").value = "";
    });


    document.getElementById("cluster-6-btn").addEventListener("click", function () {

        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");


        svg.selectAll("circle")
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])
            .attr("opacity", 1);

        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-6-select").value = "";
    });
    let filteredClusterData = data;
    let activeFilterData = data;  // Solo un filtro activo a la vez (estación, año o mes)

    document.getElementById("cluster-12-select").addEventListener("change", function () {
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_12 === selectedCluster);
        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];
        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans12Colors[selectedCluster];
        updateVisualization();
        updateClusterDisplay(12, selectedCluster, kmeans12Colors);
    });
    document.getElementById("cluster-3-select").addEventListener("change", function () {
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_3 === selectedCluster);
        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];
        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans3Colors[selectedCluster];
        updateVisualization();
        updateClusterDisplay(3, selectedCluster, kmeans3Colors);
    });
    document.getElementById("cluster-4-select").addEventListener("change", function () {


        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_4 === selectedCluster);

        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];

        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans4Colors[selectedCluster];

        // // Imprimir en consola las fechas y el color del cluster seleccionado
        // console.log("Fechas del Cluster seleccionado:", clusterDates);
        // console.log("Color del Cluster seleccionado:", clusterColor);

        updateVisualization();
        updateClusterDisplay(4, selectedCluster, kmeans4Colors);
    });


    let filteredClusterData2 = data;
    let activeFilterData2 = data;  // Solo un filtro activo a la vez (estación, año o mes)

    document.getElementById("cluster-6-select").addEventListener("change", function () {
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData2 = data.filter(d => d.Kmeans_6 === selectedCluster);

        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData2.map(d => `${d.year}-${d.month}-${d.day}`))];

        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans6Colors[selectedCluster];

        // // Imprimir en consola las fechas y el color del cluster seleccionado
        // console.log("Fechas del Cluster seleccionado:", clusterDates);
        // console.log("Color del Cluster seleccionado:", clusterColor);

        updateVisualization2();
        updateClusterDisplay(6, selectedCluster, kmeans6Colors);
    });

    document.getElementById("aqi-btn").addEventListener("click", function () {


        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        updateAQIDisplay(); // Actualiza la visualización de AQI
        updateButtonOpacity("aqi-btn");

    });


    // Función para actualizar la opacidad de los filtros
    function updateFilterOpacity(activeFilterId) {
        const filters = ["station-filter", "year-filter", "month-filter", "aqi-filter"];
        filters.forEach((filterId) => {
            const filterElement = document.getElementById(filterId);
            if (filterId === activeFilterId) {
                filterElement.classList.remove("dimmed");
            } else {
                filterElement.classList.add("dimmed");
            }
        });
    }
    // Función para determinar qué cluster está activo
    function getActiveClusterVisualizationFunction() {
        if (!document.getElementById("cluster-6-select").disabled) {
            return updateVisualization2; // Si cluster-6 está habilitado, usa updateVisualization2
        }
        if (!document.getElementById("cluster-4-select").disabled) {
            return updateVisualization; // Si cluster-4 está habilitado, usa updateVisualization
        }
        if (!document.getElementById("cluster-3-select").disabled) {
            return updateVisualization3; // Si cluster-3 está habilitado, usa updateVisualization3
        }
        if (!document.getElementById("cluster-12-select").disabled) {
            return updateVisualization4; // Si cluster-12 está habilitado, usa updateVisualization12
        }
    }

    document.getElementById('station-filter').addEventListener('change', (event) => {

        const selectedSeason = event.target.value;
        activeFilterData = filterDataBySeason(selectedSeason, data); // Actualiza el único filtro activo
        activeFilterData2 = filterDataBySeason(selectedSeason, data); // Actualiza el único filtro activo

        highlightSeason(selectedSeason, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('station-filter');
    });

    document.getElementById('year-filter').addEventListener('change', (event) => {

        const selectedYear = parseInt(event.target.value, 10);
        activeFilterData = data.filter(d => d.year === selectedYear); // Solo un filtro activo a la vez
        activeFilterData2 = data.filter(d => d.year === selectedYear); // Solo un filtro activo a la vez

        highlightYear(selectedYear, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('year-filter');
    });

    document.getElementById('month-filter').addEventListener('change', (event) => {

        const selectedMonth = event.target.value;
        activeFilterData = filterDataByMonth(selectedMonth, data); // Solo un filtro activo a la vez
        activeFilterData2 = filterDataByMonth(selectedMonth, data); // Solo un filtro activo a la vez

        highlightMonth(selectedMonth, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('month-filter');
    });

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization() {
        const clusterDates = new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates.has(date)));

        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData.filter(d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);

        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;

            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization2() {
        const clusterDates = new Set(filteredClusterData2.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates2 = new Set(activeFilterData2.map(d => `${d.year}-${d.month}-${d.day}`));

        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates2.has(date)));

        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData2.filter(d => activeFilterDates2.has(`${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates2.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);

        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;

            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }


    function updateVisualization3() {
        const clusterDates = new Set(filteredClusterData3.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates3 = new Set(activeFilterData3.map(d => `${d.year}-${d.month}-${d.day}`));
        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates3.has(date)));
        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData3.filter(d => activeFilterDates3.has(`${d.year}-${d.month}-${d.day}`));
        svg.selectAll("circle")
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates3.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);
        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    function updateVisualization4() {
        const clusterDates = new Set(filteredClusterData4.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates4 = new Set(activeFilterData4.map(d => `${d.year}-${d.month}-${d.day}`));
        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates4.has(date)));
        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData4.filter(d => activeFilterDates4.has(`${d.year}-${d.month}-${d.day}`));
        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates4.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);
        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }
    // Función para manejar la actualización de gráficos
    function handleSelectionUpdate(filteredData, selectedDates, fechaInicio, fechaFin) {
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas seleccionadas.");
            return;
        }

        // console.log("Actualizando gráficos con fechas seleccionadas:", selectedDates);
        const cityFile = filteredData.length > 0 ? filteredData[0].city : null;

        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates);
        updateRadialChartWithSelection(filteredData, fechaInicio, fechaFin);
    }
    // Función para filtrar datos por estación
    function filterDataBySeason(season, data) {
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } }
        };

        const range = seasonRanges[season];
        if (!range) return [];

        return data.filter(d => {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            return season === 'Invierno'
                ? (date >= start || date <= end)
                : (date >= start && date <= end);
        });
    }

    // Función para filtrar datos por mes
    function filterDataByMonth(month, data) {
        const monthMapping = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };
        const monthNumber = monthMapping[month];
        return data.filter(d => d.month === monthNumber);
    }

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-contaminacion");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("transform", "translate(275, -190)") // Desplazamiento hacia la derecha y abajo
        .attr("width", "45%")
        .attr("height", "45%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none") // Fondo transparente
        .style("position", "relative") // Asegura que el desplazamiento funcione correctamente
        .style("border", "1px solid black") // Agrega un borde negro de 2px
        .style("border-radius", "10px") // Bordes redondeados
        .on("contextmenu", (event) => event.preventDefault());
    // Agregar título en la parte superior izquierda
    svg.append("text")
        .attr("x", 53) // Posición horizontal (izquierda)
        .attr("y", 30) // Posición vertical (arriba)
        .attr("font-size", "30px") // Tamaño de la fuente
        .attr("font-weight", "bold") // Negrita
        .attr("fill", "black") // Color del texto
        .text("Contaminantes");

    // Agregar un checkbox al lado del título
    const checkbox = d3.select("#umap-plot-contaminacion")
        .append("input")
        .attr("type", "checkbox")
        .attr("id", "toggle-umap-contaminacion")
        .style("position", "absolute")
        .style("left", "295px") // Ajusta la posición respecto al contenedor
        .style("top", "16px") // Ajusta la posición respecto al contenedor
        .property("checked", false); // Inicia desmarcado

    // Función para resaltar el borde cuando el checkbox esté marcado
    d3.select("#toggle-umap-contaminacion").on("change", function () {
        const isChecked = d3.select(this).property("checked");

        // Cambiar el borde del SVG dependiendo del estado del checkbox
        if (isChecked) {
            svg.style("border", "1px solid #ff6347"); // Borde resaltado con color cuando está seleccionado
            enableClusterAndAQIControls2(); // Habilitar botones de clusters y AQI
            isGraphLocked2 = true; // Bloquear gráfica
            isGraphLocked_boton2 = false; // Desbloquear botones
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "all")
                .style("opacity", "1") // Habilitar botones
                .style("display", "block"); // Mostrar botones de nuevo


        } else {
            svg.style("border", "1px solid black"); // Borde normal cuando no está seleccionado
            disableClusterAndAQIControls2(); // Deshabilitar botones de clusters y AQI
            isGraphLocked2 = false; // Desbloquear gráfica
            isGraphLocked_boton2 = true;
            d3.selectAll(".legend-item-pca2, .reset-button-pca2")
                .style("pointer-events", "none")
                .style("opacity", "0.5")

        }
    });

    // Función para habilitar los controles de clusters y AQI
    function enableClusterAndAQIControls2() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
    }

    // Función para deshabilitar los controles de clusters y AQI
    function disableClusterAndAQIControls2() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }

    // Inicializar en el estado deshabilitado
    disableClusterAndAQIControls2();

    // Grupo para aplicar zoom
    const g = svg.append("g");

    // Escalas
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height, 0]);

    // Colores según el nivel de AQI
    const colorScale = d3.scaleOrdinal()
        .domain([1, 2, 3, 4, 5, 6])
        .range(['#00E400', '#FFFF00', '#FF7E00', '#FF0000', '#99004c', '#800000']);

    // Tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar puntos
    g.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 6)
        .attr("fill", d => colorScale(d.AQI))
        .attr("opacity", 1)
        .attr("stroke", "none")  // Sin borde inicialmente
        // Agregar manejador para el filtro de estación

        .on("mouseover", function (event, d) {
            tooltip.style("visibility", "visible")
                .html(`
                <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                <strong>AQI:</strong> ${d.AQI}
            `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 1);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0);
        });

    function highlightSeason(season, data, svg, xScale, yScale) {
        // Definir rangos de fechas para cada estación
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } },
        };

        const range = seasonRanges[season];
        if (!range) return;

        function isInSeason(d) {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            if (season === 'Invierno') {
                return (
                    (date >= start && d.month >= 12) ||
                    (d.month <= 3 && date <= end)
                );
            }

            return date >= start && date <= end;
        }

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => isInSeason(d))
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }

    function highlightYear(year, data, svg, xScale, yScale) {
        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.year === year)
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }

    function highlightMonth(month, data, svg, xScale, yScale) {
        const months = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };

        const monthNumber = months[month];
        if (!monthNumber) return;

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.month === monthNumber)
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }
    // Variables para la selección
    let isDrawing = false;
    let points = [];
    let selectionLine; // Para almacenar la línea de selección

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);

    svg.on("mousedown", (event) => {
        if (event.button !== 2) return; // Solo activar con anticlick (botón derecho del mouse)

        // Limpiar la selección anterior
        if (selectionLine) {
            selectionLine.remove();
        }

        isDrawing = true;
        points = []; // Reiniciar puntos

        const [startX, startY] = d3.pointer(event, g.node());
        points.push([startX, startY]);

        // Crear línea inicial
        selectionLine = g.append("polyline")
            .attr("fill", "rgba(100, 100, 255, 0.3)")
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("points", points.join(" "));

        svg.on("mousemove", (event) => {
            if (!isDrawing) return;

            const [currentX, currentY] = d3.pointer(event, g.node());
            points.push([currentX, currentY]);
            selectionLine.attr("points", points.join(" "));
        });
    });

    svg.on("mouseup", () => {
        if (!isDrawing) return;

        isDrawing = false;

        // Unir el último punto con el primero
        points.push(points[0]); // Añadir el primer punto al final para cerrar el polígono
        selectionLine.attr("points", points.join(" ")); // Actualizar la línea para incluir el cierre

        // Filtrar los puntos seleccionados dentro del polígono
        // Los puntos del lasso se capturan en coordenadas de g.node() (post-zoom),
        // por eso la proyección de datos también debe hacerse con xScale/yScale puras.
        const activeDimCols = getDimCols();
        const selectionData = data.filter(d => {
            const x = xScale(d[activeDimCols[0]]);
            const y = yScale(d[activeDimCols[1]]);
            return d3.polygonContains(points, [x, y]);
        });

        // Verificar si hay datos seleccionados
        if (selectionData.length === 0) {
            console.warn("No se seleccionaron puntos dentro del área.");
            return;
        }

        // Construir el arreglo de fechas seleccionadas
        const selectedDates = selectionData.map(d => `${d.year}-${d.month}-${d.day}`);

        // Verifica que haya fechas válidas en `selectedDates`
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas en los datos seleccionados.");
            return;
        }

        // Obtener el archivo de la ciudad seleccionada
        const cityFile = selectionData[0].city;

        // Llamar a las funciones con las fechas seleccionadas
        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates);
        updateRadialChartWithSelection(selectionData, fechaInicio, fechaFin);
        plotUMAPfusionCluster(filterDataFusion, fechaInicio, fechaFin, selectedDates, "blue");
        plotUMAPmetCluster(filterDataMet, fechaInicio, fechaFin, selectedDates, "blue");

        // Restaurar todos los puntos a su estado original
        g.selectAll("circle")
            .attr("r", 6)
            .attr("stroke", "none");

        // Resaltar puntos seleccionados dentro de g (donde viven los círculos)
        const selectedSet = new Set(selectionData.map(d => `${d.year}-${d.month}-${d.day}-${d.station || ''}`));
        g.selectAll("circle")
            .filter(d => selectedSet.has(`${d.year}-${d.month}-${d.day}-${d.station || ''}`))
            .attr("r", 8)
            .attr("stroke", "blue")
            .attr("stroke-width", 3);
    });

    // Agregar la leyenda como botones
    const legendData = [
        { color: '#00E400', label: 'Bueno', AQI: 1 },
        { color: '#FFFF00', label: 'Moderado', AQI: 2 },
        { color: '#FF7E00', label: 'Insalubre', AQI: 3 },
        { color: '#FF0000', label: 'Muy Insalubre', AQI: 4 },
        { color: '#99004c', label: 'Malo', AQI: 5 },
        { color: '#800000', label: 'Severo', AQI: 6 },
    ];

    // Crear la leyenda como botones, asegurando que esté delante de otros elementos
    if (container.select('.legend-pca').empty()) {
        const legend = container.insert('div', ':first-child')
            .attr('class', 'legend-pca')
            .style('display', 'flex')
            .style('justify-content', 'center')
            .style('align-items', 'center')
            .style('position', 'absolute')
            .style('bottom', '-1%') // Coloca la leyenda en la parte inferior del contenedor
            .style('left', '4%')
            .style('width', '90%') // Ajusta el ancho disponible
            .style('height', 'auto')
            .style('font-family', 'Arial, sans-serif')
            .style('font-weight', 'bold')
            .style('z-index', '1000') // Asegura que esté encima de cualquier cosa
            .style('pointer-events', 'all') // Permite interacciones con los botones
            .style('border-radius', '10px')
            .style('padding', '10px') // Espaciado interno para los botones
            .style('text-align', 'center');  // Centrar el texto

        legendData.forEach((item, index) => {
            const legendButton = legend.append('button')
                .attr('class', 'legend-item-pca2')
                .style('background-color', item.color)
                .style('padding', '3px 10px')
                .style('margin', '0 4px')
                .style('border-radius', '5px')
                .style('color', index > 3 ? 'white' : 'black') // Texto blanco para "Malo" y "Severo"
                .style('border', 'none')
                .style('cursor', 'pointer')
                .style('font-weight', 'bold')
                .style('text-align', 'center')  // Centrar el texto
                .style('font-size', '11px')
                .style('box-shadow', '0px 2px 5px rgba(0, 0, 0, 0.3)') // Sombra para resaltar los botones
                .text(item.label);

            // Cambiar la opacidad y agregar borde en hover
            legendButton
                .on('mouseover', () => {
                    legendButton.style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)');
                })
                .on('mouseout', () => {
                    if (!legendButton.classed('selected')) {
                        legendButton.style('box-shadow', 'none');
                    }
                });

            // Filtrar puntos al hacer clic
            legendButton.on('click', () => {
                // Quitar la sombra de todos los botones y restablecer tamaño
                if (isGraphLocked_boton2) return;
                legend.selectAll('button')
                    .style('box-shadow', 'none')
                    .style('transform', 'scale(1)')
                    .style('opacity', '0.7')  // Reducir opacidad de los otros botones
                    .classed('selected', false);

                // Agregar la clase 'selected' al botón clickeado para aplicar la sombra
                legendButton.style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)')
                    .style('transform', 'scale(1.1)') // Hacer que el botón crezca un poco
                    .style('opacity', '1')  // El botón seleccionado no pierde opacidad
                    .classed('selected', true);

                const selectedAQI = index + 1; // AQI corresponde al índice + 1

                // Filtrar puntos en el gráfico UMAP
                svg.selectAll('circle')
                    .attr('opacity', d => (d.AQI === selectedAQI ? 1 : 0.1));

                // Filtrar datos para otras visualizaciones
                const selectedData = data.filter(d => d.AQI === selectedAQI);
                const selectedDates = selectedData.map(d => `${d.year}-${d.month}-${d.day}`);

                // Actualizar otras gráficas con los datos seleccionados
                updateTimeSeriesChart(selectedData[0]?.city, fechaInicio, fechaFin, selectedDates);
                updateCorrelationMatrixnew(selectedDates);
                drawThemeRiver(selectedData[0]?.city, selectedDates);
                updateRadialChartWithSelection(selectedData, fechaInicio, fechaFin);
            });
        });

        // Agregar un botón para resetear el filtro
        legend.append('button')
            .attr('class', 'reset-button-pca2')
            .style('background-color', '#ccc')
            .style('padding', '5px 15px')
            .style('margin', '0 5px')
            .style('border-radius', '5px')
            .style('color', 'black')
            .style('border', 'none')
            .style('cursor', 'pointer')
            .style('font-size', '12px')
            .style('font-weight', 'bold')
            .style('box-shadow', '0px 2px 5px rgba(0, 0, 0, 0.3)') // Sombra para resaltar el botón
            .text('Resetear')
            .on('mouseover', function () {
                d3.select(this).style('box-shadow', '0px 0px 5px 2px rgba(0,0,0,0.5)');
            })
            .on('mouseout', function () {
                d3.select(this).style('box-shadow', 'none');
            })
            .on('click', () => {
                // Resetear opacidad de todos los puntos
                svg.selectAll('circle')
                    .attr('opacity', 1);

                // Eliminar la sombra de todos los botones y quitar la clase 'selected'
                legend.selectAll('button')
                    .style('box-shadow', 'none')
                    .style('transform', 'scale(1)')
                    .style('opacity', '1')  // Restaurar opacidad original
                    .classed('selected', false);
            });
    }

}

function plotUMAPmet(data, fechaInicio, fechaFin) {
    // Limpiar el gráfico anterior
    d3.select("#umap-plot-meteorologia").selectAll("*").remove();
    // console.log("Fechas de entrada:", fechaInicio, fechaFin);
    // Colores para Kmeans_4
    // Colores para Kmeans_3
    const kmeans3Colors = {
        0: '#1b9e77',
        1: '#d95f02',
        2: '#7570b3',
    };

    // Colores para Kmeans_4
    const kmeans4Colors = {
        0: '#66c2a5',
        1: '#fc8d62',
        2: '#8da0cb',
        3: '#e78ac3',
    };

    // Colores para Kmeans_6
    const kmeans6Colors = {
        0: '#fdae61',
        1: '#fee08b',
        2: '#d73027',
        3: '#4575b4',
        4: '#313695',
        5: '#91bfdb',
    };

    // Colores para Kmeans_12
    const kmeans12Colors = {
        0: '#a6cee3',
        1: '#1f78b4',
        2: '#b2df8a',
        3: '#33a02c',
        4: '#fb9a99',
        5: '#e31a1c',
        6: '#fdbf6f',
        7: '#ff7f00',
        8: '#cab2d6',
        9: '#6a3d9a',
        10: '#ffff99',
        11: '#b15928',
    };

    // Colores para AQI
    const aqiColors = {
        1: '#D3D3D3', // Bueno
        2: '#D3D3D3', // Moderado
        3: '#D3D3D3', // Insalubre
        4: '#D3D3D3', // Muy Insalubre
        5: '#D3D3D3', // Malo
        6: '#D3D3D3', // Severo
    };


    // Función para actualizar la opacidad de los puntos del cluster seleccionado y agregar borde
    function updateClusterDisplay(clusterCount, selectedCluster, clusterColors) {
        svg.selectAll("circle")
            .attr("fill", d => clusterColors[d[`Kmeans_${clusterCount}`]]) // Relleno con el color del cluster
            .attr("opacity", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? 1 : 0.2) // Opacidad según selección
            .attr("stroke", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? "black" : "none") // Borde negro solo en el cluster seleccionado
            .attr("stroke-width", d => d[`Kmeans_${clusterCount}`] === selectedCluster ? 1 : 0); // El borde negro tendrá grosor de 2 si está seleccionado, sino sin borde
    }

    function updateAQIDisplay() {
        // Obtener las fechas seleccionadas en los filtros activos
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => aqiColors[d.AQI] === undefined ? '#000000' : aqiColors[d.AQI]) // Color por AQI
            .attr("opacity", d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`) ? 1 : 0.1); // Opacar los no seleccionados
    }



    // Evento para el selector de cluster-3
    document.getElementById("cluster-3-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])
            .attr("opacity", 1);

        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-3-select").value = "";
    });

    // Evento para el selector de cluster-12
    document.getElementById("cluster-12-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");


        svg.selectAll("circle")
            .attr("fill", d => kmeans12Colors[d.Kmeans_12])
            .attr("opacity", 1);

        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").value = "";
    });


    // Evento para el botón de cluster-4
    document.getElementById("cluster-4-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-6-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])
            .attr("opacity", 1);

        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-4-select").value = "";
    });

    // Evento para el botón de cluster-6
    document.getElementById("cluster-6-btn").addEventListener("click", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-select").classList.remove("dimmed");
        document.getElementById("aqi-btn").classList.add("dimmed");

        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-4-select").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-3-select").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
        document.getElementById("cluster-12-select").classList.add("dimmed");

        svg.selectAll("circle")
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])
            .attr("opacity", 1);

        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("cluster-6-select").value = "";
    });
    let filteredClusterData = data;
    let activeFilterData = data;  // Solo un filtro activo a la vez (estación, año o mes)

    // Evento para el selector de cluster-12
    document.getElementById("cluster-12-select").addEventListener("change", function () {
        if (isGraphLocked2 || isGraphLocked) return;
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_12 === selectedCluster);
        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];
        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans12Colors[selectedCluster];
        updateVisualization();
        updateClusterDisplay(12, selectedCluster, kmeans12Colors);
        plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, clusterDates, clusterColor);
        plotUMAPfusionCluster(filterDataMet, fechaInicio, fechaFin, clusterDates, clusterColor);
    });

    // Evento para el selector de cluster-3
    document.getElementById("cluster-3-select").addEventListener("change", function () {
        if (isGraphLocked2 || isGraphLocked) return;
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_3 === selectedCluster);
        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];
        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans3Colors[selectedCluster];
        updateVisualization();
        updateClusterDisplay(3, selectedCluster, kmeans3Colors);
        plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, clusterDates, clusterColor);
        plotUMAPfusionCluster(filterDataMet, fechaInicio, fechaFin, clusterDates, clusterColor);
    });

    // Evento para el selector de cluster-4
    document.getElementById("cluster-4-select").addEventListener("change", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData = data.filter(d => d.Kmeans_4 === selectedCluster);
        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`))];

        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans4Colors[selectedCluster];

        // // Imprimir en consola las fechas y el color del cluster seleccionado
        // console.log("Fechas del Cluster seleccionado:", clusterDates);
        // console.log("Color del Cluster seleccionado:", clusterColor);

        updateVisualization();
        updateClusterDisplay(4, selectedCluster, kmeans4Colors);
        plotUMAPfusionCluster(filterDataFusion, fechaInicio, fechaFin, clusterDates, clusterColor);
        plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, clusterDates, clusterColor);
    });

    let filteredClusterData2 = data;
    let activeFilterData2 = data;  // Solo un filtro activo a la vez (estación, año o mes)

    // Evento para el selector de cluster-6
    document.getElementById("cluster-6-select").addEventListener("change", function () {
        if (isGraphLocked2) return; // Si la gráfica está bloqueada, salir de la función.
        if (isGraphLocked) return; // Si la gráfica está bloqueada, salir de la función.
        const selectedCluster = parseInt(this.value.replace('Cluster ', '')) - 1;
        filteredClusterData2 = data.filter(d => d.Kmeans_6 === selectedCluster);

        // Obtener las fechas únicas del cluster seleccionado
        const clusterDates = [...new Set(filteredClusterData2.map(d => `${d.year}-${d.month}-${d.day}`))];

        // Obtener el color correspondiente al cluster seleccionado
        const clusterColor = kmeans6Colors[selectedCluster];

        // // Imprimir en consola las fechas y el color del cluster seleccionado
        // console.log("Fechas del Cluster seleccionado:", clusterDates);
        // console.log("Color del Cluster seleccionado:", clusterColor);
        updateVisualization2();
        updateClusterDisplay(6, selectedCluster, kmeans6Colors);
        plotUMAPfusionCluster(filterDataFusion, fechaInicio, fechaFin, clusterDates, clusterColor);
        plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, clusterDates, clusterColor);
    });

    document.getElementById("aqi-btn").disabled = true;



    // Función para actualizar la opacidad de los filtros
    function updateFilterOpacity(activeFilterId) {
        const filters = ["station-filter", "year-filter", "month-filter", "aqi-filter"];
        filters.forEach((filterId) => {
            const filterElement = document.getElementById(filterId);
            if (filterId === activeFilterId) {
                filterElement.classList.remove("dimmed");
            } else {
                filterElement.classList.add("dimmed");
            }
        });
    }
    // Función para determinar qué cluster está activo
    function getActiveClusterVisualizationFunction() {
        if (!document.getElementById("cluster-6-select").disabled) {
            return updateVisualization2; // Si cluster-6 está habilitado, usa updateVisualization2
        }
        if (!document.getElementById("cluster-4-select").disabled) {
            return updateVisualization; // Si cluster-4 está habilitado, usa updateVisualization
        }
        if (!document.getElementById("cluster-3-select").disabled) {
            return updateVisualization3; // Si cluster-3 está habilitado, usa updateVisualization3
        }
        if (!document.getElementById("cluster-12-select").disabled) {
            return updateVisualization4; // Si cluster-12 está habilitado, usa updateVisualization12
        }
    }

    // Evento para el filtro de estación del año
    document.getElementById('station-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked) return;

        const selectedSeason = event.target.value;
        activeFilterData = filterDataBySeason(selectedSeason, data); // Actualiza el único filtro activo
        activeFilterData2 = filterDataBySeason(selectedSeason, data); // Actualiza el único filtro activo

        highlightSeason(selectedSeason, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('station-filter');
    });

    // Evento para el filtro de año
    document.getElementById('year-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked) return;

        const selectedYear = parseInt(event.target.value, 10);
        activeFilterData = data.filter(d => d.year === selectedYear); // Solo un filtro activo a la vez
        activeFilterData2 = data.filter(d => d.year === selectedYear); // Solo un filtro activo a la vez

        highlightYear(selectedYear, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('year-filter');
    });

    // Evento para el filtro de mes
    document.getElementById('month-filter').addEventListener('change', (event) => {
        if (isGraphLocked2 || isGraphLocked) return;

        const selectedMonth = event.target.value;
        activeFilterData = filterDataByMonth(selectedMonth, data); // Solo un filtro activo a la vez
        activeFilterData2 = filterDataByMonth(selectedMonth, data); // Solo un filtro activo a la vez

        highlightMonth(selectedMonth, data, svg, xScale, yScale);

        // Llama a la función de visualización correspondiente
        getActiveClusterVisualizationFunction()();
        updateFilterOpacity('month-filter');
    });

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization() {
        const clusterDates = new Set(filteredClusterData.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates = new Set(activeFilterData.map(d => `${d.year}-${d.month}-${d.day}`));

        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates.has(date)));

        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData.filter(d => activeFilterDates.has(`${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);

        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;

            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    // Función para actualizar la visualización considerando solo cluster + un filtro activo
    function updateVisualization2() {
        const clusterDates = new Set(filteredClusterData2.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates2 = new Set(activeFilterData2.map(d => `${d.year}-${d.month}-${d.day}`));

        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates2.has(date)));

        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData2.filter(d => activeFilterDates2.has(`${d.year}-${d.month}-${d.day}`));

        svg.selectAll("circle")
            .attr("fill", d => kmeans6Colors[d.Kmeans_6])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates2.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);

        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;

            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    function updateVisualization3() {
        const clusterDates = new Set(filteredClusterData3.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates3 = new Set(activeFilterData3.map(d => `${d.year}-${d.month}-${d.day}`));
        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates3.has(date)));
        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData3.filter(d => activeFilterDates3.has(`${d.year}-${d.month}-${d.day}`));
        svg.selectAll("circle")
            .attr("fill", d => kmeans3Colors[d.Kmeans_3])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates3.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);
        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }

    function updateVisualization4() {
        const clusterDates = new Set(filteredClusterData4.map(d => `${d.year}-${d.month}-${d.day}`));
        const activeFilterDates4 = new Set(activeFilterData4.map(d => `${d.year}-${d.month}-${d.day}`));
        // Intersección de fechas entre cluster y el filtro activo
        const intersectionDates = new Set([...clusterDates].filter(date => activeFilterDates4.has(date)));
        // Filtrar los datos que cumplen con la intersección de ambos filtros
        const intersectionData = filteredClusterData4.filter(d => activeFilterDates4.has(`${d.year}-${d.month}-${d.day}`));
        svg.selectAll("circle")
            .attr("fill", d => kmeans4Colors[d.Kmeans_4])  // Mantiene el color original del cluster
            .attr("opacity", d => (clusterDates.has(`${d.year}-${d.month}-${d.day}`) ||
                activeFilterDates4.has(`${d.year}-${d.month}-${d.day}`)) ? 1 : 0.3) // Los que no están en ningún filtro se atenúan
            .attr("stroke", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? "black" : "none") // Borde rojo si está en ambos filtros
            .attr("stroke-width", d => intersectionDates.has(`${d.year}-${d.month}-${d.day}`) ? 2 : 0);
        // **Actualizar gráficos con los datos de la intersección**
        if (intersectionData.length > 0) {
            const selectedDates = intersectionData.map(d => `${d.year}-${d.month}-${d.day}`);
            const cityFile = intersectionData.length > 0 ? intersectionData[0].city : null;
            handleSelectionUpdate(intersectionData, selectedDates, fechaInicio, fechaFin);
        }
    }
    // Función para manejar la actualización de gráficos
    function handleSelectionUpdate(filteredData, selectedDates, fechaInicio, fechaFin) {
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas seleccionadas.");
            return;
        }

        // console.log("Actualizando gráficos con fechas seleccionadas:", selectedDates);
        const cityFile = filteredData.length > 0 ? filteredData[0].city : null;

        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates);
        updateRadialChartWithSelection(filteredData, fechaInicio, fechaFin);
    }


    // Función para filtrar datos por estación
    function filterDataBySeason(season, data) {
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } }
        };

        const range = seasonRanges[season];
        if (!range) return [];

        return data.filter(d => {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            return season === 'Invierno'
                ? (date >= start || date <= end)
                : (date >= start && date <= end);
        });
    }

    // Función para filtrar datos por mes
    function filterDataByMonth(month, data) {
        const monthMapping = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };
        const monthNumber = monthMapping[month];
        return data.filter(d => d.month === monthNumber);
    }

    // Dimensiones del contenedor
    const container = d3.select("#umap-plot-meteorologia");
    const width = container.node().clientWidth || 800; // Default width
    const height = container.node().clientHeight || 440; // Default height

    const svg = container.append("svg")
        .attr("transform", "translate(27, -185)") // Desplazamiento hacia la derecha y abajo
        .attr("width", "45%")
        .attr("height", "45%")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .style("background", "none") // Fondo transparente
        .style("position", "relative") // Asegura que el desplazamiento funcione correctamente
        .style("border", "1px solid black") // Agrega un borde negro de 2px
        .style("border-radius", "10px") // Bordes redondeados
        .on("contextmenu", (event) => event.preventDefault());
    // Agregar título en la parte superior izquierda
    svg.append("text")
        .attr("x", 53) // Posición horizontal (izquierda)
        .attr("y", 30) // Posición vertical (arriba)
        .attr("font-size", "30px") // Tamaño de la fuente
        .attr("font-weight", "bold") // Negrita
        .attr("fill", "black") // Color del texto
        .text("Meteorologicos");

    // Agregar un checkbox al lado del título
    const checkbox = d3.select("#umap-plot-meteorologia")
        .append("input")
        .attr("type", "checkbox")
        .attr("id", "toggle-umap-meteorologia")
        .style("position", "absolute")
        .style("left", "47px") // Ajusta la posición respecto al contenedor
        .style("top", "225px") // Ajusta la posición respecto al contenedor
        .property("checked", false); // Inicia desmarcado

    // Función para resaltar el borde cuando el checkbox esté marcado
    d3.select("#toggle-umap-meteorologia").on("change", function () {
        const isChecked = d3.select(this).property("checked");

        // Cambiar el borde del SVG dependiendo del estado del checkbox
        if (isChecked) {
            svg.style("border", "1px solid #ff6347"); // Borde resaltado con color cuando está seleccionado
            enableClusterAndAQIControls3(); // Habilitar botones de clusters y AQI
            isGraphLocked3 = true; // Bloquear gráfica



        } else {
            svg.style("border", "1px solid black"); // Borde normal cuando no está seleccionado
            disableClusterAndAQIControls3(); // Deshabilitar botones de clusters y AQI
            isGraphLocked3 = false; // Desbloquear gráfica

        }
    });

    // Función para habilitar los controles de clusters y AQI
    function enableClusterAndAQIControls3() {
        document.getElementById("cluster-4-btn").disabled = false;
        document.getElementById("cluster-6-btn").disabled = false;
        document.getElementById("cluster-3-btn").disabled = false;
        document.getElementById("cluster-12-btn").disabled = false;
        document.getElementById("aqi-btn").disabled = false;
        document.getElementById("cluster-4-select").disabled = false;
        document.getElementById("cluster-6-select").disabled = false;
        document.getElementById("cluster-3-select").disabled = false;
        document.getElementById("cluster-12-select").disabled = false;
        document.getElementById("aqi-btn").classList.remove("dimmed");
        document.getElementById("cluster-4-btn").classList.remove("dimmed");
        document.getElementById("cluster-6-btn").classList.remove("dimmed");
        document.getElementById("cluster-3-btn").classList.remove("dimmed");
        document.getElementById("cluster-12-btn").classList.remove("dimmed");
    }

    // Función para deshabilitar los controles de clusters y AQI
    function disableClusterAndAQIControls3() {
        document.getElementById("cluster-4-btn").disabled = true;
        document.getElementById("cluster-6-btn").disabled = true;
        document.getElementById("cluster-3-btn").disabled = true;
        document.getElementById("cluster-12-btn").disabled = true;
        document.getElementById("aqi-btn").disabled = true;
        document.getElementById("cluster-4-select").disabled = true;
        document.getElementById("cluster-6-select").disabled = true;
        document.getElementById("cluster-3-select").disabled = true;
        document.getElementById("cluster-12-select").disabled = true;
        document.getElementById("aqi-btn").classList.add("dimmed");
        document.getElementById("cluster-4-btn").classList.add("dimmed");
        document.getElementById("cluster-6-btn").classList.add("dimmed");
        document.getElementById("cluster-3-btn").classList.add("dimmed");
        document.getElementById("cluster-12-btn").classList.add("dimmed");
    }


    // Grupo para aplicar zoom
    const g = svg.append("g");

    // Escalas
    const dimCols = getDimCols();
    const xScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[0]]))
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain(d3.extent(data, d => d[dimCols[1]]))
        .range([height, 0]);

    // Colores según el nivel de AQI
    const colorScale = d3.scaleOrdinal()
        .domain([1, 2, 3, 4, 5, 6])
        .range(['#D3D3D3', '#D3D3D3', '#D3D3D3', '#D3D3D3', '#D3D3D3', '#D3D3D3']);

    // Tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Dibujar puntos
    g.selectAll("circle")
        .data(data)
        .enter()
        .append("circle")
        .attr("cx", d => xScale(d[dimCols[0]]))
        .attr("cy", d => yScale(d[dimCols[1]]))
        .attr("r", 6)
        .attr("fill", d => colorScale(d.AQI))
        .attr("opacity", 1)
        .attr("stroke", "none")  // Sin borde inicialmente
        // Agregar manejador para el filtro de estación

        .on("mouseover", function (event, d) {
            tooltip.style("visibility", "visible")
                .html(`
                    <strong>Estación:</strong> ${getStationNameFromCity(d.city)}<br>
                    <strong>Fecha:</strong> ${d.day}/${d.month}/${d.year}<br>
                    <strong>AQI:</strong> ${d.AQI}
                `);

            d3.select(this)
                .attr("r", 10)
                .attr("stroke-width", 1);
        })
        .on("mousemove", (event) => {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function (event, d) {
            tooltip.style("visibility", "hidden");

            d3.select(this)
                .attr("r", 6)
                .attr("stroke-width", d => clusterDateSet.has(`${+d.year}-${+d.month}-${+d.day}`) ? 1 : 0);
        });

    function highlightSeason(season, data, svg, xScale, yScale) {
        // Definir rangos de fechas para cada estación
        const seasonRanges = {
            Primavera: { start: { month: 3, day: 20 }, end: { month: 6, day: 21 } },
            Verano: { start: { month: 6, day: 21 }, end: { month: 9, day: 22 } },
            Otoño: { start: { month: 9, day: 22 }, end: { month: 12, day: 21 } },
            Invierno: { start: { month: 12, day: 21 }, end: { month: 3, day: 20 } },
        };

        const range = seasonRanges[season];
        if (!range) return;

        function isInSeason(d) {
            const start = new Date(d.year, range.start.month - 1, range.start.day);
            const end = new Date(d.year, range.end.month - 1, range.end.day);
            const date = new Date(d.year, d.month - 1, d.day);

            if (season === 'Invierno') {
                return (
                    (date >= start && d.month >= 12) ||
                    (d.month <= 3 && date <= end)
                );
            }

            return date >= start && date <= end;
        }

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => isInSeason(d))
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }

    function highlightYear(year, data, svg, xScale, yScale) {
        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.year === year)
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }

    function highlightMonth(month, data, svg, xScale, yScale) {
        const months = {
            Enero: 1, Febrero: 2, Marzo: 3, Abril: 4, Mayo: 5, Junio: 6,
            Julio: 7, Agosto: 8, Septiembre: 9, Octubre: 10, Noviembre: 11, Diciembre: 12
        };

        const monthNumber = months[month];
        if (!monthNumber) return;

        svg.selectAll("circle")
            .attr("stroke", "none")
            .attr("r", 6);

        svg.selectAll("circle")
            .filter(d => d.month === monthNumber)
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("r", 8);
    }
    // Variables para la selección
    let isDrawing = false;
    let points = [];
    let selectionLine; // Para almacenar la línea de selección

    // Zoom
    const zoom = d3.zoom()
        .scaleExtent([0.5, 10])
        .on("zoom", (event) => {
            g.attr("transform", event.transform);
        });

    svg.call(zoom);
    const initialTransform = d3.zoomIdentity.translate(width / 9.5, height / 9).scale(0.79);
    svg.call(zoom).call(zoom.transform, initialTransform);

    svg.on("mousedown", (event) => {
        if (event.button !== 2) return; // Solo activar con anticlick (botón derecho del mouse)

        // Limpiar la selección anterior
        if (selectionLine) {
            selectionLine.remove();
        }

        isDrawing = true;
        points = []; // Reiniciar puntos

        const [startX, startY] = d3.pointer(event, g.node());
        points.push([startX, startY]);

        // Crear línea inicial
        selectionLine = g.append("polyline")
            .attr("fill", "rgba(100, 100, 255, 0.3)")
            .attr("stroke", "blue")
            .attr("stroke-width", 2)
            .attr("points", points.join(" "));

        svg.on("mousemove", (event) => {
            if (!isDrawing) return;

            const [currentX, currentY] = d3.pointer(event, g.node());
            points.push([currentX, currentY]);
            selectionLine.attr("points", points.join(" "));
        });
    });

    svg.on("mouseup", () => {
        if (!isDrawing) return;

        isDrawing = false;

        // Unir el último punto con el primero
        points.push(points[0]); // Añadir el primer punto al final para cerrar el polígono
        selectionLine.attr("points", points.join(" ")); // Actualizar la línea para incluir el cierre

        // Filtrar los puntos seleccionados dentro del polígono
        // Los puntos del lasso se capturan en coordenadas de g.node() (post-zoom),
        // por eso la proyección de datos también debe hacerse con xScale/yScale puras.
        const activeDimCols = getDimCols();
        const selectionData = data.filter(d => {
            const x = xScale(d[activeDimCols[0]]);
            const y = yScale(d[activeDimCols[1]]);
            return d3.polygonContains(points, [x, y]);
        });

        // Verificar si hay datos seleccionados
        if (selectionData.length === 0) {
            console.warn("No se seleccionaron puntos dentro del área.");
            return;
        }

        // Construir el arreglo de fechas (formato "YYYY-M-D" sin padding, consistente con drawThemeRiver)
        const selectedDates = [...new Set(selectionData.map(d => {
            const dt = d.date instanceof Date ? d.date : new Date(+d.year, +d.month - 1, +d.day);
            return `${dt.getFullYear()}-${dt.getMonth() + 1}-${dt.getDate()}`;
        }))];

        // Verifica que haya fechas válidas en `selectedDates`
        if (selectedDates.length === 0) {
            console.warn("No hay fechas válidas en los datos seleccionados.");
            return;
        }

        // Obtener el archivo de la ciudad seleccionada
        const cityFile = selectionData[0].city;

        // Llamar a las funciones con las fechas seleccionadas
        updateTimeSeriesChart(cityFile, fechaInicio, fechaFin, selectedDates);
        updateCorrelationMatrixnew(selectedDates);
        drawThemeRiver(cityFile, selectedDates, selectionData);
        updateRadialChartWithSelection(selectionData, fechaInicio, fechaFin);
        plotUMAPfusionCluster(filterDataFusion, fechaInicio, fechaFin, selectedDates, "blue");
        plotUMAPcontCluster(filteredDataCont, fechaInicio, fechaFin, selectedDates, "blue");

        // Restaurar todos los puntos a su estado original
        g.selectAll("circle")
            .attr("r", 6)
            .attr("stroke", "none");

        // Resaltar puntos seleccionados dentro de g (donde viven los círculos)
        const selectedSet = new Set(selectionData.map(d => `${d.year}-${d.month}-${d.day}-${d.station || ''}`));
        g.selectAll("circle")
            .filter(d => selectedSet.has(`${d.year}-${d.month}-${d.day}-${d.station || ''}`))
            .attr("r", 8)
            .attr("stroke", "blue")
            .attr("stroke-width", 3);
    });


}





function updateCorrelationMatrixnew(dates) {
    console.log("FECHAS DE LA MATRIZ NEW", dates);
    const selectedAttributes = Array.from(document.querySelectorAll('.options-chek-correlation input[type="checkbox"]:checked'))
        .map(cb => cb.value);

    if (selectedAttributes.length === 0) return;

    // Obtener las ciudades seleccionadas
    const selectedCities = Array.from(document.querySelectorAll('#city-checkboxes input[type="radio"]:checked'))
        .map(cb => cb.value);

    const visualizarTodo = document.getElementById('visualizar-todo').checked;

    selectedCities.forEach(selectedCity => {
        // Use the fusion path, not the raw 'data/' folder
        d3.csv(`${getFusionPath()}${selectedCity}`).then(data => {
            // Filtrar los datos por las fechas seleccionadas
            // Usamos formato YYYY-M-D sin padding (mismo que el resto del sistema)
            if (dates && dates.length > 0) {
                const datesSet = new Set(dates);
                data = data.filter(d => {
                    // Construir la clave sin padding para que coincida
                    const dateKey = `${+d.year}-${+d.month}-${+d.day}`;
                    return datesSet.has(dateKey);
                });
            }

            // Agrupar por fecha y hora
            const parsedData = d3.groups(data, d => `${d.year}-${d.month}-${d.day} ${d.hour}`)
                .map(([datetime, entries]) => {
                    const avg = {};
                    selectedAttributes.forEach(attr => {
                        const values = entries.map(d => +d[attr.replace('.', '_')]).filter(v => !isNaN(v));
                        avg[attr] = values.length > 0 ? d3.mean(values) : 0;
                    });
                    return avg;
                });

            console.log("Datos de Update Matrix NEW por hora", parsedData);
            const correlationMatrix = calculateCorrelationMatrix(parsedData, selectedAttributes);
            const matrizdistancia = calculateDistanceMatrix(correlationMatrix);
            const hierarchyData = buildHierarchy(selectedAttributes, matrizdistancia);

            // Crear o actualizar el dendrograma radial
            createRadialDendrogram(hierarchyData, selectedAttributes, matrizdistancia, selectedCity, dates.join(', '));
        });
    });
}


let lastEvolutionDraw = null;

async function refreshEvolutionPanelChart() {
    if (!lastEvolutionDraw || !lastEvolutionDraw.cityFile) return;
    try {
        await drawThemeRiver(
            lastEvolutionDraw.cityFile,
            lastEvolutionDraw.dates,
            lastEvolutionDraw.preloadedData
        );
    } catch (e) {
        console.warn("refreshEvolutionPanelChart:", e);
    }
}

async function drawThemeRiver(cityFile, dates, preloadedData) {
    // Normalize input dates to a consistent "YYYY-M-D" key format (no zero padding)
    // using Integer arithmetic to avoid timezone/parsing issues
    function toDateKey(d) {
        if (d instanceof Date) {
            return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        }
        // Parse ISO string like "2013-03-01" safely as local time
        const parts = String(d).split('-');
        if (parts.length === 3) {
            return `${+parts[0]}-${+parts[1]}-${+parts[2]}`; // strips leading zeros
        }
        return String(d);
    }

    const dateKeySet = new Set(dates.map(toDateKey));

    let data;
    if (preloadedData && preloadedData.length > 0) {
        // Use in-memory data directly — map to the expected shape
        data = preloadedData.map(d => ({
            date: d.date instanceof Date ? d.date : new Date(+d.year, +d.month - 1, +d.day),
            PM2_5: isNaN(+d.PM2_5) ? null : +d.PM2_5,
            PM10: isNaN(+d.PM10) ? null : +d.PM10,
            SO2: isNaN(+d.SO2) ? null : +d.SO2,
            NO2: isNaN(+d.NO2) ? null : +d.NO2,
            CO: isNaN(+d.CO) ? null : +d.CO,
            O3: isNaN(+d.O3) ? null : +d.O3,
            TEMP: isNaN(+d.TEMP) ? null : +d.TEMP,
            PRES: isNaN(+d.PRES) ? null : +d.PRES,
            DEWP: isNaN(+d.DEWP) ? null : +d.DEWP,
            RAIN: isNaN(+d.RAIN) ? null : +d.RAIN,
        }));
    } else {
        try {
            const response = await fetch(`${getFusionPath()}${cityFile}`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const csvData = await response.text();
            data = d3.csvParse(csvData, d => ({
                date: new Date(+d.year, +d.month - 1, +d.day),
                PM2_5: isNaN(+d.PM2_5) ? null : +d.PM2_5,
                PM10: isNaN(+d.PM10) ? null : +d.PM10,
                SO2: isNaN(+d.SO2) ? null : +d.SO2,
                NO2: isNaN(+d.NO2) ? null : +d.NO2,
                CO: isNaN(+d.CO) ? null : +d.CO,
                O3: isNaN(+d.O3) ? null : +d.O3,
                TEMP: isNaN(+d.TEMP) ? null : +d.TEMP,
                PRES: isNaN(+d.PRES) ? null : +d.PRES,
                DEWP: isNaN(+d.DEWP) ? null : +d.DEWP,
                RAIN: isNaN(+d.RAIN) ? null : +d.RAIN,
            }));
        } catch (e) {
            console.warn('drawThemeRiver: could not load CSV.', e);
            return;
        }
    }

    // Filter using same toDateKey function — consistent format, no timezone issues
    const filteredData = dateKeySet.size > 0
        ? data.filter(d => dateKeySet.has(toDateKey(d.date)))
        : data;

    // if (filteredData.length === 0) {
    //     alert("No se encontraron datos para las fechas seleccionadas.");
    //     return;
    // }

    const evolutionAttributeOrder = [
        "PM2_5", "PM10", "SO2", "NO2", "CO", "O3", "TEMP", "PRES", "DEWP", "RAIN"
    ];

    const attributeStats = evolutionAttributeOrder.reduce((stats, attr) => {
        const values = filteredData.map(d => d[attr]).filter(value => value !== null && !isNaN(value));
        const min = values.length ? d3.min(values) : 0;
        const max = values.length ? d3.max(values) : 1;
        stats[attr] = { min, max: max > min ? max : min + 1e-9 };
        return stats;
    }, {});

    const normalizedData = filteredData.map(d => {
        const normalized = { date: d.date };
        evolutionAttributeOrder.forEach(attr => {
            const { min, max } = attributeStats[attr];
            normalized[attr] = d[attr] !== null && !isNaN(d[attr]) && max > min
                ? (d[attr] - min) / (max - min)
                : 0.5;
        });
        return normalized;
    });

    const togglesHost = d3.select("#evolution-toggles");
    if (!togglesHost.empty() && togglesHost.selectAll("label.evolution-attr-toggle").empty()) {
        evolutionAttributeOrder.forEach(attr => {
            const lab = togglesHost.append("label")
                .attr("class", "evolution-attr-toggle")
                .style("color", attributeColors[attr] || "#333");
            lab.append("input")
                .attr("type", "checkbox")
                .attr("class", "evolution-attr-cb")
                .attr("value", attr)
                .property("checked", true);
            lab.append("span").text(attr);
        });
    }

    function getActiveEvolutionKeys() {
        return evolutionAttributeOrder.filter(attr => {
            const el = document.querySelector(`#evolution-toggles input.evolution-attr-cb[value="${attr}"]`);
            return !el || el.checked;
        });
    }

    const container = d3.select("#evolution-plot");
    container.selectAll("*").remove();

    const evolutionEl = document.getElementById("evolution");
    const plotEl = document.getElementById("evolution-plot");
    const isEvolutionMaximized = evolutionEl && evolutionEl.classList.contains("evolution-maximized");

    let outerW;
    let outerH;
    if (isEvolutionMaximized && plotEl && plotEl.clientWidth > 40 && plotEl.clientHeight > 40) {
        outerW = Math.max(200, plotEl.clientWidth);
        outerH = Math.max(160, plotEl.clientHeight);
    } else if (evolutionEl && plotEl) {
        const pad = 15;
        const maxRefW = 800;
        const maxRefH = 620;
        const availW = Math.max(160, evolutionEl.clientWidth - 2 * pad);
        const plotTop = plotEl.offsetTop;
        const availH = Math.max(120, evolutionEl.clientHeight - plotTop - pad);
        outerW = Math.min(maxRefW, availW);
        outerH = Math.min(maxRefH, availH);
    } else {
        outerW = 600;
        outerH = 420;
    }

    const margin = isEvolutionMaximized
        ? { top: 20, right: 12, bottom: 52, left: 34 }
        : { top: 24, right: 10, bottom: 70, left: 30 };
    let width = outerW - margin.left - margin.right;
    let height = outerH - margin.top - margin.bottom;
    width = Math.max(60, width);
    height = Math.max(50, height);
    if (width + margin.left + margin.right > outerW) {
        width = Math.max(40, outerW - margin.left - margin.right);
    }
    if (height + margin.top + margin.bottom > outerH) {
        height = Math.max(40, outerH - margin.top - margin.bottom);
    }

    const svg = container.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom);

    const chartGroup = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    const seasonBgGroup = chartGroup.append("g")
        .attr("class", "evolution-season-bg")
        .style("pointer-events", "none");

    const stackGen = d3.stack()
        .value((d, key) => d[key] || 0)
        .order(d3.stackOrderNone)
        .offset(d3.stackOffsetWiggle);

    const x = d3.scaleLinear()
        .domain([0, Math.max(0, normalizedData.length - 1)])
        .range([0, width]);

    const y = d3.scaleLinear()
        .domain([0, 1])
        .range([height, 0]);

    const area = d3.area()
        .x((d, i) => x(i))
        .y0(d => y(d[0]))
        .y1(d => y(d[1]));

    // Índices globales [inicio, fin] sobre normalizedData (como filtrar fechas en Serie de tiempo).
    let evolutionGlobalRange = [0, Math.max(0, normalizedData.length - 1)];

    const updateGraph = (globalDomain) => {
        const nFull = normalizedData.length;
        if (nFull === 0) return;

        let g0 = Math.max(0, Math.floor(Math.min(globalDomain[0], globalDomain[1])));
        let g1 = Math.min(nFull - 1, Math.ceil(Math.max(globalDomain[0], globalDomain[1])));
        if (g1 < g0) {
            const t = g0;
            g0 = g1;
            g1 = t;
        }
        evolutionGlobalRange = [g0, g1];

        const viewData = normalizedData.slice(g0, g1 + 1);
        const nv = viewData.length;
        if (nv === 0) return;

        x.domain([0, Math.max(0, nv - 1)]);

        const activeKeys = getActiveEvolutionKeys();
        let series = [];
        if (activeKeys.length > 0) {
            stackGen.keys(activeKeys);
            series = stackGen(viewData);
            const flat = series.flat();
            y.domain([
                d3.min(flat, d => d[0]),
                d3.max(flat, d => d[1])
            ]);
        } else {
            y.domain([0, 1]);
        }

        const stripData = viewData.map((d, i) => {
            const dt = d.date instanceof Date ? d.date : new Date(d.date);
            return { i, season: getSeason(dt) };
        });

        function evolutionStripWidth(i) {
            if (nv <= 1) return width;
            if (i < nv - 1) return Math.max(0.5, x(i + 1) - x(i));
            return Math.max(0.5, x(i) - x(i - 1));
        }

        seasonBgGroup.selectAll("rect.season-strip")
            .data(stripData, d => d.i)
            .join(
                enter => enter.append("rect").attr("class", "season-strip"),
                update => update,
                exit => exit.remove()
            )
            .attr("x", d => x(d.i))
            .attr("y", 0)
            .attr("width", d => evolutionStripWidth(d.i))
            .attr("height", height)
            .attr("fill", d => seasonColors[d.season] || "#ccc")
            .attr("opacity", 0.15);

        chartGroup.selectAll("path.stream-layer")
            .data(series, d => d.key)
            .join(
                enter => enter.append("path")
                    .attr("class", "stream-layer")
                    .attr("fill", d => attributeColors[d.key] || "#999")
                    .attr("d", area),
                update => update
                    .attr("fill", d => attributeColors[d.key] || "#999")
                    .attr("d", area),
                exit => exit.remove()
            );

        const maxTicks = 30;
        const totalVisibleDates = nv;
        const tickStep = Math.max(1, Math.ceil(totalVisibleDates / maxTicks));
        const visibleDates = d3.range(0, nv, tickStep);

        const dateTicks = visibleDates
            .filter(i => i >= 0 && i < nv)
            .map(i => ({
                index: i,
                date: viewData[i].date
            }));

        const gridLines = chartGroup.selectAll(".grid-line")
            .data(dateTicks, d => d.index);

        gridLines.enter()
            .append("line")
            .attr("class", "grid-line")
            .merge(gridLines)
            .attr("x1", d => x(d.index))
            .attr("x2", d => x(d.index))
            .attr("y1", 0)
            .attr("y2", height)
            .attr("stroke", "#000")
            .attr("stroke-opacity", 0.15)
            .attr("stroke-width", 1);

        gridLines.exit().remove();

        chartGroup.select(".x-axis")
            .call(
                d3.axisBottom(x)
                    .tickValues(visibleDates.filter(i => i >= 0 && i < nv))
                    .tickFormat(i => d3.timeFormat("%d-%m-%Y")(viewData[Math.min(Math.max(0, Math.round(i)), nv - 1)].date))
            )
            .selectAll("text")
            .attr("transform", `rotate(-45)`)
            .style("text-anchor", "end");
    };

    chartGroup.append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(
            d3.axisBottom(x)
                .ticks(20)
                .tickFormat(i => d3.timeFormat("%d-%m-%Y")(normalizedData[Math.min(Math.max(0, Math.round(i)), normalizedData.length - 1)].date))
        )
        .selectAll("text")
        .attr("transform", `rotate(-45)`)
        .style("text-anchor", "end");

    const brush = d3.brushX()
        .extent([[0, 0], [width, height]])
        .on("end", ({ selection }) => {
            if (!selection) return;

            const [px0, px1] = selection.map(x.invert);
            let l0 = Math.floor(Math.min(px0, px1));
            let l1 = Math.ceil(Math.max(px0, px1));
            const base = evolutionGlobalRange[0];
            const viewLen = evolutionGlobalRange[1] - evolutionGlobalRange[0] + 1;
            if (viewLen < 1) return;
            l0 = Math.max(0, l0);
            l1 = Math.min(viewLen - 1, l1);
            if (l1 <= l0) return;

            updateGraph([base + l0, base + l1]);
            chartGroup.select(".brush").call(brush.move, null);
        });

    chartGroup.append("g")
        .attr("class", "brush")
        .call(brush);

    svg.on("dblclick", () => {
        updateGraph([0, normalizedData.length - 1]);
    });

    d3.selectAll("#evolution-toggles input.evolution-attr-cb")
        .on("change", () => updateGraph([evolutionGlobalRange[0], evolutionGlobalRange[1]]));

    updateGraph([0, Math.max(0, normalizedData.length - 1)]);

    lastEvolutionDraw = {
        cityFile,
        dates: Array.isArray(dates) ? [...dates] : [],
        preloadedData: (preloadedData && preloadedData.length) ? preloadedData : undefined
    };
}

function initEvolutionMaximizeControls() {
    const evo = document.getElementById("evolution");
    const btn = document.getElementById("evolution-maximize-btn");
    const title = evo && evo.querySelector(".title-banner");
    if (!evo || !btn) return;

    const drag = { active: false, sx: 0, sy: 0, ol: 0, ot: 0 };

    function setMaximized(on) {
        if (on) {
            const w = Math.min(window.innerWidth * 0.92, 1100);
            const h = Math.min(window.innerHeight * 0.62, 520);
            evo.classList.add("evolution-maximized");
            evo.style.width = `${Math.round(w)}px`;
            evo.style.height = `${Math.round(h)}px`;
            evo.style.left = `${Math.round((window.innerWidth - w) / 2)}px`;
            evo.style.top = `${Math.round((window.innerHeight - h) / 2)}px`;
            btn.setAttribute("aria-pressed", "true");
            btn.title = "Restaurar";
            btn.setAttribute("aria-label", "Restaurar evolución temporal");
        } else {
            evo.classList.remove("evolution-maximized");
            evo.style.width = "";
            evo.style.height = "";
            evo.style.left = "";
            evo.style.top = "";
            btn.setAttribute("aria-pressed", "false");
            btn.title = "Maximizar";
            btn.setAttribute("aria-label", "Maximizar evolución temporal");
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => void refreshEvolutionPanelChart());
        });
    }

    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        setMaximized(!evo.classList.contains("evolution-maximized"));
    });

    if (title) {
        title.addEventListener("mousedown", (e) => {
            if (!evo.classList.contains("evolution-maximized")) return;
            if (e.target.closest && e.target.closest(".evolution-maximize-btn")) return;
            drag.active = true;
            drag.sx = e.clientX;
            drag.sy = e.clientY;
            const r = evo.getBoundingClientRect();
            drag.ol = r.left;
            drag.ot = r.top;
            e.preventDefault();
        });
    }

    window.addEventListener("mousemove", (e) => {
        if (!drag.active) return;
        const nx = drag.ol + e.clientX - drag.sx;
        const ny = drag.ot + e.clientY - drag.sy;
        const maxL = Math.max(0, window.innerWidth - evo.offsetWidth);
        const maxT = Math.max(0, window.innerHeight - evo.offsetHeight);
        evo.style.left = `${Math.max(0, Math.min(maxL, nx))}px`;
        evo.style.top = `${Math.max(0, Math.min(maxT, ny))}px`;
    });

    window.addEventListener("mouseup", () => {
        drag.active = false;
    });

    let evoResizeTimer;
    window.addEventListener("resize", () => {
        if (!evo.classList.contains("evolution-maximized")) return;
        clearTimeout(evoResizeTimer);
        evoResizeTimer = setTimeout(() => void refreshEvolutionPanelChart(), 200);
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initEvolutionMaximizeControls);
} else {
    initEvolutionMaximizeControls();
}


//GRAFICA DE DISTRIBUCION TEMPORAL GLOBAL
// Variables globales
let activeGraph = "distribucion-global-graph1"; // Track the currently active graph - Initialized to the first global graph
let globallySelectedPoints = new Set(); // Global set of selected points
currentFilename = 'China_1000.csv'; // Inicializar con un valor por defecto

// Colores para los clusters (incluyendo HDBSCAN y -1)
const clusterColors = {
    'Kmeans_3': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#1b9e77', 1: '#d95f02', 2: '#7570b3' },
    'Kmeans_4': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#66c2a5', 1: '#fc8d62', 2: '#8da0cb', 3: '#e78ac3' },
    'Kmeans_6': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#fdae61', 1: '#fee08b', 2: '#d73027', 3: '#4575b4', 4: '#313695', 5: '#91bfdb' },
    'Kmeans_12': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#a6cee3', 1: '#1f78b4', 2: '#b2df8a', 3: '#33a02c', 4: '#fb9a99', 5: '#e31a1c', 6: '#fdbf6f', 7: '#ff7f00', 8: '#cab2d6', 9: '#6a3d9a', 10: '#ffff99', 11: '#b15928' },
    'HDBSCAN_3': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#ff9999', 1: '#66b3ff', 2: '#99ff99' },
    'HDBSCAN_4': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#ff6666', 1: '#3399ff', 2: '#66cc66', 3: '#ffcc66' },
    'HDBSCAN_6': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#ff3333', 1: '#0066cc', 2: '#33cc33', 3: '#ff9933', 4: '#cc33ff', 5: '#66cccc' },
    'HDBSCAN_12': { '-1': 'rgba(128, 128, 128, 0.5)', 0: '#ff0000', 1: '#0000ff', 2: '#00ff00', 3: '#ffff00', 4: '#ff00ff', 5: '#00ffff', 6: '#990000', 7: '#000099', 8: '#009900', 9: '#999900', 10: '#990099', 11: '#009999' }
};

// Rango de fechas permitido
const minDate = new Date(2013, 2, 1);
const maxDate = new Date(2017, 1, 28);

// Filtros de fecha (globales para todas las gráficas)
// Filtros de fecha (ya declarados arriba)

// Estado de selección y transformación por gráfica
const selectionStates = {
    "distribucion-global-graph1": {
        points: [], selectedData: [], isDrawing: false, data: [], context: null, canvas: null,
        xScale: null, yScale: null, scale: 1, translateX: 0, translateY: 0,
        currentClustering: 'Kmeans_3', selectedCluster: null, currentVisualization: 'PCA'
    }
};

// Obtener los radio buttons y los botones de clustering
const clusteringRadios = document.querySelectorAll('input[name="clustering"]');
const clusterButtons = {
    3: document.getElementById('cluster-3-btn2'),
    4: document.getElementById('cluster-4-btn2'),
    6: document.getElementById('cluster-6-btn2'),
    12: document.getElementById('cluster-12-btn2')
};

// Función para actualizar el texto de los botones
function updateButtonText(method) {
    const prefix = method === 'kmeans' ? 'Kmeans' : 'HDBSCAN';
    clusterButtons[3].textContent = `${prefix} 3`;
    clusterButtons[4].textContent = `${prefix} 4`;
    clusterButtons[6].textContent = `${prefix} 6`;
    clusterButtons[12].textContent = `${prefix} 12`;
}
// Datos seleccionados para series temporales
let selectedDataForTimeSeries = null;


// Función para calcular la categoría del AQI genérica
function calculateAQICategory(value) {
    if (value <= 50) return 1;
    else if (value <= 100) return 2;
    else if (value <= 150) return 3;
    else if (value <= 200) return 4;
    else if (value <= 300) return 5;
    else return 6;
}

function getAQICategoryForCO(value) {
    if (value <= 2) return 1;
    else if (value <= 4) return 2;
    else if (value <= 6) return 3;
    else if (value <= 8) return 4;
    else if (value <= 10) return 5;
    else return 6;
}

// Evento de carga inicial
document.addEventListener('DOMContentLoaded', function () {
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');

    startDateInput.setAttribute('min', minDate.toISOString().split('T')[0]);
    startDateInput.setAttribute('max', maxDate.toISOString().split('T')[0]);
    endDateInput.setAttribute('min', minDate.toISOString().split('T')[0]);
    endDateInput.setAttribute('max', maxDate.toISOString().split('T')[0]);

    initializeCharts();

    // Cambiar dataset
    document.querySelectorAll('input[name="dataset"]').forEach(radio => {
        radio.addEventListener('change', function () {
            if (this.checked) {
                currentFilename = this.value;
                if (currentFilename.includes('pca')) dimensionality = 'pca2';
                else if (currentFilename.includes('tnse')) dimensionality = 'tsne2';
                else if (currentFilename.includes('umap')) dimensionality = 'umap2';

                // Actualizar visualización actual en todos los estados
                const vizMap = { pca2: 'PCA', tsne2: 'TSNE', umap2: 'UMAP' };
                Object.keys(selectionStates).forEach(id => {
                    selectionStates[id].currentVisualization = vizMap[dimensionality];
                });

                globallySelectedPoints = new Set();
                loadAndUpdateCharts();
            }
        });
    });

    // Cambiar método de clustering (Kmeans o HDBSCAN) en tiempo real
    clusteringRadios.forEach(radio => {
        radio.addEventListener('change', (event) => {
            const selectedMethod = event.target.value;
            updateButtonText(selectedMethod);
            updateClusteringMethod(selectedMethod);
            loadAndUpdateCharts(); // Actualizar gráficos inmediatamente
        });
    });

    // Botones y selectores de clusters
    const clusterButtonsConfig = {
        'cluster-3-btn2': { clustering: 'Kmeans_3', selectId: 'cluster-3-select2' },
        'cluster-4-btn2': { clustering: 'Kmeans_4', selectId: 'cluster-4-select2' },
        'cluster-6-btn2': { clustering: 'Kmeans_6', selectId: 'cluster-6-select2' },
        'cluster-12-btn2': { clustering: 'Kmeans_12', selectId: 'cluster-12-select2' }
    };

    // Deshabilitar todos los controles inicialmente
    Object.values(clusterButtonsConfig).forEach(item => {
        document.getElementById(item.selectId).disabled = true;
    });

    Object.keys(clusterButtonsConfig).forEach(btnId => {
        const btn = document.getElementById(btnId);
        const select = document.getElementById(clusterButtonsConfig[btnId].selectId);

        btn.addEventListener('click', function () {
            const state = selectionStates[activeGraph];
            const method = document.querySelector('input[name="clustering"]:checked').value;
            const prefix = method === 'kmeans' ? 'Kmeans' : 'HDBSCAN';
            state.currentClustering = `${prefix}_${btnId.split('-')[1]}`; // Ejemplo: HDBSCAN_3
            state.selectedCluster = null;
            globallySelectedPoints = new Set();
            updateSelectOptions(select, state.currentClustering);
            select.disabled = false;
            select.value = "";
            updateCharts();
        });
        select.addEventListener('change', function () {
            const state = selectionStates[activeGraph];
            state.selectedCluster = this.value ? parseInt(this.value) : null;
            globallySelectedPoints = new Set();

            const filteredData = state.data.filter(d =>
                d[state.currentClustering] === state.selectedCluster &&
                (!startDateFilter || d.date >= startDateFilter) &&
                (!endDateFilter || d.date <= endDateFilter)
            );
            selectedDataForTimeSeries = filteredData;
            globallySelectedPoints = new Set(filteredData.map(d => d.date.toISOString() + "_" + d.station));

            updateCharts();
            updateStationBarCharts(); // Actualizar gráfica de barras con datos filtrados

            // --- Build zero-padded ISO date strings for consistent comparison ---
            const selectedDates = [...new Set(
                filteredData
                    .filter(d => d.date instanceof Date)
                    .map(d => `${d.date.getFullYear()}-${d.date.getMonth() + 1}-${d.date.getDate()}`)
            )];
            const cityFile = (filteredData.length > 0 && filteredData[0].city)
                ? filteredData[0].city
                : currentFilename;
            const fechaInicio = document.getElementById('fecha-inicio')?.value || '';
            const fechaFin = document.getElementById('fecha-fin')?.value || '';

            // Propagate ONLY to specific visualizations
            if (typeof updateStationBarCharts === 'function')
                updateStationBarCharts(); // Linked to distribucion-espacio-temporal

            // Llamar a la función plotTimeSeries para cada atributo relevante
            const attributes = ["PM2_5", "PM10", "SO2", "NO2", "CO", "O3", "TEMP", "PRES", "DEWP", "RAIN"];
            attributes.forEach(attr => {
                plotTimeSeries(attr, filteredData); // Linked to series-temporales-global
            });
        });
    });

    // Filtro de fechas
    document.getElementById('apply-date-filter').addEventListener('click', function () {
        const startDate = document.getElementById('start-date').value;
        const endDate = document.getElementById('end-date').value;
        startDateFilter = startDate ? new Date(startDate) : null;
        endDateFilter = endDate ? new Date(endDate) : null;
        loadAndUpdateCharts();
    });

    // Estado inicial
    updateButtonText('kmeans');
    updateClusteringMethod('kmeans');
});
// Actualizar método de clustering
function updateClusteringMethod(method) {
    const prefix = method === 'kmeans' ? 'Kmeans' : 'HDBSCAN';
    Object.values(selectionStates).forEach(state => {
        const currentNumClusters = state.currentClustering.split('_')[1];
        state.currentClustering = `${prefix}_${currentNumClusters}`;
        state.selectedCluster = null;
        globallySelectedPoints = new Set();
    });

    // Actualizar selectores
    const clusterButtonsConfig = {
        'cluster-3-btn2': `${prefix}_3`,
        'cluster-4-btn2': `${prefix}_4`,
        'cluster-6-btn2': `${prefix}_6`,
        'cluster-12-btn2': `${prefix}_12`
    };
    Object.keys(clusterButtonsConfig).forEach(btnId => {
        const selectId = btnId.replace('btn2', 'select2');
        const select = document.getElementById(selectId);
        updateSelectOptions(select, clusterButtonsConfig[btnId]);
    });
}

// Actualizar opciones del selector dinámicamente
function updateSelectOptions(select, clustering) {
    select.innerHTML = '<option value="" disabled selected>Elegir Cluster</option>';
    const numClusters = Object.keys(clusterColors[clustering]).length;
    for (let i = -1; i < numClusters - 1; i++) { // Incluye -1 para HDBSCAN
        const option = document.createElement('option');
        option.value = i;
        option.textContent = i === -1 ? 'Ruido (-1)' : `Cluster ${i + 1}`;
        option.style.backgroundColor = clusterColors[clustering][i];
        select.appendChild(option);
    }
}
// Inicializar gráficos
function initializeCharts() {
    setupChart("fusion", currentFilename, "distribucion-global-graph1");
}

// Cargar datos y actualizar gráficos
function loadAndUpdateCharts() {
    ["distribucion-global-graph1"].forEach(graphId => {
        const state = selectionStates[graphId];
        state.data = [];
        state.selectedData = [];
        state.points = [];
        state.scale = 1;
        state.translateX = 0;
        state.translateY = 0;
        loadChartData(graphId);
    });
}

// Actualizar gráficos sin recargar datos
function updateCharts() {
    ["distribucion-global-graph1"].forEach(graphId => {
        const state = selectionStates[graphId];
        if (state.context && state.data.length > 0) {
            renderChart(graphId, state.data);
        }
    });
}


// Configurar gráfico de dispersión
function setupChart(tipo, filename, graphId) {
    const margin = { top: 50, right: 50, bottom: 50, left: 50 };
    const width = 450 - margin.left - margin.right;
    const height = 250 - margin.top - margin.bottom;

    const canvas = d3.select(`#${graphId}`)
        .append("canvas")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .style("border", "1px solid black")
        .style("border-radius", "5px");

    const context = canvas.node().getContext("2d");
    context.translate(margin.left, margin.top);

    const state = selectionStates[graphId];
    state.canvas = canvas;
    state.context = context;

    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("opacity", 0)
        .style("position", "absolute")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    let isPanning = false;
    let startX, startY;

    loadChartData(graphId);



    // Eventos de interacción
    canvas.on("mousedown", function (event) {
        if (event.button === 2) {
            state.isDrawing = true;
            state.points = [];
            state.selectedData = [];
            const [x, y] = d3.pointer(event, this);
            const adjustedX = (x - margin.left - state.translateX) / state.scale;
            const adjustedY = (y - margin.top - state.translateY) / state.scale;
            state.points.push([adjustedX, adjustedY]);
            renderChart(graphId, state.data);
        } else if (!isPanning) {
            isPanning = true;
            [startX, startY] = d3.pointer(event, this);
        }
    });

    canvas.on("mousemove", function (event) {
        if (state.isDrawing) {
            const [x, y] = d3.pointer(event, this);
            const adjustedX = (x - margin.left - state.translateX) / state.scale;
            const adjustedY = (y - margin.top - state.translateY) / state.scale;
            state.points.push([adjustedX, adjustedY]);
            renderChart(graphId, state.data);
        } else if (isPanning) {
            const [currentX, currentY] = d3.pointer(event, this);
            state.translateX += currentX - startX;
            state.translateY += currentY - startY;
            startX = currentX;
            startY = currentY;
            renderChart(graphId, state.data);
        } else {
            const [x, y] = d3.pointer(event, this);
            const adjustedX = (x - margin.left - state.translateX) / state.scale;
            const adjustedY = (y - margin.top - state.translateY) / state.scale;
            const closestPoint = findClosestPoint(state.data, adjustedX, adjustedY, state.xScale, state.yScale, state.scale, state.currentVisualization);

            if (closestPoint) {
                const country = closestPoint.city ? closestPoint.city.split('_')[0] : 'N/A';

                // Obtener el nombre real de la estación a partir del ID
                const allStationObjs = (stationMeta && stationMeta.stations) ? Object.values(stationMeta.stations).flat() : [];
                const stationObj = allStationObjs.find(s => String(s.id) === String(closestPoint.station));
                const stationName = stationObj ? stationObj.name : closestPoint.station;

                tooltip.transition().duration(200).style("opacity", 0.9);
                tooltip.html(`Fecha: ${closestPoint.date.toLocaleDateString()}<br>País: ${country}<br>Estación: ${stationName}<br>Cluster: ${closestPoint[state.currentClustering] + 1}`)
                    .style("left", (event.pageX + 5) + "px")
                    .style("top", (event.pageY - 28) + "px");
            } else {
                tooltip.transition().duration(500).style("opacity", 0);
            }
        }
    });

    canvas.on("mouseup", function (event) {
        if (state.isDrawing) {
            state.isDrawing = false;
            if (state.points.length < 3) {
                state.points = [];
                renderChart(graphId, state.data);
                return;
            }
            state.points.push(state.points[0]);
            const dimCols = getDimCols();
            state.selectedData = state.data.filter(d =>
                d3.polygonContains(state.points, [state.xScale(d[dimCols[0]]), state.yScale(d[dimCols[1]])])
            );
            globallySelectedPoints = new Set(state.selectedData.map(d => d.date.toISOString() + "_" + d.station));
            selectedDataForTimeSeries = state.selectedData;
            updateStationBarCharts();
            console.log(`Puntos seleccionados en ${graphId}:`, state.selectedData.length > 0 ?
                state.selectedData.map(d => `Fecha: ${d.date.toLocaleDateString()}, Estación: ${d.station}`) :
                `No se seleccionaron puntos.`);
            updateCharts();

            // Build date keys from the Date object
            selectedDataForTimeSeries = state.selectedData;

            // Propagate ONLY to specific visualizations
            if (typeof updateStationBarCharts === 'function')
                updateStationBarCharts(); // Linked to distribucion-espacio-temporal

            // Llamar a la función plotTimeSeries para cada atributo relevante
            const attributes = ["PM2_5", "PM10", "SO2", "NO2", "CO", "O3", "TEMP", "PRES", "DEWP", "RAIN"];
            attributes.forEach(attr => {
                plotTimeSeries(attr, state.selectedData); // Linked to series-temporales-global
            });
        } else {
            isPanning = false;
        }
    });

    canvas.on("contextmenu", event => event.preventDefault());
    canvas.on("mouseleave", () => {
        isPanning = false;
        tooltip.transition().duration(500).style("opacity", 0);
    });

    canvas.on("wheel", function (event) {
        event.preventDefault();
        const delta = event.deltaY;
        const zoomFactor = delta > 0 ? 0.95 : 1.05;
        const [mouseX, mouseY] = d3.pointer(event, this);
        const adjustedMouseX = mouseX - margin.left;
        const adjustedMouseY = mouseY - margin.top;

        const newScale = Math.min(Math.max(state.scale * zoomFactor, 0.1), 10);
        state.translateX = adjustedMouseX - (adjustedMouseX - state.translateX) * (newScale / state.scale);
        state.translateY = adjustedMouseY - (adjustedMouseY - state.translateY) * (newScale / state.scale);
        state.scale = newScale;

        renderChart(graphId, state.data);
    });
}


// Cargar datos del gráfico
function loadChartData(graphId) {
    let filename;
    let isGlobal = graphId.includes('global');

    if (isGlobal) {
        // Para gráficos globales, usar siempre los archivos "unido" si están disponibles
        const selectedDatasetRadio = document.querySelector('input[name="dataset"]:checked');
        filename = selectedDatasetRadio ? selectedDatasetRadio.value : "pca_unido_promediado2.csv";
    } else {
        filename = currentFilename;
    }

    const basePath = filename.includes('promediado') ? 'NEW_MODEL_DCAE/fusion/data_unida/' : getFusionPath();
    const filePath = `${basePath}${filename}`;

    d3.csv(filePath).then(data => {
        data.forEach(d => {
            d.date = new Date(+d.year, +d.month - 1, +d.day);
            d.PCA1 = +d.PCA1; d.PCA2 = +d.PCA2;
            d.TSNE1 = +d.TSNE1; d.TSNE2 = +d.TSNE2;
            d.UMAP1 = +d.UMAP1; d.UMAP2 = +d.UMAP2;
            d.Kmeans_3 = +d.Kmeans_3; d.Kmeans_4 = +d.Kmeans_4;
            d.Kmeans_6 = +d.Kmeans_6; d.Kmeans_12 = +d.Kmeans_12;
            d.HDBSCAN_3 = +d.HDBSCAN_3; d.HDBSCAN_4 = +d.HDBSCAN_4;
            d.HDBSCAN_6 = +d.HDBSCAN_6; d.HDBSCAN_12 = +d.HDBSCAN_12;
            d.PM2_5 = +d.PM2_5; d.PM10 = +d.PM10; d.SO2 = +d.SO2;
            d.NO2 = +d.NO2; d.CO = +d.CO; d.O3 = +d.O3;
            d.TEMP = +d.TEMP; d.PRES = +d.PRES; d.DEWP = +d.DEWP;
            d.RAIN = +d.RAIN; d.WSPM = +d.WSPM;
            d.AQI = +d.AQI;
            d.city = d.city || "";
        });

        // Aplicar filtros de fecha y de país (solo mostrar puntos del país actual)
        const filteredData = data.filter(d =>
            (!startDateFilter || d.date >= startDateFilter) &&
            (!endDateFilter || d.date <= endDateFilter) &&
            (d.city && d.city.startsWith(currentCountry))
        );

        const state = selectionStates[graphId];
        state.data = filteredData;
        state.xScale = d3.scaleLinear().domain(d3.extent(filteredData, d => d[state.currentVisualization + '1'])).range([0, 450 - 100]);
        state.yScale = d3.scaleLinear().domain(d3.extent(filteredData, d => d[state.currentVisualization + '2'])).range([250 - 100, 0]);

        renderChart(graphId, filteredData);
    }).catch(error => console.error("Error loading CSV:", error));
}

// Funciones de inicialización y actualización
function initializeCharts() {
    setupChart("fusion", currentFilename, "distribucion-global-graph1");
}

function loadAndUpdateCharts() {
    ["distribucion-global-graph1"].forEach(graphId => {
        const state = selectionStates[graphId];
        state.data = [];
        state.selectedData = [];
        state.points = [];
        state.scale = 1;
        state.translateX = 0;
        state.translateY = 0;
        loadChartData(graphId);
    });
}

function updateCharts() {
    ["distribucion-global-graph1"].forEach(graphId => {
        const state = selectionStates[graphId];
        if (state.context && state.data.length > 0) {
            renderChart(graphId, state.data);
        }
    });
}

// Encontrar punto más cercano para tooltip
function findClosestPoint(data, x, y, xScale, yScale, scale, visualization) {
    let closestPoint = null;
    let minDistance = Infinity;
    data.forEach(d => {
        const dx = xScale(d[visualization + '1']) - x;
        const dy = yScale(d[visualization + '2']) - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance && distance < 5 / scale) {
            minDistance = distance;
            closestPoint = d;
        }
    });
    return closestPoint;
}
// Renderizar gráfico
function renderChart(graphId, data) {
    const state = selectionStates[graphId];
    const context = state.context;
    const width = 450 - 100;
    const height = 250 - 100;

    context.save();
    context.clearRect(-50, -50, width + 100, height + 100);
    context.translate(state.translateX, state.translateY);
    context.scale(state.scale, state.scale);

    const xScale = state.xScale.domain(d3.extent(data, d => d[state.currentVisualization + '1']));
    const yScale = state.yScale.domain(d3.extent(data, d => d[state.currentVisualization + '2']));

    data.forEach(d => {
        const x = xScale(d[state.currentVisualization + '1']);
        const y = yScale(d[state.currentVisualization + '2']);
        const key = d.date.toISOString() + "_" + d.station;
        const isSelected = globallySelectedPoints.has(key);
        const clusterValue = d[state.currentClustering];
        const isClusterSelected = state.selectedCluster !== null && clusterValue === state.selectedCluster;

        context.beginPath();
        context.arc(x, y, 2 / state.scale, 0, 2 * Math.PI);

        if (globallySelectedPoints.size > 0) {
            context.globalAlpha = isSelected ? 1 : 0.3;
            context.fillStyle = clusterColors[state.currentClustering][clusterValue] || clusterColors[state.currentClustering]['-1'];
            context.fill();
            if (isSelected) {
                context.strokeStyle = 'black';
                context.lineWidth = 1 / state.scale;
                context.stroke();
            }
        } else if (state.selectedCluster !== null) {
            context.globalAlpha = isClusterSelected ? 1 : 0.3;
            context.fillStyle = clusterColors[state.currentClustering][clusterValue] || clusterColors[state.currentClustering]['-1'];
            context.fill();
            if (isClusterSelected) {
                context.strokeStyle = 'black';
                context.lineWidth = 1 / state.scale;
                context.stroke();
            }
        } else {
            context.globalAlpha = 1;
            context.fillStyle = clusterColors[state.currentClustering][clusterValue] || clusterColors[state.currentClustering]['-1'];
            context.fill();
        }
    });

    if (state.isDrawing && state.points.length > 0) {
        context.globalAlpha = 1;
        context.beginPath();
        context.moveTo(state.points[0][0], state.points[0][1]);
        state.points.forEach(point => context.lineTo(point[0], point[1]));
        context.strokeStyle = 'blue';
        context.lineWidth = 2 / state.scale;
        context.stroke();
    }

    context.restore();
}
// Encontrar punto más cercano para tooltip (corregido)
function findClosestPoint(data, x, y, xScale, yScale, scale, visualization) {
    let closestPoint = null;
    let minDistance = Infinity;
    data.forEach(d => {
        const dx = xScale(d[visualization + '1']) - x;
        const dy = yScale(d[visualization + '2']) - y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < minDistance && distance < 5 / scale) {
            minDistance = distance;
            closestPoint = d;
        }
    });
    return closestPoint;
}

function updateStationBarCharts() {
    const aqiColors = ['#00e400', '#ff0', '#ff7e00', '#f00', '#99004c', '#7e0023'];

    // Colores por temporada meteorológica (diciembre-noviembre)
    const seasonColors = {
        'Invierno': '#1f78b4',
        'Primavera': '#2ca25f',
        'Verano': '#d95f0e',
        'Otoño': '#7570b3'
    };

    // Asignar temporada a cada número de mes (1-12)
    function monthToSeason(month) {
        if (month === 12 || month <= 2) return 'Invierno';
        if (month >= 3 && month <= 5) return 'Primavera';
        if (month >= 6 && month <= 8) return 'Verano';
        return 'Otoño'; // 9, 10, 11
    }

    const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

    // Determinar los datos base
    let dataSource = selectedDataForTimeSeries || [];
    const firstGlobalState = selectionStates['distribucion-global-graph1'];
    if (dataSource.length === 0 && firstGlobalState && firstGlobalState.data) {
        dataSource = firstGlobalState.data.filter(d => d.city && d.city.startsWith(currentCountry));
    }

    const stationsToProcess = stations.map(s => ({ ...s, country: currentCountry }));

    // Calcular el rango temporal
    let range = stationMeta ? stationMeta.ranges[currentCountry] : { min: '2013-03-01', max: '2017-02-28' };
    if (dataSource.length > 0) {
        const dates = dataSource.map(d => d.date instanceof Date ? d.date : new Date(d.date));
        range = { min: new Date(Math.min(...dates)), max: new Date(Math.max(...dates)) };
    }

    // Generar lista de meses en el rango [min, max]
    const minDate = new Date(range.min);
    const maxDate = new Date(range.max);
    const months = [];   // { year, month, season, label, start, end }
    let cur = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
    while (cur <= maxDate) {
        const y = cur.getFullYear();
        const m = cur.getMonth() + 1;             // 1-12
        const end = new Date(y, m, 0);              // último día del mes
        months.push({
            year: y,
            month: m,
            season: monthToSeason(m),
            label: `${monthNames[m - 1]} ${y}`,
            start: new Date(y, m - 1, 1),
            end: end < maxDate ? end : maxDate
        });
        cur = new Date(y, m, 1);  // primer día del siguiente mes
    }

    // Contar días y AQI promedio por estación × mes
    const counts = {};
    const aqiAvgs = {};
    const dataByStation = d3.group(dataSource, d => String(d.station));

    stationsToProcess.forEach(s => {
        const sid = String(s.id);
        const name = s.name;
        const sData = dataByStation.get(sid) || [];
        counts[name] = {};
        aqiAvgs[name] = {};
        months.forEach(mo => {
            const filtered = sData.filter(item => {
                const dt = item.date instanceof Date ? item.date : new Date(item.date);
                return dt >= mo.start && dt <= mo.end;
            });
            counts[name][mo.label] = filtered.length;
            const sumAQI = filtered.reduce((a, item) => a + (item.AQI || 0), 0);
            aqiAvgs[name][mo.label] = filtered.length > 0 ? Math.round(sumAQI / filtered.length) : 0;
        });
    });

    d3.select("#distribucion-espacio-temporal-graph").selectAll("*").remove();

    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0,0,0,0.85)")
        .style("color", "#fff")
        .style("padding", "8px 12px")
        .style("border-radius", "4px")
        .style("font-size", "12px")
        .style("z-index", "2000")
        .style("box-shadow", "0 2px 5px rgba(0,0,0,0.5)");

    const totalStations = stationsToProcess.length;

    stationsToProcess.forEach((s, index) => {
        const name = s.name;
        const sid = s.id;
        const country = s.country || currentCountry;
        const isLast = index === totalStations - 1;

        const stationDiv = d3.select("#distribucion-espacio-temporal-graph")
            .append("div")
            .attr("class", "station-graph")
            .style("margin-bottom", "-1px")
            .style("display", "flex")
            .style("align-items", isLast ? "flex-start" : "center");

        // Etiqueta de la estación
        stationDiv.append("div")
            .style("width", "100px")
            .style("min-width", "100px")
            .style("text-align", "right")
            .style("padding-right", "10px")
            .style("font-size", "11px")
            .style("color", "#2D6A4F")
            .style("font-weight", "bold")
            .style("line-height", "1.1")
            .style("margin-top", isLast ? "13px" : "0px")
            .text(name);

        // Contenedor vertical para las gráficas y leyendas (para que se apilen abajo si es la última)
        const chartWrapper = stationDiv.append("div")
            .style("display", "flex")
            .style("flex-direction", "column");

        const targetBarHeight = 35;
        const marginBars = { top: 2, right: 0, bottom: 2, left: 0 };
        const svgHBars = targetBarHeight + marginBars.top + marginBars.bottom;
        const svgW = 800;
        const W = svgW - marginBars.left - marginBars.right;
        const H = targetBarHeight;

        // SVG para las BARRAS (con su borde de CSS)
        const svgBars = chartWrapper.append("svg").attr("width", svgW).attr("height", svgHBars);
        const gBars = svgBars.append("g").attr("transform", `translate(${marginBars.left},${marginBars.top})`);

        // Datos: un punto por mes
        const barData = months.map(mo => ({
            label: mo.label,
            year: mo.year,
            month: mo.month,
            season: mo.season,
            count: counts[name][mo.label] || 0,
            aqiAvg: aqiAvgs[name][mo.label] || 0,
            start: mo.start,
            end: mo.end
        }));

        const xScale = d3.scaleBand()
            .domain(barData.map(d => d.label))
            .range([0, W])
            .padding(0.04);

        const yScale = d3.scaleLinear()
            .domain([0, 31])
            .range([H, 0]);

        // Fondo suave por temporada
        gBars.selectAll(".season-bg")
            .data(barData)
            .enter().append("rect")
            .attr("class", "season-bg")
            .attr("x", d => xScale(d.label))
            .attr("y", 0)
            .attr("width", xScale.bandwidth())
            .attr("height", H)
            .attr("fill", d => seasonColors[d.season] || "#ccc")
            .attr("opacity", 0.08);

        // Barras (mes) coloreadas por AQI
        gBars.selectAll(".bar")
            .data(barData)
            .enter().append("rect")
            .attr("class", "bar")
            .attr("x", d => xScale(d.label))
            .attr("y", d => yScale(d.count))
            .attr("width", xScale.bandwidth())
            .attr("height", d => H - yScale(d.count))
            .attr("fill", d => {
                if (d.aqiAvg === 0) return "rgba(200,200,200,0.25)";
                return aqiColors[Math.min(Math.floor(d.aqiAvg / 50), 5)];
            })
            .attr("stroke", d => seasonColors[d.season] || "#aaa")
            .attr("stroke-width", 0.6)
            .on("mouseover", function (event, d) {
                const aqiTxt = d.aqiAvg === 0 ? "Sin datos" : d.aqiAvg;
                const dS = d.start.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
                const dE = d.end.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
                tooltip.style("visibility", "visible")
                    .html(`<strong>País:</strong> ${country}<br>
                           <strong>Estación:</strong> ${name}<br>
                           <strong>Mes:</strong> ${d.label}<br>
                           <strong>Rango:</strong> ${dS} - ${dE}<br>
                           <strong>Temporada:</strong> ${d.season}<br>
                           <strong>Días con datos:</strong> ${d.count}<br>
                           <strong>Promedio AQI:</strong> ${aqiTxt}`);
            })
            .on("mousemove", function (event) {
                tooltip.style("top", (event.pageY - 10) + "px")
                    .style("left", (event.pageX + 15) + "px");
            })
            .on("mouseout", function () { tooltip.style("visibility", "hidden"); })
            .on("click", function (event, d) {
                d3.selectAll(".bar").style("stroke-width", 0.6);
                d3.select(this).style("stroke-width", 2).style("stroke", "#000");
                const src = selectedDataForTimeSeries || [];
                const filtered = src.filter(item => {
                    const dt = item.date instanceof Date ? item.date : new Date(item.date);
                    return dt >= d.start && dt <= d.end && String(item.station) === String(sid);
                });
                if (filtered.length > 0)
                    generateStackedBarPlot(filtered, s, { start: d.start, end: d.end, label: d.label, season: d.season });
            });

        // Separadores
        barData.forEach((d, i) => {
            if (i === barData.length - 1) return;
            const next = barData[i + 1];
            const isY = next.year !== d.year;
            const isS = next.season !== d.season;
            if (isY || isS) {
                gBars.append("line")
                    .attr("x1", xScale(d.label) + xScale.bandwidth())
                    .attr("x2", xScale(d.label) + xScale.bandwidth())
                    .attr("y1", 0).attr("y2", H)
                    .attr("stroke", isY ? "#333" : seasonColors[d.season])
                    .attr("stroke-width", isY ? 1.5 : 0.8)
                    .attr("stroke-dasharray", isY ? "3,3" : "1,2")
                    .attr("opacity", isY ? 1 : 0.6);
            }
        });

        // Eje X y Años (solo última estación, en un SEGUNDO SVG sin borde)
        if (isLast) {
            const marginLabels = { top: 5, right: 0, bottom: 5, left: 0 };
            const svgHLabels = 25;
            const svgLabels = chartWrapper.append("svg")
                .attr("width", svgW)
                .attr("height", svgHLabels);
            const gLabels = svgLabels.append("g")
                .attr("transform", `translate(${marginLabels.left},${marginLabels.top})`);

            // Quitar el borde explícitamente
            svgLabels.style("border", "none").style("margin-top", "0px");

            const years = [...new Set(barData.map(d => d.year))];
            const yearTicks = years.map(yr => {
                const items = barData.filter(d => d.year === yr);
                const mid = items[Math.floor(items.length / 2)];
                return { year: yr, label: mid.label };
            });

            const xAxis = d3.axisBottom(xScale)
                .tickValues(yearTicks.map(d => d.label))
                .tickFormat((d, i) => yearTicks[i].year);

            gLabels.append("g")
                .call(xAxis)
                .selectAll("text")
                .style("font-size", "11px").style("font-weight", "bold").style("fill", "#333");

            gLabels.select(".domain").remove();
            gLabels.selectAll(".tick line").remove();
        }
    });
}

// Eliminado placeholder duplicado



// Atributos y colores para contaminantes (menos saturados)
const attributesCONT = ['PM2_5', 'PM10', 'SO2', 'NO2', 'CO', 'O3'];
const attributeColorsCONT = {
    'PM2_5': '#FF6666', // Rojo suave
    'PM10': '#FFBB66',  // Naranja suave
    'SO2': '#FFEE99',   // Amarillo suave
    'NO2': '#DD99DD',   // Púrpura suave
    'CO': '#66D9E8',    // Turquesa suave
    'O3': '#6666FF'     // Azul suave
};

// Atributos y colores para meteorología
const attributesMET = ['TEMP', 'PRES', 'DEWP', 'RAIN', 'WSPM', 'WD'];
const attributeColorsMET = {
    'TEMP': '#008000',  // Verde
    'PRES': '#8B0000',  // Rojo oscuro
    'DEWP': '#4B0082',  // Púrpura
    'RAIN': '#1E90FF',  // Azul claro
    'WSPM': '#7f8c8d',  // Gris
    'WD': '#95a5a6'     // Gris claro
};

// Unidades de medida para meteorología
const metUnits = {
    'TEMP': '°C',
    'PRES': 'hPa',
    'DEWP': '°C',
    'RAIN': 'mm',
    'WSPM': 'm/s',
    'WD': '°'
};

function generateStackedBarPlot(filteredData, station, selectedRange) {
    // Agrupar datos por día y calcular promedios para contaminantes y meteorología
    const dailyData = {};
    filteredData.forEach(item => {
        const dayKey = item.date.toLocaleDateString();
        if (!dailyData[dayKey]) {
            dailyData[dayKey] = { count: 0, date: item.date };
            attributesCONT.forEach(attr => dailyData[dayKey][attr] = 0);
            attributesMET.forEach(attr => dailyData[dayKey][attr] = 0);
        }
        dailyData[dayKey].count += 1;
        attributesCONT.forEach(attr => dailyData[dayKey][attr] += item[attr] || 0);
        attributesMET.forEach(attr => dailyData[dayKey][attr] += item[attr] || 0);
    });

    // Calcular promedios diarios y preparar datos
    const data = Object.entries(dailyData).map(([day, values]) => {
        const averages = { day, date: values.date };
        attributesCONT.forEach(attr => {
            averages[attr] = values.count > 0 ? values[attr] / values.count : 0;
        });
        attributesMET.forEach(attr => {
            averages[attr] = values.count > 0 ? values[attr] / values.count : 0;
        });
        return averages;
    });

    // Ordenar por fecha usando el objeto Date guardado
    data.sort((a, b) => a.date - b.date);

    // Normalizar datos meteorológicos
    const metMinMax = {};
    attributesMET.forEach(attr => {
        const values = data.map(d => d[attr]).filter(v => v !== null && !isNaN(v));
        metMinMax[attr] = {
            min: d3.min(values),
            max: d3.max(values)
        };
    });

    data.forEach(d => {
        attributesMET.forEach(attr => {
            const min = metMinMax[attr].min;
            const max = metMinMax[attr].max;
            d[attr + '_norm'] = (max - min) === 0 ? 0 : (d[attr] - min) / (max - min);
        });
    });

    // Generar el gráfico
    createStackedBarPlot(data, station, selectedRange);
}

function createStackedBarPlot(data, station, selectedRange) {
    // Contenedor principal para los gráficos
    const graphContainer = d3.select("#distribucion-por-periodo-graph")
        .style("display", "flex")
        .style("flex-wrap", "wrap")
        .style("gap", "40px") // Aumentado de 20px a 40px para más separación horizontal
        .style("overflow-y", "auto")
        .style("max-height", "600px"); // Ajusta la altura máxima según tus necesidades

    // Crear un nuevo contenedor para este gráfico
    const graphId = `graph-${Date.now()}`; // ID único para cada gráfico
    const graphWrapper = graphContainer.append("div")
        .attr("id", graphId)
        .style("position", "relative")
        .style("width", "calc(50% - 20px)") // Ajustado de 10px a 20px para mantener proporción con el gap
        .style("margin-bottom", "-20px")
        .style("margin-left", "-10px") // Aumentado de 10px a 20px para más separación horizontal


    // Agregar la "X" para eliminar el gráfico
    graphWrapper.append("div")
        .style("position", "absolute")
        .style("top", "50px") // Movido de 10px a 50px para bajar la "X"
        .style("right", "35px")
        .style("cursor", "pointer")
        .style("font-size", "16px")
        .style("color", "red")
        .style("background", "white") // Fondo blanco
        .style("border", "1px solid red") // Borde rojo
        .style("border-radius", "5px") // Bordes redondeados
        .style("padding", "2px 6px") // Espaciado interno
        .style("box-shadow", "1px 1px 5px rgba(0, 0, 0, 0.2)") // Sombra para resaltar
        .text("X")
        .on("click", function () {
            d3.select(`#${graphId}`).remove(); // Eliminar el gráfico al hacer clic en la "X"
        });

    // Configurar el SVG con más espacio en la parte superior para la leyenda
    const margin = { top: 60, right: 60, bottom: 88, left: 40 }; // Aumentar top para la leyenda
    const width = 450 - margin.left - margin.right;
    const height = 380 - margin.top - margin.bottom;

    const svg = graphWrapper.append("svg")
        .attr("width", width + margin.left + margin.right)
        .attr("height", height + margin.top + margin.bottom)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top + 40})`); // Mover el gráfico hacia abajo

    // Agregar título (nombre de la estación)
    svg.append("text")
        .attr("x", width / 2)
        .attr("y", -80) // Ajustar posición Y del título
        .attr("text-anchor", "middle")
        .attr("font-size", "16px")
        .attr("font-weight", "bold")
        .text(station.name || station);

    // Agregar subtítulo (temporada, rango de fechas y estación)
    const startStr = selectedRange.start.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
    const endStr = selectedRange.end.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
    svg.append("text")
        .attr("x", width / 2)
        .attr("y", -60) // Ajustar posición Y del subtítulo
        .attr("text-anchor", "middle")
        .attr("font-size", "12px")
        .text(`${selectedRange.season} (${startStr} - ${endStr})`);

    // Crear la leyenda centrada
    const lineLength = 20; // Longitud de la línea
    const spacingX = 80; // Espacio horizontal entre elementos
    const spacingY = 15; // Espacio vertical entre filas
    const legendYStart = -40; // Posición inicial en Y (debajo del subtítulo)

    // Calcular el ancho estimado de cada elemento (línea + espacio + texto aproximado)
    const itemWidth = spacingX; // Usamos spacingX como ancho total por elemento

    // Primera fila: PM2_5, PM10, SO2 (3 elementos)
    const firstRowAttrs = ['PM2_5', 'PM10', 'SO2'];
    const firstRowWidth = firstRowAttrs.length * itemWidth;
    const legendXStartFirst = (width - firstRowWidth) / 2; // Centro de la fila
    firstRowAttrs.forEach((attr, i) => {
        const xPos = legendXStartFirst + i * spacingX;
        svg.append("line")
            .attr("x1", xPos)
            .attr("y1", legendYStart)
            .attr("x2", xPos + lineLength)
            .attr("y2", legendYStart)
            .attr("stroke", attributeColorsCONT[attr])
            .attr("stroke-width", 2);
        svg.append("text")
            .attr("x", xPos + lineLength + 5)
            .attr("y", legendYStart + 4)
            .attr("font-size", "10px")
            .text(attr);
    });

    // Segunda fila: NO2, CO, O3 (3 elementos)
    const secondRowAttrs = ['NO2', 'CO', 'O3'];
    const secondRowWidth = secondRowAttrs.length * itemWidth;
    const legendXStartSecond = (width - secondRowWidth) / 2; // Centro de la fila
    secondRowAttrs.forEach((attr, i) => {
        const xPos = legendXStartSecond + i * spacingX;
        svg.append("line")
            .attr("x1", xPos)
            .attr("y1", legendYStart + spacingY)
            .attr("x2", xPos + lineLength)
            .attr("y2", legendYStart + spacingY)
            .attr("stroke", attributeColorsCONT[attr])
            .attr("stroke-width", 2);
        svg.append("text")
            .attr("x", xPos + lineLength + 5)
            .attr("y", legendYStart + spacingY + 4)
            .attr("font-size", "10px")
            .text(attr);
    });

    // Tercera fila: TEMP, PRES, DEWP, RAIN (4 elementos)
    const thirdRowWidth = attributesMET.length * itemWidth;
    const legendXStartThird = (width - thirdRowWidth) / 2; // Centro de la fila
    attributesMET.forEach((attr, i) => {
        const xPos = legendXStartThird + i * spacingX;
        svg.append("line")
            .attr("x1", xPos)
            .attr("y1", legendYStart + 2 * spacingY)
            .attr("x2", xPos + lineLength)
            .attr("y2", legendYStart + 2 * spacingY)
            .attr("stroke", attributeColorsMET[attr])
            .attr("stroke-width", 2);
        svg.append("text")
            .attr("x", xPos + lineLength + 5)
            .attr("y", legendYStart + 2 * spacingY + 4)
            .attr("font-size", "10px")
            .text(attr);
    });

    // Crear el tooltip
    const tooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("position", "absolute")
        .style("visibility", "hidden")
        .style("background", "rgba(0, 0, 0, 0.7)")
        .style("color", "#fff")
        .style("padding", "5px 10px")
        .style("border-radius", "5px")
        .style("font-size", "12px");

    // Escala X (común para barras y líneas)
    const x = d3.scaleBand()
        .domain(data.map(d => d.day))
        .range([0, width])
        .padding(0.1);

    // Escala Y izquierda (para barras de contaminantes)
    const stack = d3.stack()
        .keys(attributesCONT)
        .order(d3.stackOrderNone)
        .offset(d3.stackOffsetNone);
    const series = stack(data);
    const yLeft = d3.scaleLinear()
        .domain([0, d3.max(series, d => d3.max(d, d => d[1]))])
        .nice()
        .range([height, 0]);

    // Escala Y derecha (para líneas meteorológicas normalizadas)
    const yRight = d3.scaleLinear()
        .domain([0, 1])
        .range([height, 0]);

    // Colores para contaminantes
    const colorCONT = d3.scaleOrdinal()
        .domain(attributesCONT)
        .range(attributesCONT.map(attr => attributeColorsCONT[attr]));

    // Colores para meteorología
    const colorMET = d3.scaleOrdinal()
        .domain(attributesMET)
        .range(attributesMET.map(attr => attributeColorsMET[attr]));

    // Dibujar las barras de contaminantes
    svg.append("g")
        .selectAll("g")
        .data(series)
        .enter()
        .append("g")
        .attr("fill", d => colorCONT(d.key))
        .selectAll("rect")
        .data(d => d)
        .enter()
        .append("rect")
        .attr("x", d => x(d.data.day))
        .attr("y", d => yLeft(d[1]))
        .attr("height", d => yLeft(d[0]) - yLeft(d[1]))
        .attr("width", x.bandwidth())
        .on("mouseover", function (event, d) {
            const contaminant = d3.select(this.parentNode).datum().key;
            const value = (d[1] - d[0]).toFixed(2);
            const unit = contaminant === "CO" ? "mg/m³" : "µg/m³";
            tooltip.style("visibility", "visible")
                .html(`<strong>${contaminant}:</strong> ${value} ${unit}`);
        })
        .on("mousemove", function (event) {
            tooltip.style("top", (event.pageY - 10) + "px")
                .style("left", (event.pageX + 10) + "px");
        })
        .on("mouseout", function () {
            tooltip.style("visibility", "hidden");
        });

    // Dibujar series temporales meteorológicas (líneas solo si son continuas, puntos siempre)
    attributesMET.forEach(attr => {
        // Dibujar líneas solo entre días consecutivos
        for (let i = 0; i < data.length - 1; i++) {
            const date1 = new Date(data[i].date);
            const date2 = new Date(data[i + 1].date);
            const diffDays = (date2 - date1) / (1000 * 60 * 60 * 24);

            if (diffDays === 1) { // Días consecutivos
                const line = d3.line()
                    .x((d, idx) => x(d.day) + x.bandwidth() / 2)
                    .y(d => yRight(d[attr + '_norm']))
                    .defined(d => d[attr + '_norm'] !== null && !isNaN(d[attr + '_norm']));

                svg.append("path")
                    .datum([data[i], data[i + 1]])
                    .attr("fill", "none")
                    .attr("stroke", attributeColorsMET[attr])
                    .attr("stroke-width", 2)
                    .attr("d", line);
            }
        }

        // Dibujar puntos en cada día
        svg.selectAll(`.point-${attr}`)
            .data(data.filter(d => d[attr + '_norm'] !== null && !isNaN(d[attr + '_norm'])))
            .enter()
            .append("circle")
            .attr("class", `point-${attr}`)
            .attr("cx", d => x(d.day) + x.bandwidth() / 2)
            .attr("cy", d => yRight(d[attr + '_norm']))
            .attr("r", 3)
            .attr("fill", attributeColorsMET[attr])
            .on("mouseover", function (event, d) {
                const value = d[attr].toFixed(2);
                tooltip.style("visibility", "visible")
                    .html(`<strong>${attr}:</strong> ${value} ${metUnits[attr]}`);
            })
            .on("mousemove", function (event) {
                tooltip.style("top", (event.pageY - 10) + "px")
                    .style("left", (event.pageX + 10) + "px");
            })
            .on("mouseout", function () {
                tooltip.style("visibility", "hidden");
            });
    });

    // Eje X
    const xAxis = d3.axisBottom(x)
        .tickFormat(d => d);
    svg.append("g")
        .attr("class", "x-axis")
        .attr("transform", `translate(0,${height})`)
        .call(xAxis)
        .selectAll("text")
        .style("text-anchor", "end")
        .attr("dx", "-.8em")
        .attr("dy", ".15em")
        .attr("transform", "rotate(-45)");

    // Eje Y izquierdo (contaminantes)
    const yAxisLeft = d3.axisLeft(yLeft);
    svg.append("g")
        .attr("class", "y-axis-left")
        .call(yAxisLeft);

    // Eje Y derecho (meteorología normalizada)
    const yAxisRight = d3.axisRight(yRight);
    svg.append("g")
        .attr("class", "y-axis-right")
        .attr("transform", `translate(${width},0)`)
        .call(yAxisRight);
}



// Graficar serie temporal
function plotTimeSeries(attr, data) {
    const container = d3.select("#series-temporales-" + attr.toLowerCase());
    container.html("");

    const margin = { top: 20, right: 50, bottom: 30, left: 50 };
    const width = 600 - margin.left - margin.right;
    const height = 200 - margin.top - margin.bottom;

    const svg = container.append("svg")
        .attr("width", 650)
        .attr("height", 200)
        .append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Para atributos meteorológicos, enriquecer con datos del cache de Meteo
    const meteoAttributes = ['TEMP', 'PRES', 'DEWP', 'RAIN', 'WSPM'];
    let enrichedData = data;
    if (meteoAttributes.includes(attr)) {
        if (!meteoDataCache[currentCountry]) {
            // Cargar asincrónicamente y re-renderizar
            loadMeteoForCountry(currentCountry).then(() => plotTimeSeries(attr, data));
            return;
        }
        enrichedData = enrichWithMeteoCache(data, currentCountry);
    }

    const uniqueStationIds = [...new Set(enrichedData.map(d => d.station))];
    const allStationObjs = (stationMeta && stationMeta.stations) ? Object.values(stationMeta.stations).flat() : [];
    const stationData = uniqueStationIds.map(sId => {
        const stationObj = allStationObjs.find(s => String(s.id) === String(sId));
        return {
            station: sId,
            name: stationObj ? stationObj.name : `Station ${sId}`,
            values: enrichedData.filter(d => String(d.station) === String(sId)).sort((a, b) => a.date - b.date)
        };
    });

    const xScale = d3.scaleTime()
        .domain([d3.min(data, d => d.date), d3.max(data, d => d.date)])
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([d3.min(enrichedData, d => +d[attr]) || 0, d3.max(enrichedData, d => +d[attr]) || 0])
        .range([height, 0]);

    const line = d3.line()
        .x(d => xScale(d.date))
        .y(d => yScale(d[attr]))
        .defined(d => !isNaN(d[attr]));

    // Crear un nuevo tooltip para las series temporales
    const timeSeriesTooltip = d3.select("body").append("div")
        .attr("class", "tooltip")
        .style("opacity", 0);

    stationData.forEach((sd, i) => {
        const values = sd.values;
        const segments = [];
        let currentSegment = [];

        for (let j = 0; j < values.length; j++) {
            if (j > 0 && (values[j].date - values[j - 1].date) > (24 * 60 * 60 * 1000)) {
                // Si la diferencia entre fechas es mayor a un día, es un nuevo segmento
                segments.push(currentSegment);
                currentSegment = [];
            }
            currentSegment.push(values[j]);
        }
        segments.push(currentSegment); // Añadir el último segmento

        segments.forEach(segment => {
            if (segment.length > 1) {
                // Dibujar línea para segmentos continuos
                svg.append("path")
                    .datum(segment)
                    .attr("fill", "none")
                    .attr("stroke", d3.schemeCategory10[i % 10])
                    .attr("stroke-width", 1.5)
                    .attr("d", line)
                    .on("mouseover", function (event) {
                        d3.select(this).attr("stroke-width", 3); // Resaltar la línea
                        timeSeriesTooltip.transition().duration(200).style("opacity", 0.9);
                        timeSeriesTooltip.html(`Estación: ${sd.name}`)
                            .style("left", (event.pageX + 5) + "px")
                            .style("top", (event.pageY - 28) + "px");
                    })
                    .on("mousemove", function (event) {
                        timeSeriesTooltip.style("left", (event.pageX + 5) + "px")
                            .style("top", (event.pageY - 28) + "px");
                    })
                    .on("mouseout", function () {
                        d3.select(this).attr("stroke-width", 1.5); // Volver al grosor original
                        timeSeriesTooltip.transition().duration(500).style("opacity", 0);
                    });
            } else if (segment.length === 1) {
                // Dibujar punto para segmentos no continuos
                const point = segment[0];
                let color;
                if (attr === 'TEMP' || attr === 'PRES' || attr === 'DEWP' || attr === 'RAIN') {
                    color = meteorologicalColor;
                } else if (attr === 'CO') {
                    const co_mg = point['CO']; // Los datos ya vienen en mg/m³
                    const category = getAQICategoryForCO(co_mg);
                    color = aqiColors[category - 1];
                } else {
                    const category = calculateAQICategory(point[attr]);
                    color = aqiColors[category - 1];
                }

                svg.append("circle")
                    .attr("cx", xScale(point.date))
                    .attr("cy", yScale(point[attr]))
                    .attr("r", 3)
                    .attr("fill", color)
                    .on("mouseover", function (event) {
                        d3.select(this).attr("r", 5); // Resaltar el punto
                        timeSeriesTooltip.transition().duration(200).style("opacity", 0.9);
                        timeSeriesTooltip.html(`Estación: ${sd.name}<br>Fecha: ${point.date.toLocaleDateString()}<br>${attr}: ${point[attr]}`)
                            .style("left", (event.pageX + 5) + "px")
                            .style("top", (event.pageY - 28) + "px");
                    })
                    .on("mousemove", function (event) {
                        timeSeriesTooltip.style("left", (event.pageX + 5) + "px")
                            .style("top", (event.pageY - 28) + "px");
                    })
                    .on("mouseout", function () {
                        d3.select(this).attr("r", 3); // Volver al tamaño original
                        timeSeriesTooltip.transition().duration(500).style("opacity", 0);
                    });
            }
        });
    });

    svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(xScale).ticks(5));

    svg.append("g")
        .call(d3.axisLeft(yScale));

    const legend = svg.append("g")
        .attr("transform", `translate(${width + 10}, 0)`);

    stationData.forEach((sd, i) => {
        const legendItem = legend.append("g").attr("transform", `translate(0, ${i * 15})`);
        legendItem.append("rect").attr("width", 10).attr("height", 10).attr("fill", d3.schemeCategory10[i % 10]);
        legendItem.append("text").attr("x", 15).attr("y", 7).text(sd.name).style("font-size", "10px");
    });

    svg.append("text")
        .attr("x", width / 2)
        .attr("y", 10)
        .attr("text-anchor", "middle")
        .text(attr.replace('_', '.'));
}