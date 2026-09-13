# Turning a prescription into JSON

medbot does not use AI at runtime — it has no API keys and costs nothing to run. But the
genuinely hard part of this, reading a doctor's handwriting, is something you already have
a tool for. So do that part once, in whatever chatbot you already use, and paste the result
into the bot.

> **The easy way:** send `/prompt` to the bot and it will hand you this, ready to copy,
> without needing to find this file at all. What follows is the same thing.

## What to do

1. Photograph your prescription.
2. Open any AI chatbot (Claude, ChatGPT, Gemini — whichever you have).
3. Attach the photo and paste the prompt below.
4. Copy the JSON it gives you.
5. Send `/import` to the bot, then paste the JSON as your next message.

medbot validates everything, tells you in plain English exactly what would change, and
waits for you to press **Apply**. Nothing takes effect until you do. If the JSON is wrong
it will say which medicine and which field, so you can go back and fix it.

---

## The prompt to paste

> Convert this prescription photo into JSON for a medication reminder bot. Output **only**
> the JSON, no commentary.
>
> ```json
> {
>   "version": 1,
>   "patient": "<name, or omit>",
>   "timezone": "<IANA zone, e.g. Asia/Dhaka>",
>   "day": {
>     "morning_poll_at": "06:30",
>     "presumed_wake_at": "09:00",
>     "evening_poll_at": "22:30",
>     "presumed_sleep_at": "01:00"
>   },
>   "meals": [
>     { "id": "breakfast", "typical_local": "08:30", "ask_after_local": "09:30", "presume_at_local": "11:30" },
>     { "id": "lunch",     "typical_local": "13:30", "ask_after_local": "14:30", "presume_at_local": "16:30" },
>     { "id": "dinner",    "typical_local": "20:30", "ask_after_local": "21:30", "presume_at_local": "23:30" }
>   ],
>   "groups": [
>     { "id": "eye_drops", "spacing": "10m" }
>   ],
>   "medicines": [
>     {
>       "id": "short_lowercase_id",
>       "name": "Full name as printed",
>       "dose": "1 drop, right eye",
>       "notes": "anything the prescription says, e.g. shake well",
>       "schedule": { "type": "interval", "every": "2h", "anchor": "wake" },
>       "min_gap": "90m",
>       "group": "eye_drops",
>       "group_seq": 1,
>       "course": { "days": 7 }
>     }
>   ]
> }
> ```
>
> **Tapering** — very common for eye drops. When a medicine steps down partway through
> ("4 times a day for 7 days, then 3 times a day for 7 days"), use `phases` rather than a
> single schedule, or the rest of the course is lost:
>
> ```json
> "phases": [
>   { "schedule": { "type": "times_per_day", "n": 4 }, "days": 7, "label": "4 times a day" },
>   { "schedule": { "type": "times_per_day", "n": 3 }, "days": 7, "label": "3 times a day" }
> ]
> ```
>
> **Schedule types** — pick the one that matches what is written:
> - `{"type": "interval", "every": "2h", "anchor": "wake"}` — every N hours. Use
>   `"anchor": "wake"` when dosing should start when the patient wakes up (typical for eye
>   drops), `"anchor": "clock"` for round-the-clock antibiotics.
> - `{"type": "fixed_times", "times": ["08:00", "20:00"]}` — specific times of day.
> - `{"type": "times_per_day", "n": 3, "from": "08:00", "to": "22:00"}` — "three times a
>   day" with no times given. Spreads across the patient's waking day, starting when they
>   actually get up; add `"anchor": "clock"` only if the times are genuinely fixed.
> - `{"type": "meal", "meals": ["breakfast"], "relation": "before", "offset": "30m"}` —
>   `relation` is `before`, `after` or `with`.
> - `{"type": "as_needed"}` — PRN / SOS / "when needed". Add `"max_per_day"` and `"min_gap"`.
>
> **Shorthand**: if the prescription uses the `1+0+1` notation (morning + noon + night),
> you may write `"pattern": "1+0+1"` instead of a schedule.
>
> **Rules**
> - Eye drops, or anything that must be spaced apart, all share the same `"group"`, with
>   the gap declared once in `groups`. Ten minutes is usual unless stated otherwise.
>   Grouped medicines **keep their own separate schedules and courses** — the group only
>   means the bot will never ask for two of them within that gap.
> - `min_gap` is the *shortest safe interval* between two doses. Set it a little below the
>   scheduled interval (about three quarters). This is a safety floor, so err on the
>   longer side.
> - `course`: `{"days": 7}`, `{"doses": 20}`, or `{"until": "2026-10-01"}`. Omit entirely
>   for ongoing medication.
> - Add `"critical": true` only if a dose genuinely must happen overnight — it lets the bot
>   wake the patient.
> - If the prescription is ambiguous, choose the safer reading and say so in a `"notes"`
>   field on that medicine.
> - Use IDs that are short, lowercase and meaningful (`drop_a`, `stomach_capsule`, `painkiller`).

---

## Check it yourself before applying

The bot shows you a summary, but you are the last line of defence. Read it against the
paper and confirm:

- every medicine on the prescription is present, and nothing extra;
- doses and frequencies match;
- course lengths match;
- anything that must be spaced apart shares a group.

If something looks wrong, press **Cancel**, fix the JSON, and `/import` again. You can also
adjust individual medicines afterwards with `/pause`, `/stop` and `/import`.

> ⚠️ medbot is a reminder, not a doctor, and neither is the chatbot that produced this JSON.
> Check the result against your prescription.
