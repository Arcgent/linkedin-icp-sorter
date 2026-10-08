# LinkedIn ICP Sorter

Sort every LinkedIn connection into four buckets: **Warm · Maybe warm · Cold · Not relevant**. Then find out who on your Warm list has a reason to talk now, and get a first message you can send.

**New in v2: step 4, Reach out.** For every Warm connection the tool checks the current role and its start date, the real company size and location, recent LinkedIn posts and open jobs. Jev answers *"Is now a good moment to reach out?"* with Now, Soon or Later. Claude drafts a short opener for the people you pick: one question about their work, without a pitch or a link. Nothing is ever sent. You read it, change it and send it yourself.

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
6. **Reach out** in tab 4. Click *Find signals*, then *Draft openers for all Now*. Copy a message, change what you want and send it on LinkedIn yourself.

Trying it with the sample file? Tab 4 then uses made-up signals from `examples/signals.sample.json`, so you can see the whole flow without a Unipile or Apify account.

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

## Step 4: Reach out

Step 4 works on the Warm list of a full run (tick *Include Maybe warm* to add those). Per person it collects:

| Signal | Why it matters |
|---|---|
| New in role (6 months or less) | New leaders change how things run, and they are open to it |
| Open jobs at their company | Growth, or work that piles up |
| Posted on LinkedIn in the last 30 days | They are around to reply, and the post gives you something real to refer to |
| Company size and location from LinkedIn | Step 1 had to guess these from the job title. Now they are checked |

Jev then answers one question per person, *"Is now a good moment to reach out?"*, using your ICP description from tab 1. The answers are **Now** (a clear trigger and the company still fits), **Soon** (fits, no trigger yet) and **Later** (no trigger, or the checked data shows they don't fit after all).

For the people you pick, Claude (through OpenRouter, same key) writes an opener of at most 300 characters: one reason to talk now, one question about their work. No pitch, no link, no meeting request. It writes in Dutch for Dutch and Flemish profiles and in English otherwise. You can edit every message in the app; edits are saved.

### Where the signals come from

Pick one. The app uses whichever keys you set (Unipile wins if both are set; force one with `SIGNALS_PROVIDER`).

- **Unipile** (`UNIPILE_DSN`, `UNIPILE_API_KEY`, `UNIPILE_ACCOUNT_ID`): reads LinkedIn through your own connected account. Four reads per person (profile, company, posts, jobs), about 8 seconds per person. It asks LinkedIn not to send a profile-view notification. Because it is your own account, keep it to 100-150 people a day. People checked in the last 14 days are skipped, so you can spread a long list over a few days.
- **Apify** (`APIFY_TOKEN`): no LinkedIn login. It runs four actors in batches: `harvestapi/linkedin-profile-scraper`, `harvestapi/linkedin-company`, `harvestapi/linkedin-profile-posts` and `curious_coder/linkedin-jobs-scraper`. You pay Apify per result, roughly $0.01-0.02 per person at their current prices. Apify's free plan includes monthly credit.

### What gets sent where in step 4

Step 1 never sends names or profile links. Step 4 has to, because it looks people up:

- **Unipile or Apify** receive the profile URLs of the people on your Warm list (and Maybe warm if you include it). Nobody else from your network.
- **Jev** receives the role, company and the checked facts (months in role, company size and location, open job titles, the first 280 characters of their latest post). No name, no profile link.
- **Claude** receives the first name, headline, role, company and the same facts, only for the people you draft an opener for.
- Everything is cached locally in `data/signals.json` and `data/reachout.json`.

### Speed and cost of step 4

- Unipile: about 8 seconds per person (measured: 5 people in 40 seconds). No cost per call beyond your Unipile plan.
- Jev: about $0.00004 per person.
- Claude opener (Sonnet 5.5): about $0.002-0.005 per opener, depending on the length of their latest post.

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
npm run signals                        # step 4: signals + Jev's Now/Soon/Later for the Warm list of the latest run
npm run signals -- --limit 25 --maybe  # newest 25 people, Maybe warm included
npm run openers                        # draft openers for everyone on Now (nothing is sent)
npm run openers -- --which soon        # or for Soon
```

## Configuration (`.env`)

| Variable | Default | |
|---|---|---|
| `OPENROUTER_API_KEY` | – | required |
| `JEV_MODEL` | `~typesafe/jev-latest` | pin a specific Jev version |
| `JEV_DIRECT` + `TYPESAFE_API_KEY` | off | call TypeSafe directly instead of OpenRouter |
| `PORT` | `3161` | local app port |
| `UNIPILE_DSN`, `UNIPILE_API_KEY`, `UNIPILE_ACCOUNT_ID` | – | step 4 signals, and `npm run engagement` |
| `APIFY_TOKEN` | – | step 4 signals without a LinkedIn login |
| `SIGNALS_PROVIDER` | auto | `unipile` or `apify` when both are set |
| `SIGNALS_PAUSE_MS` | `1500` | pause between Unipile reads |
| `OPENER_MODEL` | `anthropic/claude-sonnet-5.5` | OpenRouter model for the openers |
| `OPENER_LANGUAGE` | `auto` | force a language for the openers, e.g. `en` or `nl` |

## Files

Everything the app creates lives in `data/`, which git ignores:

- `records.json`: what Jev receives per connection
- `people.json`: id → name and profile URL (local only)
- `setup.json`: your saved setup (the example setup is used until you save your own)
- `runs/`: every full run with its results and the setup version it used
- `labels.json`: your own answers from tab 3
- `signals.json`: the looked-up signals per person (step 4)
- `reachout.json`: Jev's Now/Soon/Later and your openers (step 4)

## About

Built by Robin van Veen at [Arcgent](https://arcgent.ai). We help companies become AI-native, one process at a time.

**Want to know how Arcgent can help your company become AI-native?** [Book a 30-minute call](https://cal.com/robin-van-veen-x9jhid/30min).

## License

MIT
