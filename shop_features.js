module.exports = function mountShopFeatures({ app, db, auth, admin, staff }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cart_items(
      telegram_id TEXT NOT NULL, product_id INTEGER NOT NULL, qty INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(telegram_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS referrals(
      telegram_id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, referred_by TEXT NOT NULL DEFAULT '',
      bonus INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bonus_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT, telegram_id TEXT NOT NULL, amount INTEGER NOT NULL,
      reason TEXT NOT NULL, ref_id TEXT NOT NULL DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sales_attribution(
      application_id INTEGER PRIMARY KEY, seller_id TEXT NOT NULL DEFAULT '', seller_name TEXT NOT NULL DEFAULT ''
    );
  `);
  const codeFor = id => 'MD' + String(id).replace(/[^0-9]/g, '').slice(-8).padStart(8, '0');
  const ensureReferral = id => {
    let r = db.prepare('SELECT * FROM referrals WHERE telegram_id=?').get(String(id));
    if (!r) {
      const code = codeFor(id);
      db.prepare('INSERT OR IGNORE INTO referrals(telegram_id,code) VALUES(?,?)').run(String(id), code);
      r = db.prepare('SELECT * FROM referrals WHERE telegram_id=?').get(String(id));
    }
    return r;
  };
  app.get('/api/features/cart', auth, (req,res) => {
    if(req.authType!=='telegram') return res.status(403).json({error:'Telegram ichida oching.'});
    const id=String(req.user.id);
    res.json(db.prepare('SELECT c.product_id id,c.qty,p.name,p.price,p.stock,p.image,p.images FROM cart_items c JOIN products p ON p.id=c.product_id WHERE c.telegram_id=? AND p.active=1 ORDER BY c.created_at DESC').all(id));
  });
  app.post('/api/features/cart/:id', auth, (req,res) => {
    if(req.authType!=='telegram') return res.status(403).json({error:'Telegram ichida oching.'});
    const id=Number(req.params.id), qty=Math.max(1,Math.min(20,Number(req.body.qty)||1));
    const p=db.prepare('SELECT id,stock,active FROM products WHERE id=?').get(id);
    if(!p||!p.active) return res.status(404).json({error:'Mahsulot topilmadi.'});
    if(p.stock<1) return res.status(400).json({error:'Mahsulot omborda yo‘q.'});
    db.prepare('INSERT INTO cart_items(telegram_id,product_id,qty) VALUES(?,?,?) ON CONFLICT(telegram_id,product_id) DO UPDATE SET qty=MIN(20,cart_items.qty+excluded.qty)').run(String(req.user.id),id,qty);
    res.json({ok:true});
  });
  app.patch('/api/features/cart/:id', auth, (req,res) => {
    if(req.authType!=='telegram') return res.status(403).json({error:'Telegram ichida oching.'});
    const id=Number(req.params.id), qty=Math.max(0,Math.min(20,Number(req.body.qty)||0));
    if(qty===0) db.prepare('DELETE FROM cart_items WHERE telegram_id=? AND product_id=?').run(String(req.user.id),id);
    else db.prepare('UPDATE cart_items SET qty=? WHERE telegram_id=? AND product_id=?').run(qty,String(req.user.id),id);
    res.json({ok:true});
  });
  app.delete('/api/features/cart', auth, (req,res) => { if(req.authType!=='telegram') return res.status(403).json({error:'Telegram ichida oching.'}); db.prepare('DELETE FROM cart_items WHERE telegram_id=?').run(String(req.user.id)); res.json({ok:true}); });
  app.get('/api/features/referral', auth, (req,res) => {
    const id=String(req.user.id), r=ensureReferral(id);
    const invited=db.prepare('SELECT COUNT(*) n FROM referrals WHERE referred_by=?').get(id).n;
    const points=db.prepare('SELECT COALESCE(SUM(amount),0) n FROM bonus_ledger WHERE telegram_id=?').get(id).n;
    res.json({code:r.code,invited,points,link:(process.env.WEBAPP_URL||'')+'?startapp=ref_'+r.code});
  });
  app.post('/api/features/referral/apply', auth, (req,res) => {
    const id=String(req.user.id), code=String(req.body.code||'').trim().toUpperCase();
    const owner=db.prepare('SELECT telegram_id FROM referrals WHERE code=?').get(code);
    if(!owner||owner.telegram_id===id) return res.status(400).json({error:'Referal kod noto‘g‘ri.'});
    ensureReferral(id);
    const own=db.prepare('SELECT referred_by FROM referrals WHERE telegram_id=?').get(id);
    if(own.referred_by) return res.status(400).json({error:'Referal avval ishlatilgan.'});
    const tx=db.transaction(()=>{
      db.prepare('UPDATE referrals SET referred_by=? WHERE telegram_id=?').run(owner.telegram_id,id);
      db.prepare('INSERT INTO bonus_ledger(telegram_id,amount,reason,ref_id) VALUES(?,10000,?,?)').run(id,'Referal orqali ro‘yxatdan o‘tish',owner.telegram_id);
      db.prepare('INSERT INTO bonus_ledger(telegram_id,amount,reason,ref_id) VALUES(?,10000,?,?)').run(owner.telegram_id,'Do‘st taklif qilgani uchun',id);
    }); tx();
    res.json({ok:true,message:'Referal qabul qilindi. 10 000 bonus yozildi.'});
  });
  app.get('/api/features/leaderboard', auth, (req,res) => {
    res.json(db.prepare(`SELECT s.seller_id id,COALESCE(NULLIF(s.seller_name,''),u.name,'Xodim') name,
      COUNT(*) sales,COALESCE(SUM(a.total),0) revenue
      FROM sales_attribution s JOIN applications a ON a.id=s.application_id
      LEFT JOIN users u ON u.telegram_id=s.seller_id
      WHERE a.status IN ('approved','preparing','shipping','delivered')
      GROUP BY s.seller_id,s.seller_name,u.name ORDER BY sales DESC,revenue DESC LIMIT 20`).all());
  });
  app.get('/api/admin/features/analytics', auth, admin, (req,res) => {
    res.json({
      cartItems:db.prepare('SELECT COALESCE(SUM(qty),0) n FROM cart_items').get().n,
      cartUsers:db.prepare('SELECT COUNT(DISTINCT telegram_id) n FROM cart_items').get().n,
      referrals:db.prepare('SELECT COUNT(*) n FROM referrals WHERE referred_by!=""').get().n,
      bonusIssued:db.prepare('SELECT COALESCE(SUM(amount),0) n FROM bonus_ledger').get().n,
      topProducts:db.prepare('SELECT p.name,COUNT(c.telegram_id) adds,COALESCE(SUM(c.qty),0) qty FROM cart_items c JOIN products p ON p.id=c.product_id GROUP BY p.id ORDER BY qty DESC LIMIT 5').all()
    });
  });
  app.post('/api/admin/features/sales/:id/assign', auth, staff, (req,res) => {
    const appId=Number(req.params.id), seller=String(req.body.seller_id||'').trim(), name=String(req.body.seller_name||'').trim().slice(0,80);
    if(!/^\\d{5,15}$/.test(seller)) return res.status(400).json({error:'Xodim Telegram ID raqami noto‘g‘ri.'});
    if(!db.prepare('SELECT 1 FROM applications WHERE id=?').get(appId)) return res.status(404).json({error:'Ariza topilmadi.'});
    db.prepare('INSERT INTO sales_attribution(application_id,seller_id,seller_name) VALUES(?,?,?) ON CONFLICT(application_id) DO UPDATE SET seller_id=excluded.seller_id,seller_name=excluded.seller_name').run(appId,seller,name);
    res.json({ok:true});
  });
};
