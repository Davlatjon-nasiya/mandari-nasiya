'use strict';
/*
  Kanal orqali avtomatik telefon qo‘shish.
  Admin paneldan kanal ID qo‘shiladi → botni kanalga admin qilasiz →
  kanalga rasm + izoh (model, narx) joylansa, bot uni katalogga o‘zi qo‘shadi.
*/
const fs = require('fs');
const path = require('path');

/* ---------- Post matnini tahlil qilish ---------- */
const APOS = "['\\u2018\\u2019\\u02bb\\u02bc\\u0060\\u00b4]";
const NUM = '(\\d{1,3}(?:[ \\u00a0.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?)';
const RE_USD = new RegExp('(?:\\$\\s*' + NUM + '|' + NUM + '\\s*(?:\\$|usd(?![a-z])|dollar|доллар|у\\.?\\s?е))', 'iu');
const RE_MLN = new RegExp(NUM + '\\s*(?:mln|млн|million|миллион)', 'iu');
const RE_UZS = new RegExp(NUM + '\\s*(?:so' + APOS + '?m(?![a-z])|сўм|сум|uzs|som(?![a-z]))', 'iu');
const RE_KEY = new RegExp('(?:narx\\w*|bahosi|baho|цена|price|баҳо|💰|💵|💲)\\s*[:=–—-]?\\s*' + NUM, 'iu');
const RE_ANY = new RegExp(NUM, 'gu');
const RE_STOCK1 = /(?:soni|qoldiq|omborda|mavjud|в наличии|количество|qty|stock)\s*[:=-]?\s*(\d{1,3})/iu;
const RE_STOCK2 = /(\d{1,3})\s*(?:ta|dona|шт|pcs)(?![a-zа-я])/iu;
const RE_TAG = /#([\p{L}\p{N}_]+)/u;
const RE_TAGS = /#[\p{L}\p{N}_]+/gu;
const EMOJI = /[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu;
const RE_PKEY = /(?:narx\w*|bahosi|baho|цена|price)\s*[:=–—-]?/giu;

function toNum(s) {
  s = String(s).replace(/\u00a0/g, ' ').trim();
  if (/^\d{1,3}([ .,]\d{3})+$/.test(s)) return Number(s.replace(/[ .,]/g, ''));
  const m = s.match(/^(\d{1,3}(?:[ .,]\d{3})*)[.,](\d{1,2})$/);
  if (m) return Number(m[1].replace(/[ .,]/g, '') + '.' + m[2]);
  return Number(s.replace(/\s/g, '').replace(',', '.'));
}

function findPrice(text) {
  let m;
  if ((m = RE_USD.exec(text))) { const v = toNum(m[1] || m[2]); if (v > 0) return { value: v, usd: true, raw: m[0] }; }
  if ((m = RE_MLN.exec(text))) { const v = Math.round(toNum(m[1]) * 1e6); if (v > 0) return { value: v, usd: false, raw: m[0] }; }
  if ((m = RE_UZS.exec(text))) { const v = Math.round(toNum(m[1])); if (v > 0) return { value: v, usd: false, raw: m[0] }; }
  if ((m = RE_KEY.exec(text))) {
    const v = toNum(m[1]);
    if (v > 0) return v < 10000 ? { value: v, usd: true, assumed: true, raw: m[0] } : { value: Math.round(v), usd: false, raw: m[0] };
  }
  let best = null;
  RE_ANY.lastIndex = 0;
  while ((m = RE_ANY.exec(text))) { const v = toNum(m[1]); if (v >= 100000 && (!best || v > best.value)) best = { value: Math.round(v), usd: false, raw: m[0] }; }
  return best;
}

function cleanName(s) {
  return String(s).replace(EMOJI, '').replace(RE_TAGS, '')
    .replace(/^\s*(model|nomi|название|name)\s*[:–-]\s*/iu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:|·•*_.,]+|[\s\-–—:|·•*_.,]+$/g, '').trim();
}

