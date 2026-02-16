import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const RAW = "./data/raw/";

const state = {
    selectedArtistName: null,
    selectedPlaylistName: "ALL",
    dateRange: null,          // [Date, Date]
    shortlist: new Map(),     // trackUri -> {trackName, artistName, count, msPlayed}
    raceMetric: "streamCount",
    racePlaying: true
};

let tables = null;
let raceTimer = null;
let raceIndex = 0;

const els = {
    playlistSelect: document.getElementById("playlistSelect"),
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
        selectedPlaylistName: "ALL",
        dateRange: null
    });
    els.playlistSelect.value = "ALL";
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

    // Highlights
    // Highlights (Sound Capsule) — parse per highlightType
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


    return { topTracks, playlistAdds, raceFrames, highlights };
}

// ---------- Charts ----------
function drawTopTracksChart(data, mode = "plays") {
    // mode: "plays" (Wrapped) or "adds" (from filtered playlist additions)
    const container = d3.select("#chartTopTracks");
    const W = container.node().clientWidth;
    const H = 320;

    const margin = { top: 22, right: 12, bottom: 70, left: 46 };
    const width = Math.max(320, W);
    const height = H;

    const rows = data.slice(0, 15);

    const x = d3.scaleBand()
        .domain(rows.map(d => d.trackUri))
        .range([margin.left, width - margin.right])
        .padding(0.2);

    const y = d3.scaleLinear()
        .domain([0, d3.max(rows, d => d.count) || 1])
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
        .call(d3.axisBottom(x).tickFormat(() => ""))
        .call(g => g.selectAll("path,line").attr("stroke", "rgba(21,34,59,0.18)"));

    // Title hint (dynamic)
    const label = mode === "adds" ? "Adds (from current filters)" : "Plays (Wrapped)";
    svg.append("text")
        .attr("x", margin.left)
        .attr("y", 14)
        .attr("fill", "#53627d")
        .attr("font-size", 11)
        .text(`Top 15 tracks by ${label}`);

    const bars = svg.append("g").selectAll("rect")
        .data(rows, d => d.trackUri)
        .join("rect")
        .attr("x", d => x(d.trackUri))
        .attr("y", d => y(d.count))
        .attr("width", x.bandwidth())
        .attr("height", d => y(0) - y(d.count))
        .attr("fill", d => state.shortlist.has(d.trackUri) ? "#60a5fa" : "rgba(96,165,250,0.55)")
        .attr("stroke", d => state.shortlist.has(d.trackUri) ? "#e7eaf2" : "transparent")
        .attr("stroke-width", 1)
        .style("cursor", "pointer")
        .on("click", (_, d) => {
            if (state.shortlist.has(d.trackUri)) state.shortlist.delete(d.trackUri);
            else state.shortlist.set(d.trackUri, d);

            renderShortlist();
            // redraw *the same dataset you’re currently viewing*
            drawTopTracksChart(data, mode);
        });

    // Tooltip (dynamic wording)
    bars.append("title").text(d => {
        const metricWord = mode === "adds" ? "adds" : "plays";
        return `${d.trackName} — ${d.artistName}\n${metricWord}: ${d.count}`;
    });

    // Rank labels (1..15)
    svg.append("g")
        .selectAll("text.rank")
        .data(rows, d => d.trackUri)
        .join("text")
        .attr("class", "rank")
        .attr("x", d => x(d.trackUri) + x.bandwidth() / 2)
        .attr("y", height - margin.bottom + 14)
        .attr("text-anchor", "middle")
        .attr("fill", "#53627d")
        .attr("font-size", 10)
        .text((d, i) => i + 1);
}


function drawPlaylistTimeline(allAdds) {
    const container = d3.select("#chartPlaylistTimeline");
    const W = container.node().clientWidth;
    const H = 320;

    const margin = { top: 16, right: 12, bottom: 36, left: 46 };
    const width = Math.max(320, W);
    const height = H;

    const norm = s => (s || "").toLowerCase().trim();

    let adds = allAdds
        .filter(d => state.selectedPlaylistName === "ALL" || d.playlistName === state.selectedPlaylistName);

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
    if (state.dateRange) {
        const [a, b] = state.dateRange;
        svg.select("g").call(brush.move, [x(a), x(b)]);
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
                .attr("x", d => x(d.value) + 6)
                .attr("y", d => y(d.artistName) + y.bandwidth() / 2)
                .attr("dy", "0.35em")
                .attr("fill", "#e7eaf2")
                .attr("font-size", 12)
                .text(d => `${d.artistName} (${d.value})`),
            update => update,
            exit => exit.transition(t).style("opacity", 0).remove()
        )
            .transition(t)
            .attr("x", d => x(d.value) + 6)
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

    // Apply playlist filter
    if (state.selectedPlaylistName !== "ALL") {
        filteredAdds = filteredAdds.filter(d => d.playlistName === state.selectedPlaylistName);
    }

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
    const anyFilterActive =
        state.selectedPlaylistName !== "ALL" || !!state.dateRange || !!state.selectedArtistName;

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
    drawHighlightsTimeline(tables.highlights);
    renderShortlist();
}


