/* Mortgage Desk (web): Microsoft sign-in, OneDrive storage, offline cache.
   Stores one JSON file per case in OneDrive/Mortgage Desk Data/. No other server is used. */
(function () {
  'use strict';
  var CFG = window.MD_CONFIG || {};
  var BASE_SCOPES = 'Files.ReadWrite.AppFolder User.Read offline_access';
  var ls = function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } };
  var lset = function (k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} };
  function scopes() { return BASE_SCOPES + ((ls('md.cal') === '1' || ls('md.calwant') === '1') ? ' Calendars.ReadWrite' : ''); }
  var AUTH = 'https://login.microsoftonline.com/' + (CFG.tenant || 'common') + '/oauth2/v2.0/';
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var ROOT = 'Apps / Mortgage Desk';
  var APP = '/me/drive/special/approot';
  var COLS = ['cases', 'notebook', 'appointments', 'marketing'];
  var REDIRECT = CFG.redirectUri || (location.origin + location.pathname.replace(/[^\/]*$/, ''));
  var $ = function (i) { return document.getElementById(i); };
  var enc = function (p) { return p.split('/').map(encodeURIComponent).join('/'); };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };
  var safeId = function (s) { return String(s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 120); };
  var genId = function () { return Math.random().toString(36).slice(2, 12) + Date.now().toString(36).slice(-4); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  /* ---------- small UI helpers ---------- */
  function toast(msg) {
    var t = $('mdToast');
    if (!t) { t = document.createElement('div'); t.id = 'mdToast'; t.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:20px;background:#101C26;color:#fff;padding:10px 16px;border-radius:8px;z-index:200;max-width:90vw;font:14px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)'; document.body.appendChild(t); }
    t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(function () { t.style.display = 'none'; }, 5000);
  }
  window.mdToast = toast;
  function acctBanner(nowMail, lastMail) {
    var b = document.createElement('div'); b.id = 'mdAcct'; b.setAttribute('role', 'alert');
    b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:210;background:#b71c1c;color:#fff;padding:12px 16px;font:14px system-ui,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    b.innerHTML = '<b>Different Microsoft account.</b><span>You are signed in as <b></b>. Last time this device used <b></b>. Each account has its own separate client list, so if your clients seem to be missing, log out and sign in with the usual account.</span><button type="button" style="margin-left:auto;background:#fff;color:#b71c1c;border:0;border-radius:6px;padding:6px 12px;font-weight:700;cursor:pointer">OK, I know</button>';
    var bs = b.querySelectorAll('span b'); bs[0].textContent = nowMail; bs[1].textContent = lastMail;
    b.querySelector('button').onclick = function () { b.remove(); };
    document.body.appendChild(b);
  }

  /* ---------- tokens (Microsoft sign-in, PKCE, no library) ---------- */
  function readTok() { try { return JSON.parse(localStorage.getItem('md.tok2') || 'null'); } catch (e) { return null; } }
  function writeTok(t) { try { if (t) localStorage.setItem('md.tok2', JSON.stringify(t)); else localStorage.removeItem('md.tok2'); } catch (e) {} }
  var memTok = null;
  function tok() { return memTok || (memTok = readTok()); }
  function setTok(t) { memTok = t; writeTok(t); }
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function form(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }

  async function startLogin(reauth) {
    var v = rand(48), st = rand(16);
    var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    try { localStorage.setItem('md.pkce', JSON.stringify({ v: v, st: st })); } catch (e) {}
    location.href = AUTH + 'authorize?' + form(Object.assign({ client_id: CFG.clientId, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: scopes(), state: st, code_challenge: b64url(h), code_challenge_method: 'S256', prompt: reauth ? 'login' : 'select_account' }, reauth && ((tok() || {}).account || {}).mail ? { login_hint: tok().account.mail } : {}));
  }
  async function tokenRequest(params) {
    var r = await fetch(AUTH + 'token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(Object.assign({ client_id: CFG.clientId, scope: scopes() }, params)) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.error) { var e = new Error(j.error_description || j.error || 'Sign-in failed'); e.auth = true; e.code = j.error; throw e; }
    var old = tok() || {};
    setTok({ access: j.access_token, refresh: j.refresh_token || old.refresh, exp: Date.now() + (j.expires_in || 3600) * 1000, account: old.account });
    return j;
  }
  var refreshing = null;
  function getToken() {
    var t = tok();
    if (!t) { var e = new Error('Not signed in'); e.auth = true; return Promise.reject(e); }
    if (t.exp - Date.now() > 120000) return Promise.resolve(t.access);
    if (refreshing) return refreshing;
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }).then(function () { return tok().access; }, function (e) {
      if (e.auth && /invalid_grant|interaction_required|invalid_request/.test(e.code || '')) { setTok(null); sessionExpired(); }
      throw e;
    }).then(function (a) { refreshing = null; return a; }, function (e) { refreshing = null; throw e; });
    return refreshing;
  }
  async function gfetch(path, opt, retried) {
    opt = opt || {};
    var at = await getToken();
    var url = path.indexOf('http') === 0 ? path : GRAPH + path;
    var r = await fetch(url, Object.assign({}, opt, { headers: Object.assign({ Authorization: 'Bearer ' + at }, opt.headers || {}) }));
    if (r.status === 401 && !retried) { var t = tok(); if (t) { t.exp = 0; } return gfetch(path, opt, true); }
    if ((r.status === 429 || r.status === 503) && !retried) { await sleep(Math.min(10, +r.headers.get('Retry-After') || 2) * 1000); return gfetch(path, opt, true); }
    return r;
  }
  function httpErr(r) { var e = new Error('OneDrive said ' + r.status); e.status = r.status; return e; }

  /* ---------- local cache (IndexedDB) ---------- */
  var idb = null;
  function openIdb() {
    return new Promise(function (res) {
      try {
        var q = indexedDB.open('mortgage-desk', 1);
        q.onupgradeneeded = function () { var d = q.result; d.createObjectStore('docs', { keyPath: 'k' }); d.createObjectStore('dirty', { keyPath: 'k' }); };
        q.onsuccess = function () { idb = q.result; res(); };
        q.onerror = function () { res(); };
      } catch (e) { res(); }
    });
  }
  function idbAll(store) { return new Promise(function (res) { if (!idb) return res([]); try { var q = idb.transaction(store).objectStore(store).getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { res([]); }; } catch (e) { res([]); } }); }
  function idbPut(store, o) { if (!idb) return; try { idb.transaction(store, 'readwrite').objectStore(store).put(o); } catch (e) {} }
  function idbDel(store, k) { if (!idb) return; try { idb.transaction(store, 'readwrite').objectStore(store).delete(k); } catch (e) {} }
  function idbClearAll() { return new Promise(function (res) { if (!idb) return res(); try { var t = idb.transaction(['docs', 'dirty'], 'readwrite'); t.objectStore('docs').clear(); t.objectStore('dirty').clear(); t.oncomplete = res; t.onerror = res; } catch (e) { res(); } }); }

  var mem = { cases: {}, notebook: {}, appointments: {}, marketing: {} }, dirty = {}, vctr = 0, subs = { cases: [], notebook: [], appointments: [], marketing: [] };
  function persistDoc(col, id) { var d = mem[col][id]; if (d) idbPut('docs', { k: col + '/' + id, col: col, id: id, data: d.data, etag: d.etag, itemId: d.itemId }); }
  function snap(col) { return { docs: Object.keys(mem[col]).map(function (id) { var d = mem[col][id].data; return { id: id, data: function () { return clone(d); } }; }) }; }
  function notify(col) { subs[col].forEach(function (cb) { try { cb(snap(col)); } catch (e) { console.error(e); } }); }
  var docPath = function (col, id) { return APP + ':/' + enc(col + '/' + id + '.json'); };

  /* ---------- status text ---------- */
  var st = { offline: false, busy: '', last: 0, err: '' };
  function pending() { return Object.keys(dirty).length; }
  function setState() {
    var el = $('syncState'); if (!el) return;
    var txt, col = '#58697A';
    if (!tok()) txt = 'Not signed in';
    else if (st.busy) txt = st.busy;
    else if (st.err) { txt = st.err + (pending() ? ' · ' + pending() + ' waiting' : ''); col = '#A3261F'; }
    else if (st.offline) { txt = 'Offline' + (pending() ? ' · ' + pending() + ' change' + (pending() > 1 ? 's' : '') + ' waiting' : ''); col = '#8A5A00'; }
    else if (pending()) txt = 'Saving…';
    else { txt = st.last ? 'Saved to OneDrive ' + new Date(st.last).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : 'Connected'; col = '#0A6B50'; }
    el.textContent = txt; el.style.color = col;
  }

  /* ---------- writing (local first, then OneDrive) ---------- */
  function localWrite(col, id, data, kind, patch) {
    var cur = mem[col][id];
    mem[col][id] = { data: data, etag: cur ? cur.etag : null, itemId: cur ? cur.itemId : null };
    persistDoc(col, id);
    var k = col + '/' + id, d = dirty[k];
    var nd = { k: k, col: col, id: id, kind: (kind === 'set' || (d && d.kind === 'set')) ? 'set' : 'patch', patch: kind === 'set' ? {} : Object.assign({}, d && d.patch || {}, patch || {}), v: ++vctr };
    dirty[k] = nd; idbPut('dirty', nd); notify(col); scheduleFlush(); setState();
  }
  function localDelete(col, id) {
    if (col === 'appointments' && mem[col][id] && mem[col][id].data && mem[col][id].data.calId) { var cd = calDelList(); cd.push(mem[col][id].data.calId); setCalDel(cd); calSchedule(2000); }
    delete mem[col][id]; idbDel('docs', col + '/' + id);
    var k = col + '/' + id, nd = { k: k, col: col, id: id, kind: 'del', patch: {}, v: ++vctr };
    dirty[k] = nd; idbPut('dirty', nd); notify(col); scheduleFlush(); setState();
  }
  function clearDirty(d) { delete dirty[d.k]; idbDel('dirty', d.k); }
  var flushing = false, flushTimer = null;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms == null ? 800 : ms); }
  function putDoc(col, id, data, etag) {
    var h = { 'Content-Type': 'application/json' }; if (etag) h['If-Match'] = etag;
    return gfetch(docPath(col, id) + ':/content', { method: 'PUT', headers: h, body: JSON.stringify(data) });
  }
  async function resolveConflict(d) {
    var m = await gfetch(docPath(d.col, d.id));
    if (m.status === 404) { var r0 = await putDoc(d.col, d.id, mem[d.col][d.id].data, null); if (!r0.ok) throw httpErr(r0); var j0 = await r0.json(); mem[d.col][d.id].etag = j0.eTag; persistDoc(d.col, d.id); clearDirty(d); return; }
    if (!m.ok) throw httpErr(m);
    var meta = await m.json();
    var c = await gfetch(docPath(d.col, d.id) + ':/content'); if (!c.ok) throw httpErr(c);
    var remote = await c.json();
    var merged = d.kind === 'set' ? mem[d.col][d.id].data : Object.assign({}, remote, d.patch);
    var r = await putDoc(d.col, d.id, merged, meta.eTag);
    if (!r.ok) throw httpErr(r);
    var j = await r.json();
    mem[d.col][d.id] = { data: merged, etag: j.eTag, itemId: j.id }; persistDoc(d.col, d.id); clearDirty(d); notify(d.col);
    toast('Combined changes made on another device');
  }
  async function pushOne(d) {
    if (d.kind === 'del') {
      var rd = await gfetch(docPath(d.col, d.id), { method: 'DELETE' });
      if (rd.ok || rd.status === 404) clearDirty(d); else throw httpErr(rd);
      return;
    }
    var doc = mem[d.col][d.id]; if (!doc) { clearDirty(d); return; }
    var v = d.v, r = await putDoc(d.col, d.id, doc.data, doc.etag);
    if (r.status === 412) return resolveConflict(d);
    if (r.status === 400 && doc.etag) { r = await putDoc(d.col, d.id, doc.data, null); }
    if (!r.ok) throw httpErr(r);
    var j = await r.json(); doc.etag = j.eTag; doc.itemId = j.id; persistDoc(d.col, d.id);
    if (dirty[d.k] && dirty[d.k].v === v) clearDirty(d);
  }
  async function flush() {
    if (flushing || !tok()) return;
    flushing = true;
    try {
      var keys = Object.keys(dirty);
      for (var i = 0; i < keys.length; i++) { if (dirty[keys[i]]) await pushOne(dirty[keys[i]]); }
      st.offline = false; st.err = ''; st.last = Date.now();
      flushing = false; setState();
      if (pending()) scheduleFlush(300);
    } catch (e) {
      flushing = false; handleErr(e);
      if (!e.auth) scheduleFlush(30000);
    }
  }
  function handleErr(e) {
    if (e && e.auth) { st.err = 'Sign-in needed'; setState(); return; }
    if (e instanceof TypeError || (e && /Failed to fetch|NetworkError|Load failed/i.test(e.message))) { st.offline = true; st.err = ''; }
    else { st.err = 'Sync problem (' + (e && e.message || 'unknown') + ')'; st.offline = false; }
    setState();
  }

  /* ---------- reading (delta by eTag) ---------- */
  async function listRemote(col) {
    var out = [], url = APP + ':/' + enc(col) + ':/children?$select=id,name,eTag&$top=200';
    while (url) {
      var r = await gfetch(url);
      if (r.status === 404) return out;
      if (!r.ok) throw httpErr(r);
      var j = await r.json();
      (j.value || []).forEach(function (it) { if (it.name && /\.json$/.test(it.name)) out.push({ id: it.name.slice(0, -5), itemId: it.id, etag: it.eTag }); });
      url = j['@odata.nextLink'] || null;
    }
    return out;
  }
  var pulling = false, firstPullDone = false;
  async function pull() {
    if (pulling || !tok()) return;
    pulling = true;
    try {
      var todo = [], removed = {};
      for (var ci = 0; ci < COLS.length; ci++) {
        var col = COLS[ci], remote = await listRemote(col), seen = {};
        remote.forEach(function (it) {
          seen[it.id] = 1;
          var loc = mem[col][it.id];
          if (dirty[col + '/' + it.id]) return;
          if (!loc || loc.etag !== it.etag) todo.push({ col: col, it: it });
        });
        Object.keys(mem[col]).forEach(function (id) { if (!seen[id] && !dirty[col + '/' + id] && mem[col][id].etag) { delete mem[col][id]; idbDel('docs', col + '/' + id); removed[col] = 1; } });
      }
      var total = todo.length, done = 0, touched = {}, big = total > 20;
      if (big) showLoading('Loading your cases from OneDrive… 0 of ' + total);
      var idx = 0;
      async function worker() {
        while (idx < todo.length) {
          var w = todo[idx++];
          var r = await gfetch('/me/drive/items/' + encodeURIComponent(w.it.itemId) + '/content');
          if (!r.ok) throw httpErr(r);
          var data = await r.json();
          if (!dirty[w.col + '/' + w.it.id]) { mem[w.col][w.it.id] = { data: data, etag: w.it.etag, itemId: w.it.itemId }; persistDoc(w.col, w.it.id); touched[w.col] = 1; }
          done++; if (big && done % 5 === 0) showLoading('Loading your cases from OneDrive… ' + done + ' of ' + total);
        }
      }
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      hideLoading();
      COLS.forEach(function (c) { if (touched[c] || removed[c]) notify(c); });
      if (!firstPullDone) {
        firstPullDone = true;
        if (!Object.keys(mem.cases).length && !Object.keys(dirty).length) toast('No cases found in your OneDrive yet. Open Settings and choose "Import backup file".');
      }
      st.offline = false; st.err = ''; st.last = Date.now();
    } catch (e) { hideLoading(); handleErr(e); }
    pulling = false; setState();
  }

  function showLoading(txt) {
    var o = $('mdLoad');
    if (!o) { o = document.createElement('div'); o.id = 'mdLoad'; o.style.cssText = 'position:fixed;inset:0;z-index:150;background:rgba(237,240,241,.96);display:flex;align-items:center;justify-content:center;font:16px system-ui,sans-serif;color:#101C26;text-align:center;padding:20px'; document.body.appendChild(o); }
    o.textContent = txt;
  }
  function hideLoading() { var o = $('mdLoad'); if (o) o.remove(); }

  /* ---------- Outlook calendar reminders (opt-in, 15 minutes before) ---------- */
  var CAL_MIN = 15, calBusy = false, calTimer = null, calAgain = false;
  function calOn() { return ls('md.cal') === '1'; }
  function calDelList() { try { return JSON.parse(ls('md.caldel') || '[]'); } catch (e) { return []; } }
  function setCalDel(a) { lset('md.caldel', JSON.stringify(a)); }
  function calHash(a) { return JSON.stringify([a.who, a.type, a.date, a.time, a.dur, a.mode, a.where]); }
  function calWall(date, time, plusMin) {
    var d = date.split('-'), t = time.split(':');
    return new Date(Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], (+t[1] || 0) + plusMin)).toISOString().slice(0, 19);
  }
  function calBody(a) {
    return {
      subject: 'Mortgage appointment: ' + (a.who || ''),
      start: { dateTime: calWall(a.date, a.time, 0), timeZone: 'Europe/London' },
      end: { dateTime: calWall(a.date, a.time, +a.dur || 30), timeZone: 'Europe/London' },
      location: { displayName: a.where || '' },
      body: { contentType: 'text', content: [a.type, a.mode].filter(Boolean).join(' · ') },
      isReminderOn: true, reminderMinutesBeforeStart: CAL_MIN, showAs: 'busy'
    };
  }
  function calSchedule(ms) { if (!calOn()) return; clearTimeout(calTimer); calTimer = setTimeout(calSync, ms == null ? 2000 : ms); }
  function calPerm() { var e = new Error('perm'); e.cal = true; return e; }
  async function calSync() {
    if (!calOn() || !tok() || st.offline) return;
    if (calBusy) { calAgain = true; return; }
    calBusy = true; var changed = false;
    try {
      var keep = [], dels = calDelList();
      for (var i = 0; i < dels.length; i++) {
        var rd = await gfetch('/me/events/' + encodeURIComponent(dels[i]), { method: 'DELETE' });
        if (rd.status === 401 || rd.status === 403) throw calPerm();
        if (!(rd.ok || rd.status === 404)) keep.push(dels[i]);
      }
      if (dels.length) setCalDel(keep);
      var y = new Date(Date.now() - 86400000), floor = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
      var ids = Object.keys(mem.appointments);
      for (var j = 0; j < ids.length; j++) {
        var id = ids[j], rec = mem.appointments[id], a = rec && rec.data; if (!a) continue;
        var ref = collection('appointments').doc(id);
        var want = (a.status || 'booked') === 'booked' && a.date && a.time && a.date >= floor;
        if (!want) {
          if (a.calId) {
            var rx = await gfetch('/me/events/' + encodeURIComponent(a.calId), { method: 'DELETE' });
            if (rx.status === 401 || rx.status === 403) throw calPerm();
            if (rx.ok || rx.status === 404) { await ref.update({ calId: '', calH: '' }); changed = true; }
          }
          continue;
        }
        var h = calHash(a);
        if (a.calId && a.calH === h) continue;
        var r = null;
        if (a.calId) {
          r = await gfetch('/me/events/' + encodeURIComponent(a.calId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calBody(a)) });
          if (r.status === 404) r = null;
        }
        if (!r) {
          var b = calBody(a); b.transactionId = id;
          r = await gfetch('/me/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
        }
        if (r.status === 401 || r.status === 403) throw calPerm();
        if (r.ok) { var jj = await r.json().catch(function () { return {}; }); await ref.update({ calId: jj.id || a.calId || '', calH: h }); changed = true; }
      }
    } catch (e) {
      if (e && e.cal) { lset('md.cal', null); toast('Calendar reminders stopped: permission was not given. Turn them on again in Settings.'); }
    } finally {
      calBusy = false;
      if (changed || calAgain) { calAgain = false; calSchedule(3000); }
    }
  }

  /* ---------- PDF / CSV case backup ---------- */
  var BK_STAGE = { enquiry: 'Enquiry', factfind: 'Fact find', dip: 'AIP', application: 'FMA', offer: 'Offered', completed: 'Completed', lost: 'Closed lost' };
  var BK_INV = { 'Spouse / partner': 'Spouse / partner', 'Parent': 'Child', 'Child': 'Parent', 'Grandparent': 'Grandchild', 'Grandchild': 'Grandparent', 'Sibling': 'Sibling', 'Other relative': 'Other relative', 'Friend': 'Friend', 'Colleague': 'Colleague', 'Business partner': 'Business partner', 'Employer': 'Employee', 'Employee': 'Employer', 'Referred by': 'Referred client', 'Referred client': 'Referred by', 'Other': 'Other' };
  var bkRunning = false, bkTimer = null;
  function bkCfg() { var c = {}; try { c = JSON.parse(ls('md.bk') || '{}'); } catch (e) {} return Object.assign({ auto: true, last: 0, tried: 0, res: {} }, c); }
  function bkSave(c) { lset('md.bk', JSON.stringify(c)); }
  function bkNames(c) { var a = (c.applicants || []).map(function (x) { return x.name; }).filter(Boolean); return a.length ? a.join(' & ') : 'Unnamed client'; }
  function bkDate(s) { if (!s) return ''; var p = String(s).split('-'); if (p.length !== 3) return String(s); var d = new Date(+p[0], +p[1] - 1, +p[2]); return isNaN(d) ? String(s) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function bkTs(t) { return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function bkGbp(n) { if (n == null || n === '') return ''; n = +n; return isNaN(n) ? '' : '£' + n.toLocaleString('en-GB', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }); }
  function bkCases() {
    var all = Object.keys(mem.cases).map(function (id) { var d = clone(mem.cases[id].data || {}); d.id = id; return d; });
    all.sort(function (a, b) { return String(a.clientNo || 'zzz').localeCompare(String(b.clientNo || 'zzz'), 'en', { numeric: true }) || bkNames(a).localeCompare(bkNames(b)); });
    return all;
  }
  function bkConn(c, all) {
    var out = [], seen = {};
    function add(o, rel) { if (!o || o.id === c.id) return; var k = bkNames(o).toLowerCase(); if (seen[k]) return; seen[k] = 1; out.push(bkNames(o) + ' (' + rel + ')'); }
    var by = {}; all.forEach(function (x) { by[x.id] = x; });
    (c.links || []).forEach(function (l) { add(by[l.cid], l.rel); });
    all.forEach(function (x) { (x.links || []).forEach(function (l) { if (l.cid === c.id) add(x, BK_INV[l.rel] || l.rel); }); });
    return out;
  }
  var BK_COLS = ['clientNo', 'applicants', 'dates of birth', 'phones', 'emails', 'addresses', 'stage', 'type', 'property type', 'repayment', 'propertyAddress', 'propertyValue', 'purchasePrice', 'loanAmount', 'termYears', 'termLeft', 'lender', 'lenderRef', 'product', 'rate', 'followOnRate', 'fixedUntil', 'reviewDate', 'erc', 'monthlyPayment', 'dipExpiry', 'offerDate', 'offerExpiry', 'completionDate', 'conveyancer', 'other security addresses', 'connected clients', 'open tasks', 'notes', 'protection notes', 'oneDriveLink'];
  function bkProp(v) { return { main: 'Main residence', btl: 'Buy to let', second: 'Second home', holiday: 'Holiday home' }[v] || ''; }
  function bkTasks(c, openOnly) { return (c.tasks || []).filter(function (t) { return !openOnly || !t.done; }).map(function (t) { return (t.done ? '[done] ' : '') + (t.pri ? '[high] ' : '') + (t.text || '') + (t.due ? ' (due ' + bkDate(t.due) + (t.time ? ' ' + t.time : '') + ')' : ''); }); }
  function bkLog(arr) { return (arr || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).map(function (n) { return bkTs(n.ts) + ': ' + String(n.text || '').replace(/\s+/g, ' ').trim(); }); }
  function bkCsv(all) {
    function q(v) { v = v == null ? '' : String(v); return '"' + v.replace(/"/g, '""') + '"'; }
    var rows = [BK_COLS.map(q).join(',')];
    all.forEach(function (c) {
      var ap = c.applicants || [];
      var r = [c.clientNo, bkNames(c), ap.map(function (a) { return a.dob ? bkDate(a.dob) : ''; }).join(' | '), ap.map(function (a) { return a.phone || ''; }).join(' | '), ap.map(function (a) { return a.email || ''; }).join(' | '), ap.map(function (a) { return a.address || ''; }).join(' | '),
        BK_STAGE[c.stage] || c.stage, c.type, bkProp(c.propUse), c.repayment, c.propertyAddress, c.propertyValue, c.purchasePrice, c.loanAmount, c.termYears, c.termLeft, c.lender, c.lenderRef, c.product, c.rate, c.followOnRate, c.fixedUntil, c.reviewDate, c.erc, c.monthlyPayment, c.dipExpiry, c.offerDate, c.offerExpiry, c.completionDate, c.conveyancer,
        (c.securities || []).map(function (s) { return s.address || ''; }).filter(Boolean).join(' | '), bkConn(c, all).join('; '), bkTasks(c, true).join(' | '), bkLog(c.notes).join(' | '), bkLog(c.protection).join(' | '), c.oneDriveLink];
      rows.push(r.map(q).join(','));
    });
    return '﻿' + rows.join('\r\n') + '\r\n';
  }
  /* minimal PDF writer: text only, Helvetica, A4 */
  function pdfStr(s) {
    var o = '';
    s = String(s == null ? '' : s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i), t;
      if (c === 0x2013 || c === 0x2014 || c === 0x2212) t = '-';
      else if (c === 0x2018 || c === 0x2019) t = "'";
      else if (c === 0x201c || c === 0x201d) t = '"';
      else if (c === 0x2026) t = '...';
      else if (c === 0x20ac) t = '\\200';
      else if (c === 0x2022) t = '\\225';
      else if (c === 0x28 || c === 0x29 || c === 0x5c) t = '\\' + s.charAt(i);
      else if (c < 32) t = ' ';
      else if (c > 126 && c < 256) t = '\\' + ('00' + c.toString(8)).slice(-3);
      else if (c > 255) t = '?';
      else t = s.charAt(i);
      o += t;
    }
    return o;
  }
  function pdfWrap(text, max) {
    var out = [], words = String(text == null ? '' : text).split(/\s+/), line = '';
    words.forEach(function (w) {
      while (w.length > max) { if (line) { out.push(line); line = ''; } out.push(w.slice(0, max)); w = w.slice(max); }
      if (!line) line = w; else if ((line + ' ' + w).length <= max) line += ' ' + w; else { out.push(line); line = w; }
    });
    if (line || !out.length) out.push(line);
    return out;
  }
  function pdfBuild(items, footer, pw) {
    var W = 595, H = 842, ML = 42, TOP = 800, BOT = 54, pages = [[]], y = TOP;
    function newPage() { pages.push([]); y = TOP; }
    items.forEach(function (it) {
      if (it.pb) { if (pages[pages.length - 1].length) newPage(); return; }
      var sz = it.sz || 9, lh = Math.round(sz * 1.38 * 10) / 10, ind = it.ind || 0;
      var max = Math.floor((W - 2 * ML - ind) / (sz * (it.b ? 0.58 : 0.53)));
      pdfWrap(it.t, max).forEach(function (ln, k) {
        if (y - lh < BOT) newPage();
        pages[pages.length - 1].push({ t: ln, x: ML + ind + (k && it.hang ? it.hang : 0), y: y, b: it.b, sz: sz });
        y -= lh;
      });
      y -= it.gap || 0;
    });
    var out = '%PDF-1.4\n', offs = [], n = pages.length, enc = pw ? pdfEncInit(pw) : null;
    function obj(i, body) { offs[i] = out.length; out += i + ' 0 obj\n' + body + '\nendobj\n'; }
    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    var kids = pages.map(function (p, i) { return (5 + 2 * i) + ' 0 R'; }).join(' ');
    obj(2, '<< /Type /Pages /Kids [' + kids + '] /Count ' + n + ' >>');
    obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    pages.forEach(function (p, i) {
      var cs = '';
      p.forEach(function (l) { cs += 'BT /' + (l.b ? 'F2' : 'F1') + ' ' + l.sz + ' Tf 1 0 0 1 ' + l.x + ' ' + l.y.toFixed(1) + ' Tm (' + pdfStr(l.t) + ') Tj ET\n'; });
      cs += 'BT /F1 8 Tf 1 0 0 1 ' + ML + ' 30 Tm (' + pdfStr(footer + '  |  page ' + (i + 1) + ' of ' + n) + ') Tj ET\n';
      obj(5 + 2 * i, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + W + ' ' + H + '] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ' + (6 + 2 * i) + ' 0 R >>');
      if (enc) { var eb = pdfObjEnc(enc, 6 + 2 * i, strB(cs)), es = ''; for (var q = 0; q < eb.length; q++) es += String.fromCharCode(eb[q]); cs = es; }
      obj(6 + 2 * i, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + '\nendstream');
    });
    var total = 5 + 2 * n;
    if (enc) { obj(total, '<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <' + enc.O + '> /U <' + enc.U + '> /P -4 >>'); total++; }
    var xref = out.length;
    out += 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) out += ('0000000000' + offs[k]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + total + ' /Root 1 0 R' + (enc ? ' /Encrypt ' + (total - 1) + ' 0 R /ID [<' + enc.id + '><' + enc.id + '>]' : '') + ' >>\nstartxref\n' + xref + '\n%%EOF\n';
    var u = new Uint8Array(out.length); for (var m = 0; m < out.length; m++) u[m] = out.charCodeAt(m) & 255;
    return u;
  }
  /* ---------- password protection for backups: AES, MD5, RC4, encrypted PDF, AES-256 ZIP ---------- */
  var AES_S = null;
  function aesInit() {
    if (AES_S) return;
    var s = new Uint8Array(256), p = 1, q = 1, rot = function (x, n) { return ((x << n) | (x >> (8 - n))) & 255; };
    do {
      p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x11b : 0)) & 255;
      q ^= q << 1; q &= 255; q ^= q << 2; q &= 255; q ^= q << 4; q &= 255; if (q & 0x80) q ^= 0x09;
      s[p] = (q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63) & 255;
    } while (p !== 1);
    s[0] = 0x63; AES_S = s;
  }
  function aesKey(key) {
    aesInit();
    var nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1)), i, t = new Uint8Array(4), rc = 1, k;
    w.set(key);
    for (i = nk; i < 4 * (nr + 1); i++) {
      t[0] = w[4 * i - 4]; t[1] = w[4 * i - 3]; t[2] = w[4 * i - 2]; t[3] = w[4 * i - 1];
      if (i % nk === 0) {
        var x = t[0]; t[0] = AES_S[t[1]] ^ rc; t[1] = AES_S[t[2]]; t[2] = AES_S[t[3]]; t[3] = AES_S[x];
        rc = ((rc << 1) ^ ((rc & 0x80) ? 0x11b : 0)) & 255;
      } else if (nk > 6 && i % nk === 4) { t[0] = AES_S[t[0]]; t[1] = AES_S[t[1]]; t[2] = AES_S[t[2]]; t[3] = AES_S[t[3]]; }
      for (k = 0; k < 4; k++) w[4 * i + k] = w[4 * (i - nk) + k] ^ t[k];
    }
    return { w: w, nr: nr };
  }
  function aesBlock(K, inp) {
    var s = new Uint8Array(16), t = new Uint8Array(16), r, i, xt = function (x) { return ((x << 1) ^ ((x & 0x80) ? 0x1b : 0)) & 255; };
    for (i = 0; i < 16; i++) s[i] = inp[i] ^ K.w[i];
    for (r = 1; r <= K.nr; r++) {
      for (i = 0; i < 16; i++) t[i] = AES_S[s[i]];
      s[0] = t[0]; s[1] = t[5]; s[2] = t[10]; s[3] = t[15]; s[4] = t[4]; s[5] = t[9]; s[6] = t[14]; s[7] = t[3];
      s[8] = t[8]; s[9] = t[13]; s[10] = t[2]; s[11] = t[7]; s[12] = t[12]; s[13] = t[1]; s[14] = t[6]; s[15] = t[11];
      if (r < K.nr) {
        for (i = 0; i < 16; i += 4) {
          var a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3], x = a0 ^ a1 ^ a2 ^ a3;
          s[i] = a0 ^ x ^ xt(a0 ^ a1); s[i + 1] = a1 ^ x ^ xt(a1 ^ a2); s[i + 2] = a2 ^ x ^ xt(a2 ^ a3); s[i + 3] = a3 ^ x ^ xt(a3 ^ a0);
        }
      }
      for (i = 0; i < 16; i++) s[i] ^= K.w[16 * r + i];
    }
    return s;
  }
  function aesCbcPad(keyBytes, data) {
    var K = aesKey(keyBytes), iv = crypto.getRandomValues(new Uint8Array(16)), n = data.length, pad = 16 - (n % 16), tot = n + pad;
    var out = new Uint8Array(16 + tot), prev = iv, blk = new Uint8Array(16), i, j;
    out.set(iv);
    for (i = 0; i < tot; i += 16) {
      for (j = 0; j < 16; j++) blk[j] = (i + j < n ? data[i + j] : pad) ^ prev[j];
      prev = aesBlock(K, blk); out.set(prev, 16 + i);
    }
    return out;
  }
  function aesCtrLE(keyBytes, data) {
    var K = aesKey(keyBytes), out = new Uint8Array(data.length), ctr = new Uint8Array(16), i, j, ks;
    for (i = 0; i < data.length; i += 16) {
      for (j = 0; j < 16; j++) { ctr[j] = (ctr[j] + 1) & 255; if (ctr[j]) break; }
      ks = aesBlock(K, ctr);
      for (j = 0; j < 16 && i + j < data.length; j++) out[i + j] = data[i + j] ^ ks[j];
    }
    return out;
  }
  function md5(b) {
    var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21], K = [], i, j;
    for (i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    var n = b.length, tot = (((n + 8) >> 6) + 1) * 64, m = new Uint8Array(tot);
    m.set(b); m[n] = 0x80;
    var bl = n * 8; m[tot - 8] = bl & 255; m[tot - 7] = (bl >>> 8) & 255; m[tot - 6] = (bl >>> 16) & 255; m[tot - 5] = (bl >>> 24) & 255;
    var a0 = 0x67452301, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476;
    for (var o = 0; o < tot; o += 64) {
      var M = [];
      for (i = 0; i < 16; i++) M[i] = m[o + 4 * i] | (m[o + 4 * i + 1] << 8) | (m[o + 4 * i + 2] << 16) | (m[o + 4 * i + 3] << 24);
      var A = a0, B = b0, C = c0, D = d0, F, g;
      for (i = 0; i < 64; i++) {
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0; A = D; D = C; C = B; B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    var out = new Uint8Array(16), v = [a0, b0, c0, d0];
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) out[4 * i + j] = (v[i] >>> (8 * j)) & 255;
    return out;
  }
  function rc4(key, data) {
    var s = [], i, j = 0, t, out = new Uint8Array(data.length);
    for (i = 0; i < 256; i++) s[i] = i;
    for (i = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; t = s[i]; s[i] = s[j]; s[j] = t; }
    i = 0; j = 0;
    for (var k = 0; k < data.length; k++) { i = (i + 1) & 255; j = (j + s[i]) & 255; t = s[i]; s[i] = s[j]; s[j] = t; out[k] = data[k] ^ s[(s[i] + s[j]) & 255]; }
    return out;
  }
  var PDF_PAD = [0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A];
  function catB() { var n = 0, i, k = 0, a; for (i = 0; i < arguments.length; i++) n += arguments[i].length; a = new Uint8Array(n); for (i = 0; i < arguments.length; i++) { a.set(arguments[i], k); k += arguments[i].length; } return a; }
  function hexB(u) { var h = ''; for (var i = 0; i < u.length; i++) h += ('0' + u[i].toString(16)).slice(-2); return h; }
  function strB(s) { var u = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; }
  function pdfEncInit(pw) {
    var pb = strB(String(pw)).slice(0, 32), pad = new Uint8Array(32), i, r;
    pad.set(pb); pad.set(PDF_PAD.slice(0, 32 - pb.length), pb.length);
    var h = md5(pad); for (i = 0; i < 50; i++) h = md5(h);
    var ok = h.slice(0, 16), O = rc4(ok, pad);
    for (i = 1; i <= 19; i++) { var kk = ok.map(function (x) { return x ^ i; }); O = rc4(kk, O); }
    var P = new Uint8Array([0xFC, 0xFF, 0xFF, 0xFF]), id = crypto.getRandomValues(new Uint8Array(16));
    var key = md5(catB(pad, O, P, id)); for (i = 0; i < 50; i++) key = md5(key.slice(0, 16)); key = key.slice(0, 16);
    var U = rc4(key, md5(catB(new Uint8Array(PDF_PAD), id)));
    for (i = 1; i <= 19; i++) { var k2 = key.map(function (x) { return x ^ i; }); U = rc4(k2, U); }
    U = catB(U, new Uint8Array(16));
    return { key: key, O: hexB(O), U: hexB(U), id: hexB(id) };
  }
  function pdfObjEnc(enc, num, bytes) {
    var k = md5(catB(enc.key, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]), strB('sAlT')));
    return aesCbcPad(k.slice(0, 16), bytes);
  }
  var CRC_T = null;
  function crc32(b) {
    if (!CRC_T) { CRC_T = []; for (var n = 0, c; n < 256; n++) { c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c >>> 0; } }
    var c2 = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) c2 = CRC_T[(c2 ^ b[i]) & 255] ^ (c2 >>> 8);
    return (c2 ^ 0xFFFFFFFF) >>> 0;
  }
  async function zipAesEntry(pw, data) {
    var salt = crypto.getRandomValues(new Uint8Array(16)), pk = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    var km = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 1000, hash: 'SHA-1' }, pk, 528));
    var ek = km.slice(0, 32), hk = km.slice(32, 64), pv = km.slice(64, 66), ct = aesCtrLE(ek, data);
    var hm = await crypto.subtle.importKey('raw', hk, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    var mac = new Uint8Array(await crypto.subtle.sign('HMAC', hm, ct)).slice(0, 10);
    return catB(salt, pv, ct, mac);
  }
  async function bkZip(entries, pw) {
    var now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF, dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    var parts = [], central = [], off = 0;
    var u16 = function (v) { return new Uint8Array([v & 255, (v >> 8) & 255]); }, u32 = function (v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); };
    var extra = catB(u16(0x9901), u16(7), u16(2), strB('AE'), new Uint8Array([3]), u16(0));
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i], nm = strB(e.name), body = await zipAesEntry(pw, e.data);
      var lh = catB(u32(0x04034b50), u16(51), u16(0x0801), u16(99), u16(dt), u16(dd), u32(0), u32(body.length), u32(e.data.length), u16(nm.length), u16(extra.length), nm, extra);
      parts.push(lh, body);
      central.push(catB(u32(0x02014b50), u16(51), u16(51), u16(0x0801), u16(99), u16(dt), u16(dd), u32(0), u32(body.length), u32(e.data.length), u16(nm.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(off), nm, extra));
      off += lh.length + body.length;
    }
    var cd = catB.apply(null, central), end = catB(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(off), u16(0));
    return catB.apply(null, parts.concat([cd, end]));
  }

  function bkPw() { return ls('md.bkpw') || ''; }
  function waNorm(v) {
    var d = String(v || '').replace(/[^\d+]/g, ''), plus = d.charAt(0) === '+'; d = d.replace(/\D/g, '');
    if (!plus && d.indexOf('00') === 0) d = d.slice(2); else if (!plus && d.charAt(0) === '0') d = '44' + d.slice(1);
    return d.length >= 10 && d.length <= 15 ? d : '';
  }
  function waShow(n) { return n.length > 6 ? n.slice(0, 4) + '\u2022\u2022\u2022\u2022\u2022' + n.slice(-3) : n; }
  function bkPdf(all, stamp, pw) {
    var it = [];
    it.push({ t: 'Mortgage Desk - case backup', b: 1, sz: 18, gap: 6 });
    it.push({ t: 'Created ' + stamp + '. ' + all.length + ' case' + (all.length === 1 ? '' : 's') + '.', sz: 10, gap: 10 });
    it.push({ t: 'Contents', b: 1, sz: 11, gap: 2 });
    all.forEach(function (c) { it.push({ t: (c.clientNo || '-') + '   ' + bkNames(c) + '   (' + (BK_STAGE[c.stage] || c.stage || '') + (c.type ? ', ' + c.type : '') + ')', sz: 9 }); });
    all.forEach(function (c) {
      var ap = c.applicants || [];
      it.push({ pb: 1 });
      it.push({ t: (c.clientNo ? c.clientNo + '   ' : '') + bkNames(c), b: 1, sz: 14, gap: 2 });
      it.push({ t: [BK_STAGE[c.stage] || c.stage, c.type, bkProp(c.propUse), c.repayment].filter(Boolean).join('  |  '), sz: 10, gap: 6 });
      it.push({ t: 'Applicants', b: 1, sz: 10.5, gap: 1 });
      ap.forEach(function (a, i) {
        it.push({ t: (i + 1) + '. ' + (a.name || '') + (a.dob ? '   DOB ' + bkDate(a.dob) : ''), ind: 6 });
        var ct = [a.phone, a.email].filter(Boolean).join('   '); if (ct) it.push({ t: ct, ind: 16 });
        if (a.address) it.push({ t: 'Address: ' + a.address, ind: 16 });
        if (a.resMort === 'yes') it.push({ t: 'Mortgage on this address: yes' + (a.resLender ? '  |  ' + a.resLender : '') + (a.resType ? '  |  ' + a.resType : '') + (a.resDealEnd ? '  |  deal ends ' + bkDate(a.resDealEnd) : '') + (a.resBalance ? '  |  approx ' + bkGbp(a.resBalance) : '') + (a.resOwn ? '  |  ' + a.resOwn + ' name(s)' : ''), ind: 16 });
        else if (a.resMort === 'no') it.push({ t: 'Mortgage on this address: no', ind: 16 });
      });
      var conn = bkConn(c, all);
      it.push({ t: 'Connected clients', b: 1, sz: 10.5, gap: 1 }); it.push({ t: conn.length ? conn.join('; ') : 'None', ind: 6 });
      it.push({ t: 'Property and mortgage', b: 1, sz: 10.5, gap: 1 });
      function kv(label, v) { if (v != null && v !== '') it.push({ t: label + ': ' + v, ind: 6 }); }
      kv('Property address', c.propertyAddress); kv('Property value', bkGbp(c.propertyValue)); kv('Purchase price', bkGbp(c.purchasePrice));
      kv('Lender', c.lender); kv('Lender reference', c.lenderRef); kv('Product', c.product); kv('Loan amount', bkGbp(c.loanAmount));
      kv('Initial term (years)', c.termYears); kv('Term left (years)', c.termLeft); kv('Rate', c.rate != null && c.rate !== '' ? c.rate + '%' : ''); kv('Follow-on rate', c.followOnRate != null && c.followOnRate !== '' ? c.followOnRate + '%' : '');
      kv('Initial deal ends', bkDate(c.fixedUntil)); kv('Review date', bkDate(c.reviewDate)); kv('Early repayment charge', c.erc); kv('Monthly payment', bkGbp(c.monthlyPayment));
      kv('AIP expiry', bkDate(c.dipExpiry)); kv('Offer date', bkDate(c.offerDate)); kv('Offer expiry', bkDate(c.offerExpiry)); kv('Completion date', bkDate(c.completionDate)); kv('Conveyancer', c.conveyancer);
      (c.securities || []).forEach(function (s, i) { if (s.address) it.push({ t: 'Other property ' + (i + 1) + ({ btl: ' (Buy to let)', second: ' (Second home)', holiday: ' (Holiday home)', other: ' (Other)' }[s.use] || '') + ': ' + s.address + (s.lender ? '  |  ' + s.lender : '') + (s.product ? '  |  ' + s.product : '') + (s.loanAmount ? '  |  ' + bkGbp(s.loanAmount) : '') + (s.fixedUntil ? '  |  deal ends ' + bkDate(s.fixedUntil) : ''), ind: 6 }); });
      var ts = bkTasks(c, false);
      it.push({ t: 'Tasks', b: 1, sz: 10.5, gap: 1 }); if (!ts.length) it.push({ t: 'None', ind: 6 }); ts.forEach(function (t) { it.push({ t: '- ' + t, ind: 6, hang: 8 }); });
      var ns = bkLog(c.notes);
      it.push({ t: 'Notes', b: 1, sz: 10.5, gap: 1 }); if (!ns.length) it.push({ t: 'None', ind: 6 }); ns.forEach(function (t) { it.push({ t: t, ind: 6, gap: 2 }); });
      var ps = bkLog(c.protection);
      it.push({ t: 'Protection notes', b: 1, sz: 10.5, gap: 1 }); if (!ps.length) it.push({ t: 'None', ind: 6 }); ps.forEach(function (t) { it.push({ t: t, ind: 6, gap: 2 }); });
    });
    return pdfBuild(it, 'Mortgage Desk backup ' + stamp, pw);
  }
  function bkIdb() { return new Promise(function (res) { try { var q = indexedDB.open('md-bk', 1); q.onupgradeneeded = function () { q.result.createObjectStore('h'); }; q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }
  var bkDirMem = {};
  var BK_FILE = 'Mortgage-Desk-Backup.zip';
  async function bkGetDir(slot) {
    if (bkDirMem[slot]) return bkDirMem[slot]; var d = await bkIdb(); if (!d) return null;
    return new Promise(function (res) { try { var r = d.transaction('h').objectStore('h').get(slot); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); } });
  }
  async function bkPutDir(slot, h) {
    if (h) bkDirMem[slot] = h; else delete bkDirMem[slot];
    var d = await bkIdb(); if (!d) return;
    return new Promise(function (res) { try { var t = d.transaction('h', 'readwrite'); if (h) t.objectStore('h').put(h, slot); else t.objectStore('h').delete(slot); t.oncomplete = function () { res(); }; t.onerror = function () { res(); }; } catch (e) { res(); } });
  }
  function bkCanPick() { return typeof window.showDirectoryPicker === 'function'; }
  async function bkPerm(slot, interactive) {
    var h = await bkGetDir(slot); if (!h) return { none: true };
    var p = 'prompt'; try { p = await h.queryPermission({ mode: 'readwrite' }); } catch (e) {}
    if (p !== 'granted') {
      if (!interactive) return { ok: false, msg: 'Needs your permission. Open PDF/CSV Case Backup and press Back up now.' };
      try { p = await h.requestPermission({ mode: 'readwrite' }); } catch (e) { p = 'denied'; }
      if (p !== 'granted') return { ok: false, msg: 'Permission to the folder was not given.' };
    }
    return { ok: true, h: h };
  }
  async function bkWrite(g, blob) {
    if (!g || g.none) return null; if (!g.ok) return g;
    try { var fh = await g.h.getFileHandle(BK_FILE, { create: true }); var w = await fh.createWritable(); await w.write(blob); await w.close(); return { ok: true, msg: 'Saved in ' + g.h.name }; }
    catch (e) { return { ok: false, msg: 'Could not write to the folder (' + (e && e.name || 'error') + ').' }; }
  }
  async function bkRun(interactive) {
    if (bkRunning) return null;
    if (!bkPw()) return { nopw: true };
    var pick = bkCanPick(), g1 = null, g2 = null;
    if (pick) {
      g1 = await bkPerm('dir', interactive); g2 = await bkPerm('dir2', interactive);
      if (g1.none && g2.none) return { nofolder: true };
    } else if (!interactive) return { nofolder: true };
    bkRunning = true;
    try {
      var all = bkCases(), d = new Date(), pad = function (n) { return ('0' + n).slice(-2); };
      var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var stamp = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var pw = bkPw();
      var zipBytes = await bkZip([
        { name: 'Mortgage-Desk-Cases-' + day + '.pdf', data: bkPdf(all, stamp, pw) },
        { name: 'Mortgage-Desk-Cases-' + day + '.csv', data: new TextEncoder().encode(bkCsv(all)) }
      ], pw);
      var blob = new Blob([zipBytes], { type: 'application/zip' });
      var res = { at: Date.now(), count: all.length };
      if (pick) { res.l1 = await bkWrite(g1, blob); res.l2 = await bkWrite(g2, blob); }
      else {
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = BK_FILE; document.body.appendChild(a); a.click();
        await sleep(400); a.remove(); (function (u) { setTimeout(function () { URL.revokeObjectURL(u); }, 20000); })(a.href);
        res.l1 = { ok: true, msg: 'Downloaded to this device (check your Downloads).' };
      }
      var cfg = bkCfg(); cfg.tried = Date.now();
      var bad = [res.l1, res.l2].some(function (x) { return x && !x.ok; });
      if (!bad) cfg.last = Date.now();
      cfg.res = res; bkSave(cfg);
      return res;
    } finally { bkRunning = false; }
  }
  function bkTick() {
    var cfg = bkCfg();
    if (!cfg.auto || !bkPw() || !tok() || !Object.keys(mem.cases).length) return;
    var now = Date.now();
    if (now - cfg.last < 86400000) return;
    if (now - cfg.tried < 3600000) return;
    bkRun(false).then(function () { var m = $('bkMsg'); if (m) bkPaint(); }).catch(function () {});
  }
  function bkStart() { setTimeout(bkTick, 20000); clearInterval(bkTimer); bkTimer = setInterval(bkTick, 600000); document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(bkTick, 3000); }); }
  function bkPaint() {
    var cfg = bkCfg(), el = $('bkStatus'); if (!el) return;
    var r = cfg.res || {}, f = function (d) { return new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }, h = '';
    h += cfg.last ? 'Last successful backup: ' + f(cfg.last) + '.' : 'No backup yet.';
    if (r.at) {
      h += '<br>Last attempt ' + f(r.at) + ' (' + (r.count || 0) + ' cases):';
      if (r.l1) h += '<br>' + (r.l1.ok ? '\u2713' : '\u2717') + ' Location 1: ' + esc(r.l1.msg);
      if (r.l2) h += '<br>' + (r.l2.ok ? '\u2713' : '\u2717') + ' Location 2: ' + esc(r.l2.msg);
    }
    el.innerHTML = h;
  }
  function reFresh() { return Date.now() - (+ls('md.reauthOk') || 0) < 600000; }
  function reGate(next) {
    if (reFresh()) return true;
    if (confirm('To change this, Microsoft will ask for your account password again to confirm it is you. Continue?')) { lset('md.reauth', '1'); lset('md.reauthNext', next); startLogin(true); }
    return false;
  }
  function profGet() { try { return JSON.parse(ls('md.profile') || '{}') || {}; } catch (e) { return {}; } }
  function waNum() { return profGet().phone || ls('md.bkwa') || ''; }
  function openProfile() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
    var inp = 'width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #D4DBDF;border-radius:8px;font:inherit;margin:4px 0 10px';
    function draw(msg) {
      var p = profGet(), ph = p.phone || ls('md.bkwa') || '', acc = (tok() || {}).account || {}, lk = !!(p.name || p.phone || p.biz || p.email) && !reFresh(), dis = lk ? ' disabled' : '';
      ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(520px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">My profile</h2><button class="btn ghost" data-p="close">Close</button></div>' +
        '<p style="margin:12px 0;color:#58697A;font-size:13px">Your own details. They stay on this device. Your mobile number is used in the backup section to send you your backup password on WhatsApp.</p>' +
        (lk ? '<p style="margin:0 0 10px;padding:8px 10px;background:#FFF6DD;border-radius:8px;font-size:13px">Your profile is locked. To change anything, confirm with your Microsoft account password.</p><button class="btn" data-p="unlock" style="margin-bottom:12px">Unlock to edit</button>' : '') + '<label>Your name</label><input id="prName"' + dis + ' type="text" maxlength="80" value="' + esc(p.name || '') + '" style="' + inp + '">' +
        '<label>Business name</label><input id="prBiz"' + dis + ' type="text" maxlength="80" value="' + esc(p.biz || '') + '" style="' + inp + '">' +
        '<label>Mobile number (WhatsApp)</label>' + (p.phone
          ? '<div style="display:flex;gap:8px;align-items:center;margin:4px 0 10px"><input type="text" disabled value="+' + esc(waShow(p.phone)) + '" style="flex:1;padding:8px 10px;border:1px solid #D4DBDF;border-radius:8px;font:inherit;background:#EDF0F1"><button class="btn ghost" data-p="chg"' + dis + '>Change number</button></div><div id="prChg"></div>'
          : '<input id="prPhone" type="tel" placeholder="e.g. 07722223199" value="' + esc(ph) + '" style="' + inp + '"><p style="margin:-6px 0 10px;color:#58697A;font-size:12px">Once saved, the number is locked. Changing it later needs your Microsoft account password.</p>') +
        '<label>Email address</label><input id="prMail"' + dis + ' type="email" maxlength="120" value="' + esc(p.email || '') + '" placeholder="' + esc(acc.mail || '') + '" style="' + inp + '">' +
        '<button class="btn" data-p="save"' + dis + '>Save profile</button><p id="prMsg" style="min-height:18px;margin:10px 0 0">' + esc(msg || '') + '</p></div>';
    }
    draw();
    var say = function (m) { var e = $('prMsg'); if (e) e.textContent = m; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-p]'); if (!b) return; b = b.getAttribute('data-p');
      var p = profGet();
      if (b === 'close') ov.remove();
      else if (b === 'unlock') { reGate('profile'); }
      else if (b === 'save') {
        if ((p.name || p.phone || p.biz || p.email) && !reGate('profile')) return;
        var mail = (($('prMail') || {}).value || '').trim();
        if (mail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) { say('That email address does not look right.'); return; }
        var ph = p.phone || '';
        if (!ph) { var raw = (($('prPhone') || {}).value || '').trim(); if (raw) { ph = waNorm(raw); if (!ph) { say('That does not look like a phone number.'); return; } } }
        lset('md.profile', JSON.stringify({ name: (($('prName') || {}).value || '').trim(), biz: (($('prBiz') || {}).value || '').trim(), phone: ph, email: mail }));
        draw('Profile saved.' + (ph ? ' Your number is now locked and is used in the backup section.' : ''));
      } else if (b === 'chg') {
        var bx = $('prChg'); if (!bx) return;
        if (!reGate('profile')) return;
        bx.innerHTML = '<input id="prNew" type="tel" placeholder="New mobile number" style="' + inp + '"><button class="btn" data-p="chgok">Change number</button>';
      } else if (b === 'chgok') {
        if (!reGate('profile')) return;
        var nn = waNorm(($('prNew') || {}).value); if (!nn) { say('That does not look like a phone number.'); return; }
        p.phone = nn; lset('md.profile', JSON.stringify(p)); draw('Number changed and locked.');
      }
    });
  }
  async function openBackup() {
    ['md.bkq', 'md.bkrec', 'md.bkhint', 'md.bkwa'].forEach(function (k) { if (k !== 'md.bkwa' || profGet().phone) lset(k, null); });
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
    var names = { dir: '', dir2: '' }, pick = bkCanPick(), editPw = false;
    if (pick) { var h1 = await bkGetDir('dir'), h2 = await bkGetDir('dir2'); names.dir = h1 ? h1.name : ''; names.dir2 = h2 ? h2.name : ''; }
    var box = 'padding:8px 10px;border:1px solid #D4DBDF;border-radius:8px;font:inherit;flex:1;min-width:150px';
    function loc(slot, label, opt) {
      return '<div style="display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap"><div style="flex:1;min-width:180px"><b>' + label + '</b><br><span style="color:#58697A;font-size:13px">' + (names[slot] ? 'Folder: <b>' + esc(names[slot]) + '</b>' : (opt ? 'Optional' : 'Not chosen yet')) + '</span></div>' +
        '<button class="btn ghost sm" data-b="pick" data-slot="' + slot + '">' + (names[slot] ? 'Change' : 'Choose folder') + '</button>' + (opt && names[slot] ? '<button class="btn ghost sm" data-b="unpick" data-slot="' + slot + '">Remove</button>' : '') + '</div>';
    }
    function draw() {
      var c = bkCfg(), hasPw = !!bkPw(), num = waNum(), editing = !hasPw || editPw, dis = editing ? '' : ' disabled', dstyle = editing ? '' : ';background:#EDF0F1;color:#8a98a3';
      ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(560px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">PDF/CSV Case Backup</h2><button class="btn ghost" data-b="close">Close</button></div>' +
        '<p style="margin:12px 0;color:#58697A">Saves every case as a PDF and a CSV inside one password-protected ZIP file. Each new backup replaces the previous one.</p>' +
        '<h3 style="margin:14px 0 4px;font-size:15px">1. Where to save</h3>' +
        (pick ? loc('dir', 'Location 1', false) + loc('dir2', 'Location 2', true) : '<p style="margin:4px 0;color:#58697A;font-size:13px">This browser cannot save to a chosen folder (phones and some browsers). Back up now downloads the ZIP file to this device instead.</p>') +
        '<h3 style="margin:16px 0 4px;font-size:15px">2. Backup password</h3>' +
        '<p style="margin:4px 0 8px;color:#58697A;font-size:13px">' + (hasPw ? (editing ? 'Type the new password twice, then press Save password.' : 'A password is saved. You need it to open the ZIP and the PDF inside. Press Change password to set a new one.') : 'Choose a password of at least 8 characters. You need it to open the backup.') + ' It is kept on this device so automatic backups can run. If you lose it the backup cannot be opened.</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px"><input id="bkPw"' + dis + ' type="password" autocomplete="new-password" placeholder="' + (hasPw ? (editing ? 'New password' : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') : 'Password') + '" style="' + box + dstyle + '"><input id="bkPw2"' + dis + ' type="password" autocomplete="new-password" placeholder="Confirm password" style="' + box + dstyle + '"></div>' +
        '<div style="margin-top:8px;display:flex;gap:8px"><button class="btn" data-b="' + (editing ? 'pw' : 'pwedit') + '">' + (editing ? 'Save password' : 'Change password') + '</button>' + (hasPw && editing ? '<button class="btn ghost" data-b="pwcancel">Cancel</button>' : '') + '</div>' +
        '<h3 style="margin:16px 0 4px;font-size:15px">3. Back up</h3>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0"><input type="checkbox" id="bkAuto"' + (c.auto ? ' checked' : '') + ' style="margin-top:3px"><span>Back up automatically every 24 hours<br><span style="color:#58697A;font-size:13px">Runs while the app is open. If it was closed, it runs the next time you open it.</span></span></label>' +
        '<div style="margin:12px 0 8px"><button class="btn" data-b="run">Back up now</button></div>' +
        '<p id="bkStatus" style="margin:8px 0;font-size:13px;color:#2b3b47"></p>' +
        (hasPw ? '<h3 style="margin:16px 0 4px;font-size:15px">Forgot the password?</h3>' + (num ? '<p style="margin:4px 0 8px;color:#58697A;font-size:13px">Sends it to the mobile number in <a href="#" data-b="profile">My profile</a>: <b>+' + esc(waShow(num)) + '</b>. WhatsApp opens with the message ready and you press Send.</p><button class="btn ghost" data-b="wasend">Send password reminder to my WhatsApp</button>' : '<p style="margin:4px 0 8px;color:#58697A;font-size:13px">Add your mobile number in <a href="#" data-b="profile">My profile</a> and a reminder button will appear here.</p>') : '') +
        '<p id="bkMsg" style="min-height:18px;margin:10px 0 0"></p></div>';
      bkPaint();
    }
    draw();
    var say = function (m) { var e = $('bkMsg'); if (e) e.textContent = m; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'bkAuto') { var c = bkCfg(); c.auto = e.target.checked; bkSave(c); say('Saved.'); }
    });
    ov.addEventListener('click', async function (e) {
      var el = e.target.closest && e.target.closest('[data-b]'); if (!el) return; var b = el.getAttribute('data-b'), slot = el.getAttribute('data-slot');
      if (b === 'close') ov.remove();
      else if (b === 'profile') { e.preventDefault(); ov.remove(); openProfile(); }
      else if (b === 'pick') {
        try { var h = await window.showDirectoryPicker({ mode: 'readwrite' }); await bkPutDir(slot, h); names[slot] = h.name; draw(); say('Folder chosen.'); }
        catch (x) { if (!x || x.name !== 'AbortError') say('Could not choose that folder.'); }
      } else if (b === 'unpick') { await bkPutDir(slot, null); names[slot] = ''; draw(); say('Location removed.'); }
      else if (b === 'pwedit') { editPw = true; draw(); var f = $('bkPw'); if (f) f.focus(); }
      else if (b === 'pwcancel') { editPw = false; draw(); }
      else if (b === 'pw') {
        var pv = ($('bkPw') || {}).value || '', pv2 = ($('bkPw2') || {}).value || '';
        if (pv.length < 8) { say('The password needs at least 8 characters.'); return; }
        if (/[^\x20-\x7E]/.test(pv)) { say('Please use letters, numbers and ordinary symbols only.'); return; }
        if (pv !== pv2) { say('The two passwords do not match. Please type them again.'); return; }
        lset('md.bkpw', pv); editPw = false; draw(); say('Password saved. Remember it: you need it to open your backups.');
      } else if (b === 'wasend') {
        var wn = waNum(); if (!wn || !bkPw()) return;
        window.open('https://wa.me/' + wn + '?text=' + encodeURIComponent('Mortgage Desk backup password: ' + bkPw()), '_blank', 'noopener');
        say('WhatsApp should open. Tap Send to keep the message in your chat.');
      } else if (b === 'run') {
        if (!bkPw()) { say('Set a backup password first.'); return; }
        if (pick && !names.dir && !names.dir2) { say('Choose a folder for Location 1 first.'); return; }
        say('Backing up…');
        var r = await bkRun(true); bkPaint();
        if (r && r.nopw) say('Set a backup password first.');
        else if (r && r.nofolder) say('Choose a folder for Location 1 first.');
        else if (r) say(((!r.l1 || r.l1.ok) && (!r.l2 || r.l2.ok)) ? 'Backup finished.' : 'Backup finished with a problem. See below.');
      }
    });
  }

  /* ---------- collections ---------- */
  function collection(col) {
    return {
      onSnapshot: function (cb) { subs[col].push(cb); try { cb(snap(col)); } catch (e) { console.error(e); } return function () { subs[col] = subs[col].filter(function (x) { return x !== cb; }); }; },
      doc: function (id) {
        id = safeId(id || genId());
        return {
          id: id,
          set: function (data) { var cu = mem[col][id]; data = clone(data); if (col === 'appointments' && cu && cu.data && cu.data.calId && data.calId == null) { data.calId = cu.data.calId; data.calH = cu.data.calH; } localWrite(col, id, data, 'set'); return Promise.resolve(); },
          update: function (patch) {
            var cur = mem[col][id], diff = {};
            Object.keys(patch).forEach(function (k) { if (!cur || JSON.stringify(cur.data[k]) !== JSON.stringify(patch[k])) diff[k] = clone({ v: patch[k] }).v; });
            if (!Object.keys(diff).length) return Promise.resolve();
            localWrite(col, id, Object.assign(cur ? clone(cur.data) : {}, clone(diff)), 'patch', diff); return Promise.resolve();
          },
          delete: function () { localDelete(col, id); return Promise.resolve(); },
          get: function () { var c = mem[col][id]; return Promise.resolve(c ? { id: id, exists: true, data: function () { return clone(c.data); } } : { id: id, exists: false }); }
        };
      }
    };
  }

  /* ---------- sign-in screen ---------- */
  var readyRes; var ready = new Promise(function (r) { readyRes = r; });
  function overlay(html) {
    var o = $('mdSign');
    if (!o) { o = document.createElement('div'); o.id = 'mdSign'; o.style.cssText = 'position:fixed;inset:0;z-index:300;background:#EDF0F1;display:flex;align-items:center;justify-content:center;padding:16px;font:15px system-ui,"Segoe UI",sans-serif;color:#101C26'; document.body.appendChild(o); }
    o.innerHTML = html; return o;
  }
  function showSignIn(msg) {
    if (!msg) { try { if (localStorage.getItem('md.idleMsg')) { localStorage.removeItem('md.idleMsg'); msg = 'You were signed out after ' + idleLabel() + ' of inactivity. Sign in again to continue.'; } } catch (e) {} }
    var bad = !CFG.clientId || /PASTE/i.test(CFG.clientId);
    var o = overlay('<div style="width:min(420px,100%);background:#fff;border:1px solid #D4DBDF;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(16,28,38,.12)">' +
      '<div style="font-weight:700;font-size:20px;margin-bottom:6px">&#9670; Mortgage Desk</div>' +
      '<p style="color:#58697A;margin:0 0 18px;font-size:14px;line-height:1.45">Sign in with your Microsoft account. Your cases are stored in your own OneDrive and nowhere else.</p>' +
      (bad ? '<p style="color:#A3261F;font-size:14px">This copy has not been set up yet (no Microsoft app ID).</p>' : '<button id="mdGo" style="width:100%;padding:12px;border:0;border-radius:8px;background:#0A6B50;color:#fff;font:600 15px system-ui;cursor:pointer">Sign in with Microsoft</button>') +
      '<div id="mdErr" style="color:#A3261F;font-size:13px;margin-top:12px;min-height:16px">' + esc(msg || '') + '</div></div>');
    var b = o.querySelector('#mdGo'); if (b) b.onclick = function () { b.disabled = true; startLogin(); };
  }
  function sessionExpired() { showSignIn('Your sign-in has expired. Please sign in again. Your unsaved changes are kept on this device.'); }

  /* ---------- account / settings ---------- */
  async function openAccount() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
    var t = tok() || {};
    function render(msg) {
      var acc = t.account || {};
      ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(560px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">Settings</h2><button class="btn ghost" data-a="close">Close</button></div>' +
        '<p style="margin:14px 0 4px"><b>Signed in as</b><br>' + esc(acc.name || '') + ' ' + esc(acc.mail || '') + '</p>' +
        '<p style="margin:6px 0 0;color:#1b5e20;font-size:13px">' + esc((($('syncState') || {}).textContent || '').trim()) + '</p>' +
        '<p style="margin:10px 0 0;color:#58697A;font-size:12px">App version: ' + esc(window.MD_BUILD || 'unknown') + ' &middot; <a href="#" data-a="guide">Quick guide</a></p><p style="margin:10px 0;color:#58697A">Cases are saved in your OneDrive, in the folder <b>' + esc(ROOT) + '</b>. ' + esc(pending() ? pending() + ' change(s) are waiting to upload.' : 'Everything is uploaded.') + '</p>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">My profile</h3><p style="margin:0 0 8px;color:#58697A">' + (profGet().name ? esc(profGet().name) + (profGet().biz ? ' &middot; ' + esc(profGet().biz) : '') : 'Add your name, business, mobile number and email.') + '</p><button class="btn" data-a="profile">' + (profGet().name || profGet().phone ? 'Edit profile' : 'Set up profile') + '</button>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Security</h3>' + (pinData() ? '<p style="margin:0 0 8px;color:#1b5e20">PIN is on. The screen locks after ' + (LOCK_MS / 60000) + ' minutes with no activity.</p><button class="btn ghost" data-a="pin">Change PIN &amp; Auto-lock</button>' : '<p style="margin:0 0 8px;color:#b3261e;background:#fdecea;border-radius:6px;padding:8px 10px"><b>Warning:</b> no PIN is set. Anyone who picks up this device while you are signed in can see your clients. Set a PIN so the screen locks after ' + (LOCK_MS / 60000) + ' minutes with no activity.</p><button class="btn" data-a="pin">Set up PIN</button>') +
        '<h3 style="margin:18px 0 6px;font-size:15px">Sync</h3><div style="margin:0 0 6px"><button class="btn" data-a="sync">Sync now</button></div>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">PDF/CSV Case Backup</h3><p style="margin:0 0 8px;color:#58697A">Saves all cases as a password-protected ZIP (PDF and CSV) to the folders you choose, with an automatic backup every 24 hours.</p><button class="btn" data-a="pdfbk" style="background:#2f4a40;border-color:#2f4a40;color:#fff">PDF/CSV Case Backup</button>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Import a backup file</h3><p style="margin:0 0 8px;color:#58697A">Loads cases from a Mortgage Desk backup (.json). Cases that already exist are not overwritten.</p>' +
        '<input type="file" id="mdImp" accept=".json,application/json" style="max-width:100%">' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Restore from backup</h3><p style="margin:0 0 8px;color:#58697A">Use this if something was changed or deleted by mistake. Cases in the backup file replace the matching cases here.</p><input type="file" id="mdRes" accept=".json,application/json" style="max-width:100%">' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Calendar reminders</h3>' + (calOn()
          ? '<p style="margin:0 0 8px;color:#1b5e20">On. Booked appointments are added to your Outlook calendar with a ' + CAL_MIN + '-minute reminder.</p><button class="btn ghost" data-a="caloff">Turn off</button>'
          : '<p style="margin:0 0 8px;color:#58697A">Adds each booked appointment to your Outlook calendar with a ' + CAL_MIN + '-minute reminder, so your phone alerts you even when this app is closed. You will be asked to approve calendar access once.</p><button class="btn" data-a="calon">Turn on</button>') +
        '<p style="margin:8px 0 0;color:#58697A;font-size:12px">Only the name, time, type, method and place go to the calendar, never your notes. On your phone, use the Outlook app or add this Microsoft account to your phone calendar, and allow notifications.</p>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Log out</h3><p style="margin:0 0 8px;color:#58697A">Removes the cases from this device. They stay safe in OneDrive.</p><button class="btn" data-a="out">Log out</button>' +
        '<p style="margin-top:14px;min-height:18px" id="mdAccMsg">' + esc(msg || '') + '</p></div>';
    }
    render('');
    var say = function (m) { var e = $('mdAccMsg'); if (e) e.textContent = m; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('change', async function (e) {
      var isRes = e.target.id === 'mdRes';
      if ((e.target.id !== 'mdImp' && !isRes) || !e.target.files[0]) return;
      if (isRes && !confirm('Restore from this backup? Cases in the file replace the matching cases here with the backup version. Cases not in the file are left alone.')) { e.target.value = ''; return; }
      try {
        var p = JSON.parse(await e.target.files[0].text()), n = 0, skipped = 0;
        COLS.forEach(function (col) {
          (p[col] || []).forEach(function (row) {
            var id = safeId(row.id || genId()); if (mem[col][id] && !isRes) { skipped++; return; }
            var d = clone(row); delete d.id; localWrite(col, id, d, 'set'); n++;
          });
        });
        say((isRes ? 'Restored ' : 'Imported ') + n + ' item(s)' + (skipped ? ', skipped ' + skipped + ' that already exist' : '') + '. Uploading to OneDrive…');
        flush();
      } catch (x) { say('That file could not be read as a backup.'); }
    });
    ov.addEventListener('click', async function (e) {
      var a = e.target.closest && e.target.closest('[data-a]'); if (!a) return; a = a.getAttribute('data-a');
      if (a === 'close') ov.remove();
      else if (a === 'backup') { var bb = $('backupBtn'); if (bb) bb.click(); }
      else if (a === 'sync') { say('Syncing…'); await flush(); await pull(); say(st.err || (st.offline ? 'Offline. Will retry.' : 'Up to date.')); }
      else if (a === 'folder') { try { var r = await gfetch(APP); var j = await r.json(); if (j.webUrl) window.open(j.webUrl, '_blank'); else say('Folder not created yet.'); } catch (x) { say('Could not reach OneDrive.'); } }
      else if (a === 'calon') { lset('md.calwant', '1'); startLogin(); }
      else if (a === 'caloff') { lset('md.cal', null); render('Calendar reminders turned off. Events already in Outlook stay there.'); }
      else if (a === 'pdfbk') { ov.remove(); openBackup(); }
      else if (a === 'profile') { ov.remove(); openProfile(); }
      else if (a === 'pin') { if (pinData() && !reGate('pin')) return; ov.remove(); openPin(); }
      else if (a === 'guide') { e.preventDefault(); openGuide(); }
      else if (a === 'out') { ov.remove(); signOut(); }
    });
  }
  async function signOut() {
    if (pending()) { try { await flush(); } catch (e) {} }
    var msg = pending()
      ? pending() + ' change(s) have not reached OneDrive yet and will be lost. Log out anyway?'
      : 'Log out? Cases are removed from this device and load again when you sign in. Signing in again also loads the latest version of the app.';
    if (!confirm(msg)) return;
    await wipeAndReload(false);
  }
  async function wipeAndReload(auto) {
    try { if (window.caches) { var ks = await caches.keys(); await Promise.all(ks.map(function (k) { return caches.delete(k); })); } } catch (e) {}
    try { if (navigator.serviceWorker) { var rg = await navigator.serviceWorker.getRegistrations(); await Promise.all(rg.map(function (r) { return r.unregister(); })); } } catch (e) {}
    await idbClearAll(); setTok(null);
    try { localStorage.removeItem('md.pkce'); localStorage.removeItem('md.reauthOk'); } catch (e) {}
    if (auto) { try { localStorage.setItem('md.idleMsg', '1'); } catch (e) {} }
    location.replace(location.pathname + '?fresh=' + Date.now());
  }
  /* ---------- automatic log out after a period with no activity (default 2 hours) ---------- */
  var IDLE_MS = Math.max(0.05, +(CFG.idleMinutes || 120)) * 60000, idleBusy = false, lastW = 0;
  function idleLabel() { var m = IDLE_MS / 60000; return m >= 60 ? (m / 60 === 1 ? '1 hour' : (m / 60) + ' hours') : m + ' minutes'; }
  function markAct() { if (locked) return; try { localStorage.setItem('md.act', String(Date.now())); } catch (e) {} }
  function lastAct() { var v = 0; try { v = +localStorage.getItem('md.act') || 0; } catch (e) {} return v || Date.now(); }
  function isIdle() { return Date.now() - lastAct() >= IDLE_MS; }
  async function autoSignOut() {
    if (pending()) { try { await flush(); } catch (e) {} }
    if (pending()) {
      setTok(null);
      showSignIn('You were signed out after ' + idleLabel() + ' of inactivity. Changes not yet saved to OneDrive are kept on this device and upload when you sign in.');
      return;
    }
    await wipeAndReload(true);
  }

  /* ---------- PIN screen lock (auto-locks after 15 minutes with no activity, only when a PIN is set) ---------- */
  var locked = false, LOCK_MS = Math.max(0.05, +(CFG.lockMinutes || 15)) * 60000, pinFails = 0;
  function pinData() { try { return JSON.parse(ls('md.pin') || 'null'); } catch (e) { return null; } }
  function b64(buf) { var a = new Uint8Array(buf), s2 = ''; for (var i = 0; i < a.length; i++) s2 += String.fromCharCode(a[i]); return btoa(s2); }
  function unb64(t) { var s2 = atob(t), a = new Uint8Array(s2.length); for (var i = 0; i < s2.length; i++) a[i] = s2.charCodeAt(i); return a; }
  async function pinHash(pin, salt) {
    var k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, k, 256));
  }
  async function pinSet(pin) { var salt = crypto.getRandomValues(new Uint8Array(16)); lset('md.pin', JSON.stringify({ s: b64(salt), h: await pinHash(pin, salt) })); }
  async function pinCheck(pin) { var d = pinData(); if (!d) return true; return (await pinHash(pin, unb64(d.s))) === d.h; }
  function lockDue() { return !!pinData() && Date.now() - lastAct() >= LOCK_MS; }
  function lockNow() {
    if (locked || !pinData()) return;
    locked = true; lset('md.locked', '1'); pinFails = 0;
    var ov = document.createElement('div'); ov.id = 'mdLock';
    ov.style.cssText = 'position:fixed;inset:0;z-index:400;background:#0f1f1a;color:#fff;display:flex;align-items:center;justify-content:center;padding:16px;font:15px system-ui,sans-serif';
    ov.innerHTML = '<form style="width:min(340px,100%);text-align:center" autocomplete="off"><div style="font-size:40px">🔒</div><h2 style="margin:8px 0 4px;font-size:22px">Mortgage Desk is locked</h2><p style="margin:0 0 16px;color:#b9c8c0;font-size:13px">Enter your PIN to carry on.</p>' +
      '<input id="mdLockPin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN" style="width:100%;box-sizing:border-box;padding:12px;font-size:22px;letter-spacing:.3em;text-align:center;border-radius:8px;border:1px solid #3d5a4e;background:#fff;color:#101C26">' +
      '<button type="submit" id="mdLockGo" style="width:100%;margin-top:12px;padding:12px;font-size:16px;border:0;border-radius:8px;background:#2f8f6b;color:#fff;cursor:pointer">Unlock</button>' +
      '<p id="mdLockMsg" style="min-height:20px;margin:10px 0 0;color:#ffb4a8;font-size:13px"></p><button type="button" id="mdLockOut" style="background:none;border:0;color:#b9c8c0;text-decoration:underline;cursor:pointer;font-size:13px">Forgot PIN? Log out</button></form>';
    document.body.appendChild(ov);
    var app = $('app'); if (app) { try { app.inert = true; } catch (e) {} }
    var inp = $('mdLockPin'), msg = $('mdLockMsg'); setTimeout(function () { inp.focus(); }, 30);
    var autoSeq = 0;
    inp.addEventListener('input', async function () {
      var v = inp.value.trim(), my = ++autoSeq;
      if (v.length < 4 || v.length > 8) return;
      var ok = false; try { ok = await pinCheck(v); } catch (x) { ok = false; }
      if (ok && my === autoSeq && !$('mdLock') === false) unlock();
    });
    ov.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault(); var v = inp.value.trim(); if (!v) return;
      var ok = false; try { ok = await pinCheck(v); } catch (x) { ok = false; }
      if (ok) { unlock(); return; }
      pinFails++; inp.value = '';
      if (pinFails >= 5) { msg.textContent = 'Too many wrong attempts. Logging out…'; autoSignOut(); return; }
      msg.textContent = 'Wrong PIN. ' + (5 - pinFails) + ' attempt' + (5 - pinFails === 1 ? '' : 's') + ' left.'; inp.focus();
    });
    $('mdLockOut').addEventListener('click', function () { signOut(); });
  }
  function unlock() {
    locked = false; lset('md.locked', null); markAct();
    var ov = $('mdLock'); if (ov) ov.remove();
    var app = $('app'); if (app) { try { app.inert = false; } catch (e) {} }
  }
  function checkLock() { if (!locked && tok() && lockDue()) lockNow(); }
  function startLockWatch() {
    if (pinData() && (ls('md.locked') === '1' || lockDue())) lockNow();
    setInterval(checkLock, Math.min(15000, LOCK_MS / 2));
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkLock(); });
    window.addEventListener('focus', checkLock); window.addEventListener('pageshow', checkLock);
  }


  function openGuide() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:260;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(520px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)"><h2 style="margin:0 0 10px;font-size:20px">Quick guide</h2>' +
      '<ul style="margin:0 0 12px;padding-left:20px"><li><b>Tasks</b> (home page): tick things off. Tap a task to change its date or edit it.</li><li><b>Create Case</b> opens a new client. Everything saves by itself to your OneDrive.</li><li><b>Tools</b> (left bar): Mortgage Calculator, Notebook, Birthdays and Settings.</li><li><b>Reminders</b> (right of the home page): mortgage reviews coming up.</li><li><b>Settings</b>: set a PIN, sync, back up to PDF/CSV, restore, calendar reminders.</li></ul>' +
      '<p style="margin:0 0 6px"><b>Please do not record</b> NI numbers, bank or sort-code details, passport numbers, income and expenditure, health or lifestyle answers, immigration share codes or benefit amounts.</p>' +
      '<p style="margin:0 0 14px;color:#58697A">Keep your own Microsoft login private, and save your Microsoft recovery code somewhere safe.</p><button class="btn" data-g="1">Got it</button></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if ((e.target.closest && e.target.closest('[data-g]')) || e.target === ov) ov.remove(); });
  }
  function guideMaybe() { if (!tok() || ls('md.guide')) return false; lset('md.guide', '1'); openGuide(); return true; }
  function pinWarnMaybe() {
    if (!tok() || guideMaybe() || pinData()) return;
    var last = +ls('md.pinwarn') || 0; if (Date.now() - last < 7 * 86400000) return;
    lset('md.pinwarn', String(Date.now()));
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(420px,100%);border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)"><h2 style="margin:0 0 8px;font-size:19px">⚠️ Security reminder</h2><p style="margin:0 0 14px;color:#33444f">You have not set a PIN. Your client details are visible to anyone who picks up this device while you are signed in. A PIN locks the screen after ' + (LOCK_MS / 60000) + ' minutes with no activity.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-w="set">Set up PIN</button><button class="btn ghost" data-w="later">Remind me in 7 days</button></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-w]'); if (!b) return;
      ov.remove(); if (b.getAttribute('data-w') === 'set') openPin();
    });
  }
  function openPin() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
    var inS = 'width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c9d3da;border-radius:6px;font-size:15px;margin:4px 0 10px';
    function draw(msg, good) {
      var has = !!pinData(), mins = LOCK_MS / 60000;
      ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(460px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">' + (has ? 'Change PIN &amp; Auto-lock' : 'Set up PIN') + '</h2><button class="btn ghost" data-p="close">Close</button></div>' +
        '<p style="margin:12px 0;color:#58697A">' + (has ? '<b style="color:#1b5e20">PIN is on.</b> The screen locks by itself after ' + mins + ' minutes with no activity, and you unlock it with your PIN.' : 'Set a PIN and the screen will lock by itself after ' + mins + ' minutes with no activity. Without a PIN, nothing locks.') + '</p>' +
        (has ? '<label>Current PIN<input id="pnCur" type="password" inputmode="numeric" maxlength="12" autocomplete="off" style="' + inS + '"></label>' : '') +
        '<label>' + (has ? 'New PIN' : 'Choose a PIN') + ' (4 to 8 digits)<input id="pnNew" type="password" inputmode="numeric" maxlength="8" autocomplete="off" style="' + inS + '"></label>' +
        '<label>Repeat PIN<input id="pnNew2" type="password" inputmode="numeric" maxlength="8" autocomplete="off" style="' + inS + '"></label>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px"><button class="btn" data-p="save">' + (has ? 'Change PIN' : 'Set PIN') + '</button>' + (has ? '<button class="btn ghost" data-p="lock">Lock now</button><button class="btn ghost" data-p="remove">Remove PIN</button>' : '') + '</div>' +
        '<p id="pnMsg" style="min-height:18px;margin:12px 0 0;color:' + (good ? '#1b5e20' : '#b3261e') + '">' + esc(msg || '') + '</p>' +
        '<p style="margin:8px 0 0;color:#58697A;font-size:12px">This is a screen lock for this device only. Your PIN is stored here as a scrambled code, never in OneDrive. If you forget it, log out and sign in again with Microsoft.</p></div>';
    }
    draw('');
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('click', async function (e) {
      var b = e.target.closest && e.target.closest('[data-p]'); if (!b) return; var a = b.getAttribute('data-p');
      if (a === 'close') { ov.remove(); return; }
      if (a === 'lock') { ov.remove(); lockNow(); return; }
      var cur = $('pnCur'), has = !!pinData();
      if (has) { var okc = false; try { okc = await pinCheck(cur ? cur.value.trim() : ''); } catch (x) {} if (!okc) { draw('Current PIN is wrong.'); return; } }
      if (a === 'remove') { lset('md.pin', null); lset('md.locked', null); draw('PIN removed. The screen will no longer lock.', true); return; }
      if (a === 'save') {
        var n1 = $('pnNew').value.trim(), n2 = $('pnNew2').value.trim();
        if (!/^\d{4,8}$/.test(n1)) { draw('The PIN must be 4 to 8 digits.'); return; }
        if (n1 !== n2) { draw('The two PINs do not match.'); return; }
        try { await pinSet(n1); } catch (x) { draw('This browser cannot store a PIN here.'); return; }
        markAct(); draw(has ? 'PIN changed.' : 'PIN set. The screen locks after ' + (LOCK_MS / 60000) + ' minutes of no activity.', true);
      }
    });
  }
  function checkIdle() {
    if (idleBusy || !tok() || !isIdle()) return;
    idleBusy = true; autoSignOut().then(function () { idleBusy = false; }, function () { idleBusy = false; });
  }
  function startIdleWatch() {
    var gap = Math.min(5000, IDLE_MS / 4);
    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel', 'click'].forEach(function (ev) {
      window.addEventListener(ev, function () { var n = Date.now(); if (n - lastW > gap) { lastW = n; markAct(); } }, { capture: true, passive: true });
    });
    setInterval(checkIdle, Math.min(30000, IDLE_MS / 2));
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkIdle(); });
    window.addEventListener('focus', checkIdle); window.addEventListener('pageshow', checkIdle);
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#settingsBtn,#logoutBtn'); if (!b) return;
    e.preventDefault(); e.stopPropagation();
    if (b.id === 'logoutBtn') signOut(); else openAccount();
  }, true);

  /* ---------- downloads (Backup / CSV buttons) ---------- */
  function saveFile(o) {
    return new Promise(function (res) {
      var blob = new Blob([o.data], { type: /\.csv$/i.test(o.filename) ? 'text/csv' : 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = o.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); res();
    });
  }
  window.claude = { use: function (name) {
    if (name === 'db') return ready;
    if (name === 'downloads') return Promise.resolve({ save: saveFile });
    return Promise.resolve(null);
  } };

  /* ---------- start ---------- */
  function addSyncBadge() {
    if ($('syncState')) return;
    var b = $('backupBtn'); if (!b) return;
    var s = document.createElement('span'); s.id = 'syncState'; s.style.cssText = 'font-size:12px;white-space:nowrap;margin-right:6px'; b.parentNode.insertBefore(s, b); setState();
  }
  async function loadCache() {
    (await idbAll('docs')).forEach(function (r) { if (mem[r.col]) mem[r.col][r.id] = { data: r.data, etag: r.etag, itemId: r.itemId }; });
    (await idbAll('dirty')).forEach(function (d) { dirty[d.k] = d; vctr = Math.max(vctr, d.v || 0); });
  }
  async function handleRedirect() {
    var p = new URLSearchParams(location.search);
    if (p.get('fresh') && !p.get('code') && !p.get('error')) { history.replaceState(null, '', location.pathname); return; }
    if (!p.get('code') && !p.get('error')) { lset('md.calwant', null); lset('md.reauth', null); return; }
    var clean = function () { history.replaceState(null, '', location.pathname); };
    if (p.get('error')) { var m = p.get('error_description') || p.get('error'); lset('md.calwant', null); lset('md.reauth', null); clean(); throw new Error(m); }
    var pk = null; try { pk = JSON.parse(localStorage.getItem('md.pkce') || 'null'); } catch (e) {}
    var code = p.get('code'), state = p.get('state'); clean();
    if (!pk || pk.st !== state) throw new Error('Sign-in could not be verified. Please try again.');
    var prevAcc = (tok() || {}).account || {};
    var tj = await tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT, code_verifier: pk.v });
    if (ls('md.calwant') === '1') {
      lset('md.calwant', null);
      if (/calendars\.readwrite/i.test(tj.scope || '')) { lset('md.cal', '1'); lset('md.calnote', 'Calendar reminders are on.'); }
      else lset('md.calnote', 'Microsoft did not grant calendar access, so reminders are still off.');
    }
    markAct();
    try { localStorage.removeItem('md.pkce'); } catch (e) {}
    var meMail = '';
    try {
      var me = await (await gfetch('/me?$select=displayName,mail,userPrincipalName')).json();
      var t = tok(); t.account = { name: me.displayName || '', mail: me.mail || me.userPrincipalName || '' }; setTok(t); meMail = t.account.mail;
    } catch (e) {}
    /* Warn when this is a different Microsoft account from the one used here last time (each account has its own, separate client list). */
    try {
      var lastM = String(ls('md.lastMail') || '').toLowerCase(), nowM = String(meMail || '').toLowerCase();
      if (nowM && lastM && nowM !== lastM && ls('md.reauth') !== '1') acctBanner(meMail, ls('md.lastMail'));
      if (nowM && ls('md.reauth') !== '1') lset('md.lastMail', meMail);
    } catch (e) {}
    if (ls('md.reauth') === '1') {
      lset('md.reauth', null);
      var pm = String(prevAcc.mail || '').toLowerCase(), nm = String(meMail || '').toLowerCase();
      if (pm && nm && pm !== nm) { setTok(null); lset('md.reauthNext', null); throw new Error('That was a different Microsoft account from the one signed in here, so nothing was changed. Please sign in again.'); }
      lset('md.reauthOk', String(Date.now())); lset('md.reopen', ls('md.reauthNext')); lset('md.reauthNext', null);
    }
  }
  /* One-time move: cases kept on this device are uploaded to the app's own OneDrive folder. */
  function migrateToAppFolder() {
    var done = null; try { done = localStorage.getItem('md.loc2'); } catch (e) {}
    if (done) return;
    COLS.forEach(function (col) {
      Object.keys(mem[col]).forEach(function (id) {
        var d = mem[col][id]; d.etag = null; d.itemId = null; persistDoc(col, id);
        var k = col + '/' + id; if (!dirty[k]) { var nd = { k: k, col: col, id: id, kind: 'set', patch: {}, v: ++vctr }; dirty[k] = nd; idbPut('dirty', nd); }
      });
    });
    try { localStorage.setItem('md.loc2', '1'); } catch (e) {}
  }
  async function boot() {
    addSyncBadge();
    await openIdb(); await loadCache();
    try { await handleRedirect(); } catch (e) { showSignIn(e.message); return; }
    if (!tok()) { showSignIn(''); return; }
    if (isIdle()) { await autoSignOut(); return; }
    startIdleWatch(); startLockWatch(); setTimeout(pinWarnMaybe, 2500);
    migrateToAppFolder();
    var o = $('mdSign'); if (o) o.remove();
    readyRes({ collection: collection });
    setState();
    flush(); pull();
    subs.appointments.push(function () { calSchedule(2000); }); calSchedule(5000); bkStart();
    var ro = ls('md.reopen'); if (ro) { lset('md.reopen', null); setTimeout(function () { toast('Confirmed. You can now make your changes.'); if (ro === 'profile') openProfile(); else if (ro === 'backup') openBackup(); else if (ro === 'pin') openPin(); }, 1800); }
    var cn = ls('md.calnote'); if (cn) { lset('md.calnote', null); setTimeout(function () { toast(cn); }, 1500); }
    setInterval(function () { if (document.visibilityState === 'visible') { flush(); pull(); calSchedule(3000); } }, 60000);
    window.addEventListener('online', function () { st.offline = false; flush(); pull(); });
    window.addEventListener('offline', function () { st.offline = true; setState(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flush(); else pull(); });
    window.addEventListener('pagehide', function () { flush(); });
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') { window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); }); }
  boot();
})();
