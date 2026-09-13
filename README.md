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

### 2. Deploy

```bash
git clone <this repo> && cd medbot
npm install

npx wrangler login                        # opens a browser
npx wrangler d1 create medbot             # prints a database_id
```

Put that `database_id` into `wrangler.jsonc`, replacing `REPLACE_WITH_YOUR_DATABASE_ID`.
Then:

```bash
npx wrangler d1 migrations apply MEDBOT_DB --remote

npx wrangler secret put TELEGRAM_BOT_TOKEN   # paste the BotFather token
npx wrangler secret put WEBHOOK_SECRET       # any long random string

npx wrangler deploy
```

Generate the random string with `openssl rand -hex 32`. There is no join password to set —
joining is by single-use invite code, minted from the dashboard.

### 3. Connect it to Telegram, and get your admin password

Open this once in a browser, using the `WEBHOOK_SECRET` you just set:

```
https://medbot.<your-subdomain>.workers.dev/setup?key=<WEBHOOK_SECRET>
```

That registers the webhook, publishes the command menu, and creates the single admin
account. **It shows you a generated password exactly once** — save it. There is no
recovery: the only way to get a new one is to reset the account.

### 4. Sign in and invite yourself

Go to `https://medbot.<your-subdomain>.workers.dev/app` and sign in as `admin`. Change the
password, then use the join code on the overview page.

### 5. Say hello

In Telegram, send your bot:

```
/start <the join code from the dashboard>
/tz Asia/Dhaka
/import
```

Then paste your prescription JSON. **[docs/LLM_PROMPT.md](docs/LLM_PROMPT.md)** has a
prompt you can give any AI chatbot along with a photo of your prescription — that's the
easy way to produce it. The bot shows you exactly what would change and waits for you to
confirm.

### 6. Add your backup person

Either mint a caregiver code in the dashboard, or send `/invite` in Telegram. Give them the
code; they open the bot and send `/start <code>`. From then on, anything you haven't
answered within five minutes goes to them too.

Invite codes are **single use and expire in 24 hours** — there is no permanent password
that opens your deployment forever.

---

## Using it

```
/start <code>      join, using an invite code
/status            what's waiting, what's next
/awake  /sleep     start and end your day (accepts a past time: /awake 6:30am)
/ate lunch         meal-timed medicines need this
/took antibiotic drop         log a dose
/took antibiotic drop 5pm     …at a time you actually took it
/took antibiotic drop 20m ago
/skip antibiotic drop         /snooze antibiotic drop 15m
/meds              medicines, schedules, course progress
/log 7             adherence for the last week
/import  /export   change the prescription
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
