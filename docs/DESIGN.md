# How medbot works

Everything the README deliberately leaves out: the scheduling rules, the failure modes it
was built around, the security model, and how to work on it.

The organising principle, which decides most of the close calls below:

> **A bot that is annoying is a bug. A bot that goes quiet is a catastrophe.**

Where the system can't be sure, it asks rather than assumes, and it errs towards making
noise rather than towards silence.

---

## How a day goes

The whole loop, in one place.

**You wake up.** Either you say so, or the bot infers it from any message you send, or --
if it has heard nothing by a fallback time you set -- it presumes you are up and starts
anyway. That instant becomes the day's anchor.

**The drops start immediately.** Anything anchored on waking is due right then, not at some
clock time. Medicines that must be spaced apart are staggered behind it -- first drop now,
second ten minutes after you actually take the first, third ten minutes after that.

**It nags.** Every reminder repeats at 10, 15, 20, then every 30 minutes, with the wording
escalating and the previous message deleted so the chat stays readable. It does not give
up. If you have a backup person, anything you have ignored for five minutes goes to them
too, and they can answer for you.

**You answer, whenever.** Tap Taken, or say `/took drop_a 5pm` if you took it earlier and
forgot, or log it before the bot has even asked. Either way the next dose is measured from
when you actually took it -- absorbing small lateness so the day does not drift, re-basing
on the real time when you were properly late.

**Meals get proposed, not assumed.** A while after waking the bot suggests a time -- "having
breakfast around 09:15?" -- far enough ahead that the tablet due half an hour before food
still has its half hour. One tap to agree, one to push it back. Tablets tied to that meal
move with your answer, and the reminder says why: "you said breakfast in about 30 minutes,
this one goes before it." At the proposed time it asks whether you are actually eating,
which releases anything due after the meal.

**Nothing waits for ever.** An unanswered dose rolls forward when the next one falls due,
so one ignored reminder can never freeze a medicine. An unanswered meal is presumed after a
couple of hours. A skipped meal resolves whatever depended on it.

**Evening.** It asks whether you have gone to bed, and sends a short summary of the day --
taken, missed, how far through each course. If that summary stops arriving, something is
wrong, and that is the cheapest way for a person to notice.

**You sleep.** Nothing is scheduled into the night in the first place: "every four hours"
means every four hours of the day you are actually having, so a dose that would land at
half past two goes on the morning instead. Anything that does come due while you are asleep
is parked -- exactly one, not one per missed interval -- and re-raised when you get up.
Medicines marked `critical` are exempt, because those are the ones that genuinely should
wake you.

Then the loop starts again from whenever you happen to wake, which may be nothing like
today.

---

## Scheduling

### Waking up

Interval medicines anchor on when the day starts, not on a clock, because a dose "every two
hours from waking" means something different on a Tuesday than on a Sunday lie-in.

The day state is `awake` or `asleep`, each with a confidence: `confirmed` (you said so),
`inferred` (you sent the bot something, so you're evidently up), or `presumed` (the clock
passed a fallback time and nobody said otherwise).

There is deliberately **no "unknown" state**. An uncertain state that only a human can clear
is an absorbing one — leave your phone charging and you'd get no reminders all day, with
nothing to notice it. So from `presumed_wake_at` (09:00 by default) the bot presumes you're
up and doses normally, with a "tap if I've got this wrong" note.

Presuming *asleep* only suppresses non-critical medicines, never one flagged `critical`.
Being wrong in that direction costs a delayed reminder; being wrong the other way costs a
missed dose.

**A confirmation overrides a presumption, retroactively.** Someone presumed awake at nine
who actually surfaces at noon and says so moves the whole day to noon: wake-anchored
medicines restart from then, and any dose still sitting on the abandoned nine o'clock
anchor is moved forward with it rather than left stranded in the past and firing at once.
The min-gap floor still applies, so if they genuinely did take something before saying
"I'm up", the next dose waits out the gap.

### Drift

The obvious rule — next dose is the last one plus the interval — is wrong in a way that
takes a few days to show. People answer about twenty minutes late on average, so each dose
pushes the next one later. An eight-hourly antibiotic drifts about an hour a day, and by
day four its evening dose is at two in the morning.

So the default policy is `absorb`:

- answer **within 30 minutes** of the scheduled time and the next dose anchors on the
  *scheduled* time — ordinary human lag doesn't accumulate;
- answer **later than that** and it re-anchors on when you actually took it, because that
  was a genuinely missed dose and carrying on from the real time is what you'd want.

