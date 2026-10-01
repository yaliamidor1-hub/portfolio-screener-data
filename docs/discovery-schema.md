# סכמת גילוי Themes (נכתב על ידי Claude, מאומת בקוד)

לכל תחום (theme) פעיל וצריך-גילוי נכתב קובץ אחד בריפו הציבורי `portfolio-screener-data`:

```
data/discovery/<YYYY-MM>/<theme>.json       # <theme> בדיוק כשמו בטאב Themes, למשל defense-security
```

מה לחקור — `GET <web app /exec>?themes=1&token=<TICKERS_TOKEN>` מחזיר JSON עם התחומים הפעילים
(`theme`, `description`, `market`, `maxCandidates`, `due`, `filePath`) וה-Universe הנוכחי (כולל מניות שסומנו `exclude`),
כדי לא להציע כפילויות או מניות שנדחו. דוגמה: `docs/examples/themes-response.json`.
הקוד (`ingestDiscovery`, ימים 22–27) מושך את הקובץ ומריץ אימות — Claude מציע, **הקוד מאמת**.

## הקובץ

מערך של מועמדים (גם `{ "candidates": [...] }` מתקבל):

```json
[
  { "ticker": "EXMP", "name": "Example Aerospace Corp", "why": "משפט קצר על הקשר לתחום",
    "sources": ["https://example.com/profile/exmp", { "url": "https://example.com/10k", "title": "EXMP 10-K 2026" }] }
]
```

| שדה | חובה | הערה |
|---|---|---|
| `ticker` | כן | סימול בורסה אמריקאית (`BRK.B` / `BRK-B`); לא תקין — נשמט |
| `name` | כן | שם החברה באנגלית כפי שהוא רשום בבורסה (נבדק מול Finnhub) |
| `why` | מומלץ | נימוק קצר (עד 200 תווים נשמרים) |
| `sources[]` | כן | לפחות כתובת http(s) אחת (מחרוזת או `{url,title}`); בלי מקור — המועמד נדחה |

עד `maxCandidates` (ברירת מחדל 12, מקסימום 30). פחות זה בסדר; אל תכלול חברה שאינך בטוח בה.

## מה הקוד בודק (אותו אימות כמו במסלול Gemini)

1. פרופיל Finnhub קיים; הבורסה אמריקאית (NYSE / Nasdaq / NYSE American, לא OTC);
2. שווי שוק מעל שורת `marketCap` בטאב Thresholds;
3. התאמת שם: שם החברה בקובץ מול Finnhub (סימול שגוי נדחה);
4. מניה חדשה: לא delisted ויש מחיר עדכני (quote בן פחות מ-10 ימים);
5. מי שעבר ולא היה ב-Universe מתווסף עם `source = auto:<theme>`; קיים (גם `exclude`) לא מתווסף שוב.

התוצאה — הוצעו / אומתו / נדחו והסיבה — נרשמת ב-RunLog. ללא קובץ: התחום ממתין; מיום 27 (ב-`hybrid` מיום 24) Gemini מגלה אותו כגיבוי
(`DISCOVERY_SOURCE` = `claude` | `gemini` | `hybrid`, ברירת מחדל `claude`).
קובץ לדוגמה: [`examples/discovery-example-theme.json`](examples/discovery-example-theme.json) (כולל מועמדת שנדחית כי אינה נסחרת ומועמדת בלי מקור).
