/*
  Mandarin Nasiya — yangilash skripti.
  Ishlatish (loyiha papkasida):   node patch.js
  Yoki yo'l bilan:                node patch.js server.js public/index.html

  Hamma o'zgartirish yoki umuman qo'llanmaydi (xato bo'lsa fayllarga tegmaydi).
  Eski fayllar .bak nomi bilan saqlanadi.
*/
const fs = require('fs');
const R = String.raw;

const FILES = { server: process.argv[2] || 'server.js', html: process.argv[3] || 'public/index.html' };

const E = [];
const add = (f, name, find, rep) => E.push({ f, name, find, rep });

/* ====================== SERVER.JS ====================== */

add('server', 'users.credit_limit ustuni',
  R`['users', 'note', "TEXT NOT NULL DEFAULT ''"],`,
  R`['users', 'note', "TEXT NOT NULL DEFAULT ''"], ['users', 'credit_limit', 'INTEGER NOT NULL DEFAULT 0'],`);

add('server', 'Kassir roli (roleOf)',
  R`const roleOf = req => req.authType === 'web' ? 'admin' : adminIds().includes(String(req.user && req.user.id)) ? 'admin' : staffIds().includes(String(req.user && req.user.id)) ? 'manager' : '';`,
  R`const cashierIds = () => (process.env.CASHIER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
const roleOf = req => req.authType === 'web' ? 'admin' : adminIds().includes(String(req.user && req.user.id)) ? 'admin' : staffIds().includes(String(req.user && req.user.id)) ? 'manager' : cashierIds().includes(String(req.user && req.user.id)) ? 'cashier' : '';`);

add('server', 'Kassir middleware',
  R`function staff(req, res, next) { if (req.authType === 'telegram' && staffIds().includes(String(req.user.id))) return next(); return admin(req, res, next); }`,
  R`function staff(req, res, next) { if (req.authType === 'telegram' && staffIds().includes(String(req.user.id))) return next(); return admin(req, res, next); }
function cashier(req, res, next) { if (req.authType === 'telegram' && cashierIds().includes(String(req.user.id))) return next(); return staff(req, res, next); }`);

add('server', 'Limit yordamchi funksiyalari',
  R`function notifyAll(ids, text) {`,
  R`const limitFor = uid => { const u = db.prepare('SELECT credit_limit FROM users WHERE telegram_id=?').get(String(uid)); return u && u.credit_limit > 0 ? u.credit_limit : Number(getSetting('default_limit', '0')); };
const usedCredit = uid => { let s = 0; for (const a of db.prepare("SELECT * FROM applications WHERE telegram_id=? AND pay_type='installment' AND status IN ('new','review','approved','preparing','shipping','delivered')").all(String(uid))) s += a.approved_at ? debtInfo(a).left : a.total; return s; };
function notifyAll(ids, text) {`);

add('server', 'Audit: to‘lov bekor qilish / eksport',
  R`else if (/\/export$/.test(req.path)) t = 'CSV yuklab olindi';`,
  R`else if (/\/export$/.test(req.path)) t = 'CSV yuklab olindi';
    else if (/\/export-payments$/.test(req.path)) t = 'To‘lovlar CSV yuklab olindi';
    else if (req.method === 'DELETE' && /\/payments\/\d+$/.test(req.path)) t = 'To‘lov #' + req.path.split('/').pop() + ' bekor qilindi';`);

add('server', 'Nasiya limiti tekshiruvi',
  R`const dup = db.prepare("SELECT id FROM applications WHERE telegram_id=? AND product_id=? AND variant=? AND status IN ('new','review')").get(uid, p0.id, variant);`,
  R`if (!cash) { const lim = limitFor(uid), used = lim > 0 ? usedCredit(uid) : 0; if (lim > 0 && used + total > lim) return bad('Nasiya limiti ' + money(lim) + ' dan oshib ketadi. Hozirgi qarz va kutilayotgan arizalar: ' + money(used) + '. Avansni oshiring yoki qarzni to‘lab, qayta urining.'); }
  const dup = db.prepare("SELECT id FROM applications WHERE telegram_id=? AND product_id=? AND variant=? AND status IN ('new','review')").get(uid, p0.id, variant);`);

