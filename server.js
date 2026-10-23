require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '30kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'mandarin.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec('CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,price INTEGER NOT NULL CHECK(price > 0),stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),image TEXT DEFAULT \'\',active INTEGER NOT NULL DEFAULT 1); CREATE TABLE IF NOT EXISTS applications(id INTEGER PRIMARY KEY AUTOINCREMENT,telegram_id TEXT NOT NULL,customer TEXT NOT NULL,phone TEXT NOT NULL,product_id INTEGER NOT NULL,months INTEGER NOT NULL,down INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT \'new\',created_at TEXT DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
if (!db.prepare('SELECT 1 FROM settings WHERE key=?').get('markup')) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('markup', '50');
}
const adminIds = () => (process.env.ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const safeEqual = (a, b) => {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
};
function verifyTelegram(raw) {
  if (!process.env.BOT_TOKEN || !raw) return null;
  try {
    const params = new URLSearchParams(raw);
    const hash = params.get('hash');
    if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
    params.delete('hash');
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
    const calculated = crypto.createHmac('sha256', secret).update(check).digest('hex');
    if (!safeEqual(hash.toLowerCase(), calculated)) return null;
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? user : null;
  } catch (_) { return null; }
}
function webAdminToken(exp) {
  const secret = process.env.ADMIN_PASSWORD + '|' + (process.env.BOT_TOKEN || 'mandarin-admin');
  return String(exp) + '.' + crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
}
function validWebAdmin(token) {
  if (!process.env.ADMIN_PASSWORD || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp < Date.now() || exp > Date.now() + 13 * 60 * 60 * 1000) return false;
  return safeEqual(parts[1], webAdminToken(exp).split('.')[1]);
}
function auth(req, res, next) {
  const user = verifyTelegram(req.get('X-Telegram-Init-Data'));
  if (user) { req.user = user; req.authType = 'telegram'; return next(); }
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (validWebAdmin(bearer)) { req.user = { id: 'web-admin' }; req.authType = 'web'; return next(); }
  return res.status(401).json({ error: 'Telegram ichidan oching yoki admin sifatida kiring.' });
}
function admin(req, res, next) {
  const bearer = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (req.authType === 'web' && validWebAdmin(bearer)) return next();
  if (req.authType === 'telegram' && adminIds().includes(String(req.user.id))) return next();
  return res.status(403).json({ error: 'Admin huquqi yo‘q.' });
}
app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/config', (_, res) => res.json({ webAdminEnabled: Boolean(process.env.ADMIN_PASSWORD) }));
app.post('/api/admin/login', (req, res) => {
  const password = String(req.body && req.body.password || '');
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: 'Render Environment’da ADMIN_PASSWORD sozlanmagan.' });
  if (!safeEqual(password, process.env.ADMIN_PASSWORD)) return res.status(401).json({ error: 'Parol noto‘g‘ri.' });
  res.json({ token: webAdminToken(Date.now() + 12 * 60 * 60 * 1000), expiresIn: 43200 });
});
app.get('/api/catalog', (_, res) => {
  const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('markup');
  res.json({ products: db.prepare('SELECT id,name,price,stock,image FROM products WHERE active=1 ORDER BY id DESC').all(), markup: Number(setting ? setting.value : 50), terms: [3,6,12,18,24] });
});
app.get('/api/me', (req, res) => {
  const user = verifyTelegram(req.get('X-Telegram-Init-Data'));
  if (!user) return res.status(401).json({ error: 'Telegram ichidan ilovani oching.' });
  res.json({ id: user.id, name: user.first_name || '', admin: adminIds().includes(String(user.id)) });
});
app.post('/api/applications', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(401).json({ error: 'Ariza yuborish uchun Telegram ichidan oching.' });
  const body = req.body || {};
  const customer = String(body.customer || '').trim(), phone = String(body.phone || '').trim();
  const productId = Number(body.product_id), months = Number(body.months), down = Number(body.down);
  const p = db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(productId);
  if (!p || p.stock < 1 || !customer || customer.length > 100 || !/^[+\d\s()-]{9,20}$/.test(phone) || ![3,6,12,18,24].includes(months) || !Number.isSafeInteger(down) || down < 0 || down > p.price) {
    return res.status(400).json({ error: 'Ma’lumotlarni tekshiring. Telefon mavjudligini, raqam va to‘lovni ko‘ring.' });
  }
  const result = db.prepare('INSERT INTO applications(telegram_id,customer,phone,product_id,months,down) VALUES(?,?,?,?,?,?)').run(String(req.user.id), customer, phone, p.id, months, down);
  res.json({ id: result.lastInsertRowid, status: 'new' });
});
app.get('/api/applications/mine', auth, (req, res) => {
  if (req.authType !== 'telegram') return res.status(403).json({ error: 'Bu bo‘lim Telegram foydalanuvchilari uchun.' });
  res.json(db.prepare('SELECT a.*,p.name AS product FROM applications a LEFT JOIN products p ON a.product_id=p.id WHERE telegram_id=? ORDER BY a.id DESC').all(String(req.user.id)));
});
app.get('/api/admin', auth, admin, (req, res) => {
  const setting = db.prepare('SELECT value FROM settings WHERE key=?').get('markup');
  res.json({ products: db.prepare('SELECT * FROM products ORDER BY id DESC').all(), applications: db.prepare('SELECT a.*,p.name AS product FROM applications a LEFT JOIN products p ON a.product_id=p.id ORDER BY a.id DESC').all(), markup: Number(setting ? setting.value : 50) });
});
app.post('/api/admin/products', auth, admin, (req, res) => {
  const b = req.body || {}, name = String(b.name || '').trim(), price = Number(b.price), stock = Number(b.stock), image = String(b.image || '').trim();
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || (image && (!/^https:\/\/\S+$/i.test(image) || image.length > 500))) return res.status(400).json({ error: 'Nomi, narxi, ombor soni yoki rasm havolasini tekshiring.' });
  const result = db.prepare('INSERT INTO products(name,price,stock,image) VALUES(?,?,?,?)').run(name, price, stock, image);
  res.json({ id: result.lastInsertRowid });
});
app.patch('/api/admin/products/:id', auth, admin, (req, res) => {
  const id = Number(req.params.id), p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  if (!p) return res.status(404).json({ error: 'Mahsulot topilmadi.' });
  const b = req.body || {}, name = String(b.name === undefined ? p.name : b.name).trim(), price = Number(b.price === undefined ? p.price : b.price), stock = Number(b.stock === undefined ? p.stock : b.stock), active = Number(b.active === undefined ? p.active : b.active);
  if (!name || name.length > 100 || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(stock) || stock < 0 || ![0,1].includes(active)) return res.status(400).json({ error: 'Qiymatlarni tekshiring.' });
  db.prepare('UPDATE products SET name=?,price=?,stock=?,active=? WHERE id=?').run(name, price, stock, active, id);
  res.json({ ok: true });
});
app.patch('/api/admin/applications/:id', auth, admin, (req, res) => {
  const status = String((req.body || {}).status || '');
  if (!['new','review','approved','rejected'].includes(status)) return res.status(400).json({ error: 'Ariza holati noto‘g‘ri.' });
  const result = db.prepare('UPDATE applications SET status=? WHERE id=?').run(status, Number(req.params.id));
  res.json({ ok: result.changes > 0 });
});
app.post('/api/admin/settings', auth, admin, (req, res) => {
  const markup = Number((req.body || {}).markup);
  if (!Number.isFinite(markup) || markup < 0 || markup > 300) return res.status(400).json({ error: 'Ustama 0–300% oralig‘ida bo‘lsin.' });
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(String(markup), 'markup');
  res.json({ ok: true });
});
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => console.log('Mandarin Mini App ready on port ' + port));
if (process.env.BOT_TOKEN && process.env.WEBAPP_URL && process.env.WEBAPP_URL.startsWith('https://')) {
  const TelegramBot = require('node-telegram-bot-api');
  const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });
  bot.onText(/\/start/, msg => bot.sendMessage(msg.chat.id, '🍊 Mandarin Nasiya\nTelefonlarni ko‘ring, oylik to‘lovni hisoblang va ariza yuboring.', { reply_markup: { keyboard: [[{ text: '📱 Ilovani ochish', web_app: { url: process.env.WEBAPP_URL } }]], resize_keyboard: true } }));
  bot.on('polling_error', err => console.error('Telegram polling:', err.message));
}
