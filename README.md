# Matchglass — statistical football match probabilities

A small site that shows **calibrated probabilities** for upcoming football
fixtures, computed with a Poisson goal-expectancy model. It does **not**
claim "sure games" or 95–100% accuracy — no legitimate model can back that
claim, and marketing it that way is what separates a useful tool from a
scam tipster site. See "Why not 95–100%?" below if you want the full reasoning.

## What's in this project

```
football-predictor/
├── netlify.toml              # tells Netlify where the site + functions live
├── package.json
├── .env.example               # copy to .env for local dev
├── netlify/functions/
│   └── predictions.js         # fetches fixtures + team stats, runs the model
└── public/
    ├── index.html
    ├── style.css
    └── app.js                 # fetches from the function, renders the cards
```

## How the model works

1. For the selected competition, it pulls the current league table (goals
   for/against per team) and the list of scheduled fixtures.
2. Each team gets an **attack strength** (goals scored per game, relative to
   the league average) and **defense strength** (goals conceded per game,
   relative to league average).
3. For a given fixture, expected goals are:
   `home xG = home attack × away defense × league average × home advantage`
   `away xG = away attack × home defense × league average`
4. Those two expected-goals numbers feed a Poisson distribution to build a
   full score-probability grid (0-0, 1-0, 2-1, etc.), which is then summed
   into home win / draw / away win / over-under / both-teams-to-score
   percentages.

This is a well-established, simplified approach (the same family as
Dixon-Coles models used in real analytics). It does **not** account for
injuries, suspensions, weather, tactical news, or recent form beyond the
season aggregate — it's a solid baseline, not a finished product. Matches
early in a season get a "small sample" flag because there's less data to
work with.

## Top Picks (cross-league confidence ranking)

The site's landing view is now **Top Picks**, not a single league. Instead
of picking one competition, it sweeps all 9 covered leagues, scores every
scheduled fixture with the same Poisson model above, and ranks the whole
pool by **confidence** — how lopsided the model's own home/draw/away
probabilities are for that match, not any external "certainty" claim.

A few deliberate choices worth knowing about:

- **It's a ranking of the model's own outputs, not a guarantee.** "#1 pick,
  72% confidence" means the model's probability split favors one outcome
  more than any other match in the pool — it does not mean 72% of the time
  this specific game goes that way in some verified sense. Same honesty
  rules as the rest of the site apply.
- **Matches flagged `lowSample` are excluded from ranking when possible.**
  Early in a season, most/all matches only have league-average data to work
  from (see "small sample" above) — ranking those by "confidence" would
  just be ranking noise. The scan only falls back to including them if
  there genuinely aren't 20 matches with real season data yet, and it says
  so on-screen when that happens.
- **The scan takes a few minutes.** football-data.org's free tier is
  rate-limited to 10 requests/minute, and covering 10 leagues costs 30
  requests (standings + previous-season standings + fixtures per league).
  The frontend processes leagues one at a time with a short pause between
  each, and pauses longer between groups of 3 to stay under the limit, with
  a visible progress readout the whole time. If a league still gets
  rate-limited, it retries once after 15 seconds before giving up on it.
  Results are cached in the browser tab until you hit **Rescan**, so you're
  not re-paying that wait every time you switch tabs.
- **A single league can't dominate the whole list.** No more than 3 of the
  top 20 can come from any one league (`MAX_PICKS_PER_LEAGUE` in `app.js`).
  Without this, a league that happens to be further into its season (and so
  has more real data to differentiate teams with) can crowd out every other
  league entirely — technically honest numbers, but it defeats the point of
  a *worldwide* ranking. The cap only relaxes if there genuinely aren't
  enough other leagues with real matches to fill the list otherwise.
- **Only goals-based markets are ranked** (result, over/under 2.5, BTTS,
  correct score) — the free data source doesn't cover corners, cards, or
  bookings, so those aren't part of this feature. See "Extending it" below.

## Using historical data, not just this season

Two features address the same underlying issue: early in a season, current-
season stats alone aren't enough to tell teams apart.

- **Prior-season blending.** Each team's attack/defense rating now blends
  this season's data with last season's final numbers, weighted by how many
  games have been played this season (`played / 5`, capped at 1). At 0 games
  played, a team's rating is 100% last season's real data instead of a flat
  "average" guess; by 5 games in, it's 100% current-season. Matches that
  leaned on last season's data are marked `usedPriorSeasonData` and show a
  "Uses last season's data" badge. This is best-effort — if a competition or
  key doesn't allow querying past seasons, it fails quietly and falls back
  to the original flat-average behavior (no broken page).
- **Head-to-head lookup.** Every match card has a "Head-to-head" toggle that
  lazily fetches the historical record between those two specific teams
  (past meetings, W/D/L split, last 5 scorelines) via
  `netlify/functions/head2head.js`. It's on-demand, not fetched automatically
  for every fixture, specifically to avoid multiplying API calls across a
  9-league Top Picks scan. Head-to-head samples are usually small (a handful
  of meetings), so it's presented as historical context, not a prediction
  signal — same anti-hype approach as everywhere else on the site.

**Worth knowing:** the exact depth of historical data football-data.org's
free tier allows (how many past seasons, head-to-head coverage per
competition) wasn't verified against the live API while building this —
this environment can only reach package registries, not football-data.org
itself. Both features are written to fail gracefully and fall back to
existing behavior if a historical call isn't available on your key, but
it's worth checking after deploying that they're returning real data and not
silently falling back every time.

## Coverage: 10 leagues, including one outside Europe

