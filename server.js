import 'dotenv/config';
import express from 'express';
import TelegramBot from 'node-telegram-bot-api';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.dirname(__filename);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const PORT = Number(process.env.PORT || 3000);
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const ALLOWED_USER_ID = (process.env.TELEGRAM_ALLOWED_USER_ID || '').trim();
const AREAS_FILE = path.join(ROOT, 'areas.json');
const SERVICES_FILE = path.join(ROOT, 'services.json');
const EXISTING_UNITS_FILE = process.env.EXISTING_UNITS_FILE
  ? path.resolve(process.env.EXISTING_UNITS_FILE)
  : path.join(ROOT, 'units.json');
const STATE_FILE = path.join(ROOT, 'importer_state.json');
const PRICE_PER_NIGHT = 8000000;
const MAX_TELEGRAM_TEXT = 3900;

if (!TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN in .env.');
if (!/^\d+$/.test(ALLOWED_USER_ID)) {
  throw new Error('Set TELEGRAM_ALLOWED_USER_ID in .env to your numeric Telegram user ID.');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}
const areasData = readJson(AREAS_FILE, []);
const servicesData = readJson(SERVICES_FILE, []);
const serviceSlugs = new Set(servicesData.map((item) => item.slug));
const existingUnits = readJson(EXISTING_UNITS_FILE, []);
const existingCodes = new Set(existingUnits
  .filter((item) => item && typeof item === 'object' && String(item.code ?? '').trim())
  .map((item) => String(item.code).trim()));

const AREA_ALIASES = {
  abadgaran: ['آبادگران', 'برج آبادگران', 'برج‌های آبادگران', 'abadgaran'],
  hashemieh: ['هاشمیه', 'هشمیه', 'hashemieh'],
  'haft-tir': ['هفت تیر', 'هفت‌تیر', 'haft tir', 'haft-tir'],
  daneshjoo: ['دانشجو', 'daneshjoo'],
  daneshamoz: ['دانش آموز', 'دانش‌آموز', 'دانشاموز', 'daneshamoz'],
  serafrazan: ['سرافرازان', 'serafrazan']
};
const SERVICE_KEYWORDS = {
  wifi: ['وای فای', 'وای‌فای', 'اینترنت', 'wifi', 'wi-fi', 'اینترنت پرسرعت'],
  parking: ['پارکینگ', 'پارکینگ اختصاصی', 'پارکینگ مسقف'],
  jacuzzi: ['جکوزی', 'جاکوزی', 'jacuzzi'],
  terrace: ['تراس', 'بالکن', 'روف گاردن', 'روف‌گاردن'],
  yard: ['حیاط اختصاصی', 'حیاط', 'باغچه', 'فضای سبز اختصاصی'],
  kitchen: ['آشپزخانه', 'آشپزخانه مجهز', 'آشپزخانه کامل'],
  tv: ['تلویزیون', 'tv', '۴k', '4k', 'تلویزیون هوشمند'],
  ac: ['کولر', 'اسپیلت', 'اسپلیت', 'سرمایش', 'گرمایش', 'تهویه'],
  billiard: ['بیلیارد', 'میز بیلیارد', 'billiard'],
  ps5: ['ps5', 'پلی استیشن ۵', 'پلی‌استیشن ۵', 'پلی استیشن', 'پلی‌استیشن'],
  sound: ['سیستم صوتی', 'اسپیکر', 'باند', 'سینمای خانگی'],
  sanitized: ['ضدعفونی', 'ضد عفونی', 'نظافت هتلی', 'نظافت حرفه‌ای', 'تمیز و ضدعفونی'],
  elevator: ['آسانسور', 'elevator'],
  washer: ['ماشین لباسشویی', 'لباسشویی']
};
const DIGIT_MAP = new Map([
  ...'۰۱۲۳۴۵۶۷۸۹'.split('').map((d, i) => [d, String(i)]),
  ...'٠١٢٣٤٥٦٧٨٩'.split('').map((d, i) => [d, String(i)])
]);
function normalizeDigits(text = '') {
  return [...String(text)].map((ch) => DIGIT_MAP.get(ch) ?? ch).join('');
}
function cleanText(text = '') {
  return normalizeDigits(text)
    .replace(/\r/g, '\n')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*(?:📞|☎️?|تماس|شماره تماس|ارتباط با ما).*?$/gm, '')
    .replace(/^\s*@[\w_]+\s*$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim().replace(/^[\n\t \-،|]+|[\n\t \-،|]+$/g, '');
}
function slugify(text) {
  return String(text || '').toLowerCase().trim()
    .replace(/[^\w\u0600-\u06FF]+/gu, '-')
    .replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 70) || 'unit';
}
function findArea(text) {
  const folded = text.toLocaleLowerCase();
  for (const [slug, aliases] of Object.entries(AREA_ALIASES)) {
    if (aliases.some((alias) => folded.includes(alias.toLocaleLowerCase()))) return slug;
  }
  return null;
}
function findInt(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const value = Number.parseInt(match[1], 10);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}
function extractCode(text) {
  const patterns = [
    /(?:کد\s*(?:واحد|ملک|اقامت)?|شماره\s*(?:واحد|ملک)|واحد\s*شماره|code|unit\s*(?:no\.?|number)?)\s*[:：#\-]?\s*([0-9]{2,8})/i,
    /#\s*([0-9]{3,8})\b/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}
function extractServices(text) {
  const folded = text.toLocaleLowerCase();
  return Object.entries(SERVICE_KEYWORDS)
    .filter(([slug, words]) => serviceSlugs.has(slug) && words.some((word) => folded.includes(word.toLocaleLowerCase())))
    .map(([slug]) => slug);
}
function extractBedrooms(text) {
  return findInt([/([0-9]{1,2})\s*خوابه/i, /([0-9]{1,2})\s*اتاق\s*خواب/i, /خوابه\s*([0-9]{1,2})/i], text);
}
function extractCapacity(text) {
  return findInt([/ظرفیت\s*[:：\-]?\s*([0-9]{1,2})\s*(?:نفر)?/i, /مناسب\s*(?:برای\s*)?([0-9]{1,2})\s*نفر/i, /([0-9]{1,2})\s*نفره/i], text);
}
function extractBathrooms(text) {
  return findInt([/([0-9]{1,2})\s*حمام/i, /([0-9]{1,2})\s*سرویس\s*بهداشتی/i], text);
}
function extractSize(text) {
  return findInt([/(?:متراژ|زیربنا|مساحت)\s*[:：\-]?\s*([0-9]{2,4})\s*(?:متر|مترمربع|متر مربع)?/i, /([0-9]{2,4})\s*متر\s*(?:مربع)?/i], text);
}
function firstMeaningfulLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^[\W_]+/u, '').trim();
    if (cleaned.length >= 4 && !/(?:تماس|شماره تماس|تلگرام|واتساپ|@)/i.test(cleaned)) return cleaned.slice(0, 100);
  }
  return 'واحد اقامتی';
}
function makeRecord(text, code) {
  const cleaned = cleanText(text);
  const warnings = [];
  const title = firstMeaningfulLine(cleaned);
  const area = findArea(cleaned);
  let bedrooms = extractBedrooms(cleaned);
  let capacity = extractCapacity(cleaned);
  let bathrooms = extractBathrooms(cleaned);
  let size = extractSize(cleaned);
  const services = extractServices(cleaned);

  if (!area) warnings.push('منطقه از کپشن تشخیص داده نشد؛ فیلد area خالی است.');
  if (bedrooms === null) {
    bedrooms = 0;
    warnings.push('تعداد اتاق خواب مشخص نیست؛ bedrooms=0 گذاشته شد.');
  }
  if (capacity === null) {
    capacity = bedrooms > 0 ? bedrooms * 2 : 2;
    warnings.push(`ظرفیت صریح نبود؛ ظرفیت پیشنهادی ${capacity} نفر ثبت شد.`);
  }
  if (bathrooms === null) {
    bathrooms = 1;
    warnings.push('تعداد سرویس/حمام مشخص نیست؛ bathrooms=1 گذاشته شد.');
  }
  if (size === null) {
    size = 0;
    warnings.push('متراژ مشخص نیست؛ sizeM2=0 گذاشته شد.');
  }
  if (!services.length) warnings.push('هیچ‌یک از امکانات شناخته‌شده از کپشن تشخیص داده نشد.');

  const description = cleaned || title;
  let shortDescription = [...description].slice(0, 180).join('').trim();
  if ([...description].length > 180) shortDescription = shortDescription.replace(/\s+\S*$/, '') + '…';
  const tags = services.map((slug) => servicesData.find((item) => item.slug === slug)?.title || slug);
  return {
    record: {
      code: String(code),
      slug: slugify(`${code}-${title}-${area || 'area-unknown'}`),
      title,
      shortDescription,
      description,
      badge: tags[0] || '',
      area: area || '',
      bedrooms,
      capacity,
      bathrooms,
      sizeM2: size,
      pricePerNight: PRICE_PER_NIGHT,
      tags,
      services,
      highlights: tags.slice(0, 5),
      images: title ? [{ src: `/images/units/${code}-1.jpg`, alt: title }] : [],
      featured: false,
      updatedAt: new Date().toISOString().slice(0, 10)
    },
    warnings
  };
}
function loadState() {
  const state = readJson(STATE_FILE, { posts: [], fingerprints: [], next_auto_code: 1 });
  if (!state || typeof state !== 'object') return { posts: [], fingerprints: [], next_auto_code: 1 };
  state.posts ||= [];
  state.fingerprints ||= [];
  state.next_auto_code ||= 1;
  return state;
}
function saveState(state) { writeJson(STATE_FILE, state); }
function nextCode(state) {
  const allCodes = new Set([...existingCodes, ...state.posts.map((post) => String(post.record?.code ?? ''))]);
  const numeric = [...allCodes].filter((code) => /^\d+$/.test(code)).map(Number);
  let n = Math.max(Number(state.next_auto_code || 1), numeric.length ? Math.max(...numeric) + 1 : 1);
  while (allCodes.has(String(n))) n++;
  state.next_auto_code = n + 1;
  return String(n);
}
function fingerprint(message, caption) {
  const originChat = message.forward_from_chat?.id ?? message.forward_origin?.chat?.id ?? '';
  const originMessageId = message.forward_from_message_id ?? message.forward_origin?.message_id ?? '';
  const originId = originChat && originMessageId ? `${originChat}:${originMessageId}` : '';
  const source = originId || crypto.createHash('sha1').update(caption).digest('hex');
  return crypto.createHash('sha1').update(String(source)).digest('hex');
}
function authorized(msg) {
  return Boolean(msg?.from && String(msg.from.id) === ALLOWED_USER_ID && msg.chat?.type === 'private');
}
function mainKeyboard() {
  return { reply_markup: { keyboard: [[{ text: 'Generate JSON' }, { text: 'Status' }]], resize_keyboard: true, is_persistent: true } };
}
function inlineKeyboard() {
  return { reply_markup: { inline_keyboard: [
    [{ text: 'نمایش JSON متنی', callback_data: 'show_json' }],
    [{ text: 'دریافت فایل JSON یکپارچه (اختیاری)', callback_data: 'download_json' }],
    [{ text: 'گزارش کدهای تکراری و موارد نیازمند بررسی', callback_data: 'show_warnings' }]
  ] } };
}
async function ingestMessage(msg) {
  const raw = msg.caption || msg.text || '';
  const cleaned = cleanText(raw);
  if (!cleaned) {
    await bot.sendMessage(msg.chat.id, 'این پیام کپشن/متن قابل پردازش ندارد؛ نادیده گرفته شد.');
    return;
  }
  const state = loadState();
  const fp = fingerprint(msg, cleaned);
  if (state.fingerprints.includes(fp)) {
    await bot.sendMessage(msg.chat.id, 'این پست قبلاً دریافت شده؛ برای جلوگیری از تکرار نادیده گرفته شد.');
    return;
  }
  let code = extractCode(cleaned);
  let codeSource = 'caption';
  if (!code) {
    code = nextCode(state);
    codeSource = 'generated';
  }
  const { record, warnings } = makeRecord(cleaned, code);
  state.posts.push({ fingerprint: fp, message_id: msg.message_id, caption: cleaned, code_source: codeSource, record, warnings });
  state.fingerprints.push(fp);
  saveState(state);
  const note = codeSource === 'caption' ? 'کد از کپشن استخراج شد' : 'کد خودکار ساخته شد چون کدی در کپشن پیدا نشد';
  await bot.sendMessage(msg.chat.id,
    `دریافت شد: ${record.title}\nکد: ${code} (${note})\nبرای ساخت خروجی، هر زمان آماده بودید Generate JSON را بزنید.`,
    mainKeyboard());
}
function collectResults(state) {
  const records = state.posts.map((post) => post.record);
  const counts = new Map();
  for (const record of records) counts.set(String(record.code), (counts.get(String(record.code)) || 0) + 1);
  const duplicates = [];
  for (const [code, count] of counts.entries()) {
    const reasons = [];
    if (existingCodes.has(code)) reasons.push('این کد از قبل در units.json وجود دارد');
    if (count > 1) reasons.push(`این کد بین پست‌های واردشده ${count} بار تکرار شده`);
    if (reasons.length) duplicates.push({ code, reasons });
  }
  const duplicateSet = new Set(duplicates.map((item) => item.code));
  const safeRecords = records.filter((record) => !duplicateSet.has(String(record.code)));
  return { records, safeRecords, duplicates };
}
function chunksByRecord(records) {
  const chunks = [];
  let current = [];
  for (const record of records) {
    const candidate = [...current, record];
    if (JSON.stringify(candidate, null, 2).length > MAX_TELEGRAM_TEXT && current.length) {
      chunks.push(current);
      current = [record];
    } else current = candidate;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
async function sendJsonText(chatId, records) {
  if (!records.length) {
    await bot.sendMessage(chatId, 'هیچ رکورد بدون کد تکراری برای خروجی وجود ندارد.');
    return;
  }
  for (const chunk of chunksByRecord(records)) {
    await bot.sendMessage(chatId, JSON.stringify(chunk, null, 2));
  }
}
async function showWarnings(chatId, state, duplicates) {
  const lines = [];
  if (duplicates.length) {
    lines.push('کدهای تکراری (در خروجی JSON قرار نگرفته‌اند):');
    for (const item of duplicates) lines.push(`- کد ${item.code}: ${item.reasons.join('؛ ')}`);
  } else lines.push('کد تکراری پیدا نشد.');
  lines.push('', 'موارد نیازمند بررسی:');
  for (const post of state.posts) {
    if (post.warnings?.length) lines.push(`- کد ${post.record.code} / ${post.record.title}: ${post.warnings.join('؛ ')}`);
  }
  const text = lines.join('\n');
  for (let i = 0; i < text.length; i += MAX_TELEGRAM_TEXT) {
    await bot.sendMessage(chatId, text.slice(i, i + MAX_TELEGRAM_TEXT));
  }
}

app.get('/', (_req, res) => res.type('text').send('Telegram Nuxt importer is running.'));
app.get('/health', (_req, res) => res.json({ ok: true, service: 'telegram-nuxt-importer-express' }));
app.get('/status', (_req, res) => {
  const state = loadState();
  res.json({ ok: true, importedPosts: state.posts.length, existingUnitCodes: existingCodes.size });
});
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Express health server listening on http://127.0.0.1:${PORT}`);
});

