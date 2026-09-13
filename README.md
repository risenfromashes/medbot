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
npx wrangler secret put JOIN_CODE            # a password for joining your bot

npx wrangler deploy
```

Generate the random strings with `openssl rand -hex 32` if you like.

### 3. Connect it to Telegram

Open this once in a browser, using the `WEBHOOK_SECRET` you just set:

```
https://medbot.<your-subdomain>.workers.dev/setup?key=<WEBHOOK_SECRET>
```

That registers the webhook and publishes the command menu. (If you ever forget, the bot
re-checks its own webhook hourly and fixes it.)

### 4. Say hello

In Telegram, send your bot:

```
/start <your JOIN_CODE>
/tz Asia/Dhaka
/import
```

Then paste your prescription JSON. **[docs/LLM_PROMPT.md](docs/LLM_PROMPT.md)** has a
prompt you can give any AI chatbot along with a photo of your prescription — that's the
easy way to produce it. The bot shows you exactly what would change and waits for you to
confirm.

### 5. Add your backup person

You run `/invite` and get a code. They open the bot and send `/caregiver <code> 5m`. From
then on, anything you haven't answered within five minutes goes to them too.

---

## Using it

```
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
