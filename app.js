(function(){
'use strict';
var STAGES=[
  {id:'enquiry',label:'Enquiry'},{id:'factfind',label:'Fact find'},{id:'dip',label:'AIP'},
  {id:'application',label:'FMA'},{id:'offer',label:'Offered'},{id:'completed',label:'Completed'}];
var STAGE_LABEL={lost:'Closed lost'}; STAGES.forEach(function(s){STAGE_LABEL[s.id]=s.label});
var TYPES=['Purchase','First-time buyer','Remortgage','Product transfer','Further advance','Buy to let','Other'];

var db=null, col=null, cases=[], loaded=false, view='tasks', query='', stageFilter='', lenderFilter='', revFilter='', sortBy=(function(){try{return localStorage.getItem('sortBy')||'task'}catch(e){return 'task'}})(), openId=undefined;
var queues={};

/* ---------- helpers ---------- */
function $(s,r){return (r||document).querySelector(s)}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){if(v===''||v==null)return null;var n=parseFloat(String(v).replace(/[£,\s]/g,''));return isNaN(n)?null:n}
function money(n){if(n==null||n==='')return '—';n=+n;return '£'+n.toLocaleString('en-GB',{minimumFractionDigits:Number.isInteger(n)?0:2,maximumFractionDigits:2})}
function pd(iso){if(!iso)return null;var p=iso.split('-').map(Number);return new Date(p[0],p[1]-1,p[2])}
var TODAY=(function(){var d=new Date();return new Date(d.getFullYear(),d.getMonth(),d.getDate())})();
function diff(iso){return Math.round((pd(iso)-TODAY)/864e5)}
function iso(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function addMonths(s,n){var d=pd(s),day=d.getDate();d.setDate(1);d.setMonth(d.getMonth()+n);var last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();d.setDate(Math.min(day,last));return iso(d)}
var REVM=4;
function addDays(s,n){var d=pd(s);d.setDate(d.getDate()+n);return iso(d)}
function fd(s){return s?pd(s).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—'}
function rel(s){var n=diff(s);if(n===0)return 'today';if(n===1)return 'tomorrow';if(n===-1)return 'yesterday';return n>0?'in '+n+' days':Math.abs(n)+' days ago'}
function uid(){return Math.random().toString(36).slice(2,9)}
var protHidden=false,protAll=false,prDraft='';

function protFs(c){
  var ps=(c.protection||[]).slice().sort(function(a,b){return b.ts-a.ts});
  return '<fieldset style="margin-top:14px"><legend>Protection notes ('+ps.length+')</legend><div class="add" style="margin:0 0 8px"><button type="button" class="btn ghost sm" id="prHide">'+(protHidden?'Show protection':'Hide protection')+'</button></div>'+
  (protHidden?'<span class="muted">Protection notes hidden.</span>':'<label class="f">New protection note<textarea id="prText" rows="3" placeholder="Life cover, critical illness, income protection, buildings and contents: provider, cover, premium, review date">'+esc(prDraft)+'</textarea></label><div id="prTblBox">'+pendHtml('pr')+'</div><div class="add"><button type="button" class="btn ghost" id="prStamp">Insert date and time</button><button type="button" class="btn ghost" id="prAdd">Add note</button></div>'+
  (protAll?ps:ps.slice(0,1)).map(function(n){return noteItem(n,'protection',(protAll||ps.length<2?'':' (latest)'),esc)}).join('')+
  (ps.length>1?'<button type="button" class="btn ghost sm" id="prAll">'+(protAll?'Show latest only':'Show all '+ps.length+' protection notes')+'</button>':''))+'</fieldset>';
}
function latestNoteCell(c,key){var n=(c[key||'notes']||[]).slice().sort(function(a,b){return b.ts-a.ts})[0];if(!n)return '<span class="muted">—</span>';var t=String(n.text||'');if(!t&&n.table)t='[Table]';if(t.length>140)t=t.slice(0,140)+'…';t=t.replace(/\s+/g,' ');return '<div class="nl1" title="'+esc(stampOf(n.ts)+' '+t)+'"><span class="muted" style="font-family:var(--mono);font-size:11px">'+stampOf(n.ts)+'</span> '+esc(t)+'</div>'}
function cno(c){return c.clientNo?' <span class="cno">'+esc(c.clientNo)+'</span>':''}
function nextClientNo(){var m=0;cases.forEach(function(c){var r=/^C(\d+)$/i.exec(c.clientNo||'');if(r)m=Math.max(m,+r[1])});return 'C'+String(m+1).padStart(3,'0')}
function names(c){var a=(c.applicants||[]).map(function(x){return x.name}).filter(Boolean);return a.length?a.join(' & '):'Unnamed client'}
var PROP_TYPES=[['','Not set'],['main','Main residence'],['btl','Buy to let'],['second','Second home'],['holiday','Holiday home']];
function propLabel(v){var o=PROP_TYPES.filter(function(q){return q[0]===v})[0];return o&&o[0]?o[1]:''}
function propTag(c){var l=propLabel(c.propUse);return l?' <span class="ptag '+esc(c.propUse)+'">'+esc(l)+'</span>':''}
/* Same client = same applicant names and dates of birth (any order). A joint case with a different second person is a different client. */
function clientKey(c){var a=(c.applicants||[]).map(function(x){return (x.name||'').trim().toLowerCase().replace(/\s+/g,' ')+'|'+(x.dob||'')}).filter(function(s){return s!=='|'});return a.length?a.sort().join('||'):'#'+c.id}
function sameClient(c){var k=clientKey(c);return cases.filter(function(x){return clientKey(x)===k}).sort(function(a,b){return (a.createdAt||0)-(b.createdAt||0)})}
function ownReview(c){return c.reviewDate||(c.fixedUntil?addMonths(c.fixedUntil,-REVM):'')}
function secReview(x){return x.reviewDate||(x.fixedUntil?addMonths(x.fixedUntil,-REVM):'')}
function reviewItems(c){var d=ownReview(c);return d?[{date:d,addr:'',lender:'',fixedUntil:c.fixedUntil||'',sec:false}]:[]}
function reviewOf(c){var r=reviewItems(c).map(function(x){return x.date}).sort();return r[0]||''}
function rateEndOf(c){return c.fixedUntil||''}
function firstName(c){var a=(c.applicants||[]).map(function(x){return (x.name||'').trim()}).filter(Boolean)[0]||'';return a.replace(/^(mr|mrs|miss|ms|dr)\.?\s+/i,'').toLowerCase()}
function cnum(c){var m=/(\d+)/.exec(c.clientNo||'');return m?+m[1]:1e9}
function odLink(u){u=String(u||'').trim();return /^https?:\/\//i.test(u)?'<a href="'+esc(u)+'" target="_blank" rel="noopener">Open OneDrive folder</a>':''}
/* ---------- pasted tables: Excel colours kept, cells editable ---------- */
var ntTable=null,prTable=null,tblTimer=null;
function safeColor(v){v=String(v||'').trim();return /^#[0-9a-fA-F]{6}$/.test(v)?v:''}
function rgbHex(s){var m=/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s\/]+([\d.]+))?/.exec(s||'');if(!m)return '';if(m[4]!=null&&+m[4]===0)return '';return '#'+[m[1],m[2],m[3]].map(function(x){return ('0'+Math.min(255,+x).toString(16)).slice(-2)}).join('')}
function lum(h){return (0.299*parseInt(h.substr(1,2),16)+0.587*parseInt(h.substr(3,2),16)+0.114*parseInt(h.substr(5,2),16))/255}
function cellStyle(c){
  var s=[],bg=safeColor(c.bg),col=safeColor(c.c),bd=safeColor(c.bd);
  if(bg){s.push('background:'+bg);s.push('color:'+(col||'#101C26'))}else if(col&&lum(col)>0.25&&lum(col)<0.9){s.push('color:'+col)}
  if(c.b)s.push('font-weight:700');if(c.i)s.push('font-style:italic');
  if(c.a==='center'||c.a==='right')s.push('text-align:'+c.a);
  if(bd)s.push('border:1px solid '+bd);
  return s.join(';');
}
function cellHtml(c,edit){c=c||{};var st=cellStyle(c);return '<td'+(edit?' contenteditable="true"':'')+(st?' style="'+st+'"':'')+'>'+esc(c.v)+'</td>'}
function tblInner(rows,edit){var w=0;rows.forEach(function(r){if(r.length>w)w=r.length});return rows.map(function(r){var h='';for(var i=0;i<w;i++)h+=cellHtml(r[i],edit);return '<tr>'+h+'</tr>'}).join('')}
function tblBlock(n,list){
  var tb=n&&n.table;if(!tb||!tb.rows||!tb.rows.length)return '';
  return '<div class="tblwrap" data-list="'+list+'" data-ts="'+esc(n.ts)+'"><table class="nt xl"><tbody>'+tblInner(tb.rows,true)+'</tbody></table><div class="tblbar"><button type="button" class="btn ghost sm" data-tb="addrow">Add row</button><button type="button" class="btn ghost sm" data-tb="addcol">Add column</button><button type="button" class="btn ghost sm" data-tb="delrow">Remove last row</button><button type="button" class="btn ghost sm" data-tb="delcol">Remove last column</button>'+(list==='nbtables'?'<button type="button" class="btn danger sm" data-tb="nbdel">Remove table</button>':'')+'</div></div>';
}
function pendHtml(k){
  var tb=k==='nt'?ntTable:prTable;if(!tb)return '';
  return '<div class="tblpend"><div class="muted" style="margin:6px 0">Table ready: '+tb.rows.length+' rows × '+(tb.rows[0]?tb.rows[0].length:0)+' columns. Click Add note to save it. <button type="button" class="btn ghost sm" data-tb="drop'+k+'">Remove table</button></div><div class="tblwrap"><table class="nt xl"><tbody>'+tblInner(tb.rows,false)+'</tbody></table></div></div>';
}
function showPend(k){var b=$('#'+k+'TblBox');if(b)b.innerHTML=pendHtml(k)}
function parseTable(html,cb){
  var doc=new DOMParser().parseFromString(html,'text/html'),tb=doc.querySelector('table');
  if(!tb){cb(null);return}
  doc.querySelectorAll('script,link,img,iframe,object,embed,meta,base,form,svg,video,audio').forEach(function(x){x.remove()});
  var styles='';doc.querySelectorAll('style').forEach(function(s){styles+=s.outerHTML});
  var fr=document.createElement('iframe'),done=false;
  fr.setAttribute('sandbox','allow-same-origin');
  fr.style.cssText='position:fixed;left:-9999px;top:0;width:1200px;height:800px;visibility:hidden;border:0';
  function finish(r){if(done)return;done=true;try{fr.remove()}catch(e){}cb(r)}
  fr.onload=function(){
    try{
      var d=fr.contentDocument,w=fr.contentWindow,rows=[],width=0,cells=0,cut=false;
      d.querySelectorAll('table tr').forEach(function(tr){
        if(rows.length>=200||cells>1500){cut=true;return}
        var r=[];
        Array.prototype.slice.call(tr.children).forEach(function(td){
          if(!/^t[dh]$/i.test(td.tagName)||r.length>=30)return;
          var cs=w.getComputedStyle(td),c={v:(td.textContent||'').replace(/\s+/g,' ').trim()};
          var bg=rgbHex(cs.backgroundColor);if(bg)c.bg=bg;
          var fc=rgbHex(cs.color);if(fc&&lum(fc)>0.12)c.c=fc;
          var fw=cs.fontWeight;if(fw==='bold'||+fw>=600)c.b=1;
          if(cs.fontStyle==='italic')c.i=1;
          if(cs.textAlign==='center'||cs.textAlign==='right')c.a=cs.textAlign;
          var bc='';['Top','Right','Bottom','Left'].forEach(function(sd){if(!bc&&cs['border'+sd+'Style']!=='none'&&parseFloat(cs['border'+sd+'Width'])>0)bc=rgbHex(cs['border'+sd+'Color'])||'#888888'});
          if(bc)c.bd=bc;
          r.push(c);cells++;
          var span=Math.min(+td.getAttribute('colspan')||1,10);
          for(var k=1;k<span&&r.length<30;k++){var e={v:''};if(c.bg)e.bg=c.bg;if(c.bd)e.bd=c.bd;r.push(e)}
        });
        if(r.length){rows.push(r);if(r.length>width)width=r.length}
      });
      rows.forEach(function(r){while(r.length<width)r.push({v:''})});
      finish(rows.length?{rows:rows,cut:cut}:null);
    }catch(e){finish(null)}
  };
  setTimeout(function(){finish(null)},4000);
  fr.srcdoc='<!doctype html><html><head><meta charset="utf-8">'+styles+'</head><body>'+tb.outerHTML+'</body></html>';
  document.body.appendChild(fr);
}
function readRows(w){
  var ts=+w.getAttribute('data-ts'),list=w.getAttribute('data-list'),c=list==='nbtables'?notes.filter(function(x){return x.id===nbShown})[0]:currentCase();if(!c)return null;
  var arr=(list==='nbtables'?c.tables:c[list])||[],idx=-1;arr.forEach(function(n,i){if(n.ts===ts)idx=i});
  if(idx<0||!arr[idx].table)return null;
  var old=arr[idx].table.rows,rows=[];
  w.querySelectorAll('tr').forEach(function(tr,ri){var r=[];tr.querySelectorAll('td').forEach(function(td,ci){var o=Object.assign({},(old[ri]||[])[ci]||{});o.v=td.textContent.replace(/ /g,' ');r.push(o)});rows.push(r)});
  return {list:list,idx:idx,arr:arr,rows:rows};
}
function commitTbl(info,rows){
  var arr=info.arr.map(function(n,i){if(i!==info.idx)return n;var m=Object.assign({},n);m.table={rows:rows};return m});
  if(info.list==='nbtables'){nbSetTables(arr);return}
  var o={};o[info.list]=arr;patch(openId,o);
}
function saveTbl(w){var info=readRows(w);if(!info)return;if(JSON.stringify(info.rows)===JSON.stringify(info.arr[info.idx].table.rows))return;commitTbl(info,info.rows)}
function cellTxt(c){c=String(c);if(c.length>1&&c.charAt(0)==='"'&&c.charAt(c.length-1)==='"')c=c.slice(1,-1).replace(/""/g,'"');return c.trim()}
function tableHtml(rows){
  var w=0;rows.forEach(function(r){if(r.length>w)w=r.length});
  function tr(r,tag){var h='';for(var i=0;i<w;i++)h+='<'+tag+'>'+esc(r[i]==null?'':r[i])+'</'+tag+'>';return '<tr>'+h+'</tr>'}
  return '<div class="tblwrap"><table class="nt"><thead>'+tr(rows[0],'th')+'</thead><tbody>'+rows.slice(1).map(function(r){return tr(r,'td')}).join('')+'</tbody></table></div>';
}
function paras(t){
  var lines=String(t||'').replace(/\r\n?/g,'\n').split('\n'),out=[],tbl=[],k=0;
  function flush(){if(!tbl.length)return;out.push('<div class="np np'+(k++%6)+'">'+(tbl.length>1?tableHtml(tbl):esc(tbl[0].join('  ')))+'</div>');tbl=[]}
  lines.forEach(function(l){
    if(l.indexOf('\t')>=0){var cells=l.split('\t').map(cellTxt);while(cells.length&&cells[cells.length-1]==='')cells.pop();if(cells.length>1||cells.length===1&&cells[0]){tbl.push(cells);return}}
    flush();
    if(l.trim())out.push('<div class="np np'+(k++%6)+'">'+esc(l)+'</div>');
  });
  flush();
  return out.join('');
}
function nextTask(c){var d=(c.tasks||[]).filter(function(t){return !t.done&&t.due}).map(function(t){return t.due}).sort();return d[0]||''}
function taskCell(c){var d=nextTask(c);return '<td>'+(d?'<span class="chip '+tone(d)+'">'+fd(d)+'</span>':'<span class="muted">—</span>')+'</td>'}
function sortList(l){
  return l.slice().sort(function(a,b){
    if(sortBy==='first'){var x=firstName(a),y=firstName(b);if(!x&&y)return 1;if(x&&!y)return -1;return x.localeCompare(y)||cnum(a)-cnum(b)}
    if(sortBy==='review'){var ra=reviewOf(a),rb=reviewOf(b);if(!ra&&rb)return 1;if(ra&&!rb)return -1;return ra<rb?-1:ra>rb?1:(firstName(a).localeCompare(firstName(b)))}
    if(sortBy==='task'){var ka=nextTask(a),kb=nextTask(b);if(!ka&&kb)return 1;if(ka&&!kb)return -1;return ka<kb?-1:ka>kb?1:cnum(a)-cnum(b)}
    if(sortBy==='clientno')return cnum(a)-cnum(b);
    return (b.updatedAt||0)-(a.updatedAt||0)});
}
function short(addr){return (addr||'').split('\n')[0]||''}
function ltv(c){return c.loanAmount&&(c.propertyValue||c.purchasePrice)?c.loanAmount/(c.purchasePrice||c.propertyValue)*100:null}
function toast(m,sticky){var t=$('#toast');t.textContent=m;t.hidden=false;clearTimeout(toast.h);if(!sticky)toast.h=setTimeout(function(){t.hidden=true},3200)}
function stageIdx(id){return STAGES.findIndex(function(s){return s.id===id})}

/* ---------- writes (one at a time per document) ---------- */
function write(id,fn){
  var p=(queues[id]||Promise.resolve()).then(fn).catch(function(e){toast('Not saved: '+((e&&e.message)||'try again'))});
  queues[id]=p;return p;
}
function patch(id,data){
  if(!col)return Promise.resolve();
  data.updatedAt=Date.now();
  return write(id,function(){return col.doc(id).update(data)});
}

/* ---------- events / reminders ---------- */
function caseEvents(c){
  var ev=[],st=c.stage,n=names(c);
  function add(date,label,kind){if(date)ev.push({date:date,label:label,kind:kind,id:c.id,who:n})}
  if(st==='completed')reviewItems(c).forEach(function(r){
    ev.push({date:r.date,label:(r.sec?'Start rate review for '+r.addr+(r.lender?' ('+r.lender+')':''):'Start rate review')+(r.fixedUntil?'. Product ends '+fd(r.fixedUntil):''),kind:'review',id:c.id,who:n,sec:r.sec});
  });
  (c.tasks||[]).forEach(function(t){if(!t.done&&t.due)ev.push({date:t.due,label:t.text,kind:'task',id:c.id,who:n})});
  return ev;
}
function allEvents(){
  var out=[];cases.forEach(function(c){if(c.stage!=='lost')out=out.concat(caseEvents(c))});
  return out.sort(function(a,b){return a.date<b.date?-1:a.date>b.date?1:0});
}
function reviewEvents(){return allEvents().filter(function(e){return e.kind==='review'})}
function nextEvent(c){
  var e=caseEvents(c).sort(function(a,b){return a.date<b.date?-1:1});
  var over=e.filter(function(x){return diff(x.date)<0})[0];
  return over||e.filter(function(x){return diff(x.date)>=0})[0]||null;
}
function tone(date){var n=diff(date);return n<0?'bad':n<=7?'warn':''}
function dueCount(){return reviewEvents().filter(function(e){return diff(e.date)<0}).length}

/* ---------- filtering ---------- */
function visible(){
  var q=query.trim().toLowerCase();
  return cases.filter(function(c){
    if(stageFilter&&c.stage!==stageFilter)return false;
    if(lenderFilter&&(c.lender||'')!==lenderFilter)return false;
    if(revFilter){var rv=reviewOf(c);if(revFilter==='none'?!!rv:rv.slice(0,7)!==revFilter)return false}
    if(!q)return true;
    var hay=[names(c),c.propertyAddress,c.clientNo,c.lenderRef,c.lender,c.product,c.conveyancer].join(' ').toLowerCase();
    return hay.indexOf(q)>-1;
  });
}

/* ---------- render shell ---------- */
function renderNav(){updTrayBtn();
  var items=[['cases','All cases'],['pipeline','Pipeline'],['tasks','Tasks'],['reminders','Reminders'],['calculator','Mortgage Calculator'],['appointments','Calendar'],['notebook','Notebook'],['birthdays','Birthdays'],['marketing','Marketing']];
  var dc=dueCount(),tdc=allTasks().filter(function(x){return trBucket(x)==='over'}).length;
  var tools={calculator:1,appointments:1,notebook:1,birthdays:1,marketing:1};
  var mk=function(list){return list.map(function(i){
    return '<button data-v="'+i[0]+'"'+(view===i[0]?' aria-current="page"':'')+'>'+i[1]+(i[0]==='reminders'&&dc?'<span class="badge">'+dc+' overdue</span>':'')+(i[0]==='tasks'&&tdc?'<span class="badge">'+tdc+' overdue</span>':'')+(i[0]==='birthdays'&&bdCounts(bdPeople().list).today?'<span class="badge" style="background:#fde4ee;color:#c2185b">'+bdCounts(bdPeople().list).today+' today</span>':'')+(i[0]==='appointments'&&apTodayN()?'<span class="badge" style="background:var(--accent-soft,#dbe9f8);color:var(--accent)">'+apTodayN()+' today</span>':'')+'</button>';
  }).join('')};
  var hideRem=sideVisible();$('#nav').innerHTML=mk(items.filter(function(i){return !tools[i[0]]&&!(hideRem&&i[0]==='reminders')}));var n2=$('#nav2');if(n2)n2.innerHTML=mk(items.filter(function(i){return tools[i[0]]}));
}

function gbp2(n){return '£'+n.toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})}
function calcPay(P,rate,n){var r=rate/1200;return r===0?P/n:P*r/(1-Math.pow(1+r,-n))}
function calcShell(){
  var list=cases.slice().sort(function(a,b){return names(a).toLowerCase()<names(b).toLowerCase()?-1:1});
  return '<div class="pagehead"><h1>Mortgage calculator</h1><span class="muted">Monthly payment, repayment and interest only</span></div><div id="calcMain" class="calc">'+
   '<div class="calcin"><label class="f">Fill from a case (optional)<select id="calcCase"><option value="">Choose a case, or type the figures below</option>'+list.map(function(x){return '<option value="'+esc(x.id)+'">'+esc(names(x)+(x.clientNo?' ('+x.clientNo+')':''))+'</option>'}).join('')+'</select></label>'+
   '<div class="grid" style="margin-top:10px"><label class="f">Mortgage amount<span class="ig"><i>£</i><input id="calcAmt" type="number" step="any" inputmode="decimal" placeholder="e.g. 250000"></span></label>'+
   '<label class="f">Term (years)<input id="calcYrs" type="number" step="1" inputmode="numeric" placeholder="e.g. 25"></label>'+
   '<label class="f">Extra months (optional)<input id="calcMon" type="number" step="1" min="0" max="11" inputmode="numeric" placeholder="0"></label>'+
   '<label class="f">Interest rate (% a year)<input id="calcRate" type="number" step="any" inputmode="decimal" placeholder="e.g. 4.5"></label></div></div>'+
   '<div id="calcOut"></div></div>';
}
function calcUpdate(){
  var out=$('#calcOut');if(!out)return;
  var P=parseFloat($('#calcAmt').value),y=parseFloat($('#calcYrs').value)||0,m=parseFloat($('#calcMon').value)||0,R=parseFloat($('#calcRate').value),n=Math.round(y*12+m);
  if(!(P>0)||!(n>0)||isNaN(R)||R<0){out.innerHTML='<p class="muted" style="margin:14px 0">Enter the mortgage amount, term and interest rate to see the monthly payments.</p>';return}
  var rp=calcPay(P,R,n),io=P*R/1200,tr=rp*n,ti=io*n,t=Math.floor(n/12)+' years'+(n%12?' '+(n%12)+' months':'');
  var rises=[1,2,3].map(function(d){var p2=calcPay(P,R+d,n);return '<tr><td>Rate '+(R+d).toFixed(2).replace(/\.?0+$/,'')+'% (+'+d+'%)</td><td>'+gbp2(p2)+'</td><td>'+gbp2(p2-rp)+' more</td><td>'+gbp2((R+d)*P/1200)+'</td></tr>'}).join('');
  out.innerHTML='<div class="calcres"><div class="calcbox"><div class="ct">Repayment</div><div class="cbig">'+gbp2(rp)+'<span> a month</span></div>'+
    '<div class="crow"><span>Total interest over '+t+'</span><b>'+gbp2(tr-P)+'</b></div><div class="crow"><span>Total repaid</span><b>'+gbp2(tr)+'</b></div><div class="crow"><span>Mortgage left at the end</span><b>£0.00</b></div></div>'+
    '<div class="calcbox io"><div class="ct">Interest only</div><div class="cbig">'+gbp2(io)+'<span> a month</span></div>'+
    '<div class="crow"><span>Total interest over '+t+'</span><b>'+gbp2(ti)+'</b></div><div class="crow"><span>Total paid by you</span><b>'+gbp2(ti)+'</b></div><div class="crow"><span>Mortgage left at the end</span><b>'+gbp2(P)+'</b></div></div></div>'+
    '<div class="calcdiff">Interest only is <b>'+gbp2(rp-io)+'</b> a month cheaper, but the full <b>'+gbp2(P)+'</b> is still owed at the end of the term.</div>'+
    '<div class="calcrise"><b>If the rate rises</b><table><thead><tr><th></th><th>Repayment</th><th>Change</th><th>Interest only</th></tr></thead><tbody>'+rises+'</tbody></table></div>'+
    '<p class="muted" style="font-size:12px">Monthly payments are worked out with the rate compounded monthly. Figures are an illustration, not a quote. A lender may calculate slightly differently.</p>';
}
function render(){
  renderNav();applySide();
  var v=$('#view');
  if(!db){v.innerHTML='<div class="banner">Saving is not available in this view, so cases cannot be stored. Open the page from your artifact link while signed in.</div>';return}
  if(!loaded){v.innerHTML='<div class="empty">Loading your cases…</div>';return}
  if(view==='tasks'){if(!$('#trList')||!v.contains($('#trList'))){v.innerHTML='<div class="homesplit"><section class="hp" id="homeCal" aria-label="Appointments calendar"></section><section class="hp htk" aria-label="Tasks"><div class="pagehead"><h1>Tasks</h1><span class="muted">Due today first, then overdue, then soonest</span></div><div class="tpage">'+taskShell()+'</div></section><aside class="hp hrem" id="homeRem" aria-label="Reminders"></aside></div>'}var hc=$('#homeCal');if(hc&&!$('#apOv'))hc.innerHTML=apHome();renderTray();renderRem()}
  else if(view==='notebook'){if(!$('#nbMain')||!v.contains($('#nbMain'))){v.innerHTML=nbShell();nbShown=null}renderNotebook()}
  else if(view==='calculator'){if(!$('#calcMain')||!v.contains($('#calcMain'))){v.innerHTML=calcShell();calcUpdate()}}
  else if(view==='marketing'){var mr=$('#mkRoot');if(!mr||!v.contains(mr)||mr.getAttribute('data-tab')!==mkTab)v.innerHTML=mkShell();mkList()}
  else if(view==='birthdays'){if(!$('#bdList')||!v.contains($('#bdList'))){v.innerHTML=bdShell();bdTplRender()}bdRender()}
  else if(view==='appointments')v.innerHTML=apHTML();
  else if(view==='pipeline')v.innerHTML=pipelineHTML();
  else if(view==='cases')v.innerHTML=casesHTML();
  else v.innerHTML=remindersHTML();
}
function emptyHTML(){
  return '<div class="empty"><h2>No cases yet</h2>Add a client to start tracking them from enquiry to completion, with reminders for offer expiry and product maturity.<br><button class="btn" data-act="new">Add your first case</button> <button class="btn ghost" data-act="pdf">Add from PDF</button></div>';
}

/* ---------- pipeline ---------- */
function pipelineHTML(){
  if(!cases.length)return emptyHTML();
  var list=sortList(visible().filter(function(c){return c.stage!=='lost'}));
  var active=list.filter(function(c){return c.stage!=='completed'});
  var vol=active.reduce(function(a,c){return a+(c.loanAmount||0)},0);
  var h='<div class="pagehead"><h1>Pipeline</h1><div class="stats">'+
    '<div class="stat"><b>'+active.length+'</b><span>Live cases</span></div>'+
    '<div class="stat"><b>'+money(vol)+'</b><span>Lending in progress</span></div></div></div><div class="board">';
  STAGES.forEach(function(s,i){
    var cs=list.filter(function(c){return c.stage===s.id});
    var sum=cs.reduce(function(a,c){return a+(c.loanAmount||0)},0);
    h+='<section class="col" data-stage="'+s.id+'"><h3>'+s.label+'<span>'+cs.length+'</span></h3><div class="sum">'+(sum?money(sum):'&nbsp;')+'</div><div class="cards">';
    cs.forEach(function(c){
      var ne=nextEvent(c),next=STAGES[i+1];
      h+='<div class="card" draggable="true" tabindex="0" role="button" data-open="'+c.id+'">'+
        '<div class="nm">'+esc(names(c))+cno(c)+'</div>'+
        '<div class="ad">'+esc(short(c.propertyAddress)||c.type||'')+propTag(c)+'</div>'+
        '<div class="row"><span class="num">'+money(c.loanAmount)+'</span><span class="muted">'+esc(c.lender||'')+'</span></div>'+
        (ne?'<div><span class="chip '+tone(ne.date)+'">'+esc(ne.label.split('.')[0])+' · '+rel(ne.date)+'</span></div>':'')+
        (next?'<button class="btn ghost sm go" data-adv="'+c.id+'" data-to="'+next.id+'">Move to '+next.label+' →</button>':'')+
      '</div>';
    });
    h+='</div></section>';
  });
  return h+'</div>';
}

/* ---------- cases table ---------- */
var CASE_COLS=[['type','Type'],['stage','Stage'],['lender','Lender'],['task','Next task due'],['review','Review date'],['note','Latest note'],['prot','Protection']];
var colsHide=(function(){try{return JSON.parse(localStorage.getItem('colsHide')||'[]')}catch(e){return []}})();
function colOn(k){return colsHide.indexOf(k)<0}
function lenderSelHTML(){var ls={};cases.forEach(function(c){if(c.lender)ls[c.lender]=1});return '<select id="lenderSel" aria-label="Filter by lender"><option value="">All lenders</option>'+Object.keys(ls).sort().map(function(l){return '<option value="'+esc(l)+'"'+(lenderFilter===l?' selected':'')+'>'+esc(l)+'</option>'}).join('')+'</select>'}
function revSelHTML(){var ms={};cases.forEach(function(c){var r=reviewOf(c);if(r)ms[r.slice(0,7)]=1});return '<select id="revSel" aria-label="Filter by review month"><option value="">Any review month</option>'+Object.keys(ms).sort().map(function(m){return '<option value="'+m+'"'+(revFilter===m?' selected':'')+'>'+new Date(m+'-01T00:00:00').toLocaleDateString('en-GB',{month:'long',year:'numeric'})+'</option>'}).join('')+'<option value="none"'+(revFilter==='none'?' selected':'')+'>No review date</option></select>'}
function casesHTML(){
  var list=sortList(visible());
  var opts='<option value="">All stages</option>'+STAGES.concat([{id:'lost',label:'Closed lost'}]).map(function(s){return '<option value="'+s.id+'"'+(stageFilter===s.id?' selected':'')+'>'+s.label+'</option>'}).join('');
  var h='<div class="pagehead"><h1>All cases</h1><button class="btn ghost" data-act="export">Export CSV</button></div>'+
    '<div class="filters"><select id="stageSel" aria-label="Filter by stage">'+opts+'</select> <select id="sortSel" aria-label="Sort clients">'+[['updated','Sort: recently updated'],['first','Sort: first name A–Z'],['review','Sort: mortgage review date'],['task','Sort: next task due date'],['clientno','Sort: client number']].map(function(o){return '<option value="'+o[0]+'"'+(sortBy===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>'+lenderSelHTML()+revSelHTML()+'<details class="colpick"><summary class="btn ghost">Columns</summary><div class="colbox">'+CASE_COLS.map(function(c){return '<label><input type="checkbox" data-colk="'+c[0]+'"'+(colOn(c[0])?' checked':'')+'> '+c[1]+'</label>'}).join('')+'</div></details>'+((stageFilter||lenderFilter||revFilter)?' <button type="button" class="btn ghost" data-clrf="1">Clear filters</button>':'')+'</div>';
  if(!cases.length)return h+emptyHTML();
  h+='<div class="tw"><table><thead><tr><th>Client</th>'+(colOn('type')?'<th>Type</th>':'')+(colOn('stage')?'<th>Stage</th>':'')+(colOn('lender')?'<th>Lender</th>':'')+(colOn('task')?'<th>Next task due</th>':'')+(colOn('review')?'<th>Review date</th>':'')+(colOn('note')?'<th>Latest note</th>':'')+(colOn('prot')?'<th>Protection</th>':'')+'</tr></thead><tbody>';
  if(!list.length)h+='<tr><td colspan="8" class="muted">No cases match.</td></tr>';
  var grp={};list.forEach(function(c){var k=clientKey(c);(grp[k]=grp[k]||[]).push(c)});var done={};
  list.forEach(function(c0){
    var k0=clientKey(c0),g=grp[k0];if(done[k0])return;done[k0]=1;
    if(g.length>1)h+='<tr class="cg"><td colspan="8"><b>'+esc(names(c0))+'</b> <span class="muted">· '+g.length+' properties: '+g.slice().sort(function(a,b){return (a.propUse==='main'?0:1)-(b.propUse==='main'?0:1)||(a.createdAt||0)-(b.createdAt||0)}).map(function(x){return propLabel(x.propUse)||'type not set'}).join(', ')+'</span></td></tr>';
    g.forEach(function(c){
    var ne=nextEvent(c),l=ltv(c);
    h+='<tr class="click'+(g.length>1?' ing':'')+'" data-open="'+c.id+'"><td><b>'+esc(names(c))+'</b>'+cno(c)+'<div class="muted" style="font-size:12px">'+esc(short(c.propertyAddress))+propTag(c)+'</div></td>'+
      (colOn('type')?'<td>'+esc(c.type||'')+'</td>':'')+(colOn('stage')?'<td><span class="chip">'+esc(STAGE_LABEL[c.stage]||c.stage)+'</span></td>':'')+
      (colOn('lender')?'<td>'+esc(c.lender||'')+'<div class="muted num" style="font-size:12px">'+esc(c.lenderRef||'')+'</div></td>':'')+
      (colOn('task')?taskCell(c):'')+(colOn('review')?'<td>'+(reviewOf(c)?'<span class="chip '+tone(reviewOf(c))+'">'+fd(reviewOf(c))+'</span>':'<span class="muted">—</span>')+'</td>':'')+
      (colOn('note')?'<td class="ntc">'+latestNoteCell(c)+'</td>':'')+(colOn('prot')?'<td class="ntc">'+latestNoteCell(c,'protection')+'</td>':'')+'</tr>';
    });
  });
  return h+'</tbody></table></div>';
}

/* ---------- reminders ---------- */
function remindersHTML(){
  var ev=reviewEvents(),q=query.trim().toLowerCase();
  if(q)ev=ev.filter(function(e){return (e.who+' '+e.label).toLowerCase().indexOf(q)>-1});
  var g=[['Overdue','bad',function(n){return n<0}],['Next 7 days','',function(n){return n>=0&&n<=7}],['Next 30 days','',function(n){return n>7&&n<=30}],['Later this year and beyond','',function(n){return n>30}]];
  var h='<div class="pagehead"><h1>Reminders</h1><span class="muted">Mortgage review dates only. Tasks are in the Tasks tab</span></div>';
  if(!ev.length)return h+'<div class="empty"><h2>No reviews due</h2>Completed cases appear here when they have a review date, or a fixed-rate end date (the review is set six months before it).</div>';
  g.forEach(function(x){
    var items=ev.filter(function(e){return x[2](diff(e.date))});
    if(!items.length)return;
    h+='<div class="group"><h3 class="'+x[1]+'">'+x[0]+' · '+items.length+'</h3>';
    items.forEach(function(e){
      h+='<button class="ev'+(e.sec?' sec':'')+'" data-open="'+e.id+'"><div class="d">'+fd(e.date)+'<small>'+rel(e.date)+'</small></div><div><b>'+esc(e.label)+'</b><div class="who">'+esc(e.who)+'</div></div><span class="chip '+tone(e.date)+'">'+(e.sec?'Security review':{dip:'DIP',offer:'Offer',completion:'Completion',reflect:'Reflection',review:'Review',task:'Task'}[e.kind])+'</span></button>';
    });
    h+='</div>';
  });
  return h;
}

/* ---------- drawer ---------- */
function fld(name,label,val,type,extra){
  type=type||'text';
  var inp='<input id="f-'+name+'" data-f="'+name+'" type="'+type+'" value="'+esc(val==null?'':val)+'"'+(type==='number'?' step="any" inputmode="decimal"':'')+'>';
  if(extra&&extra.gbp)inp='<span class="ig"><i>£</i>'+inp+'</span>';
  return '<label class="f'+(extra&&extra.wide?' wide':'')+'">'+label+inp+'</label>';
}
function stageOpts(cur){
  var o=[['dip','AIP'],['application','FMA'],['offer','Offered'],['completed','Completed'],['lost','Closed lost']];
  if(cur==='enquiry')o.unshift(['enquiry','Enquiry']);if(cur==='factfind')o.unshift(['factfind','Fact find']);
  return o;
}
function sel(name,label,val,opts){
  return '<label class="f">'+label+'<select id="f-'+name+'" data-f="'+name+'">'+opts.map(function(o){var v=o[0],l=o[1];return '<option value="'+esc(v)+'"'+(v===val?' selected':'')+'>'+esc(l)+'</option>'}).join('')+'</select></label>';
}
function elinks(m){
  m=String(m||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m))return '';
  return '<a href="https://outlook.live.com/mail/0/deeplink/compose?to='+encodeURIComponent(m)+'" target="_blank" rel="noopener">Send email (Outlook)</a><a href="mailto:'+esc(m)+'" target="_blank" rel="noopener">Mail app</a>';
}
function plinks(p){
  var d=String(p||'').replace(/[^\d+]/g,'');if(d.replace(/\D/g,'').length<7)return '';
  var intl=d.charAt(0)==='+'?d.slice(1):d.charAt(0)==='0'?'44'+d.slice(1):d;
  return '<a href="https://wa.me/'+intl+'" target="_blank" rel="noopener">WhatsApp</a>';
}
var secCollapsed={};
function secSumText(x){var rv=x.reviewDate||(x.fixedUntil?addMonths(x.fixedUntil,-REVM):'');var parts=[x.lender,x.rate?x.rate+'%':'',rv?'Review '+fd(rv):''].filter(Boolean);return parts.join(' · ')||'No lender details yet'}
var PROP_USES=[['','Choose…'],['btl','Buy to let'],['second','Second home'],['holiday','Holiday home'],['other','Other']];
function propsFs(c,id){
  var me=id?cases.filter(function(x){return x.id===id})[0]:null,list=me?sameClient(me):[],old=(c.securities||[]).filter(function(s){return s.address});
  var h='<fieldset class="secfs propfs"><legend>Properties for this client</legend><p class="muted" style="font-size:12px;margin:0 0 8px">Every property this client owns is its own record with its own lender, rate end date, stage and tasks. Clients are matched on name and date of birth; a joint case with someone else is a separate client.</p>';
  if(!me)h+='<p class="muted">Save this record first, then you can add further properties for the same client.</p>';
  else{
    h+='<div class="proplist">'+list.map(function(x){var cur=x.id===id;return '<div class="propi'+(cur?' cur':'')+'"><div><b>'+(propLabel(x.propUse)||'Property')+'</b>'+(cur?' <span class="muted">(this record)</span>':'')+' <span class="cno">'+esc(x.clientNo||'')+'</span><div>'+esc(short(x.propertyAddress)||'No address yet')+'</div><div class="muted" style="font-size:12px">'+[x.lender,STAGE_LABEL[x.stage]||x.stage,x.fixedUntil?'rate ends '+fd(x.fixedUntil):'',reviewOf(x)?'review '+fd(reviewOf(x)):''].filter(Boolean).join(' · ')+'</div></div>'+(cur?'':'<button type="button" class="btn ghost sm" data-open="'+x.id+'">Open</button>')+'</div>'}).join('')+'</div>';
    if(old.length)h+='<div class="propold"><b>Addresses noted earlier (not yet their own record)</b>'+old.map(function(s){return '<div class="propi"><div>'+(propUse(s.use)?'<b>'+esc(propUse(s.use))+'</b> ':'')+esc(short(s.address))+'</div><span><button type="button" class="btn sm" data-secprop="'+esc(s.id)+'">Add as property</button><button type="button" class="btn ghost sm" data-rmsec="'+esc(s.id)+'">Remove</button></span></div>'}).join('')+'</div>';
    h+='<div class="add propadd"><label class="f">New property type<select id="addPropUse">'+PROP_TYPES.map(function(o){return '<option value="'+o[0]+'">'+(o[0]?o[1]:'Choose type…')+'</option>'}).join('')+'</select></label><button type="button" class="btn" id="addProp">Add new property</button></div>';
  }
  return h+'<div id="secs" hidden>'+(c.securities||[]).map(secRow).join('')+'</div></fieldset>';
}
function propUse(v){var u=PROP_USES.filter(function(q){return q[0]===v})[0];return u&&u[0]?u[1]:''}
function secRow(x,i){
  x=x||{};var sid=x.id||('s'+Math.random().toString(36).slice(2,9));
  return '<div class="sec2" data-sid="'+sid+'"><div class="top2"><span>Other property '+(i+1)+'</span><span><button type="button" class="btn ghost sm" data-rmsec="'+sid+'">Remove</button></span></div>'+
   '<div class="grid"><label class="f">Property type<select data-s="use">'+PROP_USES.map(function(u){return '<option value="'+u[0]+'"'+((x.use||'')===u[0]?' selected':'')+'>'+u[1]+'</option>'}).join('')+'</select></label>'+
   '<label class="f wide">Property address<input data-s="address" value="'+esc(x.address)+'" placeholder="House number and street. Then use the postcode search below"></label></div>'+
   '<div class="pcbar"><input data-pc type="text" placeholder="UK postcode, e.g. B19 1AA" aria-label="Postcode search" autocomplete="off"><button type="button" class="btn ghost sm" data-pcfind>Find postcode</button><span class="pcres muted"></span></div></div>';
}
function ukPc(s){s=String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(s.length<5||s.length>7)return '';return s.slice(0,-3)+' '+s.slice(-3)}
function pcFind(btn){
  var card=btn.closest('.sec2'),inp=card.querySelector('[data-pc]'),out=card.querySelector('.pcres'),pc=ukPc(inp.value);
  if(!pc){out.textContent='Enter a full UK postcode';return}
  out.textContent='Searching…';
  fetch('https://api.postcodes.io/postcodes/'+encodeURIComponent(pc)).then(function(r){return r.json()}).then(function(j){
    if(!j||j.status!==200||!j.result){out.textContent='Postcode not found. Check it and try again.';return}
    var r=j.result,town=r.admin_district||r.parish||'';
    out.textContent=r.postcode+' · '+[r.admin_ward,r.admin_district,r.region||r.country].filter(Boolean).join(', ');
    var ad=card.querySelector('[data-s="address"]'),cur=ad.value.trim();
    if(cur.toUpperCase().replace(/[^A-Z0-9]/g,'').indexOf(r.postcode.replace(' ',''))<0){
      ad.value=(cur?cur.replace(/[,\s]+$/,'')+', ':'')+(town?town+', ':'')+r.postcode;
      ad.dispatchEvent(new Event('input',{bubbles:true}));
    }
    inp.value=r.postcode;
  }).catch(function(){out.textContent='Could not reach the postcode service. Check your connection.'});
}
function updSRev(){var el=$('#sRev');if(!el)return;var o=$('#f-reviewDate'),v=o?o.value:'';el.textContent=v?fd(v):'—'}
function appRow(a,i){
  a=a||{};
  return '<div class="app" data-app="'+i+'"><div class="top2"><span>Applicant '+(i+1)+'</span><button type="button" class="btn ghost sm" data-rmapp="'+i+'">Remove</button></div><div class="grid">'+
   '<label class="f">Full name<input data-a="name" value="'+esc(a.name)+'"></label>'+
   '<label class="f">Date of birth<input data-a="dob" type="date" value="'+esc(a.dob)+'"></label>'+
   '<label class="f">Phone<input data-a="phone" type="tel" value="'+esc(a.phone)+'"><span class="pl">'+plinks(a.phone)+'</span></label>'+
   '<label class="f">Email<input data-a="email" type="email" value="'+esc(a.email)+'"><span class="pl el">'+elinks(a.email)+'</span></label>'+
   '<label class="f wide">Current address<input data-a="address" value="'+esc(a.address)+'"></label>'+
   '<label class="f">Do you have a mortgage on this address?<select data-a="resMort"><option value=""'+(!a.resMort?' selected':'')+'>Not asked</option><option value="no"'+(a.resMort==='no'?' selected':'')+'>No</option><option value="yes"'+(a.resMort==='yes'?' selected':'')+'>Yes</option></select></label></div>'+
   '<div class="grid resm"'+(a.resMort==='yes'?'':' hidden')+'>'+
   '<label class="f">Current lender<input data-a="resLender" value="'+esc(a.resLender)+'"></label>'+
   '<label class="f">Mortgage type<select data-a="resType">'+[['','Choose…'],['repayment','Repayment'],['interest-only','Interest only'],['part-and-part','Part and part']].map(function(u){return '<option value="'+u[0]+'"'+((a.resType||'')===u[0]?' selected':'')+'>'+u[1]+'</option>'}).join('')+'</select></label>'+
   '<label class="f">Current deal ends<input data-a="resDealEnd" type="date" value="'+esc(a.resDealEnd)+'"></label>'+
   '<label class="f">Approx. balance (£)<input data-a="resBalance" type="number" min="0" step="1" value="'+esc(a.resBalance)+'"></label>'+
   '<label class="f">Owned by<select data-a="resOwn">'+[['','Choose…'],['sole','Sole name'],['joint','Joint names']].map(function(u){return '<option value="'+u[0]+'"'+((a.resOwn||'')===u[0]?' selected':'')+'>'+u[1]+'</option>'}).join('')+'</select></label>'+
   '</div></div>';
}
var pendingNotes=[];
function pickClient(){
  var list=cases.slice().sort(function(a,b){return names(a).toLowerCase()<names(b).toLowerCase()?-1:1});
  if(!list.length)return '';
  return '<label class="f" style="margin-bottom:12px">Start from an existing client (copies their details)<select id="fromClient"><option value="">Choose a client, or leave blank for a new one</option>'+list.map(function(x){return '<option value="'+esc(x.id)+'">'+esc(names(x)+(x.clientNo?' ('+x.clientNo+')':''))+'</option>'}).join('')+'</select></label>';
}
var pendingSecMove=null;
function startFrom(src,use,addr,secId){
  var ap=JSON.parse(JSON.stringify(src.applicants&&src.applicants.length?src.applicants:[{}]));
  var d={stage:'dip',type:use==='btl'?'Buy to let':'Purchase',repayment:'repayment',applicants:ap,propUse:use||'',propertyAddress:addr||'',oneDriveLink:src.oneDriveLink||'',_from:src.id,notes:[{ts:Date.now(),text:'Another property for the same client: '+names(src)+(src.clientNo?' (see '+src.clientNo+')':'')+(propLabel(use)?' · '+propLabel(use):'')+'.'}]};
  pendingSecMove=secId?{cid:src.id,sid:secId}:null;
  closeDrawer();openDrawer(null,d);
}
function secMoveDone(){var m=pendingSecMove;pendingSecMove=null;if(!m)return;var sc=cases.filter(function(x){return x.id===m.cid})[0];if(sc&&(sc.securities||[]).some(function(s){return s.id===m.sid}))patch(sc.id,{securities:sc.securities.filter(function(s){return s.id!==m.sid})})}
function openDrawer(id,draft){
  openId=id;noteSug=null;ntDraft='';notesAll=false;prDraft='';protAll=false;editNote=null;editTk=null;ntTable=null;prTable=null;pendingNotes=(draft&&draft.notes)||[];
  var c=id?cases.filter(function(x){return x.id===id})[0]:null;
  if(id&&!c){openId=undefined;return}
  c=c||Object.assign({stage:'dip',type:'Purchase',repayment:'repayment',applicants:[{}]},draft||{});
  var l=ltv(c);
  var d=$('#drawer');d.hidden=false;
  d.innerHTML='<div class="bk" data-close></div><div class="panel" role="dialog" aria-modal="true" aria-label="Case">'+
  '<div class="dh"><div style="min-width:0"><div class="eyebrow">'+(id?'Case':draft&&draft._from?'New property for an existing client. Add the property and mortgage details; it saves automatically':draft?'New case from PDF. Check the details, then save':'New case')+'</div><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><h2 id="dTitle" style="margin:0">'+esc(id?names(c):'Add a client')+'</h2></div>'+(id?'<div id="nextAppt" class="muted" style="font-size:12px;margin-top:4px">'+apNextHtml(id)+'</div>':'')+(id&&c.oneDriveLink?'<div class="pl" style="margin-top:4px">'+odLink(c.oneDriveLink)+'</div>':'')+
  '<div class="strip"><div><b id="sLtv">'+(l?l.toFixed(1)+'%':'—')+'</b><span>LTV</span></div><div><b>'+(rateEndOf(c)?fd(rateEndOf(c)):'—')+'</b><span>Rate ends</span></div><div><b id="sRev">'+(reviewOf(c)?fd(reviewOf(c)):'—')+'</b><span>Review date</span></div></div></div>'+
  '<div class="dhb" style="display:flex;gap:8px;flex-wrap:nowrap;justify-content:flex-end;align-items:center;flex:none">'+(id?'<button type="button" class="btn" id="bookBtn">Book appointment</button>':'')+(id?'<button type="button" class="btn" id="dupBtn" title="Same client, another property record">Add new property</button>':'')+'<button class="btn ghost" data-close aria-label="Close">Close</button></div></div>'+
  '<form id="caseForm" class="db" autocomplete="off">'+
   (!id&&!draft?pickClient():'')+'<fieldset><legend>Applicants and residential address</legend><div class="appsplit"><div class="appleft"><div id="apps">'+(c.applicants&&c.applicants.length?c.applicants:[{}]).map(appRow).join('')+'</div><button type="button" class="btn ghost sm" id="addApp">Add applicant</button><div class="grid" style="margin-top:10px">'+fld('clientNo','Client number',c.clientNo)+'</div></div><aside class="lkpane"><div class="lkt" style="display:flex;align-items:center;justify-content:space-between;gap:8px"><span id="lkTitle">Connected clients (0)</span><button type="button" class="btn ghost sm secbtn" id="lkToggle">Show</button></div><div id="linksBox" style="display:none"></div></aside></div></fieldset>'+
   propsFs(c,id)+
   secFs('lender','Lender')+
     sel('propUse','Property type',c.propUse,PROP_TYPES)+
     fld('lender','Lender name',c.lender)+
     sel('stage','Stage',c.stage,stageOpts(c.stage))+
     sel('type','Type',c.type,TYPES.map(function(t){return [t,t]}))+
     sel('repayment','Repayment method',c.repayment,[['repayment','Repayment'],['interest-only','Interest only'],['part-and-part','Part and part']])+
     fld('propertyAddress','Property address (Security Address)',c.propertyAddress,'text',{wide:1})+
     fld('purchasePrice','Purchase price',c.purchasePrice,'number',{gbp:1})+
     fld('propertyValue','Valuation',c.propertyValue,'number',{gbp:1})+
     fld('loanAmount','Loan amount',c.loanAmount,'number',{gbp:1})+
     fld('monthlyPayment','Monthly payment',c.monthlyPayment,'number',{gbp:1})+
     fld('termYears','Initial term (years)',c.termYears,'number')+
     fld('termLeft','Term left (years)',c.termLeft,'number')+
     fld('product','Product code',c.product)+
     fld('rate','Initial rate (%)',c.rate,'number')+
     fld('followOnRate','Rate after (%)',c.followOnRate,'number')+
     fld('erc','Early repayment charge',c.erc)+
     fld('fixedUntil','Initial deal ends',c.fixedUntil,'date')+
     '<label class="f">Mortgage review date (4 months before the initial deal ends. You can change it)<input id="f-reviewDate" data-f="reviewDate" type="date" data-auto="'+(c.reviewDate?'0':'1')+'" value="'+esc(ownReview(c))+'"></label>'+
     fld('lenderRef','Lender reference / roll number',c.lenderRef)+
   '</div></fieldset>'+
   '<div id="liveNotes"></div>'+
   '<div id="live"></div>'+
   '<fieldset class="odfs"><legend>OneDrive folder</legend><label class="f">OneDrive folder link<input id="f-oneDriveLink" data-f="oneDriveLink" type="url" placeholder="Paste the OneDrive folder link for this client" value="'+esc(c.oneDriveLink)+'"><span class="pl" id="odl">'+odLink(c.oneDriveLink)+'</span></label></fieldset>'+
  '</form>'+
  '<div class="df"><div>'+(id?'<button type="button" class="btn danger" id="delBtn">Delete case</button><span class="muted" id="autoMsg" style="font-size:12px;margin-left:10px">Auto-save on (every 5 seconds)</span>':'')+'</div><div style="display:flex;gap:8px"><button type="button" class="btn ghost" data-close>Cancel</button><button type="button" class="btn" id="saveBtn">Save case</button></div></div></div>';
  colOpen={};lkOpen=false;curLinks=((c&&c.links)||[]).map(function(l){return {id:l.id,cid:l.cid,rel:l.rel}});renderLive();renderLinks();
  var first=$('#drawer [data-a="name"]');if(first&&!id)first.focus();
  ntDraft=(id&&c.noteDraft)||'';prDraft=(id&&c.protDraft)||'';lastND=ntDraft;lastPD=prDraft;renderLive();
  lastAuto=id?JSON.stringify(collectForm()):null;
  newBase=id?null:JSON.stringify(collectForm());
}
function closeDrawer(){editNote=null;editTk=null;var d=$('#drawer');d.hidden=true;d.innerHTML='';openId=undefined;lastAuto=null;newBase=null;ntTable=null;prTable=null}
function currentCase(){return openId?cases.filter(function(x){return x.id===openId})[0]:null}

/* ---------- appointments ---------- */
var apCol=null,appts=[],apMonth={y:TODAY.getFullYear(),m:TODAY.getMonth()},apSel=iso(TODAY),apEditId=null,apClash=false;
var AP_TYPES=['Initial consultation','Fact-find','Document check','Mortgage review','Remortgage review','Offer or completion call','Follow-up','Other'];
var AP_MODES=['Phone','Video call','In person','Office'];
var AP_DURS=[15,30,45,60,90,120];
var AP_STATUS={booked:'Booked',done:'Done',cancelled:'Cancelled',noshow:'Missed'};
function apMin(t){var m=/^(\d\d):(\d\d)$/.exec(t||'');return m?+m[1]*60+ +m[2]:0}
function apHM(n){n=((n%1440)+1440)%1440;return String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')}
function apSorted(l){return l.slice().sort(function(a,b){return (a.date+' '+(a.time||''))<(b.date+' '+(b.time||''))?-1:(a.date+' '+(a.time||''))>(b.date+' '+(b.time||''))?1:0})}
function apCase(a){return a.caseId?cases.filter(function(x){return x.id===a.caseId})[0]:null}
function apWho(a){var c=apCase(a);return c?names(c):(a.who||'Unnamed')}
function apWhoHtml(a){var c=apCase(a);return c?'<button type="button" class="lnk" data-open="'+c.id+'">'+esc(names(c))+cno(c)+'</button>':esc(a.who||'Unnamed')+' <span class="apst">not yet a case</span>'}
function apLabel(c){return c.clientNo?c.clientNo+' · '+names(c):names(c)}
function apFindCase(v){v=String(v||'').trim();if(!v)return null;var no=v.split(' · ')[0].trim().toUpperCase(),c=no?cases.filter(function(x){return (x.clientNo||'').toUpperCase()===no})[0]:null;if(c)return c;var nm=v.replace(/^.* · /,'').trim().toLowerCase();return cases.filter(function(x){return names(x).toLowerCase()===nm})[0]||null}
function apTodayN(){var t=iso(TODAY);return appts.filter(function(a){return a.date===t&&a.status!=='cancelled'&&a.status!=='done'&&a.status!=='noshow'}).length}
function apCard(a,showDate){
  var st=a.status||'booked',end=apHM(apMin(a.time)+(+a.dur||30)),past=st==='booked'&&(a.date<iso(TODAY)||(a.date===iso(TODAY)&&apMin(a.time)+(+a.dur||30)<new Date().getHours()*60+new Date().getMinutes()));
  var dl=showDate?'<span class="muted" style="font-size:12px">'+new Date(a.date+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+' · </span>':'';
  var meta=[a.type,a.mode,a.where].filter(Boolean).map(esc).join(' · ');
  return '<div class="apc st-'+st+'"><div class="aptm" data-apdrag="'+a.id+'" title="Drag onto a day in the calendar to move it"><b>'+esc(a.time||'')+'</b>to '+end+'</div><div class="apbody"><div class="apwho">'+dl+apWhoHtml(a)+(st!=='booked'?'<span class="apst">'+AP_STATUS[st]+'</span>':'')+(past?'<span class="apst late">Past, still marked Booked</span>':'')+'</div>'+(meta?'<div class="muted" style="font-size:12px">'+meta+'</div>':'')+(a.notes?'<div style="font-size:13px;margin-top:3px;white-space:pre-wrap">'+esc(String(a.notes).slice(0,220))+'</div>':'')+'</div><div class="apact"><button type="button" class="btn ghost sm" data-apedit="'+a.id+'">Edit</button><button type="button" class="btn ghost sm" data-apdone="'+a.id+'">'+(st==='done'?'Reopen':'Mark done')+'</button>'+(past?'<button type="button" class="btn ghost sm" data-apmiss="'+a.id+'">Missed</button>'+(a.caseId?'<button type="button" class="btn sm" data-aprebook="'+a.id+'">Rebook</button>':''):(st==='noshow'&&a.caseId?'<button type="button" class="btn sm" data-aprebook="'+a.id+'">Rebook</button>':''))+'</div></div>';
}
function apHTML(home){
  var y=apMonth.y,mo=apMonth.m,first=new Date(y,mo,1),off=(first.getDay()+6)%7,tIso=iso(TODAY);
  var by={};appts.forEach(function(a){if(a.status==='cancelled')return;(by[a.date]=by[a.date]||[]).push(a)});
  var h=(home?'':'<div class="pagehead"><h1>Calendar</h1><span class="muted">Every appointment, past and future. Click a day, then Edit to amend one, including missed ones.</span></div>')+'<div class="apwrap"><div>';
  h+='<div class="aphead"><h2>'+first.toLocaleDateString('en-GB',{month:'long',year:'numeric'})+'</h2><button type="button" class="btn ghost sm" data-apmonth="-1" aria-label="Previous month">‹ Prev</button><button type="button" class="btn ghost sm" data-apmonth="0">Today</button><button type="button" class="btn ghost sm" data-apmonth="1" aria-label="Next month">Next ›</button><button type="button" class="btn" data-apnew="1" style="margin-left:auto">Book appointment</button></div>';
  h+='<div class="apgrid">'+['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(d){return '<div class="apdow">'+d+'</div>'}).join('');
  for(var i=0;i<42;i++){
    var d=new Date(y,mo,1-off+i),di=iso(d),l=apSorted(by[di]||[]),tk=tasksOn(di);
    h+='<button type="button" class="apcell'+(d.getMonth()!==mo?' out':'')+(di===tIso?' today':'')+(di===apSel?' sel':'')+'" data-apday="'+di+'" aria-label="'+di+(l.length?', '+l.length+' appointments':'')+(tk.length?', '+tk.length+' tasks due':'')+'"><span class="apn">'+d.getDate()+'</span>'+(tk.length?'<span class="aptkn" title="'+tk.length+' task'+(tk.length===1?'':'s')+' due">'+tk.length+' task'+(tk.length===1?'':'s')+'</span>':'')+
      l.slice(0,3).map(function(a){var late=(a.status||'booked')==='booked'&&di<tIso;return '<span class="apchip'+(a.status==='done'?' done':'')+(a.status==='noshow'?' miss':'')+(late?' late':'')+'" data-apdrag="'+a.id+'"'+(late?' title="Past appointment still marked Booked. Open the day to update it."':' title="Drag to another day to move it"')+'>'+esc(a.time)+' '+esc(apWho(a))+'</span>'}).join('')+(l.length>3?'<span class="apmore">+'+(l.length-3)+' more</span>':'')+
      (l.length?'<span class="apdots">'+l.slice(0,6).map(function(){return '<span class="apdot"></span>'}).join('')+'</span>':'')+'</button>';
  }
  h+='</div></div><div>';
  var day=apSorted(appts.filter(function(a){return a.date===apSel}));
  h+='<div class="aphead"><h2>'+new Date(apSel+'T00:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})+'</h2><button type="button" class="btn ghost sm" data-apnew="1">Book on this day</button></div>';
  h+=day.length?day.map(function(a){return apCard(a,false)}).join(''):'<div class="muted" style="margin-bottom:10px">Nothing booked on this day.</div>';
  var dtk=tasksOn(apSel);if(dtk.length)h+='<div class="aptks"><b>Tasks due this day</b>'+dtk.map(function(x){return '<div class="aptk'+(x.t.pri?' pri':'')+'">'+(x.t.time?'<span class="aptkt">'+esc(x.t.time)+'</span>':'')+'<span>'+esc(x.t.text)+'</span><button type="button" class="lnk" data-open="'+x.c.id+'">'+esc(names(x.c))+'</button></div>'}).join('')+'</div>';
  var nowMin=new Date().getHours()*60+new Date().getMinutes();
  var up=apSorted(appts.filter(function(a){return (a.status||'booked')==='booked'&&(a.date>tIso||(a.date===tIso&&apMin(a.time)+(+a.dur||30)>=nowMin))})).slice(0,8);
  h+='<div class="aphead" style="margin-top:16px"><h2 style="font-size:15px">Coming up</h2></div>'+(up.length?up.map(function(a){return apCard(a,true)}).join(''):'<div class="muted">No upcoming appointments.</div>');
  return h+'</div></div>';
}
var homeMonth=false;
function apHome(){
  if(homeMonth)return '<div class="aphead" style="margin-bottom:6px"><h2 style="font-size:15px">Month view</h2><button type="button" class="btn ghost sm" data-hmtog="0">Back to agenda</button></div>'+apHTML(true);
  var nowMin=new Date().getHours()*60+new Date().getMinutes(),tI=iso(TODAY),h='<div class="aphead"><h2>Today and next 7 days</h2><button type="button" class="btn ghost sm" data-hmtog="1">Month view</button><button type="button" class="btn" data-apnew="1" style="margin-left:auto">Book appointment</button></div>',any=0;
  for(var i=0;i<8;i++){
    var di=addDays(tI,i),l=apSorted(appts.filter(function(a){return a.date===di&&(a.status||'booked')!=='cancelled'}));
    if(!l.length&&i>0)continue;
    any+=l.length;
    var sec='<div class="agd"><b>'+(i===0?'Today':i===1?'Tomorrow':'')+(i<2?' · ':'')+new Date(di+'T00:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})+'</b><span class="muted"> · '+l.length+' appointment'+(l.length===1?'':'s')+'</span></div>'+(l.length?l.map(function(a){return apCard(a,false)}).join(''):'<div class="muted" style="margin:0 0 8px">Nothing booked today.</div>');
    h+=i===0?'<div class="agtoday">'+sec+'</div>':sec;
  }
  if(!any)h+='<div class="muted" style="margin-top:6px">No appointments in the next 7 days.</div>';
  return h;
}
function apNextHtml(cid){
  var nowMin=new Date().getHours()*60+new Date().getMinutes(),t=iso(TODAY);
  var up=apSorted(appts.filter(function(a){return a.caseId===cid&&(a.status||'booked')==='booked'&&(a.date>t||(a.date===t&&apMin(a.time)+(+a.dur||30)>=nowMin))}));
  if(!up.length)return '';
  var a=up[0];return 'Next appointment: <b>'+new Date(a.date+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+', '+esc(a.time)+'</b>'+(a.mode?' · '+esc(a.mode):'')+(up.length>1?' · +'+(up.length-1)+' more':'');
}
function apClose(){var o=$('#apOv');if(o)o.remove();apEditId=null;apClash=false;apDpM=null}
document.addEventListener('change',function(e){var x=e.target;if(x&&x.getAttribute&&x.getAttribute('data-a')==='resMort'){var row=x.closest('.app'),bx=row&&row.querySelector('.resm');if(bx){bx.hidden=x.value!=='yes';if(x.value==='yes'){var f=bx.querySelector('input');if(f)f.focus()}}}});
document.addEventListener('change',function(e){var x=e.target;if(!x)return;if(x.id==='apDur'){apClash=false;apDpRender()}else if(x.id==='apSlSel'){$('#apTime').value=x.value;apClash=false;apDpRender()}});
var apDpM=null;
function apT(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')}
function apDpRender(){
  var box=$('#apDp');if(!box)return;
  var dv=$('#apDate').value||iso(TODAY),tv=$('#apTime').value||'10:00',dur=+(($('#apDur')||{}).value)||30,pp=dv.split('-');
  if(!apDpM)apDpM={y:+pp[0],m:+pp[1]-1};
  var first=new Date(apDpM.y,apDpM.m,1),off=(first.getDay()+6)%7,dim=new Date(apDpM.y,apDpM.m+1,0).getDate(),tIso=iso(TODAY);
  var live=appts.filter(function(x){return (x.status||'booked')==='booked'&&x.id!==apEditId}),by={};
  live.forEach(function(x){(by[x.date]=by[x.date]||[]).push(x)});
  var cal='<div class="apdh"><button type="button" class="btn ghost sm" data-apdm="-1" aria-label="Previous month">&#8249; Prev</button><b>'+first.toLocaleDateString('en-GB',{month:'long',year:'numeric'})+'</b><button type="button" class="btn ghost sm" data-apdm="1" aria-label="Next month">Next &#8250;</button><button type="button" class="btn ghost sm" data-apdd="'+tIso+'">Today</button></div><div class="apdg">'+
    ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(h){return '<span class="apdw">'+h+'</span>'}).join('');
  for(var i=0;i<off;i++)cal+='<span></span>';
  for(var d=1;d<=dim;d++){
    var ds=apDpM.y+'-'+String(apDpM.m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'),L=(by[ds]||[]).slice().sort(function(x,y){return apMin(x.time)-apMin(y.time)});
    cal+='<button type="button" class="apdd'+(ds===dv?' sel':'')+(ds===tIso?' today':'')+'" data-apdd="'+ds+'" aria-label="'+ds+(L.length?', '+L.length+' booked':'')+'"><span class="apdn">'+d+'</span>'+
      L.slice(0,3).map(function(x){return '<span class="apdc">'+esc(x.time)+' '+esc(apWho(x))+'</span>'}).join('')+(L.length>3?'<span class="apdc more">+'+(L.length-3)+' more</span>':'')+(L.length?'<i class="apdot"></i>':'')+'</button>';
  }
  cal+='</div>';
  var s0=apMin(tv),lo=Math.min(7*60,s0),hi=Math.max(21*60+45,s0),day=(by[dv]||[]).slice().sort(function(x,y){return apMin(x.time)-apMin(y.time)});
  var opts='';
  for(var m=lo;m<=hi;m+=15){
    var busy=day.filter(function(x){return apMin(x.time)<m+15&&apMin(x.time)+(+x.dur||30)>m})[0];
    opts+='<option value="'+apT(m)+'"'+(m===s0?' selected':'')+'>'+apT(m)+(busy?'  — booked: '+esc(apWho(busy)):'')+'</option>';
  }
  var dd=new Date(+pp[0],+pp[1]-1,+pp[2]),sum=dd.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})+', '+apT(s0)+' to '+apT(s0+dur);
  var bk=day.map(function(x){return x.time+' '+esc(apWho(x))}).join(' &middot; ');
  box.innerHTML='<div class="apdcal">'+cal+'</div>'+
    '<div class="apdpick"><label class="apdsel">Time (15-minute slots)<select id="apSlSel" aria-label="Time">'+opts+'</select></label>'+
    '<div class="apdsum"><b>'+esc(sum)+'</b>'+(bk?'<div class="muted">Already booked that day: '+bk+'</div>':'<div class="muted">Nothing else booked that day.</div>')+'</div></div>';
}
function apOpen(id,date,preCase){
  apDpM=null;
  var a=id?appts.filter(function(x){return x.id===id})[0]:null;if(id&&!a)return;
  apEditId=a?a.id:null;apClash=false;
  var c=a&&apCase(a),who=a?(c?apLabel(c):(a.who||'')):'';
  if(!a&&preCase){var pc=cases.filter(function(x){return x.id===preCase})[0];if(pc)who=apLabel(pc)}
  var opt=function(list,sel){return list.map(function(v){return '<option'+(v===sel?' selected':'')+'>'+esc(v)+'</option>'}).join('')};
  var o=$('#apOv');if(!o){o=document.createElement('div');o.id='apOv';document.body.appendChild(o)}
  o.innerHTML='<div class="apm" role="dialog" aria-label="Appointment"><h2>'+(a?'Edit appointment':'Book appointment')+'</h2><div class="apf">'+
    '<label class="full">Client<input type="text" id="apWho" list="apCases" value="'+esc(who)+'" placeholder="Pick a client or case number, or type a new name" autocomplete="off"></label><datalist id="apCases">'+cases.slice().sort(function(x,y){return cnum(x)-cnum(y)}).map(function(x){return '<option value="'+esc(apLabel(x))+'"></option>'}).join('')+'</datalist>'+
    '<input type="hidden" id="apDate" value="'+esc(a?a.date:(date||iso(TODAY)))+'"><input type="hidden" id="apTime" value="'+esc(a?a.time:'10:00')+'"><div class="full apdp" id="apDp"></div>'+
    '<label>Type<select id="apType">'+opt(AP_TYPES,a&&a.type)+'</select></label><label>Length<select id="apDur">'+AP_DURS.map(function(v){return '<option value="'+v+'"'+(v===(a?+a.dur:30)?' selected':'')+'>'+v+' minutes</option>'}).join('')+'</select></label>'+
    '<label>How<select id="apMode">'+opt(AP_MODES,a&&a.mode)+'</select></label><label>Where or link<input type="text" id="apWhere" value="'+esc(a&&a.where||'')+'" placeholder="Address, phone number or meeting link"></label>'+
    (a?'<label class="full">Status<select id="apStatus">'+Object.keys(AP_STATUS).map(function(k){return '<option value="'+k+'"'+(k===(a.status||'booked')?' selected':'')+'>'+AP_STATUS[k]+'</option>'}).join('')+'</select></label>':'')+
    '<label class="full">Notes<textarea id="apNotes" rows="3" placeholder="What to cover, documents to bring">'+esc(a&&a.notes||'')+'</textarea></label></div>'+
    '<p id="apMsg" class="muted" style="min-height:18px;margin:8px 0 0"></p><div class="add" style="margin-top:8px"><button type="button" class="btn" id="apSave">'+(a?'Save changes':'Book it')+'</button><button type="button" class="btn ghost" data-apclose="1">Cancel</button>'+(a?'<button type="button" class="btn danger" id="apDel">Delete</button>':'')+'</div></div>';
  apDpRender();
  setTimeout(function(){var w=$('#apWho');if(w)w.focus()},50);
}
function apSave(){
  var msg=$('#apMsg'),wv=$('#apWho').value.trim(),date=$('#apDate').value,time=$('#apTime').value;
  if(!wv){msg.textContent='Choose or type who the appointment is with.';return}
  if(!date||!time){msg.textContent='Choose a date and a time.';return}
  var c=apFindCase(wv),ex=apEditId?appts.filter(function(x){return x.id===apEditId})[0]:null,ref=apEditId?apCol.doc(apEditId):apCol.doc(),id=ref.id;
  var d={caseId:c?c.id:'',who:c?names(c):wv,type:$('#apType').value,date:date,time:time,dur:+$('#apDur').value||30,mode:$('#apMode').value,where:$('#apWhere').value.trim(),notes:$('#apNotes').value.trim(),status:apEditId?$('#apStatus').value:'booked',created:(ex&&ex.created)||Date.now(),updatedAt:Date.now()};
  if(d.status==='noshow'&&(!ex||ex.status!=='noshow')&&d.caseId)setTimeout(function(){apMissTask(d)},400);
  var s0=apMin(time),e0=s0+d.dur,clash=(d.status==='booked')?appts.filter(function(x){return x.id!==id&&x.date===date&&(x.status||'booked')==='booked'&&apMin(x.time)<e0&&apMin(x.time)+(+x.dur||30)>s0}):[];
  if(clash.length&&!apClash){apClash=true;msg.textContent='That overlaps with '+apWho(clash[0])+' at '+clash[0].time+'. Press the button again to book it anyway.';return}
  write('ap-'+id,function(){return apEditId?ref.update(d):ref.set(d)});
  apSel=date;var pd=date.split('-');apMonth={y:+pd[0],m:+pd[1]-1};
  var was=apEditId;apClose();toast(was?'Appointment updated':'Appointment booked');setTimeout(function(){if(view==='appointments'||view==='tasks')render();renderNav()},30);
}
/* ---------- notes -> suggested tasks / appointments / stage ---------- */
var noteSug=null;
var SUG_ACT=/\b(call|ring|phone|chase|chasing|email|send|book|follow(?:\s|-)?up|remind|check|request|submit|arrange|contact|speak to|ask|text|upload|order|instruct|get|obtain|confirm|update|review|visit|meet|meeting|appointment|zoom|teams)\b/i;
var SUG_MEET=/\b(call|ring|phone|visit|meet|meeting|appointment|zoom|teams|speak to|review meeting|sign)\b/i;
var SUG_STAGE=[[/\b(offer(ed)?\s+(received|issued|out|came through)|mortgage offer|formal offer)\b/i,'offer'],[/\b(completed|completion (took place|went through|happened)|keys released)\b/i,'completed'],[/\b(fma|full (mortgage )?application|application)\s+(submitted|sent|keyed|in)\b/i,'application'],[/\b(dip|aip|decision in principle|agreement in principle)\s+(agreed|approved|accepted|passed|done|obtained)\b/i,'dip'],[/\bfact(\s|-)?find\s+(done|completed|booked|held)\b/i,'factfind']];
var SUG_DOW={monday:1,mon:1,tuesday:2,tue:2,tues:2,wednesday:3,wed:3,thursday:4,thu:4,thur:4,thurs:4,friday:5,fri:5,saturday:6,sat:6,sunday:0,sun:0};
function sugWhen(s){
  var now=new Date(TODAY.getFullYear(),TODAY.getMonth(),TODAY.getDate()),d=null,m,low=s.toLowerCase();
  if(/\btoday\b|\bthis (morning|afternoon|evening)\b|\btonight\b/.test(low))d=new Date(now);
  else if(/\btomorrow\b/.test(low)){d=new Date(now);d.setDate(d.getDate()+1)}
  else if((m=low.match(/\bin (\d+|a|one|two|three|four|five|six)\s*(day|week|month)s?\b/))){var n={a:1,one:1,two:2,three:3,four:4,five:5,six:6}[m[1]]||+m[1];d=new Date(now);if(m[2]==='day')d.setDate(d.getDate()+n);else if(m[2]==='week')d.setDate(d.getDate()+7*n);else d.setMonth(d.getMonth()+n)}
  else if((m=low.match(/\b(next|this|on|by|before)?\s*(monday|mon|tuesday|tue|tues|wednesday|wed|thursday|thu|thur|thurs|friday|fri|saturday|sat|sunday|sun)\b/))){var want=SUG_DOW[m[2]],diff=(want-now.getDay()+7)%7;if(diff===0&&m[1]!=='this')diff=7;if(m[1]==='next'&&diff<7)diff+=0;d=new Date(now);d.setDate(d.getDate()+diff)}
  else if(/\bnext week\b/.test(low)){d=new Date(now);d.setDate(d.getDate()+((8-now.getDay())%7||7))}
  else if(/\bend of (the )?month\b/.test(low)){d=new Date(now.getFullYear(),now.getMonth()+1,0)}
  else if(/\bend of (the )?week\b/.test(low)){d=new Date(now);d.setDate(d.getDate()+((5-now.getDay()+7)%7))}
  else if((m=low.match(/\b(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\b/))){var yy=m[3]?(m[3].length===2?2000+ +m[3]:+m[3]):now.getFullYear();var dd=new Date(yy,+m[2]-1,+m[1]);if(!m[3]&&dd<now)dd.setFullYear(yy+1);if(!isNaN(dd))d=dd}
  else if((m=low.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/))){var mi=['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].slice(0,3));var d2=new Date(m[3]?+m[3]:now.getFullYear(),mi,+m[1]);if(!m[3]&&d2<now)d2.setFullYear(d2.getFullYear()+1);d=d2}
  var time='';if((m=low.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/))){var hh=+m[1]%12+(m[3]==='pm'?12:0);time=('0'+hh).slice(-2)+':'+(m[2]||'00')}
  else if((m=low.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)))time=('0'+m[1]).slice(-2)+':'+m[2];
  else if((m=low.match(/\bat (\d{1,2})\b/))&&+m[1]>=7&&+m[1]<=20)time=('0'+m[1]).slice(-2)+':00';
  if(time&&!d)d=new Date(now);
  return {date:d?iso(d):'',time:time};
}
function sugClean(s){s=s.replace(/^\s*[-*•\d.)]+\s*/,'').replace(/\s+/g,' ').trim().replace(/[.;,]+$/,'');if(s.length>90)s=s.slice(0,87).replace(/\s\S*$/,'')+'…';return s.charAt(0).toUpperCase()+s.slice(1)}
function noteSuggest(text,c){
  var out=[],seen={},existing=(c&&c.tasks||[]).filter(function(x){return !x.done}).map(function(x){return x.text.toLowerCase()});
  var parts=text.split(/[.!?]+\s+|\n+|;\s+/).map(function(s){return s.trim()}).filter(Boolean);
  parts.forEach(function(s){
    if(out.length>=3)return;
    var low=s.toLowerCase();
    if(/\b(has|have|had|was|were|did|done|sent|called|rang|spoke|chased|emailed|received|confirmed|completed|agreed)\b/.test(low)&&!/\b(need|needs|must|should|will|to|remember|remind|next|then|book)\b/.test(low))return;
    if(!SUG_ACT.test(s))return;
    var w=sugWhen(s),txt=sugClean(s),k=txt.toLowerCase();
    if(seen[k]||existing.indexOf(k)>-1)return;seen[k]=1;
    if(w.time&&SUG_MEET.test(s))out.push({kind:'appt',text:txt,date:w.date,time:w.time});
    else out.push({kind:'task',text:txt,date:w.date,time:w.time});
  });
  var cur=c&&c.stage||'',order=STAGES.map(function(s){return s.id});
  for(var i=0;i<SUG_STAGE.length;i++){if(SUG_STAGE[i][0].test(text)){var st=SUG_STAGE[i][1];if(st!==cur&&order.indexOf(st)>order.indexOf(cur))out.push({kind:'stage',stage:st,text:'Move stage to '+STAGE_LABEL[st]});break}}
  return out.length?{items:out.slice(0,4)}:null;
}
function sugLabel(x){var fd=function(s){return new Date(s+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})};
  if(x.kind==='stage')return '<span class="sgk">Stage</span> '+esc(x.text);
  if(x.kind==='appt')return '<span class="sgk">Appointment</span> '+esc(x.text)+' <span class="muted">· '+fd(x.date)+' '+esc(x.time)+'</span>';
  return '<span class="sgk">Task</span> '+esc(x.text)+(x.date?' <span class="muted">· due '+fd(x.date)+(x.time?' '+esc(x.time):'')+'</span>':' <span class="muted">· no date found, add one after</span>')}
function sugHtml(){
  if(!noteSug||!noteSug.items.length)return '';
  return '<div id="ntSug" class="ntsug" role="region" aria-label="Suggested from this note"><div class="sgh"><b>Suggested from this note</b><span class="muted"> · nothing is created until you press Add</span><button type="button" class="btn ghost sm" data-sgall="1">Dismiss all</button></div>'+
    noteSug.items.map(function(x,i){return '<div class="sgi"><span>'+sugLabel(x)+'</span><span class="sgb"><button type="button" class="btn sm" data-sgadd="'+i+'">Add</button><button type="button" class="btn ghost sm" data-sgx="'+i+'">Dismiss</button></span></div>'}).join('')+'</div>';
}
function sugApply(i){
  var x=noteSug&&noteSug.items[i],c=currentCase();if(!x||!c)return;
  if(x.kind==='task'){patch(openId,{tasks:(c.tasks||[]).concat([{id:uid(),text:x.text,due:x.date||'',time:x.time||'',done:false,created:Date.now(),pri:false,from:'note'}])});toast('Task added')}
  else if(x.kind==='stage'){var ss=$('#f-stage');if(ss)ss.value=x.stage;patch(openId,{stage:x.stage});toast('Stage set to '+STAGE_LABEL[x.stage])}
  else if(x.kind==='appt'){apOpen(null,x.date||iso(TODAY),openId);setTimeout(function(){var s=$('#apSlSel');if(s&&x.time){var mm=apMin(x.time),r=Math.round(mm/15)*15,v=apT(r);if([].some.call(s.options,function(o){return o.value===v})){s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}))}}var n=$('#apNotes');if(n&&!n.value)n.value=x.text},80)}
  noteSug.items.splice(i,1);if(!noteSug.items.length)noteSug=null;if(x.kind!=='appt')renderLive();else{var b=$('#ntSug');if(b)b.outerHTML=sugHtml()}
}
document.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;
  var ad=t.closest('[data-sgadd]');if(ad){sugApply(+ad.getAttribute('data-sgadd'));return}
  var dx=t.closest('[data-sgx]');if(dx){if(noteSug){noteSug.items.splice(+dx.getAttribute('data-sgx'),1);if(!noteSug.items.length)noteSug=null}var b=$('#ntSug');if(b)b.outerHTML=sugHtml();return}
  if(t.closest('[data-sgall]')){noteSug=null;var b2=$('#ntSug');if(b2)b2.remove();return}
});
/* missed appointment -> rebook task on the case */
function apMissTask(a){
  var c=a&&a.caseId&&cases.filter(function(x){return x.id===a.caseId})[0];if(!c)return false;
  var txt='Rebook missed '+(a.type||'appointment').toLowerCase()+' from '+new Date(a.date+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'});
  if((c.tasks||[]).some(function(x){return !x.done&&x.text.toLowerCase()===txt.toLowerCase()}))return false;
  patch(c.id,{tasks:(c.tasks||[]).concat([{id:uid(),text:txt,due:iso(TODAY),time:'',done:false,created:Date.now(),pri:true,from:'missed'}])});return true;
}
/* tasks due on a day, for the calendar */
function tasksOn(di){var out=[];cases.forEach(function(c){(c.tasks||[]).forEach(function(x){if(!x.done&&x.due===di)out.push({c:c,t:x})})});out.sort(function(a,b){return (a.t.time||'99')<(b.t.time||'99')?-1:1});return out}
/* ---------- drag an appointment to another day / time ---------- */
var apDrag=null,apDragUsed=false;
function apDragGhost(a){var g=document.createElement('div');g.className='apghost';g.textContent=(a.time||'')+' '+apWho(a);document.body.appendChild(g);return g}
function apDragCell(x,y){var el=document.elementFromPoint(x,y);return el&&el.closest?el.closest('.apcell[data-apday]'):null}
function apDragClear(){document.querySelectorAll('.apcell.drop').forEach(function(c){c.classList.remove('drop')})}
function apDragEnd(){if(!apDrag)return;if(apDrag.ghost)apDrag.ghost.remove();apDragClear();document.body.classList.remove('apdragging');apDrag=null}
document.addEventListener('pointerdown',function(e){
  if(e.button&&e.button!==0)return;var h=e.target.closest&&e.target.closest('[data-apdrag]');if(!h)return;
  if(!document.querySelector('.apcell[data-apday]'))return;
  var id=h.getAttribute('data-apdrag'),a=appts.filter(function(x){return x.id===id})[0];if(!a)return;
  apDrag={id:id,a:a,x:e.clientX,y:e.clientY,on:false,ghost:null,pid:e.pointerId,h:h};
  try{h.setPointerCapture(e.pointerId)}catch(_){}
});
document.addEventListener('pointermove',function(e){
  if(!apDrag||e.pointerId!==apDrag.pid)return;
  if(!apDrag.on){if(Math.abs(e.clientX-apDrag.x)+Math.abs(e.clientY-apDrag.y)<7)return;apDrag.on=true;apDrag.ghost=apDragGhost(apDrag.a);document.body.classList.add('apdragging')}
  e.preventDefault();
  apDrag.ghost.style.left=(e.clientX+12)+'px';apDrag.ghost.style.top=(e.clientY+12)+'px';
  var c=apDragCell(e.clientX,e.clientY);apDragClear();if(c)c.classList.add('drop');
});
document.addEventListener('pointerup',function(e){
  if(!apDrag||e.pointerId!==apDrag.pid)return;
  var d=apDrag,c=d.on?apDragCell(e.clientX,e.clientY):null;
  apDragEnd();
  if(!d.on)return;
  apDragUsed=true;setTimeout(function(){apDragUsed=false},300);
  if(c)apMoveOpen(d.id,c.getAttribute('data-apday'));
});
document.addEventListener('pointercancel',function(){apDragEnd()});
function apMoveOpen(id,date){
  var a=appts.filter(function(x){return x.id===id})[0];if(!a)return;
  apMoveClose();
  var s0=apMin(a.time),dur=+a.dur||30,lo=Math.min(7*60,s0),hi=Math.max(21*60+45,s0);
  var day=appts.filter(function(x){return x.id!==id&&x.date===date&&(x.status||'booked')==='booked'}),opts='';
  for(var m=lo;m<=hi;m+=15){var busy=day.filter(function(x){return apMin(x.time)<m+15&&apMin(x.time)+(+x.dur||30)>m})[0];
    opts+='<option value="'+apT(m)+'"'+(m===s0?' selected':'')+'>'+apT(m)+(busy?'  — booked: '+esc(apWho(busy)):'')+'</option>'}
  var fd=function(s){return new Date(s+'T00:00:00').toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})};
  var o=document.createElement('div');o.id='apMvOv';o.setAttribute('role','dialog');o.setAttribute('aria-label','Move appointment');
  o.innerHTML='<div class="apmv"><h2>Move appointment</h2><div class="apmvwho">'+esc(apWho(a))+'</div>'+
    '<div class="apmvrow"><span class="muted">From</span><b>'+fd(a.date)+', '+esc(a.time||'')+'</b></div>'+
    '<div class="apmvrow"><span class="muted">To</span><b>'+fd(date)+(date===a.date?' <span class="muted">(same day)</span>':'')+'</b></div>'+
    '<label class="apdsel">New time (15-minute slots)<select id="apMvTime" aria-label="New time">'+opts+'</select></label>'+
    '<div id="apMvMsg" class="muted" style="min-height:18px;margin-top:6px"></div>'+
    '<div class="apmvbtns"><button type="button" class="btn ghost" data-apmvx="1">Cancel</button><button type="button" class="btn" data-apmvok="1">Move</button></div></div>';
  o.dataset.id=id;o.dataset.date=date;o.dataset.force='';
  document.body.appendChild(o);var sel=$('#apMvTime');if(sel)sel.focus();
}
function apMoveClose(){var o=$('#apMvOv');if(o)o.remove()}
function apMoveSave(){
  var o=$('#apMvOv');if(!o)return;var id=o.dataset.id,date=o.dataset.date,time=$('#apMvTime').value,a=appts.filter(function(x){return x.id===id})[0];if(!a)return apMoveClose();
  var dur=+a.dur||30,s0=apMin(time),e0=s0+dur,msg=$('#apMvMsg');
  var clash=(a.status||'booked')==='booked'?appts.filter(function(x){return x.id!==id&&x.date===date&&(x.status||'booked')==='booked'&&apMin(x.time)<e0&&apMin(x.time)+(+x.dur||30)>s0}):[];
  if(clash.length&&!o.dataset.force){o.dataset.force='1';msg.textContent='That overlaps with '+apWho(clash[0])+' at '+clash[0].time+'. Press Move again to move it anyway.';return}
  if(date===a.date&&time===a.time){apMoveClose();return}
  var ref=apCol.doc(id),d={date:date,time:time,updatedAt:Date.now()};
  write('ap-'+id,function(){return ref.update(d)});
  apSel=date;var pd=date.split('-');apMonth={y:+pd[0],m:+pd[1]-1};
  apMoveClose();toast('Appointment moved to '+new Date(date+'T00:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'})+' '+time);
  setTimeout(function(){if(view==='appointments'||view==='tasks')render();renderNav()},30);
}
document.addEventListener('click',function(e){var t=e.target;if(!t.closest)return;
  if(t.closest('[data-apmvok]')){apMoveSave();return}
  if(t.closest('[data-apmvx]')||(t.id==='apMvOv')){apMoveClose();return}
});
document.addEventListener('change',function(e){if(e.target&&e.target.id==='apMvTime'){var o=$('#apMvOv');if(o){o.dataset.force='';var m=$('#apMvMsg');if(m)m.textContent=''}}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'&&$('#apMvOv')){apMoveClose();e.stopPropagation()}},true);
/* ---------- marketing contacts ---------- */
var mkCol=null,mkItems=[],mkQuery='',mkConsent='',mkGroup='',mkGroupKey='',mkEditId=null,mkTab='contacts';
var MK_LABEL={yes:'Opted in',unknown:'Unknown',no:'Opted out'};
function mkSave(){var items=mkItems.slice();return write('mk',function(){return mkCol.doc('contacts').set({items:items,updatedAt:Date.now()})})}
function mkShell(){
  var tabs='<div class="mktabs"><button type="button" class="mktab'+(mkTab==='contacts'?' on':'')+'" data-mktab="contacts">Contacts</button><button type="button" class="mktab'+(mkTab==='messages'?' on':'')+'" data-mktab="messages">Messages</button></div>';
  var head='<div class="pagehead"><h1>Marketing</h1><span class="muted">'+(mkTab==='messages'?'Messages to send to your contacts':'Contacts for your marketing')+'</span></div>';
  if(mkTab==='messages')return '<div id="mkRoot" data-tab="messages">'+head+tabs+'<div id="mkMsgs"></div></div>';
  return '<div id="mkRoot" data-tab="contacts">'+head+tabs+
  '<div class="mknote"><b>Before you message anyone:</b> only market to people who have agreed to hear from you (UK GDPR and PECR). Imported contacts start as <b>Unknown</b>. Mark them <b>Opted in</b> once they agree, and <b>Opted out</b> if they ask you to stop.</div>'+
  '<div class="mkbar"><input id="mkQ" type="search" placeholder="Search contacts" aria-label="Search contacts" value="'+esc(mkQuery)+'"><select id="mkConsent" aria-label="Filter by consent"><option value="">All consent</option><option value="yes">Opted in</option><option value="unknown">Unknown</option><option value="no">Opted out</option></select><select id="mkGroup" aria-label="Filter by group"></select>'+
  '<button type="button" class="btn" data-mkadd="1">Add contact</button><label class="btn ghost mkimp">Import<input type="file" id="mkImp" accept=".csv,.vcf,text/csv,text/vcard,text/x-vcard,text/plain" hidden></label><button type="button" class="btn ghost" data-mkexp="1">Export CSV</button><span id="mkCount" class="muted"></span></div>'+
  '<div class="mkbar"><label class="mktpl">Message for the WhatsApp and Email buttons <select id="mkTpl" aria-label="Message"></select></label></div>'+
  '<div id="mkList"></div></div>';
}
function mkGroups(){var g={};mkItems.forEach(function(c){if(c.group)g[c.group]=1});return Object.keys(g).sort()}
function mkFiltered(){
  var q=mkQuery.trim().toLowerCase();
  return mkItems.filter(function(c){
    if(mkConsent&&(c.consent||'unknown')!==mkConsent)return false;
    if(mkGroup&&(c.group||'')!==mkGroup)return false;
    if(!q)return true;
    return ((c.name||'')+' '+(c.phone||'')+' '+(c.email||'')+' '+(c.group||'')+' '+(c.notes||'')).toLowerCase().indexOf(q)>=0;
  }).sort(function(a,b){
    var na=mkNamed(a),nb=mkNamed(b);if(na!==nb)return na?-1:1;
    return (na?a.name:(a.phone||a.email||'')).localeCompare(nb?b.name:(b.phone||b.email||''),undefined,{sensitivity:'base',numeric:true});
  });
}
function mkNamed(c){return !!(c.name&&/\p{L}/u.test(c.name))}
function mkWa(c){var d=String(c.phone||'').replace(/\D/g,'');return d.length>=8?'https://wa.me/'+d:''}
function mkLinks(c){
  var w=mkWa(c),h='';
  var tp=mkTplCur();
  if(w&&tp)w+='?text='+encodeURIComponent(mkFill(tp.text,c));
  if(w)h+='<a class="mklink wa" href="'+esc(w)+'" target="_blank" rel="noopener noreferrer" title="Open WhatsApp chat">WhatsApp</a>';
  if(c.email)h+='<a class="mklink em" href="mailto:'+esc(c.email)+(tp?'?subject='+encodeURIComponent(tp.subject||tp.title)+'&body='+encodeURIComponent(mkFill(tp.text,c).replace(/\n/g,'\r\n')):'')+'" title="Send an email">Email</a>';
  return h||'<span class="muted">\u2014</span>';
}
function mkTplOpts(){var sel=$('#mkTpl');if(!sel)return;sel.innerHTML='<option value="">No message (blank)</option>'+mkTpls().map(function(m){return '<option value="'+esc(m.id)+'"'+(m.id===mkTplId?' selected':'')+'>'+esc(m.title)+'</option>'}).join('')}
function mkList(){
  if(mkTab==='messages'){mkMsgs();return}
  var box=$('#mkList');if(!box)return;
  mkTplOpts();
  var gs=mkGroups(),key=gs.join('|')+'#'+mkGroup,sel=$('#mkGroup');
  if(sel&&mkGroupKey!==key){mkGroupKey=key;sel.innerHTML='<option value="">All groups</option>'+gs.map(function(g){return '<option value="'+esc(g)+'"'+(g===mkGroup?' selected':'')+'>'+esc(g)+'</option>'}).join('')}
  var cs=$('#mkConsent');if(cs&&cs.value!==mkConsent)cs.value=mkConsent;
  var l=mkFiltered(),n=mkItems.length,shown=l.slice(0,500);
  var ct=$('#mkCount');if(ct)ct.textContent=l.length===n?n+' contact'+(n===1?'':'s'):l.length+' of '+n+' shown';
  if(!n){box.innerHTML='<div class="empty"><h2>No contacts yet</h2>Use Import to load a CSV or vCard (.vcf) file, or Add contact to type one in.</div>';return}
  if(!l.length){box.innerHTML='<div class="muted" style="margin-top:12px">No contacts match.</div>';return}
  box.innerHTML='<div class="tw"><table><thead><tr><th>Name</th><th>Phone</th><th>Email</th><th>Group</th><th>Message</th><th>Consent</th><th>Notes</th></tr></thead><tbody>'+shown.map(function(c){
    var k=c.consent||'unknown';
    return '<tr class="click" data-mkedit="'+esc(c.id)+'"><td><b>'+esc(c.name||'(no name)')+'</b></td><td class="num">'+esc(c.phone||'')+'</td><td>'+esc(c.email||'')+'</td><td>'+esc(c.group||'')+'</td><td class="mklinks">'+mkLinks(c)+'</td><td><span class="chip mk-'+k+'">'+MK_LABEL[k]+'</span></td><td class="ntc"><div class="nl1">'+esc(c.notes||'')+'</div></td></tr>';
  }).join('')+'</tbody></table></div>'+(l.length>shown.length?'<div class="muted" style="margin-top:8px">Showing the first 500. Use search or filters to narrow the list.</div>':'');
}
function mkNorm(p){
  var raw=String(p||'').trim();if(!raw)return '';
  var plus=raw.charAt(0)==='+',d=raw.replace(/\D/g,'');if(!d)return '';
  if(!plus&&d.slice(0,2)==='00'){plus=true;d=d.slice(2)}
  if(plus)return '+'+d;
  if(d.charAt(0)==='0')return '+44'+d.slice(1);
  if(d.slice(0,2)==='44'&&d.length>=12)return '+'+d;
  if(d.length===10&&d.charAt(0)==='7')return '+44'+d;
  return d;
}
function mkKey(c){return c.phone?'p'+c.phone:c.email?'e'+c.email.toLowerCase():'n'+(c.name||'').toLowerCase()}
function mkId(){return 'm'+Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function mkCsvRows(t){
  var rows=[],row=[],f='',q=false,i=0,c;
  var first=t.split(/\r?\n/)[0]||'',dl=',';
  [',',';','\t'].forEach(function(d){if(first.split(d).length>first.split(dl).length)dl=d});
  for(i=0;i<t.length;i++){
    c=t.charAt(i);
    if(q){if(c==='"'){if(t.charAt(i+1)==='"'){f+='"';i++}else q=false}else f+=c}
    else if(c==='"')q=true;
    else if(c===dl){row.push(f);f=''}
    else if(c==='\n'||c==='\r'){if(c==='\r'&&t.charAt(i+1)==='\n')i++;row.push(f);f='';if(row.some(function(x){return x.trim()}))rows.push(row);row=[]}
    else f+=c;
  }
  row.push(f);if(row.some(function(x){return x.trim()}))rows.push(row);
  return rows;
}
function mkParseCsv(t){
  var rows=mkCsvRows(t.replace(/^﻿/,''));if(!rows.length)return [];
  var hasData=function(r){return r.some(function(x){return /@/.test(x)||x.replace(/\D/g,'').length>=7})};
  var head=!hasData(rows[0]),out=[];
  if(head){
    var h=rows[0].map(function(x){return x.trim().toLowerCase()}),body=rows.slice(1);
    var idx=function(re){var r=[];h.forEach(function(x,i){if(re.test(x))r.push(i)});return r};
    var nm=idx(/^(name|full name|display name|contact name|contact)$/),fn=idx(/^(first name|given name|first)$/),ln=idx(/^(last name|family name|surname|last)$/),
        ph=idx(/phone|mobile|tel|number|whatsapp/),em=idx(/e-?mail/),gr=idx(/^(group|groups|label|labels|source|list|group membership)$/),no=idx(/note/),co=idx(/consent|opt/);
    body.forEach(function(r){
      var g=function(a){for(var i=0;i<a.length;i++){var v=(r[a[i]]||'').trim();if(v)return v}return ''};
      var name=g(nm)||((g(fn)+' '+g(ln)).trim()),cv=g(co).toLowerCase();
      out.push({name:name,phone:g(ph),email:g(em),group:g(gr).replace(/\s*:::\s*\*?$/,''),notes:g(no),consent:/^(yes|y|opted in|opt in|true|1)$/.test(cv)?'yes':/^(no|n|opted out|opt out|false|0)$/.test(cv)&&cv?'no':'unknown'});
    });
  }else{
    rows.forEach(function(r){
      var o={name:'',phone:'',email:'',group:'',notes:'',consent:'unknown'};
      r.forEach(function(x){x=x.trim();if(!x)return;if(/@/.test(x)&&!o.email)o.email=x;else if(x.replace(/\D/g,'').length>=7&&/^[+()\d\s.-]+$/.test(x)&&!o.phone)o.phone=x;else if(!o.name)o.name=x});
      out.push(o);
    });
  }
  return out;
}
function mkParseVcf(t){
  var lines=t.replace(/\r/g,'').replace(/\n[ \t]/g,'').split('\n'),out=[],cur=null;
  lines.forEach(function(l){
    if(/^BEGIN:VCARD/i.test(l)){cur={name:'',phone:'',email:'',group:'',notes:'',consent:'unknown'};return}
    if(/^END:VCARD/i.test(l)){if(cur)out.push(cur);cur=null;return}
    if(!cur)return;
    var i=l.indexOf(':');if(i<0)return;
    var k=l.slice(0,i).split(';')[0].toUpperCase().replace(/^ITEM\d+\./,''),v=l.slice(i+1).trim();
    if(k==='FN'&&v)cur.name=v;
    else if(k==='N'&&!cur.name){var p=v.split(';');cur.name=((p[1]||'')+' '+(p[0]||'')).trim()}
    else if(k==='TEL'&&!cur.phone)cur.phone=v;
    else if(k==='EMAIL'&&!cur.email)cur.email=v;
    else if(k==='ORG'&&!cur.group)cur.group=v.replace(/;/g,' ').trim();
    else if(k==='NOTE'&&!cur.notes)cur.notes=v;
  });
  return out;
}
function mkImport(file){
  var rd=new FileReader();
  rd.onload=function(){
    try{
      var t=String(rd.result||''),raw=/BEGIN:VCARD/i.test(t)?mkParseVcf(t):mkParseCsv(t),grp=file.name.replace(/\.[^.]+$/,'').replace(/^WhatsApp (Chat|Group) with /i,'').trim();
      var have={};mkItems.forEach(function(c){have[mkKey(c)]=1});
      var added=0,skipped=0,empty=0;
      raw.forEach(function(r){
        var c={id:mkId(),name:(r.name||'').trim(),phone:mkNorm(r.phone),email:(r.email||'').trim(),group:(r.group||'').trim()||grp,notes:(r.notes||'').trim(),consent:r.consent||'unknown',added:Date.now()};
        if(!c.name&&!c.phone&&!c.email){empty++;return}
        var k=mkKey(c);if(have[k]){skipped++;return}
        have[k]=1;mkItems.push(c);added++;
      });
      if(added)mkSave();
      mkList();
      toast('Imported '+added+' contact'+(added===1?'':'s')+(skipped?', skipped '+skipped+' duplicate'+(skipped===1?'':'s'):'')+(empty?', ignored '+empty+' empty row'+(empty===1?'':'s'):'')+(added?'. Consent is set to Unknown.':''),true);
    }catch(x){toast('That file could not be read as contacts.')}
  };
  rd.readAsText(file);
}
function mkExport(){
  var l=mkFiltered(),q=function(v){v=String(v==null?'':v);return /[",\n\r]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};
  var rows=[['Name','Phone','Email','Group','Consent','Notes','Added'].join(',')];
  l.forEach(function(c){rows.push([c.name,c.phone,c.email,c.group,MK_LABEL[c.consent||'unknown'],c.notes,c.added?new Date(c.added).toISOString().slice(0,10):''].map(q).join(','))});
  var blob=new Blob(['﻿'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download='marketing-contacts-'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},500);
  toast('Exported '+l.length+' contact'+(l.length===1?'':'s'));
}
function mkSendBox(c){
  var w=mkWa(c),h='<div class="mksend"><b>Send a message</b><div class="muted" style="font-size:12px;margin:2px 0 8px">'+(w||c.email?'Pick a message. It opens in WhatsApp or your email app, filled in and ready to send. Check consent first.':'Add a phone number or email to send a message.')+'</div>';
  mkTpls().forEach(function(m){
    var t=mkFill(m.text,c),pv=t.replace(/\s+/g,' ').slice(0,150)+(t.length>150?'\u2026':'');
    h+='<div class="mksm"><div class="mkch"><b>'+esc(m.title)+'</b></div><div class="muted" style="font-size:12px;margin-bottom:6px">'+esc(pv)+'</div><div>'+
      (w?'<a class="mklink wa" href="'+esc(w+'?text='+encodeURIComponent(t))+'" target="_blank" rel="noopener noreferrer">WhatsApp</a>':'')+
      (c.email?'<a class="mklink em" href="mailto:'+esc(c.email)+'?subject='+encodeURIComponent(m.subject||m.title)+'&body='+encodeURIComponent(t.replace(/\n/g,'\r\n'))+'">Email</a>':'')+'</div></div>';
  });
  return h+'</div>';
}
function mkOpen(id){
  var c=mkItems.filter(function(x){return x.id===id})[0]||{},ov=document.createElement('div');
  mkEditId=id||null;ov.id='mkOv';ov.className='mkov';
  ov.innerHTML='<div class="mkpanel" role="dialog" aria-label="Contact"><h2>'+(id?'Edit contact':'Add contact')+'</h2>'+
   '<label class="f">Name<input id="mkf-name" value="'+esc(c.name||'')+'"></label><label class="f">Phone<input id="mkf-phone" inputmode="tel" value="'+esc(c.phone||'')+'"></label>'+(id&&mkWa(c)?'<div class="mkrow"><a class="mklink wa" href="'+esc(mkWa(c))+'" target="_blank" rel="noopener noreferrer">WhatsApp</a></div>':'')+'<label class="f">Email<input id="mkf-email" type="email" value="'+esc(c.email||'')+'"></label>'+(id&&c.email?'<div class="mkrow"><a class="mklink em" href="mailto:'+esc(c.email)+'">Email</a></div>':'')+'<label class="f">Group or source<input id="mkf-group" value="'+esc(c.group||'')+'"></label>'+
   '<label class="f">Consent<select id="mkf-consent"><option value="unknown"'+((c.consent||'unknown')==='unknown'?' selected':'')+'>Unknown</option><option value="yes"'+(c.consent==='yes'?' selected':'')+'>Opted in</option><option value="no"'+(c.consent==='no'?' selected':'')+'>Opted out</option></select></label><label class="f">Notes<textarea id="mkf-notes" rows="3">'+esc(c.notes||'')+'</textarea></label>'+
   (id?mkSendBox(c):'')+'<div class="mkact"><button type="button" class="btn" data-mksave="1">Save</button><button type="button" class="btn ghost" data-mkcancel="1">Cancel</button>'+(id?'<button type="button" class="btn ghost" id="mkDel" data-mkdel="1" style="margin-left:auto">Delete</button>':'')+'</div></div>';
  document.body.appendChild(ov);setTimeout(function(){var f=$('#mkf-name');if(f)f.focus()},30);
}
function mkClose(){var o=$('#mkOv');if(o)o.remove();mkEditId=null}
function mkSaveForm(){
  var g=function(i){return ($('#mkf-'+i).value||'').trim()},c={name:g('name'),phone:mkNorm(g('phone')),email:g('email'),group:g('group'),notes:g('notes'),consent:$('#mkf-consent').value};
  if(!c.name&&!c.phone&&!c.email){toast('Add a name, phone or email');return}
  if(mkEditId){mkItems=mkItems.map(function(x){return x.id===mkEditId?Object.assign({},x,c):x})}
  else mkItems.push(Object.assign({id:mkId(),added:Date.now()},c));
  mkSave();mkClose();mkList();toast('Saved');
}

/* ---------- marketing messages ---------- */
var MK_SIG='Atik Raza\nMortgage and Protection Adviser\nMobile: 07722223199',
    MK_FOOT='Your home may be repossessed if you do not keep up repayments on your mortgage.\nIf you would rather I did not message you, just reply STOP.';
var MK_DEFAULTS=[
 {id:'d1',title:'Home purchase',subject:'Helping with your home purchase',text:"Assalamu Alaikum,\n\nI hope you and your family are well, insha'Allah.\n\nI am Atik, a mortgage adviser. If you are thinking about buying a home, whether it is your first or your next, I would be glad to help with your options, what you may be able to borrow, and each step from start to finish.\n\nThere is no obligation. Just message me back or call me for a friendly, no-pressure chat.\n\nJazakAllah khair.\n\n"+MK_SIG+"\n\n"+MK_FOOT},
 {id:'d2',title:'Remortgage',subject:'Is your mortgage deal ending soon?',text:"Assalamu Alaikum,\n\nI hope you are well, insha'Allah.\n\nIf your fixed rate or mortgage deal is due to end in the next 6 to 12 months, now is a good time to look at your options. If you do nothing, you may move onto your lender's standard variable rate, which is often higher.\n\nI am Atik, a mortgage adviser, and I would be happy to review your mortgage with you. There is no obligation.\n\nJust reply here and I will get back to you.\n\nJazakAllah khair.\n\n"+MK_SIG+"\n\n"+MK_FOOT},
 {id:'d3',title:'First-time buyer',subject:'Buying your first home',text:"Assalamu Alaikum,\n\nI hope this message finds you and your family in good health, insha'Allah.\n\nBuying a first home can feel overwhelming, and there is a lot to understand about deposits, affordability and the process. I am Atik, a mortgage adviser, and I help first-time buyers take it one step at a time.\n\nIf you or someone close to you is thinking about it, I would be glad to have a relaxed chat with no obligation.\n\nJazakAllah khair.\n\n"+MK_SIG+"\n\n"+MK_FOOT},
 {id:'d4',title:'Ask for a referral',subject:'Could you help someone you know?',text:"Assalamu Alaikum,\n\nI hope you and your family are well, insha'Allah.\n\nI am Atik, a mortgage adviser. Do you know a family member, friend or colleague who is looking to buy a home or remortgage? If so, I would be grateful if you could pass on my details, and I would be happy to help them.\n\nThank you for your time and support.\n\nJazakAllah khair.\n\n"+MK_SIG+"\n\n"+MK_FOOT},
 {id:'d5',title:'Gentle follow-up',subject:'Just following up',text:"Assalamu Alaikum,\n\nJust a quick note after my last message, in case it got lost. If a home purchase or remortgage is on your mind, I am happy to chat whenever suits you. No pressure at all.\n\nJazakAllah khair.\n\n"+MK_SIG+"\n\n"+MK_FOOT}
];
var mkMsgsDoc=null,mkTplId='',mkMsgEdit=null,mkDraft=null;
function mkTpls(){return mkMsgsDoc||MK_DEFAULTS}
function mkTplSave(list){mkMsgsDoc=list;return write('mkm',function(){return mkCol.doc('messages').set({items:list,updatedAt:Date.now()})})}
function mkFirst(c){var n=(c&&c.name||'').trim();return mkNamed(c)?n.split(/\s+/)[0]:''}
function mkFill(t,c){var f=mkFirst(c);return String(t||'').replace(/ ?\{name\}/g,f?' '+f:'')}
function mkTplCur(){return mkTpls().filter(function(x){return x.id===mkTplId})[0]||null}
function mkMsgs(){
  var box=$('#mkMsgs');if(!box)return;
  var l=mkDraft?[mkDraft].concat(mkTpls()):mkTpls();
  box.innerHTML='<div class="mknote">Messages start with a general greeting and do not use a name. (If you ever want one, type {name} where the first name should go.) On the Contacts tab, choose a message and the WhatsApp and Email buttons will open with it filled in. Each message includes the usual mortgage warning and a way to opt out.</div>'+
  '<div class="mkbar"><button type="button" class="btn" data-mkmnew="1">New message</button>'+(mkMsgsDoc?'<button type="button" class="btn ghost" data-mkmreset="1">Restore the standard messages</button>':'')+'</div>'+
  (l.length?l.map(function(m){
    if(mkMsgEdit===m.id)return '<div class="mkcard"><label class="f">Title<input id="mkm-title" value="'+esc(m.title)+'"></label><label class="f">Email subject<input id="mkm-subject" value="'+esc(m.subject||'')+'"></label><label class="f">Message<textarea id="mkm-text" rows="12">'+esc(m.text)+'</textarea></label><div class="mkact"><button type="button" class="btn" data-mkmsave="'+esc(m.id)+'">Save</button><button type="button" class="btn ghost" data-mkmcancel="1">Cancel</button><button type="button" class="btn ghost" data-mkmdel="'+esc(m.id)+'" style="margin-left:auto">Delete</button></div></div>';
    return '<div class="mkcard"><div class="mkch"><b>'+esc(m.title)+'</b><span class="muted">'+esc(m.subject||'')+'</span></div><pre class="mkpre">'+esc(m.text)+'</pre><div class="mkact"><button type="button" class="btn ghost sm" data-mkmcopy="'+esc(m.id)+'">Copy message</button><button type="button" class="btn ghost sm" data-mkmedit="'+esc(m.id)+'">Edit</button></div></div>';
  }).join(''):'<div class="muted">No messages. Use New message or Restore the standard messages.</div>');
}
function mkMsgAct(t){
  var g=function(a){var e=t.closest('['+a+']');return e?e.getAttribute(a):null},v;
  if(g('data-mkmnew')!==null){var id='c'+Date.now().toString(36);mkDraft={id:id,title:'New message',subject:'',text:"Assalamu Alaikum,\n\n\n\n"+MK_SIG+"\n\n"+MK_FOOT};mkMsgEdit=id;mkMsgs();return true}
  if(g('data-mkmreset')!==null){if(!window.confirm('Replace your messages with the standard ones?'))return true;mkMsgsDoc=null;write('mkm',function(){return mkCol.doc('messages').delete()});mkMsgEdit=null;mkMsgs();return true}
  if((v=g('data-mkmedit'))){mkMsgEdit=v;mkMsgs();return true}
  if(g('data-mkmcancel')!==null){mkMsgEdit=null;mkDraft=null;mkMsgs();return true}
  if((v=g('data-mkmsave'))){var ti=($('#mkm-title').value||'').trim()||'Message';var nm={id:v,title:ti,subject:($('#mkm-subject').value||'').trim(),text:$('#mkm-text').value},cur=mkTpls(),has=cur.some(function(m){return m.id===v});mkTplSave(has?cur.map(function(m){return m.id===v?nm:m}):[nm].concat(cur));mkDraft=null;mkMsgEdit=null;mkMsgs();toast('Message saved');return true}
  if((v=g('data-mkmdel'))){if(!t.classList.contains('armed')){t.classList.add('armed');t.textContent='Confirm delete';return true}if(mkDraft&&mkDraft.id===v){mkDraft=null;mkMsgEdit=null;mkMsgs();return true}mkTplSave(mkTpls().filter(function(m){return m.id!==v}));if(mkTplId===v)mkTplId='';mkMsgEdit=null;mkMsgs();toast('Message deleted');return true}
  if((v=g('data-mkmcopy'))){var m=mkTpls().filter(function(x){return x.id===v})[0];if(m){var txt=mkFill(m.text,null);if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).then(function(){toast('Message copied')},function(){toast('Could not copy')});else toast('Could not copy')}return true}
  return false;
}

/* ---------- birthdays ---------- */
var bdFilter='week',bdQuery='',bdOpen={},bdDraft={},bdTplOpen=false;
var BD_MSGS=['Happy Birthday {name}! 🎂🎉 Wishing you a wonderful day filled with joy, laughter and all your favourite things. May the year ahead bring you good health, happiness and lots of lovely surprises.','Dear {name}, wishing you a very happy birthday! 🎈 I hope today is full of smiles, good company and a little bit of cake. Here\'s to a fantastic year ahead!','Happy Birthday {name}! 🥳 Thinking of you today and hoping you have a lovely, relaxing day with the people who matter most to you.','Many happy returns, {name}! 🎁 May your day be as special as you are, and may the coming year bring you everything you wish for.','Hi {name}, just a quick note to wish you a very happy birthday! 🌟 I hope you\'re spoiled rotten today. Enjoy every moment!','Happy Birthday {name}! 🎂 Wishing you health, happiness and success in the year ahead. Have a truly wonderful day!','Warmest birthday wishes to you, {name}! 🌸 May this new year of life bring you peace, prosperity and plenty of reasons to celebrate.','Happy Birthday {name}! 🎉 Hope your day is packed with good food, good company and lots of laughter. You deserve it!','Hello {name}, sending you my very best wishes on your birthday! 💐 May it be the start of a brilliant year for you and your family.','Happy Birthday {name}! 🥂 Here\'s to another great year. Wishing you a day full of love, laughter and wonderful surprises.','Wishing you a fantastic birthday, {name}! 🎈 Take time to enjoy today. You deserve a day that\'s all about you!','Happy Birthday {name}! ☀️ I hope today brings you plenty of joy and that the year ahead is your best yet.','Dear {name}, happy birthday! 🎂 Thank you for being a valued client. Wishing you a wonderful day and a happy, healthy year ahead.','Happy Birthday {name}! 🌹 May your day be filled with love and your year with happy moments. Enjoy every minute!','Wishing you the happiest of birthdays, {name}! 🎊 May all your wishes come true today and throughout the year ahead.'];
var BD_SIG='Warmest wishes,\nAtik Raza\nMortgage and Protection Adviser';
var bdCfg={messages:null,signature:null,islamic:null},bdShuf={};
var BD_ISL=['Assalamu alaikum {name}! 🌙 Wishing you a very happy and blessed birthday. May Allah grant you good health, happiness and barakah in everything you do this year. Ameen.','Assalamu alaikum {name}, many happy returns! 🤲 May Allah bless you with a long, healthy life filled with joy, peace and success, and keep you and your family safe. Ameen.','Happy Birthday {name}! ✨ Barakallahu feek. May Allah make this coming year your best yet, fill your home with happiness and grant you ease in all your affairs.','Assalamu alaikum {name}. Sending you warm birthday wishes today. May Allah shower you with His mercy, protect you and your loved ones, and bless every day of the year ahead. 🌟','Dear {name}, Assalamu alaikum and happy birthday! 🎂 May Allah grant you good health, a blessed income and happiness for you and your family. Ameen.','Happy Birthday {name}! Alhamdulillah for another year. May Allah fill it with barakah, good health and good news. Wishing you and your family all the best. 🤍','Assalamu alaikum {name}! 🌸 Wishing you a lovely birthday. May Allah bless you with peace of heart, success and many more healthy years ahead. Ameen.','Warm birthday wishes {name}! 🌙 May Allah accept your good deeds, guide you, and grant you and your family happiness and ease in the year ahead.','Assalamu alaikum {name}, wishing you a happy birthday! May Allah protect you, bless your family and your home, and make the year ahead full of khayr. Jazakallah khair for being a valued client. 🤲','Happy Birthday {name}! 🎈 Barakallahu fee umrik. May Allah bless your life and give you good health, happiness and success always.'];
var BD_MUS_SET={};('mohammed muhammad mohammad mohamed mohamad mohd md mahmoud mahmood mehmood mahmud mahmuda hamza hamzah ibrahim ismail ismael yusuf yousuf yusuff usman uthman umar omar abdullah abdul abdur abdel abu bilal imran tariq kamran salman saeed saleem salim nadeem naeem shahid zahid zahidur jamal kamal kabir karim rashid rasheed rafiq rafique shafiq shafique anwar aslam arif asif adnan faisal farooq faruk habib harun haroon idris ilyas jahangir junaid khalid khalil masud masood mustafa nasir noor nur rizwan sadiq shoaib suleman sulaiman waseem wasim zubair zakaria zakir ahmed ahmad ahamed ali hussain hussein hossain hosen hassan hasan rahman rehman islam alam haque hoque huq siddiqui siddique sheikh shaikh syed sayed sayyid iqbal hafiz mirza qureshi malik butt ansari khan begum bibi khatun khanom akhter akhtar akter aktar miah mia mian uddin ullah sultana nasreen parveen perveen yasmin yasmeen fatima fatema fatimah aisha ayesha aysha khadija khadijah maryam mariam zainab zaynab amina aminah rabia ruqayya sumaiya sumayya samira salma jannat rahima rokeya rubina tahmina nazma nazneen shamsun shamim shamima ashraful mizanur rafiqul nazrul'.split(' ')).forEach(function(w){BD_MUS_SET[w]=1});
function bdMuslim(nm){
  return String(nm||'').toLowerCase().split(/[^a-z]+/).filter(Boolean).some(function(w){
    return BD_MUS_SET[w]||/^(abdul|abdur|abdel|mohamm|muham|mohd)/.test(w)||/(uddin|uddeen|ullah)$/.test(w);
  });
}
var bdGen={};
var BD_FEM={};('jerin thania shumaya husneara fatema-tuz nipa mitu ria rima shapla popy poly lucky happy nilufa nilufar rumana rumi shilpi lipi fatima fatema fatimah fatma aisha ayesha aysha ayisha khadija khadijah khodeja maryam mariam mary zainab zaynab zeinab sana sara sarah amina aminah asma halima hajra hina nadia nadiya nasreen nasrin nazia nazma nazneen parveen perveen rubina sabina shabana shahida shazia sultana yasmin yasmeen zahra zara rehana rukhsana razia rashida salma samira sania sobia sadia sonia tahira tasneem uzma farzana farida fouzia fozia jannat rahima rokeya ruksana rabia ruqayya ruqayyah sumaiya sumayya sumaya tahmina shamima shamsun shahnaz shahina shirin shiren sharmin sharmeen sultana jesmin jasmin laila laylah lubna madiha maheen mahnoor mehreen mehwish misbah naila nargis noreen nusrat rizwana robina roksana saima sajida shaheen sidra sumi tamanna tania tanzila umme uzma yasmina zakia zarina zubaida zeenat bushra anisa anika hafsa hafsah iqra insha kulsum kalsoom kauser kishwar maliha momina munira nafisa naseem nazira parvin rahena rehena ruma selina shakila shamim sharifa suraiya sultana tahera '.trim().split(/\s+/)).forEach(function(w){BD_FEM[w]=1});
var BD_MALE={};('ijaz korban kurban foyjul foysal foyez ehsan ihsan ikram inam ilyaas imtiaz jamil jashim jakir kader kalam kaium khokon mamunur mannan matin mofiz motin nurul nazmul rashed rubel salauddin selim shahed shahidul tofazzul tuhin mohammed muhammad mohammad mohamed mohamad mohd md mahmoud mahmood mehmood mahmud hamza hamzah ibrahim ismail ismael yusuf yousuf yusuff usman uthman umar omar abdullah abdul abdur abdel abu bilal imran tariq kamran salman saeed saleem salim nadeem naeem shahid zahid jamal kamal kabir kobir karim rashid rasheed rafiq rafique shafiq shafique anwar aslam arif asif adnan faisal farooq faruk forhad habib harun haroon idris ilyas jahangir junaid khalid khalil masud masood mustafa nasir rizwan sadiq shoaib suleman sulaiman waseem wasim zubair zakaria zakir ahmed ahmad ahamed ali hussain hussein hossain hosen hassan hasan iqbal hafiz mirza sardar shorif sharif rahim rubel sohel monir sumon tanvir masum jahid mizan mizanur ashraful rafiqul nazrul osama usama talha yahya yaqub yacub zain zayn ayaan arman aziz amir ameen amin ashiq ashik babul belal billal dilwar enam farhan fahim fazal gulzar harris haris hanif jabir jalal javed jawad kaiser kashif liaquat luqman majid manzoor mamun masud mehdi mohsin mubarak muzammil nawaz obaid raihan rayhan ramzan rony saif shabir shafi shakil shamim shamsul shuvo siraj sultan tahir taslim tauhid wahid yasin younis zahir zia'.trim().split(/\s+/)).forEach(function(w){BD_MALE[w]=1});
function bdGuess(nm){
  var toks=String(nm||'').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  if(!toks.length)return '';
  if(toks[0]==='mr')return 'm';
  if(/^(mrs|miss|ms)$/.test(toks[0]))return 'f';
  var f=toks.filter(function(w){return !/^(mr|mrs|miss|ms|dr)$/.test(w)})[0]||'';
  if(BD_FEM[f])return 'f';
  if(BD_MALE[f]||/^(abdul|abdur|abdel|mohamm|muham|mohd)/.test(f)||/(uddin|uddeen|ullah)$/.test(f))return 'm';
  if(toks.some(function(w){return /^(begum|khatun|bibi|banu|khanom|nessa)$/.test(w)}))return 'f';
  return '';
}
function bdGender(p){return bdGen[p.key]||bdGuess(p.name)}
function bdGenBtns(p){
  var g=bdGender(p);
  return '<span class="bdgenw" role="group" aria-label="Address as"><button type="button" class="btn ghost bdgen" data-bdgen="'+esc(p.key)+'|m" aria-pressed="'+(g==='m')+'">Brother</button><button type="button" class="btn ghost bdgen" data-bdgen="'+esc(p.key)+'|f" aria-pressed="'+(g==='f')+'">Sister</button></span>';
}
var bdKind={};
function bdMode(p){return bdKind[p.key]||(p.muslim?'isl':'gen')}
function bdIsl(){return (bdCfg.islamic&&bdCfg.islamic.length)?bdCfg.islamic:BD_ISL}
function bdList(p){return bdMode(p)==='isl'?bdIsl():bdMsgs()}

function bdMsgs(){return (bdCfg.messages&&bdCfg.messages.length)?bdCfg.messages:BD_MSGS}
function bdSig(){return bdCfg.signature!=null?bdCfg.signature:BD_SIG}
function bdHash(t){var h=0;for(var i=0;i<t.length;i++)h=(h*31+t.charCodeAt(i))>>>0;return h}
function bdPick(p){var l=bdList(p);return bdHash(p.slug+'|'+p.year+'|'+(bdShuf[p.key]||0))%l.length}
function bdFirst(nm){var t=String(nm||'').trim().split(/\s+/).filter(Boolean);while(t.length>1&&/^(mr|mrs|miss|ms|dr|md|mohd)\.?$/i.test(t[0]))t.shift();var f=t[0]||'';return f.charAt(0).toUpperCase()+f.slice(1).toLowerCase()}
function bdSlug(nm){return String(nm||'').toLowerCase().replace(/[^a-z0-9]/g,'')}
function bdIntl(ph){var d=String(ph||'').replace(/[^\d+]/g,'');if(d.replace(/\D/g,'').length<7)return '';return d.charAt(0)==='+'?d.slice(1):d.charAt(0)==='0'?'44'+d.slice(1):d}
function bdLeap(y){return (y%4===0&&y%100!==0)||y%400===0}
function bdPeople(){
  var map={},withDob={},noDob={};
  cases.forEach(function(c){(c.applicants||[]).forEach(function(a){
    var nm=String(a.name||'').trim();if(!nm)return;
    var nk=nm.toLowerCase().replace(/\s+/g,' ');
    if(!a.dob||!/^\d{4}-\d{2}-\d{2}$/.test(a.dob)){noDob[nk]=1;return}
    withDob[nk]=1;
    var key=nk+'|'+a.dob,p=map[key]||(map[key]={key:key,name:nm,dob:a.dob,phone:'',cases:[]});
    if(!p.phone&&a.phone)p.phone=a.phone;
    p.cases.push(c);
  })});
  var list=Object.keys(map).map(function(k){
    var p=map[k],m=+p.dob.slice(5,7),d=+p.dob.slice(8,10),y=TODAY.getFullYear();
    var occ=function(yr){return (m===2&&d===29&&!bdLeap(yr))?new Date(yr,1,28):new Date(yr,m-1,d)};
    var n=occ(y);if(n<TODAY)n=occ(y+1);
    p.next=n;p.days=Math.round((n-TODAY)/864e5);p.age=n.getFullYear()-(+p.dob.slice(0,4));
    p.slug=bdSlug(p.name);p.year=n.getFullYear();p.muslim=bdMuslim(p.name);
    p.sent=p.cases.some(function(c){return c.bdaySent&&c.bdaySent[p.slug]===p.year});
    return p;
  }).sort(function(a,b){return a.days-b.days||a.name.localeCompare(b.name)});
  var missing=Object.keys(noDob).filter(function(k){return !withDob[k]}).length;
  return {list:list,missing:missing};
}
function bdCounts(list){var c={today:0,week:0,month:0,all:list.length};list.forEach(function(p){if(p.sent)return;if(p.days===0)c.today++;if(p.days<=7)c.week++;if(p.days<=30)c.month++});return c}
function bdMessage(p){if(bdDraft[p.key]!=null)return bdDraft[p.key];var isl=bdMode(p)==='isl',g=isl?bdGender(p):'',who=g==='m'?'brother':g==='f'?'sister':bdFirst(p.name),t=bdList(p)[bdPick(p)].replace(/\{name\}/g,who),sg=bdSig().trim();if(isl&&g==='f')t=t.replace(/\bfeek\b/g,'feeki');return sg?t+'\n\n'+sg:t}
function bdShell(){
  return '<div class="pagehead"><h1>Birthdays</h1><span class="muted">Send a birthday message with one click</span></div><div id="bdTplBox"></div><div class="filters" style="margin:10px 0"><input type="search" id="bdQ" class="search" style="width:100%" placeholder="Search by name" aria-label="Search birthdays" value="'+esc(bdQuery)+'"></div><div id="bdChips" class="chips" style="margin:10px 0"></div><div id="bdList"></div>';
}
function bdTplRender(){
  var b=$('#bdTplBox');if(!b)return;
  b.innerHTML=bdTplOpen?'<div class="bdc" style="border-left-color:var(--accent)"><b>Birthday messages</b><div class="muted" style="font-size:12px;margin:2px 0 6px">'+bdMsgs().length+' messages. Each client is given one of them automatically (standard greetings). Write {name} where the first name goes, and put a line with --- between messages.</div><textarea id="bdMsgsText" rows="14">'+esc(bdMsgs().join('\n---\n'))+'</textarea><div class="muted" style="font-size:12px;margin:8px 0 2px">Signature, added at the end of every message</div><textarea id="bdSigText" rows="3">'+esc(bdSig())+'</textarea><div class="muted" style="font-size:12px;margin:10px 0 2px">Islamic greetings ('+bdIsl().length+'). Used first for clients whose names suggest they may be Muslim. Write {name} where "brother" or "sister" should go (chosen from the name, and you can change it on each client). Same format, with --- between messages.</div><textarea id="bdIslText" rows="10">'+esc(bdIsl().join('\n---\n'))+'</textarea><div class="add" style="margin-top:8px"><button type="button" class="btn" id="bdTplSave">Save</button><button type="button" class="btn ghost" id="bdTplReset">Reset to the standard messages</button><button type="button" class="btn ghost" id="bdTplBtn">Close</button></div></div>':'<button type="button" class="btn ghost sm" id="bdTplBtn">Edit messages and signature</button>';
}
function bdDobText(p){var y=+p.dob.slice(0,4),d=new Date(y,+p.dob.slice(5,7)-1,+p.dob.slice(8,10));return d.toLocaleDateString('en-GB',y>=1900&&y<=TODAY.getFullYear()?{day:'numeric',month:'short',year:'numeric'}:{day:'numeric',month:'short'})}
function bdSentAt(p){var t=0;p.cases.forEach(function(c){if(c.bdaySent&&c.bdaySent[p.slug]===p.year&&c.bdaySentAt&&c.bdaySentAt[p.slug]>t)t=c.bdaySentAt[p.slug]});return t}
function bdItem(p){
  var intl=bdIntl(p.phone),open=bdOpen[p.key]!==undefined?bdOpen[p.key]:p.days<=7;
  var when=p.days===0?'Today':p.days===1?'Tomorrow':p.next.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});
  var meta=[when+(p.days>1?' · in '+p.days+' days':''),(p.age>=16&&p.age<=110?'turns '+p.age:''),p.phone?esc(p.phone):'no phone number'].filter(Boolean).join(' · ');
  var c0=p.cases.slice().sort(function(a,b){return (b.updatedAt||0)-(a.updatedAt||0)})[0],sa=p.sent?bdSentAt(p):0;
  var h='<div class="bdc'+(p.sent?' sent':'')+'" data-bdkey="'+esc(p.key)+'"><div class="bdh"><div><b>'+esc(p.name)+'</b> <span class="muted" style="font-size:13px">🎂 '+esc(bdDobText(p))+'</span>'+(p.sent?'<span class="bdok">✓ Sent'+(sa?' '+shortStamp(sa):'')+'</span>':'')+'</div><div class="muted" style="font-size:12px">'+meta+' · <button type="button" class="lnk" data-open="'+c0.id+'">'+(c0.clientNo?esc(c0.clientNo):'open case')+'</button></div></div>';
  if(!open)return h+'<div class="add" style="margin-top:6px"><button type="button" class="btn ghost sm" data-bdopen="'+esc(p.key)+'">Write message</button><label class="bdchk"><input type="checkbox" data-bdchk="'+esc(p.key)+'"'+(p.sent?' checked':'')+'> Sent</label></div></div>';
  var isl=bdMode(p)==='isl',tip=isl&&p.muslim&&!bdKind[p.key]?'<div class="muted" style="font-size:12px;margin:4px 0">Suggested: Islamic greeting, chosen from the name. Check it suits this client, or switch to the standard greeting.</div>':'';if(isl&&!bdGender(p))tip+='<div style="font-size:12px;margin:4px 0;color:#8A5A00">Choose Brother or Sister below. The name does not show which, so the first name is used until you pick.</div>';
  return h+tip+'<textarea data-bdmsg="'+esc(p.key)+'" rows="7" aria-label="Birthday message for '+esc(p.name)+'">'+esc(bdMessage(p))+'</textarea><div class="add" style="margin-top:6px">'+
    (intl?'<button type="button" class="btn bdwa" data-bdsend="'+esc(p.key)+'">Send on WhatsApp</button>':'<span class="muted" style="align-self:center;font-size:12px">Add a phone number to the case to send on WhatsApp.</span>')+
    (isl?bdGenBtns(p):'')+'<button type="button" class="btn ghost" data-bdkind="'+esc(p.key)+'">'+(isl?'Use standard greeting':'Use Islamic greeting')+'</button><button type="button" class="btn ghost" data-bdshuf="'+esc(p.key)+'" title="Pick a different message">Another message</button><button type="button" class="btn ghost" data-bdcopy="'+esc(p.key)+'">Copy message</button><label class="bdchk"><input type="checkbox" data-bdchk="'+esc(p.key)+'"'+(p.sent?' checked':'')+'> Sent</label>'+(bdOpen[p.key]!==undefined&&p.days>7?'<button type="button" class="btn ghost sm" data-bdopen="'+esc(p.key)+'">Hide</button>':'')+'</div></div>';
}
function bdRender(){
  var box=$('#bdList');if(!box)return;
  var ae=document.activeElement;if(ae&&ae.matches&&ae.matches('[data-bdmsg]'))return;
  var r=bdPeople(),cnt=bdCounts(r.list),q=bdQuery.trim().toLowerCase();
  var chips=[['today','Today'],['week','Next 7 days'],['month','Next 30 days'],['all','All']];
  $('#bdChips').innerHTML=chips.map(function(c){return '<button type="button" data-bdf="'+c[0]+'" aria-pressed="'+(bdFilter===c[0])+'">'+c[1]+' '+cnt[c[0]]+'</button>'}).join('');
  var max={today:0,week:7,month:30,all:400}[bdFilter];
  var items=r.list.filter(function(p){return p.days<=max&&(!q||p.name.toLowerCase().indexOf(q)>-1)});
  var h='';
  if(!r.list.length)h='<div class="empty"><h2>No birthdays yet</h2>Birthdays come from the date of birth saved on each client. Add dates of birth to the cases and they will appear here.</div>';
  else if(!items.length)h='<div class="empty">Nobody has a birthday in this period.</div>';
  else{
    var groups=[['Today',function(p){return p.days===0}],['Next 7 days',function(p){return p.days>0&&p.days<=7}],['Next 30 days',function(p){return p.days>7&&p.days<=30}],['Later',function(p){return p.days>30}]];
    groups.forEach(function(g){var gi=items.filter(g[1]);if(!gi.length)return;h+='<div class="tgh">'+g[0]+' · '+gi.length+'</div>'+gi.map(bdItem).join('')});
  }
  if(r.missing)h+='<p class="muted" style="margin-top:14px">'+r.missing+' client'+(r.missing===1?' has':'s have')+' no date of birth saved, so they cannot appear here.</p>';
  box.innerHTML=h;
}
function bdFind(key){return bdPeople().list.filter(function(p){return p.key===key})[0]}
function bdText(p){var ta=document.querySelector('[data-bdmsg="'+(window.CSS&&CSS.escape?CSS.escape(p.key):p.key)+'"]');return ta?ta.value:bdMessage(p)}
function bdSetSent(p,on){
  var jobs=[];
  p.cases.forEach(function(c){
    var o=Object.assign({},c.bdaySent||{}),at=Object.assign({},c.bdaySentAt||{});
    if(on){if(c!==p.cases[0])return;o[p.slug]=p.year;at[p.slug]=Date.now()}
    else{if(o[p.slug]!==p.year)return;delete o[p.slug];delete at[p.slug]}
    jobs.push([c,{bdaySent:o,bdaySentAt:at}]);
  });
  jobs.forEach(function(j){patch(j[0].id,j[1])});
}
function bdBanner(){
  var b=$('#bdBanner');if(!b)return;
  var c=bdCounts(bdPeople().list);
  b.innerHTML=(c.today||c.week)?'<div class="bdban"><b>🎂 Birthdays</b><span>'+(c.today?c.today+' today':'none today')+' · '+c.week+' in the next 7 days</span><button type="button" class="btn sm" data-bdgo="1" style="margin-left:auto">Send birthday messages</button></div>':'';
}
function shortStamp(ts){return new Date(ts).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
var editNote=null,editTk=null;
function tkKey(t){return (t.due||'9999-99-99')+' '+(t.time||'99:99')}
function tkEditor(k,t){return '<div class="tkedit" data-tkbox="'+k+'"><input type="text" data-tkf="text" value="'+esc(t.text)+'" aria-label="Task"><input type="date" data-tkf="due" value="'+esc(t.due||'')+'" aria-label="Due date"><input type="time" data-tkf="time" value="'+esc(t.time||'')+'" aria-label="Time"><label class="prichk"><input type="checkbox" data-tkf="pri"'+(t.pri?' checked':'')+'> High priority</label><button type="button" class="btn" data-tkesave="'+k+'">Save</button><button type="button" class="btn ghost" data-tkecancel="1">Cancel</button></div>'}
function rerenderTasks(){if(openId)renderLive();if($('#trList'))renderTray();renderSide()}
function noteItem(n,list,suffix,fmt){
  var head=stampOf(n.ts)+suffix+(n.edited?' · edited '+shortStamp(n.edited):'');
  if(editNote&&editNote.list===list&&editNote.ts===n.ts)
    return '<div class="note"><small>'+head+'</small><textarea id="ntEdit" class="nbb" style="min-height:140px" aria-label="Edit note">'+esc(n.text||'')+'</textarea><div class="add"><button type="button" class="btn" id="ntEditSave">Save changes</button><button type="button" class="btn ghost" id="ntEditCancel">Cancel</button></div>'+tblBlock(n,list)+'</div>';
  return '<div class="note"><small>'+head+' <button type="button" class="btn ghost sm" data-nedit="'+list+'|'+n.ts+'" style="margin-left:8px">Edit</button></small>'+fmt(n.text)+tblBlock(n,list)+'</div>';
}
var colOpen={};
/* ---------- connected clients ---------- */
var curLinks=[],lkOpen=false;
var REL_OPTS=['Spouse / partner','Parent','Child','Grandparent','Grandchild','Sibling','Other relative','Friend','Colleague','Business partner','Employer','Employee','Referred by','Referred client','Other'];
var REL_INV={'Spouse / partner':'Spouse / partner','Parent':'Child','Child':'Parent','Grandparent':'Grandchild','Grandchild':'Grandparent','Sibling':'Sibling','Other relative':'Other relative','Friend':'Friend','Colleague':'Colleague','Business partner':'Business partner','Employer':'Employee','Employee':'Employer','Referred by':'Referred client','Referred client':'Referred by','Other':'Other'};
function lkById(id){return cases.filter(function(x){return x.id===id})[0]}
function nkey(c){return names(c).toLowerCase()}
function lkGroup(c){if(!c)return[];var k=nkey(c);return cases.filter(function(x){return nkey(x)===k})}
function lkIds(g){var o={};g.forEach(function(x){o[x.id]=1});return o}
function lkEdges(){
  var me=currentCase(),g=me?lkGroup(me):[],gids=lkIds(g),seen={},list=[];
  function add(o,rel){if(!o||gids[o.id]||o.id===openId)return;var k=nkey(o);if(seen[k])return;seen[k]=1;list.push({o:o,rel:rel})}
  curLinks.forEach(function(l){add(lkById(l.cid),l.rel)});
  g.forEach(function(x){if(x.id===openId)return;(x.links||[]).forEach(function(l){add(lkById(l.cid),l.rel)})});
  cases.forEach(function(x){if(gids[x.id])return;(x.links||[]).forEach(function(l){if(gids[l.cid])add(x,REL_INV[l.rel]||l.rel)})});
  return list;
}
function lkSave(){if(openId)patch(openId,{links:curLinks.map(function(l){return {id:l.id,cid:l.cid,rel:l.rel}})})}
function lkDrop(target){
  if(!target)return;
  var me=currentCase(),mg=me?lkGroup(me):[],mids=lkIds(mg),tg=lkGroup(target),tids=lkIds(tg);
  curLinks=curLinks.filter(function(l){return !tids[l.cid]});
  mg.forEach(function(x){if(x.id===openId)return;var n=(x.links||[]).filter(function(l){return !tids[l.cid]});if(n.length!==(x.links||[]).length)patch(x.id,{links:n})});
  tg.forEach(function(x){var n=(x.links||[]).filter(function(l){return !mids[l.cid]});if(n.length!==(x.links||[]).length)patch(x.id,{links:n})});
  lkSave();
}
function lkSet(target,rel){
  if(!target)return;lkDrop(target);
  var tg=lkGroup(target).sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0)})[0]||target;
  curLinks.push({id:Math.random().toString(36).slice(2,9),cid:tg.id,rel:rel});lkSave();
}
function lkCaseLine(x){
  var bits=[STAGE_LABEL[x.stage]||x.stage||'',x.type||'',x.lender||'',x.loanAmount?money(x.loanAmount):'',x.fixedUntil?'rate ends '+fd(x.fixedUntil):''].filter(Boolean);
  return '<div class="lkc">'+bits.map(esc).join(' · ')+'</div>';
}
function lkActivity(g){
  var tk=0,nn=0,last=null;
  g.forEach(function(x){(x.tasks||[]).forEach(function(t){if(!t.done)tk++});(x.notes||[]).forEach(function(n){nn++;if(!last||(n.ts||0)>(last.ts||0))last=n})});
  var s=tk+' open task'+(tk===1?'':'s')+' · '+nn+' note'+(nn===1?'':'s');
  if(last)s+=' · latest '+new Date(last.ts||0).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'})+': '+String(last.text||'').replace(/\s+/g,' ').slice(0,90);
  return s;
}
function renderLinks(){
  var box=document.getElementById('linksBox');if(!box)return;
  var ed=lkEdges(),me=currentCase(),mids=lkIds(me?lkGroup(me):[]),taken={};
  ed.forEach(function(e){taken[nkey(e.o)]=1});
  var opts={};cases.forEach(function(x){var k=nkey(x);if(mids[x.id]||x.id===openId||taken[k]||k==='unnamed client')return;opts[names(x)]=1});
  var h=ed.map(function(e){
    var g=lkGroup(e.o).sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0)});
    return '<div class="lkrow"><div class="lkh"><button type="button" class="lnk" data-lkopen="'+e.o.id+'"><b>'+esc(names(e.o))+'</b></button>'+
      '<select data-lkrel="'+e.o.id+'" aria-label="Relationship">'+REL_OPTS.map(function(r){return '<option'+(r===e.rel?' selected':'')+'>'+esc(r)+'</option>'}).join('')+'</select>'+
      '<button type="button" class="btn ghost sm" data-lkdel="'+e.o.id+'">Remove</button></div>'+
      g.map(lkCaseLine).join('')+'<div class="muted lkact">'+esc(lkActivity(g))+'</div></div>';
  }).join('');
  if(!ed.length)h='<p class="muted" style="margin:0 0 8px">No connected clients yet.</p>';
  h+='<div class="lkadd"><input id="lkQ" list="lkDL" placeholder="Search client name" autocomplete="off"><select id="lkRel" aria-label="They are this client\'s">'+REL_OPTS.map(function(r){return '<option>'+esc(r)+'</option>'}).join('')+'</select><button type="button" class="btn sm" id="lkAdd">Add</button></div>'+
    '<datalist id="lkDL">'+Object.keys(opts).sort().map(function(n){return '<option value="'+esc(n)+'">'}).join('')+'</datalist>'+
    '<p class="muted" style="font-size:12px;margin:6px 0 0">Pick the client, then choose who they are to this client (for example Parent). The link shows on both records.</p>';
  box.innerHTML=h;
  var lt=document.getElementById('lkTitle');if(lt)lt.textContent='Connected clients ('+ed.length+')';
  box.style.display=lkOpen?'':'none';var tg=document.getElementById('lkToggle');if(tg){tg.textContent=lkOpen?'Hide':'Show';tg.setAttribute('aria-expanded',lkOpen?'true':'false')}
}
document.addEventListener('click',function(e){
  var t=e.target;if(!t||!t.closest)return;
  if(t.closest('#lkToggle')){lkOpen=!lkOpen;renderLinks();return}
  var b=t.closest('[data-lkopen]');
  if(b){e.preventDefault();var id=b.getAttribute('data-lkopen');if(openId&&document.getElementById('caseForm'))patch(openId,collectForm());openDrawer(id);return}
  b=t.closest('[data-lkdel]');
  if(b){if(!b.classList.contains('armed')){b.classList.add('armed');b.textContent='Confirm remove';return}lkDrop(lkById(b.getAttribute('data-lkdel')));renderLinks();setTimeout(renderLinks,200);toast('Connection removed');return}
  if(t.closest('#lkAdd')){
    var q=document.getElementById('lkQ'),r=document.getElementById('lkRel'),nm=((q&&q.value)||'').trim().toLowerCase();
    var me=currentCase(),mids=lkIds(me?lkGroup(me):[]);
    var cand=cases.filter(function(x){return nkey(x)===nm&&!mids[x.id]&&x.id!==openId});
    if(!nm||!cand.length){toast('Choose a client from the list');return}
    lkSet(cand[0],r.value);renderLinks();setTimeout(renderLinks,200);toast('Clients connected');
  }
});
document.addEventListener('change',function(e){var s=e.target;if(s&&s.hasAttribute&&s.hasAttribute('data-lkrel')){lkSet(lkById(s.getAttribute('data-lkrel')),s.value);renderLinks();setTimeout(renderLinks,200)}});

