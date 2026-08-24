// ---------- config ----------

// Every league the free football-data.org tier gives us. Same list as the
// dropdown. Used by the Top Picks scanner to sweep all of them.
const LEAGUES = [
  { code: "PL", name: "Premier League" },
  { code: "PD", name: "La Liga" },
  { code: "BL1", name: "Bundesliga" },
  { code: "SA", name: "Serie A" },
  { code: "FL1", name: "Ligue 1" },
  { code: "DED", name: "Eredivisie" },
  { code: "PPL", name: "Primeira Liga" },
  { code: "ELC", name: "Championship" },
  { code: "CL", name: "Champions League" },
  { code: "BSA", name: "Brazil Série A" },
];

const TOP_PICKS_COUNT = 20;
const MAX_PICKS_PER_LEAGUE = 6; // scaled proportionally with TOP_PICKS_COUNT (was 3 of 10)

// football-data.org's free tier allows 10 requests/minute. Each league now
// costs us 3 requests (standings + previous-season standings + fixtures),
// so we sweep in batches of 3 leagues (9 requests) and pause between
// batches to stay under the limit.
const BATCH_SIZE = 3;
const BATCH_PAUSE_MS = 65 * 1000;

// ---------- element refs ----------

const matchesEl = document.getElementById("matches");
const generatedAtEl = document.getElementById("generatedAt");
const competitionSelect = document.getElementById("competition");
const tabTopPicks = document.getElementById("tabTopPicks");
const tabBrowse = document.getElementById("tabBrowse");
const browseControls = document.getElementById("browseControls");
const rescanBtn = document.getElementById("rescanBtn");

let currentView = "toppicks"; // "toppicks" | "browse"
let topPicksCache = null; // { generatedAt, picks, leaguesScanned, leaguesFailed }
let scanInProgress = false;
const h2hCache = {}; // matchId -> summary data, so repeat expands don't re-fetch

matchesEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".h2h-toggle");
  if (!btn) return;
  toggleHeadToHead(btn.dataset.matchId);
});

