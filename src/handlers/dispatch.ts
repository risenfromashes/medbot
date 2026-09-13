/**
 * Turning planner actions into messages.
 *
 * The one Telegram-specific rule that shapes this file: **editing a message produces no
 * notification**. A nudge implemented as an edit is invisible, which for a medication
 * reminder is the same as not sending it. So every nudge is a fresh message, and the
 * superseded one is deleted so the chat does not fill with duplicates.
 */

import type { Action, Chat, Dose, Medicine, PatientState, Prompt } from '../core/domain.js';
import {
  renderDosePrompt, renderMealPrompt, renderSleepPrompt, renderWakePrompt,
} from '../core/render.js';
import type { Rendered } from '../core/render.js';
import type { Db } from '../io/db.js';
import type { Telegram } from '../io/telegram.js';
import type { Zone } from '../core/tz.js';

export interface DispatchCtx {
  db: Db;
  tg: Telegram;
  z: Zone;
  now: number;
}

/** Reconstruct the dose objects a prompt refers to, including ones created this tick. */
function doseLookup(state: PatientState, actions: Action[], doseIds: Map<number, number>): Map<number, Dose> {
  const map = new Map<number, Dose>();
  for (const d of state.liveDoses) map.set(d.id, d);
  for (const a of actions) {
    if (a.t !== 'createDose') continue;
    const realId = doseIds.get(a.id) ?? a.id;
    map.set(realId, {
      id: realId,
      patientId: state.patient.id,
      medId: a.medId,
      seq: a.seq,
      step: a.step,
      localDay: a.localDay,
      plannedDueAt: a.plannedDueAt,
      effectiveDueAt: a.effectiveDueAt,
      anchorKind: a.anchorKind,
      status: 'prompted',
      takenAt: null,
      resolvedAt: null,
      resolvedByChat: null,
      resolutionSrc: null,
      nagCount: 0,
      firstPromptAt: null,
      promptId: null,
    });
  }
  // Retimed doses may have moved since the snapshot was taken.
  for (const a of actions) {
    if (a.t !== 'retimeDose') continue;
    const d = map.get(doseIds.get(a.doseId) ?? a.doseId);
    if (d !== undefined) d.effectiveDueAt = a.effectiveDueAt;
  }
  return map;
}

function renderFor(
  prompt: Prompt,
  doses: Dose[],
  meds: Map<number, Medicine>,
  state: PatientState,
  z: Zone,
  now: number,
  forCaregiver: boolean,
): Rendered {
  const name = state.patient.displayName;
  switch (prompt.kind) {
    case 'dose':
      return renderDosePrompt(prompt, doses, meds, z, now, { forCaregiver, patientName: name });
    case 'wake':
      return renderWakePrompt(prompt.nudgeCount, forCaregiver, name);
    case 'sleep':
      return renderSleepPrompt(forCaregiver, name);
    case 'meal':
      return renderMealPrompt(prompt.body.meal ?? 'a meal', forCaregiver, name);
    case 'info':
      return { text: prompt.body.text ?? '', buttons: [] };
  }
}

/** Chats that should receive a prompt at a given escalation tier. */
function chatsAtOrBelow(state: PatientState, tier: number): Chat[] {
  return state.chats.filter((c) => c.active && c.escalationTier <= tier);
}

function chatsExactly(state: PatientState, tier: number): Chat[] {
  return state.chats.filter((c) => c.active && c.escalationTier === tier);
}

async function sendTo(
  ctx: DispatchCtx,
  chats: Chat[],
  promptId: number,
  render: (forCaregiver: boolean) => Rendered,
): Promise<void> {
  for (const chat of chats) {
    if (ctx.tg.exhausted) return;
    const r = render(chat.role === 'caregiver');
    const res = await ctx.tg.sendMessage(chat.chatId, r.text, {
      ...(r.buttons.length > 0 ? { replyMarkup: { inline_keyboard: r.buttons } } : {}),
    });
    if (res.ok && res.result !== undefined) {
      await ctx.db.recordPromptMessage(promptId, chat.chatId, res.result.message_id, 'sent', ctx.now);
    } else {
      // 403 means the user blocked the bot. Left active, it would burn a subrequest every
      // single tick forever.
      if (res.errorCode === 403) await ctx.db.deactivateChat(chat.chatId, ctx.now);
      await ctx.db.recordPromptMessage(promptId, chat.chatId, null, 'failed', ctx.now, res.error);
    }
  }
}