add('server', 'Mijoz uchun to‘lovlar tarixi',
  R`.all(String(req.user.id)).map(x => ({ ...x, ...payInfo(x) })));`,
  R`.all(String(req.user.id)).map(x => ({ ...x, ...payInfo(x), hist: db.prepare('SELECT amount,paid_at FROM payments WHERE app_id=? ORDER BY id DESC LIMIT 24').all(x.id) })));`);

add('server', '/api/me kassir',
  R`admin: staffIds().includes(String(user.id)), role: adminIds().includes(String(user.id)) ? 'admin' : staffIds().includes(String(user.id)) ? 'manager' : '' });`,
  R`admin: [...staffIds(), ...cashierIds()].includes(String(user.id)), role: adminIds().includes(String(user.id)) ? 'admin' : staffIds().includes(String(user.id)) ? 'manager' : cashierIds().includes(String(user.id)) ? 'cashier' : '' });`);

add('server', '/api/admin kassirga ochiq',
  R`app.get('/api/admin', auth, staff, (req, res) => {`,
  R`app.get('/api/admin', auth, cashier, (req, res) => {`);

add('server', 'default_limit javobda',
  R`remind_days: Number(getSetting('remind_days', '3')), promos:`,
  R`remind_days: Number(getSetting('remind_days', '3')), default_limit: Number(getSetting('default_limit', '0')), promos:`);

add('server', 'default_limit sozlamasi',
  R`if (b.remind_days !== undefined) {`,
  R`if (b.default_limit !== undefined) {
    const v = Number(b.default_limit);
    if (!Number.isSafeInteger(v) || v < 0) return res.status(400).json({ error: 'Limit 0 yoki musbat butun son bo‘lsin (0 = cheklovsiz).' });
    setSetting('default_limit', v);
  }
  if (b.remind_days !== undefined) {`);

add('server', 'Mijozlar ro‘yxatida limit',
  R`u.note,u.risky,(SELECT COUNT(*)`,
  R`u.note,u.risky,u.credit_limit,(SELECT COUNT(*)`);

add('server', 'Mijoz limitini saqlash',
  R`res.json({ ok: db.prepare('UPDATE users SET note=?, risky=? WHERE telegram_id=?').run(String(b.note || '').trim().slice(0, 500), b.risky ? 1 : 0, String(req.params.id)).changes > 0 });`,
  R`const lim = roleOf(req) === 'admin' && b.limit !== undefined ? Math.max(0, Math.floor(Number(b.limit) || 0)) : null;
  res.json({ ok: db.prepare('UPDATE users SET note=?, risky=?, credit_limit=COALESCE(?, credit_limit) WHERE telegram_id=?').run(String(b.note || '').trim().slice(0, 500), b.risky ? 1 : 0, lim, String(req.params.id)).changes > 0 });`);

add('server', 'To‘lov qabul qilish kassirga',
  R`app.post('/api/admin/applications/:id/payments', auth, staff, (req, res) => {`,
  R`app.post('/api/admin/applications/:id/payments', auth, cashier, (req, res) => {`);

add('server', 'Qarzdorlar kassirga',
  R`app.get('/api/admin/debtors', auth, staff, (req, res) => {`,
  R`app.get('/api/admin/debtors', auth, cashier, (req, res) => {`);

