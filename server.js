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
for (const [c, d] of [['pay_type', "'installment'"], ['passport_enc', "''"], ['card_enc', "''"], ['card_last4', "''"], ['card_phone', "''"], ['consent_at', "''"]])
  if (!appCols.includes(c)) db.exec('ALTER TABLE applications ADD COLUMN ' + c + ' TEXT NOT NULL DEFAULT ' + d);
if (!appCols.includes('note')) db.exec("ALTER TABLE applications ADD COLUMN note TEXT NOT NULL DEFAULT ''");

const getSetting = (k, d = '') => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('markup')) setSetting('markup', '50');

const TERMS = [3, 6, 12, 18, 24];
const markupFor = m => { try { const o = JSON.parse(getSetting('markups', '{}')); if (o[m] !== undefined && Number.isFinite(Number(o[m]))) return Number(o[m]); } catch (_) {} return Number(getSetting('markup', '50')); };
const markupsMap = () => Object.fromEntries(TERMS.map(t => [t, markupFor(t)]));
const shape = p => { let im = []; try { im = JSON.parse(p.images || '[]'); } catch (_) {} if (!im.length && p.image) im = [p.image]; return { ...p, images: im }; };
const dataKey = crypto.createHash('sha256').update(process.env.DATA_KEY || ('mandarin|' + (process.env.BOT_TOKEN || 'local'))).digest();
const enc = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', dataKey, iv), e = Buffer.concat([c.update(String(t), 'utf8'), c.final()]); return [iv, c.getAuthTag(), e].map(x => x.toString('base64')).join('.'); };
const dec = v => { try { const [iv, tag, e] = String(v).split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', dataKey, iv); d.setAuthTag(tag); return Buffer.concat([d.update(e), d.final()]).toString('utf8'); } catch (_) { return ''; } };
const luhn = n => { let x = 0, a = false; for (let i = n.length - 1; i >= 0; i--) { let d = +n[i]; if (a) { d *= 2; if (d > 9) d -= 9; } x += d; a = !a; } return x % 10 === 0; };
const STATUSES = ['new', 'review', 'approved', 'rejected'];
const STATUS_UZ = { new: 'Yangi', review: 'Ko‘rib chiqilmoqda', approved: 'Tasdiqlandi', rejected: 'Rad etildi' };
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
  if (user) { req.user = user; req.authType = 'telegram'; return next(); }
  if (validWebAdmin(bearerOf(req))) { req.user = { id: 'web-admin' }; req.authType = 'web'; return next(); }
  return res.status(401).json({ error: 'Telegram ichidan oching yoki admin sifatida kiring.' });
}
function admin(req, res, next) {
  if (req.authType === 'web' && validWebAdmin(bearerOf(req))) return next();
  if (req.authType === 'telegram' && adminIds().includes(String(req.user.id))) return next();
  return res.status(403).json({ error: 'Admin huquqi yo‘q.' });
}

// parol tanlashdan himoya: 15 daqiqada 8 ta urinish
const attempts = new Map();
function loginLimit(req, res, next) {
  const ip = req.ip, now = Date.now(), a = attempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60 * 1000) { a.n = 0; a.t = now; }
  if (a.n >= 8) return res.status(429).json({ error: 'Juda ko‘p urinish. 15 daqiqadan keyin qayta urining.' });
  a.n++; attempts.set(ip, a); req.attempt = a; next();
}

/* ---------- Telegram bot (xabarnomalar uchun) ---------- */
let bot = null;
const notify = (chatId, text) => { if (bot && chatId && /^\d+$/.test(String(chatId))) bot.sendMessage(chatId, text).catch(e => console.error('Notify:', e.message)); };
const money = n => Number(n).toLocaleString('ru-RU') + ' so‘m';

