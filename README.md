# medbot

A Telegram bot that reminds you to take your medicines, and doesn't give up until you say
you have.

Phone alarms fire on a fixed grid whether or not you woke up late, can't tell you *which*
drop to put in, and have no idea whether you answered. medbot follows the actual
prescription: it knows the eye drops need ten minutes between them, that the stomach capsule
goes half an hour before breakfast, that you took the four o'clock dose at ten past — and
that you still haven't confirmed the six o'clock one.

- **Free to run.** Cloudflare's free tier, no credit card. Uses roughly 0.1% of it.
- **No AI at runtime, no API keys.** Entirely deterministic.
- **Your prescription lives in JSON, not in the code.** Change it from your phone.
- **Shared, with escalation.** If the patient doesn't answer in five minutes, someone else
  gets asked.
- **An admin dashboard** for whoever organises the household — read-only, on the same
  deployment, no extra hosting.

> ⚠️ **This is a reminder, not a medical device.** It can fail — phones get muted, networks
> drop, bugs exist. Don't rely on it as the only safeguard for anything critical, and
> follow your prescription over anything the bot says.

---

## What it actually does

**It waits for you to wake up.** Interval medicines anchor on when your day starts, not on
a clock. If you haven't said you're awake it asks, and if you never answer it starts dosing
anyway at a configured fallback time — going quiet is worse than being wrong.

**It measures from the dose you actually took.** Answer within half an hour of the
scheduled time and the grid holds. Answer two hours late and the whole chain re-bases on
when you really took it. (Without the first half, a week-long course drifts an hour a day
and walks its evening dose into the middle of the night.)

**It spaces what needs spacing.** Three eye drops ten minutes apart arrive as three
separate prompts, each timed from the previous drop actually going in. Tablets due at the
same time arrive as one checklist.

**It doesn't give up — and doesn't get stuck.** Reminders repeat at 10, 15, 20, then every
30 minutes, and stop while you're asleep. But when the next dose falls due, the unanswered
one is logged as missed and the schedule moves on, so one ignored reminder can never freeze
a medicine.

**It tells you every evening what happened.** A short digest at a time you choose — taken,
missed, course progress. If that stops arriving, something is wrong, and that is the
cheapest possible way for a human to notice. A watchdog separately escalates any medicine
that has gone quiet for far longer than its own cycle.

**It lets you correct the past.** Took it and forgot to tap? `/took antibiotic drop 5pm`. If the bot
already wrote that dose off as missed, it flips it back, recalculates from the real time,
and keeps both values in the log.

**It asks someone else if you don't answer.** A caregiver chat gets any prompt you've
ignored for five minutes — medicines, meals, waking, sleeping — and can answer for you.

---

## Setting it up

You need a Telegram account and a Cloudflare account. Both free, neither needs a card.
About ten minutes.

### 1. Make a bot

Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, pick a name.
He gives you a token that looks like `123456789:AAE...`. Keep it — it is a password.

### 2. Run the setup script

```bash
git clone https://github.com/risenfromashes/medbot.git && cd medbot
npm install
npx wrangler login     # opens a browser
npm run setup
```

`npm run setup` does the rest: verifies the bot token, creates the D1 database, runs the
migrations, generates and uploads the secrets, **measures how fast password hashing is on
this machine and calibrates the work factor to fit Cloudflare's CPU budget**, deploys,
registers the webhook, and creates your admin account.

It prints the generated admin password once and writes it to `medbot-credentials.json`
(gitignored, `chmod 600`). It is idempotent — re-running it will never regenerate a
password you have already changed.

### 3. Sign in and invite yourself

Open the dashboard URL it printed, sign in, and change the password. The overview page
shows a join code; send it to the bot in Telegram:

```
/start <the join code>
/tz Asia/Dhaka
/prompt          ← the prompt for turning a prescription photo into JSON
/import          ← then paste what the chatbot gives you
```

### 4. Add your backup person

Mint a caregiver code in the dashboard, or send `/invite` in Telegram. Give them the code;
they open the bot and send `/start <code>`. From then on, anything you haven't answered
within five minutes goes to them too.

Invite codes are **single use and expire in 24 hours** — there is no permanent password
that opens your deployment forever.

### Later on

```bash
npm run status           # what is deployed and running
npm run reset-password   # issue a new admin password
npm run calibrate        # re-tune password hashing to this runtime
npm run deploy           # migrate and push code
```

## Using it

```
/start <code>      join, using an invite code
/status            what's waiting, what's next, and today so far
/awake  /sleep     start and end your day (accepts a past time: /awake 6:30am)
/ate lunch         meal-timed medicines need this
/took antibiotic drop         log a dose
/took antibiotic drop 5pm     …at a time you actually took it
/took antibiotic drop 20m ago
/skip antibiotic drop         /snooze antibiotic drop 15m
/meds              medicines, schedules, course progress
/log 7             adherence for the last week
/prompt            the prompt for converting a prescription photo
/import  /export   replace the whole prescription
/add {...}         add one medicine
/edit antibiotic drop every 3h    change one thing
/extend antibiotic drop 3d        lengthen a course
/pause  /resume  /stop
/tz Asia/Dhaka
/invite  /caregiver
/health            is the scheduler still running?
```

Most of the time you just tap the buttons on the reminder.

---

## The dashboard

