/* TempMail — disposable inbox via the free Guerrilla Mail API.
   Pure logic is exported for headless tests; UI wiring runs in the browser only. */
(function(){
'use strict';

var API = 'https://api.guerrillamail.com/ajax.php';

/* ---------- pure helpers ---------- */
function splitEmail(email){
  var i = (email || '').indexOf('@');
  if(i < 0) return { login: email || '', domain: '' };
  return { login: email.slice(0, i), domain: email.slice(i + 1) };
}
function fmtClock(ts){
  var d = new Date(ts * 1000);
  var h = d.getHours(), m = d.getMinutes();
  var ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if(h === 0) h = 12;
  return h + ':' + (m < 10 ? '0' + m : m) + ' ' + ap;
}
function timeAgo(ts){
  var s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if(s < 60) return 'just now';
  var m = Math.floor(s / 60);
  if(m < 60) return m + 'm ago';
  var h = Math.floor(m / 60);
  if(h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function esc(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function validName(n){
  return /^[a-zA-Z0-9._-]{1,30}$/.test(n || '');
}

/* ---------- API layer ---------- */
function call(params){
  var q = Object.keys(params).map(function(k){
    return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  }).join('&');
  return fetch(API + '?' + q).then(function(r){
    if(!r.ok) throw new Error('net');
    return r.json();
  });
}
function apiGetAddress(){
  return call({ f: 'get_email_address', ip: '127.0.0.1', agent: 'TempMail' });
}
function apiSetUser(sid, name){
  return call({ f: 'set_email_user', email_user: name, sid_token: sid, lang: 'en' });
}
function apiCheck(sid, seq){
  return call({ f: 'check_email', sid_token: sid, seq: seq || 0 });
}
function apiFetch(sid, id){
  return call({ f: 'fetch_email', email_id: id, sid_token: sid });
}

/* ---------- browser UI ---------- */
if(typeof window !== 'undefined' && typeof document !== 'undefined'){
  var $ = function(id){ return document.getElementById(id); };
  var addrEl = $('addr'), inboxEl = $('inbox'), statusEl = $('status'),
      toastEl = $('toast'), toastT = null;
  var sid = localStorage.getItem('tm_sid') || '';
  var email = localStorage.getItem('tm_email') || '';
  var readIds = {};
  var openIds = {};
  var bodyCache = {};
  var lastIds = '';
  var lastCheck = 0;
  var timer = null;

  function toast(msg){
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function(){ toastEl.classList.remove('show'); }, 1800);
  }
  function copyText(t, msg){
    function done(){ toast(msg || 'Copied'); }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(done, function(){ fallback(); });
    } else fallback();
    function fallback(){
      var ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch(e){ toast('Copy failed'); }
      document.body.removeChild(ta);
    }
  }
  function save(){
    localStorage.setItem('tm_sid', sid);
    localStorage.setItem('tm_email', email);
  }
  function setStatus(html){ statusEl.innerHTML = html; }

  function newAddress(){
    setStatus('Creating…');
    apiGetAddress().then(function(d){
      sid = d.sid_token; email = d.email_addr;
      readIds = {}; openIds = {}; bodyCache = {}; lastIds = '';
      save();
      addrEl.textContent = email;
      renderEmpty();
      checkInbox(false);
      toast('New address ready');
    }).catch(function(){
      setStatus('Offline');
      toast('Could not reach mail server');
    });
  }

  function renderEmpty(){
    inboxEl.innerHTML = '<div class="empty">Inbox is empty.<br>Waiting for mail…</div>';
  }

  function mailIds(list){
    return list.map(function(m){ return m.mail_id; }).sort().join(',');
  }

  function checkInbox(force){
    if(!sid){ newAddress(); return; }
    if(force) setStatus('<span class="dotpulse"></span>Checking…');
    apiCheck(sid, 0).then(function(d){
      lastCheck = Date.now();
      var list = d.list || [];
      var ids = mailIds(list);
      if(ids !== lastIds){
        lastIds = ids;
        if(list.length) renderList(list);
        else renderEmpty();
      }
      setStatus('<span class="dotpulse"></span>Live');
    }).catch(function(){
      setStatus('Offline — retrying');
    });
  }

  function makeFrame(html){
    var f = document.createElement('iframe');
    f.setAttribute('sandbox', '');
    f.setAttribute('srcdoc',
      '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' +
      '*{box-sizing:border-box;max-width:100%;}' +
      'html,body{margin:0!important;padding:0!important;overflow-x:hidden!important;}' +
      'body{padding:8px!important;font-family:sans-serif;font-size:14px;line-height:1.6;color:#111;overflow-wrap:anywhere!important;word-break:break-word;}' +
      'img{max-width:100%!important;height:auto!important;}' +
      'table{display:block!important;overflow-x:auto!important;max-width:100%!important;}' +
      'pre{white-space:pre-wrap!important;overflow-wrap:anywhere!important;}' +
      'a{overflow-wrap:anywhere!important;}' +
      '</style>' +
      '</head><body>' + html + '</body></html>');
    f.style.cssText = 'width:100%;max-width:100%;height:52vh;border:0;border-radius:8px;background:#fff;display:block;';
    return f;
  }

  function renderList(list){
    // newest first
    var items = list.slice().sort(function(a, b){
      return (b.mail_timestamp || 0) - (a.mail_timestamp || 0);
    });
    inboxEl.innerHTML = '';
    items.forEach(function(m){
      var id = m.mail_id;
      var isOpen = !!openIds[id];
      var div = document.createElement('div');
      div.className = 'mail' + (readIds[id] ? '' : ' unread') + (isOpen ? ' open' : '');
      div.dataset.id = id;
      var top = document.createElement('div'); top.className = 'mail-top';
      var from = document.createElement('div'); from.className = 'mail-from';
      from.textContent = m.mail_from || '(unknown)';
      var time = document.createElement('div'); time.className = 'mail-time';
      time.textContent = m.mail_timestamp ? timeAgo(m.mail_timestamp) : '';
      top.appendChild(from); top.appendChild(time);
      var sub = document.createElement('div'); sub.className = 'mail-sub';
      sub.textContent = m.mail_subject || '(no subject)';
      var body = document.createElement('div'); body.className = 'mail-body';
      if(isOpen && bodyCache[id]){
        body.dataset.loaded = '1';
        body.appendChild(makeFrame(bodyCache[id]));
      } else {
        body.innerHTML = '<span style="color:var(--muted)">Loading…</span>';
      }
      div.appendChild(top); div.appendChild(sub); div.appendChild(body);
      div.addEventListener('click', function(){ toggleMail(div, id, body); });
      inboxEl.appendChild(div);
    });
  }

  function toggleMail(div, id, bodyEl){
    var opening = !div.classList.contains('open');
    div.classList.toggle('open');
    if(!opening){ delete openIds[id]; return; }
    openIds[id] = true;
    if(bodyEl.dataset.loaded) return;
    if(bodyCache[id]){ showBody(div, id, bodyEl, bodyCache[id]); return; }
    apiFetch(sid, id).then(function(d){
      showBody(div, id, bodyEl, d.mail_body || '');
    }).catch(function(){
      bodyEl.innerHTML = '<span style="color:var(--muted)">Could not load message.</span>';
    });
  }

  function showBody(div, id, bodyEl, html){
    bodyEl.dataset.loaded = '1';
    bodyEl.innerHTML = '';
    bodyCache[id] = html;
    if(!html.trim()){
      bodyEl.textContent = '(empty message)';
    } else {
      bodyEl.appendChild(makeFrame(html));
    }
    readIds[id] = true;
    div.classList.remove('unread');
  }

  $('copy').addEventListener('click', function(){ copyText(email, 'Address copied'); });
  addrEl.addEventListener('click', function(){ copyText(email, 'Address copied'); });
  $('newaddr').addEventListener('click', function(){
    if(confirm('Get a new address? The current inbox will be lost.')) newAddress();
  });
  $('setname').addEventListener('click', function(){
    var n = $('customname').value.trim();
    if(!validName(n)){ toast('Letters, numbers, . _ - only'); return; }
    setStatus('Setting…');
    apiSetUser(sid, n).then(function(d){
      if(d.email_addr){
        email = d.email_addr;
        readIds = {}; openIds = {}; bodyCache = {}; lastIds = '';
        save();
        addrEl.textContent = email;
        renderEmpty();
        checkInbox(true);
        toast('Address updated');
      } else {
        toast('Name taken, try another');
        setStatus('<span class="dotpulse"></span>Live');
      }
    }).catch(function(){
      toast('Could not reach mail server');
      setStatus('<span class="dotpulse"></span>Live');
    });
  });

  // boot
  if(email && sid){
    addrEl.textContent = email;
    checkInbox(false);
  } else {
    newAddress();
  }
  timer = setInterval(function(){ checkInbox(false); }, 15000);
  $('refresh').addEventListener('click', function(){ checkInbox(true); });
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    splitEmail: splitEmail, fmtClock: fmtClock, timeAgo: timeAgo,
    esc: esc, validName: validName, API: API
  };
}
})();
