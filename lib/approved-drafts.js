// Approved SendKit replies, sent with /api/respond?key=...&draft=<id>&mode=send
// Plain JS rather than JSON: JSON import attributes resolve inconsistently
// across serverless runtimes.

export const drafts = [
  {
    id: "charles",
    conversationId: "6a472b2ddb803e014b214e94",
    lead: "Charles Caudillo, Central Texas Network In Action — asked for times on 31 Jul, 91h cold",
    slots: [
      { start_time: 1785956400, label: "Wednesday, August 5 at 2:00 PM CT" },
      { start_time: 1786042800, label: "Thursday, August 6 at 2:00 PM CT" },
      { start_time: 1786129200, label: "Friday, August 7 at 2:00 PM CT" },
    ],
    body: `Hi Charles,

Sorry for the slow turnaround, you asked for times and I left you waiting.

Here is what is open, all your afternoon:

• Wednesday, August 5 at 2:00 PM CT
• Thursday, August 6 at 2:00 PM CT
• Friday, August 7 at 2:00 PM CT

Click whichever suits and it will book itself, invite comes through with a Meet link on it. If none of those work, tell me what does and I will fit around you.

Aria`,
  },

  {
    id: "haojun",
    conversationId: "6a1dfe9b22aefcaab94ae5ed",
    lead: "Haojun S., SG Assist (Singapore, 48 days cold, previously said no call needed)",
    body: `Hi Haojun,

Apologies for the long gap on my side.

You mentioned you'd take a look back in June, so I wanted to close the loop rather than leave it hanging. If it's still of interest I'm happy to answer anything by email, no call needed.

If a quick call is easier, these work on my side and land in your evening:

• Thursday, July 30 at 8:00 PM SGT
• Friday, July 31 at 8:00 PM SGT

Zoe`,
  },
];