/* ---------- Zaxira nusxa (Telegram orqali saqlash va tiklash) ---------- */
const makeBackup = () => JSON.stringify({ v: 1, at: new Date().toISOString(), products: db.prepare('SELECT * FROM products').all(), applications: db.prepare('SELECT * FROM applications').all(), settings: db.prepare('SELECT * FROM settings').all(), images: db.prepare('SELECT * FROM images').all() });
const insertRows = (table, rows) => {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
  for (const r of rows) {
    const k = Object.keys(r).filter(x => cols.includes(x));
    if (k.length) db.prepare('INSERT INTO ' + table + '(' + k.join(',') + ') VALUES(' + k.map(() => '?').join(',') + ')').run(...k.map(x => r[x]));
  }
};
const restoreBackup = db.transaction(data => {
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.applications) || !Array.isArray(data.settings)) throw new Error('Zaxira fayli noto‘g‘ri.');
  db.exec('DELETE FROM applications; DELETE FROM products; DELETE FROM settings; DELETE FROM images;');
  insertRows('products', data.products); insertRows('applications', data.applications); insertRows('settings', data.settings); insertRows('images', data.images || []);
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
  if (req.method !== 'GET' && !/^\/api\/admin\/(login|backup)/.test(req.path)) res.on('finish', () => { if (res.statusCode < 400 && bot) { clearTimeout(bkTimer); bkTimer = setTimeout(sendBackup, 60000); } });
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
    products: db.prepare('SELECT id,name,price,stock,image,images,description,category FROM products WHERE active=1 ORDER BY id DESC').all().map(shape),
    markups: markupsMap(),
    markup: Number(getSetting('markup', '50')),
    terms: TERMS,
    contact: { phone: getSetting('contact_phone'), telegram: getSetting('contact_telegram'), address: getSetting('contact_address'), hours: getSetting('contact_hours'), instagram: getSetting('contact_instagram') },
    promo: getSetting('promo')
  });
});

app.get('/api/me', (req, res) => {
  const user = verifyTelegram(req.get('X-Telegram-Init-Data'));
  if (!user) return res.status(401).json({ error: 'Telegram ichidan ilovani oching.' });
  res.json({ id: user.id, name: user.first_name || '', admin: adminIds().includes(String(user.id)) });
});

app.post('/api/applications', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(401).json({ error: 'Ariza yuborish uchun Telegram ichidan oching.' });
  const b = req.body || {}, cash = b.pay_type === 'cash';
  const customer = String(b.customer || '').trim(), phone = String(b.phone || '').trim();
  const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(Number(b.product_id));
  const bad = m => res.status(400).json({ error: m });
  if (!p || p.stock < 1) return bad('Bu telefon hozir mavjud emas.');
  if (customer.length < 2 || customer.length > 100) return bad('Ism-familiyani to‘g‘ri kiriting.');
  if (!PHONE_RE.test(phone)) return bad('Telefon raqamini to‘g‘ri kiriting. Masalan: +998 90 123 45 67');
  let months = 0, down = p.price, total = p.price, monthly = 0, passEnc = '', cardEnc = '', last4 = '', cardPhone = '';
  if (!cash) {
    months = Number(b.months); down = Number(b.down || 0);
    if (!TERMS.includes(months)) return bad('Muddat noto‘g‘ri.');
    if (!Number.isSafeInteger(down) || down < 0 || down >= p.price) return bad('Boshlang‘ich to‘lov 0 dan telefon narxigacha (narxdan kam) bo‘lsin.');
    const passport = String(b.passport || '').replace(/\s/g, '').toUpperCase(), card = String(b.card || '').replace(/\D/g, '');
    cardPhone = String(b.card_phone || '').trim();
    if (!/^[A-Z]{2}\d{7}$/.test(passport)) return bad('Pasport seriya va raqamini kiriting. Masalan: AA1234567');
    if (card.length !== 16 || !luhn(card)) return bad('Karta raqami (16 xona) noto‘g‘ri.');
    if (!PHONE_RE.test(cardPhone)) return bad('Kartaga ulangan telefon raqamini to‘g‘ri kiriting.');
    if (b.consent !== true) return bad('Ma’lumotlarni qayta ishlashga rozilik kerak.');
    total = Math.ceil((p.price - down) * (1 + markupFor(months) / 100)); monthly = Math.ceil(total / months);
    passEnc = enc(passport); cardEnc = enc(card); last4 = card.slice(-4);
  }
  const open = db.prepare("SELECT COUNT(*) c FROM applications WHERE telegram_id=? AND status IN ('new','review')").get(String(req.user.id)).c;
  if (open >= 5) return res.status(429).json({ error: 'Sizda 5 ta ko‘rib chiqilayotgan ariza bor. Javobini kuting.' });
  const dup = db.prepare("SELECT id FROM applications WHERE telegram_id=? AND product_id=? AND status IN ('new','review')").get(String(req.user.id), p.id);
  if (dup) return res.status(409).json({ error: 'Bu telefon uchun arizangiz allaqachon bor (#' + dup.id + ').' });
  const r = db.prepare('INSERT INTO applications(telegram_id,customer,phone,product_id,months,down,total,monthly,pay_type,passport_enc,card_enc,card_last4,card_phone,consent_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(String(req.user.id), customer, phone, p.id, months, down, total, monthly, cash ? 'cash' : 'installment', passEnc, cardEnc, last4, cardPhone, cash ? '' : new Date().toISOString());
  const msg = (cash ? '💵 NAXT buyurtma #' : '💳 NASIYA ariza #') + r.lastInsertRowid + '\n👤 ' + customer + '\n📞 ' + phone + '\n📱 ' + p.name + ' — ' + money(p.price) +
    (cash ? '' : '\n🗓 ' + months + ' oy · avans ' + money(down) + '\n💳 Oyiga ' + money(monthly) + ' (jami ' + money(total) + ')\n🔒 Pasport va karta admin panelda');
  adminIds().forEach(id => notify(id, msg));
  res.json({ id: r.lastInsertRowid, status: 'new' });
});