At `/app`, for whoever organises the household. One account, created at setup; **accounts
can never be created from the web** — the only way into the family group is an invite code
redeemed through the bot.

- **Overview** — everyone in the group, awake or asleep, how many medicines are waiting,
  and whether the scheduler is actually running.
- **Per person** — the active prescription, every medicine with its schedule and course
  progress, what's pending right now, 14-day adherence, and the recent dose log with
  retrospective corrections marked as such.
- **Relationships** — who looks after whom, drawn as a graph. Solid lines are a person's
  own chat (reminded immediately), dashed lines are caregivers (reminded only after
  silence).
- **Invites** — mint join codes for new members and caregiver codes for backups, revoke
  outstanding ones, see which have been redeemed.
- **Account** — change your name, username and password; see and revoke active sessions.

**It is strictly read-only over medical data.** Nothing in the dashboard can alter a
schedule, pause a medicine or mark a dose taken — those all stay in Telegram, so the
scheduler's safety rules live in exactly one code path.

### On the security of it

Worth being straight about, since this is health data on a public URL:

- Sessions are random 256-bit tokens; only their SHA-256 is stored, so a copy of the
  database does not hand over live logins. The cookie is `__Host-` prefixed, HttpOnly,
  Secure, SameSite=Lax, and there is a CSRF token on every state-changing form.
- Passwords are PBKDF2-HMAC-SHA256. **The work factor is capped by the platform**: the free
  plan allows 10ms of CPU per request, and 60k iterations measured 11–17ms on the real
  runtime, so it runs at 25k (~8–9ms per login). That is far below the ~600k OWASP
  suggests. What compensates is that the initial password is generated with ~114 bits of
  entropy, a chosen one must be at least 12 characters, and failed logins are throttled per
  source address — an online guessing attack is the realistic threat, and that is what
  stops it. An offline attack needs the D1 database, which needs your Cloudflare account.
- Throttling is per-IP with a loose global backstop, deliberately: a single global counter
  would let anyone lock you out of your own dashboard by guessing wrong every few minutes.
- The admin can read every family member's medical data. That is the design — it is one
  household's deployment — but it is worth knowing before you invite someone.

## How it works

```
Telegram ──webhook──► fetch()     ─┐                    ┌─► D1 (SQLite)
                                   ├─► plan()  [pure] ──┤
Cron (every minute) ─► scheduled()─┘                    └─► Telegram API
```

Every scheduling decision goes through one pure function, `plan(state, now, zone) →
Action[]`, which does no I/O at all. The tick loads a snapshot, calls it, applies the
returned actions in one batch, and sends whatever came out. That is what makes the
behaviour testable: [`test/`](test/) drives a synthetic clock through a week at one-minute
resolution and asserts a set of invariants after *every* tick — most importantly that no
active medicine is ever left without a scheduled dose, and that two doses of the same
medicine never land closer together than its safety floor.

A few decisions worth knowing about:

- **There is no "unknown" day state.** The patient is always awake or asleep, with a
  confidence. An uncertain state that only a human can clear is an absorbing one, and the
  failure mode is total silence.
- **`min_gap` is never overridden.** Not by the wake anchor, not by a meal moving, not by a
  retrospective correction. It is the one check between the scheduler and a double dose.
- **One live dose per medicine, enforced by the database** (a partial unique index), so
  duplicate or overlapping ticks cannot stack up three pending prompts.
- **Telegram updates are deduplicated** by `update_id`, because Telegram redelivers
  whenever it doesn't get a prompt reply, and a repeated "taken" would end a course early.
- **Acknowledgment races are settled by a guarded UPDATE.** D1 has no interactive
  transactions, so whoever's statement actually changes a row is the one that advances the
  schedule; the other person is told who got there first.
- **A dropped cron is harmless.** The tick asks "what is due at or before now", never "what
  is due this minute", so a late or missing tick self-heals rather than losing a dose or
  firing a burst of catch-up nags.
- **A send that fails is queued, not lost.** A Worker gets 50 subrequests and Telegram
  rate-limits per chat, so a busy tick can genuinely run out of room mid-fan-out. Anything
  undelivered goes to a priority queue and is retried with backoff on a later tick —
  critical medicines first, so a backlog of digests can never stand in front of a dose.
- **The password work factor is calibrated, not hardcoded.** It lives in the database and
  is set by measuring the real cost at deploy time; see the security note above.

### Development

```bash
npm test           # the full simulation suite
npm run typecheck
npm run dev        # local worker + local D1
```

`GET /health` reports when the scheduler last ran — the cheapest way to notice it has
stopped.

## Licence

MIT.

## One-click install

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/risenfromashes/medbot)

Cloudflare forks the repository, provisions the D1 database, runs the migrations and
deploys — you supply the bot token. Afterwards, open `/setup?key=<WEBHOOK_SECRET>` once to
register the webhook and create your admin account.

For anything beyond the first install — resetting a password, re-tuning the hash cost,
rotating the webhook secret — use the script:

```bash
npm run setup            # first-time deploy, end to end
npm run status           # what is deployed and running
npm run reset-password   # issue a new admin password
npm run calibrate        # re-tune password hashing to this runtime
npm run deploy           # migrate and push code
```

`setup` is idempotent: it will not regenerate an admin password that already exists, so
re-running it after you have changed yours is safe.