Verified live against football-data.org's current coverage page while
building this: the free tier is **12 competitions total**, and — usefully —
**Brazil's Série A is one of them**, alongside the 9 European leagues/cups
already covered. It's now included as league code `BSA`. This is genuine,
zero-cost South American coverage; going further (Argentina, MLS, Japan, and
the rest) requires a paid tier, since football-data.org gates broader
worldwide coverage behind Standard (€49/mo, 30 competitions), Advanced
(€99/mo, 50 competitions), and Pro (€199/mo, 100 competitions) — verified
current pricing, not a guess. Two other paid add-ons worth knowing about if
you want to go further later: a **Statistics add-on (€15/mo)** that adds
corners/cards/bookings data, and an **Odds add-on (€15/mo)** with real
bookmaker pre-match odds — both would meaningfully extend what this model
can do, but neither is wired in yet.

## Rate-limit reliability

Earlier versions of the Top Picks scan fired all of a batch's requests at
the same instant, which — even though the batch's total stayed under the
free tier's 10-requests/minute cap on paper — turned out to trip the rate
limit in practice; bursts seem to matter, not just the per-minute average.
Fixed two ways:
- **Sequential fetching**, both inside each league's own function
  (`predictions.js` now awaits standings, then fixtures, then previous
  season, one at a time instead of firing two at once) and across leagues
  in a Top Picks batch (processed one at a time with a short stagger,
  instead of all at once via `Promise.all`).
- **Retry with backoff**: if a league's request still fails, the scanner
  waits 15 seconds and tries once more before giving up on that league for
  the scan. The status line will say "Rate-limited even after a retry" for
  any league that still couldn't be reached, so it's visible rather than
  silently missing.

## Step 1 — Get a free football data API key

1. Go to https://www.football-data.org/client/register and sign up (free tier).
2. You'll get an API key by email. Free tier covers ~12 major competitions
   (Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Champions League,
   Eredivisie, Primeira Liga, Championship, and a few others) and is rate
   limited to **10 requests/minute** — fine for this app since the Netlify
   function is cached for 2 minutes per competition (see `netlify.toml`).

## Step 2 — Run it locally (optional but recommended)

You'll need [Node.js](https://nodejs.org) installed (v18+).

```bash
cd football-predictor
npm install
cp .env.example .env
# edit .env and paste your FOOTBALL_API_KEY in
npx netlify dev
```

This starts a local server (usually `http://localhost:8888`) that runs both
the static site and the serverless function together, so you can test
before deploying.

## Step 3 — Push it to GitHub

```bash
cd football-predictor
git init
git add .
git commit -m "Initial commit: Matchglass"
```

Create a new empty repo on GitHub (github.com → New repository), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```

## Step 4 — Deploy on Netlify

1. Go to https://app.netlify.com and sign up / log in (GitHub login is easiest).
2. **Add new site → Import an existing project → Deploy with GitHub**, and
   pick the repo you just pushed.
3. Netlify will auto-detect the settings from `netlify.toml`
   (publish directory `public`, functions directory `netlify/functions`) —
   you shouldn't need to change anything in the build settings screen.
4. Before the first deploy finishes being useful, go to **Site
   configuration → Environment variables** and add:
   - `FOOTBALL_API_KEY` = the key you got in Step 1
   - `DEFAULT_COMPETITION` = `PL` (optional)
5. Trigger a deploy (or it'll deploy automatically once you save the repo
   import). Netlify gives you a URL like `random-name-123.netlify.app`
   immediately — you can add a custom domain later under **Domain
   management** if you want.

That's it — the site is live. Every time you `git push` to `main`, Netlify
redeploys automatically.

## Extending it

Good next steps, roughly in order of value:

- **Home/away split stats** — right now attack/defense strength uses overall
  season stats. Splitting into home-specific and away-specific scoring rates
  (football-data.org supports `?type=HOME` / `?type=AWAY` standings queries
  on some plans) would sharpen the home-advantage estimate.
- **Recent form weighting** — weight the last 5-6 games more heavily than
  the full season, so a team's current form matters more than August results.
- **Track record page** — store each prediction and the actual result, then
  show your own historical accuracy on the site. This is the single best
  thing you can do for credibility — real, visible track records beat any
  marketing copy.
- **More goals-based markets** — Asian handicap, correct score, first-team-
  to-score — all extensions of the same Poisson grid already being computed.
- **Cards, corners, bookings, first goalscorer** — these are genuinely out
  of reach on the current free data source, which only reports goals and
  results. They'd need a different/additional provider (e.g. a paid tier
  with match-event data) plus a separate statistical model, since Poisson
  goal-expectancy doesn't extend to those markets on its own.
- **True worldwide coverage** — the current 9 leagues are all European. South
  America, Asia, and the rest of Africa would need another data source
  layered in alongside football-data.org.

## Why not 95–100%?

Football has real, irreducible randomness in it — a deflection, a red card,
a goalkeeper's error. Even the best professional models (the ones used by
bookmakers and analytics firms with far more data than this project has)
land around 50-60% accuracy on match-outcome predictions. Anything claiming
near-certainty on individual games is either misunderstanding its own
numbers or selling something. Framing this as calibrated probabilities
instead is both more honest and, for anyone actually using it, more useful:
a real edge compounds over many bets; a fake "sure thing" just fails
unpredictably.

## One more thing worth checking

If you plan to monetize this (subscriptions, ads, tipster-style access)
rather than run it as a personal tool, it's worth checking whether tipster
or prediction services fall under gambling-adjacent advertising or
licensing rules in whatever country you're targeting — this varies a lot
by jurisdiction and isn't something to assume your way through.