`strict_actual` (always from the real time) and `strict_grid` (the schedule never moves) are
available per medicine.

### Spacing groups

"Please give 10 mins gap between 2 drops" is a constraint between medicines, not a shared
schedule. The first design got this wrong: it folded a group into one medicine with
ordered steps, on the assumption that drops needing a gap are on the same frequency.

That does not survive contact with real prescriptions — three drops can need ten minutes
between them, but one four times a day for 14 days, one four times a day for 7 then three
times a day for 7, and a drop_c every two hours indefinitely. Folding them silently
rewrote two of the three, turning a two-hourly drop_c into four doses a day and
truncating an indefinite course at fourteen days.

So each medicine keeps its own schedule and its own course, and the planner refuses to
place two members of a group within the gap. The floor is measured from the last dose any
member was *actually* taken, so three drops due at once become 08:00, 08:10 and 08:20 —
and if the first is really taken at 08:03, the other two shift to 08:13 and 08:23.

### Tapering courses

"4 times a day for 7 days, then 3 times a day for 7 days" is routine, especially for
steroids, and was impossible to express at all — the second phase simply vanished on import. A medicine
can now carry ordered `phases`, each with its own schedule and a length in days. The
planner resolves the active phase by elapsed local days, cancels the dose scheduled under
the old rule when the taper steps down, and tells the patient it has changed.

### Waking hours

"Every four hours" means every four hours of the day you are actually having. An awake-only
medicine whose next dose would fall inside the expected sleep window is scheduled for the
morning rather than left sitting due at two in the morning.

Deferring it at the moment it became due would reach the same place, and did. The
difference is that nothing is ever *scheduled* or pending through the small hours, so
`/status` and the daily digest say "tomorrow morning" instead of naming a time nobody will
be awake for.

The consequence worth knowing: a strict six-hourly medicine only fits three doses into a
fifteen-hour day. If a prescription genuinely means four doses round the clock, mark it
`"awake_only": false`, or `"critical": true` if it should wake the patient. Otherwise
`times_per_day` is usually the more faithful reading of "four times a day".

### Nagging

Reminders repeat at 10, 15, 20, then every 30 minutes. It never gives up — but an
unanswered reminder must never be able to wedge a medicine, so when the *next* dose falls
due the outstanding one is logged as missed and the chain moves on.

Nagging stops while you're asleep and resumes in the morning. Each nudge is a new message
with the previous one deleted, because editing a Telegram message doesn't produce a
notification, and a nudge nobody is notified about isn't a nudge.

### Joining, and leaving

Two kinds of invite code, deliberately not interchangeable. A **joining** code creates a
new person in the group and is redeemed with `/start`; a **caregiver** code links you as
someone's backup and is redeemed with `/caregiver`. Offering one to the wrong command is
refused *without consuming it* — these are single use, and burning one on the wrong command
would leave someone holding a dead code with no idea why.

Either side can end a caregiver arrangement: the caregiver with `/leave`, the patient from
the buttons under `/patients`. Both parties are told when it ends, because otherwise one
person believes they are being watched and the other believes they are watching.

That `/leave` exists at all matters for safety, not just courtesy: a caregiver who cannot
step back will mute the bot instead, and a muted caregiver is a safety net that looks
present and is not.

A chat cannot become a backup for a patient it already owns. This is not hypothetical —
the upsert used to overwrite `role='patient'` with `'caregiver'`, leaving a patient with no
tier-0 chat and nobody being reminded first-hand, while the link looked perfectly healthy.

### Escalation

Every chat linked to a patient has a tier. Tier 0 — the patient — gets everything
immediately. Tier 1 — a caregiver — gets nothing until a prompt has gone unanswered for a
few minutes, at which point they see the same prompt in the third person and can answer on
the patient's behalf.

This applies to *every* kind of prompt: medicines, meals, waking, sleeping. There's no kind
of question that can quietly die in a chat nobody is looking at.

### Taking a dose early

`/took drop_a` works before the bot has asked. Someone already up and holding the bottle has
taken that dose, and the chain re-bases from when they really did it.

How far "early" may go is bounded by the medicine's own safety floor, not by the schedule:
a stated time is accepted as long as it is far enough after the previous dose. That is the
only constraint that matters clinically. A time too soon after the last dose is still
recorded -- the patient is saying what happened -- but flagged, so nobody doubles up on
the strength of it.

