# סכמת נתוני שוק ישראלי (נכתב על ידי Claude, מאומת בקוד)

קבצים בריפו הציבורי `portfolio-screener-data`:

```
data/il/watchlist.json                    רשימת החברות לקליטה (manifest)
data/il/<YYYY-MM>/<מספר נייר>.json        קובץ לכל חברה; ה-ticker של מניה ישראלית הוא מספר הנייר בבורסה
```

`ingestIlData()` (מופעל ב-`runMonthly` לפני שלב 1, ובטריגרים ב-28 לחודש וב-1 לחודש 06:00) מושך את ה-manifest ואת הקבצים (החודש הנוכחי,
ואם אין — החודש הקודם), מאמת, וכותב ל-`IL_Data` (עמודות הגלם בלבד) ול-`IL_Watchlist` (securityNumber, issuerId, isFinancial, symbol).
את המדדים (pe, roe, debtToEquity, fcfYield) מחשב `IlProvider` מעמודות הגלם, בדיוק כמו נתונים שהוקלדו ידנית.

**הוספת חברה בלי שינוי קוד:** שורה חדשה ב-`watchlist.json` (או שורה ב-`IL_Watchlist`) והקובץ שלה; הקליטה מוסיפה גם שורה ל-`Universe`.

## watchlist.json

```json
{ "companies": [ { "ticker": "731018", "name": "מלם-תים אחזקות", "symbol": "מלתא", "issuerId": "731", "isFinancial": false, "sector": "optional", "thesis": "optional" } ] }
```

## קובץ חברה

```json
{
  "ticker": "731018", "month": "2026-10", "name": "מלם-תים אחזקות", "symbol": "מלתא", "issuerId": "731",
  "unit": "thousands", "currency": "ILS", "isFinancial": false, "reportDate": "2026-06-30",
  "marketCap": 1879027, "netIncomeAttributableTTM": 81211, "equityAttributable": 588526, "totalDebt": null, "fcfTTM": null,
  "ocfTTMBeforeCapex": 75597,
  "price": 123.45, "priceUnit": "ILS", "priceDate": "2026-10-01",
  "source": [{ "url": "https://maya.tase.co.il/he/companies/731" }],
  "notes": "free text"
}
```

| שדה | חובה | כלל |
|---|---|---|
| `ticker` | כן | מספר הנייר; חייב להתאים לשם הקובץ |
| `unit` | כן | בדיוק `"thousands"`: כל הסכומים באלפים של המטבע שצוין |
| `currency` | כן | `ILS` או `USD` — מטבע הסכומים שבקובץ |
| `reportingCurrency` | אם שונה | מטבע הדיווח של החברה; חברה שמדווחת בדולר (`USD` כאן או ב-`currency`) **חייבת** `fx` |
| `fx` | חברה בדולר | שקלים לדולר, בין 1.5 ל-8. אם `currency = USD` הקוד ממיר את הסכומים לאלפי ש"ח; אם הסכומים כבר הומרו (`currency = ILS`, `reportingCurrency = USD`) השער רק נרשם. השער לא מאומת מול בנק ישראל (היחסים לא מושפעים ממנו) |
| `isFinancial` | כן | `true` / `false`. **הקוד מכריע**: הרשימה ב-`CONFIG.IL_FINANCIAL_SECURITIES` (+ Script Property `IL_FINANCIALS`, מופרד בפסיקים); ערך סותר דוחה את הקובץ. כרגע: איביאי 175018, מיטב 1081843, מניף 1170893, שוהם 1082007 |
| `reportDate` | כן | `yyyy-MM-dd`; לא בעתיד, לא ישן מ-15 חודשים |
| `marketCap`, `netIncomeAttributableTTM`, `equityAttributable` | כן | מספרים (לא מחרוזות), באלפים. `netIncomeAttributableTTM` ו-`equityAttributable` — מיוחסים לבעלי המניות של החברה האם (בלי מיעוט) |
| `totalDebt`, `fcfTTM` | לא | חסר = `null` או בלי השדה, אף פעם לא `0`. `totalDebt` לא שלילי |
| `ocfTTMBeforeCapex` | לא | מידע בלבד (נרשם ב-notes; אינו FCF) |
| `price`, `priceUnit`, `priceDate` | לא | מחיר: `priceUnit` (`agorot` — המחיר ב-MAYA, מחולק ב-100 — או `ILS`) ו-`priceDate` חובה |
| `source` | כן | רשימה; לפחות כתובת `https` אחת ב-`maya.tase.co.il` או `tase.co.il`, וכל הכתובות `https` |