app.get('/api/applications/mine', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Bu bo‘lim Telegram foydalanuvchilari uchun.' });
  res.json(db.prepare('SELECT a.id,a.months,a.down,a.status,a.note,a.created_at,a.total,a.monthly,a.pay_type,p.name AS product,p.price AS price FROM applications a LEFT JOIN products p ON a.product_id=p.id WHERE a.telegram_id=? ORDER BY a.id DESC').all(String(req.user.id)));
});

/* ---------- Admin API ---------- */
app.get('/api/admin', auth, admin, (req, res) => {
  const stats = db.prepare("SELECT COUNT(*) total, SUM(status='new') new_, SUM(status='review') review, SUM(status='approved') approved, SUM(status='rejected') rejected FROM applications").get();
  res.json({
    products: db.prepare('SELECT * FROM products ORDER BY id DESC').all().map(shape),
    markups: markupsMap(),
    applications: db.prepare('SELECT a.*,p.name AS product FROM applications a LEFT JOIN products p ON a.product_id=p.id ORDER BY a.id DESC').all().map(({ passport_enc, card_enc, ...r }) => ({ ...r, has_secret: Boolean(card_enc) })),
    markup: Number(getSetting('markup', '50')),
    contact: { phone: getSetting('contact_phone'), telegram: getSetting('contact_telegram'), address: getSetting('contact_address'), hours: getSetting('contact_hours'), instagram: getSetting('contact_instagram') },
    promo: getSetting('promo'),
    stats: { total: stats.total || 0, new: stats.new_ || 0, review: stats.review || 0, approved: stats.approved || 0, rejected: stats.rejected || 0 }
  });
});

