# portfolio-screener-data

Data bridge for the *portfolio-screener* Google Apps Script project.

SEC EDGAR answers **HTTP 403** to Google Apps Script (Akamai blocks it, including
`data.sec.gov`), so a GitHub Actions job fetches the XBRL data instead and publishes it here as
static JSON. The Apps Script project reads these files from `raw.githubusercontent.com`.

## What is published

| File | Content |
|---|---|
| `data/<TICKER>.json` | `{ ticker, cik, generatedAt, tags: { "<taxonomy>/<TAG>": <companyconcept JSON, trimmed> } }` — one file per ticker |
| `data/meta.json` | `{ generatedAt, tickersTotal, succeeded, unchanged, failed, tagCount, failures: [{ticker, reason}], error? }` |

Concept JSON is trimmed to the 12 most recent period ends and to annual/quarterly filings
(10-K, 10-Q, 20-F, 40-F and their amendments). The tag list is `TAGS` in
`scripts/fetch_sec.mjs` and must stay identical to `EDGAR_TAGS` in the Apps Script project's
`src/Edgar.gs`.

Data refreshes **once a day** (04:00 UTC). A bundle is rewritten only when its data changed or it
is 3+ days old, so most days only `meta.json` changes. If a ticker fails, its previous file is
kept; the consumer ignores any file older than 5 days.

## Setup

1. Add the secret (it prompts for the value; nothing is stored in the repo):
   `gh secret set SEC_CONTACT_EMAIL`
   SEC requires a contact in the User-Agent. The workflow sends
   `PortfolioScreener/1.0 (<that email>)` and never prints or commits it.
2. Run the workflow once: `gh workflow run sec-data.yml`, then `gh run watch`.
3. Edit `tickers.txt` to change the universe (one ticker per line; optional `TICKER,CIK`).

## Local use

```
node --test scripts/fetch_sec.test.mjs        # unit tests (no network)
SEC_CONTACT_EMAIL=you@example.com node scripts/fetch_sec.mjs
```

Requires Node 20+, no dependencies.

## Planned

Stage 2 of the screener will also need 10-K sections (Risk Factors, MD&A); this bridge is
where they will be published.
