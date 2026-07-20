/**
 * Google Apps Script — Sheet logger for the SendKit Reply Classifier.
 *
 * Setup (5 minutes, one time):
 * 1. Create a Google Sheet. Rename the first tab to "Replies".
 * 2. Extensions -> Apps Script. Delete the default code, paste this file.
 * 3. Deploy -> New deployment -> type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 4. Copy the Web app URL and set it as SHEETS_WEBHOOK_URL in Vercel.
 */

var HEADERS = [
  "Timestamp", "Lead Email", "Lead Name", "Campaign", "Subject",
  "Category", "Confidence", "Reason", "Conversation ID", "Reply Preview"
];

function doPost(e) {
  var data = JSON.parse(e.postData.contents);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Replies")
    || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }

  sheet.appendRow([
    data.timestamp || new Date().toISOString(),
    data.leadEmail || "",
    data.leadName || "",
    data.campaignName || "",
    data.subject || "",
    data.category || "",
    data.confidence || "",
    data.reason || "",
    data.conversationId || "",
    data.replyPreview || ""
  ]);

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