function decorateSecs(){
  var f=document.getElementById('caseForm');if(!f)return;
  var fs=f.querySelectorAll('fieldset');
  for(var i=0;i<fs.length;i++){
    var x=fs[i],lg=x.querySelector(':scope>legend');if(!lg||lg.querySelector('.colbtn'))continue;
    var t=(lg.firstChild&&lg.firstChild.nodeType===3?lg.firstChild.nodeValue:lg.textContent).replace(/\(\d+\)/,'').trim().toLowerCase();
    if(t.indexOf('applicants')===0){x.setAttribute('data-col','applicants');continue}
    if(x.id==='pickClient'||x.querySelector('#pickSel,#pcSel'))continue;
    x.setAttribute('data-col',t);
    var open=!!colOpen[t];x.classList.toggle('col-closed',!open);
    var b=document.createElement('button');b.type='button';b.className='btn ghost sm secbtn colbtn';b.setAttribute('data-coltoggle',t);b.textContent=open?'Hide':'Show';
    lg.appendChild(document.createTextNode(' '));lg.appendChild(b);
  }
}
function renderLive(){
  var box=$('#live');if(!box)return;
  if(!openId){var nb0=$('#liveNotes');if(nb0)nb0.innerHTML='';box.innerHTML='<fieldset><legend>Tasks and notes</legend><span class="muted">Save the case first, then add tasks and file notes here.</span></fieldset>';decorateSecs();return}
  var c=currentCase();if(!c)return;
  var ts=(c.tasks||[]).slice().sort(function(a,b){return (a.done?1:0)-(b.done?1:0)||((b.pri&&!b.done?1:0)-(a.pri&&!a.done?1:0))||(tkKey(a)<tkKey(b)?-1:tkKey(a)>tkKey(b)?1:0)});
  var ns=(c.notes||[]).slice().sort(function(a,b){return b.ts-a.ts});
  var tasksHtml='<fieldset><legend>Tasks</legend>'+
    (ts.length?ts.map(function(t){var tk0=c.id+'|'+t.id;if(editTk===tk0)return '<div class="task">'+tkEditor(tk0,t)+'</div>';return '<div class="task'+(t.done?' done':'')+(t.pri&&!t.done?' pri':'')+'"><input type="checkbox" data-tk="'+t.id+'"'+(t.done?' checked':'')+' aria-label="Done"><span class="t">'+esc(t.text)+'</span>'+(t.created?'<span class="muted" style="font-size:11px;white-space:nowrap">Added '+shortStamp(t.created)+'</span>':'')+(t.due?'<span class="chip '+(t.done?'':tone(t.due))+'">'+fd(t.due)+(t.time?' · '+esc(t.time):'')+'</span>':'')+'<button type="button" class="star'+(t.pri?' on':'')+'" data-tkpri="'+tk0+'" title="High priority" aria-label="Toggle high priority">'+(t.pri?'★':'☆')+'</button><button type="button" class="btn ghost sm" data-tkedit="'+tk0+'">Edit</button><button type="button" class="x" data-rmtk=""'+t.id+'" aria-label="Delete task">×</button></div>'}).join(''):'<span class="muted">No tasks yet.</span>')+
    '<div class="add"><input type="text" id="tkText" placeholder="Add a task, e.g. chase conveyancer" aria-label="New task"><input type="date" id="tkDue" aria-label="Due date"><input type="time" id="tkTime" aria-label="Time"><label class="prichk"><input type="checkbox" id="tkPri"> High priority</label><button type="button" class="btn ghost" id="tkAdd">Add task</button><button type="button" class="btn" id="tkBook">Book appointment</button></div></fieldset>';
  box.innerHTML=protFs(c);
  var nb=$('#liveNotes');if(nb)nb.innerHTML='<div style="margin-bottom:14px">'+tasksHtml+'</div><fieldset><legend>Notes ('+ns.length+')</legend><div class="add" style="margin:0 0 8px"><button type="button" class="btn ghost sm" id="ntHide">'+(notesHidden?'Show notes':'Hide notes')+'</button></div>'+
    (notesHidden?'<span class="muted">Notes hidden.</span>':'<label class="f">New note<textarea id="ntText" rows="3" placeholder="File note, call summary, next step. You can also paste a table from Excel">'+esc(ntDraft)+'</textarea></label><div class="muted" style="font-size:12px;margin:-4px 0 8px">Do not type NI numbers, bank details, passport numbers, income and expenditure, or health answers here.</div><div id="ntTblBox">'+pendHtml('nt')+'</div><div class="add"><button type="button" class="btn ghost" id="ntStamp">Insert date and time</button><button type="button" class="btn ghost" id="ntAdd">Add note</button></div>'+sugHtml()+
    (notesAll?ns:ns.slice(0,1)).map(function(n){return noteItem(n,'notes',(notesAll||ns.length<2?'':' (latest)'),paras)}).join('')+(ns.length>1?'<button type="button" class="btn ghost sm" id="ntAll">'+(notesAll?'Show latest only':'Show all '+ns.length+' notes')+'</button>':''))+'</fieldset>';
  decorateSecs();
}
var secHidden={};

