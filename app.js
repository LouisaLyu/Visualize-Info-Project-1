import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const RAW = "./data/raw/";

const state = {
    selectedArtistName: null,
    // selectedPlaylistName removed
    dateRange: null,          // [Date, Date]
    shortlist: new Map(),     // trackUri -> {trackName, artistName, count, msPlayed}
    raceMetric: "streamCount",
    racePlaying: true
};

let tables = null;
let raceTimer = null;
let raceIndex = 0;

const els = {
    // playlistSelect removed
    raceMetric: document.getElementById("raceMetric"),
    clearFiltersBtn: document.getElementById("clearFiltersBtn"),
    exportShortlistBtn: document.getElementById("exportShortlistBtn"),
    shortlistCount: document.getElementById("shortlistCount"),
    chipArtist: document.getElementById("chipArtist"),
    chipDateRange: document.getElementById("chipDateRange"),
    racePlayPauseBtn: document.getElementById("racePlayPauseBtn"),
    raceDateLabel: document.getElementById("raceDateLabel")
};

function setStatus(ok, text) {
    // Status indicator removed
}

function setState(patch) {
    Object.assign(state, patch);
    renderAll();
}

function clearFilters() {
    setState({
        selectedArtistName: null,
        // selectedPlaylistName removed
        dateRange: null
    });
    // els.playlistSelect removed
    updateChips();
}

function updateChips() {
    if (state.selectedArtistName) {
        els.chipArtist.textContent = `Artist: ${state.selectedArtistName}`;
        els.chipArtist.classList.remove("hidden");
    } else {
        els.chipArtist.classList.add("hidden");
    }

    if (state.dateRange) {
        const [a, b] = state.dateRange;
        els.chipDateRange.textContent = `Dates: ${fmtDate(a)} → ${fmtDate(b)}`;
        els.chipDateRange.classList.remove("hidden");
    } else {
        els.chipDateRange.classList.add("hidden");
    }
}

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

