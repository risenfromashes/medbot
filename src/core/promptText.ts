/**
 * The prescription-conversion prompt, as the bot hands it out.
 *
 * The same text lives in docs/LLM_PROMPT.md for people reading the repository, but the
 * person who actually needs it is standing in a pharmacy with a piece of paper and a
 * phone. Making them find a GitHub file first is the difference between this being usable
 * and not.
 */

/** Telegram caps a message at 4096 characters, so this is deliberately split. */
export const PRESCRIPTION_PROMPT_PARTS: string[] = [
  `📋 <b>Turning a prescription into JSON</b>

1. Photograph your prescription.
2. Open any AI chatbot — Claude, ChatGPT, Gemini, whichever you have.
3. Attach the photo and paste the message below.
4. Download the <b>prescription.json</b> it gives you and send me that file. 📎

The prompt already asks it for a downloadable file. If your chatbot can't make
one, copy the JSON into a file yourself and attach that.

<b>A file, not pasted text.</b> Telegram splits long pastes across two messages,
which is where nearly every import problem comes from. Pasting still works and
I'll stitch the pieces back together — but a file just works.

I check everything and show you exactly what would change before anything takes effect.

<i>Tap the block below to copy it.</i>`,

  `<pre><code>Convert this prescription photo into JSON for a medication reminder bot.

Give me the result as a downloadable file named prescription.json.
If you can't produce a file, output only the JSON and nothing else.

Shape:
{
  "version": 1,
  "timezone": "Asia/Dhaka",
  "day": { "morning_poll_at": "06:30", "presumed_wake_at": "09:00",
           "evening_poll_at": "22:30", "presumed_sleep_at": "01:00" },
  "meals": [
    { "id": "breakfast", "typical_local": "08:30", "ask_after_local": "09:30" },
    { "id": "lunch",     "typical_local": "13:30", "ask_after_local": "14:30" },
    { "id": "dinner",    "typical_local": "20:30", "ask_after_local": "21:30" }
  ],
  "groups": [ { "id": "eye_drops", "spacing": "10m" } ],
  "medicines": [
    {
      "id": "short_lowercase_id",
      "name": "Full name as printed",
      "dose": "1 drop, right eye",
      "notes": "anything the prescription says",
      "schedule": { "type": "interval", "every": "2h", "anchor": "wake" },
      "min_gap": "90m",
      "group": "eye_drops",
      "group_seq": 1,
      "course": { "days": 7 }
    }
  ]
}

Schedule types, pick what matches:
- {"type":"interval","every":"2h","anchor":"wake"}  every N hours;
  anchor "wake" starts from waking (typical for eye drops),
  "clock" for round-the-clock antibiotics
- {"type":"fixed_times","times":["08:00","20:00"]}
- {"type":"times_per_day","n":3,"from":"08:00","to":"22:00"}
  Spreads across the patient's waking day, starting when they get up.
  Add "anchor":"clock" only if the times are genuinely fixed.
- {"type":"meal","meals":["breakfast","dinner"],"relation":"before",
   "offset":"30m"}  relation is before, after or with.
  The bot asks the patient when they are going to eat and times the
  dose from their answer, so meal-relative is better than guessing
  clock times whenever the prescription says "before/after food".
- {"type":"as_needed"}  for PRN/SOS; add max_per_day and min_gap

TAPERING (very common for eye drops): when a medicine steps down
partway through -- "4 times a day for 7 days, then 3 times a day for
7 days" -- use phases instead of a schedule:
  "phases": [
    {"schedule":{"type":"times_per_day","n":4},"days":7,
     "label":"4 times a day"},
    {"schedule":{"type":"times_per_day","n":3},"days":7,
     "label":"3 times a day"}
  ]
Do NOT flatten a taper to its first phase -- the rest would be lost.

Shorthand: for the 1+0+1 notation write "pattern" verbatim --
"1+0+1", "1+1+1", "1+1+1+1" (morning, noon, evening, night) or
"1/2+0+1/2" all work, with "relation": "before" or "after".

Rules:
- Eye drops or anything that must be spaced apart share one "group",
  with "spacing" in the groups list. 10m is the usual gap.
  They KEEP their own separate schedules and courses -- grouping only
  means they will never be asked for within that gap of each other.
- "min_gap" is the shortest SAFE interval between doses. Set it to about
  three quarters of the scheduled interval. Err on the longer side.
- "course": {"days":7} or {"doses":20} or {"until":"2026-10-01"}.
  Omit for ongoing medication.
- If the prescription is ambiguous, choose the safer reading and say so
  in a "notes" field on that medicine.
- Unless the prescription explicitly says otherwise, doses are divided
  across the patient's waking hours, not the full 24. So "4 times a
  day, 6 hourly" means four doses across the day: prefer
  {"type":"times_per_day","n":4} over a 6h interval. Add
  "awake_only": false only for genuine round-the-clock dosing.</code></pre>`,

  `⚠️ <b>Check it against the paper before you confirm.</b>

The chatbot is reading handwriting, and so are you. When I show you the summary, look for:
• every medicine on the prescription, and nothing extra
• doses and frequencies matching
• course lengths matching
• anything that must be spaced apart sharing a group

If something is wrong, press Cancel and fix the JSON. Nothing changes until you confirm.

<i>I'm a reminder, not a doctor — and neither is the chatbot that wrote the JSON.</i>`,
];
