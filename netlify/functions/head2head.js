// netlify/functions/head2head.js
//
// On-demand lookup of the historical head-to-head record between the two
// teams in a specific fixture. Deliberately NOT called automatically for
// every match on a page — it's fetched lazily when the user expands a
// match card, so scanning many leagues (Top Picks) doesn't multiply this
// on top of the standings/fixtures calls and blow the free-tier rate limit.
//
// Same honesty rules as the rest of the site: head-to-head samples are
// usually small (a handful of meetings), so this is presented as historical
// record, not a prediction signal to be taken as certainty.

const FOOTBALL_DATA_BASE = "https://api.football-data.org/v4";
const H2H_LIMIT = 10; // most recent meetings to consider

exports.handler = async (event) => {
  try {
    const apiKey = process.env.FOOTBALL_API_KEY;
    if (!apiKey) {
      return errorResponse(500, "Missing FOOTBALL_API_KEY environment variable.");
    }

    const matchId = event.queryStringParameters && event.queryStringParameters.matchId;
    if (!matchId) {
      return errorResponse(400, "Missing required 'matchId' query parameter.");
    }

    const data = await fetchJSON(
      `${FOOTBALL_DATA_BASE}/matches/${encodeURIComponent(matchId)}/head2head?limit=${H2H_LIMIT}`,
      apiKey
    );

    const summary = summarizeHeadToHead(data);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summary),
    };
  } catch (err) {
    return errorResponse(502, err.message || "Couldn't fetch head-to-head data.");
  }
};

async function fetchJSON(url, apiKey) {
  const res = await fetch(url, { headers: { "X-Auth-Token": apiKey } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`football-data.org error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Defensive parsing: the exact response shape isn't something we can verify
// from this build environment (no live network access to football-data.org
// here), so this handles the documented `aggregates` shape if present, and
// falls back to computing the same summary from the raw `matches` list if
// the shape differs or `aggregates` is missing.
function summarizeHeadToHead(data) {
  const matches = data.matches || [];

  if (data.aggregates && data.aggregates.homeTeam && data.aggregates.awayTeam) {
    const agg = data.aggregates;
    return {
      totalMeetings: agg.numberOfMatches || matches.length,
      homeTeamName: agg.homeTeam.name,
      homeTeamWins: agg.homeTeam.wins || 0,
      awayTeamName: agg.awayTeam.name,
      awayTeamWins: agg.awayTeam.wins || 0,
      draws: agg.homeTeam.draws || agg.awayTeam.draws || 0,
      recentMatches: recentMatchSummaries(matches),
      disclaimer:
        "Historical record between these two teams. A handful of past meetings is not a reliable predictor on its own — treat it as context, not certainty.",
    };
  }

  return summarizeFromRawMatches(matches);
}

function summarizeFromRawMatches(matches) {
  if (!matches.length) {
    return {
      totalMeetings: 0,
      recentMatches: [],
      disclaimer: "No prior meetings found between these two teams in the available data.",
    };
  }

  const tally = {}; // teamId -> { name, wins }
  let draws = 0;

  matches.forEach((m) => {
    const home = m.homeTeam;
    const away = m.awayTeam;
    const homeGoals = m.score && m.score.fullTime && m.score.fullTime.home;
    const awayGoals = m.score && m.score.fullTime && m.score.fullTime.away;

    if (homeGoals == null || awayGoals == null) return;

    if (!tally[home.id]) tally[home.id] = { name: home.name, wins: 0 };
    if (!tally[away.id]) tally[away.id] = { name: away.name, wins: 0 };

    if (homeGoals > awayGoals) tally[home.id].wins++;
    else if (awayGoals > homeGoals) tally[away.id].wins++;
    else draws++;
  });

  const teams = Object.values(tally);

  return {
    totalMeetings: matches.length,
    teams,
    draws,
    recentMatches: recentMatchSummaries(matches),
    disclaimer:
      "Historical record between these two teams. A handful of past meetings is not a reliable predictor on its own — treat it as context, not certainty.",
  };
}

function recentMatchSummaries(matches) {
  return matches.slice(0, 5).map((m) => ({
    utcDate: m.utcDate,
    homeTeam: m.homeTeam && m.homeTeam.name,
    awayTeam: m.awayTeam && m.awayTeam.name,
    homeGoals: m.score && m.score.fullTime && m.score.fullTime.home,
    awayGoals: m.score && m.score.fullTime && m.score.fullTime.away,
    competition: m.competition && m.competition.name,
  }));
}

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}
