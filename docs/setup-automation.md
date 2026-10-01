# הפעלת האוטומציה החודשית — מה לעשות פעם אחת

אחרי ההגדרה הזאת, כל חודש רץ התהליך לבד ובסוף מגיע אליך מייל "עשר המניות של <חודש>" (עד 6 ישראליות + 4 אמריקאיות, כל אחת עם סקירה מלאה).

## מי עושה מה (בקצרה)
| מתי | מי | מה |
|---|---|---|
| כל יום (04:00 UTC) | GitHub Actions | נתוני SEC, מחירי ושווי שוק ישראליים (Bizportal), דירוגי שלומי ארדן ורשימת מועמדות, העתקת קובצי נתונים ישראליים קדימה |
| 18–31 לחודש | **משימת Cowork** | קריאת MAYA: נתונים פיננסיים ישראליים חדשים (כולל חוב ו-FCF), הוספת עד 6 חברות חדשות, גילוי נושאים ל-US (22–27) |
| 28 ו-1 (06:00) | Apps Script | קליטת קובצי הנתונים הישראליים לגיליון (עם אימות) |
| 1 לחודש 07:00 | Apps Script | סינון כמותי (שלב 1) ובניית התור לסקירות |
| 1–7 לחודש | **משימת Cowork** | כתיבת הסקירות; קריאה ל-`finalize` שמאמת ושולח את המייל כשהכול מוכן |
| 2–7 לחודש 08:00 | Apps Script | גיבוי: מאמת סקירות שהגיעו; התראה אחת ביום מהיום ה-3 אם משהו חסר; מייל גם אם חסר משהו ביום ה-7 |

## צעדים (בסדר הזה)
1. **פריסה:** ב-Apps Script: Deploy → Manage deployments → ✏️ (עריכה) → Version: **New version** → Deploy. (הקוד כבר נדחף עם `clasp push`; בלי גרסה חדשה ה-Web App לא מכיר את `?finalize` / `?status`.)
2. **טריגרים:** בעורך הרץ פעם אחת את `installTriggers()` (17 טריגרים; הוא מחליף את הקיימים).
3. **Script Properties** (Project Settings → Script properties): `TICKERS_TOKEN` (מחרוזת אקראית של 24 תווים ויותר; אם כבר קיים — השאר), `GITHUB_DATA_BASE_URL` (`https://raw.githubusercontent.com/yaliamidor1-hub/portfolio-screener-data/main/data`), `REPORT_EMAILS` (הכתובות שיקבלו את המייל). `STAGE2_SOURCE` אינו נדרש (ברירת המחדל `claude`).
4. **קובץ הגדרות מקומי** (המחשב שבו רץ Cowork): ליצור `C:\Users\yalia\portfolio-screener-data\.env` (הקובץ ב-.gitignore ולא עולה ל-GitHub) עם שתי שורות:
   ```
   WEBAPP_URL=https://script.google.com/macros/s/<מזהה>/exec
   TICKERS_TOKEN=<אותו ערך כמו ב-Script Property>
   ```
   את כתובת ה-`/exec` מקבלים מ-Deploy → Manage deployments (או מההרצה של `checkWebAppUrl()`). הטוקן לא נכתב בשום צ'אט.
5. **סודות ב-GitHub** (Settings → Secrets → Actions) — לסנכרון הטיקרים האמריקאים מה-Universe: `SCREENER_WEBAPP_URL` (כתובת ה-/exec) ו-`TICKERS_TOKEN`. (`SEC_CONTACT_EMAIL` כבר קיים.)
6. **בדיקה ידנית אחת:** בטרמינל בתיקיית ריפו הנתונים: `node scripts/screener_api.mjs status` — אמורה לחזור תשובת JSON (גם אם התור ריק). "empty answer" = הטוקן שגוי או שלא פורסמה גרסה חדשה.
7. **משימת Cowork מתוזמנת** (שלב בנפרד, ראו למטה).
8. אחרי הסריקה הראשונה: בגיליון — `Universe` ו-`RunLog`; ובמייל — תצוגת הדוח.

## הגדרת משימת Cowork
* **שם:** `Portfolio screener — monthly`
* **תזמון:** כל יום, 4 פעמים ביום: 08:30, 13:30, 19:30, 23:30 (חלונות רחבים; כל הרצה בודקת מה חסר, עושה אותו ויוצאת — הרצות מיותרות עולות כמה שניות). מומלץ לתזמן גם "keep awake" ל-Windows בחלונות האלה.
* **גישה:** תיקיית `C:\Users\yalia\portfolio-screener-data` (קריאה וכתיבה), הדפדפן (Claude in Chrome, כדי לקרוא את MAYA), ו-git לשליחה (`git push` ללא סיסמה).
* **הנחיה (להדביק כמות שהיא):**
  ```
  אתה האנליסט של ה-portfolio screener. פעל לפי docs/cowork-monthly-task.md בתיקייה C:\Users\yalia\portfolio-screener-data.
  התחל מ-git pull ומ-node scripts/screener_api.mjs status, קבע אילו שלבים נדרשים היום, בצע רק את מה שחסר, דחוף אחרי כל קובץ,
  ובסיום דווח בכמה שורות. אל תמציא נתונים; אל תדפיס או תכתוב את הטוקן.
  ```

## מה קורה אם משהו נכשל
* Cowork לא רץ / לא סיים (המחשב כבוי): ביום ה-3 מגיעה התראה (אחת ביום) עם רשימת הסקירות החסרות; הרצה מאוחרת פשוט ממשיכה. ביום ה-7 נשלח מייל עם מה שיש (המניות בלי סקירה מופיעות ברשימת "לא נכנסו").
* קובץ שנדחה: הסיבה בתשובת `finalize` (Cowork מתקן) וב-RunLog.
* אין שום מניה שעוברת את כל הבדיקות: נשלח מייל שאומר זאת (אין מילוי).
