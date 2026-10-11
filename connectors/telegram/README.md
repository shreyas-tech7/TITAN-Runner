# Telegram

A two way connector. TITAN sends messages and approval buttons to your bot. You send commands to the bot.

## Set up

1. Open @BotFather in Telegram. Send `/newbot`. Follow the steps.
2. Paste the bot token in the connect window.
3. TITAN calls `getMe`, then `setWebhook`. The webhook address is `https://<worker>/hooks/telegram/<connection id>`. TITAN sets a secret token and checks the header `X-Telegram-Bot-Api-Secret-Token` on each update.
4. TITAN shows a pair code. Send `/pair <code>` to your bot within 10 minutes. TITAN then keeps your chat id as the owner.

The bot does not answer other chats. For other chats, the Worker logs metadata only.

## Commands

`/status`, `/task <text>`, `/tasks`, `/approve <key>`, `/deny <key>`, `/brief`, `/keys` (states only), `/chat <text>`, and `/help`.

## Actions

| Action | Risk | Data |
|---|---|---|
| `send_message` | write | internal |