// ---------- Wire controls ----------
function wireControls() {
    els.playlistSelect.addEventListener("change", (e) => {
        setState({ selectedPlaylistName: e.target.value });
    });

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
    const names = (playlistJson.playlists || []).map(p => p.name).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        els.playlistSelect.appendChild(opt);
    }
}

function drawHighlightsTimeline(highlightsRaw) {
  const container = d3.select("#panelHighlights");
  if (container.empty()) {
    console.error("drawHighlightsTimeline: #panelHighlights not found");
    return;
  }

  const rect = container.node().getBoundingClientRect();
  const width = Math.max(360, rect.width || 0);
  const height = 240;

  const margin = { top: 18, right: 16, bottom: 36, left: 200 };

  // Parse + normalize
  const highlights = (highlightsRaw || [])
    .map(d => ({
      ...d,
      date: d.date ? new Date(d.date) : (d.timestamp ? new Date(d.timestamp) : null),
      type: d.type || d.highlightType || d.category || "UNKNOWN",
    }))
    .filter(d => d.date && !Number.isNaN(+d.date));

  if (highlights.length === 0) {
    container.html(`<p class="meta-text">No highlights found.</p>`);
    return;
  }

  // If you have a global dateRange filter, apply it
  const filtered = (state && state.dateRange)
    ? highlights.filter(d => d.date >= state.dateRange[0] && d.date <= state.dateRange[1])
    : highlights;

  const types = Array.from(new Set(filtered.map(d => d.type)));

  // Fixed-ish order
  const preferred = [
    "STREAKS",
    "MILESTONE",
    "UNLIKE_COMBINATION",
    "ON_REPEAT",
    "FIRST_TO_DISCOVER",
    "PROPORTION_LISTENING_ENTITY",
    "UNKNOWN",
  ];
  const typeOrder = preferred.filter(t => types.includes(t)).concat(types.filter(t => !preferred.includes(t)));

  const xDomain = d3.extent(filtered, d => d.date);
  const x = d3.scaleTime()
    .domain(xDomain[0] && xDomain[1] ? xDomain : [new Date("2025-01-01"), new Date("2025-12-31")])
    .range([margin.left, width - margin.right]);

  const y = d3.scalePoint()
    .domain(typeOrder)
    .range([margin.top, height - margin.bottom])
    .padding(0.7);

  const svg = container.html("")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  // Left axis + horizontal gridlines
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).tickSize(-(width - margin.left - margin.right)))
    .call(g => g.selectAll(".tick line").attr("stroke", "rgba(21,34,59,0.12)"))
    .call(g => g.selectAll(".domain").attr("stroke", "rgba(21,34,59,0.18)"))
    .call(g => g.selectAll("text").attr("fill", "#53627d").attr("font-size", 12));

  // Bottom axis
  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(Math.min(6, width / 140)))
    .call(g => g.selectAll(".domain").attr("stroke", "rgba(21,34,59,0.18)"))
    .call(g => g.selectAll("line").attr("stroke", "rgba(21,34,59,0.12)"))
    .call(g => g.selectAll("text").attr("fill", "#53627d"));

  // Deterministic tiny jitter (prevents exact overlap)
  const jitter = (key) => {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return ((h % 9) - 4) * 1.2;
  };

  const color = d3.scaleOrdinal()
    .domain(typeOrder)
    .range(["#22c55e", "#6366f1", "#06b6d4", "#ec4899", "#f59e0b", "#8b5cf6", "#94a3b8"]);

  svg.append("g")
    .selectAll("circle")
    .data(filtered, d => `${d.type}-${+d.date}-${d.entity || ""}`)
    .join("circle")
    .attr("cx", d => x(d.date))
    .attr("cy", d => y(d.type) + jitter(`${d.type}-${d3.timeDay.floor(d.date)}`))
    .attr("r", 6)
    .attr("fill", d => color(d.type))
    .attr("opacity", 0.95)
    .attr("stroke", "white")
    .attr("stroke-width", 2)
    .style("cursor", "pointer")
    .on("click", (_, d) => {
      const start = new Date(+d.date - 7 * 24 * 3600 * 1000);
      const end   = new Date(+d.date + 7 * 24 * 3600 * 1000);
      setState({ dateRange: [start, end] });
      updateChips();
    })
    .append("title")
    .text(d => {
      const day = d.date.toISOString().slice(0, 10);
      const extra = d.entity || d.entityName || d.trackName || d.artistName || d.value || "";
      return `${day}\n${d.type}${extra ? `\n${extra}` : ""}\n(click to filter dates)`;
    });
}




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

        populatePlaylists(playlist);
        tables = transform({ wrapped, capsule, playlist, library });

        setStatus(true, "Loaded. Dashboard ready.");
        renderAll();
    } catch (err) {
        console.error(err);
        setStatus(false, "Failed to load data. Check file paths and run a local server.");
    }
}

main();
