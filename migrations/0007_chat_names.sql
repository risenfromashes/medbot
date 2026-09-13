-- A readable name for each linked chat.
--
-- Without it, the only way to show someone their caregivers -- or to let them remove one --
-- is by numeric Telegram chat id, which nobody recognises as a person.
ALTER TABLE chats ADD COLUMN display_name TEXT;
