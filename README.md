# Mandarin Nasiya — Telegram Mini App

## Tayyor funksiyalar
Mijoz katalogi, nasiya hisoblash, ariza yuborish va holatini ko‘rish. Telegram orqali tekshirilgan admin panel: mahsulot qo‘shish/yashirish, ustama sozlash, ariza statusini o‘zgartirish. Narxlar so‘mda. **Bu MVP:** to‘lov shartlari taxminiy, hamkor kredit API'lari ulanmagan.

## GitHub
1. github.com → New repository → `mandarin-nasiya` → Create.
2. ZIP'ni oching va **ichidagi** fayllarni `Add file → Upload files` orqali yuklang.
3. `.env` faylini hech qachon GitHub'ga yuklamang.

## Render
1. render.com → New → Web Service → GitHub repository'ni tanlang.
2. Runtime Node, Build command `npm install`, Start command `npm start`.
3. Environment variables: `BOT_TOKEN` (maxfiy), `ADMIN_IDS` (Telegram raqamli user ID), `WEBAPP_URL` (Render HTTPS manzili).
4. Deploy. Telegram botga `/start` yuboring.
5. BotFather → /mybots → Bot Settings → Menu Button orqali HTTPS manzilni qo‘shing.

**Eslatma:** SQLite ma'lumotlar bazasi Render'ning vaqtinchalik diskida deploy/restart paytida yo‘qolishi mumkin. Ishlab chiqarish uchun doimiy disk yoki PostgreSQL va zaxira nusxalar zarur. Bitta bot token bilan boshqa serverda polling ishlayotgan bo‘lsa, uni o‘chiring. Mijozlarning pasport, karta raqami, CVV yoki yuz suratlarini bu ilovaga yig‘mang. Kredit identifikatsiyasini faqat tasdiqlangan hamkor tizimida amalga oshiring.