add('server', 'To‘lovlar tarixi, bekor qilish, CSV',
  R`app.get('/api/admin/stats', auth, admin, (req, res) => {`,
  R`app.get('/api/admin/payments', auth, cashier, (req, res) => res.json(db.prepare('SELECT p.id,p.app_id,p.amount,p.paid_at,p.note,p.taker,a.customer,a.phone FROM payments p LEFT JOIN applications a ON a.id=p.app_id ORDER BY p.id DESC LIMIT 300').all()));
app.delete('/api/admin/payments/:id', auth, admin, (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'To‘lov topilmadi.' });
  db.prepare('DELETE FROM payments WHERE id=?').run(p.id);
  const a = db.prepare('SELECT telegram_id FROM applications WHERE id=?').get(p.app_id);
  if (a) notify(a.telegram_id, 'ℹ️ Ariza #' + p.app_id + ': ' + money(p.amount) + ' miqdoridagi to‘lov yozuvi bekor qilindi (xato kiritilgan edi). Savollar bo‘lsa, biz bilan bog‘laning.');
  res.json({ ok: true });
});
app.post('/api/admin/export-payments', auth, cashier, async (req, res) => {
  if (!bot) return res.status(503).json({ error: 'Bot ulanmagan.' });
  const rows = db.prepare('SELECT p.*, a.customer, a.phone FROM payments p LEFT JOIN applications a ON a.id=p.app_id ORDER BY p.id DESC').all();
  const q = v => { let t = String(v == null ? '' : v); if (/^[=@]|^[+\-](?![\d\s])/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
  const head = ['ID', 'Sana (UTC)', 'Ariza', 'Mijoz', 'Telefon', 'Summa', 'Qabul qildi', 'Izoh'];
  const csv = '\ufeff' + [head, ...rows.map(p => [p.id, p.paid_at, p.app_id, p.customer, p.phone, p.amount, p.taker, p.note])].map(r => r.map(q).join(',')).join('\r\n');
  let ok = false;
  for (const id of (req.authType === 'telegram' ? [String(req.user.id)] : adminIds())) {
    try { await bot.sendDocument(id, Buffer.from(csv), { caption: '💵 To‘lovlar (Excel/CSV)' }, { filename: 'tolovlar-' + new Date().toISOString().slice(0, 10) + '.csv', contentType: 'text/csv' }); ok = true; } catch (e) { console.error('ExportPay:', e.message); }
  }
  res.json({ ok });
});
app.get('/api/admin/stats', auth, admin, (req, res) => {`);

/* ====================== INDEX.HTML ====================== */

add('html', 'To‘lovlar chip',
  R`<button class="chip" onclick="aTab('stt',this);loadStats()">📊 Statistika</button>`,
  R`<button class="chip" onclick="aTab('stt',this);loadStats()">📊 Statistika</button><button class="chip" onclick="aTab('pays',this);loadPays()">💵 To‘lovlar</button>`);

add('html', 'To‘lovlar bo‘limi',
  R`<div id="debt" class="hidden"></div><div id="stt" class="hidden"></div>`,
  R`<div id="debt" class="hidden"></div><div id="stt" class="hidden"></div><div id="pays" class="hidden"></div>`);

add('html', 'aTab ro‘yxati',
  R`['add','stock','apps','settings','custs','audit','debt','stt'].forEach`,
  R`['add','stock','apps','settings','custs','audit','debt','stt','pays'].forEach`);

add('html', 'Rolga qarab bo‘limlarni yashirish',
  R`[1,2,3,5,7].forEach(function(i){if(ch[i])ch[i].classList.toggle('hidden',A.role==='manager')})`,
  R`var hide=A.role==='cashier'?[1,2,3,4,5,7]:A.role==='manager'?[1,2,3,5,7]:[];for(var hi=0;hi<ch.length;hi++)ch[hi].classList.toggle('hidden',hide.indexOf(hi)>-1)`);

add('html', 'Standart limit maydoni qiymati',
  R`$('remD').value=A.remind_days;`,
  R`$('remD').value=A.remind_days;$('dLim').value=A.default_limit||0;$('clrBtn').classList.toggle('hidden',A.role!=='admin');`);

add('html', 'Standart limit kartasi',
  R`<div class="card"><h2>Reklama matni</h2>`,
  R`<div class="card"><h2>💳 Standart nasiya limiti</h2><p class="muted">Har bir mijoz uchun umumiy qarz (joriy qarz + kutilayotgan arizalar + yangi ariza) shu summadan oshmasin. 0 = cheklovsiz. Alohida mijozga “Mijozlar” bo‘limida boshqa limit qo‘yish mumkin.</p><label>Limit (so‘m)</label><input id="dLim" type="number" min="0"><button onclick="saveS('limit')" style="width:100%">Saqlash</button></div>
<div class="card"><h2>Reklama matni</h2>`);

