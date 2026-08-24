// netlify/functions/predictions.js
//
// Fetches upcoming fixtures + season-to-date team stats from football-data.org,
// then runs a Poisson goal-expectancy model to produce match probabilities.
//
// IMPORTANT: this produces statistical estimates, not certainties. There is no
// version of this function that should ever output "95-100% sure" claims —
// real models top out well below that on match-outcome prediction. See the
// `disclaimer` field returned to the frontend.

const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const HOME_ADVANTAGE = 1.30; // standard simplified-Poisson home-field multiplier
const MAX_GOALS = 8;         // grid truncation point (captures >99.9% of mass)
const MIN_GAMES_FOR_CONFIDENCE = 5;

exports.handler = async (event) => {
  try {
    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) {
      return errorResponse(
        500,
        "Missing FOOTBALL_API_KEY environment variable. Set it in Netlify: Site settings > Environment variables."
      );
    }

    const competition =
      (event.queryStringParameters && event.queryStringParameters.competition) ||
      process.env.DEFAULT_COMPETITION ||
      "PL";

    // Sequential rather than concurrent: firing standings + fixtures at the
    // exact same instant, multiplied across several leagues in the Top Picks
    // scan, was tripping football-data.org's rate limit in practice even
    // though the per-minute total looked safe on paper. Spreading calls out
    // naturally (one after another) instead of bursting them is more
    // reliable, at the cost of each individual league request being a bit
    // slower.
    const standings = await fetchJSON(`${FOOTBALL_DATA_BASE}/competitions/${competition}/standings`, apiKey);
    const fixtures = await fetchJSON(
      `${FOOTBALL_DATA_BASE}/competitions/${competition}/matches?status=SCHEDULED`,
      apiKey
    );

    // Try to pull last season's final standings too, so early-season fixtures
    // (when every team has 0-4 games played) can lean on real per-team history
    // instead of falling back to a flat league-average guess for everyone.
    // This is best-effort: some free-tier keys/competitions may not allow
    // historical season queries, so a failure here just means we skip the
    // blend and fall back to the previous (season-average-only) behavior.
    const previousStandings = await fetchPreviousSeasonStandings(competition, standings, apiKey);

    const teamStats = buildTeamStats(standings, previousStandings);
    const upcoming = (fixtures.matches || []).slice(0, 20); // keep payload light

    const competitionName = (fixtures.competition && fixtures.competition.name) || competition;

    const matches = upcoming
      .map((m) => buildMatchPrediction(m, teamStats))
      .filter(Boolean)
      .map((m) => ({ ...m, competitionCode: competition, competitionName }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competition: competitionName,
        competitionCode: competition,
        generatedAt: new Date().toISOString(),
        model: "Poisson goal-expectancy model (season-to-date attack/defense strength)",
        matches,
        usingHistoricalPrior: teamStats.usingPreviousSeason,
        disclaimer:
          "These are statistical probabilities derived from season-to-date scoring data, not certainties or guarantees. No legitimate model predicts football outcomes at 95-100% accuracy. Treat every figure here as an estimate that can and will be wrong sometimes.",
      }),
    };
  } catch (err) {
    return errorResponse(500, err.message || "Unknown server error");
  }
};

// ---------- data fetching ----------