async function toggleHeadToHead(matchId) {
  const panel = document.getElementById(`h2h-panel-${matchId}`);
  const btn = document.querySelector(`.h2h-toggle[data-match-id="${matchId}"]`);
  if (!panel) return;

  const isOpen = panel.classList.contains("open");
  if (isOpen) {
    panel.classList.remove("open");
    if (btn) btn.textContent = "Head-to-head ▾";
    return;
  }

  panel.classList.add("open");
  if (btn) btn.textContent = "Head-to-head ▴";

  if (h2hCache[matchId]) {
    panel.innerHTML = renderH2H(h2hCache[matchId]);
    return;
  }

  panel.innerHTML = `<p class="h2h-loading">Loading past meetings…</p>`;
  try {
    const res = await fetch(`/.netlify/functions/head2head?matchId=${encodeURIComponent(matchId)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    h2hCache[matchId] = data;
    panel.innerHTML = renderH2H(data);
  } catch (err) {
    panel.innerHTML = `<p class="h2h-loading error">Couldn't load head-to-head history: ${escapeHtml(err.message)}</p>`;
  }
}

function renderH2H(data) {
  if (!data.totalMeetings) {
    return `<p class="h2h-empty">${escapeHtml(data.disclaimer || "No prior meetings found between these two teams.")}</p>`;
  }

  let recordLine = "";
  if (data.homeTeamName) {
    recordLine = `${escapeHtml(data.homeTeamName)} <strong>${data.homeTeamWins}</strong> — 
      <strong>${data.draws}</strong> draws — 
      ${escapeHtml(data.awayTeamName)} <strong>${data.awayTeamWins}</strong>`;
  } else if (data.teams) {
    recordLine = data.teams
      .map((t) => `${escapeHtml(t.name)} <strong>${t.wins}</strong>`)
      .join(" — ") + ` — <strong>${data.draws || 0}</strong> draws`;
  }

  const recentRows = (data.recentMatches || [])
    .map((m) => {
      const date = m.utcDate ? new Date(m.utcDate).toLocaleDateString() : "";
      const score = m.homeGoals != null && m.awayGoals != null ? `${m.homeGoals}-${m.awayGoals}` : "—";
      return `<li>${date ? `<span class="h2h-date">${date}</span> ` : ""}${escapeHtml(m.homeTeam || "")} ${score} ${escapeHtml(m.awayTeam || "")}</li>`;
    })
    .join("");

  return `
    <p class="h2h-record">${data.totalMeetings} past meeting${data.totalMeetings === 1 ? "" : "s"} — ${recordLine}</p>
    ${recentRows ? `<ul class="h2h-recent">${recentRows}</ul>` : ""}
    <p class="h2h-disclaimer">${escapeHtml(data.disclaimer || "")}</p>
  `;
}

// ---------- view switching ----------

tabTopPicks.addEventListener("click", () => switchView("toppicks"));
tabBrowse.addEventListener("click", () => switchView("browse"));

function switchView(view) {
  currentView = view;
  tabTopPicks.classList.toggle("active", view === "toppicks");
  tabBrowse.classList.toggle("active", view === "browse");
  browseControls.style.display = view === "browse" ? "flex" : "none";
  rescanBtn.style.display = view === "toppicks" ? "inline-flex" : "none";

  if (view === "toppicks") {
    if (topPicksCache) {
      renderTopPicks(topPicksCache);
    } else {
      runTopPicksScan();
    }
  } else {
    loadLeaguePredictions(competitionSelect.value);
  }
}

rescanBtn.addEventListener("click", () => {
  if (!scanInProgress) runTopPicksScan();
});

// ---------- single-league browse (unchanged behavior) ----------

async function loadLeaguePredictions(competition) {
  matchesEl.innerHTML = `<p class="state-message">Loading fixtures…</p>`;
  generatedAtEl.textContent = "";

  try {
    const data = await fetchLeague(competition);
    renderMatches(data);
  } catch (err) {
    matchesEl.innerHTML = `<p class="state-message error">Couldn't load fixtures: ${escapeHtml(err.message)}</p>`;
  }
}

async function fetchLeague(code) {
  const res = await fetch(`/.netlify/functions/predictions?competition=${encodeURIComponent(code)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Wraps fetchLeague with one retry after a pause. We can't perfectly predict
// football-data.org's exact rate-limit behavior from outside, so rather than
// over-engineer the pacing, this just retries a transient failure (e.g. a
// 429) once before giving up on that league for this scan.
async function fetchLeagueWithRetry(code, onRetryWait) {
  try {
    return await fetchLeague(code);
  } catch (err) {
    if (onRetryWait) onRetryWait();
    await sleep(15000);
    return await fetchLeague(code);
  }
}

function renderMatches(data) {
  generatedAtEl.textContent = `Generated ${new Date(data.generatedAt).toLocaleString()} · ${data.model}`;

  if (!data.matches || data.matches.length === 0) {
    matchesEl.innerHTML = `<p class="state-message">No scheduled fixtures found for this competition right now.</p>`;
    return;
  }

  matchesEl.innerHTML = data.matches.map((m) => matchCard(m, { showLeagueTag: false })).join("");
}

competitionSelect.addEventListener("change", () => {
  loadLeaguePredictions(competitionSelect.value);
});

// ---------- top picks: scan all leagues, rank by confidence ----------

function confidenceOf(m) {
  return Math.max(m.probabilities.homeWin, m.probabilities.draw, m.probabilities.awayWin);
}

// Picks the top N by confidence, but caps how many can come from any single
// league. Without this, a league that happens to have more complete data
// (e.g. further into its season than others) can crowd out every other
// league entirely — which defeats the point of a "worldwide" ranking, even
// though each individual number would still be honest. First pass enforces
// the cap; if that leaves slots unfilled (too few leagues have real data),
// a second pass fills the rest by confidence alone.
function selectDiversePicks(sortedPool, count, maxPerLeague) {
  const result = [];
  const leagueCounts = {};

  for (const m of sortedPool) {
    if (result.length >= count) break;
    const key = m.competitionCode || m.competitionName;
    const used = leagueCounts[key] || 0;
    if (used < maxPerLeague) {
      result.push(m);
      leagueCounts[key] = used + 1;
    }
  }

  if (result.length < count) {
    for (const m of sortedPool) {
      if (result.length >= count) break;
      if (!result.includes(m)) result.push(m);
    }
  }

  return result;
}

function confidenceLabel(m) {
  const p = m.probabilities;
  if (p.homeWin >= p.draw && p.homeWin >= p.awayWin) return { side: `${m.homeTeam} win`, value: p.homeWin };
  if (p.awayWin >= p.draw && p.awayWin >= p.homeWin) return { side: `${m.awayTeam} win`, value: p.awayWin };
  return { side: "Draw", value: p.draw };
}

function setProgress(text) {
  generatedAtEl.textContent = text;
}

async function runTopPicksScan() {
  scanInProgress = true;
  rescanBtn.disabled = true;
  matchesEl.innerHTML = `<p class="state-message">Scanning leagues for the strongest picks…</p>`;

  const allMatches = [];
  const leaguesScanned = [];
  const leaguesFailed = [];

  const batches = [];
  for (let i = 0; i < LEAGUES.length; i += BATCH_SIZE) {
    batches.push(LEAGUES.slice(i, i + BATCH_SIZE));
  }

  let leagueIndex = 0;

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];

    // Sequential, not Promise.all: firing every league in a batch at the
    // exact same instant was bursty enough to trip the rate limit even
    // though the batch total looked safe on paper. Processing one at a time
    // (with a short stagger) spreads the load out naturally.
    for (const league of batch) {
      leagueIndex++;
      setProgress(`Scanning ${league.name}… (${leagueIndex}/${LEAGUES.length})`);
      try {
        const data = await fetchLeagueWithRetry(league.code, () =>
          setProgress(`${league.name} hit a rate limit — retrying in 15s… (${leagueIndex}/${LEAGUES.length})`)
        );
        leaguesScanned.push(league.name);
        allMatches.push(
          ...(data.matches || []).map((m) => ({ ...m, competitionName: league.name, competitionCode: league.code }))
        );
      } catch (err) {
        leaguesFailed.push(league.name);
      }
      await sleep(1500); // small stagger between leagues within a batch
    }

    const isLastBatch = b === batches.length - 1;
    if (!isLastBatch) {
      // Respect the free-tier rate limit before starting the next batch.
      const waitSeconds = Math.round(BATCH_PAUSE_MS / 1000);
      for (let s = waitSeconds; s > 0; s--) {
        setProgress(`Pausing ${s}s to stay within the data provider's rate limit…`);
        await sleep(1000);
      }
    }
  }

  // A match has real signal if EITHER it has enough current-season games,
  // OR it leaned on prior-season data (which is genuine historical data, not
  // a flat guess). Only exclude matches with neither — those are the true
  // "everyone's average" cases with nothing real to rank on. Before this
  // fix, `lowSample` alone was used here, which wrongly excluded every
  // early-season match even when prior-season blending gave it a real,
  // meaningful confidence number — collapsing the ranking pool down to
  // whichever league happened to be further into its season already.
  const confident = allMatches.filter((m) => !m.lowSample || m.usedPriorSeasonData);
  const pool = confident.length >= TOP_PICKS_COUNT ? confident : allMatches;
  const usedFallback = confident.length < TOP_PICKS_COUNT;

  const picks = selectDiversePicks(
    pool.slice().sort((a, b) => confidenceOf(b) - confidenceOf(a)),
    TOP_PICKS_COUNT,
    MAX_PICKS_PER_LEAGUE
  );

  topPicksCache = {
    generatedAt: new Date().toISOString(),
    picks,
    leaguesScanned,
    leaguesFailed,
    usedFallback,
  };

  scanInProgress = false;
  rescanBtn.disabled = false;
  renderTopPicks(topPicksCache);
}

