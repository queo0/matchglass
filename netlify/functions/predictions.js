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

    const [standings, fixtures] = await Promise.all([
      fetchJSON(`${FOOTBALL_DATA_BASE}/competitions/${competition}/standings`, apiKey),
      fetchJSON(`${FOOTBALL_DATA_BASE}/competitions/${competition}/matches?status=SCHEDULED`, apiKey),
    ]);

    const teamStats = buildTeamStats(standings);
    const upcoming = (fixtures.matches || []).slice(0, 20); // keep payload light

    const matches = upcoming
      .map((m) => buildMatchPrediction(m, teamStats))
      .filter(Boolean);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        competition: (fixtures.competition && fixtures.competition.name) || competition,
        generatedAt: new Date().toISOString(),
        model: "Poisson goal-expectancy model (season-to-date attack/defense strength)",
        matches,
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

// ---------- team strength model ----------

function buildTeamStats(standings) {
  const totalTable =
    (standings.standings || []).find((s) => s.type === "TOTAL") ||
    (standings.standings || [])[0];

  const rows = (totalTable && totalTable.table) || [];

  let sumGoalsFor = 0;
  let sumPlayed = 0;
  rows.forEach((r) => {
    sumGoalsFor += r.goalsFor;
    sumPlayed += r.playedGames;
  });

  // League-wide average goals scored per team per match. If the season just
  // started and there's no data yet, fall back to a reasonable prior (1.35,
  // roughly the long-run average across major European leagues).
  const leagueAvgGoals = sumPlayed > 0 ? sumGoalsFor / sumPlayed : 1.35;

  const map = {};
  rows.forEach((r) => {
    const played = r.playedGames || 0;
    const goalsFor = r.goalsFor || 0;
    const goalsAgainst = r.goalsAgainst || 0;

    // Guard against div-by-zero for teams with no games played yet.
    const attack = played > 0 ? goalsFor / played / leagueAvgGoals : 1;
    const defense = played > 0 ? goalsAgainst / played / leagueAvgGoals : 1;

    map[r.team.id] = {
      name: r.team.name,
      played,
      goalsFor,
      goalsAgainst,
      attack,
      defense,
    };
  });

  return { map, leagueAvgGoals };
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
  };
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}
