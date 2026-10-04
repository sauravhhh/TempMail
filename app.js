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

  // ---- local mail cache: incoming mails stay on the phone for a day,
  // keyed per address, so the inbox survives session expiry and reloads.
  var CACHE_TTL = 24*3600*1000, CACHE_MAX = 50, BODY_MAX = 100*1024;
  var mailCache = {};
  function cacheKey(){ return 'tm_mails_' + (splitEmail(email).login || 'none'); }
  function readKey(){ return 'tm_read_' + (splitEmail(email).login || 'none'); }
  function loadCache(){
    var out = {};
    try {
      var c = JSON.parse(localStorage.getItem(cacheKey()) || '{}');
      var now = Date.now();
      Object.keys(c).forEach(function(k){
        if(c[k] && now - (c[k].cachedAt || 0) < CACHE_TTL) out[k] = c[k];
      });
    } catch(e){}
    return out;
  }
  function saveCache(){
    try {
      var keys = Object.keys(mailCache).sort(function(a,b){
        return (mailCache[b].ts||0) - (mailCache[a].ts||0);
      }).slice(0, CACHE_MAX);
      var slim = {};
      keys.forEach(function(k){ slim[k] = mailCache[k]; });
      mailCache = slim;
      localStorage.setItem(cacheKey(), JSON.stringify(slim));
    } catch(e){
      try {
        Object.keys(mailCache).forEach(function(k){ delete mailCache[k].body; });
        localStorage.setItem(cacheKey(), JSON.stringify(mailCache));
      } catch(e2){}
    }
  }
  function cachedList(){
    return Object.keys(mailCache).map(function(k){
      var n = mailCache[k];
      return { mail_id:n.id, mail_from:n.from, mail_subject:n.subject, mail_timestamp:n.ts };
    }).sort(function(a,b){ return (b.mail_timestamp||0) - (a.mail_timestamp||0); });
  }
  function cacheBody(id, html){
    var n = mailCache[id];
    if(!n || !html || html.length > BODY_MAX) return;
    n.body = html; n.cachedAt = Date.now();
    saveCache();
  }
  function loadRead(){
    try { return JSON.parse(localStorage.getItem(readKey()) || '[]'); }
    catch(e){ return []; }
  }
  function saveRead(){
    try { localStorage.setItem(readKey(), JSON.stringify(Object.keys(readIds).slice(0,200))); }
    catch(e){}
  }
  // Call after changing `email`: stashes the old address state, loads the new.
  function useAddressCache(){
    mailCache = loadCache();
    readIds = {};
    loadRead().forEach(function(id){ readIds[id] = true; });
    openIds = {}; bodyCache = {}; lastIds = '';
  }

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
      saveCache(); saveRead();
      sid = d.sid_token; email = d.email_addr;
      useAddressCache();
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
      if(d && d.error){
        // Session expired (or API hiccup): never wipe the visible inbox.
        onSessionExpired();
        return;
      }
      lastCheck = Date.now();
      var list = d.list || [];
      var now = Date.now();
      list.forEach(function(m){
        var id = String(m.mail_id);
        var prev = mailCache[id] || {};
        mailCache[id] = {
          id: id,
          from: m.mail_from || '', subject: m.mail_subject || '(no subject)',
          ts: m.mail_timestamp || 0,
          body: prev.body, cachedAt: now
        };
      });
      saveCache();
      var merged = cachedList();
      var ids = mailIds(merged);
      if(ids !== lastIds){
        lastIds = ids;
        if(merged.length) renderList(merged);
        else renderEmpty();
      }
      setStatus('<span class="dotpulse"></span>Live');
      restoreTried = false;
    }).catch(function(){
      setStatus('Offline — retrying');
    });
  }

  var restoring = false;
  var restoreTried = false;
  function onSessionExpired(){
    if(restoring || restoreTried){
      setStatus('Session expired');
      return;
    }
    var login = splitEmail(email).login;
    if(!login){
      setStatus('Session expired');
      toast('Session expired. Tap New address.');
      return;
    }
    restoring = true;
    restoreTried = true;
    setStatus('Session expired — restoring…');
    // Try to reclaim the same address with a fresh session; Guerrilla keeps
    // addresses (and their mail) for about an hour.
    apiGetAddress().then(function(d2){
      return apiSetUser(d2.sid_token, login).then(function(d3){
        if(d3.email_addr === email){
          sid = d2.sid_token;
          save();
          lastIds = '';
          toast('Address restored');
          checkInbox(true);
        } else {
          throw new Error('taken');
        }
      });
    }).catch(function(){
      setStatus('Session expired');
      toast('Session expired. Tap New address.');
    }).then(function(){ restoring = false; });
  }

  // Force every email link to open in a new tab (same tab group),
  // with no opener access back into the mail app.
  function hardenLinks(f){
    try {
      var d = f.contentDocument;
      if(!d) return;
      var links = d.getElementsByTagName('a');
      for(var i = 0; i < links.length; i++){
        links[i].target = '_blank';
        links[i].rel = 'noopener';
      }
    } catch(e){}
  }

  function makeFrame(html){
    var f = document.createElement('iframe');
    // allow-same-origin but NO scripts: the parent can measure and scale the
    // email to fit, while email JavaScript stays blocked.
    // allow-popups (+ escape) so tapped links open in a new tab instead of
    // being trapped or killed by the sandbox.
    f.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('srcdoc',
      '<!DOCTYPE html><html><head><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>' +
      'html,body{margin:0!important;padding:0!important;}' +
      'body{padding:8px;font-family:sans-serif;font-size:14px;line-height:1.6;color:#111;overflow-wrap:anywhere;word-break:break-word;}' +
      'img{max-width:100%;height:auto;}' +
      'pre{white-space:pre-wrap;overflow-wrap:anywhere;}' +
      'a{overflow-wrap:anywhere;}' +
      '#emroot{}' +
      '</style>' +
      '</head><body><div id="emroot">' + html + '</div></body></html>');
    f.style.cssText = 'width:100%;max-width:100%;height:160px;border:0;border-radius:8px;background:#fff;display:block;overflow:hidden;';
    function fit(){
      try {
        var d = f.contentDocument;
        if(!d) return;
        var root = d.getElementById('emroot');
        if(!root) return;
        root.style.zoom = '';
        var availW = f.clientWidth || 320;
        var natW = root.scrollWidth || availW;
        var natH = root.scrollHeight || 120;
        if(natW > availW + 1){
          // zoom (unlike transform) shrinks the layout too, so no scrollbar
          var s = availW / natW;
          root.style.zoom = s;
          f.style.height = Math.ceil(natH * s + 16) + 'px';
        } else {
          f.style.height = Math.ceil(natH + 16) + 'px';
        }
      } catch(e){}
    }
    f.addEventListener('load', function(){
      hardenLinks(f);
      fit();
      setTimeout(fit, 600);
      setTimeout(fit, 2000);
    });
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
      var cachedBody = bodyCache[id] || (mailCache[id] && mailCache[id].body);
      if(isOpen && cachedBody){
        body.dataset.loaded = '1';
        body.appendChild(makeFrame(cachedBody));
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
    var cb = bodyCache[id] || (mailCache[id] && mailCache[id].body);
    if(cb){ showBody(div, id, bodyEl, cb); return; }
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
    cacheBody(id, html);
    if(!html.trim()){
      bodyEl.textContent = '(empty message)';
    } else {
      bodyEl.appendChild(makeFrame(html));
    }
    readIds[id] = true;
    saveRead();
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
        saveCache(); saveRead();
        email = d.email_addr;
        useAddressCache();
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
  mailCache = loadCache();
  readIds = {};
  loadRead().forEach(function(id){ readIds[id] = true; });
  if(email && sid){
    addrEl.textContent = email;
    var cached = cachedList();
    if(cached.length){
      renderList(cached);
      lastIds = mailIds(cached);
    }
    checkInbox(false);
  } else {
    newAddress();
  }
  timer = setInterval(function(){ checkInbox(false); }, 60000);
  $('refresh').addEventListener('click', function(){ checkInbox(true); });
}

if(typeof module !== 'undefined' && module.exports){
  module.exports = {
    splitEmail: splitEmail, fmtClock: fmtClock, timeAgo: timeAgo,
    esc: esc, validName: validName, API: API
  };
}
})();
