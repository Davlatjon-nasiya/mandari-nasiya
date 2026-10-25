require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use('/api/admin/upload', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '30kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- Database ---------- */
const db = new Database(process.env.DB_PATH || path.join(__dirname, 'mandarin.db'));
if (!process.env.DB_PATH) console.warn('⚠️ DB_PATH sozlanmagan: baza vaqtinchalik diskda. Doimiy disk ulang va DB_PATH=/data/mandarin.db qo‘ying (Telegram zaxirasi himoya qiladi).');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK(price > 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
  image TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS applications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL,
  customer TEXT NOT NULL,
  phone TEXT NOT NULL,
  product_id INTEGER NOT NULL,
  months INTEGER NOT NULL,
  down INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
// migratsiyalar (eski bazani buzmaydi)
const appCols = db.prepare('PRAGMA table_info(applications)').all().map(c => c.name);
if (!appCols.includes('stock_taken')) db.exec('ALTER TABLE applications ADD COLUMN stock_taken INTEGER NOT NULL DEFAULT 0');
const prodCols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name);
if (!prodCols.includes('description')) db.exec("ALTER TABLE products ADD COLUMN description TEXT NOT NULL DEFAULT ''");
if (!prodCols.includes('category')) db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT ''");
if (!prodCols.includes('images')) db.exec("ALTER TABLE products ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
if (!appCols.includes('total')) db.exec('ALTER TABLE applications ADD COLUMN total INTEGER NOT NULL DEFAULT 0');
if (!appCols.includes('monthly')) db.exec('ALTER TABLE applications ADD COLUMN monthly INTEGER NOT NULL DEFAULT 0');
db.exec('CREATE TABLE IF NOT EXISTS images(id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL)');
db.exec(`
CREATE TABLE IF NOT EXISTS users(telegram_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', last_remind TEXT NOT NULL DEFAULT '', blocked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS favorites(telegram_id TEXT NOT NULL, product_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(telegram_id, product_id));
CREATE TABLE IF NOT EXISTS support_msgs(admin_chat TEXT NOT NULL, admin_msg INTEGER NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY(admin_chat, admin_msg));
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT DEFAULT CURRENT_TIMESTAMP, actor TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, app_id INTEGER NOT NULL, amount INTEGER NOT NULL, paid_at TEXT DEFAULT CURRENT_TIMESTAMP, note TEXT NOT NULL DEFAULT '', taker TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS notify_me(telegram_id TEXT NOT NULL, product_id INTEGER NOT NULL, PRIMARY KEY(telegram_id, product_id));
`);
for (const [c, d] of [['pay_type', "'installment'"], ['passport_enc', "''"], ['card_enc', "''"], ['card_last4', "''"], ['card_phone', "''"], ['consent_at', "''"], ['approved_at', "''"], ['last_pay_remind', "''"]])
  if (!appCols.includes(c)) db.exec('ALTER TABLE applications ADD COLUMN ' + c + ' TEXT NOT NULL DEFAULT ' + d);
if (!appCols.includes('note')) db.exec("ALTER TABLE applications ADD COLUMN note TEXT NOT NULL DEFAULT ''");
db.exec("UPDATE applications SET passport_enc='', card_enc='', card_last4='', card_phone='' WHERE passport_enc!='' OR card_enc!=''"); // pasport/karta ma’lumotlari endi yig‘ilmaydi — eskilari o‘chiriladi

const getSetting = (k, d = '') => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('markup')) setSetting('markup', '50');

const TERMS = [3, 6, 12, 18, 24];
const markupFor = m => { try { const o = JSON.parse(getSetting('markups', '{}')); if (o[m] !== undefined && Number.isFinite(Number(o[m]))) return Number(o[m]); } catch (_) {} return Number(getSetting('markup', '50')); };
const colsOf = t => db.prepare('PRAGMA table_info(' + t + ')').all().map(c => c.name);
for (const [t, c, d] of [['products', 'variants', "TEXT NOT NULL DEFAULT '[]'"], ['products', 'old_price', 'INTEGER NOT NULL DEFAULT 0'], ['products', 'sale_until', "TEXT NOT NULL DEFAULT ''"], ['applications', 'variant', "TEXT NOT NULL DEFAULT ''"], ['applications', 'trade_model', "TEXT NOT NULL DEFAULT ''"], ['applications', 'trade_value', 'INTEGER NOT NULL DEFAULT 0'], ['applications', 'promo', "TEXT NOT NULL DEFAULT ''"], ['users', 'note', "TEXT NOT NULL DEFAULT ''"], ['users', 'risky', 'INTEGER NOT NULL DEFAULT 0'], ['applications', 'delivery', "TEXT NOT NULL DEFAULT 'pickup'"], ['applications', 'branch', "TEXT NOT NULL DEFAULT ''"], ['applications', 'address', "TEXT NOT NULL DEFAULT ''"], ['applications', 'geo', "TEXT NOT NULL DEFAULT ''"], ['applications', 'contract_sent', "TEXT NOT NULL DEFAULT ''"], ['applications', 'last_overdue_remind', "TEXT NOT NULL DEFAULT ''"]])
  if (!colsOf(t).includes(c)) db.exec('ALTER TABLE ' + t + ' ADD COLUMN ' + c + ' ' + d);
const getBranches = () => getSetting('branches').split('\n').map(l => l.split('|').map(x => x.trim())).filter(x => x[0]).map(x => ({ name: x[0], address: x[1] || '', phone: x[2] || '' }));
const getBanners = () => { try { return JSON.parse(getSetting('banners', '[]')); } catch (_) { return []; } };
const markupsMap = () => Object.fromEntries(TERMS.map(t => [t, markupFor(t)]));
const shape = p => {
  let im = [], vs = [];
  try { im = JSON.parse(p.images || '[]'); } catch (_) {} try { vs = JSON.parse(p.variants || '[]'); } catch (_) {}
  if (!im.length && p.image) im = [p.image];
  let out = { ...p, images: im, variants: vs };
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  if (p.old_price > 0 && p.sale_until && p.sale_until < today) out = { ...out, price: p.old_price, old_price: 0, sale_until: '' }; // aksiya tugagan
  return out;
};
const dataKey = crypto.createHash('sha256').update(process.env.DATA_KEY || ('mandarin|' + (process.env.BOT_TOKEN || 'local'))).digest();
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', dataKey, iv), e = Buffer.concat([c.update(String(t), 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(x => x.toString('base64')).join('.'); };
const dec = v => { try { const [iv, tag, e] = String(v).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', dataKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); } catch (_) { return ''; } };
const normPass = v => String(v || '').toUpperCase().replace(/[АВСЕКМНОРТХУ]/g, c => ({ 'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X', 'У': 'Y' })[c]).replace(/[^A-Z0-9]/g, '').slice(0, 12);
const passOk = s => /^[A-Z0-9]{7,12}$/.test(s) && (s.match(/\d/g) || []).length >= 6;
const luhn = n => { let x = 0, a = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (a) { d *= 2; if (d > 9) d -= 9; } x += d; a = !a; } return x % 10 === 0; };
const STATUSES = ['new', 'review', 'approved', 'preparing', 'shipping', 'delivered', 'rejected'];
const STATUS_UZ = { new: 'Yangi', review: 'Ko‘rib chiqilmoqda', approved: 'Tasdiqlandi', preparing: 'Tayyorlanmoqda', shipping: 'Yo‘lda', delivered: 'Topshirildi', rejected: 'Rad etildi' };
const PHONE_RE = /^[+\d\s()-]{9,20}$/;

const adminIds = () => (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};

/* ---------- Auth ---------- */
function verifyTelegram(raw) {
  if (!process.env.BOT_TOKEN || !raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculated = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (!safeEqual(hash.toLowerCase(), calculated)) return null;
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) { return null; }
}
const adminSecret = () => String(process.env.ADMIN_PASSWORD) + '|' + (process.env.BOT_TOKEN || 'mandarin-admin');
function webAdminToken(exp) {
  return String(exp) + '.' + crypto.createHmac('sha256', adminSecret()).update(String(exp)).digest('hex');
}
function validWebAdmin(token) {
  if (!process.env.ADMIN_PASSWORD || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 13 * 60 * 60 * 1000) return false;
  return safeEqual(parts[1], webAdminToken(exp).split('.')[1]);
}
const bearerOf = req => (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
function auth(req, res, next) {
  const user = verifyTelegram(req.get('X-Telegram-Init-Data'));
  if (user) {
    req.user = user; req.authType = 'telegram';
    try { db.prepare('INSERT INTO users(telegram_id,name,username) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET name=excluded.name, username=excluded.username').run(String(user.id), String(user.first_name || '').slice(0, 80), String(user.username || '').slice(0, 40)); } catch (_) {}
    return next();
  }
  if (validWebAdmin(bearerOf(req))) { req.user = { id: 'web-admin' }; req.authType = 'web'; return next(); }
  return res.status(401).json({ error: 'Telegram ichidan oching yoki admin sifatida kiring.' });
}
function admin(req, res, next) {
  if (req.authType === 'web' && validWebAdmin(bearerOf(req))) return next();
  if (req.authType === 'telegram' && adminIds().includes(String(req.user.id))) return next();
  return res.status(403).json({ error: 'Admin huquqi yo‘q.' });
}

const staffIds = () => [...adminIds(), ...(process.env.MANAGER_IDS || '').split(',').map(x => x.trim()).filter(Boolean)];
const roleOf = req => req.authType === 'web' ? 'admin' : adminIds().includes(String(req.user && req.user.id)) ? 'admin' : staffIds().includes(String(req.user && req.user.id)) ? 'manager' : '';
function staff(req, res, next) { if (req.authType === 'telegram' && staffIds().includes(String(req.user.id))) return next(); return admin(req, res, next); }
// parol tanlashdan himoya: 15 daqiqada 8 ta urinish
const attempts = new Map();
function loginLimit(req, res, next) {
  const ip = req.ip, now = Date.now(), a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 8) return res.status(429).json({ error: 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urining.' });
  a.n++; attempts.set(ip, a); req.attempt = a; next();
}

/* ---------- Telegram bot (xabarnomalar uchun) ---------- */
let bot = null, botUser = '';
const notify = (chatId, text) => { if (bot && chatId && /^\d+$/.test(String(chatId))) bot.sendMessage(chatId, text).catch(e => console.error('Notify:', e.message)); };
const money = n => Number(n).toLocaleString('ru-RU') + ' so‘m';

let PDFDocument = null;
try { PDFDocument = require('pdfkit'); } catch (_) { console.warn('pdfkit o‘rnatilmagan — shartnoma PDF yuborilmaydi (package.json ni yangilang).'); }
const CY = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sh', ъ: "'", ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya', ў: "o'", қ: 'q', ғ: "g'", ҳ: 'h' };
const asc = v => String(v == null ? '' : v).replace(/[‘’ʻʼ`´]/g, "'").replace(/[А-Яа-яЁёЎўҚқҒғҲҳ]/g, c => { const l = CY[c.toLowerCase()]; return l === undefined ? '?' : c === c.toLowerCase() ? l : l.charAt(0).toUpperCase() + l.slice(1); }).replace(/[^\x20-\x7E\n]/g, '');
function makeContract(a) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 }), chunks = [];
    doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const M = n => asc(Number(n).toLocaleString('ru-RU').replace(/\s/g, ' ') + " so'm"), now = new Date(Date.now() + 5 * 3600 * 1000);
    const d2 = d => ('0' + d.getUTCDate()).slice(-2) + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '.' + d.getUTCFullYear();
    const co = asc(getSetting('company') || 'Mandarin Nasiya'), price = a.total + a.down;
    doc.font('Helvetica-Bold').fontSize(16).text('NASIYA SHARTNOMASI № ' + a.id, { align: 'center' }).moveDown(0.3);
    doc.font('Helvetica').fontSize(10).text('Sana: ' + d2(now), { align: 'center' }).moveDown();
    doc.fontSize(11).font('Helvetica-Bold').text('1. Tomonlar').font('Helvetica');
    doc.text('Sotuvchi: ' + co + (getSetting('contact_phone') ? ', tel: ' + asc(getSetting('contact_phone')) : '') + (getSetting('contact_address') ? ', manzil: ' + asc(getSetting('contact_address')) : ''));
    doc.text('Xaridor: ' + asc(a.customer) + ', tel: ' + asc(a.phone) + (a.delivery === 'delivery' ? ', yetkazish manzili: ' + asc(a.address) : ', olib ketish filiali: ' + asc(a.branch || 'dokon'))).moveDown();
    doc.font('Helvetica-Bold').text('2. Shartnoma predmeti va narx').font('Helvetica');
    doc.text('Tovar: ' + asc(a.pname) + (a.variant ? ' (' + asc(a.variant) + ')' : '') + '.');
    doc.text('Boshlangich tolov (avans): ' + M(a.down) + (a.trade_model ? " (shundan eski telefon '" + asc(a.trade_model) + "' ~ " + M(a.trade_value) + ')' : '') + '.');
    doc.text('Muddat: ' + a.months + ' oy. Oylik tolov: ' + M(a.monthly) + '. Nasiya bo\'yicha jami: ' + M(a.total) + '. Umumiy qiymat: ' + M(price) + '.').moveDown();
    doc.font('Helvetica-Bold').text('3. Tolov jadvali').font('Helvetica');
    const st = a.approved_at ? new Date(new Date(a.approved_at.replace(' ', 'T') + 'Z').getTime() + 5 * 3600 * 1000) : now;
    for (let i = 1; i <= a.months; i++) { const x = new Date(Date.UTC(st.getUTCFullYear(), st.getUTCMonth() + i, Math.min(st.getUTCDate(), 28))); doc.text(i + '. ' + d2(x) + ' — ' + M(a.monthly)); }
    doc.moveDown().font('Helvetica-Bold').text('4. Tomonlarning majburiyatlari').font('Helvetica');
    ['Sotuvchi tovarni Xaridorga topshiradi, Xaridor esa tolovlarni yuqoridagi jadval boyicha oz vaqtida amalga oshiradi.',
      'Xaridor tovarni topshirilgan paytdan boshlab saqlash va ehtiyot qilish uchun javobgar.',
      'Tolov kechiktirilgan taqdirda tomonlar kelishuviga muvofiq choralar korilishi mumkin.',
      'Shartnoma shartlari ozgartirilsa, tomonlarning yozma yoki elektron roziligi talab etiladi.'].forEach((t, i) => doc.text('4.' + (i + 1) + '. ' + t));
    doc.moveDown(2).text('Sotuvchi: ______________________            Xaridor: ______________________');
    doc.end();
  });
}
async function sendContract(id, extraTo, onlyIfNew) {
  if (!bot || !PDFDocument) return false;
  const a = db.prepare('SELECT a.*, p.name pname FROM applications a LEFT JOIN products p ON p.id=a.product_id WHERE a.id=?').get(id);
  if (!a || a.pay_type !== 'installment' || (onlyIfNew && a.contract_sent)) return false;
  const buf = await makeContract(a), fo = { filename: 'shartnoma-' + a.id + '.pdf', contentType: 'application/pdf' };
  let ok = false;
  for (const t of (extraTo ? [String(extraTo)] : [a.telegram_id, ...staffIds()])) {
    try { await bot.sendDocument(t, buf, { caption: t === a.telegram_id ? '📄 Nasiya shartnomangiz (#' + a.id + '). Iltimos, o‘qib chiqing.' : '📄 Shartnoma #' + a.id + ' — ' + a.customer }, fo); ok = true; } catch (e) { console.error('Contract:', e.message); }
  }
  if (ok && !extraTo) db.prepare("UPDATE applications SET contract_sent=datetime('now') WHERE id=?").run(id);
  return ok;
}
const audit = (req, text) => { try { const u = req.user || {}; db.prepare('INSERT INTO audit(actor,role,text) VALUES(?,?,?)').run(req.authType === 'web' ? 'Veb-admin' : [u.first_name, u.username ? '@' + u.username : ''].filter(Boolean).join(' ') + ' (' + u.id + ')', roleOf(req), text); } catch (_) {} };
app.use((req, res, next) => { // admin amallari tarixi + tasdiqlanganda shartnoma
  if (req.method !== 'GET' && req.path.startsWith('/api/admin/') && !/\/(login|upload|backup)$/.test(req.path)) res.on('finish', () => {
    if (res.statusCode >= 400 || !req.user) return;
    const b = req.body || {}, m = req.path.match(/\/(applications|products|customers)\/(\d+)/), id = m && m[2];
    let t = req.method + ' ' + req.path;
    if (m && m[1] === 'applications') t = /\/payments$/.test(req.path) ? 'Ariza #' + id + ': to‘lov qabul qilindi ' + money(b.amount) : /\/contract$/.test(req.path) ? 'Ariza #' + id + ': shartnoma yuborildi' : 'Ariza #' + id + ': ' + (STATUS_UZ[b.status] || b.status) + (b.note ? ' · izoh: ' + String(b.note).slice(0, 60) : '');
    else if (m && m[1] === 'products') t = req.method === 'DELETE' ? 'Telefon #' + id + ' o‘chirildi' : 'Telefon #' + id + ' o‘zgartirildi' + (b.name ? ' (' + String(b.name).slice(0, 40) + ')' : '');
    else if (m && m[1] === 'customers') t = 'Mijoz ' + id + ': ' + (b.risky ? 'ishonchsiz' : 'oddiy') + (b.note ? ' · izoh' : '');
    else if (/\/products$/.test(req.path)) t = 'Telefon qo‘shildi: ' + String(b.name || '').slice(0, 40);
    else if (/\/settings$/.test(req.path)) t = 'Sozlamalar o‘zgardi: ' + Object.keys(b).join(', ').slice(0, 80);
    else if (/\/broadcast$/.test(req.path)) t = 'Hammaga xabar yuborildi: ' + String(b.text || '').slice(0, 50);
    else if (/\/export$/.test(req.path)) t = 'CSV yuklab olindi';
    audit(req, t);
    if (m && m[1] === 'applications' && req.method === 'PATCH' && b.status === 'approved') sendContract(Number(id), null, true).catch(e => console.error('Contract:', e.message));
  });
  next();
});
function debtInfo(a) {
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE app_id=?').get(a.id).s, left = Math.max(0, a.total - paid);
  const now = new Date(Date.now() + 5 * 3600 * 1000), st = new Date(new Date(a.approved_at.replace(' ', 'T') + 'Z').getTime() + 5 * 3600 * 1000);
  const dueDate = i => new Date(Date.UTC(st.getUTCFullYear(), st.getUTCMonth() + i, Math.min(st.getUTCDate(), 28)));
  let n = 0; while (n < a.months && dueDate(n + 1) <= now) n++;
  const overdue = Math.max(0, Math.min(a.total, n * a.monthly) - paid), kd = dueDate(Math.min(a.months, Math.floor(paid / a.monthly) + 1));
  const f = d => ('0' + d.getUTCDate()).slice(-2) + '.' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '.' + d.getUTCFullYear();
  return { paid, left, overdue, days: overdue > 0 ? Math.max(1, Math.floor((now - kd) / 864e5)) : 0, next: left > 0 ? f(kd) : '' };
}
const payInfo = a => { if (a.pay_type !== 'installment' || !a.approved_at || !a.months || !a.monthly) return {}; const d = debtInfo(a); return { paid: d.paid, left: d.left, overdue: d.overdue, od_days: d.days, next_due: d.next }; };
function notifyAll(ids, text) { if (bot) (async () => { for (const id of ids) { await sendUser(id, text, appBtn()); await new Promise(r => setTimeout(r, 70)); } })(); }
function productHooks(prev, now) { // telefon qaytdi / narx tushdi xabarlari
  if (!bot) return;
  if (prev.stock < 1 && now.stock > 0) {
    const ids = db.prepare('SELECT telegram_id id FROM notify_me WHERE product_id=?').all(now.id).map(r => r.id);
    db.prepare('DELETE FROM notify_me WHERE product_id=?').run(now.id);
    notifyAll(ids, '🔔 ' + now.name + ' omborga keldi!\n' + money(now.price) + ' dan.');
  }
  if (now.price < prev.price) {
    const ids = db.prepare('SELECT telegram_id id FROM favorites WHERE product_id=?').all(now.id).map(r => r.id).slice(0, 300);
    notifyAll(ids, '📉 Narx tushdi!\n📱 ' + now.name + '\n' + money(prev.price) + ' → ' + money(now.price) + '\n12 oy: ' + money(Math.ceil(now.price * (1 + markupFor(12) / 100) / 12)) + '/oy');
  }
}
async function runOverdue() { // muddati o‘tgan to‘lov eslatmasi (3 kunda bir marta)
  const t = new Date(Date.now() + 5 * 3600 * 1000);
  if (!bot || t.getUTCHours() < 10 || t.getUTCHours() >= 20) return;
  const today = t.toISOString().slice(0, 10);
  const apps = db.prepare("SELECT * FROM applications WHERE status IN ('approved','preparing','shipping','delivered') AND pay_type='installment' AND months>0 AND approved_at!='' AND (last_overdue_remind='' OR julianday(?)-julianday(last_overdue_remind)>=3)").all(today);
  for (const a of apps) {
    const d = debtInfo(a);
    if (d.overdue <= 0) continue;
    await sendUser(a.telegram_id, '⚠️ To‘lov muddati o‘tgan.\n💳 To‘lashingiz kerak: ' + money(d.overdue) + '\nQolgan jami: ' + money(d.left) + '\nIltimos, imkon qadar tezroq to‘lang yoki biz bilan bog‘laning.');
    db.prepare('UPDATE applications SET last_overdue_remind=? WHERE id=?').run(today, a.id);
    await new Promise(r => setTimeout(r, 80));
  }
}
async function sendUser(id, text, markup) {
  try { await bot.sendMessage(id, text, markup ? { reply_markup: markup } : {}); return true; }
  catch (e) { if (/403|blocked|deactivated|chat not found/i.test(e.message)) db.prepare('UPDATE users SET blocked=1 WHERE telegram_id=?').run(String(id)); return false; }
}
const appBtn = () => ({ inline_keyboard: [[{ text: '📱 Ilovani ochish', web_app: { url: process.env.WEBAPP_URL } }]] });
/* ---------- Zaxira nusxa (Telegram orqali saqlash va tiklash) ---------- */
const makeBackup = () => JSON.stringify({ v: 1, at: new Date().toISOString(), products: db.prepare('SELECT * FROM products').all(), applications: db.prepare('SELECT * FROM applications').all(), settings: db.prepare('SELECT * FROM settings').all(), images: db.prepare('SELECT * FROM images').all(), users: db.prepare('SELECT * FROM users').all(), favorites: db.prepare('SELECT * FROM favorites').all(), payments: db.prepare('SELECT * FROM payments').all(), notify_me: db.prepare('SELECT * FROM notify_me').all() });
const insertRows = (table, rows) => {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
  for (const r of rows) {
    const k = Object.keys(r).filter(x => cols.includes(x));
    if (k.length) db.prepare('INSERT INTO ' + table + '(' + k.join(',') + ') VALUES(' + k.map(() => '?').join(',') + ')').run(...k.map(x => r[x]));
  }
};
const restoreBackup = db.transaction(data => {
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.applications) || !Array.isArray(data.settings)) throw new Error('Zaxira fayli noto‘g‘ri.');
  db.exec('DELETE FROM applications; DELETE FROM products; DELETE FROM settings; DELETE FROM images; DELETE FROM users; DELETE FROM favorites; DELETE FROM payments; DELETE FROM notify_me;');
  insertRows('products', data.products); insertRows('applications', data.applications); insertRows('settings', data.settings); insertRows('images', data.images || []); insertRows('users', data.users || []); insertRows('favorites', data.favorites || []); insertRows('payments', data.payments || []); insertRows('notify_me', data.notify_me || []);
  if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('markup')) setSetting('markup', '50');
});
async function sendBackup() {
  if (!bot || !adminIds().length) return false;
  const buf = Buffer.from(makeBackup());
  const name = 'mandarin-zaxira-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  let ok = false;
  for (const id of adminIds()) {
    try {
      const old = getSetting('bk_' + id);
      if (old) await bot.deleteMessage(id, Number(old)).catch(() => {});
      const m = await bot.sendDocument(id, buf, { caption: '💾 Zaxira nusxa. Ma’lumot yo‘qolsa, bot o‘zi tiklaydi yoki shu faylni botga qayta yuboring.', disable_notification: true }, { filename: name, contentType: 'application/json' });
      setSetting('bk_' + id, m.message_id);
      await bot.pinChatMessage(id, m.message_id, { disable_notification: true }).catch(() => {});
      ok = true;
    } catch (e) { console.error('Backup:', e.message); }
  }
  return ok;
}
let bkTimer = null;
app.use((req, res, next) => { // har o‘zgarishdan 1 daqiqa keyin avtomatik zaxira
  if (req.method !== 'GET' && !/^\/api\/(admin\/(login|backup)|favorites)/.test(req.path)) res.on('finish', () => { if (res.statusCode < 400 && bot) { clearTimeout(bkTimer); bkTimer = setTimeout(sendBackup, 60000); } });
  next();
});

/* ---------- Public API ---------- */
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/config', (_, res) => res.json({ webAdminEnabled: Boolean(process.env.ADMIN_PASSWORD) }));

app.post('/api/admin/login', loginLimit, (req, res) => {
  const password = String(req.body && req.body.password || '');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Render Environment’da ADMIN_PASSWORD sozlanmagan.' });
  if (!safeEqual(password, process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: 'Parol noto‘g‘ri.' });
  req.attempt.n = 0;
  res.json({ token: webAdminToken(Date.now() + 12 * 60 * 60 * 1000), expiresIn: 43200 });
});

app.get('/api/catalog', (_, res) => {
  res.json({
    products: db.prepare('SELECT id,name,price,stock,image,images,description,category,variants,old_price,sale_until FROM products WHERE active=1 ORDER BY id DESC').all().map(shape),
    markups: markupsMap(),
    bot: botUser,
    branches: getBranches(),
    markup: Number(getSetting('markup', '50')),
    terms: TERMS,
    contact: { phone: getSetting('contact_phone'), telegram: getSetting('contact_telegram'), address: getSetting('contact_address'), hours: getSetting('contact_hours'), instagram: getSetting('contact_instagram') },
    promo: getSetting('promo'), banners: getBanners(), info: { installment: getSetting('info_installment'), delivery: getSetting('info_delivery'), about: getSetting('info_about') }
  });
});

app.get('/api/me', (req, res) => {
  const user = verifyTelegram(req.get('X-Telegram-Init-Data'));
  if (!user) return res.status(401).json({ error: 'Telegram ichidan ilovani oching.' });
  res.json({ id: user.id, name: user.first_name || '', admin: staffIds().includes(String(user.id)), role: adminIds().includes(String(user.id)) ? 'admin' : staffIds().includes(String(user.id)) ? 'manager' : '' });
});

const promoFor = code => {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  for (const line of getSetting('promos').split('\n')) {
    const [k, pct, until, max] = line.split('|').map(x => x.trim());
    if (k && k.toUpperCase() === c) {
      const used = db.prepare('SELECT COUNT(*) c FROM applications WHERE promo=?').get(c).c, p = Number(pct);
      if ((until && until < today) || (Number(max) > 0 && used >= Number(max)) || !(p > 0 && p < 100)) return null;
      return { code: c, percent: p };
    }
  }
  return null;
};
app.get('/api/promo', (req, res) => { const r = promoFor(req.query.code); return r ? res.json(r) : res.status(404).json({ error: 'Promokod topilmadi yoki muddati tugagan.' }); });
app.post('/api/applications', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(401).json({ error: 'Ariza yuborish uchun Telegram ichidan oching.' });
  const b = req.body || {}, cash = b.pay_type === 'cash', bad = m => res.status(400).json({ error: m });
  const customer = String(b.customer || '').trim(), phone = String(b.phone || '').trim();
  const raw = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(b.product_id)), p0 = raw && shape(raw);
  if (!p0) return bad('Bu telefon hozir mavjud emas.');
  let price = p0.price, left = p0.stock, variant = '';
  if (p0.variants.length) { const v = p0.variants.find(x => x.name === b.variant); if (!v) return bad('Variantni tanlang.'); price = v.price; left = v.stock; variant = v.name; }
  if (left < 1) return bad('Bu telefon hozir mavjud emas.');
  const pr = promoFor(b.promo);
  if (b.promo && !pr) return bad('Promokod noto‘g‘ri yoki muddati tugagan.');
  if (pr) price = Math.round(price * (1 - pr.percent / 100));
  if (customer.length < 2 || customer.length > 100) return bad('Ism-familiyani to‘g‘ri kiriting.');
  if (!PHONE_RE.test(phone)) return bad('Telefon raqamini to‘g‘ri kiriting. Masalan: +998 90 123 45 67');
  const delivery = b.delivery === 'delivery' ? 'delivery' : 'pickup', brs = getBranches();
  let branch = '', address = String(b.address || '').trim().slice(0, 200), geo = '';
  if (/^-?\d{1,3}(\.\d+)?$/.test(String(b.lat)) && /^-?\d{1,3}(\.\d+)?$/.test(String(b.lng))) geo = b.lat + ',' + b.lng;
  if (delivery === 'pickup') { address = ''; geo = ''; if (brs.length) { const f = brs.find(x => x.name === b.branch); if (!f) return bad('Filialni tanlang.'); branch = f.name; } }
  else if (address.length < 5 && !geo) return bad('Yetkazish uchun manzilni yozing yoki joylashuvingizni yuboring.');
  let months = 0, down = price, total = price, monthly = 0, tradeModel = '', tradeValue = 0;
  if (!cash) {
    months = Number(b.months); tradeValue = Number(b.trade_value || 0); tradeModel = String(b.trade_model || '').trim().slice(0, 80);
    down = Number(b.down || 0) + tradeValue;
    if (!TERMS.includes(months)) return bad('Muddat noto‘g‘ri.');
    if (!Number.isSafeInteger(tradeValue) || tradeValue < 0 || !Number.isSafeInteger(down) || down < 0 || down >= price) return bad('Boshlang‘ich to‘lov (eski telefon bahosi bilan) telefon narxidan kam bo‘lsin.');
    total = Math.ceil((price - down) * (1 + markupFor(months) / 100)); monthly = Math.ceil(total / months);
  }
  const uid = String(req.user.id);
  if (db.prepare("SELECT COUNT(*) c FROM applications WHERE telegram_id=? AND status IN ('new','review')").get(uid).c >= 5) return res.status(429).json({ error: 'Sizda 5 ta ko‘rib chiqilayotgan ariza bor. Javobini kuting.' });
  const dup = db.prepare("SELECT id FROM applications WHERE telegram_id=? AND product_id=? AND variant=? AND status IN ('new','review')").get(uid, p0.id, variant);
  if (dup) return res.status(409).json({ error: 'Bu telefon uchun arizangiz allaqachon bor (#' + dup.id + ').' });
  const r = db.prepare('INSERT INTO applications(telegram_id,customer,phone,product_id,months,down,total,monthly,pay_type,consent_at,variant,trade_model,trade_value,promo,delivery,branch,address,geo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(uid, customer, phone, p0.id, months, down, total, monthly, cash ? 'cash' : 'installment', '', variant, tradeModel, tradeValue, pr ? pr.code : '', delivery, branch, address, geo);
  const risky = db.prepare('SELECT risky FROM users WHERE telegram_id=?').get(uid);
  const msg = (cash ? '💵 NAXT buyurtma #' : '💳 NASIYA ariza #') + r.lastInsertRowid + (risky && risky.risky ? '\n⚠️ ISHONCHSIZ deb belgilangan mijoz!' : '') + '\n👤 ' + customer + '\n📞 ' + phone + '\n' + (delivery === 'delivery' ? '🚚 Yetkazish: ' + address + (geo ? ' 📍 https://maps.google.com/?q=' + geo : '') : '🏪 Filial: ' + (branch || 'do‘kon')) + '\n📱 ' + p0.name + (variant ? ' (' + variant + ')' : '') + ' — ' + money(price) + (pr ? ' (🎟 ' + pr.code + ' −' + pr.percent + '%)' : '') +
    (cash ? '' : '\n🗓 ' + months + ' oy · avans ' + money(down) + (tradeValue ? ' (shundan eski telefon ' + tradeModel + ' ≈ ' + money(tradeValue) + ')' : '') + '\n💳 Oyiga ' + money(monthly) + ' (jami ' + money(total) + ')');
  staffIds().forEach(id => notify(id, msg));
  res.json({ id: r.lastInsertRowid, status: 'new' });
});

app.get('/api/applications/mine', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Bu bo‘lim Telegram foydalanuvchilari uchun.' });
  res.json(db.prepare('SELECT a.id,a.months,a.down,a.status,a.note,a.created_at,a.total,a.monthly,a.pay_type,a.approved_at,a.contract_sent,p.name AS product,p.price AS price FROM applications a LEFT JOIN products p ON a.product_id=p.id WHERE a.telegram_id=? ORDER BY a.id DESC').all(String(req.user.id)).map(x => ({ ...x, ...payInfo(x) })));
});


/* ---------- Admin API ---------- */
app.get('/api/admin', auth, staff, (req, res) => {
  const stats = db.prepare("SELECT COUNT(*) total, SUM(status='new') new_, SUM(status='review') review, SUM(status='approved') approved, SUM(status='rejected') rejected FROM applications").get();
  res.json({
    products: db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(shape),
    markups: markupsMap(),
    applications: db.prepare('SELECT a.*,p.name AS product,COALESCE(u.risky,0) AS risky FROM applications a LEFT JOIN products p ON a.product_id=p.id LEFT JOIN users u ON u.telegram_id=a.telegram_id ORDER BY a.id DESC').all().map(({ passport_enc, card_enc, ...r }) => ({ ...r, has_secret: Boolean(card_enc), ...payInfo(r) })),
    markup: Number(getSetting('markup', '50')),
    contact: { phone: getSetting('contact_phone'), telegram: getSetting('contact_telegram'), address: getSetting('contact_address'), hours: getSetting('contact_hours'), instagram: getSetting('contact_instagram') },
    promo: getSetting('promo'), banners: getBanners(), info: { installment: getSetting('info_installment'), delivery: getSetting('info_delivery'), about: getSetting('info_about') },
    remind_days: Number(getSetting('remind_days', '3')), promos: getSetting('promos'), role: roleOf(req), branches_raw: getSetting('branches'), company: getSetting('company'), stats: { total: stats.total || 0, new: stats.new_ || 0, review: stats.review || 0, approved: stats.approved || 0, rejected: stats.rejected || 0 }
  });
});

const validImage = s => (/^https:\/\/\S+$/i.test(s) || /^\/img\/\d+$/.test(s)) && s.length <= 500;
function parseImages(v) {
  const arr = (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
  return arr.length <= 6 && arr.every(validImage) ? arr : null;
}
function parseVariants(v) {
  const lines = (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean), out = [];
  for (const line of lines) {
    const [n, p, st] = line.split('|').map(x => x.trim()), price = Number(p), stock = Number(st);
    if (!n || n.length > 50 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0) return null;
    out.push({ name: n, price, stock });
  }
  return out.length <= 12 ? out : null;
}
const saleOk = (old, until, price) => (!old && !until) || (Number.isSafeInteger(old) && old > price && /^\d{4}-\d{2}-\d{2}$/.test(until));
const PBAD = 'Qiymatlarni tekshiring: nomi, narx, soni, rasm havolalari, variantlar («nom | narx | soni») yoki aksiya (eski narx va tugash sanasi).';
app.post('/api/admin/products', auth, admin, (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim();
  let price = Number(b.price), stock = Number(b.stock);
  const description = String(b.description || '').trim().slice(0, 1000), category = String(b.category || '').trim().slice(0, 40);
  const imgs = parseImages(b.images !== undefined ? b.images : b.image), vs = parseVariants(b.variants);
  if (vs && vs.length) { price = Math.min(...vs.map(v => v.price)); stock = vs.reduce((t, v) => t + v.stock, 0); }
  const old = Number(b.old_price || 0), until = String(b.sale_until || '');
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || !imgs || !vs || !saleOk(old, until, price)) return res.status(400).json({ error: PBAD });
  const r = db.prepare('INSERT INTO products(name,price,stock,image,images,description,category,variants,old_price,sale_until) VALUES(?,?,?,?,?,?,?,?,?,?)').run(name, price, stock, imgs[0] || '', JSON.stringify(imgs), description, category, JSON.stringify(vs), old, until);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/admin/products/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id), p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi.' });
  const b = req.body || {}, cur = shape(p);
  const name = String(b.name === undefined ? p.name : b.name).trim();
  let price = Number(b.price === undefined ? p.price : b.price), stock = Number(b.stock === undefined ? p.stock : b.stock);
  const active = Number(b.active === undefined ? p.active : b.active);
  const description = String(b.description === undefined ? p.description : b.description).trim().slice(0, 1000);
  const category = String(b.category === undefined ? p.category : b.category).trim().slice(0, 40);
  const imgs = b.images === undefined ? cur.images : parseImages(b.images);
  const vs = b.variants === undefined ? cur.variants : parseVariants(b.variants);
  if (vs && vs.length) { price = Math.min(...vs.map(v => v.price)); stock = vs.reduce((t, v) => t + v.stock, 0); }
  const old = Number(b.old_price === undefined ? p.old_price : b.old_price || 0), until = String(b.sale_until === undefined ? p.sale_until : b.sale_until);
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || ![0, 1].includes(active) || !imgs || !vs || !saleOk(old, until, price)) return res.status(400).json({ error: PBAD });
  db.prepare('UPDATE products SET name=?,price=?,stock=?,active=?,image=?,images=?,description=?,category=?,variants=?,old_price=?,sale_until=? WHERE id=?').run(name, price, stock, active, imgs[0] || '', JSON.stringify(imgs), description, category, JSON.stringify(vs), old, until, id);
  productHooks(p, { id, name, price, stock });
  res.json({ ok: true });
});

app.delete('/api/admin/products/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id);
  const used = db.prepare('SELECT COUNT(*) c FROM applications WHERE product_id=?').get(id).c;
  if (used) { // arizalar bog‘langan — o‘chirmasdan yashiramiz
    db.prepare('UPDATE products SET active=0 WHERE id=?').run(id);
    return res.json({ ok: true, hidden: true });
  }
  res.json({ ok: db.prepare('DELETE FROM products WHERE id=?').run(id).changes > 0 });
});

const TAKEN = ['approved', 'preparing', 'shipping', 'delivered'];
function adjStock(a, delta) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(a.product_id);
  if (!p) return true;
  if (a.variant) {
    const vs = JSON.parse(p.variants || '[]'), v = vs.find(x => x.name === a.variant);
    if (v) { if (v.stock + delta < 0) return false; v.stock += delta; db.prepare('UPDATE products SET variants=?, stock=? WHERE id=?').run(JSON.stringify(vs), vs.reduce((t, x) => t + x.stock, 0), p.id); return true; }
  }
  if (p.stock + delta < 0) return false;
  db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(delta, p.id);
  return true;
}
const changeStatus = db.transaction((id, status) => {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
  if (!a) return null;
  const take = TAKEN.includes(status);
  if (take && !a.stock_taken) { if (!adjStock(a, -1)) throw new Error('Omborda bu telefon qolmagan.'); db.prepare('UPDATE applications SET stock_taken=1 WHERE id=?').run(id); }
  else if (!take && a.stock_taken) { adjStock(a, 1); db.prepare('UPDATE applications SET stock_taken=0 WHERE id=?').run(id); }
  db.prepare("UPDATE applications SET status=?, approved_at=CASE WHEN ? IN ('approved','preparing','shipping','delivered') AND approved_at='' THEN datetime('now') ELSE approved_at END WHERE id=?").run(status, status, id);
  return a;
});

app.patch('/api/admin/applications/:id', auth, staff, (req, res) => {
  const b = req.body || {}, status = String(b.status || '');
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Ariza holati noto‘g‘ri.' });
  const note = String(b.note === undefined ? '' : b.note).trim().slice(0, 300);
  const id = Number(req.params.id);
  let a;
  try { a = changeStatus(id, status); } catch (e) { return res.status(409).json({ error: e.message }); }
  if (!a) return res.status(404).json({ error: 'Ariza topilmadi.' });
  if (b.note !== undefined) db.prepare('UPDATE applications SET note=? WHERE id=?').run(note, id);
  if (a.status !== status) {
    const p = db.prepare('SELECT name FROM products WHERE id=?').get(a.product_id);
    notify(a.telegram_id, '📋 Arizangiz #' + id + ' (' + (p ? p.name : '') + ')\nHolat: ' + STATUS_UZ[status] + (note ? '\n💬 ' + note : ''));
  }
  res.json({ ok: true });
});

app.post('/api/admin/settings', auth, admin, (req, res) => {
  const b = req.body || {};
  if (b.markup !== undefined) {
    const markup = Number(b.markup);
    if (!Number.isFinite(markup) || markup < 0 || markup > 300) return res.status(400).json({ error: 'Ustama 0–300% oralig‘ida bo‘lsin.' });
    setSetting('markup', markup);
  }
  if (b.remind_days !== undefined) {
    const v = Number(b.remind_days);
    if (!Number.isInteger(v) || v < 0 || v > 30) return res.status(400).json({ error: 'Eslatma kunlari 0–30 oralig‘ida bo‘lsin (0 = o‘chirilgan).' });
    setSetting('remind_days', v);
  }
  if (b.markups !== undefined) {
    const o = {};
    for (const t of TERMS) { const v = Number((b.markups || {})[t]); if (!Number.isFinite(v) || v < 0 || v > 300) return res.status(400).json({ error: 'Har bir muddat ustamasi 0–300% bo‘lsin.' }); o[t] = v; }
    setSetting('markups', JSON.stringify(o));
  }
  if (b.banners !== undefined) {
    const arr = Array.isArray(b.banners) ? b.banners.slice(0, 6) : null;
    if (!arr || !arr.every(x => x && validImage(String(x.img || '')) && (!x.link || (/^https:\/\/\S+$/i.test(String(x.link)) && String(x.link).length <= 300))))
      return res.status(400).json({ error: 'Banner rasmi yoki havolasi noto‘g‘ri.' });
    setSetting('banners', JSON.stringify(arr.map(x => ({ img: String(x.img), link: String(x.link || '') }))));
  }
  const text = (k, max) => { if (b[k] !== undefined) setSetting(k, String(b[k]).trim().slice(0, max)); };
  if (b.contact_telegram !== undefined && !/^@?[A-Za-z0-9_]{0,32}$/.test(String(b.contact_telegram).trim()))
    return res.status(400).json({ error: 'Telegram username noto‘g‘ri (masalan @mandarin_nasiya).' });
  if (b.contact_instagram !== undefined && !/^@?[A-Za-z0-9_.]{0,31}$/.test(String(b.contact_instagram).trim())) return res.status(400).json({ error: 'Instagram username noto‘g‘ri (masalan @mandarin_nasiya).' });
  text('contact_instagram', 32); text('contact_phone', 30); text('contact_telegram', 33); text('contact_address', 200); text('contact_hours', 100); text('promo', 200); text('info_installment', 1500); text('info_delivery', 1500); text('info_about', 1500); text('promos', 1500); text('branches', 1000); text('company', 200);
  res.json({ ok: true });
});

app.get('/api/favorites', auth, (req, res) => res.json(db.prepare('SELECT product_id FROM favorites WHERE telegram_id=?').all(String(req.user.id)).map(r => r.product_id)));
app.post('/api/favorites/:id', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Faqat Telegram ichida.' });
  const id = Number(req.params.id), uid = String(req.user.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) return res.status(404).json({ error: 'Topilmadi.' });
  const has = db.prepare('SELECT 1 FROM favorites WHERE telegram_id=? AND product_id=?').get(uid, id);
  if (has) db.prepare('DELETE FROM favorites WHERE telegram_id=? AND product_id=?').run(uid, id);
  else db.prepare('INSERT INTO favorites(telegram_id,product_id) VALUES(?,?)').run(uid, id);
  res.json({ fav: !has });
});
app.post('/api/admin/broadcast', auth, admin, (req, res) => {
  if (!bot) return res.status(503).json({ error: 'Bot ulanmagan.' });
  const text = String((req.body || {}).text || '').trim().slice(0, 1000);
  if (text.length < 3) return res.status(400).json({ error: 'Xabar juda qisqa.' });
  const ids = db.prepare('SELECT telegram_id FROM users WHERE blocked=0').all().map(r => r.telegram_id);
  res.json({ count: ids.length });
  (async () => { for (const id of ids) { await sendUser(id, '📣 ' + text, appBtn()); await new Promise(r => setTimeout(r, 60)); } })();
});
app.get('/api/admin/customers', auth, staff, (req, res) => res.json(db.prepare('SELECT u.telegram_id id,u.name,u.username,u.note,u.risky,(SELECT COUNT(*) FROM applications a WHERE a.telegram_id=u.telegram_id) apps FROM users u ORDER BY apps DESC, u.rowid DESC LIMIT 500').all()));
app.patch('/api/admin/customers/:id', auth, staff, (req, res) => {
  const b = req.body || {};
  res.json({ ok: db.prepare('UPDATE users SET note=?, risky=? WHERE telegram_id=?').run(String(b.note || '').trim().slice(0, 500), b.risky ? 1 : 0, String(req.params.id)).changes > 0 });
});
app.post('/api/admin/export', auth, staff, async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'Bot ulanmagan.' });
  const rows = db.prepare('SELECT a.*,p.name pname FROM applications a LEFT JOIN products p ON p.id=a.product_id ORDER BY a.id DESC').all();
  const q = v => { let t = String(v == null ? '' : v); if (/^[=@]|^[+\-](?![\d\s])/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const head = ['ID', 'Sana', 'Mijoz', 'Telefon', 'Telefon modeli', 'Variant', 'Turi', 'Muddat (oy)', 'Avans', 'Oylik', 'Jami', 'Eski telefon', 'Eski telefon bahosi', 'Promokod', 'Holat', 'Izoh'];
  const csv = '\ufeff' + [head, ...rows.map(a => [a.id, a.created_at, a.customer, a.phone, a.pname, a.variant, a.pay_type === 'cash' ? 'Naxt' : 'Nasiya', a.months, a.down, a.monthly, a.total, a.trade_model, a.trade_value, a.promo, STATUS_UZ[a.status] || a.status, a.note])].map(r => r.map(q).join(',')).join('\r\n');
  let ok = false;
  for (const id of (req.authType === 'telegram' ? [String(req.user.id)] : adminIds())) {
    try { await bot.sendDocument(id, Buffer.from(csv), { caption: '📊 Arizalar (Excel/CSV)' }, { filename: 'arizalar-' + new Date().toISOString().slice(0, 10) + '.csv', contentType: 'text/csv' }); ok = true; } catch (e) { console.error('Export:', e.message); }
  }
  res.json({ ok });
});
app.get('/api/admin/audit', auth, admin, (req, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all()));
app.post('/api/admin/applications/:id/contract', auth, staff, async (req, res) => {
  if (!PDFDocument) return res.status(503).json({ error: 'PDF moduli (pdfkit) o‘rnatilmagan. package.json ni yangilab, qayta deploy qiling.' });
  if (!bot) return res.status(503).json({ error: 'Bot ulanmagan.' });
  res.json({ ok: await sendContract(Number(req.params.id), req.authType === 'telegram' ? req.user.id : adminIds()[0]) });
});
app.get('/api/admin/applications/:id/contract.pdf', auth, staff, async (req, res) => {
  if (!PDFDocument) return res.status(503).json({ error: 'pdfkit o‘rnatilmagan.' });
  const a = db.prepare('SELECT a.*, p.name pname FROM applications a LEFT JOIN products p ON p.id=a.product_id WHERE a.id=?').get(Number(req.params.id));
  if (!a || a.pay_type !== 'installment') return res.status(404).json({ error: 'Nasiya arizasi topilmadi.' });
  res.set('Content-Type', 'application/pdf').send(await makeContract(a));
});
app.post('/api/admin/applications/:id/payments', auth, staff, (req, res) => {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(Number(req.params.id));
  if (!a || a.pay_type !== 'installment' || !a.approved_at) return res.status(400).json({ error: 'To‘lov faqat tasdiqlangan nasiya arizasiga qabul qilinadi.' });
  const b = req.body || {}, amount = Number(b.amount), left = debtInfo(a).left, u = req.user || {};
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > left) return res.status(400).json({ error: 'Summa 1 dan ' + money(left) + ' gacha bo‘lsin.' });
  db.prepare('INSERT INTO payments(app_id,amount,note,taker) VALUES(?,?,?,?)').run(a.id, amount, String(b.note || '').slice(0, 100), req.authType === 'web' ? 'Veb-admin' : String(u.first_name || u.id));
  notify(a.telegram_id, '✅ To‘lov qabul qilindi: ' + money(amount) + '\nQolgan: ' + money(left - amount));
  res.json({ ok: true, left: left - amount });
});
app.get('/api/admin/debtors', auth, staff, (req, res) => {
  const rows = db.prepare("SELECT a.*, p.name pname FROM applications a LEFT JOIN products p ON p.id=a.product_id WHERE a.pay_type='installment' AND a.approved_at!='' AND a.months>0 AND a.status IN ('approved','preparing','shipping','delivered')").all();
  res.json(rows.map(a => ({ a, d: debtInfo(a) })).filter(x => x.d.overdue > 0).sort((x, y) => y.d.days - x.d.days).map(({ a, d }) => ({ id: a.id, customer: a.customer, phone: a.phone, product: a.pname, overdue: d.overdue, days: d.days, left: d.left })));
});
app.get('/api/admin/stats', auth, admin, (req, res) => {
  const apps = db.prepare("SELECT * FROM applications WHERE pay_type='installment' AND approved_at!='' AND months>0 AND status IN ('approved','preparing','shipping','delivered')").all();
  let outstanding = 0, overdue = 0;
  for (const a of apps) { const d = debtInfo(a); outstanding += d.left; overdue += d.overdue; }
  const monthly = [];
  for (let i = 5; i >= 0; i--) { const d = new Date(Date.now() + 5 * 3600 * 1000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i); const m = d.toISOString().slice(0, 7); monthly.push({ m, sum: db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE substr(paid_at,1,7)=?').get(m).s }); }
  const c = db.prepare("SELECT SUM(status IN ('approved','preparing','shipping','delivered')) ok, SUM(status='rejected') no FROM applications").get(), ok = c.ok || 0, no = c.no || 0;
  res.json({ paid: db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments').get().s, outstanding, overdue, rate: ok + no ? Math.round(ok * 100 / (ok + no)) : 0, monthly, top: db.prepare('SELECT p.name, COUNT(*) c FROM applications a JOIN products p ON p.id=a.product_id GROUP BY a.product_id ORDER BY c DESC LIMIT 5').all() });
});
app.post('/api/notify/:id', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Faqat Telegram ichida.' });
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM products WHERE id=?').get(id)) return res.status(404).json({ error: 'Topilmadi.' });
  db.prepare('INSERT OR IGNORE INTO notify_me(telegram_id,product_id) VALUES(?,?)').run(String(req.user.id), id);
  res.json({ ok: true });
});
const cReq = new Map();
app.post('/api/applications/:id/contract', auth, async (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Faqat Telegram ichida.' });
  const id = Number(req.params.id), a = db.prepare('SELECT * FROM applications WHERE id=? AND telegram_id=?').get(id, String(req.user.id));
  if (!a || a.pay_type !== 'installment' || !TAKEN.includes(a.status)) return res.status(404).json({ error: 'Shartnoma topilmadi (ariza hali tasdiqlanmagan).' });
  if (!PDFDocument || !bot) return res.status(503).json({ error: 'Shartnoma xizmati hozir mavjud emas.' });
  if (Date.now() - (cReq.get(id) || 0) < 20000) return res.status(429).json({ error: 'Biroz kuting va qayta urinib ko‘ring.' });
  cReq.set(id, Date.now());
  res.json({ ok: await sendContract(id, req.user.id) });
});
app.post('/api/admin/upload', auth, admin, (req, res) => {
  const d = String((req.body || {}).data || '');
  if (!d || d.length > 900000 || !/^[A-Za-z0-9+/=]+$/.test(d)) return res.status(400).json({ error: 'Rasm noto‘g‘ri yoki juda katta.' });
  if (Buffer.from(d.slice(0, 8), 'base64')[0] !== 0xff) return res.status(400).json({ error: 'Faqat rasm (JPEG) qabul qilinadi.' });
  res.json({ url: '/img/' + db.prepare('INSERT INTO images(data) VALUES(?)').run(d).lastInsertRowid });
});
app.get('/img/:id', (req, res) => {
  const r = db.prepare('SELECT data FROM images WHERE id=?').get(Number(req.params.id));
  if (!r) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' }).send(Buffer.from(r.data, 'base64'));
});
app.post('/api/admin/backup', auth, admin, async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'Bot ulanmagan (BOT_TOKEN va WEBAPP_URL tekshiring).' });
  if (!adminIds().length) return res.status(503).json({ error: 'ADMIN_IDS sozlanmagan.' });
  res.json({ ok: await sendBackup() });
});

app.use((err, req, res, next) => { // noto‘g‘ri JSON va h.k.
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status === 400 ? 'So‘rov noto‘g‘ri.' : 'Serverda xatolik.' });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log('Mandarin Mini App ready on port ' + port));

if (process.env.BOT_TOKEN && process.env.WEBAPP_URL && process.env.WEBAPP_URL.startsWith('https://')) {
  const TelegramBot = require('node-telegram-bot-api');
  const url = process.env.WEBAPP_URL;
  bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  // MUHIM: oddiy (keyboard) tugma orqali ochilganda Telegram initData bermaydi,
  // shuning uchun ariza/admin ishlamaydi. Inline tugma va Menu tugmasi ishlatiladi.
  bot.setChatMenuButton({ menu_button: JSON.stringify({ type: 'web_app', text: '📱 Ilova', web_app: { url } }) })
    .catch(e => console.error('MenuButton:', e.message));
  bot.getMe().then(me => { botUser = me.username || ''; }).catch(() => {});
  const upsertUser = u => { try { db.prepare('INSERT INTO users(telegram_id,name,username) VALUES(?,?,?) ON CONFLICT(telegram_id) DO UPDATE SET name=excluded.name, username=excluded.username, blocked=0').run(String(u.id), String(u.first_name || '').slice(0, 80), String(u.username || '').slice(0, 40)); } catch (_) {} };
  bot.onText(/\/start(?:\s+(\w+))?/, async (msg, m) => {
    try {
      upsertUser(msg.from);
      if (m && /^p\d+$/.test(m[1] || '')) return bot.sendMessage(msg.chat.id, '📱 Telefonni ko‘rish uchun tugmani bosing 👇', { reply_markup: { inline_keyboard: [[{ text: '📱 Ochish', web_app: { url: url + (url.includes('?') ? '&' : '?') + 'p=' + m[1].slice(1) } }]] } });
      if (m && m[1] === 'support') return bot.sendMessage(msg.chat.id, '🆘 Texnik yordam\nSavolingizni shu yerga yozing (matn yoki rasm) — adminga yuboraman, javob shu chatga keladi.');
      await bot.sendMessage(msg.chat.id, '🍊 Mandarin Nasiya', { reply_markup: { remove_keyboard: true } });
      await bot.sendMessage(msg.chat.id, 'Telefonlarni ko‘ring, oylik to‘lovni hisoblang va ariza yuboring.', {
        reply_markup: { inline_keyboard: [[{ text: '📱 Ilovani ochish', web_app: { url } }], [{ text: '🆘 Texnik yordam', callback_data: 'support' }]] }
      });
      if (adminIds().includes(String(msg.from.id))) bot.sendMessage(msg.chat.id, '👨‍💼 Admin: mijoz yozsa xabar shu yerga keladi. Javob berish uchun xabarga REPLY qiling — javob mijozga yetadi.');
    } catch (e) { console.error('/start:', e.message); }
  });
  bot.on('callback_query', q => {
    if (q.data === 'support') { bot.answerCallbackQuery(q.id).catch(() => {}); bot.sendMessage(q.message.chat.id, '🆘 Savolingizni shu yerga yozing (matn yoki rasm) — adminga yuboraman.').catch(() => {}); }
  });
  const hits = new Map();
  bot.on('message', async msg => { // texnik yordam: mijoz -> adminlar, admin REPLY -> mijoz
    try {
      if (msg.chat.type !== 'private' || msg.web_app_data || /^\/(start|help)/.test(msg.text || '')) return;
      const uid = String(msg.from.id);
      if (staffIds().includes(uid)) {
        const rt = msg.reply_to_message;
        const m = rt && db.prepare('SELECT user_id FROM support_msgs WHERE admin_chat=? AND admin_msg=?').get(String(msg.chat.id), rt.message_id);
        if (!m) return;
        await bot.sendMessage(m.user_id, '👨‍💼 Texnik yordam javobi:');
        await bot.copyMessage(m.user_id, msg.chat.id, msg.message_id);
        return bot.sendMessage(msg.chat.id, '✅ Mijozga yuborildi.', { reply_to_message_id: msg.message_id });
      }
      upsertUser(msg.from);
      const t = (hits.get(uid) || []).filter(x => Date.now() - x < 60000);
      if (t.length >= 8) return;
      t.push(Date.now()); hits.set(uid, t);
      const who = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') + (msg.from.username ? ' (@' + msg.from.username + ')' : '') + ' · ID ' + uid;
      for (const a of staffIds()) {
        const h = await bot.sendMessage(a, '🆘 Texnik yordam\n👤 ' + who + '\n↩️ Javob berish uchun shu xabarga yoki pastdagi nusxaga REPLY qiling.');
        const c = await bot.copyMessage(a, msg.chat.id, msg.message_id);
        for (const mid of [h.message_id, c.message_id]) db.prepare('INSERT OR REPLACE INTO support_msgs(admin_chat,admin_msg,user_id) VALUES(?,?,?)').run(String(a), mid, uid);
      }
      bot.sendMessage(msg.chat.id, '✅ Xabaringiz texnik yordamga yuborildi. Tez orada javob beramiz.');
    } catch (e) { console.error('Support:', e.message); }
  });
  const tz = () => new Date(Date.now() + 5 * 3600 * 1000); // Toshkent vaqti (UTC+5), UTC getter'lar bilan o‘qiladi
  async function runReminders() {
    const now = tz(), hour = now.getUTCHours();
    if (hour < 10 || hour >= 20) return; // kechasi xabar yubormaymiz
    const days = Number(getSetting('remind_days', '3'));
    if (days > 0) { // yoqqan telefon + 12/18/24 oylik to‘lovlar
      const us = db.prepare("SELECT u.telegram_id id FROM users u WHERE u.blocked=0 AND EXISTS(SELECT 1 FROM favorites f JOIN products p ON p.id=f.product_id AND p.active=1 AND p.stock>0 WHERE f.telegram_id=u.telegram_id) AND (u.last_remind='' OR julianday('now')-julianday(u.last_remind)>=?) LIMIT 25").all(days);
      for (const u of us) {
        const ps = db.prepare('SELECT p.* FROM favorites f JOIN products p ON p.id=f.product_id WHERE f.telegram_id=? AND p.active=1 AND p.stock>0 ORDER BY f.created_at DESC LIMIT 3').all(u.id);
        const lines = ps.map(p => '📱 ' + p.name + ' — ' + money(p.price) + '\n' + [12, 18, 24].map(mm => '   ' + mm + ' oy: ' + money(Math.ceil(p.price * (1 + markupFor(mm) / 100) / mm)) + '/oy').join('\n'));
        await sendUser(u.id, '❤️ Sizga yoqqan telefon' + (ps.length > 1 ? 'lar' : '') + ':\n\n' + lines.join('\n\n') + '\n\nAriza qoldiring — tez javob beramiz 👇', appBtn());
        db.prepare("UPDATE users SET last_remind=datetime('now') WHERE telegram_id=?").run(u.id);
        await new Promise(r => setTimeout(r, 80));
      }
    }
    const today = now.toISOString().slice(0, 10), tmr = new Date(now.getTime() + 86400000); // oylik to‘lovdan 1 kun oldin
    const apps = db.prepare("SELECT a.*, p.name pname FROM applications a LEFT JOIN products p ON p.id=a.product_id WHERE a.status IN ('approved','preparing','shipping','delivered') AND a.pay_type='installment' AND a.months>0 AND a.approved_at!='' AND a.last_pay_remind!=?").all(today);
    for (const a of apps) {
      const ap = new Date(new Date(a.approved_at.replace(' ', 'T') + 'Z').getTime() + 5 * 3600 * 1000);
      const passed = (tmr.getUTCFullYear() * 12 + tmr.getUTCMonth()) - (ap.getUTCFullYear() * 12 + ap.getUTCMonth());
      if (tmr.getUTCDate() !== Math.min(ap.getUTCDate(), 28) || passed < 1 || passed > a.months) continue;
      await sendUser(a.telegram_id, '⏰ Eslatma: ertaga oylik to‘lov kuni.\n📱 ' + (a.pname || '') + '\n💳 To‘lov: ' + money(a.monthly) + ' (' + passed + '/' + a.months + '-oy)');
      db.prepare('UPDATE applications SET last_pay_remind=? WHERE id=?').run(today, a.id);
    }
  }
  setTimeout(() => runReminders().catch(e => console.error('Reminders:', e.message)), 90000);
  setInterval(() => runReminders().catch(e => console.error('Reminders:', e.message)), 30 * 60 * 1000);
  setInterval(() => runOverdue().catch(e => console.error('Overdue:', e.message)), 60 * 60 * 1000);
  bot.on('document', async msg => { // admin zaxira faylini yuborsa — tiklanadi
    try {
      if (msg.chat.type !== 'private' || !adminIds().includes(String(msg.from.id))) return;
      const d = msg.document;
      if (!/\.json$/i.test(d.file_name || '') || d.file_size > 5 * 1024 * 1024) return;
      const data = JSON.parse(await (await fetch(await bot.getFileLink(d.file_id))).text());
      restoreBackup(data);
      bot.sendMessage(msg.chat.id, '✅ Tiklandi: ' + data.products.length + ' ta telefon, ' + data.applications.length + ' ta ariza.');
    } catch (e) { bot.sendMessage(msg.chat.id, '❌ Tiklab bo‘lmadi: ' + e.message); }
  });
  (async () => { // baza bo‘sh bo‘lsa (deploydan keyin) — qadalgan zaxiradan o‘zi tiklaydi
    try {
      if (db.prepare('SELECT (SELECT COUNT(*) FROM products)+(SELECT COUNT(*) FROM applications) c').get().c !== 0) return;
      for (const id of adminIds()) {
        const doc = (await bot.getChat(id)).pinned_message && (await bot.getChat(id)).pinned_message.document;
        if (!doc || !/\.json$/i.test(doc.file_name || '')) continue;
        restoreBackup(JSON.parse(await (await fetch(await bot.getFileLink(doc.file_id))).text()));
        notify(id, '♻️ Baza bo‘sh edi — oxirgi zaxiradan avtomatik tiklandi.');
        break;
      }
    } catch (e) { console.error('AutoRestore:', e.message); }
  })();
  bot.on('polling_error', err => console.error('Telegram polling:', err.message));
} else {
  console.warn('BOT_TOKEN yoki WEBAPP_URL (https://...) sozlanmagan — bot ishlamaydi.');
}
