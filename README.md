# LinkedIn ICP Sorter

Sort every LinkedIn connection into four buckets: **Warm · Maybe warm · Cold · Not relevant**.

You describe your ideal customer once. Jev by TypeSafe (through OpenRouter) then answers one question for each connection: *"Does this person fit my ICP?"*. That's one API call per connection, and hundreds run in parallel.

Measured on a real network of 25,033 connections: **71 seconds, $0.99**.

It runs locally. Your connections file, names and results stay on your machine. Jev only gets a few profile fields per person, never a name or profile link.

> **Want to know how Arcgent can help your company become AI-native?** [Book a 30-minute call](https://cal.com/robin-van-veen-x9jhid/30min).

## What you need

- **Node 22+.** Nothing to `npm install`.
- **An OpenRouter API key** ([openrouter.ai/keys](https://openrouter.ai/keys)). A full run of 25k connections costs about $1.
- **Your LinkedIn connections as a CSV.** On LinkedIn, go to *Settings → Data privacy → Get a copy of your data*, choose *Connections* and download the export when it arrives. It usually takes a few minutes. You need `Connections.csv` from that export.

## Quick start

```bash
git clone https://github.com/Arcgent/linkedin-icp-sorter.git && cd linkedin-icp-sorter
cp .env.example .env                               # paste your OPENROUTER_API_KEY into .env
npm run build -- ~/Downloads/Connections.csv       # or the unzipped export folder
npm start                                          # open http://localhost:3161
```

If you want to try it without your own data first, run `npm run build -- examples/Connections.sample.csv`. That file has 24 made-up connections.

Then:

1. **Edit the setup** in tab 1. The default describes an example ICP: decision makers at 50+ employee companies in or near the Netherlands. Change the context, criteria and bucket descriptions to fit who *you* sell to.
2. **Test a few records** with "Run this record through Jev". You see the bucket, the confidence, the probability for each answer and the exact request.
3. **Run everything** in tab 2. Start with the newest 100 to check the setup, then run all.
4. **Check the answers** in tab 3. Label records yourself and compare them with Jev's. This tells you which confidence line you can trust.
5. **Export** the Warm list, the review tasks or everything as CSV.

## What Jev sees

For each connection Jev receives only these fields:

| Field | From |
|---|---|
| Job title | `Position` in your CSV |
| Company | `Company` in your CSV |
| Headline | only if your CSV has a `Headline` column (LinkedIn's own export doesn't) |
| Engaged with my posts | only if you run `npm run engagement`; otherwise "unknown (not tracked)" |

Names, profile URLs and emails are never sent. They stay in `data/people.json` and only show in the app when you tick **Show names**. "Show exact request" shows the full JSON body for any record.

Location and company size aren't in the export. Jev judges them from the job title, company name and headline, like a person skimming the list would. Unknown size counts as unknown, not as a no.

## The three tabs

1. **One decision.** One record next to your saved setup: the question, the criteria and the answers with their descriptions. You can edit and version the setup here. Every run keeps the exact setup version it used.
2. **Full run.** Runs all connections, or the newest 10,000 / 1,000 / 100. You get a live counter, then the measured runtime and cost, the bucket counts and a confidence-line slider. Records above the line move on; records below it become review tasks. There are CSV exports and a "Retry unanswered" button for anything OpenRouter throttled.
3. **Check against my answers.** Label records first, then see what Jev said. It shows the match rate per confidence band and suggests the lowest confidence line where every checked answer matched.

## Speed and cost

- 25,033 connections at 300 parallel calls took 70.7 s and cost $0.99.
- 300 parallel calls is the sweet spot. Above that, OpenRouter throttles (429) and the runner automatically lowers the number of parallel calls, then climbs back up.
- One request per connection on purpose. Putting many connections in one request was 4x faster and half the price, but only 78–84% of those answers matched the one-per-request answers.

## Optional: engagement with your posts

Engagement makes a borderline fit warmer. The ICP Sorter can count who reacted to or commented on your own posts in the last 90 days. This needs a [Unipile](https://www.unipile.com) account with your LinkedIn connected (set `UNIPILE_*` in `.env`):

```bash
npm run engagement                       # last 90 days, read-only
npm run build -- ~/Downloads/Connections.csv   # rebuild so the records pick it up
```

The script stores only member ids, public profile ids and counts in `data/engagement.json`. It keeps no names and no comment text. Without Unipile, the engagement field says "unknown (not tracked)", and the default setup tells Jev to ignore it.

## Terminal

```bash
npm run one -- c00042                  # one record: bucket, confidence, exact request
npm run run                            # full run, saved to data/runs/
npm run run -- --limit 1000            # newest 1,000
npm run bench -- --n 2000              # speed/cost test on synthetic records, no real data
```

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | – | required |
| `JEV_MODEL` | `~typesafe/jev-latest` | pin a specific Jev version |
| `JEV_DIRECT` + `TYPESAFE_API_KEY` | off | call TypeSafe directly instead of OpenRouter |
| `PORT` | `3161` | local app port |
| `UNIPILE_DSN`, `UNIPILE_API_KEY`, `UNIPILE_ACCOUNT_ID` | – | only for `npm run engagement` |

## Files

Everything the app creates lives in `data/`, which git ignores:

- `records.json`: what Jev receives per connection
- `people.json`: id → name and profile URL (local only)
- `setup.json`: your saved setup (the example setup is used until you save your own)
- `runs/`: every full run with its results and the setup version it used
- `labels.json`: your own answers from tab 3

## About

Built by Robin van Veen at [Arcgent](https://arcgent.ai). We help companies become AI-native, one process at a time.

**Want to know how Arcgent can help your company become AI-native?** [Book a 30-minute call](https://cal.com/robin-van-veen-x9jhid/30min).

## License

MIT