Which slot a stated time refers to is decided by nearest match. "I took it at 5" said at 7,
when the 5pm dose was already written off, corrects the 5pm one; said at 5, when the dose
is not due for another hour, resolves the pending one.

### Order within a spacing group

When several drops fall due together, which they usually do, the order is deliberate:
an explicit `group_seq` from the prescription first, then plain medicines before tapering
ones, then by name. The patient learns a sequence -- this drop, wait, that drop -- and a
sequence that reshuffles itself is one they will get wrong. Putting the steady part of the
routine first means only the changing medicine moves as the taper steps down.

### Correcting the past

`/took drop_a 5pm` works even if the bot already wrote that dose off. It finds the dose whose
slot covers five o'clock, flips it to taken, cancels whatever the scheduler built on the
wrong assumption, and recalculates from there. Both the original and the correction stay in
the log.

This is the necessary counterweight to a bot that never stops nagging. Without it, one
forgotten tap skews the schedule permanently and you learn to ignore the thing.

Bare times mean the most recent past occurrence ("5pm" said at 2am means yesterday). Future
times are refused. Anything over a day old asks for confirmation. Anything that would imply
two doses closer together than the medicine's minimum gap is questioned rather than
silently recorded.

### Meals

The bot does not assume when you eat. It asks, in advance, and works backwards.

A fixed meal time fails twice over. It is simply wrong for someone recovering at home who
woke at noon. And it makes "half an hour before food" unschedulable, because by the time
you confirm you have eaten, that window has gone.

So each meal runs through three states:

1. **Proposed.** An assumed time is derived from when you woke -- not from the clock, and
   never bunched against the previous meal -- and the bot proposes it: *"Having breakfast
   around 09:15?"* One tap to agree, one to push it back half an hour, an hour, two.

   The question arrives far enough ahead of that time for the before-meal tablet to still
   have its half hour; the lead widens automatically to cover the longest before-meal
   offset of anything tied to that meal. And it never proposes a time that has already
   gone, because that leaves no room to act on the answer.
2. **Planned.** Your answer fixes the time. Anything due before the meal is scheduled from
   it, and its reminder says why: *"you said breakfast in about 30 minutes — this one goes
   before it."* Change your mind and the tablets move with you.
3. **Confirmed.** At the planned time it asks whether you are eating now. That releases
   anything due after the meal.

Every step has a fallback. A meal nobody answers about is presumed to have happened a
couple of hours after the *originally* assumed time -- not after the proposal, which keeps
sliding forward, or it would never be presumed at all and every after-meal tablet would
wait for ever. A meal planned but never confirmed is presumed the same way, so an after-meal tablet is never stranded waiting for an answer
that is not coming. A meal you say you are skipping resolves whatever depended on it rather
than leaving it hanging, and the medicine returns tomorrow.

Before you have said anything, a prediction stands in -- derived from your waking time, not
from a clock -- so a before-meal tablet always has something to aim at. The moment you say
when you are actually eating, the dose follows.

The `1+0+1` shorthand produces a genuinely meal-tied medicine, anchored on breakfast and
dinner, rather than clock times standing in for them. Each dose hangs off whichever meal
comes next.

---

## The failure modes it's built around

These are the rules that exist because of a specific way the thing could go quietly wrong.

1. **No absorbing state.** Covered above. Someone who never answers still gets reminders.
2. **Any inbound message counts as being awake.** If you reply to anything, you're up.
   Free, and it removes most reasons to ask.
3. **A minimum-gap floor on every computed time**, never overridden by the wake anchor, a
   meal moving, a correction, or a re-import. This is the one check between the scheduler
   and a double dose — the real path being: you take a dose at 06:20 half asleep, tap "I'm
   awake" at 07:00, and a naive anchor prompts you again thirty minutes later.
4. **Every terminal path schedules the successor**, or marks the medicine finished with a
   reason. A resolved dose that doesn't schedule the next one kills that medicine silently
   for the rest of the course.
5. **One live dose per medicine, enforced by a database constraint** rather than by code
   remembering to. Missed doses can't stack into three queued prompts.
6. **Catch-up is closed-form.** Six hours unattended collapses to one dose and a count, not
   a replay and not a loop.
7. **Telegram updates are deduplicated** by update id. Telegram redelivers whenever it
   doesn't get a prompt reply — including on any slow cold start — and a repeated "taken"
   would end a course early.