const validImage = s => (/^https:\/\/\S+$/i.test(s) || /^\/img\/\d+$/.test(s)) && s.length <= 500;
function parseImages(v) {
  const arr = (Array.isArray(v) ? v : String(v || '').split('\n')).map(x => String(x).trim()).filter(Boolean);
  return arr.length <= 6 && arr.every(validImage) ? arr : null;
}
app.post('/api/admin/products', auth, admin, (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim(), price = Number(b.price), stock = Number(b.stock);
  const description = String(b.description || '').trim().slice(0, 1000), category = String(b.category || '').trim().slice(0, 40);
  const imgs = parseImages(b.images !== undefined ? b.images : b.image);
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || !imgs)
    return res.status(400).json({ error: 'Nomi, narxi, soni yoki rasm havolalarini (https://, ko‘pi bilan 6 ta) tekshiring.' });
  const r = db.prepare('INSERT INTO products(name,price,stock,image,images,description,category) VALUES(?,?,?,?,?,?,?)').run(name, price, stock, imgs[0] || '', JSON.stringify(imgs), description, category);
  res.json({ id: r.lastInsertRowid });
});
app.patch('/api/admin/products/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id), p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi.' });
  const b = req.body || {}, cur = shape(p);
  const name = String(b.name === undefined ? p.name : b.name).trim();
  const price = Number(b.price === undefined ? p.price : b.price), stock = Number(b.stock === undefined ? p.stock : b.stock), active = Number(b.active === undefined ? p.active : b.active);
  const description = String(b.description === undefined ? p.description : b.description).trim().slice(0, 1000);
  const category = String(b.category === undefined ? p.category : b.category).trim().slice(0, 40);
  const imgs = b.images === undefined ? cur.images : parseImages(b.images);
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || ![0, 1].includes(active) || !imgs)
    return res.status(400).json({ error: 'Qiymatlarni va rasm havolalarini tekshiring.' });
  db.prepare('UPDATE products SET name=?,price=?,stock=?,active=?,image=?,images=?,description=?,category=? WHERE id=?').run(name, price, stock, active, imgs[0] || '', JSON.stringify(imgs), description, category, id);
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

const changeStatus = db.transaction((id, status) => {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
  if (!a) return null;
  if (status === 'approved' && !a.stock_taken) {
    const r = db.prepare('UPDATE products SET stock=stock-1 WHERE id=? AND stock>0').run(a.product_id);
    if (!r.changes) throw new Error('Omborda bu telefon qolmagan.');
    db.prepare('UPDATE applications SET stock_taken=1 WHERE id=?').run(id);
  } else if (status !== 'approved' && a.stock_taken) {
    db.prepare('UPDATE products SET stock=stock+1 WHERE id=?').run(a.product_id);
    db.prepare('UPDATE applications SET stock_taken=0 WHERE id=?').run(id);
  }
  db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, id);
  return a;
});

app.patch('/api/admin/applications/:id', auth, admin, (req, res) => {
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
  if (b.markups !== undefined) {
    const o = {};
    for (const t of TERMS) { const v = Number((b.markups || {})[t]); if (!Number.isFinite(v) || v < 0 || v > 300) return res.status(400).json({ error: 'Har bir muddat ustamasi 0–300% bo‘lsin.' }); o[t] = v; }
    setSetting('markups', JSON.stringify(o));
  }
  const text = (k, max) => { if (b[k] !== undefined) setSetting(k, String(b[k]).trim().slice(0, max)); };
  if (b.contact_telegram !== undefined && !/^@?[A-Za-z0-9_]{0,32}$/.test(String(b.contact_telegram).trim()))
    return res.status(400).json({ error: 'Telegram username noto‘g‘ri (masalan @mandarin_nasiya).' });
  if (b.contact_instagram !== undefined && !/^@?[A-Za-z0-9_.]{0,31}$/.test(String(b.contact_instagram).trim())) return res.status(400).json({ error: 'Instagram username noto‘g‘ri (masalan @mandarin_nasiya).' });
  text('contact_instagram', 32); text('contact_phone', 30); text('contact_telegram', 33); text('contact_address', 200); text('contact_hours', 100); text('promo', 200);
  res.json({ ok: true });
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
app.get('/api/admin/applications/:id/secret', auth, admin, (req, res) => {
  const a = db.prepare('SELECT passport_enc,card_enc FROM applications WHERE id=?').get(Number(req.params.id));
  if (!a || !a.card_enc) return res.status(404).json({ error: 'Maxfiy ma’lumot yo‘q.' });
  res.json({ passport: dec(a.passport_enc), card: dec(a.card_enc) });
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
  bot.onText(/\/start/, async msg => {
    try {
      await bot.sendMessage(msg.chat.id, '🍊 Mandarin Nasiya', { reply_markup: { remove_keyboard: true } }); // eski keyboard tugmani o‘chiradi
      await bot.sendMessage(msg.chat.id, 'Telefonlarni ko‘ring, oylik to‘lovni hisoblang va ariza yuboring.', {
        reply_markup: { inline_keyboard: [[{ text: '📱 Ilovani ochish', web_app: { url } }]] }
      });
    } catch (e) { console.error('/start:', e.message); }
  });
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