add('html', 'saveS limit',
  R`if(k==='promo')b.promo=$('promoIn').value;`,
  R`if(k==='promo')b.promo=$('promoIn').value;if(k==='limit')b.default_limit=Number($('dLim').value||0);`);

add('html', 'Kassirga holat o‘zgartirishni yashirish (boshi)',
  R`+dlv(x)+'<select id="st'+x.id+'">'+o+'</select>`,
  R`+dlv(x)+(A.role==='cashier'?'':'<select id="st'+x.id+'">'+o+'</select>`);

add('html', 'Kassirga holat o‘zgartirishni yashirish (oxiri)',
  R`Holatni saqlash</button></div>'}).join('')||'<div class="card">Ariza topilmadi.</div>'`,
  R`Holatni saqlash</button>')+(A.role==='admin'?'<button class="danger" style="width:100%;margin-top:8px" onclick="delApp('+x.id+')">🗑 Arizani o‘chirish</button>':'')+'</div>'}).join('')||'<div class="card">Ariza topilmadi.</div>'`);

add('html', 'Ishlamaydigan pasport/karta tugmasini olib tashlash',
  R`+(x.has_secret?'<p class="muted">🪪 Pasport · 💳 ****'+esc(x.card_last4)+' · 📞 '+esc(x.card_phone)+'</p><button class="sec" style="width:100%;margin-bottom:8px" onclick="showSecret('+x.id+')">👁 Pasport va kartani ko‘rish</button>':'')`,
  R``);

add('html', 'Mijozlar: limit maydoni',
  R`'</textarea><label style="display:flex;gap:8px"><input type="checkbox" id="cr'`,
  R`'</textarea>'+(A.role==='admin'?'<label>💳 Nasiya limiti (so‘m, 0 = standart)</label><input id="cl'+u.id+'" type="number" min="0" value="'+(u.credit_limit||0)+'">':'')+'<label style="display:flex;gap:8px"><input type="checkbox" id="cr'`);

add('html', 'Mijozlar: limitni yuborish',
  R`body:JSON.stringify({note:$('cn'+id).value,risky:$('cr'+id).checked})`,
  R`body:JSON.stringify({note:$('cn'+id).value,risky:$('cr'+id).checked,limit:($('cl'+id)?Number($('cl'+id).value||0):undefined)})`);

add('html', 'Qarzdorlarni saralash',
  R`async function loadDebt(){try{var d=await api('/api/admin/debtors');$('debt').innerHTML=(d.length?'`,
  R`var DB_=[],dsort='days';
async function loadDebt(){try{DB_=await api('/api/admin/debtors');renderDebt()}catch(e){say(e.message)}}
function renderDebt(){try{var d=DB_.slice().sort(function(a,b){return dsort==='sum'?b.overdue-a.overdue:b.days-a.days});$('debt').innerHTML=(d.length?'<select onchange="dsort=this.value;renderDebt()"><option value="days"'+(dsort==='days'?' selected':'')+'>Kun bo‘yicha (eng uzoq kechikkan)</option><option value="sum"'+(dsort==='sum'?' selected':'')+'>Summa bo‘yicha (eng ko‘p qarz)</option></select>':'')+(d.length?'`);

add('html', 'Mijoz: to‘lovlar tarixi',
  R`(x.next_due?'<br>📅 Keyingi to‘lov: '+esc(x.next_due):'')+'</p>':'')+`,
  R`(x.next_due?'<br>📅 Keyingi to‘lov: '+esc(x.next_due):'')+'</p>':'')+(x.hist&&x.hist.length?'<details><summary>🧾 To‘lovlar tarixi</summary>'+x.hist.map(function(h){return '<div class="sc"><span>'+esc(String(h.paid_at).slice(0,10))+'</span><b>'+money(h.amount)+'</b></div>'}).join('')+'</details>':'')+`);

