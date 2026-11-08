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
  var COLS = ['cases', 'notebook', 'appointments'];
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

  /* ---------- tokens (Microsoft sign-in, PKCE, no library) ---------- */
  function readTok() { try { return JSON.parse(localStorage.getItem('md.tok2') || 'null'); } catch (e) { return null; } }
  function writeTok(t) { try { if (t) localStorage.setItem('md.tok2', JSON.stringify(t)); else localStorage.removeItem('md.tok2'); } catch (e) {} }
  var memTok = null;
  function tok() { return memTok || (memTok = readTok()); }
  function setTok(t) { memTok = t; writeTok(t); }
  function b64url(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function rand(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a); }
  function form(o) { return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }

  async function startLogin() {
    var v = rand(48), st = rand(16);
    var h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
    try { localStorage.setItem('md.pkce', JSON.stringify({ v: v, st: st })); } catch (e) {}
    location.href = AUTH + 'authorize?' + form({ client_id: CFG.clientId, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query', scope: scopes(), state: st, code_challenge: b64url(h), code_challenge_method: 'S256', prompt: 'select_account' });
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

  var mem = { cases: {}, notebook: {}, appointments: {} }, dirty = {}, vctr = 0, subs = { cases: [], notebook: [], appointments: [] };
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
        if (!Object.keys(mem.cases).length && !Object.keys(dirty).length) toast('No cases found in your OneDrive yet. Open Account and choose "Import backup file".');
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
      if (e && e.cal) { lset('md.cal', null); toast('Calendar reminders stopped: permission was not given. Turn them on again in Account.'); }
    } finally {
      calBusy = false;
      if (changed || calAgain) { calAgain = false; calSchedule(3000); }
    }
  }

  /* ---------- PDF / CSV case backup ---------- */
  var BK_STAGE = { enquiry: 'Enquiry', factfind: 'Fact find', dip: 'AIP', application: 'FMA', offer: 'Offered', completed: 'Completed', lost: 'Closed lost' };
  var BK_INV = { 'Spouse / partner': 'Spouse / partner', 'Parent': 'Child', 'Child': 'Parent', 'Grandparent': 'Grandchild', 'Grandchild': 'Grandparent', 'Sibling': 'Sibling', 'Other relative': 'Other relative', 'Friend': 'Friend', 'Colleague': 'Colleague', 'Business partner': 'Business partner', 'Employer': 'Employee', 'Employee': 'Employer', 'Referred by': 'Referred client', 'Referred client': 'Referred by', 'Other': 'Other' };
  var bkRunning = false, bkTimer = null;
  function bkCfg() { var c = {}; try { c = JSON.parse(ls('md.bk') || '{}'); } catch (e) {} return Object.assign({ auto: true, dev: true, od: true, last: 0, tried: 0, res: {} }, c); }
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
  var BK_COLS = ['clientNo', 'applicants', 'dates of birth', 'phones', 'emails', 'addresses', 'stage', 'type', 'repayment', 'propertyAddress', 'propertyValue', 'purchasePrice', 'loanAmount', 'termYears', 'termLeft', 'lender', 'lenderRef', 'product', 'rate', 'followOnRate', 'fixedUntil', 'reviewDate', 'erc', 'monthlyPayment', 'dipExpiry', 'offerDate', 'offerExpiry', 'completionDate', 'conveyancer', 'other security addresses', 'connected clients', 'open tasks', 'notes', 'protection notes', 'oneDriveLink'];
  function bkTasks(c, openOnly) { return (c.tasks || []).filter(function (t) { return !openOnly || !t.done; }).map(function (t) { return (t.done ? '[done] ' : '') + (t.pri ? '[high] ' : '') + (t.text || '') + (t.due ? ' (due ' + bkDate(t.due) + (t.time ? ' ' + t.time : '') + ')' : ''); }); }
  function bkLog(arr) { return (arr || []).slice().sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).map(function (n) { return bkTs(n.ts) + ': ' + String(n.text || '').replace(/\s+/g, ' ').trim(); }); }
  function bkCsv(all) {
    function q(v) { v = v == null ? '' : String(v); return '"' + v.replace(/"/g, '""') + '"'; }
    var rows = [BK_COLS.map(q).join(',')];
    all.forEach(function (c) {
      var ap = c.applicants || [];
      var r = [c.clientNo, bkNames(c), ap.map(function (a) { return a.dob ? bkDate(a.dob) : ''; }).join(' | '), ap.map(function (a) { return a.phone || ''; }).join(' | '), ap.map(function (a) { return a.email || ''; }).join(' | '), ap.map(function (a) { return a.address || ''; }).join(' | '),
        BK_STAGE[c.stage] || c.stage, c.type, c.repayment, c.propertyAddress, c.propertyValue, c.purchasePrice, c.loanAmount, c.termYears, c.termLeft, c.lender, c.lenderRef, c.product, c.rate, c.followOnRate, c.fixedUntil, c.reviewDate, c.erc, c.monthlyPayment, c.dipExpiry, c.offerDate, c.offerExpiry, c.completionDate, c.conveyancer,
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
  function pdfBuild(items, footer) {
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
    var out = '%PDF-1.4\n', offs = [], n = pages.length;
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
      obj(6 + 2 * i, '<< /Length ' + cs.length + ' >>\nstream\n' + cs + 'endstream');
    });
    var total = 5 + 2 * n, xref = out.length;
    out += 'xref\n0 ' + total + '\n0000000000 65535 f \n';
    for (var k = 1; k < total; k++) out += ('0000000000' + offs[k]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + total + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    var u = new Uint8Array(out.length); for (var m = 0; m < out.length; m++) u[m] = out.charCodeAt(m) & 255;
    return u;
  }
  function bkPdf(all, stamp) {
    var it = [];
    it.push({ t: 'Mortgage Desk - case backup', b: 1, sz: 18, gap: 6 });
    it.push({ t: 'Created ' + stamp + '. ' + all.length + ' case' + (all.length === 1 ? '' : 's') + '.', sz: 10, gap: 10 });
    it.push({ t: 'Contents', b: 1, sz: 11, gap: 2 });
    all.forEach(function (c) { it.push({ t: (c.clientNo || '-') + '   ' + bkNames(c) + '   (' + (BK_STAGE[c.stage] || c.stage || '') + (c.type ? ', ' + c.type : '') + ')', sz: 9 }); });
    all.forEach(function (c) {
      var ap = c.applicants || [];
      it.push({ pb: 1 });
      it.push({ t: (c.clientNo ? c.clientNo + '   ' : '') + bkNames(c), b: 1, sz: 14, gap: 2 });
      it.push({ t: [BK_STAGE[c.stage] || c.stage, c.type, c.repayment].filter(Boolean).join('  |  '), sz: 10, gap: 6 });
      it.push({ t: 'Applicants', b: 1, sz: 10.5, gap: 1 });
      ap.forEach(function (a, i) {
        it.push({ t: (i + 1) + '. ' + (a.name || '') + (a.dob ? '   DOB ' + bkDate(a.dob) : ''), ind: 6 });
        var ct = [a.phone, a.email].filter(Boolean).join('   '); if (ct) it.push({ t: ct, ind: 16 });
        if (a.address) it.push({ t: 'Address: ' + a.address, ind: 16 });
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
      (c.securities || []).forEach(function (s, i) { if (s.address) it.push({ t: 'Security ' + (i + 1) + ': ' + s.address + (s.lender ? '  |  ' + s.lender : '') + (s.product ? '  |  ' + s.product : '') + (s.loanAmount ? '  |  ' + bkGbp(s.loanAmount) : '') + (s.fixedUntil ? '  |  deal ends ' + bkDate(s.fixedUntil) : ''), ind: 6 }); });
      var ts = bkTasks(c, false);
      it.push({ t: 'Tasks', b: 1, sz: 10.5, gap: 1 }); if (!ts.length) it.push({ t: 'None', ind: 6 }); ts.forEach(function (t) { it.push({ t: '- ' + t, ind: 6, hang: 8 }); });
      var ns = bkLog(c.notes);
      it.push({ t: 'Notes', b: 1, sz: 10.5, gap: 1 }); if (!ns.length) it.push({ t: 'None', ind: 6 }); ns.forEach(function (t) { it.push({ t: t, ind: 6, gap: 2 }); });
      var ps = bkLog(c.protection);
      it.push({ t: 'Protection notes', b: 1, sz: 10.5, gap: 1 }); if (!ps.length) it.push({ t: 'None', ind: 6 }); ps.forEach(function (t) { it.push({ t: t, ind: 6, gap: 2 }); });
    });
    return pdfBuild(it, 'Mortgage Desk backup ' + stamp);
  }
  function bkIdb() { return new Promise(function (res) { try { var q = indexedDB.open('md-bk', 1); q.onupgradeneeded = function () { q.result.createObjectStore('h'); }; q.onsuccess = function () { res(q.result); }; q.onerror = function () { res(null); }; } catch (e) { res(null); } }); }
  var bkDirMem = null;
  async function bkGetDir() { if (bkDirMem) return bkDirMem; var d = await bkIdb(); if (!d) return null; return new Promise(function (res) { try { var r = d.transaction('h').objectStore('h').get('dir'); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; } catch (e) { res(null); } }); }
  async function bkPutDir(h) { bkDirMem = h; var d = await bkIdb(); if (!d) return; return new Promise(function (res) { try { var t = d.transaction('h', 'readwrite'); t.objectStore('h').put(h, 'dir'); t.oncomplete = function () { res(); }; t.onerror = function () { res(); }; } catch (e) { res(); } }); }
  function bkCanPick() { return typeof window.showDirectoryPicker === 'function'; }
  async function bkDevPerm(interactive) {
    var h = await bkGetDir(); if (!h) return { ok: false, msg: 'No folder chosen yet.' };
    var p = 'prompt'; try { p = await h.queryPermission({ mode: 'readwrite' }); } catch (e) {}
    if (p !== 'granted') {
      if (!interactive) return { ok: false, msg: 'Needs your permission. Open PDF/CSV Case Backup and press Back up now.' };
      try { p = await h.requestPermission({ mode: 'readwrite' }); } catch (e) { p = 'denied'; }
      if (p !== 'granted') return { ok: false, msg: 'Permission to the folder was not given.' };
    }
    return { ok: true, h: h };
  }
  async function bkToDevice(files, interactive, pre) {
    if (bkCanPick()) {
      var g = pre || await bkDevPerm(interactive); if (!g.ok) return g;
      try {
        var sub = await g.h.getDirectoryHandle('Mortgage Desk Backups', { create: true });
        for (var i = 0; i < files.length; i++) { var fh = await sub.getFileHandle(files[i].name, { create: true }); var w = await fh.createWritable(); await w.write(files[i].blob); await w.close(); }
        return { ok: true, msg: 'Saved to ' + g.h.name + ' / Mortgage Desk Backups' };
      } catch (e) { return { ok: false, msg: 'Could not write to the folder (' + (e && e.name || 'error') + ').' }; }
    }
    if (!interactive) return { ok: false, msg: 'This browser cannot save to a folder automatically.' };
    for (var j = 0; j < files.length; j++) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(files[j].blob); a.download = files[j].name; document.body.appendChild(a); a.click();
      await sleep(400); a.remove(); (function (u) { setTimeout(function () { URL.revokeObjectURL(u); }, 20000); })(a.href);
    }
    return { ok: true, msg: 'Downloaded to this device (check your Downloads).' };
  }
  async function bkToOneDrive(files) {
    if (!tok()) return { ok: false, msg: 'Not signed in.' };
    try {
      for (var i = 0; i < files.length; i++) {
        var r = await gfetch(APP + ':/' + enc('Backups/' + files[i].name) + ':/content', { method: 'PUT', headers: { 'Content-Type': files[i].type }, body: files[i].blob });
        if (!r.ok) return { ok: false, msg: 'OneDrive said ' + r.status + '.' };
      }
      return { ok: true, msg: 'Saved to OneDrive / Apps / Mortgage Desk / Backups' };
    } catch (e) { return { ok: false, msg: st.offline ? 'Offline. Will retry.' : 'Could not reach OneDrive.' }; }
  }
  async function bkRun(interactive) {
    if (bkRunning) return null;
    var cfg = bkCfg();
    if (!cfg.dev && !cfg.od) return { none: true };
    bkRunning = true;
    try {
      var pre = null;
      if (cfg.dev && bkCanPick()) pre = await bkDevPerm(interactive);
      var all = bkCases(), d = new Date(), pad = function (n) { return ('0' + n).slice(-2); };
      var day = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      var stamp = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      var files = [
        { name: 'Mortgage-Desk-Cases-' + day + '.pdf', type: 'application/pdf', blob: new Blob([bkPdf(all, stamp)], { type: 'application/pdf' }) },
        { name: 'Mortgage-Desk-Cases-' + day + '.csv', type: 'text/csv', blob: new Blob([bkCsv(all)], { type: 'text/csv;charset=utf-8' }) }
      ];
      var res = { at: Date.now(), count: all.length };
      if (cfg.dev) res.dev = await bkToDevice(files, interactive, pre);
      if (cfg.od) res.od = await bkToOneDrive(files);
      cfg.tried = Date.now();
      var okAny = (res.dev && res.dev.ok) || (res.od && res.od.ok), allOk = (!cfg.dev || (res.dev && res.dev.ok)) && (!cfg.od || (res.od && res.od.ok));
      if (allOk) cfg.last = Date.now();
      cfg.res = res; bkSave(cfg);
      return res;
    } finally { bkRunning = false; }
  }
  function bkTick() {
    var cfg = bkCfg();
    if (!cfg.auto || (!cfg.dev && !cfg.od) || !tok() || !Object.keys(mem.cases).length) return;
    var now = Date.now();
    if (now - cfg.last < 86400000) return;
    if (now - cfg.tried < 3600000) return;
    bkRun(false).then(function () { var m = $('bkMsg'); if (m) bkPaint(); }).catch(function () {});
  }
  function bkStart() { setTimeout(bkTick, 20000); clearInterval(bkTimer); bkTimer = setInterval(bkTick, 600000); document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') setTimeout(bkTick, 3000); }); }
  function bkPaint() {
    var cfg = bkCfg(), el = $('bkStatus'); if (!el) return;
    var r = cfg.res || {}, h = '';
    if (cfg.last) h += 'Last full backup: ' + new Date(cfg.last).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '.<br>';
    else h += 'No full backup yet.<br>';
    if (r.at) {
      h += 'Last attempt ' + new Date(r.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' (' + (r.count || 0) + ' cases):';
      if (r.dev) h += '<br>' + (r.dev.ok ? '✓' : '✗') + ' This computer: ' + esc(r.dev.msg);
      if (r.od) h += '<br>' + (r.od.ok ? '✓' : '✗') + ' OneDrive: ' + esc(r.od.msg);
    }
    el.innerHTML = h;
  }
  async function openBackup() {
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:250;background:rgba(8,14,18,.55);display:flex;align-items:center;justify-content:center;padding:16px';
    document.body.appendChild(ov);
    var dirName = ''; if (bkCanPick()) { var dh = await bkGetDir(); dirName = dh ? dh.name : ''; }
    function draw() {
      var c = bkCfg(), pick = bkCanPick();
      ov.innerHTML = '<div style="background:#fff;color:#101C26;width:min(560px,100%);max-height:92vh;overflow:auto;border-radius:12px;padding:22px 24px;font:14px system-ui,sans-serif;box-shadow:0 8px 30px rgba(16,28,38,.3)">' +
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">PDF/CSV Case Backup</h2><button class="btn ghost" data-b="close">Close</button></div>' +
        '<p style="margin:12px 0;color:#58697A">Saves every case as a PDF (to read or print) and a CSV (opens in Excel). Both places get the same two files.</p>' +
        '<h3 style="margin:14px 0 6px;font-size:15px">Where to save</h3>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0"><input type="checkbox" id="bkDev"' + (c.dev ? ' checked' : '') + ' style="margin-top:3px"><span><b>This computer</b><br><span style="color:#58697A;font-size:13px">' + (pick ? (dirName ? 'Folder: <b>' + esc(dirName) + ' / Mortgage Desk Backups</b>' : 'No folder chosen yet.') + '</span><br><button class="btn ghost sm" data-b="pick" style="margin-top:6px">' + (dirName ? 'Change folder' : 'Choose folder') + '</button>' : 'This browser cannot pick a folder (phones and some browsers). Back up now will download the two files to this device instead.</span>') + '</span></label>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin:10px 0"><input type="checkbox" id="bkOd"' + (c.od ? ' checked' : '') + ' style="margin-top:3px"><span><b>OneDrive</b><br><span style="color:#58697A;font-size:13px">Folder: <b>Apps / Mortgage Desk / Backups</b> (the app can only use its own OneDrive folder).</span></span></label>' +
        '<h3 style="margin:16px 0 6px;font-size:15px">Automatic backup</h3>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin:6px 0"><input type="checkbox" id="bkAuto"' + (c.auto ? ' checked' : '') + ' style="margin-top:3px"><span>Back up automatically every 24 hours<br><span style="color:#58697A;font-size:13px">Runs while the app is open (on any signed-in device). If the app was closed, it runs the next time you open it.</span></span></label>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 8px"><button class="btn" data-b="run">Back up now</button></div>' +
        '<p id="bkStatus" style="margin:8px 0;font-size:13px;color:#2b3b47"></p><p id="bkMsg" style="min-height:18px;margin:6px 0 0"></p></div>';
      bkPaint();
    }
    draw();
    var say = function (m) { var e = $('bkMsg'); if (e) e.textContent = m; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('change', function (e) {
      var t = e.target; if (!t || !t.id) return; var c = bkCfg();
      if (t.id === 'bkDev') c.dev = t.checked; else if (t.id === 'bkOd') c.od = t.checked; else if (t.id === 'bkAuto') c.auto = t.checked; else return;
      bkSave(c); say('Saved.');
    });
    ov.addEventListener('click', async function (e) {
      var b = e.target.closest && e.target.closest('[data-b]'); if (!b) return; b = b.getAttribute('data-b');
      if (b === 'close') ov.remove();
      else if (b === 'pick') {
        try { var h = await window.showDirectoryPicker({ mode: 'readwrite' }); await bkPutDir(h); dirName = h.name; var c = bkCfg(); c.dev = true; bkSave(c); draw(); say('Folder chosen.'); }
        catch (x) { if (!x || x.name !== 'AbortError') say('Could not choose that folder.'); }
      } else if (b === 'run') {
        var c2 = bkCfg(); c2.dev = !!($('bkDev') || {}).checked; c2.od = !!($('bkOd') || {}).checked; c2.auto = !!($('bkAuto') || {}).checked; bkSave(c2);
        if (!c2.dev && !c2.od) { say('Tick at least one place to save to.'); return; }
        if (c2.dev && bkCanPick() && !(await bkGetDir())) { say('Choose a folder on this computer first.'); return; }
        say('Backing up…');
        var r = await bkRun(true);
        bkPaint();
        if (r && r.none) say('Tick at least one place to save to.');
        else if (r) say(((!r.dev || r.dev.ok) && (!r.od || r.od.ok)) ? 'Backup finished.' : 'Backup finished with a problem. See below.');
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
        '<div style="display:flex;justify-content:space-between;align-items:center"><h2 style="margin:0;font-size:20px">Account</h2><button class="btn ghost" data-a="close">Close</button></div>' +
        '<p style="margin:14px 0 4px"><b>Signed in as</b><br>' + esc(acc.name || '') + ' ' + esc(acc.mail || '') + '</p>' +
        '<p style="margin:6px 0 0;color:#1b5e20;font-size:13px">' + esc((($('syncState') || {}).textContent || '').trim()) + '</p>' +
        '<p style="margin:10px 0 0;color:#58697A;font-size:12px">App version: ' + esc(window.MD_BUILD || 'unknown') + '</p><p style="margin:10px 0;color:#58697A">Cases are saved in your OneDrive, in the folder <b>' + esc(ROOT) + '</b>. ' + esc(pending() ? pending() + ' change(s) are waiting to upload.' : 'Everything is uploaded.') + '</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0"><button class="btn" data-a="sync">Sync now</button><button class="btn ghost" data-a="backup" title="Save every case, with notes, tasks and protection, to a file on your computer">Backup</button><button class="btn ghost" data-a="folder">Open folder in OneDrive</button></div><div style="margin:4px 0 10px"><button class="btn" data-a="pdfbk" style="background:#2f4a40;border-color:#2f4a40;color:#fff">PDF/CSV Case Backup</button></div>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Calendar reminders</h3>' + (calOn()
          ? '<p style="margin:0 0 8px;color:#1b5e20">On. Booked appointments are added to your Outlook calendar with a ' + CAL_MIN + '-minute reminder.</p><button class="btn ghost" data-a="caloff">Turn off</button>'
          : '<p style="margin:0 0 8px;color:#58697A">Adds each booked appointment to your Outlook calendar with a ' + CAL_MIN + '-minute reminder, so your phone alerts you even when this app is closed. You will be asked to approve calendar access once.</p><button class="btn" data-a="calon">Turn on</button>') +
        '<p style="margin:8px 0 0;color:#58697A;font-size:12px">Only the name, time, type, method and place go to the calendar, never your notes. On your phone, use the Outlook app or add this Microsoft account to your phone calendar, and allow notifications.</p>' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Import a backup file</h3><p style="margin:0 0 8px;color:#58697A">Loads cases from a Mortgage Desk backup (.json). Cases that already exist are not overwritten.</p>' +
        '<input type="file" id="mdImp" accept=".json,application/json" style="max-width:100%">' +
        '<h3 style="margin:18px 0 6px;font-size:15px">Log out</h3><p style="margin:0 0 8px;color:#58697A">Removes the cases from this device. They stay safe in OneDrive.</p><button class="btn" data-a="out">Log out</button>' +
        '<p style="margin-top:14px;min-height:18px" id="mdAccMsg">' + esc(msg || '') + '</p></div>';
    }
    render('');
    var say = function (m) { var e = $('mdAccMsg'); if (e) e.textContent = m; };
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) ov.remove(); });
    ov.addEventListener('change', async function (e) {
      if (e.target.id !== 'mdImp' || !e.target.files[0]) return;
      try {
        var p = JSON.parse(await e.target.files[0].text()), n = 0, skipped = 0;
        COLS.forEach(function (col) {
          (p[col] || []).forEach(function (row) {
            var id = safeId(row.id || genId()); if (mem[col][id]) { skipped++; return; }
            var d = clone(row); delete d.id; localWrite(col, id, d, 'set'); n++;
          });
        });
        say('Imported ' + n + ' item(s)' + (skipped ? ', skipped ' + skipped + ' that already exist' : '') + '. Uploading to OneDrive…');
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
    try { localStorage.removeItem('md.pkce'); } catch (e) {}
    if (auto) { try { localStorage.setItem('md.idleMsg', '1'); } catch (e) {} }
    location.replace(location.pathname + '?fresh=' + Date.now());
  }
  /* ---------- automatic log out after a period with no activity (default 2 hours) ---------- */
  var IDLE_MS = Math.max(0.05, +(CFG.idleMinutes || 120)) * 60000, idleBusy = false, lastW = 0;
  function idleLabel() { var m = IDLE_MS / 60000; return m >= 60 ? (m / 60 === 1 ? '1 hour' : (m / 60) + ' hours') : m + ' minutes'; }
  function markAct() { try { localStorage.setItem('md.act', String(Date.now())); } catch (e) {} }
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
    if (!p.get('code') && !p.get('error')) { lset('md.calwant', null); return; }
    var clean = function () { history.replaceState(null, '', location.pathname); };
    if (p.get('error')) { var m = p.get('error_description') || p.get('error'); lset('md.calwant', null); clean(); throw new Error(m); }
    var pk = null; try { pk = JSON.parse(localStorage.getItem('md.pkce') || 'null'); } catch (e) {}
    var code = p.get('code'), state = p.get('state'); clean();
    if (!pk || pk.st !== state) throw new Error('Sign-in could not be verified. Please try again.');
    var tj = await tokenRequest({ grant_type: 'authorization_code', code: code, redirect_uri: REDIRECT, code_verifier: pk.v });
    if (ls('md.calwant') === '1') {
      lset('md.calwant', null);
      if (/calendars\.readwrite/i.test(tj.scope || '')) { lset('md.cal', '1'); lset('md.calnote', 'Calendar reminders are on.'); }
      else lset('md.calnote', 'Microsoft did not grant calendar access, so reminders are still off.');
    }
    markAct();
    try { localStorage.removeItem('md.pkce'); } catch (e) {}
    try {
      var me = await (await gfetch('/me?$select=displayName,mail,userPrincipalName')).json();
      var t = tok(); t.account = { name: me.displayName || '', mail: me.mail || me.userPrincipalName || '' }; setTok(t);
    } catch (e) {}
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
    startIdleWatch();
    migrateToAppFolder();
    var o = $('mdSign'); if (o) o.remove();
    readyRes({ collection: collection });
    setState();
    flush(); pull();
    subs.appointments.push(function () { calSchedule(2000); }); calSchedule(5000); bkStart();
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