const bot = new TelegramBot(TOKEN, { polling: true });
bot.on('polling_error', (error) => console.error('Telegram polling error:', error.message));

bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  if (!authorized(msg)) {
    if (msg.chat?.type === 'private') await bot.sendMessage(msg.chat.id, 'This importer is private and not enabled for this account.');
    return;
  }
  await bot.sendMessage(msg.chat.id,
    'سلام! پست‌های هتل/آپارتمان را به همین گفت‌وگوی خصوصی فوروارد کنید.\n\n' +
    'من فقط متن کپشن را با قواعد ساده بررسی می‌کنم؛ از هوش مصنوعی یا API پولی استفاده نمی‌شود.\n' +
    'وقتی تمام پست‌ها را فرستادید، دکمه Generate JSON را بزنید.\n\n' +
    'قیمت همه موارد 8000000 است. کدهای تکراری یا موارد نیازمند بررسی گزارش می‌شوند.',
    mainKeyboard());
});
bot.onText(/^\/status(?:@\w+)?$/, async (msg) => {
  if (!authorized(msg)) return;
  const state = loadState();
  await bot.sendMessage(msg.chat.id, `پست‌های ذخیره‌شده: ${state.posts.length}\nکدهای موجود در units.json: ${existingCodes.size}`, mainKeyboard());
});
bot.onText(/^\/generate(?:@\w+)?$/, async (msg) => {
  if (!authorized(msg)) return;
  await generateMenu(msg.chat.id);
});
async function generateMenu(chatId) {
  const state = loadState();
  if (!state.posts.length) {
    await bot.sendMessage(chatId, 'هنوز پستی دریافت نشده است. ابتدا پست‌ها را فوروارد کنید.');
    return;
  }
  await bot.sendMessage(chatId, `${state.posts.length} پست آماده بررسی است. کدام خروجی را می‌خواهید؟`, inlineKeyboard());
}
bot.on('callback_query', async (query) => {
  const msg = query.message;
  if (!msg || !query.from || String(query.from.id) !== ALLOWED_USER_ID || msg.chat?.type !== 'private') {
    await bot.answerCallbackQuery(query.id, { text: 'Not authorized', show_alert: true });
    return;
  }
  await bot.answerCallbackQuery(query.id);
  const state = loadState();
  const { records, safeRecords, duplicates } = collectResults(state);
  if (query.data === 'show_json') {
    await bot.sendMessage(msg.chat.id,
      `تعداد رکوردهای امن برای کپی: ${safeRecords.length}\n` +
      `موارد حذف‌شده از خروجی به‌دلیل کد تکراری: ${records.length - safeRecords.length}\n` +
      'به‌دلیل محدودیت طول پیام تلگرام، JSON در چند بخش ارسال می‌شود. هر بخش یک آرایه JSON مستقل است؛ ' +
      'برای ساخت units.json نهایی، اشیای بخش‌ها را داخل یک آرایه واحد قرار دهید.');
    await sendJsonText(msg.chat.id, safeRecords);
  } else if (query.data === 'download_json') {
    const json = JSON.stringify(safeRecords, null, 2);
    await bot.sendDocument(msg.chat.id, Buffer.from(json, 'utf8'), {}, { filename: 'new_units.json', contentType: 'application/json' });
    await bot.sendMessage(msg.chat.id, `رکوردهای جدید بدون کد تکراری: ${safeRecords.length}. پیش از جایگزینی، گزارش هشدارها را بررسی کنید.`);
  } else if (query.data === 'show_warnings') {
    await showWarnings(msg.chat.id, state, duplicates);
  }
});
bot.on('message', async (msg) => {
  if (!authorized(msg)) return;
  const text = (msg.text || '').trim();
  if (text.startsWith('/')) return; // commands are handled above
  if (text === 'Generate JSON') {
    await generateMenu(msg.chat.id);
    return;
  }
  if (text === 'Status') {
    const state = loadState();
    await bot.sendMessage(msg.chat.id, `پست‌های ذخیره‌شده: ${state.posts.length}\nکدهای موجود در units.json: ${existingCodes.size}`, mainKeyboard());
    return;
  }
  // Ignore callback-only updates and other non-content messages.
  if (msg.text || msg.caption) await ingestMessage(msg);
});

process.on('SIGINT', async () => {
  console.log('Stopping Telegram polling...');
  try { await bot.stopPolling(); } catch {}
  process.exit(0);
});
