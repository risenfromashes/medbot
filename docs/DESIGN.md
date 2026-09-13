# How medbot works

Everything the README deliberately leaves out: the scheduling rules, the failure modes it
was built around, the security model, and how to work on it.

The organising principle, which decides most of the close calls below:

> **A bot that is annoying is a bug. A bot that goes quiet is a catastrophe.**

Where the system can't be sure, it asks rather than assumes, and it errs towards making
noise rather than towards silence.

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

Three eye drops that must be ten minutes apart are modelled as **one medicine with three
steps**, not three medicines plus a constraint. The gap is measured from the previous drop
*actually* going in, so being slow on drop one pushes drops two and three along with it.

Medicines with no spacing that fall due within five minutes of each other are merged into a
single message with a checklist, rather than three notifications ninety seconds apart.

### Nagging

Reminders repeat at 10, 15, 20, then every 30 minutes. It never gives up — but an
unanswered reminder must never be able to wedge a medicine, so when the *next* dose falls
due the outstanding one is logged as missed and the chain moves on.

Nagging stops while you're asleep and resumes in the morning. Each nudge is a new message
with the previous one deleted, because editing a Telegram message doesn't produce a
notification, and a nudge nobody is notified about isn't a nudge.

### Escalation

Every chat linked to a patient has a tier. Tier 0 — the patient — gets everything
immediately. Tier 1 — a caregiver — gets nothing until a prompt has gone unanswered for a
few minutes, at which point they see the same prompt in the third person and can answer on
the patient's behalf.

This applies to *every* kind of prompt: medicines, meals, waking, sleeping. There's no kind
of question that can quietly die in a chat nobody is looking at.

### Correcting the past

`/took antibiotic drop 5pm` works even if the bot already wrote that dose off. It finds the dose whose
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

"Thirty minutes before breakfast" can't be scheduled from a confirmation — by the time you
say you've eaten, the window has gone. So each meal has a *typical* time that before-doses
fire against, a time to start asking whether you've eaten, and a time to give up asking and
assume you did. After-doses wait for a real confirmation. "Skipping this meal" resolves
anything depending on it rather than leaving it hanging.

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
11. **A daily digest and a liveness watchdog.** The digest is the cheapest way for a human
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

### The prescription format

Five schedule types cover essentially every real prescription: `interval` (anchored on the
actual last dose), `fixed_times`, `times_per_day` (compiled to fixed times at import),
`meal` (before/after/with, plus an offset), and `as_needed`. There's shorthand for the
South Asian `1+0+1` notation so a prescription can be transcribed literally.

Full schema in [`schema/prescription.schema.json`](../schema/prescription.schema.json), a
worked example in [`examples/eye-drops.json`](../examples/eye-drops.json), and the prompt
that generates it in [`LLM_PROMPT.md`](LLM_PROMPT.md).

Re-importing mid-course keys on a stable `med_key`, so a corrected prescription preserves
course progress rather than restarting a seven-day antibiotic on day five. A medicine that
disappears from the new document is discontinued, never deleted — the history has to stay.
