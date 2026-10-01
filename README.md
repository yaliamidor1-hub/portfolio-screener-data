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

## Filings for Stage 2 (qualitative analysis)

`scripts/fetch_filings.mjs` (second workflow step) publishes the text of the latest annual report per ticker:

| File | Content |
|---|---|
| `data/filings/<TICKER>.json` | `{ ticker, form, accession, filingDate, reportDate, sourceUrl, extractorVersion, sections: { business, riskFactors, mdna, legal }, generatedAt }` |

Form = newest original 10-K (20-F / 40-F for foreign filers; no 10-K/A). Sections are plain text after
stripping HTML, capped at 6000 (Item 1 Business), 10000 (Item 1A Risk Factors), 8000 (Item 7 MD&A) and
3000 (Item 3 Legal Proceedings) characters; a section that cannot be located is `null` (never guessed).
20-F extraction is best effort (Items 4, 3.D, 5, 8 Legal Proceedings); 40-F gives all `null` (content is in
exhibits). Per ticker per day: one `data.sec.gov/submissions` call; the document is downloaded only when
the accession changed (or `EXTRACTOR_VERSION` was bumped). Skip/failure reasons are in `data/meta.json` under
`filings`. Same rate limit (<= 4.5 req/s) and secret-only User-Agent as the XBRL step.

## Setup

1. Add the secret (it prompts for the value; nothing is stored in the repo):
   `gh secret set SEC_CONTACT_EMAIL`
   SEC requires a contact in the User-Agent. The workflow sends
   `PortfolioScreener/1.0 (<that email>)` and never prints or commits it.
2. Run the workflow once: `gh workflow run sec-data.yml`, then `gh run watch`.
3. Edit `tickers.txt` to change the universe (one ticker per line; optional `TICKER,CIK`).

## Local use

```
node --test scripts/fetch_sec.test.mjs scripts/fetch_filings.test.mjs   # unit tests (no network)
SEC_CONTACT_EMAIL=you@example.com node scripts/fetch_filings.mjs
SEC_CONTACT_EMAIL=you@example.com node scripts/fetch_sec.mjs
```

Requires Node 20+, no dependencies.

## Planned

Possible later additions: 10-Q text, earnings-call transcripts (only if a free, permitted source exists).

## Tickers: the screener's Universe is the source of truth

`scripts/sync_tickers.mjs` (first step of the workflow) asks the screener's web app for the active `market=US`
tickers of its `Universe` tab and rewrites `tickers.txt` (existing `TICKER,CIK` lines are kept). If the call fails,
the answer is empty, or it is not a plain ticker list, `tickers.txt` is left untouched and the log shows a
`::warning::` — the run continues with the existing list. IL tickers are never included.

Repository secrets (Settings → Secrets and variables → Actions): `SCREENER_WEBAPP_URL` (the web app's `/exec` URL)
and `TICKERS_TOKEN` (same value as the Apps Script Script Property `TICKERS_TOKEN`). Neither is ever logged. Set them
without putting values in a chat or a file: `gh secret set TICKERS_TOKEN` (it prompts for the value) or the GitHub UI.

## Facts and earnings releases (for Stage 2 and its verification)

| File | Content |
|---|---|
| `data/facts/<TICKER>.json` | up to 6 fiscal years: revenue, grossProfit, operatingIncome, netIncome, operatingCashFlow, capex, freeCashFlow, cash, longTermDebt, shortTermDebt, equity + growth, margins, cashConversion. Built offline by `scripts/build_facts.mjs` from the XBRL bundles; a missing value is `null` |
| `data/releases/<TICKER>.json` | `{ ticker, generatedAt, releases: [{ accession, filingDate, reportDate, url, text }] }` — the latest two earnings releases (8-K Item 2.02, exhibit 99) as plain text, by `scripts/fetch_releases.mjs` |

Schemas of the files Claude writes (`data/reports/`, `data/discovery/`) are in `docs/`.
