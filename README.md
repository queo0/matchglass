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
- **More markets** — Asian handicap, correct score, first-team-to-score —
  all extensions of the same Poisson grid already being computed.

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
