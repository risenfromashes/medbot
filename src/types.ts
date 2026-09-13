export interface Env {
  MEDBOT_DB: D1Database;
  /** From @BotFather. */
  TELEGRAM_BOT_TOKEN: string;
  /** Echoed back by Telegram on every webhook call so we can verify the sender. */
  WEBHOOK_SECRET: string;
  /** Gate so strangers who find the bot cannot use your deployment. */
  JOIN_CODE?: string;
  /** Usually discovered from the first request; set explicitly to override. */
  WEBHOOK_URL?: string;
}

/** The shapes of the Telegram updates we actually handle. */
export interface TgUpdate {
  update_id: number;
  message?: TgIncomingMessage;
  callback_query?: TgCallbackQuery;
}

export interface TgIncomingMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; first_name?: string };
  date: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
}

export interface TgCallbackQuery {
  id: string;
  from: { id: number; first_name?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}
