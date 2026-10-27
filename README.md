# Telegram → Nuxt JSON importer (Express.js)

A temporary, local **Express.js + Telegram bot** for turning forwarded hotel/apartment Telegram posts into objects matching your existing Nuxt `units.json` schema.

- JavaScript / Node.js, not Python.
- Rule-based Persian text parsing only; **no AI or paid AI API**.
- Every generated listing has `pricePerNight: 8000000`.
- It does not overwrite your Nuxt files.
- Express provides local `/health` and `/status` endpoints; the Telegram bot uses polling, so you do not need a public server or webhook.

## Telegram limitation

A bot cannot independently fetch all old posts from an arbitrary channel. Open the private chat with your bot and manually forward the posts, including their captions.

## 1. Requirements

Install Node.js 20 LTS or newer and npm. On Linux Mint / Ubuntu:

```bash
sudo apt update
sudo apt install nodejs npm
node --version
npm --version
```

If the repository version of Node.js is too old, install a current Node.js LTS release from the official Node.js website.

## 2. Configure Telegram

1. In Telegram, open `@BotFather`, send `/newbot`, and follow the prompts.
2. Copy the bot token.
3. Find your own numeric Telegram user ID using a trusted ID helper.
4. In this folder, copy `.env.example` to `.env`.
5. Edit `.env` and set:

```env
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_ALLOWED_USER_ID=your_numeric_user_id
PORT=3000
```

Keep `.env` and the bot token private. Do not upload `.env` to GitHub or send the token to anyone.

## 3. Install and run

```bash
npm install
npm start
```

Expected logs include the Express health-server address. Keep the terminal open while importing.

Check the local server at `http://127.0.0.1:3000/health`; it should return a small JSON response. The server is bound to localhost only.

## 4. Import your posts

1. Open the bot's private chat and send `/start`.
2. Forward a few hotel posts first to test the parser.
3. Forward the rest of your batch.
4. Send `/status` or press **Status**.
5. Press **Generate JSON**.
6. Choose **دریافت فایل JSON یکپارچه (اختیاری)** for `new_units.json`, and review **گزارش کدهای تکراری و موارد نیازمند بررسی**.

The bot only accepts messages from the numeric user ID in `.env` and only in a private chat.

## What gets extracted

The parser attempts to identify the area, code, bedrooms, capacity, bathrooms, size, and known services from the Persian caption. It preserves the cleaned caption as `description`, creates a short description, and uses image paths like `/images/units/431-1.jpg`. It does not download Telegram photos; save each photo to its generated path yourself.

If the caption has no labelled code, the bot generates a numeric code. Duplicate codes already in `units.json` or repeated in the imported batch are excluded from the safe output and listed in the warning report.

## Existing Nuxt data

By default duplicate checking uses this folder's `units.json`. To check the real file in your Nuxt project, set `EXISTING_UNITS_FILE` in `.env` to the full path of that file. Example:

```env
EXISTING_UNITS_FILE=/home/your-user/my-nuxt-project/data/units.json
```

Back up your original `units.json` and review the output before replacing anything. This tool intentionally does not write to your Nuxt project.

## Notes

- The parser is rule-based and may miss unusual wording or spellings.
- Unknown area is `""`; unknown bedrooms and size use `0`, bathrooms use `1`, and capacity uses a conservative estimate. These appear in the warning report.
- Telegram limits message length, so the text output may be split into several independent JSON arrays. The downloadable `new_units.json` is the easier option for a batch of around 100 posts.
- The local import queue is saved in `importer_state.json`, so restarting the bot does not erase imported posts.
- After you finish and back up `new_units.json`, stop the process with `Ctrl+C`. You can delete the temporary folder when you no longer need it.