export async function dispatch(
  ctx: DispatchCtx,
  state: PatientState,
  actions: Action[],
  ids: { doseIds: Map<number, number>; promptIds: Map<number, number> },
): Promise<void> {
  const doses = doseLookup(state, actions, ids.doseIds);
  const meds = new Map(state.meds.map((m) => [m.id, m]));

  for (const a of actions) {
    if (ctx.tg.exhausted) return;

    if (a.t === 'createPrompt') {
      const promptId = ids.promptIds.get(a.id) ?? a.id;
      const prompt: Prompt = {
        id: promptId,
        patientId: state.patient.id,
        kind: a.kind,
        state: 'open',
        body: { ...a.body, doseIds: a.body.doseIds.map((d) => ids.doseIds.get(d) ?? d) },
        nudgeCount: 0,
        lastNudgeAt: null,
        escalatedTier: 0,
        createdAt: ctx.now,
      };
      const involved = prompt.body.doseIds
        .map((id) => doses.get(id))
        .filter((d): d is Dose => d !== undefined);
      await sendTo(ctx, chatsAtOrBelow(state, a.tier), promptId, (care) =>
        renderFor(prompt, involved, meds, state, ctx.z, ctx.now, care),
      );
      continue;
    }

    if (a.t === 'nudgePrompt') {
      const promptId = ids.promptIds.get(a.promptId) ?? a.promptId;
      const prompt = state.openPrompts.find((q) => q.id === promptId);
      if (prompt === undefined) continue;
      const bumped: Prompt = { ...prompt, nudgeCount: prompt.nudgeCount + 1 };
      const involved = prompt.body.doseIds
        .map((id) => doses.get(id))
        .filter((d): d is Dose => d !== undefined);

      // Delete the superseded reminder first so the chat stays readable, then send a
      // fresh one -- which is the only way the nudge actually buzzes the phone.
      const previous = await ctx.db.promptMessages(promptId);
      for (const pm of previous) {
        if (pm.messageId === null || ctx.tg.exhausted) continue;
        await ctx.tg.deleteMessage(pm.chatId, pm.messageId);
        await ctx.db.clearPromptMessage(promptId, pm.chatId);
      }
      await sendTo(ctx, chatsAtOrBelow(state, prompt.escalatedTier), promptId, (care) =>
        renderFor(bumped, involved, meds, state, ctx.z, ctx.now, care),
      );
      continue;
    }

    if (a.t === 'escalatePrompt') {
      const promptId = ids.promptIds.get(a.promptId) ?? a.promptId;
      const prompt = state.openPrompts.find((q) => q.id === promptId);
      if (prompt === undefined) continue;
      const involved = prompt.body.doseIds
        .map((id) => doses.get(id))
        .filter((d): d is Dose => d !== undefined);
      // Only the newly-reached tier is messaged; the tiers below already have it.
      await sendTo(ctx, chatsExactly(state, a.tier), promptId, (care) =>
        renderFor(prompt, involved, meds, state, ctx.z, ctx.now, care),
      );
    }
  }
}

/** Remove a prompt's messages from every chat once it has been answered. */
export async function clearPromptMessages(ctx: DispatchCtx, promptId: number): Promise<void> {
  const messages = await ctx.db.promptMessages(promptId);
  for (const pm of messages) {
    if (pm.messageId === null || ctx.tg.exhausted) continue;
    await ctx.tg.deleteMessage(pm.chatId, pm.messageId);
    await ctx.db.clearPromptMessage(promptId, pm.chatId);
  }
}

/** A short line to every chat linked to the patient. Used for confirmations. */
export async function broadcast(
  ctx: DispatchCtx,
  chats: Chat[],
  text: string,
  except?: number,
): Promise<void> {
  for (const chat of chats) {
    if (!chat.active || chat.chatId === except || ctx.tg.exhausted) continue;
    const res = await ctx.tg.sendMessage(chat.chatId, text, { disableNotification: true });
    if (!res.ok && res.errorCode === 403) await ctx.db.deactivateChat(chat.chatId, ctx.now);
  }
}