function secFs(k,title){return '<fieldset data-sec="'+k+'"'+(secHidden[k]?' class="sec-hidden"':'')+'><legend>'+title+' <button type="button" class="btn ghost sm secbtn" data-sectoggle="'+k+'">'+(secHidden[k]?'Show':'Hide')+'</button></legend><div class="grid">'}
var notesHidden=false,notesAll=false,ntDraft='';

function stampOf(ts){return new Date(ts).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}

function collectForm(){
  var o={};
  document.querySelectorAll('#caseForm [data-f]').forEach(function(el){
    var k=el.getAttribute('data-f'),v=el.value;
    if(el.type==='number')o[k]=num(v);else o[k]=v.trim();
  });
  o.applicants=[];
  document.querySelectorAll('#apps .app').forEach(function(row){
    var a={};row.querySelectorAll('[data-a]').forEach(function(i){a[i.getAttribute('data-a')]=i.value.trim()});
    if(Object.keys(a).some(function(k){return a[k]}))o.applicants.push(a);
  });
  var auto=o.fixedUntil?addMonths(o.fixedUntil,-REVM):'';
  if(o.reviewDate===auto)o.reviewDate='';
  o.securities=[];
  document.querySelectorAll('#secs .sec2').forEach(function(card){
    var sid0=card.getAttribute('data-sid'),old0=((currentCase()||{}).securities||[]).filter(function(q){return q.id===sid0})[0]||{};var x=Object.assign({},old0,{id:sid0});
    card.querySelectorAll('[data-s]').forEach(function(i){var k=i.getAttribute('data-s');x[k]=i.type==='number'?num(i.value):i.value.trim()});
    var a2=x.fixedUntil?addMonths(x.fixedUntil,-REVM):'';if(x.reviewDate===a2)x.reviewDate='';
    var has=['address','use','lender','lenderRef','product','fixedUntil','reviewDate','erc','mortgageExpiry','rate','followOnRate','monthlyPayment','loanAmount'].some(function(k){return x[k]});
    if(has)o.securities.push(x);
  });
  o.links=curLinks.map(function(l){return {id:l.id,cid:l.cid,rel:l.rel}});
  return o;
}
function saveCase(){
  var data=collectForm();
  if(!data.applicants.length){toast('Add at least one applicant name');return}
  var btn=$('#saveBtn');btn.disabled=true;
  var p;
  if(openId){p=patch(openId,data)}
  else{
    if(!data.clientNo)data.clientNo=nextClientNo();
    var ref=col.doc();data.createdAt=Date.now();data.updatedAt=data.createdAt;data.tasks=[];data.notes=pendingNotes;
    p=write(ref.id,function(){return ref.set(data)}).then(function(){openId=ref.id;secMoveDone()});
  }
  p.then(function(){toast('Case saved');closeDrawer()});
}