function downloadJSON(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ---------- Load + Transform ----------
async function loadJSON(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Failed to load: ${path} (${r.status})`);
    return await r.json();
}

function buildTrackMetaMap(playlistJson, libraryJson) {
    const map = new Map();

    // From playlists
    (playlistJson.playlists || []).forEach(pl => {
        (pl.items || []).forEach(it => {
            const tr = it.track;
            if (!tr?.trackUri) return;
            map.set(tr.trackUri, {
                trackName: tr.trackName,
                artistName: tr.artistName,
                albumName: tr.albumName
            });
        });
    });

    // From library (if present)
    if (libraryJson?.tracks) {
        (libraryJson.tracks || []).forEach(t => {
            if (!t?.uri) return;
            if (!map.has(t.uri)) {
                map.set(t.uri, { trackName: t.track, artistName: t.artist, albumName: t.album });
            }
        });
    }

    return map;
}

function transform({ wrapped, capsule, playlist, library }) {
    const trackMeta = buildTrackMetaMap(playlist, library);

    // Top Tracks (Wrapped)
    const topTracks = (wrapped.topTracks?.topTracks || []).map(d => {
        const meta = trackMeta.get(d.trackUri) || {};
        return {
            trackUri: d.trackUri,
            trackName: meta.trackName || d.trackUri,
            artistName: meta.artistName || "",
            count: d.count || 0,
            msPlayed: d.msPlayed || 0
        };
    }).sort((a, b) => b.count - a.count);



    // Playlist adds
    const playlistAdds = [];
    (playlist.playlists || []).forEach(pl => {
        (pl.items || []).forEach(it => {
            const tr = it.track;
            if (!tr?.trackUri) return;
            playlistAdds.push({
                playlistName: pl.name,
                addedDate: new Date(it.addedDate),
                trackUri: tr.trackUri,
                trackName: tr.trackName,
                artistName: tr.artistName
            });
        });
    });

    // Artist weekly for race (Sound Capsule stats)
    const artistWeekly = [];
    (capsule.stats || []).forEach(s => {
        const date = new Date(s.date);
        (s.topArtists || []).forEach(a => {
            artistWeekly.push({
                date,
                artistName: a.name,
                streamCount: a.streamCount || 0,
                secondsPlayed: a.secondsPlayed || 0
            });
        });
    });

    // Group into frames by date
    const byDate = d3.group(artistWeekly, d => fmtDate(d.date));
    const raceFrames = Array.from(byDate, ([dateStr, rows]) => {
        const date = new Date(dateStr);
        return { date, rows };
    }).sort((a, b) => +a.date - +b.date);

    // Highlights (Sound Capsule) — parse per highlightType
    // Pass stats for Heatmap
    const listeningStats = (capsule.stats || []).map(s => ({
        date: new Date(s.date),
        streamCount: s.streamCount || 0,
        secondsPlayed: s.secondsPlayed || 0
    })).sort((a,b) => a.date - b.date);

    const highlights = (capsule.highlights || []).map(h => {
        const date = new Date(h.date);
        const type = h.highlightType;

        let entity = "";
        let value = "";

        if (type === "ON_REPEAT") {
            entity = h.onRepeatHighlight?.entity ?? "";
            value = h.onRepeatHighlight?.streamCount ?? "";
        }
        else if (type === "STREAKS") {
            entity = h.streaksHighlight?.entity ?? "";
            value = h.streaksHighlight?.dayStreaks ?? "";
        }
        else if (type === "PROPORTION_LISTENING_ENTITY") {
            entity = h.proportionListeningHighlight?.entity ?? "";
            const pct = h.proportionListeningHighlight?.listeningPercentage;
            value = (pct != null && pct !== "") ? `${Number(pct).toFixed(1)}%` : "";
        }
        else if (type === "MILESTONE") {
            const ents = h.multiEntityMilestoneHighlight?.entities ?? [];
            if (Array.isArray(ents) && ents.length) {
                entity = ents.slice(0, 3).join(", ") + (ents.length > 3 ? ` +${ents.length - 3} more` : "");
            } else {
                entity = "Milestone";
            }
            const secs = h.multiEntityMilestoneHighlight?.milestoneListeningSeconds;
            value = (secs != null) ? `${Math.round(secs / 60)} min` : "";
        }
        else if (type === "UNLIKE_COMBINATION") {
            const a = h.unlikeCombinationHighlight?.firstEntity ?? "";
            const b = h.unlikeCombinationHighlight?.secondEntity ?? "";
            entity = [a, b].filter(Boolean).join(" + ");
        }
        else if (type === "FIRST_TO_DISCOVER") {
            entity = h.firstToDiscoverHighlight?.entity ?? "";
            const country = h.firstToDiscoverHighlight?.country;
            const pos = h.firstToDiscoverHighlight?.position;
            value = [country ? `in ${country}` : "", pos != null ? `rank ${pos}` : ""]
                .filter(Boolean)
                .join(" · ");
        }

        // Last-resort fallback so it doesn't become blank
        if (!entity) entity = "(unknown)";

        return { date, type, entity, value };
    }).sort((a, b) => +b.date - +a.date);


    return { topTracks, playlistAdds, raceFrames, highlights, listeningStats };
}

// ---------- Heatmap Logic (Ported from heatmap_app.js) ----------
const HEATMAP_DAYS_MON_START = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

function heatmapLocalParts(date) {
  // Use user's local time or a specific timezone. 
  // Here we use browser default for simplicity, or "en-CA" if requested.
  const dtf = new Intl.DateTimeFormat("en-CA", {
    weekday: "short",
    hour: "2-digit",
    hour12: false
  });
  const parts = dtf.formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { weekday: map.weekday, hour: Number(map.hour) };
}

function aggregateWeekHourHeatmap(rows, { timeField="date" } = {}) {
  const counts = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const r of (rows || [])) {
    const raw = r?.[timeField];
    if (!raw) continue;

    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) continue;

    const { weekday, hour } = heatmapLocalParts(d);
    const di = HEATMAP_DAYS_MON_START.indexOf(weekday);
    if (di === -1 || hour < 0 || hour > 23) continue;
    counts[di][hour] += 1;
  }

  const data = [];
  for (let di = 0; di < 7; di++) {
    for (let h = 0; h < 24; h++) {
      data.push({ day: HEATMAP_DAYS_MON_START[di], dayIndex: di, hour: h, value: counts[di][h] });
    }
  }
  return data;
}

function ensureHeatmapTooltip() {
  let tip = d3.select("body").selectAll(".hm-tooltip").data([null]);
  tip = tip.enter().append("div").attr("class","hm-tooltip").merge(tip);
  return tip;
}

function drawListeningHeatmap(dataRows, title="Listening Rhythm (When Added)") {
    console.log("Building Heatmap from dataRows:", dataRows?.length); // Debug info 
    const container = d3.select("#panelHighlights");

    const W = container.node().clientWidth;
    const padding = { top: 16, right: 14, bottom: 34, left: 32 };
    const width = Math.max(360, W);
    const height = 280;
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;
    
    // We use playlistAdds as a proxy for "activity" since we lack hourly streaming history
    // dataRows should be `tables.playlistAdds`
    const cfg = {
        cellSize: 18,
        gap: 1,
        xTickHours: [0, 4, 8, 12, 16, 20, 23]
    };

    container.html("");
    const tip = ensureHeatmapTooltip();

    if (!dataRows || dataRows.length === 0) {
        container.html(`<p class="meta-text">No activity data available.</p>`);
        return;
    }

    const data = aggregateWeekHourHeatmap(dataRows, { timeField: "addedDate" });
    const values = data.map(d => d.value);
    const max = d3.max(values) || 1;
    const domainMax = Math.max(1, max);

    // Expand focus: Trim empty hours (start/end of day)
    const activeData = data.filter(d => d.value > 0);
    let minHour = 0, maxHour = 23;
    if (activeData.length > 0) {
        const hours = activeData.map(d => d.hour);
        minHour = Math.max(0, d3.min(hours) - 1); // buffer
        maxHour = Math.min(23, d3.max(hours) + 1);
    }
    const hourDomain = d3.range(minHour, maxHour + 1);

    const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height);

    const g = svg.append("g")
        .attr("transform", `translate(${padding.left},${padding.top})`);

    const x = d3.scaleBand()
        .domain(hourDomain)
        .range([0, innerW])
        .paddingInner(cfg.gap / (cfg.cellSize + cfg.gap));

    const y = d3.scaleBand()
        .domain(HEATMAP_DAYS_MON_START)
        .range([0, innerH])
        .paddingInner(cfg.gap / (cfg.cellSize + cfg.gap));

    const color = d3.scaleSequential()
        .domain([0, domainMax])
        .interpolator(d3.interpolateBlues);

    const xAxis = d3.axisBottom(x)
        .tickValues(hourDomain.filter(h => h % 4 === 0 || h === minHour || h === maxHour)) // smarter ticks
        .tickFormat(d => `${String(d).padStart(2,"0")}:00`);

    const yAxis = d3.axisLeft(y).tickSize(0);

    g.append("g")
        .attr("transform", `translate(0,${innerH})`)
        .call(xAxis)
        .call(ax => ax.selectAll("text").attr("fill","#53627d").attr("font-size",11))
        .call(ax => ax.selectAll("path,line").attr("stroke","rgba(21,34,59,0.18)"));

    g.append("g")
        .call(yAxis)
        .call(ax => ax.selectAll("text").attr("fill","#53627d").attr("font-size",11))
        .call(ax => ax.select(".domain").remove());

    g.append("g")
        .selectAll("rect")
        .data(data)
        .join("rect")
        .attr("x", d => x(d.hour))
        .attr("y", d => y(d.day))
        .attr("width", x.bandwidth())
        .attr("height", y.bandwidth())
        .attr("rx", 4)
        .attr("ry", 4)
        .attr("fill", d => color(d.value))
        .attr("opacity", d => d.value === 0 ? 0.18 : 1)
        .on("mousemove", (event, d) => {
            tip.style("opacity", 1)
                .style("left", `${event.pageX + 10}px`)
                .style("top", `${event.pageY + 10}px`)
                .html(`
                    <div style="font-weight:600;margin-bottom:2px;">${d.day} • ${String(d.hour).padStart(2,"0")}:00</div>
                    <div>${d.value} events</div>
                `);
        })
        .on("mouseleave", () => tip.style("opacity", 0));

    // Title
    svg.append("text")
        .attr("x", padding.left)
        .attr("y", 12)
        .attr("fill", "#53627d")
        .attr("font-size", 12)
        .text(title);
}

// ---------- Charts ----------
function drawTopTracksChart(data, mode = "plays") {
    const container = d3.select("#chartTopTracks");
    const W = container.node().clientWidth;
    const H = 320;

    const margin = { top: 30, right: 14, bottom: 14, left: 14 };
    const width = Math.max(320, W);
    const height = H;

    const rows = (data || []).slice(0, 15);

    container.html("");

    if (!rows.length) {
        container.html(`<p class="meta-text">No tracks available for this view.</p>`);
        return;
    }

    const svg = container.append("svg")
        .attr("width", width)
        .attr("height", height);

    const label = mode === "adds" ? "Adds (from current filters)" : "Plays (Wrapped)";

    // little caption
    svg.append("text")
        .attr("x", margin.left)
        .attr("y", 18)
        .attr("fill", "#53627d")
        .attr("font-size", 12)
        .text(`Top tracks by ${label} — click to shortlist`);

    // --- Robust Scaler Logic ---
    // We want to scale "msPlayed" so outlier tracks don't dwarf others, 
    // ensuring areas are distinguishable.
    const values = rows.map(d => d.msPlayed || 0).sort((a, b) => a - b);
    let scaleFn = d => d; // default identity

    if (values.length > 0) {
        const q1 = d3.quantile(values, 0.25);
        const q3 = d3.quantile(values, 0.75);
        const iqr = q3 - q1;
        // If IQR is 0 (all same or very close), fallback to linear min-max
        if (iqr === 0) {
            scaleFn = d => d;
        } else {
            // Robust scaling: (x - median) / IQR
            // But d3.pack requires positive values for area.
            // We'll map the robust range [Q1 - 1.5*IQR, Q3 + 1.5*IQR] to a reasonable size range.
            const lowerBound = Math.max(0, q1 - 1.5 * iqr);
            const upperBound = q3 + 1.5 * iqr;

            // Create a clamp scale
            const robustScale = d3.scaleLinear()
                .domain([lowerBound, upperBound])
                .range([100, 10000]) // arbitrary area units
                .clamp(true);

            scaleFn = val => robustScale(val);
        }
    }

    // Build hierarchy for d3.pack
    const root = d3.hierarchy({ children: rows })
        .sum(d => {
            // Use msPlayed with robust scaling
            const val = d.msPlayed || 0;
            return scaleFn(val);
        })
        .sort((a, b) => (b.value || 0) - (a.value || 0));

    const pack = d3.pack()
        .size([width - margin.left - margin.right, height - margin.top - margin.bottom])
        .padding(8);

    pack(root);

    const g = svg.append("g")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Color scale (soft)
    const baseFill = "rgba(96,165,250,0.45)";
    const selectedFill = "rgba(96,165,250,0.90)";

    const nodes = g.selectAll("g.node")
        .data(root.leaves(), d => d.data.trackUri)
        .join("g")
        .attr("class", "node")
        .attr("transform", d => `translate(${d.x},${d.y})`)
        .style("cursor", "pointer")
        .on("click", (_, d) => {
            const key = d.data.trackUri;
            if (state.shortlist.has(key)) state.shortlist.delete(key);
            else state.shortlist.set(key, d.data);

            renderShortlist();
            // redraw the SAME view the user is seeing
            drawTopTracksChart(data, mode);
        });

    nodes.append("circle")
        .attr("r", d => d.r)
        .attr("fill", d => state.shortlist.has(d.data.trackUri) ? selectedFill : baseFill)
        .attr("stroke", d => state.shortlist.has(d.data.trackUri) ? "rgba(21,34,59,0.35)" : "rgba(21,34,59,0.12)")
        .attr("stroke-width", d => state.shortlist.has(d.data.trackUri) ? 2 : 1);

    // Labels: show rank number inside if circle is big enough
    const text = nodes.append("text")
        .style("text-anchor", "middle")
        .style("pointer-events", "none")
        .style("fill", "rgba(21,34,59,0.9)")
        .attr("dy", "-0.2em"); // Initial offset to center the block

    // 1) Song Name
    text.append("tspan")
        .attr("x", 0)
        .attr("dy", "-0.6em")
        .style("font-weight", "bold")
        .style("font-size", d => Math.max(8, d.r / 4) + "px") // dynamic sizing
        .text(d => d.r > 25 ? (d.data.trackName.length > 8 ? d.data.trackName.slice(0, 7) + "..." : d.data.trackName) : "");

    // 2) Artist Name
    text.append("tspan")
        .attr("x", 0)
        .attr("dy", "1.1em")
        .style("font-size", d => Math.max(7, d.r / 5) + "px")
        .text(d => d.r > 25 ? (d.data.artistName.length > 15 ? d.data.artistName.slice(0, 14) + "..." : d.data.artistName) : "");

    // 3) Listening Time (Top Tracks mode usually has msPlayed)
    text.append("tspan")
        .attr("x", 0)
        .attr("dy", "1.1em")
        .style("font-size", d => Math.max(7, d.r / 5) + "px")
        .style("opacity", 0.8)
        .text(d => {
            if (d.r <= 25) return "";
            // Convert ms to minutes
            const mins = Math.round((d.data.msPlayed || 0) / 60000);
            return `${mins} min`;
        });

    // Tooltip
    nodes.append("title")
        .text(d => {
            const metricWord = mode === "adds" ? "adds" : "plays";
            return `${d.data.trackName} — ${d.data.artistName}\n${metricWord}: ${d.data.count}`;
        });

    // Optional: tiny legend for selected
    svg.append("text")
        .attr("x", width - margin.right)
        .attr("y", 18)
        .attr("text-anchor", "end")
        .attr("fill", "#53627d")
        .attr("font-size", 12)
        .text(`Shortlisted: ${state.shortlist.size}`);
}



function drawPlaylistTimeline(allAdds) {
    const container = d3.select("#chartPlaylistTimeline");
    const W = container.node().clientWidth;
    const H = 320;

    const margin = { top: 16, right: 12, bottom: 36, left: 46 };
    const width = Math.max(320, W);
    const height = H;

    const norm = s => (s || "").toLowerCase().trim();

    // Playlist filter removed, keeping only artist filter if active
    let adds = allAdds;

    // only apply artist filter if it actually matches something
    if (state.selectedArtistName) {
        const matched = adds.filter(d => norm(d.artistName) === norm(state.selectedArtistName));
        if (matched.length > 0) adds = matched; // otherwise keep unfiltered so chart doesn't look broken
    }

    const extent = d3.extent(adds, d => d.addedDate);
    const domain = extent[0] && extent[1] ? extent : [new Date("2025-01-01"), new Date("2025-12-31")];

    const x = d3.scaleTime()
        .domain(domain)
        .range([margin.left, width - margin.right]);

    // Bin by month
    const bins = d3.bin()
        .value(d => d.addedDate)
        .domain(x.domain())
        .thresholds(d3.timeMonth.range(d3.timeMonth.floor(domain[0]), d3.timeMonth.ceil(domain[1])))
        (adds);

    const y = d3.scaleLinear()
        .domain([0, d3.max(bins, b => b.length) || 1])
        .nice()
        .range([height - margin.bottom, margin.top]);

    const svg = container.html("")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    svg.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(y).ticks(5))
        .call(g => g.selectAll("text").attr("fill", "#53627d"))
        .call(g => g.selectAll("path,line").attr("stroke", "rgba(21,34,59,0.18)"));

    svg.append("g")
        .attr("transform", `translate(0,${height - margin.bottom})`)
        .call(d3.axisBottom(x).ticks(6))
        .call(g => g.selectAll("text").attr("fill", "#53627d"))
        .call(g => g.selectAll("path,line").attr("stroke", "rgba(21,34,59,0.18)"));

    svg.append("g")
        .selectAll("rect")
        .data(bins)
        .join("rect")
        .attr("x", d => x(d.x0) + 1)
        .attr("y", d => y(d.length))
        .attr("width", d => Math.max(0, x(d.x1) - x(d.x0) - 2))
        .attr("height", d => y(0) - y(d.length))
        .attr("fill", "rgba(34,197,94,0.55)");

    // Brush
    const brush = d3.brushX()
        .extent([[margin.left, margin.top], [width - margin.right, height - margin.bottom]])
        .on("end", (event) => {
            if (!event.selection) {
                setState({ dateRange: null });
                updateChips();
                return;
            }
            const [x0, x1] = event.selection;
            const start = x.invert(x0);
            const end = x.invert(x1);
            setState({ dateRange: [start, end] });
            updateChips();
        });

    svg.append("g").call(brush);

    // If state already has dateRange, show it
    if (state.dateRange && x) {
        const [a, b] = state.dateRange;
        let xA, xB;
        try {
            xA = x(a);
            xB = x(b);
        } catch (e) {
            return;
        }
        if (typeof xA === "number" && typeof xB === "number" && isFinite(xA) && isFinite(xB)) {
            // Only call brush.move if the brush group exists
            const brushGroup = svg.select("g");
            if (!brushGroup.empty() && brush && brush.move) {
                try {
                    brushGroup.call(brush.move, [xA, xB]);
                } catch (e) {
                    // Defensive: log and skip if brush.move fails
                    // console.warn("brush.move failed", e);
                }
            }
        }
    }
}

function computeRaceRank(frameRows) {
    // Aggregate per artist (safe), then rank top 10
    const agg = d3.rollup(
        frameRows,
        v => d3.sum(v, d => state.raceMetric === "secondsPlayed" ? d.secondsPlayed : d.streamCount),
        d => d.artistName
    );

    return Array.from(agg, ([artistName, value]) => ({ artistName, value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 10);
}

function drawArtistRace(frames) {
    const container = d3.select("#chartArtistRace");
    const W = container.node().clientWidth;
    const H = 320;

    const margin = { top: 14, right: 18, bottom: 28, left: 140 };
    const width = Math.max(320, W);
    const height = H;

    const svg = container.html("")
        .append("svg")
        .attr("width", width)
        .attr("height", height);

    function renderFrame(i) {
        const f = frames[i];
        if (!f) return;

        els.raceDateLabel.textContent = `Date: ${fmtDate(f.date)}`;

        const rows = computeRaceRank(f.rows);
        const maxVal = d3.max(rows, d => d.value) || 1;

        const x = d3.scaleLinear()
            .domain([0, maxVal])
            .range([margin.left, width - margin.right]);

        const y = d3.scaleBand()
            .domain(rows.map(d => d.artistName))
            .range([margin.top, height - margin.bottom])
            .padding(0.15);

        svg.selectAll(".axis").remove();

        svg.append("g")
            .attr("class", "axis")
            .attr("transform", `translate(0,${height - margin.bottom})`)
            .call(d3.axisBottom(x).ticks(5).tickSizeOuter(0))
            .call(g => g.selectAll("text").attr("fill", "#53627d"))
            .call(g => g.selectAll("path,line").attr("stroke", "rgba(21,34,59,0.18)"));

        const t = svg.transition().duration(650).ease(d3.easeCubicOut);

        const bars = svg.selectAll("rect.bar")
            .data(rows, d => d.artistName);

        bars.join(
            enter => enter.append("rect")
                .attr("class", "bar")
                .attr("x", x(0))
                .attr("y", d => y(d.artistName))
                .attr("height", y.bandwidth())
                .attr("width", d => x(d.value) - x(0))
                .attr("fill", d => (state.selectedArtistName === d.artistName ? "#f97316" : "rgba(249,115,22,0.55)"))
                .attr("stroke", d => (state.selectedArtistName === d.artistName ? "#e7eaf2" : "transparent"))
                .style("cursor", "pointer")
                .on("click", (_, d) => {
                    const next = (state.selectedArtistName === d.artistName) ? null : d.artistName;
                    setState({ selectedArtistName: next });
                    updateChips();
                })
                .append("title")
                .text(d => `${d.artistName}: ${d.value}`),
            update => update,
            exit => exit.transition(t).style("opacity", 0).remove()
        )
            .transition(t)
            .attr("y", d => y(d.artistName))
            .attr("height", y.bandwidth())
            .attr("width", d => x(d.value) - x(0))
            .attr("fill", d => (state.selectedArtistName === d.artistName ? "#f97316" : "rgba(249,115,22,0.55)"))
            .attr("stroke", d => (state.selectedArtistName === d.artistName ? "#e7eaf2" : "transparent"));

        const labels = svg.selectAll("text.label")
            .data(rows, d => d.artistName);

        labels.join(
            enter => enter.append("text")
                .attr("class", "label")
                .attr("x", x(0) - 6)
                .attr("y", d => y(d.artistName) + y.bandwidth() / 2)
                .attr("text-anchor", "end")
                .attr("dy", "0.35em")
                .attr("fill", "#737373")
                .attr("font-size", 12)
                .text(d => `${d.artistName} (${d.value})`),
            update => update,
            exit => exit.transition(t).style("opacity", 0).remove()
        )
            .transition(t)
            .attr("x", x(0) - 6)
            .attr("y", d => y(d.artistName) + y.bandwidth() / 2)
            .text(d => `${d.artistName} (${d.value})`);
    }

    renderFrame(raceIndex);

    // animation timer (recreated cleanly each time we draw)
    if (raceTimer) raceTimer.stop();
    raceTimer = d3.interval(() => {
        if (!state.racePlaying) return;
        raceIndex = (raceIndex + 1) % frames.length;
        renderFrame(raceIndex);
    }, 1200);
}

function renderHighlights(highlights) {
    const panel = document.getElementById("panelHighlights");
    panel.innerHTML = "";

    const top = highlights.slice(0, 10);
    if (top.length === 0) {
        panel.innerHTML = `<p class="meta-text">No highlights found.</p>`;
        return;
    }

    const wrap = document.createElement("div");
    wrap.className = "list";

    for (const h of top) {
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
      <div class="left">
        <div class="sub">${fmtDate(h.date)} · ${h.type}</div>
        <div class="title">${h.entity || "(unknown)"} ${h.value !== "" ? `<span class="pill">${h.value}</span>` : ""}</div>
      </div>
    `;
        wrap.appendChild(div);
    }

    panel.appendChild(wrap);
}


