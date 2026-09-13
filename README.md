# medbot

A Telegram bot that nags you to take your medicine until you actually say you have.

Some prescriptions are genuinely hard to follow. Three different eye drops, ten minutes
apart, every two hours, for a week — phone alarms are useless for that. They go off on a
fixed schedule whether you woke at six or at ten, they can't tell you *which* drop to put
in, and they have no idea whether you got up and did it or rolled over and went back to
sleep. By day three you've lost track of whether you took the four o'clock one.

So medbot works the way the prescription actually reads. It waits until you're up before
starting the day. It knows the drops need ten minutes between them, and it counts those ten
minutes from when you actually took the last one. It knows the stomach_capsule goes half an hour
before breakfast. And it keeps asking — politely at first, then less so — until you tell it
you've taken the thing.

**Free to run.** It lives on Cloudflare's free tier and uses a tiny fraction of it. No
credit card, no server, no monthly bill.

**No AI, no API keys.** Once it's running it's plain code. Nothing to subscribe to.

> ⚠️ It's a reminder, not a medical device. Phones get muted, networks drop, software has
> bugs. Don't make it the only thing standing between you and a dose that matters.

---

## A day with it

You wake up and say so — or it works it out from any message you send, or gives up waiting
and starts anyway. **The eye drops are due right then**, not at eight o'clock because eight
o'clock is when someone decided breakfast happens. The second drop comes ten minutes after
you actually take the first.

It keeps asking until you answer. If you don't, it asks whoever's backing you up.

Some time later it proposes breakfast — *"having breakfast around 09:15?"* — early enough
that the tablet due half an hour beforehand still has its half hour. Agree, or push it
back; the tablets move with you.

Took something and forgot to tap? Tell it when, even hours later, even if it had already
written that dose off. It fixes the record and recalculates from the real time.

In the evening it asks if you're off to bed, sends a short summary of the day, and goes
quiet until morning.

## Who it's for

Anyone on a course of medicine fiddly enough that you keep losing track — post-surgery eye
drops, a week of antibiotics, anything with "before food" or "every six hours" on the
label.

It works for one person. It also works for a household: someone can be your backup, so if
you don't answer a reminder within a few minutes, the bot asks *them* instead, and they can
confirm on your behalf. That turns "I forgot" from one point of failure into two.

---

## Getting it running

**1. Make a bot.** Message [@BotFather](https://t.me/BotFather) on Telegram, send
`/newbot`, pick a name. He gives you a long token. That's your password — keep it.

**2. Deploy it.**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/risenfromashes/medbot)

One click, and Cloudflare sets up the whole thing on your own account.

Or if you'd rather do it from a terminal:

```bash
git clone https://github.com/risenfromashes/medbot.git && cd medbot
npm install
npx wrangler login
npm run setup
```

The setup script asks for your bot token and handles everything else — database, secrets,
deployment, the lot. It prints an admin password at the end and saves it to a file. That's
the only time you'll see it.

**3. Say hello.** Open the dashboard link it gave you, sign in, and copy the join code off
the front page. Then message your bot:

```
/start <that code>
/tz Asia/Dhaka          ← wherever you actually are
```

**4. Give it your prescription.** Send `/prompt` and the bot hands you a block of text.
Photograph your prescription, paste that text into whatever AI chatbot you already use
(Claude, ChatGPT, whichever), and it'll turn the photo into the format medbot wants. Paste
the result back with `/import`.

The bot shows you exactly what it understood, in plain English, and waits for you to press
Apply. Read it against the paper before you do — it's reading handwriting, and so are you.

**5. Add your backup person.** Send `/invite`, get a code, give it to them. They send
`/start <code>` to the same bot and they're set.

---

## Using it

Most of the time you just tap the buttons on the reminder. When you'd rather type:

```
/status                 what's waiting, what's coming
/awake      /sleep      start and end your day
/took drop_a              took it just now
/took drop_a 5pm          took it earlier — it'll fix the schedule
/skip drop_a              not taking this one
/snooze drop_a 15m        ask me again shortly
/ate lunch              for the ones tied to meals
/meds                   what you're on and how far through
/log                    how you've been doing
```

Two things worth knowing:

**If you took it and forgot to tap, just say so.** `/took drop_a 5pm` works even if the bot
already gave up and logged that dose as missed. It'll correct the record and recalculate
everything from the real time.

**Changing things doesn't mean touching code.** `/edit drop_a every 3h`, `/extend drop_a 3d`,
`/pause`, `/stop`, `/add`, or `/import` a whole new prescription — and `/meds` gives you
buttons for most of it. All from your phone.

---

## The dashboard

There's a small web dashboard at `/app` for whoever organises things. It shows everyone in
the household, what they're on, what's pending, how they've been doing, and a little map of
who's backing up whom. It's read-only — you can't change anyone's medicine from a browser,
on purpose. Accounts can't be created there either; the only way in is an invite code
through the bot.

---

## More detail

If you want to know how it decides when a dose is due, what happens when nobody answers,
how the security works, or how to hack on it — that's all in
**[docs/DESIGN.md](docs/DESIGN.md)**.

Other bits and pieces:

- [docs/LLM_PROMPT.md](docs/LLM_PROMPT.md) — the prescription-to-JSON prompt, if you'd
  rather copy it from here than from the bot
- [schema/prescription.schema.json](schema/prescription.schema.json) — the full format
- [examples/example.json](examples/example.json) — a worked example

## Licence

MIT. Use it, fork it, and please don't rely on it alone for anything that really matters.
