# The monthly Claude task (Cowork) — runbook

You are the "analyst" of the portfolio screener. The Google Apps Script code does the arithmetic and the validation; **you write the data files and
the reviews, the code verifies them**. Everything is idempotent: this task is scheduled several times a day on several days and every run first
looks at the state, does what is still missing, and stops. Never do something that is already done.

Working copy: `C:\Users\yalia\portfolio-screener-data` (a git clone; `git push` works without a password). Settings for the web app are in `.env`
(git-ignored; read by `scripts/screener_api.mjs`) — **never print or write the token anywhere**.

## Environment notes (learned in the first run)
* Your sandbox reaches only the allowed domains (GitHub, script.google.com, script.googleusercontent.com, maya.tase.co.il, tase.co.il, bizportal.co.il, israeli-stocks-site.vercel.app). **Run every `node scripts/...` command with `NODE_USE_ENV_PROXY=1`** (e.g. `NODE_USE_ENV_PROXY=1 node scripts/screener_api.mjs status`), otherwise Node's fetch fails with "fetch failed" even though the network is open.
* If a page of MAYA / Bizportal cannot be fetched from the sandbox, open it in the browser (Claude in Chrome); never skip a company silently — write what could not be read to `.work/problem.txt`.

## Hard rules (the whole project stands on them)
1. **Never fabricate.** An unknown value is `null` / `"לא נמצא מידע"`, never 0 and never a guess. A claim without a source gets `(הערכה)`.
2. Numbers come from the sources you actually read in this run (MAYA, Bizportal, the SEC bridge files in `data/`), not from memory.
3. Do not copy text from review sites or articles: paraphrase. (Shlomi Arden's review is for the owner's private use and may be cited and used as context — still
   paraphrase, and cite it as a source.)
4. Commit and push after **each** finished file (`git add -A; git commit -m "<what>"; git pull --rebase; git push`) so an interrupted run loses nothing. Never `--force`.
5. If the web app answers "empty answer" / HTTP error: the owner must redeploy it — write that to `.work/problem.txt`, stop (the Apps Script sends the alert e-mail by itself).
6. Work in the owner's time zone (Asia/Jerusalem). `D` = day of the month, `M` = this month `YYYY-MM`, `N` = next month.

## Step 0 — every run
```
git pull --rebase
node scripts/screener_api.mjs status          # -> { month, total, done, rows[], emailSent }
```
Decide the phase:
* `D` in 1..7 and `status.month == M` and `emailSent == false` → **Phase A (reviews)**.
* `D` in 1..7 and `status.month != M` (the 07:00 scan of day 1 has not built the queue yet) → nothing to review yet; do Phase B for month `M` if its work is incomplete, then stop.
* `D` in 18..31 → **Phase B (prepare month N)**; on `D` 22..27 also **Phase C (US theme discovery)**.
* otherwise stop.
If a phase is already complete, stop immediately and say so in one line.

## Phase A — reviews (days 1–7)
1. `node scripts/screener_api.mjs queue > .work/queue.json`. Every item whose status is not `done` and for which `data/reports/M/<file>.json` does not exist (or was rejected) needs a review.
   Each item has the Stage 1 numbers, the price, the market cap text and (US) the 10-K bridge URL / (IL) an `il` block with the raw IL_Data numbers (thousands of ILS), the MAYA URL and Bizportal URLs.
2. Write `data/reports/M/<reportPath file name>` for each, following `docs/stage2-report-schema.md` **exactly** (the code rejects a file that breaks it) and the example `docs/examples/report-EXMP.json`.
   Quality bar: 400–700 words in Hebrew, analytical and conversational, no marketing language; a real business description (what they sell, to whom, why customers stay), 2–4 segments with
   their share of revenue when the report gives it, **at least 3 dated events from the last 12–24 months when they exist** (contracts, acquisitions, results, guidance, management changes), real risks.
   * **US:** sources = `S1` (Stage 1 metrics, `kind: "metrics"`), the 10-K text in `data/filings/<T>.json`, `data/facts/<T>.json` (`kind: "facts"`), `data/releases/<T>.json` (earnings releases).
   * **IL (Hebrew, no Gemini):**
     - Read **MAYA in the browser** (`https://maya.tase.co.il/he/companies/<issuerId>`): the latest annual and quarterly report (business description, segment note, material events / immediate reports of the last 12 months, debt and cash flow).
       MAYA is the primary source; every source other than `S1` must be an https URL on `maya.tase.co.il`, `tase.co.il`, `bizportal.co.il` or `israeli-stocks-site.vercel.app` (the code rejects others).
     - Bizportal (`https://www.bizportal.co.il/capitalmarket/quote/generalpage/<securityNumber>`, `/profile/`): live pages, read by the code too — a number you take from them is checked automatically.
     - Shlomi Arden's 2026 review of the company: `data/il/arden/reviews/<issuerId>.json` (his text, business, segments, events, his verdict). Cite as source
       `{ "title": "סקירת מניות ישראל 2026 — שלומי ארדן: <שם>", "url": "https://israeli-stocks-site.vercel.app/", "kind": "other" }`; his rating is also in `data/il/arden/ratings.json`. If your reading of MAYA
       disagrees with his, say so in the risks / thesis.
     - A number cited only to MAYA is "unverifiable" for the code (it cannot read MAYA) — that is fine and not deleted, but prefer numbers that also appear in `S1`/Bizportal.
     - Debt-to-equity and FCF yield for an Israeli stock appear in `S1` only when `totalDebt` / `fcfTTM` are in its data file: if they are missing say "לא נמצא מידע" (the Stage 1 verdict is then "ראשוני").
