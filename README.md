# Bench Grade — trading card condition & value estimator

A single-page web app for eyeballing a trading card's grade and rough resale value from your own photos. No build step, no backend — it's one self-contained HTML file.

## What it does

- Upload or photograph a card's front (and optionally back), with a guided camera frame to help you center it
- Drag corner handles onto the card's edges to measure centering directly from the photo
- Auto-samples corner/edge wear and surface condition from the image, with sliders to override by eye
- Rolls everything into an estimated 1–10 grade
- Scales a market price you supply (e.g. a known PSA 10 sale) down to your estimated grade

## Running it

No installation needed — it's plain HTML/CSS/JS.

**Locally:** open `index.html` directly in a browser, or serve it so the camera works over `https`-like permissions:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

**On GitHub Pages** (free hosting straight from this repo):

1. Push this repo to GitHub (see below)
2. In the repo, go to **Settings → Pages**
3. Under **Build and deployment**, set **Source** to "Deploy from a branch", branch `main`, folder `/ (root)`
4. Save — GitHub will publish it at `https://<your-username>.github.io/<repo-name>/`

The camera feature (`getUserMedia`) requires an `https://` origin (GitHub Pages provides this) or `localhost` — it won't work if you just double-click the file open in some browsers.

## A note on the "Grade with AI" / "Center with AI" buttons

Those two buttons call a Claude capability that only exists inside Claude's own Artifacts runtime (`window.claude.use(...)`). Outside that environment — including here on GitHub Pages — they'll simply report "AI unavailable" and the app falls back to the manual sliders and pixel-based auto-sampling, which work everywhere.

## Disclaimer

This is a desk estimate tool, not a substitute for professional grading (PSA/BGS/SGC/CGC) or real market comps.
