(function () {
  'use strict';
  if (document.getElementById('channels')) return;

  var panel = document.createElement('div');
  panel.id = 'channels';
  panel.className = 'hidden';
  panel.innerHTML =
    '<div class="card">' +
      '<h2>📢 Telegram kanalidan omborga avtomatik qo‘shish</h2>' +
      '<p class="muted">Bot admin qilingan kanaldagi yangi rasmli postlarni o‘qiydi. Post izohida model nomi va narx bo‘lishi shart. Masalan: iPhone 13 Pro<br>Narxi: $450<br>Soni: 2 ta</p>' +
      '<label>Kanal username yoki ID</label>' +
      '<input id="channelId" placeholder="@kanal_nomi yoki -1001234567890" autocomplete="off">' +
      '<button id="channelAddBtn" style="width:100%" onclick="addChannel()">➕ Kanalni ulash</button>' +
      '<div id="channelMsg" class="muted" style="margin-top:8px;white-space:pre-wrap"></div>' +
    '</div>' +
    '<div class="card">' +
      '<div class="ahead"><h2>Ulangan kanallar</h2><button class="sec" onclick="loadChannels()">🔄 Yangilash</button></div>' +
      '<div id="channelList"><p class="muted">Yuklanmoqda…</p></div>' +
    '</div>' +
    '<div class="card">' +
      '<b>Qanday ishlaydi?</b>' +
      '<ol class="muted" style="padding-left:20px">' +
        '<li>Botni Telegram kanalingizga administrator qilib qo‘shing.</li>' +
        '<li>Botga kanal postlarini ko‘rish imkonini bering.</li>' +
        '<li>Yuqoriga kanal username yoki ID sini kiriting.</li>' +
        '<li>Yangi mahsulotni rasm bilan, model va narx yozilgan izoh orqali joylang.</li>' +
        '<li>Bot mahsulotni katalog/omborga avtomatik qo‘shadi va adminlarga xabar beradi.</li>' +
      '</ol>' +
      '<p class="muted">Muhim: bot kanalga ulanganidan keyin joylangan yangi postlar import qilinadi. Oldingi postlar Telegram Bot API orqali avtomatik o‘qilmaydi. Birinchi qatorga mahsulot nomini, narxga esa $450 yoki 5 500 000 so‘m kabi aniq format yozing.</p>' +
    '</div>';
  document.getElementById('aBody').appendChild(panel);

  if (window.SECS && SECS.indexOf('channels') < 0) SECS.push('channels');
  if (window.TITLES) TITLES.channels = '📢 Kanal';
  if (window.ROLES) ROLES.channels = 'admin';
  if (window.TILES && !TILES.some(function (x) { return x[0] === 'channels'; })) TILES.push(['channels', '📢']);

  var originalOpenSec = window.openSec;
  window.openSec = function (name) {
    originalOpenSec(name);
    if (name === 'channels') window.loadChannels();
  };

  window.loadChannels = async function () {
    var list = document.getElementById('channelList');
    if (!list) return;
    list.innerHTML = '<p class="muted">Yuklanmoqda…</p>';
    try {
      var items = await api('/api/admin/channels');
      if (!items.length) {
        list.innerHTML = '<p class="muted">Hali kanal ulanmagan.</p>';
        return;
      }
      list.innerHTML = items.map(function (item) {
        return '<div class="sc" style="align-items:center;gap:10px">' +
          '<div style="min-width:0;flex:1"><b>' + esc(item.title || item.id) + '</b>' +
          '<div class="muted">ID: ' + esc(item.id) + ' · Import qilingan postlar: ' + Number(item.imported || 0) + '</div></div>' +
          '<button class="danger" style="flex:none;padding:8px 10px" onclick="removeChannel(' + JSON.stringify(String(item.id)) + ')">O‘chirish</button>' +
          '</div>';
      }).join('');
    } catch (e) {
      list.innerHTML = '<p class="muted">Kanal ro‘yxatini olishda xatolik: ' + esc(e.message) + '</p>';
    }
  };

  window.addChannel = async function () {
    var input = document.getElementById('channelId');
    var button = document.getElementById('channelAddBtn');
    var msg = document.getElementById('channelMsg');
    var id = input.value.trim();
    if (!id) { msg.textContent = 'Kanal username yoki ID sini kiriting.'; return; }
    button.disabled = true;
    msg.textContent = 'Kanal tekshirilmoqda…';
    try {
      var result = await api('/api/admin/channels', {
        method: 'POST',
        body: JSON.stringify({ id: id })
      });
      msg.textContent = '✅ Ulandi: ' + (result.title || result.id);
      input.value = '';
      await loadChannels();
    } catch (e) {
      msg.textContent = '❌ ' + e.message + '\nBotni kanalga administrator qilib qo‘shganingizni tekshiring.';
    } finally {
      button.disabled = false;
    }
  };

  window.removeChannel = async function (id) {
    if (!confirm('Ushbu kanalni avtomatik importdan uzasizmi?')) return;
    try {
      await api('/api/admin/channels/' + encodeURIComponent(id), { method: 'DELETE' });
      await loadChannels();
    } catch (e) {
      alert(e.message);
    }
  };
})();