/**
 * A whole bot, in memory: real migrations, real SQL, real handlers, real Telegram client
 * with the network faked out. Tests written against this see what a person sees.
 */

import { FakeD1 } from './d1.js';
import { handleWebhook } from '../../src/handlers/webhook.js';
import { runTick } from '../../src/handlers/scheduled.js';
import type { Env, TgUpdate } from '../../src/types.js';

export interface SentMessage {
  method: string;
  chatId: number;
  text: string;
  /** When it went out, so a test can look at just this tick's traffic. */
  at: number;
  buttons: Array<Array<{ text: string; callback_data: string }>>;
}

const SECRET = 'test-secret';

export class Bot {
  readonly d1 = new FakeD1();
  readonly sent: SentMessage[] = [];
  /** Telegram calls that are not messages -- setMyCommands, getFile and so on. */
  readonly calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  /** Canned responses by method, for getFile / file downloads. */
  readonly responses = new Map<string, unknown>();
  now: number;
  private updateId = 1;
  private messageId = 1000;
  private readonly pending: Array<Promise<unknown>> = [];

  constructor(start: number) {
    this.now = start;
  }

  get env(): Env {
    return {
      MEDBOT_DB: this.d1 as unknown as D1Database,
      TELEGRAM_BOT_TOKEN: 'test-token',
      WEBHOOK_SECRET: SECRET,
      WEBHOOK_URL: 'https://example.test/tg',
    };
  }

  /** Replaces global fetch for the duration of a test. */
  install(): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const m = /\/bot[^/]+\/(\w+)$/.exec(url);
      if (m === null) {
        // A file download from api.telegram.org/file/...
        const body = this.responses.get('file') ?? '{}';
        return new Response(String(body), { status: 200 });
      }
      const method = m[1]!;
      const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
      this.calls.push({ method, body });
      if (method === 'sendMessage' || method === 'editMessageText') {
        this.sent.push({
          method,
          chatId: Number(body['chat_id']),
          text: String(body['text'] ?? ''),
          at: this.now,
          buttons: ((body['reply_markup'] as { inline_keyboard?: SentMessage['buttons'] } | undefined)?.inline_keyboard) ?? [],
        });
        return this.ok({ message_id: this.messageId++, chat: { id: Number(body['chat_id']) } });
      }
      if (method === 'getFile') return this.ok(this.responses.get('getFile') ?? { file_path: 'documents/file.json' });
      if (method === 'getWebhookInfo') return this.ok({ url: 'https://example.test/tg' });
      return this.ok(true);
    }) as typeof fetch;
  }

  private ok(result: unknown): Response {
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }

  private async deliver(update: Omit<TgUpdate, 'update_id'>): Promise<void> {
    const body = JSON.stringify({ update_id: this.updateId++, ...update });
    const req = new Request('https://example.test/tg', {
      method: 'POST',
      headers: { 'X-Telegram-Bot-Api-Secret-Token': SECRET, 'content-type': 'application/json' },
      body,
    });
    await handleWebhook(req, this.env, (p) => void this.pending.push(p), this.now);
    await this.drain();
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) await this.pending.shift();
  }

  /** Someone sends the bot a message. */
  async send(chatId: number, text: string, opts: { firstName?: string } = {}): Promise<void> {
    await this.deliver({
      message: {
        message_id: this.messageId++,
        from: { id: chatId, first_name: opts.firstName ?? 'Tester' },
        chat: { id: chatId, type: 'private', first_name: opts.firstName ?? 'Tester' },
        date: Math.floor(this.now / 1000),
        text,
      },
    });
  }

  /** Someone attaches a file. `content` is what the download will return. */
  async sendFile(chatId: number, fileName: string, content: string, caption?: string): Promise<void> {
    this.responses.set('file', content);
    await this.deliver({
      message: {
        ...(caption === undefined ? {} : { caption }),
        message_id: this.messageId++,
        from: { id: chatId, first_name: 'Tester' },
        chat: { id: chatId, type: 'private', first_name: 'Tester' },
        date: Math.floor(this.now / 1000),
        document: { file_id: 'F1', file_name: fileName, mime_type: 'application/json', file_size: content.length },
      },
    });
  }

  /** Someone taps a button from the most recent message that has them. */
  async tap(chatId: number, match: string | RegExp): Promise<void> {
    const test = (t: string): boolean => (typeof match === 'string' ? t.includes(match) : match.test(t));
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const msg = this.sent[i]!;
      if (msg.chatId !== chatId) continue;
      for (const row of msg.buttons) {
        for (const b of row) {
          if (!test(b.text)) continue;
          await this.deliver({
            callback_query: {
              id: `cb${this.updateId}`,
              from: { id: chatId, first_name: 'Tester' },
              message: { message_id: this.messageId++, chat: { id: chatId } },
              data: b.callback_data,
            },
          });
          return;
        }
      }
    }
    throw new Error(`no button matching ${String(match)} in ${JSON.stringify(this.sent.slice(-2).map((s) => s.buttons))}`);
  }

  /** Tap a button by its encoded payload, when the test knows exactly which dose it means. */
  async sendCallback(chatId: number, data: string): Promise<void> {
    await this.deliver({
      callback_query: {
        id: `cb${this.updateId}`,
        from: { id: chatId, first_name: 'Tester' },
        message: { message_id: this.messageId++, chat: { id: chatId } },
        data,
      },
    });
  }

  /** One scheduled tick, at the current time. */
  async tick(): Promise<void> {
    await runTick(this.env, this.now);
    await this.drain();
  }

  /** Advance time, ticking every `stepMs`. */
  async run(ms: number, stepMs = 60_000): Promise<void> {
    const end = this.now + ms;
    while (this.now < end) {
      await this.tick();
      this.now += stepMs;
    }
  }

  // --- assertions helpers -------------------------------------------------

  textsTo(chatId: number): string[] {
    return this.sent.filter((m) => m.chatId === chatId).map((m) => m.text);
  }

  last(chatId?: number): string {
    const pool = chatId === undefined ? this.sent : this.sent.filter((m) => m.chatId === chatId);
    return pool.length > 0 ? pool[pool.length - 1]!.text : '';
  }

  clear(): void {
    this.sent.length = 0;
    this.calls.length = 0;
  }
}