function renderTopPicks(cache) {
  const { picks, leaguesScanned, leaguesFailed, usedFallback, generatedAt } = cache;

  let statusLine = `Scanned ${leaguesScanned.length} league${leaguesScanned.length === 1 ? "" : "s"} · Generated ${new Date(generatedAt).toLocaleString()}`;
  if (leaguesFailed.length) {
    statusLine += ` · Rate-limited even after a retry: ${leaguesFailed.join(", ")}`;
  }
  generatedAtEl.textContent = statusLine;

  if (!picks.length) {
    matchesEl.innerHTML = `<p class="state-message">No fixtures found across scanned leagues right now.</p>`;
    return;
  }

  let banner = "";
  if (usedFallback) {
    banner = `<p class="state-message small-sample-banner">
      Not enough season data yet to rank on confidence alone across leagues, so this list
      includes early-season matches too — treat these as more uncertain than usual.
    </p>`;
  }

  matchesEl.innerHTML =
    banner +
    picks
      .map((m, i) => matchCard(m, { showLeagueTag: true, rank: i + 1 }))
      .join("");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- shared match card rendering ----------

function matchCard(m, opts = {}) {
  const kickoff = new Date(m.utcDate).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const p = m.probabilities;
  const rankBadge = opts.rank ? `<span class="rank-badge">#${opts.rank}</span>` : "";
  const leagueTag = opts.showLeagueTag && m.competitionName
    ? `<span class="league-tag">${escapeHtml(m.competitionName)}</span>`
    : "";

  let confidenceBadge = "";
  if (opts.showLeagueTag) {
    const c = confidenceLabel(m);
    confidenceBadge = `<span class="confidence-badge">${escapeHtml(c.side)} · ${c.value}% confidence</span>`;
  }

  return `
    <article class="match-card">
      <div class="match-head">
        <div class="teams">
          ${rankBadge}
          ${escapeHtml(m.homeTeam)} <span class="vs">vs</span> ${escapeHtml(m.awayTeam)}
        </div>
        <div class="match-head-right">
          ${leagueTag}
          <div class="kickoff">${kickoff}</div>
        </div>
      </div>

      ${confidenceBadge ? `<div class="confidence-row">${confidenceBadge}</div>` : ""}

      <div class="score-bar" role="img" aria-label="Home win ${p.homeWin}%, draw ${p.draw}%, away win ${p.awayWin}%">
        <div class="score-seg home" style="flex-basis:${p.homeWin}%">
          <span class="seg-label">Home</span>
          <span class="seg-value">${p.homeWin}%</span>
        </div>
        <div class="score-seg draw" style="flex-basis:${p.draw}%">
          <span class="seg-label">Draw</span>
          <span class="seg-value">${p.draw}%</span>
        </div>
        <div class="score-seg away" style="flex-basis:${p.awayWin}%">
          <span class="seg-label">Away</span>
          <span class="seg-value">${p.awayWin}%</span>
        </div>
      </div>

      <div class="match-meta">
        <div class="meta-stats">
          <span>xG <strong>${m.expectedGoals.home}</strong> – <strong>${m.expectedGoals.away}</strong></span>
          <span>Likely score <strong>${m.mostLikelyScore.home}-${m.mostLikelyScore.away}</strong> (${m.mostLikelyScore.probability}%)</span>
          <span>O/U 2.5 <strong>${p.over25}</strong>/<strong>${p.under25}</strong></span>
          <span>BTTS <strong>${p.btts}%</strong></span>
        </div>
        <div class="match-flags">
          ${m.usedPriorSeasonData ? '<span class="prior-season-flag">Uses last season\u2019s data</span>' : ""}
          ${m.lowSample ? '<span class="low-sample-flag">Small sample</span>' : ""}
        </div>
      </div>

      <button class="h2h-toggle" data-match-id="${m.id}">Head-to-head ▾</button>
      <div class="h2h-panel" id="h2h-panel-${m.id}"></div>
    </article>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- init ----------

switchView("toppicks");