function renderShortlist() {
    els.shortlistCount.textContent = `Shortlist: ${state.shortlist.size}`;
    const panel = document.getElementById("panelShortlist");
    panel.innerHTML = "";

    if (state.shortlist.size === 0) {
        panel.innerHTML = `<p class="meta-text">Click tracks in “Top Tracks” to add them here.</p>`;
        return;
    }

    const items = Array.from(state.shortlist.values())
        .sort((a, b) => (b.count || 0) - (a.count || 0));

    const wrap = document.createElement("div");
    wrap.className = "list";

    for (const it of items) {
        const div = document.createElement("div");
        div.className = "item";
        div.innerHTML = `
      <div class="left">
        <div class="title">${it.trackName}</div>
        <div class="sub">${it.artistName || ""} · plays: ${it.count || 0}</div>
      </div>
      <button data-uri="${it.trackUri}" class="removeBtn">Remove</button>
    `;
        wrap.appendChild(div);
    }

    panel.appendChild(wrap);

    panel.querySelectorAll(".removeBtn").forEach(btn => {
        btn.addEventListener("click", (e) => {
            const uri = e.currentTarget.getAttribute("data-uri");
            state.shortlist.delete(uri);
            renderShortlist();
            // redraw top tracks so highlight updates
            drawTopTracksChart(tables.topTracks, "plays");
        });
    });
}