add('html', 'To‘lovlar bo‘limi funksiyalari',
  R`var CU=[];`,
  R`var PY=[];
async function loadPays(){try{PY=await api('/api/admin/payments');var tot=PY.reduce(function(s,p){return s+p.amount},0);$('pays').innerHTML='<button class="sec" style="width:100%;margin-bottom:8px" onclick="exportPays()">📊 To‘lovlarni Excel (CSV) qilib yuborish</button><div class="card">Oxirgi '+PY.length+' ta to‘lov · jami <b>'+money(tot)+'</b></div>'+(PY.map(function(p){return '<div class="card" style="padding:10px"><b>'+money(p.amount)+'</b> · #'+p.app_id+' '+esc(p.customer||'')+'<div class="muted">'+esc(p.paid_at)+' (UTC) · '+esc(p.taker||'')+(p.note?' · '+esc(p.note):'')+'</div>'+(A.role==='admin'?'<button class="danger" style="width:100%;margin-top:6px" onclick="delPay('+p.id+')">↩️ Bekor qilish</button>':'')+'</div>'}).join('')||'<div class="card">To‘lovlar hali yo‘q.</div>')}catch(e){say(e.message)}}
async function delPay(id){if(!confirm('Bu to‘lov yozuvi bekor qilinsinmi? Mijozning qarzi shu summaga qaytadi.'))return;try{await api('/api/admin/payments/'+id,{method:'DELETE'});A=await api('/api/admin');fillA();aTab('pays',document.querySelectorAll('#admin .chips .chip')[8]);await loadPays();say('↩️ To‘lov bekor qilindi, mijozga xabar yuborildi.')}catch(e){say(e.message)}}
async function exportPays(){try{var d=await api('/api/admin/export-payments',{method:'POST'});say(d.ok?'📊 Fayl Telegramga yuborildi.':'Yuborib bo‘lmadi. Botga /start yuborganingizni tekshiring.')}catch(e){say(e.message)}}
async function delApp(id){if(!confirm('Ariza #'+id+' butunlay o‘chirilsinmi? Unga tegishli to‘lov yozuvlari ham o‘chadi. Qaytarib bo‘lmaydi.'))return;try{await api('/api/admin/applications/'+id,{method:'DELETE'});await refresh('apps',0);say('🗑 Ariza o‘chirildi.')}catch(e){say(e.message)}}
async function clearRejected(){if(!confirm('Rad etilgan hamma arizalar o‘chirilsinmi? Qaytarib bo‘lmaydi.'))return;try{var d=await api('/api/admin/applications',{method:'DELETE'});await refresh('apps',0);say('🗑 '+d.count+' ta rad etilgan ariza o‘chirildi.')}catch(e){say(e.message)}}
var CU=[];`);


/* ---- Arizalarni o'chirish + qo'ng'iroq raqami ---- */
add('server', 'Qo‘llab-quvvatlash raqami',
  R`const money = n => Number(n).toLocaleString('ru-RU') + ' so‘m';`,
  R`const money = n => Number(n).toLocaleString('ru-RU') + ' so‘m';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '+998 91 623 56 55';`);

add('server', 'Audit: ariza o‘chirildi',
  R`if (m && m[1] === 'applications') t = /\/payments$/.test(req.path) ?`,
  R`if (m && m[1] === 'applications') t = req.method === 'DELETE' ? 'Ariza #' + id + ' o‘chirildi' : /\/payments$/.test(req.path) ?`);

add('server', 'Arizani o‘chirish API',
  R`app.post('/api/admin/settings', auth, admin, (req, res) => {`,
  R`const deleteApp = db.transaction(id => {
  const a = db.prepare('SELECT * FROM applications WHERE id=?').get(id);
  if (!a) return false;
  if (a.stock_taken) adjStock(a, 1);
  db.prepare('DELETE FROM payments WHERE app_id=?').run(id);
  db.prepare('DELETE FROM applications WHERE id=?').run(id);
  return true;
});
app.delete('/api/admin/applications/:id', auth, admin, (req, res) => {
  if (!deleteApp(Number(req.params.id))) return res.status(404).json({ error: 'Ariza topilmadi.' });
  res.json({ ok: true });
});
app.delete('/api/admin/applications', auth, admin, (req, res) => {
  const ids = db.prepare("SELECT id FROM applications WHERE status='rejected'").all().map(r => r.id);
  ids.forEach(i => deleteApp(i));
  res.json({ ok: true, count: ids.length });
});
app.post('/api/admin/settings', auth, admin, (req, res) => {`);

