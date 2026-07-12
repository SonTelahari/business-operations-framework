# Still Water Go-Live Checklist

1. Finish the Still Water product, category, tag, price, and recipe catalog.
2. Create a separate Still Water operating workbook.
3. Confirm `SPREADSHEET_ID` is `1TzMlaDaZuRmK8N_A0ZRACoHyU36DR2U-k_YgLqIuU1Y` in `webhook/Code.gs`.
4. Deploy the Apps Script receiver as a new web app.
5. Create `discord-bridge/.env` from `.env.example` using only Still Water credentials.
6. Configure the Still Water storefront Discord webhook and reader bot.
7. Test deposit, withdrawal, customer purchase, and customer sale events.
8. Test GUI counts, targets, time clock, payroll, and manual movements.
9. Keep the GUI private until real authentication and shared work-order storage are added.

The local Still Water GUI uses `http://localhost:4273` so it can run beside the original project without sharing browser storage.