// ---------- Render orchestrator ----------
function renderAll() {
    updateChips();

    // 1) Start from all playlist additions
    let filteredAdds = tables.playlistAdds;

    // Playlist dropdown filter logic removed

    // Apply date brush filter
    if (state.dateRange) {
        const [a, b] = state.dateRange;
        filteredAdds = filteredAdds.filter(d => d.addedDate >= a && d.addedDate <= b);
    }

    // Apply artist filter (but don’t let it wipe everything if names don’t match)
    if (state.selectedArtistName) {
        const norm = s => (s || "").toLowerCase().trim();
        const matched = filteredAdds.filter(d => norm(d.artistName) === norm(state.selectedArtistName));
        if (matched.length > 0) filteredAdds = matched;
    }

    // 2) Decide what Top Tracks should show
    const anyFilterActive = false;
    // Previously: state.selectedPlaylistName !== "ALL";


    let topTracksToShow = tables.topTracks; // default: Wrapped
    const topTitle = document.querySelector("#topTracksTitle"); // add this id (see next step)

    if (anyFilterActive) {
        // Build "top tracks" from filtered playlist adds (count = how many times added)
        const agg = d3.rollup(
            filteredAdds,
            v => ({
                trackUri: v[0].trackUri,
                trackName: v[0].trackName,
                artistName: v[0].artistName,
                count: v.length,
                msPlayed: 0
            }),
            d => d.trackUri
        );

        topTracksToShow = Array.from(agg.values()).sort((a, b) => b.count - a.count);

        if (topTitle) topTitle.textContent = "Top Tracks (from current filters)";
    } else {
        if (topTitle) topTitle.textContent = "Top Tracks (Wrapped)";
    }

    // 3) Draw everything
    drawTopTracksChart(topTracksToShow);
    drawPlaylistTimeline(filteredAdds);
    drawArtistRace(tables.raceFrames);
    
    // Switch to Weekday x Hour heatmap using Playlist Adds as a proxy 
    // because we lack granular streaming history in the provided files.
    // We reuse the logic from heatmap_app.js but feed it `filteredAdds` which has `addedDate`.
    drawListeningHeatmap(filteredAdds, "Listening Rhythm (Playlist Adds)");
    
    renderShortlist();
}