add('server', 'Mijozga ariza qabul qilindi xabari',
  R`staffIds().forEach(id => notify(id, msg));`,
  R`staffIds().forEach(id => notify(id, msg));
  notify(uid, '✅ Arizangiz qabul qilindi (#' + r.lastInsertRowid + '). Tez orada siz bilan bog‘lanamiz.\n📞 Agar javob kelmasa, qo‘ng‘iroq qiling: ' + SUPPORT_PHONE);`);

add('server', 'Ariza javobida raqam',
  R`res.json({ id: r.lastInsertRowid, status: 'new' });`,
  R`res.json({ id: r.lastInsertRowid, status: 'new', support: SUPPORT_PHONE });`);

add('html', 'Arizalar: rad etilganlarni tozalash tugmasi',
  R`<div id="apps"><button class="sec" style="width:100%;margin-bottom:8px" onclick="exportCsv()">📊 Excel (CSV) ni Telegramga yuborish</button>`,
  R`<div id="apps"><button class="sec" style="width:100%;margin-bottom:8px" onclick="exportCsv()">📊 Excel (CSV) ni Telegramga yuborish</button><button id="clrBtn" class="danger hidden" style="width:100%;margin-bottom:8px" onclick="clearRejected()">🗑 Rad etilgan arizalarni hammasini o‘chirish</button>`);

add('html', 'Ariza yuborilgach qo‘ng‘iroq raqami',
  R`say('✅ Arizangiz qabul qilindi! Raqami: #'+d.id)`,
  R`say('✅ Arizangiz qabul qilindi! Raqami: #'+d.id+'\n📞 Agar javob kelmasa, qo‘ng‘iroq qiling: '+(d.support||'+998 91 623 56 55'))`);

add('html', 'Arizalarim: qo‘ng‘iroq kartasi',
  R`<div id="v-mine" class="hidden"><h2>📋 Arizalarim</h2><div id="mineList"></div></div>`,
  R`<div id="v-mine" class="hidden"><h2>📋 Arizalarim</h2><div class="card">📞 Javob kelmasa, qo‘ng‘iroq qiling: <a href="tel:+998916235655">+998 91 623 56 55</a></div><div id="mineList"></div></div>`);

/* ====================== QO'LLASH ====================== */
const src = {};
for (const k of Object.keys(FILES)) {
  if (!fs.existsSync(FILES[k])) { console.error('❌ Fayl topilmadi: ' + FILES[k]); process.exit(1); }
  src[k] = fs.readFileSync(FILES[k], 'utf8');
}
const errors = [], out = { ...src };
let applied = 0, skipped = 0;
for (const e of E) {
  const s = out[e.f], n = s.split(e.find).length - 1;
  if (n === 1) { out[e.f] = s.replace(e.find, () => e.rep); applied++; }
  else if (n === 0 && e.rep && s.includes(e.rep)) { skipped++; }
  else errors.push('• [' + FILES[e.f] + '] ' + e.name + (n === 0 ? ' — joy topilmadi' : ' — ' + n + ' ta joy topildi (bittadan ko‘p)'));
}
if (errors.length) {
  console.error('❌ Quyidagi o‘zgartirishlar qo‘llanmadi, fayllarga TEGILMADI:\n' + errors.join('\n'));
  console.error('\nSabab: fayllaringiz men ko‘rgan versiyadan farq qiladi. Fayllarni chatga fayl qilib yuboring.');
  process.exit(1);
}
for (const k of Object.keys(FILES)) {
  if (out[k] !== src[k]) { fs.writeFileSync(FILES[k] + '.bak', src[k]); fs.writeFileSync(FILES[k], out[k]); }
}
console.log('✅ Tayyor. Qo‘llandi: ' + applied + ', allaqachon bor edi: ' + skipped + '. Eski fayllar .bak nomida saqlandi.');
console.log('Kassir qo‘shish uchun Render Environment ga qo‘shing:  CASHIER_IDS=123456789,987654321');
