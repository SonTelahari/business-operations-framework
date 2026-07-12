# Still Water Webhook Receiver

This Apps Script receiver must be attached to a separate Still Water operating workbook.

Before deployment:

1. Create the Still Water workbook with the required tabs and formulas.
2. Copy its spreadsheet ID from the Google Sheets URL.
3. Replace `REPLACE_WITH_STILL_WATER_SPREADSHEET_ID` in `Code.gs`.
4. Deploy as a web app that executes as the workbook owner.
5. Put the resulting `/exec` URL in the Still Water bridge and GUI hosting environment.

Never use the original Frontier Firearms spreadsheet ID or Apps Script URL in this project.
