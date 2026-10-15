(function () {
  var $ = function (id) { return document.getElementById(id); };
  var msg = function (t) { $('msg').textContent = t; };
  var fmt = function (d) { return d ? new Date(d).toLocaleDateString('tr-TR') : '-'; };

  function api(method, path, body) {
    return fetch('/api/admin' + path, {
      method: method,
      headers: { 'x-admin-key': $('key').value.trim(), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function render(users) {
    var t = $('tbl');
    t.textContent = '';
    var head = t.insertRow();
    ['Kullanıcı', 'Ad', 'Son etkinlik', 'Kayıt', 'Mesaj', 'Sohbet', ''].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; head.appendChild(th);
    });
    users.forEach(function (u) {
      var tr = t.insertRow();
      [u.handle, u.display_name, fmt(u.last_active_at), fmt(u.created_at), u.message_count, u.chat_count].forEach(function (v) {
        tr.insertCell().textContent = String(v);
      });
      var b = document.createElement('button');
      b.textContent = 'Sil'; b.className = 'danger';
      b.onclick = function () {
        if (!confirm('"' + u.handle + '" kalıcı olarak silinsin mi? Gönderdiği tüm mesajlar da silinir.')) return;
        api('DELETE', '/users/' + encodeURIComponent(u.id)).then(function (r) {
          msg(u.handle + ' silindi (' + r.deletedMessages + ' mesaj, ' + r.deletedChats + ' sohbet).');
          list();
        }).catch(function (e) { msg('Hata: ' + e.message); });
      };
      tr.insertCell().appendChild(b);
    });
  }

  function daysParam() { var v = parseInt($('days').value, 10); return isFinite(v) && v > 0 ? v : null; }

  function list() {
    var d = daysParam();
    return api('GET', '/users' + (d ? '?inactiveDays=' + d : '?limit=1000')).then(function (r) {
      msg(r.count + ' kullanıcı' + (d ? ' (' + d + '+ gündür pasif)' : ''));
      render(r.users);
    }).catch(function (e) { msg('Hata: ' + e.message); });
  }

  var REASONS = { SPAM: 'Spam', HARASSMENT: 'Taciz', HATE: 'Nefret söylemi', SEXUAL: 'Cinsel içerik', VIOLENCE: 'Şiddet', FAKE: 'Sahte hesap', OTHER: 'Diğer' };

  function describe(r) {
    var s = r.snapshot || {};
    var parts = [];
    if (r.message_id) {
      parts.push('[' + (s.type || 'MESAJ') + '] ' + (s.text != null ? s.text : (s.encrypted ? '(şifreli' + (s.reporterProvidedText ? '; şikayetçinin ilettiği metin: ' + s.reporterProvidedText : '') + ')' : '')));
      if (s.mediaFilename) parts.push('dosya: ' + s.mediaFilename);
    }
    if (r.details) parts.push('not: ' + r.details);
    return parts.join(' | ') || '-';
  }

  function action(tr, label, cls, r, act, confirmText) {
    var b = document.createElement('button');
    b.textContent = label; if (cls) b.className = cls;
    b.onclick = function () {
      if (confirmText && !confirm(confirmText)) return;
      api('POST', '/reports/' + encodeURIComponent(r.id) + '/resolve', { action: act }).then(function () {
        msg('Şikayet sonuçlandırıldı: ' + label); reportsList(r._all);
      }).catch(function (e) { msg('Hata: ' + e.message); });
    };
    tr.lastChild.appendChild(b);
  }

  function renderReports(rows, all) {
    var t = $('tbl');
    t.textContent = '';
    var head = t.insertRow();
    ['Tarih', 'Neden', 'Şikayet eden', 'Şikayet edilen', 'İçerik', 'Durum', 'İşlem'].forEach(function (h) {
      var th = document.createElement('th'); th.textContent = h; head.appendChild(th);
    });
    rows.forEach(function (r) {
      r._all = all;
      var tr = t.insertRow();
      [fmt(r.created_at), REASONS[r.reason] || r.reason, '@' + r.reporter_handle,
        '@' + r.target_handle + ' (' + r.target_report_count + ' şikayet)', describe(r), r.status].forEach(function (v) {
        tr.insertCell().textContent = String(v);
      });
      var cell = tr.insertCell();
      if (r.has_evidence_media) {
        var a = document.createElement('button');
        a.textContent = 'Medyayı indir';
        a.onclick = function () {
          fetch('/api/admin/reports/' + encodeURIComponent(r.id) + '/media', { headers: { 'x-admin-key': $('key').value.trim() } })
            .then(function (x) { if (!x.ok) throw new Error('HTTP ' + x.status); return x.blob(); })
            .then(function (blob) {
              var link = document.createElement('a');
              link.href = URL.createObjectURL(blob); link.download = 'kanit_' + r.id; link.click();
            }).catch(function (e) { msg('Hata: ' + e.message); });
        };
        cell.appendChild(a);
      }
      if (r.status === 'OPEN') {
        action(tr, 'İhlal yok', '', r, 'DISMISS');
        if (r.message_id) action(tr, 'Mesajı sil', 'danger', r, 'REMOVE_MESSAGE', 'Mesaj herkesten silinsin mi?');
        action(tr, 'Kullanıcıyı sil', 'danger', r, 'DELETE_USER', '@' + r.target_handle + ' kalıcı olarak silinsin mi?');
      }
    });
  }

  function reportsList(all) {
    return api('GET', '/reports?status=' + (all ? 'ALL' : 'OPEN')).then(function (r) {
      msg(r.count + ' şikayet' + (all ? '' : ' (açık)'));
      renderReports(r.reports, all);
    }).catch(function (e) { msg('Hata: ' + e.message); });
  }
  $('reports').onclick = function () { reportsList(false); };
  $('reportsAll').onclick = function () { reportsList(true); };

  $('list').onclick = list;
  $('stats').onclick = function () {
    api('GET', '/stats').then(function (s) {
      msg('Kullanıcı: ' + s.users + ' | Sohbet: ' + s.chats + ' | Mesaj: ' + s.messages + ' | Son 30 günde aktif: ' + s.active_30d + ' | Açık şikayet: ' + s.open_reports);
    }).catch(function (e) { msg('Hata: ' + e.message); });
  };
  $('purgeDry').onclick = function () {
    var d = daysParam(); if (!d) { msg('Önce pasiflik gün sayısını girin (en az 30).'); return; }
    api('POST', '/users/purge-inactive', { days: d }).then(function (r) {
      msg('ÖNİZLEME: ' + r.wouldDelete + ' kullanıcı silinecekti. Hiçbir şey silinmedi.');
      render(r.users);
    }).catch(function (e) { msg('Hata: ' + e.message); });
  };
  $('purgeReal').onclick = function () {
    var d = daysParam(); if (!d) { msg('Önce pasiflik gün sayısını girin (en az 30).'); return; }
    if (!confirm(d + '+ gündür pasif TÜM kullanıcılar ve mesajları kalıcı silinsin mi?')) return;
    api('POST', '/users/purge-inactive', { days: d, dryRun: false, confirm: 'DELETE' }).then(function (r) {
      msg(r.deletedUsers + ' kullanıcı, ' + r.deletedChats + ' sohbet silindi.');
      list();
    }).catch(function (e) { msg('Hata: ' + e.message); });
  };
})();