// ---------- Wire controls ----------
function wireControls() {
    // Playlist select event listener removed

    els.raceMetric.addEventListener("change", (e) => {
        setState({ raceMetric: e.target.value });
    });

    els.racePlayPauseBtn.addEventListener("click", () => {
        const next = !state.racePlaying;
        setState({ racePlaying: next });
        els.racePlayPauseBtn.textContent = next ? "Pause" : "Play";
    });

    els.clearFiltersBtn.addEventListener("click", clearFilters);

    els.exportShortlistBtn.addEventListener("click", () => {
        downloadJSON(Array.from(state.shortlist.values()), "spotify-shortlist.json");
    });
}

function populatePlaylists(playlistJson) {
    // Playlist dropdown population removed
}

// ---------- Heatmap Logic (Ported from heatmap_app.js) ----------
// OLD function removed.





// ---------- Boot ----------
async function main() {
    wireControls();

    try {
        const [wrapped, capsule, playlist, library] = await Promise.all([
            loadJSON(`${RAW}Wrapped2025.json`),
            loadJSON(`${RAW}YourSoundCapsule.json`),
            loadJSON(`${RAW}Playlist1.json`),
            // library is optional
            loadJSON(`${RAW}YourLibrary.json`).catch(() => ({}))
        ]);

        // populatePlaylists(playlist); // Removed
        tables = transform({ wrapped, capsule, playlist, library });

        setStatus(true, "Loaded. Dashboard ready.");
        renderAll();
    } catch (err) {
        console.error(err);
        setStatus(false, "Failed to load data. Check file paths and run a local server.");
    }
}

main();