8. **Acknowledgment races settle by guarded update.** D1 has no interactive transactions, so
   the precondition rides in the `WHERE` clause and only the write that actually changed a
   row advances the schedule. The other person is told who got there first.
9. **A dropped cron is harmless.** The tick asks "what is due at or before now", never
   "what is due this minute", so a late or missing run self-heals instead of losing a dose
   or firing a burst of catch-up nags.
10. **Failed sends are queued, not lost.** A Worker gets 50 subrequests and Telegram
    rate-limits per chat, so a busy tick can run out of room mid-fan-out. Anything
    undelivered goes to a priority queue and is retried with backoff — critical medicines
    first, so a backlog of digests can't stand in front of a dose.
11. **Nonsense in the database cannot stop the tick.** Every medicine and patient passes
    through `core/sanitize.ts` before planning: intervals, gaps, course lengths and nag
    ladders are clamped into workable ranges, unreadable times fall back to sane defaults,
    and an unknown timezone becomes UTC. An exception in the planner would mean that
    patient silently stops being reminded, with nothing to show for it but an audit row
    nobody reads -- so garbage is made harmless rather than allowed to propagate.
    `test/robustness.test.ts` throws several dozen malformed shapes at it and asserts it
    neither throws, nor schedules a dose at an invalid instant, nor forgets to ask to be
    woken again.
12. **A daily digest and a liveness watchdog.** The digest is the cheapest way for a human
    to notice the whole thing has stopped; the watchdog escalates any medicine that's gone
    quiet for far longer than its own cycle. A course ending normally doesn't trip it —
    an alert that fires every time teaches people to ignore the one that matters.

---

## Architecture

```
Telegram ──webhook──► fetch()     ─┐                    ┌─► D1 (SQLite)
                                   ├─► plan()  [pure] ──┤
Cron (every minute) ─► scheduled()─┘                    └─► Telegram API
```

Every scheduling decision goes through one pure function:

```ts
plan(state: PatientState, now: number, zone: Zone): Action[]
```

No fetch, no database, no `Date.now()`, no randomness inside it. The tick loads a snapshot,
calls it, applies the returned actions in one batch, and sends whatever came out.

That separation is the entire reason the behaviour is testable. `test/` drives a synthetic
clock through a week at one-minute resolution and asserts a set of invariants after *every
tick* — no active medicine ever left without a scheduled dose, no two doses of the same
medicine closer than its safety floor, no non-critical message while asleep, and no dose
stacking. Whole days of behaviour verify in milliseconds.

The simulator also honours the same wake-up gating production uses. That matters: an
earlier version ticked every minute regardless, which silently hid a bug where a prompt
created during a tick never scheduled its own follow-ups — so the caregiver escalation
would never have fired at all.

Zero runtime dependencies. Raw `fetch` against the Telegram API, hand-rolled JSON
validation, server-rendered HTML. The whole deployment is about 60 KB gzipped.

### Layout

```
src/index.ts       entry point; the only place Date.now() is read
src/core/          pure — planner, timezone maths, prescription parsing, rendering
src/io/            D1 gateway, Telegram client, auth
src/handlers/      the tick, the webhook, commands, callbacks, dashboard
test/              simulator + scenarios
migrations/        schema
```

Hard rule, enforced by the import graph: nothing under `src/core/` imports from `src/io/`.
That's what keeps `plan()` testable.

### Timezones

`src/core/tz.ts` is the one genuinely fiddly module. Converting a wall-clock time in an
IANA zone to a UTC instant with no dependencies means going through
`Intl.DateTimeFormat.formatToParts`, pinning locale, calendar, numbering system and hour
cycle (locale defaults can otherwise give you non-Gregorian years, Arabic-Indic digits, or
hour "24").

The inverse probes both sides of the day and round-trips each candidate, because the naive
single-iteration approach silently misses that a fall-back time has two valid instants.
Spring-forward times that don't exist are shifted past the transition rather than dropped —
a silently skipped dose being exactly what this is all trying to avoid. Intervals stay in
absolute UTC milliseconds, so "every 2h" is DST-immune for free.

---

## Security

The dashboard is one account, and it can read everyone in the household's medical data.
That's the design — it's one family's deployment — but it's worth knowing before you invite
someone.

- **Sessions** are random 256-bit tokens; only their SHA-256 is stored, so a copy of the
  database doesn't hand over live logins. The cookie is `__Host-` prefixed, HttpOnly,
  Secure, SameSite=Lax, with a CSRF token on every state-changing form.