## בדיקות סבירות (קובץ שנכשל נדחה כולו, הסיבה ב-RunLog)

שווי שוק 10,000 עד 1,000,000,000 (אלפי ש"ח; תופס שקלים במקום אלפים, או מיליונים) · שווי שוק / הון מיוחס בין 0.05 ל-100 · ROE בין -100% ל-200% ·
שווי שוק חיובי. רווח שלילי **אינו** נדחה: P/E יוצא שלילי ושלב 1 פוסל אותו. הון מיוחס שאינו חיובי — אין ROE (הערה ב-notes).

## מה הקוד כותב ומה לא

* שורה ב-`IL_Data` ש**אדם הקליד** (ה-`source` שלה לא מתחיל ב-`IL_FILE:`) אף פעם לא נדרסת; נרשם "rows typed by hand were kept".
* עמודות המדדים (`pe`, `roe`, `fcfYield`, `debtToEquity`) לעולם לא נכתבות על ידי הקליטה: ערך שהוקלד שם ממשיך לנצח את החישוב.
* נתונים ישנים יותר מהשורה הקיימת (reportDate מוקדם יותר) לא דורסים אותה.
* ב-`IL_Watchlist` הקוד ממלא רק תאים ריקים; ערך שונה שהוקלד נשאר ונרשמת אזהרה.
* ב-`Universe` הקוד מוסיף שורה (market IL, active, source `il-ingest`) לחברה שאין לה אף שורה — thesis `israel`, או `israel-financials` לפיננסיות, או ה-`thesis` שב-`watchlist.json`. שורה קיימת (גם `exclude`) לעולם לא משתנה ולא מוכפלת.

הקבצים של 2026-10 נוצרו מהטיוטה `IL_Data_draft_2026-10-01.csv` בלי להוסיף נתונים: תא ריק נשאר חסר.

## מחירים: prices.json

```
data/il/<YYYY-MM>/prices.json
```

```json
{ "prices": [ { "securityNumber": "731018", "price": 1234, "priceUnit": "agorot", "priceDate": "2026-10-01", "source": "https://maya.tase.co.il/he/companies/731" } ] }
```

* `priceUnit`: `ILS` (ברירת מחדל — המחיר בשקלים) או `agorot` (כפי שמוצג ב-MAYA; הקוד מחלק ב-100 ושומר בשקלים).
* `priceDate` חובה, `yyyy-MM-dd`, לא בעתיד ולא ישן מ-45 ימים (מחיר ישן נדחה — עדיף ריק ממחיר מיושן). `source`: כתובת https ב-`maya.tase.co.il` / `tase.co.il`.
* מספר נייר שמופיע פעמיים — שתי השורות נדחות. מספר נייר שאין לו שורה ב-`IL_Data` / `IL_Watchlist` — נדחה.
* `ingestIlPrices()` (נקראת בסוף `ingestIlData()`, וגם ידנית) כותבת `price` ו-`priceDate` רק לשורות ש-`ingestIlData` יצרה; שורה שהוקלדה ידנית לא נוגעים בה. מחיר חדש יותר שכבר בשורה נשמר. קליטה של קובץ נתונים בלי מחיר לא מוחקת מחיר קיים.
* המחיר זורם: `IL_Data` ← שורת הדוח (`price`, `priceDate`) ← `History.priceAtReport` (נעול בכתיבה הראשונה) ו-`History.priceDate` (תאריך המחיר, לא תאריך הדוח הכספי). בארכיון "מחיר היום" לישראלית הוא המחיר האחרון מ-`IL_Data` עם התווית "מחיר מ-MAYA ב-DD/MM", והשינוי באחוזים מחושב מול המחיר הנעול, בשקלים משני הצדדים. בלי מחיר — "—".