function detectCategory(text, name) {
  const s = (String(text || '') + ' ' + String(name || '')).toLowerCase()
    .replace(/[ʻ’‘`´]/g, "'").replace(/ё/g, 'е');
  if (/iphone|айфон|айфон|\bip\s*\d{1,2}\b/.test(s)) return 'iPhone';
  if (/samsung|самсунг|галакси|\bgalaxy\b/.test(s)) return 'Samsung';
  if (/naushnik|наушник|quloqchin|airpods|earbuds|headphone|headset|power\s?bank|пауэрбанк|повербанк|zaryadk|зарядк|adapter|адаптер|kabel|кабель|chexol|чехол|case\b|himoya\s?oyna|защитн.*стекл|steklo|glass|watch|soat|часы|kolonka|колонк|speaker|sichqoncha|мыш|klaviatura|клавиатура|aksessuar|аксессуар/.test(s)) return 'Aksessuarlar';
  return '';
}

function parsePost(text) {
  text = String(text || '');
  const price = findPrice(text);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const strip = l => { let c = l; if (price && c.includes(price.raw)) c = c.replace(price.raw, ' '); return cleanName(c.replace(RE_PKEY, ' ')); };
  let nameIdx = -1, name = '';
  for (let i = 0; i < lines.length; i++) {
    const c = strip(lines[i]);
    if (c.length >= 2 && /\p{L}/u.test(c)) { nameIdx = i; name = c.slice(0, 100); break; }
  }
  const desc = [];
  lines.forEach((l, i) => {
    if (i === nameIdx) return;
    const d = l.replace(RE_TAGS, '').replace(/\s+/g, ' ').trim();
    if (!d || /^(?:soni|qoldiq|omborda|mavjud|в наличии|количество|qty|stock)\s*[:=-]?\s*\d{1,3}\s*(?:ta|dona|шт|pcs)?$/iu.test(d)) return;
    if (price && l.includes(price.raw) && !/\p{L}{3,}/u.test(strip(l))) return; // faqat narx yozilgan qator
    desc.push(d);
  });
  const t = RE_TAG.exec(text);
  let category = t ? t[1].replace(/_/g, ' ') : '';
  if (category) category = category.charAt(0).toUpperCase() + category.slice(1);
  let stock = 1;
  const s = RE_STOCK1.exec(text) || RE_STOCK2.exec(text);
  if (s) stock = Math.min(999, Number(s[1]));
  category = detectCategory(text, name) || category;
  return { name, price: price ? price.value : 0, usd: price ? price.usd : false, assumed: Boolean(price && price.assumed), stock, category: category.slice(0, 40), description: desc.join('\n').slice(0, 1000) };
}

/* ---------- Bosh sahifaga admin skriptini ulash ---------- */
function mountUi(app, publicDir) {
  const file = path.join(publicDir, 'index.html');
  app.get(['/', '/index.html'], (req, res, next) => {
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      res.set('Content-Type', 'text/html; charset=utf-8').send(html.replace('</body>', '<script src="/channels.js"></script></body>'));
    });
  });
}

/* ---------- Server qismi ---------- */
let ctx = null, bot = null, me = null, botUsername = '';

function init(c) {
  ctx = c;
  const { app, db, auth, admin } = c;
  db.exec('CREATE TABLE IF NOT EXISTS channel_posts(chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, product_id INTEGER NOT NULL, PRIMARY KEY(chat_id, message_id))');
  app.get('/api/admin/channels', auth, admin, (req, res) => res.json(getChannels().map(x => ({ ...x, imported: db.prepare('SELECT COUNT(*) c FROM channel_posts WHERE chat_id=?').get(x.id).c }))));
  app.post('/api/admin/channels', auth, admin, async (req, res) => {
    if (!bot) return res.status(503).json({ error: 'Bot ulanmagan (BOT_TOKEN va WEBAPP_URL ni tekshiring).' });
    let raw = String((req.body || {}).id || '').trim();
    if (/^\d{6,15}$/.test(raw)) raw = '-100' + raw;
    if (!/^-100\d{5,15}$/.test(raw) && !/^@[A-Za-z][A-Za-z0-9_]{3,31}$/.test(raw)) return res.status(400).json({ error: 'Kanal ID noto‘g‘ri. Masalan: -1001234567890 yoki @kanal_nomi' });
    try {
      const chat = await bot.getChat(raw);
      if (chat.type !== 'channel') return res.status(400).json({ error: 'Bu kanal emas. Faqat Telegram kanali qo‘shiladi.' });
      if (!me) me = await bot.getMe();
      const mem = await bot.getChatMember(chat.id, me.id);
      if (!['administrator', 'creator'].includes(mem.status)) return res.status(400).json({ error: 'Bot kanalda admin emas. Avval botni kanalga ADMIN qilib qo‘shing, keyin qayta urining.' });
      const id = String(chat.id), list = getChannels().filter(x => x.id !== id);
      list.push({ id, title: String(chat.title || '').slice(0, 100) });
      c.setSetting('channels', JSON.stringify(list));
      res.json({ ok: true, id, title: chat.title || '' });
    } catch (e) { res.status(400).json({ error: 'Kanal topilmadi yoki bot unga kira olmaydi. Botni kanalga admin qiling va ID ni tekshiring. (' + e.message + ')' }); }
  });
  app.post('/api/admin/channels/buttons', auth, admin, async (req, res) => {
    if (!bot) return res.status(503).json({ error: 'Bot ulanmagan.' });
    const rows = db.prepare('SELECT chat_id, message_id, product_id FROM channel_posts ORDER BY chat_id, message_id').all();
    let added = 0, failed = 0;
    for (const row of rows) {
      try {
        if (await addOrderButton(row.chat_id, row.message_id, row.product_id)) added++; else failed++;
      } catch (_) { failed++; }
    }
    res.json({ ok: true, total: rows.length, added, failed });
  });
  app.delete('/api/admin/channels/:id', auth, admin, (req, res) => {
    const id = String(req.params.id);
    c.setSetting('channels', JSON.stringify(getChannels().filter(x => x.id !== id)));
    res.json({ ok: true });
  });
}

function getChannels() {
  try { const a = JSON.parse(ctx.getSetting('channels', '[]')); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}

function attachBot(b) {
  bot = b;
  b.getMe().then(u => { botUsername = u.username || ''; }).catch(() => {});
  bot.on('channel_post', m => onPost(m, false));
  bot.on('edited_channel_post', m => onPost(m, true));
  bot.on('callback_query', q => { // adminga kelgan xabardagi “Yashirish / Ko‘rsatish” tugmasi
    const mt = /^cp:(hide|show):(\d+)$/.exec(q.data || '');
    if (!mt) return;
    if (!ctx.adminIds().includes(String(q.from.id))) return bot.answerCallbackQuery(q.id, { text: 'Bu tugma faqat adminlar uchun.', show_alert: true }).catch(() => {});
    const id = Number(mt[2]), on = mt[1] === 'show' ? 1 : 0;
    ctx.db.prepare('UPDATE products SET active=? WHERE id=?').run(on, id);
    try { ctx.db.prepare('INSERT INTO audit(actor,role,text) VALUES(?,?,?)').run((q.from.first_name || '') + ' (' + q.from.id + ')', 'bot', 'Telefon #' + id + (on ? ' ko‘rsatildi' : ' yashirildi') + ' (kanal importi)'); } catch (_) {}
    bot.answerCallbackQuery(q.id, { text: on ? 'Katalogda ko‘rinadi' : 'Katalogdan yashirildi' }).catch(() => {});
    if (q.message) bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: on ? '🙈 Yashirish' : '👁 Ko‘rsatish', callback_data: 'cp:' + (on ? 'hide' : 'show') + ':' + id }]] }, { chat_id: q.message.chat.id, message_id: q.message.message_id }).catch(() => {});
    ctx.scheduleBackup();
  });
}

const groups = new Map(); // albom (bir nechta rasm) postlarini yig‘ish
async function addOrderButton(chatId, messageId, productId) {
  if (!bot) return;
  try {
    if (!botUsername) botUsername = (await bot.getMe()).username || '';
    if (!botUsername) return;
    const url = 'https://t.me/' + botUsername + '?start=p' + productId;
    await bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text: '🛒 Sotib olish / Buyurtma berish', url }]] },
      { chat_id: chatId, message_id: messageId }
    );
    return true;
  } catch (e) { console.error('Order button:', e.message); return false; }
}

function onPost(m, edited) {
  try {
    const cid = String(m.chat.id);
    if (!edited && m.text && /^\/id(@\w+)?\s*$/.test(m.text)) {
      bot.sendMessage(m.chat.id, '🆔 Kanal ID: ' + cid + '\nUni admin panel → 📢 Kanal bo‘limiga kiriting. (Bu xabarni keyin o‘chirib tashlashingiz mumkin.)').catch(() => {});
      return;
    }
    if (!getChannels().some(x => x.id === cid) || (!(m.caption || m.text) && (!m.photo || !m.photo.length))) return;
    if (!m.media_group_id) return void importPosts([m], edited).catch(e => console.error('Channel:', e.message));
    const key = cid + ':' + m.media_group_id;
    let g = groups.get(key);
    if (!g) { g = { msgs: [] }; groups.set(key, g); }
    g.msgs.push(m);
    clearTimeout(g.t);
    g.t = setTimeout(() => { groups.delete(key); importPosts(g.msgs, edited).catch(e => console.error('Channel:', e.message)); }, 2500);
  } catch (e) { console.error('Channel:', e.message); }
}

async function saveImage(sizes) {
  const arr = [...sizes].sort((a, b) => (a.file_size || a.width * a.height) - (b.file_size || b.width * b.height));
  for (let i = arr.length - 1; i >= 0; i--) {
    const s = arr[i];
    if (s.file_size && s.file_size > 675000) continue;
    try {
      const res = await fetch(await bot.getFileLink(s.file_id));
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 675000 || buf[0] !== 0xff) continue; // faqat JPEG va 650 KB gacha
      return '/img/' + ctx.db.prepare('INSERT INTO images(data) VALUES(?)').run(buf.toString('base64')).lastInsertRowid;
    } catch (e) { console.error('Channel image:', e.message); }
  }
  return '';
}

async function importPosts(msgs, edited) {
  const { db } = ctx;
  msgs.sort((a, b) => a.message_id - b.message_id);
  const anchor = msgs.find(x => (x.caption || x.text || '').trim()) || msgs[0], cid = String(anchor.chat.id), text = (anchor.caption || anchor.text || '').trim();
  if (!text) return; // izohsiz rasm — e’tiborga olinmaydi
  const tell = (t, kb) => ctx.adminIds().forEach(a => bot.sendMessage(a, t, { disable_web_page_preview: true, ...(kb ? { reply_markup: kb } : {}) }).catch(() => {}));
  const mapped = db.prepare('SELECT product_id FROM channel_posts WHERE chat_id=? AND message_id=?').get(cid, anchor.message_id);
  if (mapped && !edited) return;
  const p = parsePost(text), head = '«' + text.split('\n')[0].slice(0, 60) + '»';
  if (!p.name) return tell('⚠️ Kanal posti katalogga qo‘shilmadi: model nomi topilmadi.\n' + head + '\nPostni tahrirlab, birinchi qatorga model nomini yozing.');
  if (!p.price) return tell('⚠️ Kanal posti katalogga qo‘shilmadi: narx topilmadi.\n' + head + '\nPostni tahrirlang: «Narxi: 5 500 000 so‘m» yoki «$450» deb yozing — bot qayta o‘qiydi.');
  const usd = p.usd;
  if (usd && !ctx.usdRate()) return tell('⚠️ ' + head + ' narxi dollarda, lekin dollar kursi kiritilmagan.\nAdmin panel → Sozlamalar → Dollar kursi ni kiriting, so‘ng postni qayta tahrirlang.');
  if (usd ? !ctx.usdOk(p.price) : (!Number.isSafeInteger(p.price) || p.price < 1000)) return tell('⚠️ ' + head + ': narx noto‘g‘ri o‘qildi. Postni tahrirlab, narxni aniq yozing.');
  const price = usd ? ctx.toUzs(p.price) : p.price;
  const warn = p.assumed ? '\n⚠️ Valyuta yozilmagan — dollar deb qabul qilindi. Aniq bo‘lishi uchun postga $ yoki so‘m deb yozing.' : '';
  const priceTxt = (usd ? '$' + p.price + ' ≈ ' : '') + ctx.money(price);

  const prod = mapped && db.prepare('SELECT * FROM products WHERE id=?').get(mapped.product_id);
  if (prod) { // post tahrirlangan — mavjud telefonni yangilaymiz (rasm va holat o‘zgarmaydi)
    let hasVar = false; try { hasVar = JSON.parse(prod.variants || '[]').length > 0; } catch (_) {}
    if (hasVar) db.prepare('UPDATE products SET name=?, description=?, category=? WHERE id=?').run(p.name, p.description, p.category || prod.category, prod.id);
    else {
      db.prepare("UPDATE products SET name=?, price=?, stock=?, description=?, category=?, price_usd=?, old_price=0, old_price_usd=0, sale_until='' WHERE id=?").run(p.name, price, p.stock, p.description, p.category || prod.category, usd ? p.price : 0, prod.id);
      ctx.productHooks(prod, { id: prod.id, name: p.name, price, stock: p.stock });
    }
    ctx.scheduleBackup();
    await addOrderButton(cid, anchor.message_id, prod.id);
    return tell('♻️ Kanal posti tahrirlandi — katalog yangilandi\n📱 ' + p.name + '\n💰 ' + priceTxt + '\n📦 Soni: ' + p.stock + warn, { inline_keyboard: [[{ text: prod.active ? '🙈 Yashirish' : '👁 Ko‘rsatish', callback_data: 'cp:' + (prod.active ? 'hide' : 'show') + ':' + prod.id }]] });
  }

  const imgs = [];
  for (const m of msgs.slice(0, 6)) { if (!m.photo || !m.photo.length) continue; const u = await saveImage(m.photo); if (u) imgs.push(u); }
  const r = db.prepare('INSERT INTO products(name,price,stock,image,images,description,category,variants,old_price,sale_until,price_usd,old_price_usd) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(p.name, price, p.stock, imgs[0] || '', JSON.stringify(imgs), p.description, p.category, '[]', 0, '', usd ? p.price : 0, 0);
  db.prepare('INSERT OR REPLACE INTO channel_posts(chat_id,message_id,product_id) VALUES(?,?,?)').run(cid, anchor.message_id, r.lastInsertRowid);
  const orderButtonAdded = await addOrderButton(cid, anchor.message_id, r.lastInsertRowid);
  ctx.scheduleBackup();
  tell('✅ Kanaldan yangi telefon katalogga qo‘shildi\n📱 ' + p.name + '\n💰 ' + priceTxt + '\n📦 Soni: ' + p.stock + (p.category ? '\n🗂 ' + p.category : '') + '\n🖼 Rasm: ' + imgs.length + (imgs.length ? '' : ' (yuklab bo‘lmadi)') + warn + '\n🛒 Sotib olish tugmasi: ' + (orderButtonAdded ? 'qo‘shildi' : 'qo‘shilmadi — botga kanalda xabarlarni tahrirlash huquqini bering va Admin panel → Kanal → Tugmalarni qo‘shish ni bosing.') + '\n\nNoto‘g‘ri bo‘lsa, postni tahrirlang yoki shu yerdan yashiring.',
    { inline_keyboard: [[{ text: '🙈 Yashirish', callback_data: 'cp:hide:' + r.lastInsertRowid }]] });
}

module.exports = { parsePost, mountUi, init, attachBot };