async function fetchJSON(url, apiKey) {
  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`football-data.org error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Best-effort fetch of last season's final standings, used as a historical
// prior for early-season predictions. Returns null (not a throw) on any
// failure — free-tier keys or certain competitions may not permit querying
// past seasons, and that should degrade gracefully, not break the page.
async function fetchPreviousSeasonStandings(competition, currentStandings, apiKey) {
  try {
    const startYear = guessSeasonStartYear(currentStandings);
    if (!startYear) return null;

    const previousStartYear = startYear - 1;
    return await fetchJSON(
      `${FOOTBALL_DATA_BASE}/competitions/${competition}/standings?season=${previousStartYear}`,
      apiKey
    );
  } catch (err) {
    return null;
  }
}

// football-data.org standings responses typically include a top-level
// `season.startDate` (e.g. "2026-08-15"). Parse the year from that; if it's
// missing for any reason, fall back to a simple calendar-based guess (most
// European domestic seasons start July/August).
function guessSeasonStartYear(standings) {
  const startDate = standings && standings.season && standings.season.startDate;
  if (startDate) {
    const year = parseInt(String(startDate).slice(0, 4), 10);
    if (!Number.isNaN(year)) return year;
  }
  const now = new Date();
  const month = now.getUTCMonth() + 1; // 1-12
  return month >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ---------- team strength model ----------

function extractTeamRows(standingsResponse) {
  const totalTable =
    (standingsResponse && (standingsResponse.standings || []).find((s) => s.type === "TOTAL")) ||
    (standingsResponse && (standingsResponse.standings || [])[0]);
  return (totalTable && totalTable.table) || [];
}

// Builds a simple attack/defense map (relative to that table's own league
// average) for one season's standings table. Used for both current and
// previous season so they're on comparable footing before blending.
function buildSeasonMap(rows) {
  let sumGoalsFor = 0;
  let sumPlayed = 0;
  rows.forEach((r) => {
    sumGoalsFor += r.goalsFor || 0;
    sumPlayed += r.playedGames || 0;
  });

  const leagueAvgGoals = sumPlayed > 0 ? sumGoalsFor / sumPlayed : 1.35;

  const map = {};
  rows.forEach((r) => {
    const played = r.playedGames || 0;
    const goalsFor = r.goalsFor || 0;
    const goalsAgainst = r.goalsAgainst || 0;
    map[r.team.id] = {
      name: r.team.name,
      played,
      goalsFor,
      goalsAgainst,
      attack: played > 0 ? goalsFor / played / leagueAvgGoals : 1,
      defense: played > 0 ? goalsAgainst / played / leagueAvgGoals : 1,
    };
  });

  return { map, leagueAvgGoals };
}

// Combines current-season and previous-season team strength. Early in a
// season (few games played), a team's rating leans heavily on last season's
// actual data instead of a flat "1.0 = average" guess for everyone — real
// history instead of no information. As more current-season games accumulate
// (up to MIN_GAMES_FOR_CONFIDENCE), the blend shifts toward the current
// season, since recent form matters more the more of it we have.
function buildTeamStats(currentStandings, previousStandingsResponse) {
  const current = buildSeasonMap(extractTeamRows(currentStandings));
  const previousRows = previousStandingsResponse ? extractTeamRows(previousStandingsResponse) : [];
  const previous = previousRows.length ? buildSeasonMap(previousRows) : null;

  const map = {};
  Object.keys(current.map).forEach((teamId) => {
    const cur = current.map[teamId];
    const prev = previous && previous.map[teamId];

    const blendWeight = clamp(cur.played / MIN_GAMES_FOR_CONFIDENCE, 0, 1);
    const attack = prev ? blendWeight * cur.attack + (1 - blendWeight) * prev.attack : cur.attack;
    const defense = prev ? blendWeight * cur.defense + (1 - blendWeight) * prev.defense : cur.defense;

    map[teamId] = {
      name: cur.name,
      played: cur.played,
      goalsFor: cur.goalsFor,
      goalsAgainst: cur.goalsAgainst,
      attack,
      defense,
      usedPriorSeason: Boolean(prev) && blendWeight < 1,
    };
  });

  return {
    map,
    leagueAvgGoals: current.leagueAvgGoals,
    usingPreviousSeason: Boolean(previous),
  };
}

// ---------- Poisson model ----------

function factorial(n) {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPMF(lambda, k) {
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// Caps the largest of [homeWin, draw, awayWin] (raw probability mass, not yet
// converted to %) at `maxShare` of `total`, redistributing the excess to the
// other two proportionally so the three still sum to `total`.
function capOutcomeProbabilities(values, total, maxShare) {
  const cap = total * maxShare;
  const maxIdx = values.indexOf(Math.max(...values));
  if (values[maxIdx] <= cap) return values;

  const excess = values[maxIdx] - cap;
  const result = values.slice();
  result[maxIdx] = cap;

  const otherIdxs = [0, 1, 2].filter((i) => i !== maxIdx);
  const othersSum = otherIdxs.reduce((sum, i) => sum + values[i], 0);

  otherIdxs.forEach((i) => {
    result[i] += othersSum > 0 ? excess * (values[i] / othersSum) : excess / 2;
  });

  return result;
}

function buildMatchPrediction(match, teamStats) {
  const home = teamStats.map[match.homeTeam.id];
  const away = teamStats.map[match.awayTeam.id];
  if (!home || !away) return null; // e.g. team not yet in the standings table

  const leagueAvg = teamStats.leagueAvgGoals;

  let expectedHome = home.attack * away.defense * leagueAvg * HOME_ADVANTAGE;
  let expectedAway = away.attack * home.defense * leagueAvg;

  // Guardrails so a tiny sample size can't produce absurd expected-goal values
  expectedHome = clamp(expectedHome, 0.2, 4.5);
  expectedAway = clamp(expectedAway, 0.2, 4.5);

  // Build the joint score-probability grid
  const grid = [];
  let total = 0;
  for (let i = 0; i <= MAX_GOALS; i++) {
    grid[i] = [];
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = poissonPMF(expectedHome, i) * poissonPMF(expectedAway, j);
      grid[i][j] = p;
      total += p;
    }
  }

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let btts = 0;
  let best = { home: 0, away: 0, p: 0 };

  for (let i = 0; i <= MAX_GOALS; i++) {
    for (let j = 0; j <= MAX_GOALS; j++) {
      const p = grid[i][j];
      if (p > best.p) best = { home: i, away: j, p };
      if (i > j) homeWin += p;
      else if (i === j) draw += p;
      else awayWin += p;
      if (i + j >= 3) over25 += p;
      if (i >= 1 && j >= 1) btts += p;
    }
  }

  // Hard safety ceiling: regardless of what the upstream stats say, this
  // site should never present a match-outcome probability that reads as a
  // "sure thing." Cap any single outcome at 90% and redistribute the excess
  // proportionally to the other two outcomes so they still sum to `total`.
  [homeWin, draw, awayWin] = capOutcomeProbabilities([homeWin, draw, awayWin], total, 0.9);

  const pct = (x) => Math.round((x / total) * 1000) / 10; // one decimal place

  return {
    id: match.id,
    utcDate: match.utcDate,
    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,
    expectedGoals: {
      home: Math.round(expectedHome * 100) / 100,
      away: Math.round(expectedAway * 100) / 100,
    },
    probabilities: {
      homeWin: pct(homeWin),
      draw: pct(draw),
      awayWin: pct(awayWin),
      over25: pct(over25),
      under25: pct(total - over25),
      btts: pct(btts),
    },
    mostLikelyScore: {
      home: best.home,
      away: best.away,
      probability: pct(best.p),
    },
    sampleSize: { homePlayed: home.played, awayPlayed: away.played },
    lowSample:
      home.played < MIN_GAMES_FOR_CONFIDENCE || away.played < MIN_GAMES_FOR_CONFIDENCE,
    usedPriorSeasonData: Boolean(home.usedPriorSeason || away.usedPriorSeason),
  };
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}
