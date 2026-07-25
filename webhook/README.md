# Still Water Webhook Receiver

This Apps Script receiver must be attached to a separate Still Water operating workbook.

Before deployment:

1. Create the Still Water workbook with the required tabs and formulas.
2. Copy its spreadsheet ID from the Google Sheets URL.
3. Confirm `SPREADSHEET_ID` is `1TzMlaDaZuRmK8N_A0ZRACoHyU36DR2U-k_YgLqIuU1Y` in `Code.gs`.
4. Deploy as a web app that executes as the workbook owner.
5. Put the resulting `/exec` URL in the Still Water bridge and GUI hosting environment.

Schema version 8 adds sheet-backed native resale wares from webhook review. After updating `Code.gs`, deploy a new Apps Script web-app version; saving the script alone does not update the live `/exec` deployment. The `Products` tab must retain its 12-column layout through `Pricing Source`.

Never use the original Frontier Firearms spreadsheet ID or Apps Script URL in this project.