3. After about every 4 reports, and at the end: `node scripts/screener_api.mjs finalize`. The answer is `{ total, done, pending[], invalid[{ticker,reason}], emailed }`.
   * `invalid` → fix exactly what `reason` says (rewrite the file, push, call `finalize` again). Do not argue with the validator; if a reason looks like a validator bug, write it to `.work/problem.txt`.
   * `emailed: true` means the monthly e-mail (TOP 10 with full reviews) went out → the month is done. Stop.
   * `pending` not empty and nothing left to write → the files are in the queue but rejected twice: leave them, note them in `.work/problem.txt`. The script e-mails the owner by itself (an alert from day 3, the report in any case on day 7).
4. Do not write reviews for stocks that are not in the queue, and never edit the Apps Script.

## Phase B — prepare next month (days 18–31): Israeli data
The GitHub workflow already copies every watchlist company's latest data file into `data/il/N/` (`carriedForward: true`) and refreshes prices and market caps from Bizportal.
Your job is to make the data **true**:
1. **Refresh.** For each company in `data/il/watchlist.json`, open its MAYA page, compare the latest published report (quarterly/annual) with `reportDate` in `data/il/N/<ticker>.json`.
   If MAYA has a newer report, write a **new** file `data/il/N/<ticker>.json` following `docs/il-data-schema.md`: `netIncomeAttributableTTM` (last 4 quarters, attributable to shareholders), `equityAttributable`,
   `marketCap` (use the current one from MAYA/Bizportal), **`totalDebt`** (financial debt: bank loans + bonds + lease liabilities if the company counts them as debt, say which in `notes`) and **`fcfTTM`**
   (operating cash flow TTM minus capex — `ocfTTMBeforeCapex` and the capex line are in the cash-flow statement; note the formula in `notes`). Fill debt and FCF whenever the report has them: they turn a "preliminary" verdict into a full one.
   A carried file with a null `totalDebt` / `fcfTTM` also deserves a fix even without a new report, if the latest report has the numbers (do it for at most ~6 companies per run).
   Validate: `node scripts/screener_api.mjs ilcheck N` → `accepted / rejected[{ticker,reason}]`; fix rejections.
2. **Grow (Israeli discovery).** `data/il/candidates.json` is the ranked list of Arden-reviewed companies not yet in the watchlist (interesting before watch, larger first).
   Add at most **6 new companies per month** (count the watchlist entries with `addedMonth == N`): take the first candidates, and for each
   (a) find its TASE share security number on MAYA (the company page → its securities; the ordinary share), (b) check on Bizportal `generalpage/<securityNumber>` that the company name matches and that a price exists,
   (c) set `isFinancial` (banks, insurers, credit companies, investment houses = true; the code cross-checks against its own list `IL_FINANCIAL_SECURITIES` — if it disagrees `ilcheck` says so; then ask nothing, just add the number to
   the report in `.work/problem.txt` and leave the company out), (d) append `{ ticker: "<securityNumber>", name, symbol, issuerId, isFinancial, addedMonth: "N" }` to `data/il/watchlist.json`,
   (e) write its data file as in step 1. A company whose report cannot be read, that has a loss, no TTM earnings, or is a holding/real-estate NAV company the metrics do not fit → add `"<issuerId>": "<reason>"` to `data/il/rejected.json` instead.
3. Push; run `node scripts/screener_api.mjs ilcheck N` once more. The code ingests the files itself on day 28 (08:00) and day 1 (06:00).

## Phase C — US theme discovery (days 22–27)
`node scripts/screener_api.mjs themes > .work/themes.json` lists the active themes that still need candidates this month. For each, write `data/discovery/M/<theme>.json` exactly as in
`docs/discovery-schema.md` (real US-listed companies with a source URL each; fewer is fine; do not include anything already in the Universe or marked `exclude`). The code ingests them on days 22–27.

## Time and order
Work in this order and push after each item: Phase A first (the e-mail waits for it), then B1 (refresh with new reports), B2 (discovery), then B1's debt/FCF completion, then C.
If you run out of time, stop cleanly after a push — the next scheduled run continues from the state of the repo and the web app.

## What you report at the end of a run (3–6 lines)
Phase, what you wrote/changed (tickers), the last `finalize` / `ilcheck` result in one line, and anything the owner should look at.