- **Passwords** use PBKDF2-HMAC-SHA256. The work factor is **calibrated at deploy time, not
  hardcoded** — Cloudflare's free plan allows 10 ms of CPU per request, and the setup script
  measures the real cost and picks the largest value that fits comfortably. It's stored in
  the database and per password row, so raising it later re-hashes lazily instead of locking
  anyone out.

  That lands well below what OWASP suggests for PBKDF2. What compensates: the generated
  initial password carries about 114 bits of entropy, so its iteration count is irrelevant;
  a chosen one must be at least 12 characters; and failed logins are throttled. An online
  guessing attack is the realistic threat and throttling is what stops it — an offline one
  needs the database, which needs your Cloudflare account, at which point the data is
  already exposed.
- **Throttling is per source address** with a much looser global backstop. A single global
  counter would let anyone lock you out of your own dashboard by guessing wrong every few
  minutes — trading a brute-force defence for a denial-of-service hole.
- **Invites are single use and expire in 24 hours**, claimed atomically so two people can't
  redeem the same code. There's no permanent password that opens the deployment forever.
- **The webhook** verifies Telegram's secret token, and every button press checks that the
  acting chat is actually linked to that dose's patient.
- **The dashboard is read-only over medical data.** Nothing there can alter a schedule,
  pause a medicine or mark a dose taken — those stay in Telegram, so the safety rules live
  in exactly one code path.

---

## Platform notes

Running on Cloudflare's free tier, verified against current limits:

- Cron triggers have a one-minute minimum. We use one.
- 100,000 requests/day, 10 ms CPU per invocation, 50 subrequests. A tick costs 1–2 ms; a
  login about 7 ms.
- D1 free tier is 5 GB, 5M row reads and 100k row writes a day. A household uses a
  thousandth of that.
- Cloudflare doesn't retry a failed cron invocation, and free-tier crons can run late —
  hence the "due at or before now" design.

Comfortable to a few dozen patients per deployment. Hundreds would want the paid plan.

---

## Working on it

```bash
npm test           # the full simulation suite
npm run typecheck
npm run dev        # local worker + local D1
```

Admin and deployment:

```bash
npm run setup            # first-time deploy, end to end
npm run status           # what's deployed and running
npm run reset-password   # new generated password
npm run calibrate        # re-tune password hashing to this runtime
npm run deploy           # migrate and push code
```

`setup` is idempotent — it never regenerates an admin password that already exists.

`GET /health` reports when the scheduler last ran and how many messages are queued. It's
the quickest way to check the thing is alive.

### Commands

The full surface, all of which avoids ever editing code:

```
/start /help /status /meds /log /patients /settings
/awake [time]  /sleep [time]  /ate breakfast|lunch|dinner [time]
/took <med> [time]  /snooze <med> [15m]  /skip <med>  /undo
/prompt  /import  /export  /prescription
/add {...}  /edit <med> every 3h  /pause  /resume  /stop  /extend <med> 3d
/tz Asia/Dhaka  /invite  /caregiver <code>
```

Every `[time]` is optional and takes the retrospective formats above. `/meds` also puts an
✏️ button beside each medicine that opens a tap-through editor — how many doses a day,
interval, spacing, pause, stop, extend — so the common mid-course changes need no
remembered syntax.

`/edit <med> perday 3` is the one people reach for most: a doctor says "drop it to three
times a day", not "make it every four hours and forty minutes". It spreads the doses across
the patient's own waking window using exactly the arithmetic an import of "3 times a day"
would have used — two implementations of that would eventually disagree.

`/settings` covers the times that shape the day: when to start asking whether you are
awake, when to give up and assume it, the same for bedtime, and when to send the digest.

### The prescription format

Five schedule types cover essentially every real prescription: `interval` (anchored on the
actual last dose), `fixed_times`, `times_per_day` (compiled to fixed times at import),
`meal` (before/after/with, plus an offset), and `as_needed`. There's shorthand for the
South Asian `1+0+1` notation so a prescription can be transcribed literally.

Full schema in [`schema/prescription.schema.json`](../schema/prescription.schema.json), a
worked example in [`examples/example.json`](../examples/example.json), and the prompt
that generates it in [`LLM_PROMPT.md`](LLM_PROMPT.md).

Re-importing mid-course keys on a stable `med_key`, so a corrected prescription preserves
course progress rather than restarting a seven-day antibiotic on day five. A medicine that
disappears from the new document is discontinued, never deleted — the history has to stay.