/* ---------- export ---------- */
function exportCsv(){
  claude.use('downloads').then(function(dl){
    if(!dl){toast('Downloads are not available in this view');return}
    var cols=['clientNo','stage','type','propertyAddress','purchasePrice','loanAmount','termYears','lender','lenderRef','product','rate','fixedUntil','reviewDate','monthlyPayment','dipExpiry','offerDate','offerExpiry','completionDate','conveyancer'];
    function q(v){v=v==null?'':String(v);return '"'+v.replace(/"/g,'""')+'"'}
    var lines=[['clients'].concat(cols).map(q).join(',')];
    cases.forEach(function(c){lines.push([names(c)].concat(cols.map(function(k){return c[k]})).map(q).join(','))});
    return dl.save({filename:'cases-'+iso(TODAY)+'.csv',data:lines.join('\n')}).then(function(){toast('CSV saved')},function(e){if(e&&e.code!=='declined')toast('Could not save the file')});
  });
}

/* ---------- task tray ---------- */
var trayOpen=false,trFilter='open',trQuery='',trOpen={};
function allTasks(){var out=[];cases.forEach(function(c){if(c.stage==='lost')return;(c.tasks||[]).forEach(function(t){out.push({c:c,t:t})})});return out}
function trBucket(x){var d=x.t.due;if(x.t.done)return 'done';if(!d)return 'none';var n=diff(d);return n<0?'over':n===0?'today':n<=7?'week':'later'}
function updTrayBtn(){var b=$('#trayBtn');if(!b)return;var od=allTasks().filter(function(x){return trBucket(x)==='over'}).length;b.innerHTML='Tasks'+(od?'<span class="tbadge">'+od+' overdue</span>':'')}
var TR_LABEL={pri:'High priority',over:'Overdue',today:'Due today',week:'Next 7 days',later:'Later',none:'No due date',done:'Done'};
function trItem(x){
  var c=x.c,t=x.t,b=trBucket(x),k=c.id+'|'+t.id;
  if(editTk===k)return '<div class="tt"><div class="tm">'+tkEditor(k,t)+'<div><button type="button" class="lnk" data-open="'+c.id+'">'+esc(names(c))+cno(c)+'</button></div></div></div>';
  var open=!!trOpen[k],dchip=t.due?'<span class="chip '+(b==='over'?'bad':b==='today'?'warn':'')+'">'+(b==='today'?'Today':fd(t.due))+(t.time?' '+esc(t.time):'')+'</span>':'<span class="muted" style="font-size:12px">No date</span>';
  return '<div class="tt '+(b==='over'?'bad':b==='today'?'warn':'')+(t.done?' done':'')+(t.pri&&!t.done?' pri':'')+(open?' open':'')+'"><input type="checkbox" data-trk="'+k+'"'+(t.done?' checked':'')+' aria-label="Mark done"><div class="tm"><div class="trow" data-trtog="'+k+'" role="button" tabindex="0" aria-expanded="'+open+'"><div class="tx">'+(t.pri&&!t.done?'<span class="prtag">HIGH</span> ':'')+esc(t.text)+'</div>'+dchip+'</div><div><button type="button" class="lnk" data-open="'+c.id+'">'+esc(names(c))+cno(c)+'</button></div>'+(open?(t.created?'<div class="muted" style="font-size:12px">Added '+shortStamp(t.created)+'</div>':'')+'<div class="tact"><input type="date" data-trd="'+k+'" value="'+esc(t.due||'')+'" aria-label="Due date"><input type="time" data-trt="'+k+'" value="'+esc(t.time||'')+'" aria-label="Time"><button type="button" class="star'+(t.pri?' on':'')+'" data-tkpri="'+k+'" title="High priority" aria-label="Toggle high priority">'+(t.pri?'★':'☆')+'</button><button type="button" class="btn ghost sm" data-tkedit="'+k+'">Edit</button><button type="button" class="btn ghost sm" data-snz="'+k+'|1">+1 day</button><button type="button" class="btn ghost sm" data-snz="'+k+'|7">+1 week</button></div>':'')+'</div></div>';
}
var sideOn=true;
var mqSide=window.matchMedia('(min-width:760px)');
function placeAcct(){}
function sideVisible(){var sd=document.getElementById('side');return !!sd&&document.body.classList.contains('side-on')&&getComputedStyle(sd).display!=='none'}
function applySide(){document.body.classList.toggle('side-on',sideOn);if(sideVisible()&&view==='reminders'){view='tasks';render()}renderNav();placeAcct();var h=document.querySelector('header.top');if(h)document.documentElement.style.setProperty('--hh',h.offsetHeight+'px');renderSide();renderRem()}
if(mqSide.addEventListener)mqSide.addEventListener('change',function(){applySide()});
window.addEventListener('resize',function(){if(sideVisible()&&view==='reminders'){view='tasks';render()}renderNav();var h=document.querySelector('header.top');if(h)document.documentElement.style.setProperty('--hh',h.offsetHeight+'px')});
function sideItem(e,g){
  return '<div class="si'+(g==='over'?' over':'')+'"><div style="min-width:0"><button type="button" class="lnk st" data-open="'+e.id+'">'+esc(e.who)+'</button><div class="sc">'+esc(e.label)+'</div><div class="sd">'+fd(e.date)+' · '+esc(rel(e.date))+'</div></div></div>';
}
var sideLater=false;
function renderSide(){
  var s=$('#sideTasks');if(!s||!document.body.classList.contains('side-on')){if(s)s.innerHTML='';return}
  var bt=bdCounts(bdPeople().list).today;
  var items=[['calculator','Mortgage Calculator'],['appointments','Calendar'],['notebook','Notebook'],['birthdays','Birthdays'],['marketing','Marketing']];
  s.innerHTML='<div id="sideTools"><div class="sh"><b>Tools</b></div>'+items.map(function(i){return '<button type="button" class="sbtn" data-v="'+i[0]+'"'+(view===i[0]?' aria-current="page"':'')+'>'+i[1]+(i[0]==='birthdays'&&bt?'<span class="badge" style="background:#fde4ee;color:#c2185b">'+bt+' today</span>':'')+'</button>'}).join('')+'<button type="button" class="sbtn acct" data-sideacct="1">Settings</button><button type="button" class="sbtn logout" id="logoutBtn">Log out</button></div>';
}
function renderRem(){
  var s=$('#homeRem');if(!s)return;
  var ev=reviewEvents();
  var h='<div class="sh"><b>Reminders</b><span class="muted" style="font-size:12px">'+ev.length+' review'+(ev.length===1?'':'s')+'</span></div>';
  [['over','Overdue',function(n){return n<0}],['week','Next 7 days',function(n){return n>=0&&n<=7}],['month','Next 30 days',function(n){return n>7&&n<=30}],['q','31 to 90 days',function(n){return n>30&&n<=90}],['later','Later',function(n){return n>90}]].forEach(function(g){
    var gi=ev.filter(function(e){return g[2](diff(e.date))});
    if(g[0]==='later'){if(gi.length)h+='<button type="button" class="sg sglater" data-sidelater="1" aria-expanded="'+sideLater+'">Later · '+gi.length+' <span>'+(sideLater?'▾':'▸')+'</span></button>'+(sideLater?gi.map(function(e){return sideItem(e,g[0])}).join(''):'');return}
    if(gi.length)h+='<div class="sg'+(g[0]==='over'?' bad':'')+'">'+g[1]+' · '+gi.length+'</div>'+gi.map(function(e){return sideItem(e,g[0])}).join('');
  });
  if(!ev.length)h+='<div class="muted" style="font-size:13px">No mortgage reviews due.</div>';
  s.innerHTML=h;
}
function renderTray(){
  var box=$('#trList');if(!box)return;
  bdBanner();
  var aeT=document.activeElement;if(editTk&&aeT&&aeT.closest&&aeT.closest('[data-tkbox]'))return;
  var q=trQuery.trim().toLowerCase(),all=allTasks();
  var cnt={open:0,over:0,today:0,week:0,none:0,done:0};
  all.forEach(function(x){var b=trBucket(x);if(b==='done')cnt.done++;else{cnt.open++;if(b==='over')cnt.over++;if(b==='today'){cnt.today++;cnt.week++}if(b==='week')cnt.week++;if(b==='none')cnt.none++}});
  var chips=[['open','All open'],['over','Overdue'],['today','Today'],['week','Next 7 days'],['none','No date'],['done','Done']];
  var tbk=$('#trBulk');if(tbk)tbk.innerHTML=cnt.over?'<span><b>'+cnt.over+' overdue.</b> Move them all to:</span> <button type="button" class="btn ghost sm" data-trbulk="today">Today</button><button type="button" class="btn ghost sm" data-trbulk="tomorrow">Tomorrow</button><button type="button" class="btn ghost sm" data-trbulk="monday">Next Monday</button>':'';
  $('#trChips').innerHTML=chips.map(function(c){return '<button type="button" data-trf="'+c[0]+'" aria-pressed="'+(trFilter===c[0])+'">'+c[1]+' '+cnt[c[0]]+'</button>'}).join('');
  var dl=$('#trCases');if(dl)dl.innerHTML=cases.slice().sort(function(a,b){return cnum(a)-cnum(b)}).map(function(c){return '<option value="'+esc((c.clientNo||'')+' · '+names(c))+'"></option>'}).join('');
  var items=all.filter(function(x){
    var b=trBucket(x);
    if(trFilter==='done'){if(b!=='done')return false}
    else{if(b==='done')return false;
      if(trFilter==='over'&&b!=='over')return false;
      if(trFilter==='today'&&b!=='today')return false;
      if(trFilter==='week'&&b!=='today'&&b!=='week')return false;
      if(trFilter==='none'&&b!=='none')return false}
    if(q&&(x.t.text+' '+names(x.c)+' '+(x.c.clientNo||'')).toLowerCase().indexOf(q)<0)return false;
    return true});
  items.sort(function(a,b){var da=tkKey(a.t),db2=tkKey(b.t);return da<db2?-1:da>db2?1:((a.t.created||0)-(b.t.created||0))||(cnum(a.c)-cnum(b.c))});
  if(!items.length){box.innerHTML='<div class="empty">Nothing here.</div>';return}
  var order=['pri','today','over','week','later','none','done'],h='';
  var isP=function(x){return !x.t.done&&!!x.t.pri};
  order.forEach(function(g){
    var gi=items.filter(function(x){return g==='pri'?isP(x):(!isP(x)&&trBucket(x)===g)});
    if(!gi.length)return;
    h+='<div class="tgh '+(g==='over'?'bad':g==='pri'?'prh':'')+'">'+TR_LABEL[g]+' · '+gi.length+'</div>'+gi.map(trItem).join('');
  });
  box.innerHTML=h;
}
function trBulk(w){
  var d=w==='today'?iso(TODAY):w==='tomorrow'?addDays(iso(TODAY),1):addDays(iso(TODAY),((8-TODAY.getDay())%7)||7),n=0;
  cases.forEach(function(c){
    if(c.stage==='lost'||!(c.tasks||[]).some(function(t){return !t.done&&t.due&&diff(t.due)<0}))return;
    var nt=(c.tasks||[]).map(function(t){if(!t.done&&t.due&&diff(t.due)<0){n++;return Object.assign({},t,{due:d})}return t});
    patch(c.id,{tasks:nt});
  });
  toast(n+' task'+(n===1?'':'s')+' moved to '+fd(d));
}
function taskShell(){
  return '<input type="search" id="trQ" class="search" style="width:100%;margin-top:10px" placeholder="Search tasks or clients" aria-label="Search tasks" value="'+esc(trQuery)+'"><div id="trBulk" class="trbulk"></div><div id="trChips" class="chips" style="margin:10px 0"></div><div id="trList"></div>';
}
function openTray(){
  trayOpen=true;var t=$('#tray');t.hidden=false;
  t.innerHTML='<div class="th"><div><div class="eyebrow">Task tray</div><h2>Tasks</h2></div><button type="button" class="btn ghost" data-trclose>Close</button></div><div class="tb"><div class="tadd"><input type="text" id="trNewText" class="wide2" placeholder="New task, e.g. chase conveyancer" aria-label="New task"><input type="text" id="trNewCase" list="trCases" placeholder="Client (name or C number)" aria-label="Client"><datalist id="trCases"></datalist><input type="date" id="trNewDue" aria-label="Due date"><input type="time" id="trNewTime" aria-label="Time"><label class="prichk"><input type="checkbox" id="trNewPri"> High priority</label><button type="button" class="btn wide2" id="trAdd">Add task</button></div><input type="search" id="trQ" class="search" style="width:100%" placeholder="Search tasks or clients" aria-label="Search tasks" value="'+esc(trQuery)+'"><div id="trChips" class="chips"></div><div id="trList"></div></div>';
  renderTray();
}
function closeTray(){trayOpen=false;var t=$('#tray');t.hidden=true;t.innerHTML=''}
function trFind(key){var p=String(key).split('|');var c=cases.filter(function(x){return x.id===p[0]})[0];if(!c)return null;var t=(c.tasks||[]).filter(function(x){return x.id===p[1]})[0];return t?{c:c,t:t,n:+p[2]}:null}
function trSet(f,change){patch(f.c.id,{tasks:(f.c.tasks||[]).map(function(x){return x.id===f.t.id?Object.assign({},x,change):x})})}
function trAddTask(){
  var tx=$('#trNewText').value.trim(),cv=$('#trNewCase').value,due=$('#trNewDue').value,tmv=$('#trNewTime').value;if(tmv&&!due)due=iso(TODAY);
  if(!tx){toast('Type the task first');return}
  var no=cv.split(' · ')[0].trim().toUpperCase();
  var c=cases.filter(function(x){return (x.clientNo||'').toUpperCase()===no})[0];
  if(!c){toast('Pick a client from the list');return}
  patch(c.id,{tasks:(c.tasks||[]).concat([{id:uid(),text:tx,due:due||'',time:tmv||'',done:false,created:Date.now(),pri:!!$('#trNewPri').checked}])});
  $('#trNewText').value='';$('#trNewDue').value='';$('#trNewTime').value='';$('#trNewPri').checked=false;toast('Task added to '+names(c));
}

/* ---------- notebook (general notes, not linked to any client) ---------- */
var nbCol=null,notes=[],nbSel=null,nbShown=null,nbQuery='',nbTimer=null;
function nbSorted(){return notes.slice().sort(function(a,b){return (b.updatedAt||0)-(a.updatedAt||0)})}
function nbTitleOf(n){var t=(n.title||'').trim();if(t)return t;var l=String(n.body||'').split('\n').filter(function(x){return x.trim()})[0];return l?l.slice(0,60):'Untitled note'}
function nbShell(){
  return '<div class="pagehead"><h1>Notebook</h1><span class="muted">General notes, not linked to any client</span></div><div class="nb"><aside class="nbside"><button type="button" class="btn" id="nbNew" style="width:100%">New note</button><input type="search" id="nbQ" class="search" style="width:100%;margin-top:8px" placeholder="Search notes" aria-label="Search notes" value="'+esc(nbQuery)+'"><div id="nbList"></div></aside><section class="nbmain" id="nbMain"></section></div>';
}
function nbList(){
  var box=$('#nbList');if(!box)return;
  var q=nbQuery.trim().toLowerCase();
  var l=nbSorted().filter(function(n){return !q||((n.title||'')+' '+(n.body||'')).toLowerCase().indexOf(q)>-1});
  box.innerHTML=l.length?l.map(function(n){var sn=String(n.body||'').replace(/\s+/g,' ').slice(0,80);return '<button type="button" class="nbi'+(n.id===nbSel?' on':'')+'" data-nbsel="'+n.id+'"><b>'+esc(nbTitleOf(n))+'</b><span class="muted">'+stampOf(n.updatedAt||n.createdAt||Date.now())+'</span><span class="muted">'+esc(sn)+'</span></button>'}).join(''):'<div class="muted" style="padding:10px">'+(notes.length?'No notes match.':'No notes yet. Click New note.')+'</div>';
}
var NB_FONTS={'Arial':'Arial, Helvetica, sans-serif','Georgia':'Georgia, serif','Times New Roman':'"Times New Roman", Times, serif','Verdana':'Verdana, Geneva, sans-serif','Trebuchet MS':'"Trebuchet MS", sans-serif','Courier New':'"Courier New", monospace'};
var NB_SIZES={1:10,2:13,3:16,4:19,5:24,6:32,7:44};
var NB_NAMED={'x-small':10,'small':13,'medium':16,'large':19,'x-large':24,'xx-large':32,'xxx-large':44};
function nbColor(v){v=String(v||'').trim();if(/^#[0-9a-f]{3}$/i.test(v))v='#'+v.charAt(1)+v.charAt(1)+v.charAt(2)+v.charAt(2)+v.charAt(3)+v.charAt(3);var h=safeColor(v)||rgbHex(v);return h?h.toLowerCase():''}
function nbFontOf(v){var f=String(v||'').split(',')[0].replace(/["']/g,'').trim().toLowerCase();for(var k in NB_FONTS)if(k.toLowerCase()===f)return NB_FONTS[k];return ''}
function nbSizeOf(v){v=String(v||'').trim().toLowerCase();if(NB_NAMED[v])return NB_NAMED[v];var m=/^([\d.]+)px$/.exec(v);if(m){var n=Math.round(+m[1]);return n>=8&&n<=72?n:0}return 0}
function nbClean(html){
  var doc=new DOMParser().parseFromString('<body>'+String(html||'')+'</body>','text/html'),out=document.createElement('div');
  var TAG={b:'b',strong:'b',i:'i',em:'i',u:'u',s:'s',strike:'s',del:'s',ul:'ul',ol:'ol',li:'li',div:'div',p:'div',h1:'div',h2:'div',h3:'div',span:'span',font:'span'};
  function walk(src,dst,depth){
    if(depth>30)return;
    Array.prototype.forEach.call(src.childNodes,function(n){
      if(n.nodeType===3){dst.appendChild(document.createTextNode(n.nodeValue));return}
      if(n.nodeType!==1)return;
      var tg=n.tagName.toLowerCase();
      if(tg==='br'){dst.appendChild(document.createElement('br'));return}
      if(/^(script|style|iframe|object|embed|svg|math|template|noscript|textarea|select|button|input|img|video|audio|link|meta)$/.test(tg))return;
      if(!TAG[tg]){walk(n,dst,depth+1);return}
      var el=document.createElement(TAG[tg]),st=[],sd=n.style||{};
      var col=nbColor(sd.color||(tg==='font'?n.getAttribute('color'):'')),bg=nbColor(sd.backgroundColor),fam=nbFontOf(sd.fontFamily||(tg==='font'?n.getAttribute('face'):'')),sz=nbSizeOf(sd.fontSize)||(tg==='font'?NB_SIZES[+n.getAttribute('size')]||0:0);
      if(col&&(lum(col)<0.1||lum(col)>0.95))col='';
      if(bg){st.push('background-color:'+bg);if(!col)col='#101c26'}
      if(col)st.push('color:'+col);
      if(fam)st.push('font-family:'+fam);
      if(sz)st.push('font-size:'+sz+'px');
      var fw=sd.fontWeight;if(fw==='bold'||+fw>=600)st.push('font-weight:700');
      if(sd.fontStyle==='italic')st.push('font-style:italic');
      var td=String(sd.textDecorationLine||sd.textDecoration||'');
      if(/underline|line-through/.test(td))st.push('text-decoration:'+((/underline/.test(td)?'underline ':'')+(/line-through/.test(td)?'line-through':'')).trim());
      if(st.length)el.setAttribute('style',st.join(';'));
      walk(n,el,depth+1);dst.appendChild(el);
    });
  }
  walk(doc.body,out,0);
  return out.innerHTML;
}
function nbBodyHtml(n){return n.html?nbClean(n.html):esc(n.body||'').replace(/\r?\n/g,'<br>')}
function nbToolbar(){
  var sw=function(kind,c){return '<button type="button" class="sw" data-rt="'+kind+':'+c+'" style="background:'+c+'" title="'+(kind==='fore'?'Text colour':'Highlight')+'" aria-label="'+(kind==='fore'?'Text colour':'Highlight')+' '+c+'"></button>'};
  var tc=['#d32f2f','#ef6c00','#2e7d32','#1565c0','#6a1b9a','#6d4c41'],hc=['#fff176','#a5d6a7','#90caf9','#f8bbd0','#ffcc80'];
  return '<div class="rtbar" id="nbBar">'+
  '<button type="button" data-rt="bold" title="Bold"><b>B</b></button><button type="button" data-rt="italic" title="Italic"><i>I</i></button><button type="button" data-rt="underline" title="Underline"><u>U</u></button><button type="button" data-rt="strikeThrough" title="Strikethrough"><s>S</s></button><span class="sep"></span>'+
  '<select data-rtsel="font" aria-label="Font"><option value="">Font</option>'+Object.keys(NB_FONTS).map(function(k){return '<option value="'+esc(NB_FONTS[k])+'">'+k+'</option>'}).join('')+'</select>'+
  '<select data-rtsel="size" aria-label="Text size"><option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="4">Large</option><option value="5">Larger</option><option value="6">Huge</option></select><span class="sep"></span>'+
  '<label>Text</label>'+tc.map(function(c){return sw('fore',c)}).join('')+'<input type="color" data-rtinput="fore" value="#1565c0" aria-label="Custom text colour"><span class="sep"></span>'+
  '<label>Highlight</label>'+hc.map(function(c){return sw('hilite',c)}).join('')+'<input type="color" data-rtinput="hilite" value="#fff176" aria-label="Custom highlight colour"><button type="button" data-rt="hilite:none" title="Remove highlight">No highlight</button><span class="sep"></span>'+
  '<button type="button" data-rt="insertUnorderedList" title="Bullet list">• List</button><button type="button" data-rt="insertOrderedList" title="Numbered list">1. List</button><button type="button" data-rt="removeFormat" title="Clear formatting">Clear format</button></div>';
}
var nbRange=null;
document.addEventListener('selectionchange',function(){var sl=window.getSelection(),b=$('#nbBody');if(b&&sl&&sl.rangeCount&&b.contains(sl.anchorNode))nbRange=sl.getRangeAt(0).cloneRange()});
function nbExec(cmd,val){
  var b=$('#nbBody');if(!b)return;
  b.focus();if(nbRange){var sl=window.getSelection();sl.removeAllRanges();sl.addRange(nbRange)}
  try{document.execCommand('styleWithCSS',false,true)}catch(e){}
  if(cmd==='hilite'){if(val==='none'){document.execCommand('hiliteColor',false,'transparent')}else if(!document.execCommand('hiliteColor',false,val))document.execCommand('backColor',false,val)}
  else if(cmd==='fore'){document.execCommand('foreColor',false,val)}
  else document.execCommand(cmd,false,val==null?null:val);
  nbSched();
}
function nbTablesHtml(n){return (n.tables||[]).map(function(t){return '<div style="margin:12px 0">'+tblBlock({ts:t.ts,table:t.table},'nbtables')+'</div>'}).join('')}
function nbSetTables(arr){
  var id=nbShown;if(!id||!nbCol)return;
  var n=notes.filter(function(x){return x.id===id})[0];if(n)n.tables=arr;
  var bx=$('#nbTables');if(bx&&n){bx.innerHTML=nbTablesHtml(n);bx.setAttribute('data-sig',JSON.stringify(arr))}
  write('nb-'+id,function(){return nbCol.doc(id).update({tables:arr,updatedAt:Date.now()})});
}
function nbEditor(){
  var m=$('#nbMain');if(!m)return;
  var n=notes.filter(function(x){return x.id===nbSel})[0];
  if(!n){m.innerHTML='<div class="empty"><h2>Notebook</h2>Click New note to start typing.</div>';nbShown=null;return}
  nbShown=n.id;
  m.innerHTML='<input id="nbTitle" class="nbt" type="text" placeholder="Title (optional)" value="'+esc(n.title||'')+'" aria-label="Note title">'+nbToolbar()+'<div id="nbBody" class="nbb nbrt" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Note" data-ph="Type anything here. Use the toolbar for colour and font. You can also paste a table from Excel.">'+nbBodyHtml(n)+'</div><div id="nbTables" data-sig=\''+esc(JSON.stringify(n.tables||[]))+'\'>'+nbTablesHtml(n)+'</div><div class="add"><button type="button" class="btn ghost" id="nbStamp">Insert date and time</button><button type="button" class="btn danger" id="nbDel">Delete note</button><span class="muted" id="nbMsg" style="align-self:center;font-size:12px">Saves automatically</span></div>';
}
function renderNotebook(){
  if(!nbSel&&notes.length)nbSel=nbSorted()[0].id;
  nbList();
  var n=notes.filter(function(x){return x.id===nbSel})[0];
  if(nbSel!==nbShown||(!n&&nbShown)||(!$('#nbTitle')&&n))nbEditor();
  var bx=$('#nbTables');
  if(n&&bx){var sg=JSON.stringify(n.tables||[]);if(bx.getAttribute('data-sig')!==sg&&!(document.activeElement&&bx.contains(document.activeElement))){bx.innerHTML=nbTablesHtml(n);bx.setAttribute('data-sig',sg)}}
}
function nbSave(){
  nbTimer=null;var id=nbShown;if(!id||!nbCol)return;
  var t=$('#nbTitle'),b=$('#nbBody');if(!t||!b)return;
  var d={title:t.value,body:(b.innerText||'').replace(/\u00a0/g,' ').replace(/\n{3,}/g,'\n\n').trim(),html:nbClean(b.innerHTML),updatedAt:Date.now()};
  write('nb-'+id,function(){return nbCol.doc(id).update(d)}).then(function(){var m=$('#nbMsg');if(m)m.textContent='Saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})});
}
function nbFlush(){if(nbTimer){clearTimeout(nbTimer);nbSave()}}
function nbSched(){var m=$('#nbMsg');if(m)m.textContent='Saving...';clearTimeout(nbTimer);nbTimer=setTimeout(nbSave,800)}
function nbNew(){
  if(!nbCol)return;nbFlush();
  var ref=nbCol.doc(),now=Date.now();nbSel=ref.id;nbQuery='';
  write('nb-'+ref.id,function(){return ref.set({title:'',body:'',createdAt:now,updatedAt:now})}).then(function(){setTimeout(function(){var b=$('#nbBody');if(b)b.focus()},400)});
}

/* ---------- full backup ---------- */
function backupAll(){
  if(!loaded||!cases.length){toast('No cases to back up yet');return}
  claude.use('downloads').then(function(dl){
    if(!dl){toast('Downloads are not available in this view');return}
    var payload={app:'Mortgage Case Desk',exportedAt:new Date().toISOString(),count:cases.length,cases:cases,notebook:notes,appointments:appts,marketing:[{id:'contacts',items:mkItems}].concat(mkMsgsDoc?[{id:'messages',items:mkMsgsDoc}]:[])};
    return dl.save({filename:'case-desk-backup-'+iso(TODAY)+'.json',data:JSON.stringify(payload,null,2)}).then(function(){toast('Backup saved: '+cases.length+' cases')},function(e){if(e&&e.code!=='declined')toast('Could not save the backup')});
  });
}

/* ---------- events ---------- */
document.addEventListener('click',function(e){
  var cb=e.target.closest&&e.target.closest('[data-coltoggle]');
  if(cb){var ck=cb.getAttribute('data-coltoggle'),cf=cb.closest('fieldset');colOpen[ck]=!colOpen[ck];cf.classList.toggle('col-closed',!colOpen[ck]);cb.textContent=colOpen[ck]?'Hide':'Show';cb.blur();return}
  var sb=e.target.closest&&e.target.closest('[data-sectoggle]');
  if(sb){var k=sb.getAttribute('data-sectoggle'),fs=sb.closest('fieldset');secHidden[k]=!secHidden[k];
    fs.classList.toggle('sec-hidden',!!secHidden[k]);sb.textContent=secHidden[k]?'Show':'Hide';
    try{localStorage.setItem('secHidden',JSON.stringify(secHidden))}catch(x){}return}
  var t=e.target;
  var adv=t.closest('[data-adv]');
  if(adv){e.stopPropagation();patch(adv.dataset.adv,{stage:adv.dataset.to});return}
  var o=t.closest('[data-open]');
  if(o){e.preventDefault();openDrawer(o.dataset.open);return}
  if(t.closest('.brand')){nbFlush();view='tasks';render();window.scrollTo(0,0);return}
  if(t.closest&&t.closest('[data-sideacct]')){var sb=document.getElementById('settingsBtn');if(sb)sb.click();return}
  var nv=t.closest('#nav button,#nav2 button,#sideTools button[data-v]');
  if(nv){nbFlush();view=nv.dataset.v;render();return}
  if(t.closest('#newBtn')||t.closest('[data-act="new"]')){openDrawer(null);return}
  if(t.closest('#pdfBtn')||t.closest('[data-act="pdf"]')){$('#pdfIn').click();return}
  if(t.closest('[data-act="export"]')){exportCsv();return}
  if(t.closest('#backupBtn')){backupAll();return}
  if(t.closest('#trayBtn')){if(trayOpen)closeTray();else openTray();return}
  if(t.closest('[data-trclose]')){closeTray();return}
  if(t.closest('[data-clrf]')){stageFilter='';lenderFilter='';revFilter='';render();return}
  var sl=t.closest('[data-sidelater]');if(sl){sideLater=!sideLater;renderRem();return}
  var tg=t.closest('[data-trtog]');if(tg){var kk=tg.getAttribute('data-trtog');trOpen[kk]=!trOpen[kk];renderTray();return}
  var tb=t.closest('[data-trbulk]');if(tb){trBulk(tb.getAttribute('data-trbulk'));return}
  var tf=t.closest('[data-trf]');if(tf){trFilter=tf.dataset.trf;renderTray();return}
  var sz=t.closest('[data-snz]');if(sz){var f1=trFind(sz.dataset.snz);if(f1){var base=f1.t.due&&diff(f1.t.due)>=0?f1.t.due:iso(TODAY);trSet(f1,{due:addDays(base,f1.n)})}return}
  if(t.id==='trAdd'){trAddTask();return}
  if(t.id==='nbNew'){nbNew();return}
  var ns1=t.closest('[data-nbsel]');if(ns1){nbFlush();nbSel=ns1.dataset.nbsel;renderNotebook();return}
  if(t.id==='nbStamp'){var nb1=$('#nbBody');nb1.focus();var rg=document.createRange();rg.selectNodeContents(nb1);rg.collapse(false);var sg=window.getSelection();sg.removeAllRanges();sg.addRange(rg);document.execCommand('insertHTML',false,(nb1.textContent.trim()?'<br><br>':'')+esc(stampOf(Date.now()))+' - ');nbSched();return}
  if(t.id==='nbDel'){if(!t.classList.contains('armed')){t.classList.add('armed');t.textContent='Confirm delete';return}var nid=nbShown;nbSel=null;nbShown=null;write('nb-'+nid,function(){return nbCol.doc(nid).delete()}).then(function(){toast('Note deleted')});return}
  if(t.closest('[data-close]')){closeDrawer();return}
  if(t.id==='saveBtn'){saveCase();return}
  if(t.id==='addApp'){var n=document.querySelectorAll('#apps .app').length;$('#apps').insertAdjacentHTML('beforeend',appRow({},n));return}
  var pcb=t.closest&&t.closest('[data-pcfind]');if(pcb){pcFind(pcb);return}
  if(t.id==='addSec'){var sn=document.querySelectorAll('#secs .sec2').length;$('#secs').insertAdjacentHTML('beforeend',secRow({},sn));var na=$('#secs .sec2:last-child [data-s="address"]');if(na)na.focus();return}
  var rms=t.closest('[data-rmsec]');
  if(rms){var cd=rms.closest('.sec2');if(!cd){var sidr=rms.getAttribute('data-rmsec');cd=document.querySelector('#secs .sec2[data-sid="'+sidr+'"]');var pr=rms.closest('.propi');if(pr)pr.remove()}if(cd)cd.remove();document.querySelectorAll('#secs .sec2').forEach(function(c2,j){var h=c2.querySelector('.top2>span');if(h)h.textContent='Other property '+(j+1)});updSRev();return}
  var sg=t.closest('[data-sectog]');
  if(sg){var cd2=sg.closest('.sec2'),isC=cd2.classList.toggle('sec2-collapsed');secCollapsed[cd2.getAttribute('data-sid')]=isC;sg.textContent=isC?'Show lender details':'Hide lender details';return}
  var rm=t.closest('[data-rmapp]');
  if(rm){var row=rm.closest('.app');if(document.querySelectorAll('#apps .app').length>1)row.remove();return}
  if(t.id==='apOv'){apClose();return}
  if(t.id==='bookBtn'){apOpen(null,iso(TODAY),openId);return}
  if(t.id==='tkBook'){var tdue=document.getElementById('tkDue');apOpen(null,(tdue&&tdue.value)||iso(TODAY),openId);return}
  var bdf=t.closest&&t.closest('[data-bdf]');if(bdf){bdFilter=bdf.getAttribute('data-bdf');bdRender();return}
  var mkt=t.closest&&t.closest('[data-mktab]');if(mkt){mkTab=mkt.getAttribute('data-mktab');mkMsgEdit=null;render();return}
  if(mkMsgAct(t))return;
  if(t.closest&&t.closest('[data-mkadd]')){mkOpen(null);return}
  if(t.closest&&t.closest('[data-mkexp]')){mkExport();return}
  var mke=t.closest&&t.closest('[data-mkedit]');if(mke&&!(t.closest&&t.closest('a'))){mkOpen(mke.getAttribute('data-mkedit'));return}
  if(t.closest&&t.closest('[data-mksave]')){mkSaveForm();return}
  if(t.closest&&t.closest('[data-mkcancel]')){mkClose();return}
  if(t.id==='mkOv'){mkClose();return}
  if(t.closest&&t.closest('[data-mkdel]')){if(!t.classList.contains('armed')){t.classList.add('armed');t.textContent='Confirm delete';return}var did=mkEditId;mkItems=mkItems.filter(function(x){return x.id!==did});mkSave();mkClose();mkList();toast('Contact deleted');return}
  if(t.closest&&t.closest('[data-bdgo]')){view='birthdays';bdFilter='week';render();return}
  var bdo=t.closest&&t.closest('[data-bdopen]');
  if(bdo){var ok=bdo.getAttribute('data-bdopen'),cur=bdOpen[ok]!==undefined?bdOpen[ok]:(bdFind(ok)||{days:99}).days<=7;bdOpen[ok]=!cur;bdRender();return}
  var bds=t.closest&&t.closest('[data-bdsend]');
  if(bds){var sp=bdFind(bds.getAttribute('data-bdsend'));if(!sp)return;var si=bdIntl(sp.phone);if(!si){toast('No phone number saved for '+sp.name);return}
    var stx=bdText(sp);bdDraft[sp.key]=stx;window.open('https://wa.me/'+si+'?text='+encodeURIComponent(stx),'_blank','noopener');bdSetSent(sp,true);toast('WhatsApp opened for '+bdFirst(sp.name));return}
  var bdc=t.closest&&t.closest('[data-bdcopy]');
  if(bdc){var cp=bdFind(bdc.getAttribute('data-bdcopy'));if(!cp)return;var ctx=bdText(cp);bdDraft[cp.key]=ctx;
    var done=function(){toast('Message copied')};
    if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(ctx).then(done,function(){toast('Could not copy. Select the text and copy it.')});else{var ta0=document.querySelector('[data-bdmsg]');if(ta0){ta0.select();try{document.execCommand('copy');done()}catch(x){}}}
    return}
  var bdg=t.closest&&t.closest('[data-bdgen]');
  if(bdg){var gv=bdg.getAttribute('data-bdgen'),gi=gv.lastIndexOf('|'),gk=gv.slice(0,gi);bdGen[gk]=gv.slice(gi+1);delete bdDraft[gk];write('nb-bday-gender',function(){return nbCol.doc('bday-gender').set({map:bdGen,updatedAt:Date.now()})});bdRender();return}
  var bdk=t.closest&&t.closest('[data-bdkind]');
  if(bdk){var kp=bdFind(bdk.getAttribute('data-bdkind'));if(kp){bdKind[kp.key]=bdMode(kp)==='isl'?'gen':'isl';delete bdDraft[kp.key];bdRender()}return}
  var bdh=t.closest&&t.closest('[data-bdshuf]');
  if(bdh){var hp=bdFind(bdh.getAttribute('data-bdshuf'));if(hp){var n0=bdList(hp).length,cur0=bdPick(hp),tries=0;do{bdShuf[hp.key]=(bdShuf[hp.key]||0)+1;tries++}while(n0>1&&bdPick(hp)===cur0&&tries<30);delete bdDraft[hp.key];bdRender()}return}
  if(t.id==='bdTplBtn'){bdTplOpen=!bdTplOpen;bdTplRender();return}
  if(t.id==='bdTplSave'){
    var ms=$('#bdMsgsText').value.split(/\n-{3,}\s*\n/).map(function(x){return x.trim()}).filter(Boolean),sg=$('#bdSigText').value.trim();
    if(!ms.length){toast('Write at least one message');return}
    if(!ms.some(function(x){return x.indexOf('{name}')>-1})&&!confirm('None of your messages has {name}, so the first name will not be added. Save anyway?'))return;
    var im=$('#bdIslText').value.split(/\n-{3,}\s*\n/).map(function(x){return x.trim()}).filter(Boolean);if(!im.length)im=BD_ISL.slice();
    var islSame=JSON.stringify(im)===JSON.stringify(BD_ISL),same=JSON.stringify(ms)===JSON.stringify(BD_MSGS)&&sg===BD_SIG.trim()&&islSame;
    bdCfg=same?{messages:null,signature:null,islamic:null}:{messages:ms,signature:sg,islamic:islSame?null:im};bdDraft={};bdShuf={};
    write('nb-bday-template',function(){return same?nbCol.doc('bday-template').delete():nbCol.doc('bday-template').set({messages:ms,signature:sg,islamic:islSame?[]:im,updatedAt:Date.now()})});
    bdTplOpen=false;bdTplRender();bdRender();toast('Saved');return}
  if(t.id==='bdTplReset'){bdCfg={messages:null,signature:null,islamic:null};bdShuf={};bdDraft={};write('nb-bday-template',function(){return nbCol.doc('bday-template').delete()});bdTplRender();bdRender();toast('Template reset');return}
  var hmt=t.closest&&t.closest('[data-hmtog]');if(hmt){homeMonth=hmt.getAttribute('data-hmtog')==='1';var hc3=$('#homeCal');if(hc3)hc3.innerHTML=apHome();return}
  if(apDragUsed){apDragUsed=false;e.preventDefault();return}
  var apd=t.closest&&t.closest('[data-apday]');
  if(apd){apSel=apd.getAttribute('data-apday');var pq=apSel.split('-');apMonth={y:+pq[0],m:+pq[1]-1};render();return}
  var apm=t.closest&&t.closest('[data-apmonth]');
  if(apm){var dm=+apm.getAttribute('data-apmonth');if(dm===0){apMonth={y:TODAY.getFullYear(),m:TODAY.getMonth()};apSel=iso(TODAY)}else{var nd0=new Date(apMonth.y,apMonth.m+dm,1);apMonth={y:nd0.getFullYear(),m:nd0.getMonth()}}render();return}
  if(t.closest&&t.closest('[data-apnew]')){apOpen(null,apSel);return}
  var ape=t.closest&&t.closest('[data-apedit]');if(ape){apOpen(ape.getAttribute('data-apedit'));return}
  var apk=t.closest&&t.closest('[data-apdone]');
  var apm2=t.closest&&t.closest('[data-apmiss]');
  if(apm2){var mk0=apm2.getAttribute('data-apmiss'),ma0=appts.filter(function(x){return x.id===mk0})[0];write('ap-'+mk0,function(){return apCol.doc(mk0).update({status:'noshow',updatedAt:Date.now()})});toast('Marked as missed'+(ma0&&apMissTask(ma0)?'. Rebook task added':''));setTimeout(function(){if(view==='appointments'||view==='tasks')render();renderNav()},30);return}
  var apr=t.closest&&t.closest('[data-aprebook]');
  if(apr){var ra=appts.filter(function(x){return x.id===apr.getAttribute('data-aprebook')})[0];if(ra){apOpen(null,iso(TODAY),ra.caseId||null);setTimeout(function(){var ty=$('#apType'),md=$('#apMode'),dr=$('#apDur');if(ty&&ra.type)ty.value=ra.type;if(md&&ra.mode)md.value=ra.mode;if(dr&&ra.dur)dr.value=ra.dur;apDpRender()},60)}return}
  if(apk){var ak=apk.getAttribute('data-apdone'),aa=appts.filter(function(x){return x.id===ak})[0];if(aa){write('ap-'+ak,function(){return apCol.doc(ak).update({status:aa.status==='done'?'booked':'done',updatedAt:Date.now()})});setTimeout(function(){if(view==='appointments'||view==='tasks')render();renderNav()},30)}return}
  if(t.closest&&t.closest('[data-apdm]')){var dmb=t.closest('[data-apdm]'),dn=+dmb.getAttribute('data-apdm');apDpM=new Date(apDpM.y,apDpM.m+dn,1);apDpM={y:apDpM.getFullYear(),m:apDpM.getMonth()};apDpRender();return}
  if(t.closest&&t.closest('[data-apdd]')){var ddb=t.closest('[data-apdd]'),dv2=ddb.getAttribute('data-apdd'),q2=dv2.split('-');$('#apDate').value=dv2;apDpM={y:+q2[0],m:+q2[1]-1};apClash=false;apDpRender();return}
  if(t.closest&&t.closest('[data-apclose]')){apClose();return}
  if(t.id==='apSave'){apSave();return}
  if(t.id==='apDel'){if(!t.classList.contains('armed')){t.classList.add('armed');t.textContent='Confirm delete';return}var did=apEditId;apClose();if(did){write('ap-'+did,function(){return apCol.doc(did).delete()});toast('Appointment deleted');setTimeout(function(){if(view==='appointments'||view==='tasks')render();renderNav()},30)}return}
  var rtb=t.closest&&t.closest('[data-rt]');
  if(rtb){var rv=rtb.getAttribute('data-rt'),ix=rv.indexOf(':');if(ix>0)nbExec(rv.slice(0,ix),rv.slice(ix+1));else nbExec(rv);return}
  var spr=t.closest&&t.closest('[data-tkpri]');
  if(spr){var sf=trFind(spr.getAttribute('data-tkpri'));try{spr.blur()}catch(e){}if(sf)trSet(sf,{pri:!sf.t.pri});return}
  var sdt=t.closest&&t.closest('[data-sidetoggle]');
  if(sdt){sideOn=!sideOn;try{localStorage.setItem('sideOn',sideOn?'1':'0')}catch(x){}applySide();try{sdt.blur()}catch(e){}return}
  var tke=t.closest&&t.closest('[data-tkedit]');
  if(tke){editTk=tke.getAttribute('data-tkedit');rerenderTasks();setTimeout(function(){var x=document.querySelector('[data-tkf=text]');if(x)x.focus()},50);return}
  if(t.closest&&t.closest('[data-tkecancel]')){editTk=null;try{document.activeElement.blur()}catch(e){}rerenderTasks();return}
  var tks=t.closest&&t.closest('[data-tkesave]');
  if(tks){
    var key=tks.getAttribute('data-tkesave'),bx=tks.closest('[data-tkbox]'),f=trFind(key);if(!f||!bx)return;
    var tx5=bx.querySelector('[data-tkf=text]').value.trim(),du5=bx.querySelector('[data-tkf=due]').value,tm5=bx.querySelector('[data-tkf=time]').value,pr5=bx.querySelector('[data-tkf=pri]').checked;
    if(!tx5){toast('Type the task first');return}
    if(tm5&&!du5)du5=iso(TODAY);
    editTk=null;try{document.activeElement.blur()}catch(e){}
    if(tx5===f.t.text&&du5===(f.t.due||'')&&tm5===(f.t.time||'')&&pr5===!!f.t.pri){rerenderTasks();return}
    trSet(f,{text:tx5,due:du5,time:tm5,pri:pr5,edited:Date.now()});toast('Task updated');return;
  }
  var ne=t.closest&&t.closest('[data-nedit]');
  if(ne){var pp=ne.getAttribute('data-nedit').split('|');editNote={list:pp[0],ts:+pp[1]};renderLive();setTimeout(function(){var x=$('#ntEdit');if(x){x.focus();x.setSelectionRange(x.value.length,x.value.length)}},50);return}
  if(t.id==='ntEditCancel'){editNote=null;renderLive();return}
  if(t.id==='ntEditSave'){
    var ex=$('#ntEdit'),cc=currentCase();if(!ex||!editNote||!cc)return;
    var en=editNote,val=ex.value.trim(),arr0=cc[en.list]||[],cur=arr0.filter(function(x){return x.ts===en.ts})[0];if(!cur)return;
    if(!val&&!cur.table){toast('A note cannot be empty');return}
    editNote=null;
    if(val===String(cur.text||'').trim()){renderLive();return}
    var narr=arr0.map(function(x){return x.ts===en.ts?Object.assign({},x,{text:val,edited:Date.now()}):x}),oo={};oo[en.list]=narr;patch(openId,oo);toast('Note updated');return;
  }
  var tbb=t.closest&&t.closest('[data-tb]');
  if(tbb){
    var act=tbb.getAttribute('data-tb');
    if(act==='dropnt'){ntTable=null;showPend('nt');return}
    if(act==='droppr'){prTable=null;showPend('pr');return}
    if(act==='nbdel'){var tw0=tbb.closest('.tblwrap'),i0=tw0&&readRows(tw0);if(!i0)return;nbSetTables(i0.arr.filter(function(x,i){return i!==i0.idx}));return}
    var tw=tbb.closest('.tblwrap'),info=tw&&readRows(tw);if(!info)return;
    var rws=info.rows,wd=rws[0]?rws[0].length:1;
    if(act==='addrow'){var nr=[];for(var q=0;q<wd;q++)nr.push({v:''});rws.push(nr)}
    else if(act==='addcol'){rws.forEach(function(r){r.push({v:''})})}
    else if(act==='delrow'){if(rws.length>1)rws.pop()}
    else if(act==='delcol'){if(wd>1)rws.forEach(function(r){r.pop()})}
    commitTbl(info,rws);return;
  }
  if(t.id==='dupBtn'){var sc=cases.filter(function(x){return x.id===openId})[0];if(sc){autoSave();startFrom(sc)}return}
  if(t.id==='addProp'){var sc2=cases.filter(function(x){return x.id===openId})[0],u2=$('#addPropUse')?$('#addPropUse').value:'';if(sc2){autoSave();startFrom(sc2,u2)}return}
  var spb=t.closest&&t.closest('[data-secprop]');if(spb){var sc3=cases.filter(function(x){return x.id===openId})[0],sid3=spb.getAttribute('data-secprop'),s3=sc3&&(sc3.securities||[]).filter(function(s){return s.id===sid3})[0];if(sc3&&s3){autoSave();startFrom(sc3,{btl:'btl',second:'second',holiday:'holiday'}[s3.use]||'',s3.address,sid3)}return}
  if(t.id==='delBtn'){
    if(!t.classList.contains('armed')){t.classList.add('armed');t.textContent='Confirm delete';return}
    var id=openId;closeDrawer();write(id,function(){return col.doc(id).delete()}).then(function(){toast('Case deleted')});return;
  }
  if(t.id==='tkAdd'){
    var tx=$('#tkText').value.trim();if(!tx)return;
    var c2=currentCase();var arr=(c2.tasks||[]).concat([{id:uid(),text:tx,due:$('#tkDue').value||($('#tkTime').value?iso(TODAY):''),time:$('#tkTime').value||'',done:false,created:Date.now(),pri:!!$('#tkPri').checked}]);
    patch(openId,{tasks:arr});return;
  }
  var rt=t.closest('[data-rmtk]');
  if(rt){var c3=currentCase();patch(openId,{tasks:(c3.tasks||[]).filter(function(x){return x.id!==rt.dataset.rmtk})});return}
  if(t.id==='prAll'){var pa=$('#prText');if(pa)prDraft=pa.value;protAll=!protAll;renderLive();return}
  if(t.id==='prHide'){var ph=$('#prText');if(ph)prDraft=ph.value;protHidden=!protHidden;try{localStorage.setItem('protHidden',protHidden?'1':'0')}catch(x){}renderLive();return}
  if(t.id==='prStamp'){var px=$('#prText'),ps2=stampOf(Date.now())+' - ';px.value=px.value.trim()?px.value.replace(/\s*$/,'')+'\n'+ps2:ps2;px.focus();px.setSelectionRange(px.value.length,px.value.length);return}
  if(t.id==='prAdd'){var pt=$('#prText').value.trim();if(!pt&&!prTable)return;prDraft='';var c6=currentCase();lastPD='';var pn={ts:Date.now(),text:pt};if(prTable){pn.table={rows:prTable.rows};prTable=null}patch(openId,{protection:(c6.protection||[]).concat([pn]),protDraft:''});return}
  if(t.id==='ntAll'){var ta2=$('#ntText');if(ta2)ntDraft=ta2.value;notesAll=!notesAll;renderLive();return}
  if(t.id==='ntHide'){
    var ta=$('#ntText');if(ta)ntDraft=ta.value;
    notesHidden=!notesHidden;try{localStorage.setItem('notesHidden',notesHidden?'1':'0')}catch(e){}
    renderLive();return;
  }
  if(t.id==='ntStamp'){
    var tx=$('#ntText'),st=stampOf(Date.now())+' - ';
    tx.value=tx.value.trim()?tx.value.replace(/\s*$/,'')+'\n'+st:st;tx.focus();tx.setSelectionRange(tx.value.length,tx.value.length);return;
  }
  if(t.id==='ntAdd'){
    var nt=$('#ntText').value.trim();if(!nt&&!ntTable)return;ntDraft='';
    var c4=currentCase();lastND='';var nn={ts:Date.now(),text:nt};if(ntTable){nn.table={rows:ntTable.rows};ntTable=null}noteSug=nt?noteSuggest(nt,c4):null;patch(openId,{notes:(c4.notes||[]).concat([nn]),noteDraft:''});return;
  }
});
document.addEventListener('change',function(e){
  var t=e.target;
  if(t.id==='mkTpl'){mkTplId=t.value;mkList();return}
  if(t.id==='mkConsent'){mkConsent=t.value;mkList();return}
  if(t.id==='mkGroup'){mkGroup=t.value;mkList();return}
  if(t.id==='mkImp'){if(t.files&&t.files[0])mkImport(t.files[0]);t.value='';return}
  if(t.matches('[data-trk]')){var f2=trFind(t.dataset.trk);if(f2)trSet(f2,{done:t.checked});return}
  if(t.matches('[data-bdchk]')){var cp2=bdFind(t.getAttribute('data-bdchk'));if(cp2)bdSetSent(cp2,t.checked);return}
  if(t.matches('[data-rtsel]')){if(t.value){nbExec(t.getAttribute('data-rtsel')==='font'?'fontName':'fontSize',t.value)}t.selectedIndex=0;return}
  if(t.matches('[data-rtinput]')){nbExec(t.getAttribute('data-rtinput'),t.value);return}
  if(t.matches('[data-trt]')){var f4=trFind(t.dataset.trt);if(f4)trSet(f4,t.value&&!f4.t.due?{time:t.value,due:iso(TODAY)}:{time:t.value});return}
  if(t.matches('[data-trd]')){var f3=trFind(t.dataset.trd);if(f3)trSet(f3,{due:t.value});return}
  if(t.matches('[data-tk]')){
    var c=currentCase();patch(openId,{tasks:(c.tasks||[]).map(function(x){return x.id===t.dataset.tk?Object.assign({},x,{done:t.checked}):x})});return;
  }
  if(t.id==='stageSel'){stageFilter=t.value;render()}
  if(t.id==='lenderSel'){lenderFilter=t.value;render()}
  if(t.id==='revSel'){revFilter=t.value;render()}
  if(t.getAttribute&&t.getAttribute('data-colk')){var ck=t.getAttribute('data-colk');colsHide=colsHide.filter(function(x){return x!==ck});if(!t.checked)colsHide.push(ck);try{localStorage.setItem('colsHide',JSON.stringify(colsHide))}catch(e){}render();var dp=document.querySelector('.colpick');if(dp)dp.open=true}
  if(t.id==='sortSel'){sortBy=t.value;try{localStorage.setItem('sortBy',sortBy)}catch(e){}render()}
  if(t.id==='fromClient'&&t.value){var s2=cases.filter(function(x){return x.id===t.value})[0];if(s2)startFrom(s2)}
  if(t.id==='pdfIn'){var fl=Array.from(t.files||[]);t.value='';if(fl.length)importPdfs(fl)}
});
document.addEventListener('input',function(e){
  var t=e.target;
  if(t.id==='f-loanAmount'||t.id==='f-purchasePrice'||t.id==='f-propertyValue'){
    var loan=num($('#f-loanAmount').value),v=num($('#f-purchasePrice').value)||num($('#f-propertyValue').value);
    $('#sLtv').textContent=loan&&v?(loan/v*100).toFixed(1)+'%':'—';
  }
  if(t.getAttribute&&t.getAttribute('data-a')==='email'){var el=t.parentNode.querySelector('.el');if(el)el.innerHTML=elinks(t.value)}
  if(t.getAttribute&&t.getAttribute('data-a')==='phone'){var pl=t.parentNode.querySelector('.pl');if(pl)pl.innerHTML=plinks(t.value)}
  if(t.id==='f-fixedUntil'){var ri=$('#f-reviewDate');if(ri){ri.value=t.value?addMonths(t.value,-REVM):'';ri.setAttribute('data-auto','1');updSRev()}}
  if(t.id==='f-reviewDate'){t.setAttribute('data-auto','0');updSRev()}
  if(t.getAttribute&&t.getAttribute('data-s')){
    var scd=t.closest('.sec2'),sk=t.getAttribute('data-s');
    if(scd){
      if(sk==='fixedUntil'){var sr=scd.querySelector('[data-s="reviewDate"]');if(sr&&sr.getAttribute('data-auto')==='1')sr.value=t.value?addMonths(t.value,-REVM):''}
      if(sk==='reviewDate')t.setAttribute('data-auto','0');
      var gv=function(k){var q=scd.querySelector('[data-s="'+k+'"]');return q?q.value.trim():''};
      var sm=scd.querySelector('.secsum');if(sm)sm.textContent=secSumText({lender:gv('lender'),rate:gv('rate'),fixedUntil:gv('fixedUntil'),reviewDate:gv('reviewDate')});
      updSRev();
    }
  }
  if(t.id==='f-oneDriveLink'){var od=$('#odl');if(od)od.innerHTML=odLink(t.value)}
  if(t.id==='calcCase'){var cc=cases.filter(function(x){return x.id===t.value})[0];if(cc){$('#calcAmt').value=cc.loanAmount||'';var yy=cc.termLeft||cc.termYears||'';$('#calcYrs').value=yy;$('#calcMon').value='';$('#calcRate').value=cc.rate||''}calcUpdate()}
  if(t.id==='calcAmt'||t.id==='calcYrs'||t.id==='calcMon'||t.id==='calcRate')calcUpdate();
  if(t.id==='mkQ'){mkQuery=t.value;mkList();return}
  if(t.id==='trQ'){trQuery=t.value;renderTray()}
  if(t.id==='nbTitle'||t.id==='nbBody'){nbSched()}
  if(t.id==='nbQ'){nbQuery=t.value;nbList()}
  if(t.id==='q'){query=t.value;render()}
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&!$('#drawer').hidden)closeDrawer();
  else if(e.key==='Escape'&&trayOpen)closeTray();
  if((e.key==='Enter'||e.key===' ')&&e.target.classList&&e.target.classList.contains('card')){e.preventDefault();openDrawer(e.target.dataset.open)}
  if(e.key==='Enter'&&e.target.hasAttribute&&e.target.hasAttribute('data-pc')){e.preventDefault();var pb=e.target.closest('.sec2').querySelector('[data-pcfind]');if(pb)pcFind(pb);return}
  if(e.key==='Enter'&&(e.target.id==='tkText')){e.preventDefault();$('#tkAdd').click()}
});
/* drag between pipeline stages */
var dragId=null;
document.addEventListener('dragstart',function(e){var c=e.target.closest&&e.target.closest('.card');if(c){dragId=c.dataset.open;e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',dragId)}catch(_){}}});
document.addEventListener('dragover',function(e){var c=e.target.closest&&e.target.closest('.col');if(c&&dragId){e.preventDefault();document.querySelectorAll('.col.over').forEach(function(x){x.classList.remove('over')});c.classList.add('over')}});
document.addEventListener('drop',function(e){
  var c=e.target.closest&&e.target.closest('.col');
  document.querySelectorAll('.col.over').forEach(function(x){x.classList.remove('over')});
  if(c&&dragId){e.preventDefault();var cs=cases.filter(function(x){return x.id===dragId})[0];if(cs&&cs.stage!==c.dataset.stage)patch(dragId,{stage:c.dataset.stage})}
  dragId=null;
});
document.addEventListener('dragend',function(){dragId=null;document.querySelectorAll('.col.over').forEach(function(x){x.classList.remove('over')})});


/* ---------- add case from PDFs ---------- */
function pdfText(file){
  if(!window.pdfjsLib)return Promise.reject(new Error('The PDF reader did not load'));
  return file.arrayBuffer().then(function(buf){
    return pdfjsLib.getDocument({data:new Uint8Array(buf)}).promise;
  }).then(function(pdf){
    var out='',chain=Promise.resolve();
    for(var i=1;i<=pdf.numPages;i++)(function(n){
      chain=chain.then(function(){return pdf.getPage(n)}).then(function(pg){return pg.getTextContent()}).then(function(tc){
        var last=null,line='';
        tc.items.forEach(function(it){
          var y=it.transform[5];
          if(last!==null&&Math.abs(y-last)>2){out+=line+'\n';line=''}
          line+=it.str+' ';last=y;
        });
        out+=line+'\n';
      });
    })(i);
    return chain.then(function(){return out});
  });
}
var DATE_RE=/^\d{4}-\d{2}-\d{2}$/;
function cleanDraft(r){
  var d={},numKeys=['purchasePrice','propertyValue','loanAmount','termYears','rate','followOnRate','monthlyPayment','dipAmount'];
  var strKeys=['propertyAddress','lender','lenderRef','product','erc','conveyancer','estateAgent'];
  var dateKeys=['fixedUntil','reviewDate','dipDate','dipExpiry','appDate','offerDate','offerExpiry','completionDate'];
  strKeys.forEach(function(k){if(typeof r[k]==='string'&&r[k].trim())d[k]=r[k].trim()});
  numKeys.forEach(function(k){var n=num(r[k]);if(n!=null)d[k]=n});
  dateKeys.forEach(function(k){if(typeof r[k]==='string'&&DATE_RE.test(r[k]))d[k]=r[k]});
  d.stage=stageIdx(r.stage)>-1?r.stage:'enquiry';
  d.type=TYPES.indexOf(r.type)>-1?r.type:'Purchase';
  d.repayment=['repayment','interest-only','part-and-part'].indexOf(r.repayment)>-1?r.repayment:'repayment';
  d.applicants=(Array.isArray(r.applicants)?r.applicants:[]).slice(0,4).map(function(a){
    var o={};['name','address','phone','email'].forEach(function(k){if(a&&typeof a[k]==='string')o[k]=a[k].trim()});
    if(a&&typeof a.dob==='string'&&DATE_RE.test(a.dob))o.dob=a.dob;return o;
  }).filter(function(a){return a.name});
  if(!d.applicants.length)d.applicants=[{}];
  return d;
}
function importPdfs(files){
  if(!db){toast('Saving is not available in this view');return}
  toast('Reading '+files.length+' PDF'+(files.length>1?'s':'')+'…',true);
  var texts=[];
  files.reduce(function(chain,f){
    return chain.then(function(){return pdfText(f)}).then(function(t){
      if(t.replace(/\s/g,'').length<80)throw new Error(f.name+' has no readable text. Scanned PDFs are not supported.');
      texts.push('=== FILE: '+f.name+' ===\n'+t);
    });
  },Promise.resolve()).then(function(){
    return claude.use('sample');
  }).then(function(sample){
    if(!sample)throw new Error('Reading documents with Claude is not available in this view');
    toast('Extracting case details…',true);
    var prompt='You extract mortgage case data for a UK mortgage adviser from lender documents (decision in principle, mortgage offer, illustration, or similar). Several files may belong to one case.\n\n'+
    'Return ONLY a JSON object with these keys. Use null for anything the documents do not state. Never guess or invent values.\n'+
    '- applicants: array of {name, address, dob, phone, email}. Name as written in the document, including title. dob as YYYY-MM-DD.\n'+
    '- stage: one of enquiry, factfind, dip, application, offer, completed. A decision in principle only = "dip". A mortgage offer letter = "offer".\n'+
    '- type: one of Purchase, First-time buyer, Remortgage, Product transfer, Further advance, Buy to let, Other.\n'+
    '- propertyAddress (security address, single line), purchasePrice, propertyValue (lender valuation), loanAmount, termYears, repayment ("repayment", "interest-only" or "part-and-part").\n'+
    '- lender, lenderRef (roll number or application reference), product (product code or name), rate (initial rate, percent as a number), fixedUntil (YYYY-MM-DD, end of initial rate period), followOnRate (rate after the initial period, percent), monthlyPayment (regular monthly payment during the initial period, not a one-off first payment), erc (early repayment charge summary as short text).\n'+
    '- dipDate, dipExpiry, dipAmount (maximum amount in a DIP), appDate, offerDate, offerExpiry, completionDate. Dates as YYYY-MM-DD. Use the letter date as dipDate or offerDate for the matching document.\n'+
    '- conveyancer (name and address if given), estateAgent.\n'+
    '- summary: one or two sentences noting anything an adviser should watch, such as term warnings, valuation basis or conditions.\n'+
    'All money values are plain numbers in pounds with no symbols.\n\nDOCUMENTS:\n'+texts.join('\n\n').slice(0,90000);
    return sample.json(prompt,{modelTier:'default'});
  }).then(function(r){
    if(!r||typeof r!=='object')throw new Error('Could not read the case details');
    var d=cleanDraft(r);
    var note='Created from PDF: '+files.map(function(f){return f.name}).join(', ')+'.'+(typeof r.summary==='string'&&r.summary?' '+r.summary:'');
    d.notes=[{ts:Date.now(),text:note}];
    $('#toast').hidden=true;
    openDrawer(null,d);
  }).catch(function(e){
    toast((e&&e.message)||'Could not read the PDFs',false);
  });
}

/* ---------- auto save (every 5 seconds) ---------- */
var lastAuto=null,newBase=null,lastND='',lastPD='';
function draftSave(){
  var a=$('#ntText'),b=$('#prText'),o={};
  if(a&&a.value!==lastND){lastND=a.value;ntDraft=a.value;o.noteDraft=a.value}
  if(b&&b.value!==lastPD){lastPD=b.value;prDraft=b.value;o.protDraft=b.value}
  if(Object.keys(o).length)patch(openId,o).then(function(){var m=$('#autoMsg');if(m)m.textContent='Auto-saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})});
}
var creatingNew=false;
function autoSave(){
  if(!openId&&col&&!creatingNew){
    var dn=$('#drawer');
    if(dn&&!dn.hidden&&$('#caseForm')){
      var nd=collectForm();
      if(nd.applicants.length&&JSON.stringify(nd)!==newBase){
        creatingNew=true;
        if(!nd.clientNo)nd.clientNo=nextClientNo();
        var nref=col.doc();nd.createdAt=Date.now();nd.updatedAt=nd.createdAt;nd.tasks=[];nd.notes=pendingNotes;
        write(nref.id,function(){return nref.set(nd)}).then(function(){
          creatingNew=false;secMoveDone();
          if(!openId&&dn&&!dn.hidden&&$('#caseForm')){openId=nref.id;var cf=$('#f-clientNo');if(cf&&!cf.value)cf.value=nd.clientNo;lastAuto=JSON.stringify(collectForm());var m=$('#autoMsg');if(m)m.textContent='Auto-saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
        },function(){creatingNew=false});
      }
    }
    return;
  }
  if(!openId||!col||lastAuto===null)return;
  var dr=$('#drawer');if(!dr||dr.hidden||!$('#caseForm'))return;
  draftSave();
  var data=collectForm();
  if(!data.applicants.length)return;
  var key=JSON.stringify(data);
  if(key===lastAuto)return;
  lastAuto=key;
  patch(openId,data).then(function(){var m=$('#autoMsg');if(m)m.textContent='Auto-saved '+new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})});
}
setInterval(autoSave,5000);
document.addEventListener('mousedown',function(e){var t=e.target;if(t&&t.closest&&t.closest('#nbBar')&&!t.closest('select')&&!t.closest('input'))e.preventDefault()},true);
document.addEventListener('drop',function(e){var t=e.target;if(t&&t.closest&&t.closest('#nbBody')){e.preventDefault();var tx=(e.dataTransfer&&e.dataTransfer.getData('text/plain'))||'';if(tx)document.execCommand('insertText',false,tx)}},true);
document.addEventListener('paste',function(e){
  var t=e.target;
  if(t&&t.closest&&t.closest('table.nt.xl')){e.preventDefault();var tx=(e.clipboardData&&e.clipboardData.getData('text/plain')||'').replace(/\s+/g,' ');document.execCommand('insertText',false,tx);return}
  if(t&&t.closest&&t.closest('#nbBody')){
    var h2=e.clipboardData&&e.clipboardData.getData('text/html');
    var pl2=(e.clipboardData&&e.clipboardData.getData('text/plain'))||'';
    e.preventDefault();
    if(!h2||!/<table/i.test(h2)){document.execCommand('insertText',false,pl2);return}
    parseTable(h2,function(tb){
      if(!tb){document.execCommand('insertText',false,pl2);return}
      var nn2=notes.filter(function(x){return x.id===nbShown})[0];if(!nn2)return;
      nbSetTables((nn2.tables||[]).concat([{ts:Date.now(),table:{rows:tb.rows}}]));
      toast(tb.cut?'Table added. Only the first 200 rows and 30 columns were kept':'Table added to this note');
    });
    return;
  }
  if(!t||(t.id!=='ntText'&&t.id!=='prText'))return;
  var html=e.clipboardData&&e.clipboardData.getData('text/html');
  if(!html||!/<table/i.test(html))return;
  var plain=e.clipboardData.getData('text/plain'),s0=t.selectionStart,s1=t.selectionEnd,k=t.id==='ntText'?'nt':'pr';
  e.preventDefault();
  parseTable(html,function(tb){
    if(!tb){t.setRangeText(plain,s0,s1,'end');return}
    if(k==='nt')ntTable=tb;else prTable=tb;
    showPend(k);if(tb.cut)toast('That table is large. Only the first 200 rows and 30 columns were kept');
  });
},true);
document.addEventListener('input',function(e){
  var t=e.target;
  if(t&&t.id==='bdQ'){bdQuery=t.value;bdRender();return}
  if(t&&t.getAttribute&&t.getAttribute('data-bdmsg')!==null){bdDraft[t.getAttribute('data-bdmsg')]=t.value;return}
});
document.addEventListener('input',function(e){
  var w=e.target&&e.target.closest&&e.target.closest('.tblwrap');
  if(!w||!e.target.closest('table.nt.xl')||!w.getAttribute('data-ts'))return;
  clearTimeout(tblTimer);tblTimer=setTimeout(function(){saveTbl(w)},700);
});
document.addEventListener('focusout',function(e){
  var w=e.target&&e.target.closest&&e.target.closest('.tblwrap');
  if(!w||!e.target.closest('table.nt.xl')||!w.getAttribute('data-ts'))return;
  clearTimeout(tblTimer);setTimeout(function(){if(document.body.contains(w))saveTbl(w)},50);
});
document.addEventListener('keydown',function(e){
  var td=e.target&&e.target.closest&&e.target.closest('table.nt.xl td');
  if(!td||e.key!=='Enter')return;
  e.preventDefault();
  var tr=td.parentNode,nx=tr.nextElementSibling;
  if(nx){var cell=nx.children[Array.prototype.indexOf.call(tr.children,td)];if(cell)cell.focus()}
});

/* ---------- start ---------- */
render();
claude.use('db').then(function(d){
  db=d;
  if(!db){render();return}
  col=db.collection('cases');
  nbCol=db.collection('notebook');
  apCol=db.collection('appointments');
  mkCol=db.collection('marketing');
  mkCol.onSnapshot(function(s){var d=s.docs.filter(function(x){return x.id==='contacts'})[0];mkItems=(d&&d.data().items)||[];var dm=s.docs.filter(function(x){return x.id==='messages'})[0];mkMsgsDoc=(dm&&dm.data().items)||null;if(view==='marketing'&&!$('#mkOv')&&!mkMsgEdit)mkList()});
  apCol.onSnapshot(function(s){appts=s.docs.map(function(x){return Object.assign({id:x.id},x.data())});if(view==='appointments'&&!$('#apOv'))render();if(view==='tasks'&&!$('#apOv')){var hc2=$('#homeCal');if(hc2)hc2.innerHTML=apHome()}var na=$('#nextAppt');if(na&&openId)na.innerHTML=apNextHtml(openId);renderNav()},function(){});
  nbCol.onSnapshot(function(s){var all=s.docs.map(function(x){return Object.assign({id:x.id},x.data())}),tp=all.filter(function(x){return x.id==='bday-template'})[0];bdCfg=tp?(tp.messages&&tp.messages.length?{messages:tp.messages,signature:tp.signature!=null?tp.signature:''}:(tp.text?{messages:[tp.text],signature:''}:{messages:null,signature:null})):{messages:null,signature:null};bdCfg.islamic=(tp&&tp.islamic&&tp.islamic.length)?tp.islamic:null;var gdoc=all.filter(function(x){return x.id==='bday-gender'})[0];bdGen=(gdoc&&gdoc.map)||{};notes=all.filter(function(x){return x.id!=='bday-template'&&x.id!=='bday-gender'});if(view==='notebook')renderNotebook();if(view==='birthdays'){var a2=document.activeElement;if(!(a2&&a2.id==='bdTplText')){bdTplRender();bdRender()}}},function(){});
  col.onSnapshot(function(snap){
    cases=snap.docs.map(function(x){return Object.assign({id:x.id},x.data())});
    loaded=true;
    var ae=document.activeElement;
    var typing=ae&&(ae.id==='q');
    render();if(trayOpen)renderTray();
    if(typing){var q=$('#q');q.focus&&q.focus()}
    if(openId){var ae2=document.activeElement;if(!(ae2&&(/^(ntText|prText|tkText|ntEdit)$/.test(ae2.id||'')||(ae2.closest&&(ae2.closest('table.nt.xl')||ae2.closest('[data-tkbox]'))))))renderLive()}
  },function(){loaded=true;db=null;render();toast('Lost connection to your saved cases')});
});
})();
