/**
 * A thin Telegram Bot API client. No framework, no dependencies -- the whole surface we
 * need is six methods, and keeping it to raw fetch keeps cold-start CPU well inside the
 * free plan's 10ms budget.
 */

import { stripTags } from '../core/html.js';

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface SendOptions {
  replyMarkup?: { inline_keyboard: InlineButton[][] };
  disableNotification?: boolean;
}

export interface TgResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
  errorCode?: number;
  retryAfter?: number;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
}

export class Telegram {
  /** Every outbound call passes through here, so the subrequest budget has one place to live. */
  private calls = 0;

  constructor(
    private readonly token: string,
    private readonly maxCalls = 40,
  ) {}

  get callsUsed(): number {
    return this.calls;
  }

  get exhausted(): boolean {
    return this.calls >= this.maxCalls;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<TgResult<T>> {
    // A Worker invocation may make at most 50 subrequests. Refusing here rather than
    // throwing means the tick finishes cleanly and the unsent work is simply picked up
    // next minute -- the same self-healing property that makes a dropped cron harmless.
    if (this.calls >= this.maxCalls) {
      return { ok: false, error: 'subrequest budget exhausted' };
    }
    this.calls++;

    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        ok: boolean;
        result?: T;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
      };
      if (json.ok) return { ok: true, ...(json.result !== undefined ? { result: json.result } : {}) };
      return {
        ok: false,
        error: json.description ?? `HTTP ${res.status}`,
        ...(json.error_code !== undefined ? { errorCode: json.error_code } : {}),
        ...(json.parameters?.retry_after !== undefined ? { retryAfter: json.parameters.retry_after } : {}),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Send a message, and actually get it there.
   *
   * Telegram fails closed on both of the things that go wrong with generated text: a
   * message over 4096 characters is rejected outright, and so is one whose HTML it cannot
   * parse. Neither produces anything visible -- the reminder simply never arrives, which
   * for this bot is the worst failure there is. So long text is split on a line boundary,
   * and a parse failure is retried once as plain text.
   */
  async sendMessage(chatId: number, text: string, opts: SendOptions = {}): Promise<TgResult<TgMessage>> {
    const parts = splitForTelegram(text);
    let last: TgResult<TgMessage> = { ok: false, error: 'nothing to send' };
    for (const [i, part] of parts.entries()) {
      // Buttons belong on the final part, where the reader ends up.
      const isLast = i === parts.length - 1;
      last = await this.sendOne(chatId, part, isLast ? opts : { ...opts, replyMarkup: undefined });
      if (!last.ok) return last;
    }
    return last;
  }

  private async sendOne(chatId: number, text: string, opts: SendOptions): Promise<TgResult<TgMessage>> {
    const body = {
      chat_id: chatId,
      link_preview_options: { is_disabled: true },
      ...(opts.replyMarkup !== undefined ? { reply_markup: opts.replyMarkup } : {}),
      ...(opts.disableNotification === true ? { disable_notification: true } : {}),
    };
    const res = await this.call<TgMessage>('sendMessage', { ...body, text, parse_mode: 'HTML' });
    if (res.ok || !/can't parse entities|unsupported start tag|unclosed/i.test(res.error ?? '')) return res;
    return this.call<TgMessage>('sendMessage', { ...body, text: stripTags(text) });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts: SendOptions = {},
  ): Promise<TgResult<TgMessage>> {
    return this.call<TgMessage>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: opts.replyMarkup ?? { inline_keyboard: [] },
    });
  }

  deleteMessage(chatId: number, messageId: number): Promise<TgResult<boolean>> {
    return this.call<boolean>('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answerCallbackQuery(id: string, text?: string, alert = false): Promise<TgResult<boolean>> {
    return this.call<boolean>('answerCallbackQuery', {
      callback_query_id: id,
      ...(text !== undefined ? { text } : {}),
      show_alert: alert,
    });
  }

  setWebhook(url: string, secret: string): Promise<TgResult<boolean>> {
    return this.call<boolean>('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
  }

  getWebhookInfo(): Promise<TgResult<{ url: string; last_error_message?: string }>> {
    return this.call('getWebhookInfo', {});
  }

  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<TgResult<boolean>> {
    return this.call<boolean>('setMyCommands', { commands });
  }

  getFile(fileId: string): Promise<TgResult<{ file_path: string }>> {
    return this.call('getFile', { file_id: fileId });
  }

  async downloadFile(filePath: string): Promise<string | null> {
    if (this.calls >= this.maxCalls) return null;
    this.calls++;
    try {
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`);
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
  }
}

export { esc } from '../core/html.js';

/** Telegram's hard limit, with room to spare for the "(1/2)" a split never actually adds. */
const MAX_MESSAGE = 4000;

/**
 * Split overlong text at the last blank line, then the last newline, before the cap.
 *
 * Paragraph boundaries first, because that is where a tag is least likely to be left
 * hanging across the join -- and if one is, `sendOne` still gets the message through as
 * plain text rather than dropping it.
 */
export function splitForTelegram(text: string, max = MAX_MESSAGE): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest !== '') parts.push(rest);
  return parts;
}
