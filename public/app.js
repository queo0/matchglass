const matchesEl = document.getElementById("matches");
const generatedAtEl = document.getElementById("generatedAt");
const competitionSelect = document.getElementById("competition");

async function loadPredictions(competition) {
  matchesEl.innerHTML = `<p class="state-message">Loading fixtures…</p>`;
  generatedAtEl.textContent = "";

  try {
    const res = await fetch(`/.netlify/functions/predictions?competition=${encodeURIComponent(competition)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }

    renderMatches(data);
  } catch (err) {
    matchesEl.innerHTML = `<p class="state-message error">Couldn't load fixtures: ${escapeHtml(err.message)}</p>`;
  }
}

function renderMatches(data) {
  generatedAtEl.textContent = `Generated ${new Date(data.generatedAt).toLocaleString()} · ${data.model}`;

  if (!data.matches || data.matches.length === 0) {
    matchesEl.innerHTML = `<p class="state-message">No scheduled fixtures found for this competition right now.</p>`;
    return;
  }

  matchesEl.innerHTML = data.matches.map(matchCard).join("");
}

function matchCard(m) {
  const kickoff = new Date(m.utcDate).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const p = m.probabilities;

  return `
    <article class="match-card">
      <div class="match-head">
        <div class="teams">
          ${escapeHtml(m.homeTeam)} <span class="vs">vs</span> ${escapeHtml(m.awayTeam)}
        </div>
        <div class="kickoff">${kickoff}</div>
      </div>

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
        ${m.lowSample ? '<span class="low-sample-flag">Small sample</span>' : ""}
      </div>
    </article>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

competitionSelect.addEventListener("change", () => {
  loadPredictions(competitionSelect.value);
});

loadPredictions(competitionSelect.value);
