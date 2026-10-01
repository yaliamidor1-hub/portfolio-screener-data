# משימה: מחירי מניות ישראליות מ-MAYA (חודשית, ולפני הסריקה)

**למי:** סשן של Claude שיש לו דפדפן, או אדם. MAYA / TASE מוגנות (JavaScript ובוט-הגנה), ולכן אי אפשר למשוך אותן בלי דפדפן.

1. עבור כל חברה ב-`data/il/watchlist.json` פתח `https://maya.tase.co.il/he/companies/<issuerId>` וקרא את **שער המניה האחרון** ואת התאריך שלו.
2. מלא קובץ CSV (תבנית: `docs/examples/il-prices-template.csv`), שורה לכל חברה:

   ```
   securityNumber,price,unit,date
   731018,1234,agorot,2026-10-01
   ```

   * `unit`: `agorot` אם השער מוצג באגורות (כך ב-MAYA), `ILS` אם בשקלים.
   * `date`: תאריך השער (`yyyy-MM-dd`), לא תאריך היום. שער ישן מ-45 ימים יידחה.
   * אל תנחש ואל תשלים: חברה שלא קראת לה שער — אל תכתוב לה שורה.
3. הרץ: `node scripts/make_il_prices.mjs 2026-10 prices.csv` — הסקריפט בודק (מספר נייר ברשימה, מחיר חיובי, תאריך תקין) ויוצר `data/il/2026-10/prices.json` עם כתובת MAYA של כל חברה כמקור. אם יש שגיאה הוא לא כותב כלום.
4. דחוף לריפו (commit רגיל, בלי force), ואז הרץ ב-Apps Script את `ingestIlPrices` — הקוד מאמת שוב וכותב ל-`IL_Data`.

הקובץ הסופי: [`il-data-schema.md`](il-data-schema.md) (סעיף "מחירים").
