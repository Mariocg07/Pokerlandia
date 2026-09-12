/*
  PokerLandia — client.

  Everything shown here is driven by a state object. Online that object comes
  from the server (and never contains anyone else's hole cards); offline it is
  produced locally by the same engine. One render path, two drivers.
*/
'use strict';

const $ = id => document.getElementById(id);
const E = window.PokerEngine;
const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
const fmt = E.fmt;

/* ===================== sound ===================== */

const sfx = (() => {
  let ctx = null, muted = false;
  function init(){
    try{
      if(!ctx){
        const AC = window.AudioContext || window.webkitAudioContext;
        if(!AC) return;
        ctx = new AC();
      }
      if(ctx.state === 'suspended') ctx.resume();
    }catch(e){ ctx = null; }
  }
  function burst(dur){
    const n = Math.max(1, Math.floor(ctx.sampleRate*dur));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for(let i=0;i<n;i++) d[i] = (Math.random()*2-1)*Math.pow(1-i/n,1.6);
    const s = ctx.createBufferSource(); s.buffer = buf; return s;
  }
  const ok = () => ctx && !muted && ctx.state === 'running';

  function deal(vol){
    if(!ok()) return;
    const t = ctx.currentTime, v = (vol||1)*0.13;
    const s = burst(0.15), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type='bandpass'; f.Q.value=0.9;
    f.frequency.setValueAtTime(700,t);
    f.frequency.exponentialRampToValueAtTime(3400,t+0.11);
    g.gain.setValueAtTime(v,t);
    g.gain.exponentialRampToValueAtTime(0.0008,t+0.15);
    s.connect(f); f.connect(g); g.connect(ctx.destination);
    s.start(t); s.stop(t+0.16);
  }

  function flip(){
    if(!ok()) return;
    const t = ctx.currentTime;
    const s = burst(0.06), f = ctx.createBiquadFilter(), g = ctx.createGain();
    f.type='highpass'; f.frequency.value=2100;
    g.gain.setValueAtTime(0.2,t); g.gain.exponentialRampToValueAtTime(0.0008,t+0.06);
    s.connect(f); f.connect(g); g.connect(ctx.destination);
    s.start(t); s.stop(t+0.07);
    const o = ctx.createOscillator(), og = ctx.createGain();
    o.type='triangle';
    o.frequency.setValueAtTime(430,t);
    o.frequency.exponentialRampToValueAtTime(150,t+0.07);
    og.gain.setValueAtTime(0.11,t); og.gain.exponentialRampToValueAtTime(0.0008,t+0.09);
    o.connect(og); og.connect(ctx.destination);
    o.start(t); o.stop(t+0.1);
  }

  /* the register: drawer snap, then a bright two-note ring */
  function chaching(){
    if(!ok()) return;
    const t = ctx.currentTime;
    const s = burst(0.05), hp = ctx.createBiquadFilter(), g0 = ctx.createGain();
    hp.type='highpass'; hp.frequency.value=2500;
    g0.gain.setValueAtTime(0.2,t); g0.gain.exponentialRampToValueAtTime(0.0008,t+0.05);
    s.connect(hp); hp.connect(g0); g0.connect(ctx.destination);
    s.start(t); s.stop(t+0.06);

    [[1318.5,0.03,0.17],[1760,0.14,0.15],[2637,0.15,0.07]].forEach(([f,at,amp]) => {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain();
      o.type='triangle'; o2.type='sine';
      o.frequency.value=f; o2.frequency.value=f*2.01;
      g.gain.setValueAtTime(0.0001,t+at);
      g.gain.exponentialRampToValueAtTime(amp,t+at+0.01);
      g.gain.exponentialRampToValueAtTime(0.0005,t+at+0.6);
      o.connect(g); o2.connect(g); g.connect(ctx.destination);
      o.start(t+at); o.stop(t+at+0.65);
      o2.start(t+at); o2.stop(t+at+0.65);
    });
  }

  return { init, deal, flip, chaching,
           toggle(){ init(); muted = !muted; return muted; } };
})();

$('sndBtn').addEventListener('click', () => {
  const m = sfx.toggle();
  $('sndBtn').classList.toggle('off', m);
  $('sndBtn').innerHTML = m ? '&#9834;' : '&#9835;';
});

/* ===================== screens ===================== */

const SCREENS = ['welcome','lobby','results'];
function show(name){
  SCREENS.forEach(s => $(s).classList.toggle('hide', s !== name));
  $('conn').style.display = name === 'welcome' || name === 'lobby' ? '' : 'none';
}
function hideAll(){ SCREENS.forEach(s => $(s).classList.add('hide')); $('conn').style.display='none'; }

/* ===================== networking ===================== */

let ws = null, myCid = null, room = null, online = false;

function connect(){
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try { ws = new WebSocket(proto + '//' + location.host); }
  catch(e){ setConn('offline only', true); return; }

  ws.onopen = () => {
    setConn('connected');
    send({ t:'name', name: myName() });
    send({ t:'listRooms' });
  };
  ws.onclose = () => {
    setConn('disconnected', true);
    if(online){ online = false; toast('Lost the connection to the table.'); show('welcome'); }
    setTimeout(connect, 3000);
  };
  ws.onerror = () => setConn('offline only', true);
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch(e){ return; }
    handle(m);
  };
}
const send = o => { if(ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function setConn(text, bad){
  $('conn').textContent = text;
  $('conn').classList.toggle('bad', !!bad);
}

function handle(m){
  switch(m.t){
    case 'hello': myCid = m.cid; break;
    case 'publicRooms': renderRooms(m.rooms); break;
    case 'room': room = m.room; online = true; renderLobby(); break;
    case 'left': room = null; online = false; show('welcome'); break;
    case 'error': toast(m.msg); break;
    case 'state': queueState(m); break;
  }
}

function toast(msg){
  veil('Hold on', msg, 'OK', () => {});
}

/* ===================== welcome ===================== */

const myName = () => ($('nameFld').value || '').trim().slice(0,12) || 'Player';
try{
  const saved = window.sessionStorage && sessionStorage.getItem('pl-name');
  if(saved) $('nameFld').value = saved;
}catch(e){}
$('nameFld').addEventListener('input', () => {
  try{ sessionStorage.setItem('pl-name', myName()); }catch(e){}
  send({ t:'name', name: myName() });
});

$('btnPublic').addEventListener('click', () => { sfx.init(); send({t:'name',name:myName()}); send({t:'joinPublic'}); });
$('btnPrivate').addEventListener('click', () => { sfx.init(); send({t:'name',name:myName()}); send({t:'createRoom', isPublic:false}); });
$('btnCode').addEventListener('click', () => {
  sfx.init();
  const code = ($('codeFld').value||'').trim().toUpperCase();
  if(code.length < 4) return toast('Enter the 5-letter table code.');
  send({t:'name',name:myName()}); send({t:'joinCode', code});
});
$('btnOffline').addEventListener('click', () => { sfx.init(); startOffline(); });

function renderRooms(list){
  const el = $('roomList');
  if(!list || !list.length){
    el.innerHTML = '<div class="empty">No public tables open yet — start one and others can sit down.</div>';
    return;
  }
  el.innerHTML = list.map(r => `
    <div class="slot-row">
      <span class="code">${esc(r.code)}</span>
      <span class="cnt">${r.players} seated${r.started?' · in play':''}</span>
      ${r.started?'<span class="cnt" style="flex:none">running</span>'
                 :`<button class="sit" data-join="${esc(r.code)}">Sit down</button>`}
    </div>`).join('');
}
$('roomList').addEventListener('click', e => {
  const b = e.target.closest('[data-join]');
  if(b){ sfx.init(); send({t:'name',name:myName()}); send({t:'joinCode', code:b.dataset.join}); }
});

/* ===================== lobby ===================== */

const STACKS = [2500, 5000, 10000, 25000];
const SPEEDS = [
  {label:'Turbo',    hands:4,  note:'Blinds jump every four hands. A winner inside twenty minutes.'},
  {label:'Standard', hands:8,  note:'Blinds step up every eight hands. Room to actually play poker.'},
  {label:'Slow',     hands:15, note:'Blinds step up every fifteen hands. Deep stacks most of the night.'}
];

function renderLobby(){
  if(!room) return;
  show('lobby');
  const priv = !room.isPublic;
  $('codeBox').classList.toggle('pub', !priv);
  $('lobbyKind').textContent = priv ? 'Private table' : 'Public table';
  $('lobbyCode').textContent = room.code;
  $('lobbyNote').textContent = priv
    ? 'Share this code — only people who have it can join'
    : 'Anyone online can sit down at this table';

  $('seatList').innerHTML = room.seats.map(s => `
    <div class="seatrow">
      <span class="av ${s.bot?'bot':''}"></span>
      <span class="who">${esc(s.name)}</span>
      <span class="role ${s.you?'you':''}">${s.you?'You':(s.bot?'Computer':'Player')}</span>
    </div>`).join('');

  $('hostBox').classList.toggle('hide', !room.youAreHost);
  $('waitBox').classList.toggle('hide', room.youAreHost);

  if(room.youAreHost){
    $('stackRow').innerHTML = STACKS.map(s =>
      `<button class="opt ${s===room.stack?'on':''}" data-stack="${s}">${fmt(s)}</button>`).join('');
    $('speedRow').innerHTML = SPEEDS.map(s =>
      `<button class="opt ${s.hands===room.speed?'on':''}" data-hands="${s.hands}">${s.label}</button>`).join('');
    const sp = SPEEDS.find(s => s.hands === room.speed);
    $('speedNote').textContent = sp ? sp.note : '';
    if(document.activeElement !== $('stackFld')) $('stackFld').value = room.stack;
  }
}

$('lobby').addEventListener('click', e => {
  const t = e.target.closest('button'); if(!t) return;
  if(t.dataset.stack) send({t:'config', stack:+t.dataset.stack, speed:room.speed});
  else if(t.dataset.hands) send({t:'config', stack:room.stack, speed:+t.dataset.hands});
  else if(t.id==='btnBot') send({t:'addBot'});
  else if(t.id==='btnStart') send({t:'start'});
  else if(t.id==='btnLeave') send({t:'leave'});
});
$('stackFld').addEventListener('change', () => {
  const v = parseInt($('stackFld').value,10);
  if(v>=100 && room) send({t:'config', stack:v, speed:room.speed});
});

/* ===================== table state & animation ===================== */

let g = null;                 // the view we are rendering
let queue = [], animating = false;
let shownBoard = 0, boardFaceUp = 0, heroFaceUp = 0;
let freshCards = new Set(), freshHero = new Set(), tokenSpin = false;
let lastLevel = -1;

function queueState(m){ queue.push(m); pump(); }

function pump(){
  if(animating || !queue.length) return;
  const m = queue.shift();
  g = m.g;
  runAnim(m.anim, () => { pump(); });
}

function runAnim(anim, done){
  hideAll();

  if(anim === 'newhand'){
    shownBoard = 0; boardFaceUp = 0; heroFaceUp = 0;
    freshCards.clear(); freshHero.clear();
    tokenSpin = true; sizerVal = 0;
    render();
    if(g.level !== lastLevel){
      lastLevel = g.level;
      say(`Blinds ${fmt(g.blinds.sb)} and ${fmt(g.blinds.bb)}`);
    } else say('Shuffling up');
    animating = true;
    setTimeout(() => dealAnimation(() => revealHero(() => {
      animating = false; render(); done();
    })), 220);
    return;
  }

  if(anim === 'street' && shownBoard < g.board.length){
    animating = true;
    revealStreet(() => { animating = false; done(); });
    return;
  }

  if(anim === 'showdown'){
    shownBoard = g.board.length;
    boardFaceUp = g.board.length;
    heroFaceUp = 2;
    render();
    say(g.message);
    if(g.winners.indexOf(g.you) >= 0) sfx.chaching();
    done();
    return;
  }

  if(anim === 'over'){
    shownBoard = g.board.length; boardFaceUp = g.board.length;
    render();
    if(g.winners.indexOf(g.you) >= 0) sfx.chaching();
    const champ = g.players[g.finished[g.finished.length-1]];
    if(champ) say(`${champ.name} takes the table`);
    setTimeout(showResults, 2600);
    done();
    return;
  }

  render();
  done();
}

/* ---- dealer speech ---- */
let speechTimer = null;
function say(text){
  const el = $('speechTxt');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(speechTimer);
  speechTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

/* ---- geometry & pieces ---- */
const TABLE = {cx:50, cy:54, rx:44, ry:38};
function seatPositions(n){
  const out = [], {cx,cy,rx,ry} = TABLE;
  for(let i=0;i<n;i++){
    const a = (200 - (i+1)*(220/(n+1))) * Math.PI/180;
    out.push({x: cx + rx*Math.cos(a), y: cy - ry*Math.sin(a)});
  }
  return out;
}

function tokensHTML(id){
  const p = g.players[id];
  if(!p || !p.alive) return '';
  const sp = tokenSpin ? ' spin' : '';
  let out = '';
  if(id === g.button) out += `<span class="tok d${sp}">D</span>`;
  if(id === g.sbId)   out += `<span class="tok sb${sp}">SB</span>`;
  if(id === g.bbId)   out += `<span class="tok bb${sp}">BB</span>`;
  return out;
}

function cardHTML(c, cls, fresh){
  cls = cls || '';
  if(!c) return `<div class="card back ${cls}"></div>`;
  const red = c.s==='h' || c.s==='d';
  return `<div class="card ${red?'red':''} ${cls} ${fresh?'deal':''}">
    <span class="r">${E.RANK_CH[c.r]}</span><span class="s">${E.SUIT_CH[c.s]}</span></div>`;
}
function inWin(c){
  return g.winningCards && g.winningCards.some(w => w.r===c.r && w.s===c.s);
}

/* ---- render ---- */
function render(){
  if(!g) return;
  const bl = g.blinds;
  $('hBlinds').innerHTML = fmt(bl.sb)+'<em>/</em>'+fmt(bl.bb);
  $('hLevel').textContent = g.level+1;
  $('hHand').textContent = g.handNo;

  const actor = g.toAct >= 0 ? g.players[g.toAct] : null;
  const others = g.players.filter(p => p.id !== g.you);
  const pos = seatPositions(others.length);

  $('seats').innerHTML = others.map((p,i) => {
    const acting = actor && actor.id===p.id;
    const hole = !p.alive || p.folded ? ''
      : (p.cards ? p.cards.map(c=>cardHTML(c,'xs')).join('')
                 : cardHTML(null,'xs')+cardHTML(null,'xs'));
    const bubble = p.lastAction
      ? `<div class="said on ${p.folded?'grey':''}">${esc(p.lastAction)}</div>` : '';
    return `<div class="seat ${acting?'acting':''} ${p.folded&&p.alive?'folded':''} ${!p.alive?'out':''}"
                 data-id="${p.id}" style="left:${pos[i].x}%;top:${pos[i].y}%">
      <div class="ring"></div>
      ${bubble}
      <div class="plate">
        <div class="ptop">${tokensHTML(p.id)}<span class="ch">${p.alive?fmt(p.chips):'Out'}</span></div>
        <div class="nm">${esc(p.name)}</div>
      </div>
      <div class="hole">${hole}</div>
    </div>`;
  }).join('');

  $('board').innerHTML = g.board.slice(0, shownBoard).map((c,i) =>
    i < boardFaceUp ? cardHTML(c, inWin(c)?'lit':'', freshCards.has(i))
                    : cardHTML(null,'')).join('');
  freshCards.clear();

  const live = g.pot + g.players.reduce((a,p)=>a+p.bet,0);
  $('potline').innerHTML = live>0
    ? `<span class="k">Pot</span><span class="v">${fmt(live)}</span>` : '';

  renderYou(actor);
  tokenSpin = false;
}

function renderYou(actor){
  const me = g.players[g.you];
  const mine = actor && actor.id===g.you;
  $('you').classList.toggle('acting', !!mine);
  const toks = tokensHTML(me.id);
  $('youName').innerHTML = (toks?`<span class="youtoks">${toks}</span>`:'') + esc(me.name);
  $('youStack').textContent = me.alive ? fmt(me.chips) : 'Out';

  $('youCards').innerHTML = (me.cards && me.alive)
    ? me.cards.map((c,i) => i < heroFaceUp
        ? cardHTML(c,'big'+(inWin(c)?' lit':''), freshHero.has(i))
        : cardHTML(null,'big')).join('')
    : cardHTML(null,'big')+cardHTML(null,'big');
  freshHero.clear();
  $('youCards').style.opacity = me.folded && me.alive ? '.4' : '1';

  let sub = '';
  if(!me.alive) sub = 'Eliminated';
  else if(me.folded) sub = 'Folded this hand';
  else if(mine) sub = 'Your turn';
  else if(me.allIn) sub = 'All in';
  else if(actor) sub = actor.name + ' to act';
  else if(g.phase==='showdown') sub = 'Hand complete';
  $('youSub').textContent = sub;

  $('controls').innerHTML = mine ? controlsHTML(me) : '<div style="height:46px"></div>';
}

/* your legal options, worked out from the same numbers the server used */
function legal(me){
  const toCall = Math.min(g.currentBet - me.bet, me.chips);
  return {
    toCall,
    canCheck: toCall === 0,
    minTotal: Math.min(g.currentBet + g.minRaise, me.bet + me.chips),
    maxTotal: me.bet + me.chips,
    canRaise: me.bet + me.chips > g.currentBet
  };
}

let sizerVal = 0;
function controlsHTML(p){
  const L = legal(p), bl = g.blinds;
  if(sizerVal < L.minTotal || sizerVal > L.maxTotal) sizerVal = L.minTotal;
  const potNow = g.pot + g.players.reduce((a,x)=>a+x.bet,0);
  const isRaise = g.currentBet > 0;

  let sizer = '';
  if(L.canRaise && L.minTotal < L.maxTotal){
    sizer = `<div class="sizer">
      <div class="top"><span class="k">${isRaise?'Raise to':'Bet'}</span>
        <span class="v" id="sizeAmt">${fmt(sizerVal)}</span></div>
      <input type="range" id="sizeRange" min="${L.minTotal}" max="${L.maxTotal}"
             step="${Math.max(1,Math.round(bl.bb/2))}" value="${sizerVal}">
      <div class="quick">
        <button data-size="min">Min</button>
        <button data-size="half" ${Math.round(potNow*.5)>=L.maxTotal?'disabled':''}>Half pot</button>
        <button data-size="pot" ${Math.round(potNow)>=L.maxTotal?'disabled':''}>Pot</button>
        <button data-size="max">All in</button>
      </div></div>`;
  }
  const callLbl = L.canCheck ? 'Check' : (L.toCall>=p.chips ? 'Call all in' : 'Call');
  const callSub = L.canCheck ? '' : `<small>${fmt(L.toCall)}</small>`;
  let raiseBtn = '';
  if(L.canRaise){
    const lbl = L.minTotal>=L.maxTotal ? 'All in' : (isRaise?'Raise':'Bet');
    raiseBtn = `<button class="b-raise" data-act="raise">${lbl}<small>${fmt(sizerVal)}</small></button>`;
  }
  return sizer + `<div class="acts">
    <button class="b-fold" data-act="fold">Fold</button>
    <button class="b-call" data-act="${L.canCheck?'check':'call'}">${callLbl}${callSub}</button>
    ${raiseBtn}</div>`;
}

document.addEventListener('input', e => {
  if(e.target.id==='sizeRange'){
    sizerVal = +e.target.value;
    $('sizeAmt').textContent = fmt(sizerVal);
    const s = document.querySelector('[data-act="raise"] small');
    if(s) s.textContent = fmt(sizerVal);
  }
});

$('you').addEventListener('click', e => {
  const t = e.target.closest('button');
  if(!t || animating || !g) return;
  const me = g.players[g.you];
  if(g.toAct !== g.you) return;

  if(t.dataset.size){
    const L = legal(me);
    const potNow = g.pot + g.players.reduce((a,x)=>a+x.bet,0);
    const map = { min:L.minTotal,
                  half:Math.round(potNow*0.5 + L.toCall + me.bet),
                  pot: Math.round(potNow + L.toCall + me.bet),
                  max: L.maxTotal };
    sizerVal = Math.max(L.minTotal, Math.min(map[t.dataset.size], L.maxTotal));
    render();
    return;
  }
  if(t.dataset.act){
    const act = t.dataset.act==='raise' ? {type:'raise', to:sizerVal} : {type:t.dataset.act};
    sizerVal = 0;
    $('controls').innerHTML = '<div style="height:46px"></div>';
    submit(act);
  }
});

function submit(act){
  if(online) send({t:'action', act});
  else offlineAction(act);
}

/* ===================== animation pieces ===================== */

function pitch(){
  const arm = $('opArm');
  if(!arm) return;
  arm.classList.remove('pitch');
  void arm.offsetWidth;
  arm.classList.add('pitch');
}

function handOrigin(){
  const h = $('opHand');
  if(h){ const r = h.getBoundingClientRect(); if(r.width) return r; }
  return $('dealer').getBoundingClientRect();
}

function dealAnimation(done){
  const stage = $('stage');
  const sRect = stage.getBoundingClientRect();
  const dRect = handOrigin();
  const order = [];
  const live = g.players.filter(p => p.alive);
  for(let round=0; round<2; round++) for(const p of live) order.push(p.id);

  let i = 0;
  (function fly(){
    if(i >= order.length){ setTimeout(done, 200); return; }
    const id = order[i++];
    const target = id===g.you ? $('youCards')
                              : document.querySelector('.seat[data-id="'+id+'"] .hole');
    if(!target){ fly(); return; }
    const t = target.getBoundingClientRect();
    const c = document.createElement('div');
    c.className = 'card back flying';
    const x0 = dRect.left - sRect.left + dRect.width/2 - 19;
    const y0 = dRect.top  - sRect.top  + dRect.height/2 - 26;
    c.style.left = x0+'px'; c.style.top = y0+'px';
    stage.appendChild(c);
    const dx = (t.left - sRect.left + t.width/2 - 19) - x0;
    const dy = (t.top  - sRect.top  + t.height/2 - 26) - y0;
    requestAnimationFrame(() => {
      c.style.transform = `translate(${dx}px,${dy}px) rotate(${(Math.random()*26-13).toFixed(1)}deg) scale(.7)`;
    });
    pitch(); sfx.deal(0.85);
    setTimeout(() => { c.style.opacity='0'; setTimeout(()=>c.remove(),220); }, 330);
    setTimeout(fly, 145);
  })();
}

function revealHero(done){
  const me = g.players[g.you];
  const el = $('youCards');
  heroFaceUp = 0;
  if(!me || !me.alive || !me.cards){ heroFaceUp = 2; render(); done(); return; }
  el.classList.add('stacked');
  render();
  sfx.deal(0.8);
  setTimeout(() => {
    el.classList.remove('stacked');
    sfx.deal(0.6);
    setTimeout(() => {
      let i = 0;
      (function turn(){
        if(i >= me.cards.length){ heroFaceUp = me.cards.length; done(); return; }
        freshHero.add(i);
        heroFaceUp = ++i;
        sfx.flip();
        render();
        setTimeout(turn, 200);
      })();
    }, 350);
  }, 290);
}

function revealStreet(done){
  const from = shownBoard;
  const to = shownBoard===0 ? Math.min(3, g.board.length) : shownBoard+1;
  shownBoard = to;
  render();
  const label = to===3 ? 'Flop' : to===4 ? 'Turn' : 'River';
  say(label);
  dealBoard(from, to, () => {
    setTimeout(() => {
      if(shownBoard < g.board.length) revealStreet(done);
      else done();
    }, 460);
  });
}

function dealBoard(from, to, done){
  const stage = $('stage');
  const slots = Array.prototype.slice.call($('board').children, from);
  if(!slots.length){ done(); return; }

  const sR = stage.getBoundingClientRect();
  const dR = handOrigin();
  const finals = slots.map(el => el.getBoundingClientRect());
  if(!finals[0].width){
    boardFaceUp = to; for(let i=from;i<to;i++) freshCards.add(i);
    render(); sfx.flip(); done(); return;
  }
  slots.forEach(el => el.style.visibility = 'hidden');

  const single = finals.length === 1;
  const midIx = Math.floor((finals.length-1)/2);
  const mid = finals[midIx];

  const ghosts = finals.map((f,i) => {
    const gh = document.createElement('div');
    gh.className = 'card back flying';
    gh.style.width = f.width+'px'; gh.style.height = f.height+'px';
    gh.style.left = (dR.left - sR.left + dR.width/2 - f.width/2)+'px';
    gh.style.top  = (dR.top  - sR.top  + dR.height/2 - f.height/2)+'px';
    gh.style.transform = `scale(.7) rotate(${-7+i*6}deg)`;
    gh.style.zIndex = 30+i;
    stage.appendChild(gh);
    return gh;
  });

  const to_ = (gh,f,ox,oy,rot) => {
    const x = f.left - sR.left - parseFloat(gh.style.left) + (ox||0);
    const y = f.top  - sR.top  - parseFloat(gh.style.top)  + (oy||0);
    return `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)` + (rot?` rotate(${rot}deg)`:'');
  };

  pitch(); sfx.deal();
  requestAnimationFrame(() => {
    ghosts.forEach((gh,i) => {
      gh.style.transform = single ? to_(gh, finals[i])
                                  : to_(gh, mid, i*2.2, -i*2.6, (i-midIx)*2.5);
    });
  });

  if(!single) setTimeout(() => {
    sfx.deal(0.7);
    ghosts.forEach((gh,i) => { gh.style.transform = to_(gh, finals[i]); });
  }, 430);

  setTimeout(() => {
    ghosts.forEach(gh => gh.remove());
    slots.forEach(el => el.style.visibility = '');
    let i = 0;
    (function turn(){
      if(i >= finals.length){ done(); return; }
      const idx = from + i; i++;
      boardFaceUp = Math.max(boardFaceUp, idx+1);
      freshCards.add(idx);
      sfx.flip();
      render();
      setTimeout(turn, 210);
    })();
  }, single ? 400 : 830);
}

/* ===================== veil & results ===================== */

let veilCb = null;
function veil(title, text, btn, cb){
  $('veilTitle').textContent = title;
  $('veilText').textContent = text;
  $('veilBtn').textContent = btn;
  $('veil').classList.remove('hide');
  veilCb = cb;
}
$('veilBtn').addEventListener('click', () => {
  sfx.init();
  $('veil').classList.add('hide');
  const c = veilCb; veilCb = null; if(c) c();
});

function showResults(){
  const order = g.finished.slice().reverse();
  if(!order.length) return;
  $('resTitle').textContent = g.players[order[0]].name + ' wins';
  $('resList').innerHTML = order.map((id,i) => {
    const p = g.players[id];
    const note = i===0 ? fmt(p.chips)+' chips' : i===1 ? 'Runner-up' : '';
    return `<div class="board-row"><span class="pos">${i+1}</span>
      <span class="who">${esc(p.name)}</span><span class="amt">${note}</span></div>`;
  }).join('');
  show('results');
}
$('btnAgain').addEventListener('click', () => {
  if(online){ if(room) renderLobby(); else show('welcome'); }
  else show('welcome');
});

/* ===================== offline driver ===================== */

let LG = null, offTimer = null, offPrevBoard = 0;

function startOffline(){
  online = false;
  const seats = [{name: myName(), bot:false},
                 {name:'Marisol', bot:true}, {name:'Ruiz', bot:true},
                 {name:'Okafor', bot:true}, {name:'Delgado', bot:true}];
  LG = E.createGame(seats, 10000, 8);
  offPrevBoard = 0; lastLevel = -1;
  feed('newhand');
  offTimer = setTimeout(offDrive, 2600);
}
function feed(anim){ queueState({ anim, g: E.view(LG, 0) }); }

function offDrive(){
  clearTimeout(offTimer);
  if(!LG) return;
  if(LG.phase === 'over'){ feed('over'); return; }
  if(LG.phase === 'showdown'){
    feed('showdown');
    offTimer = setTimeout(() => {
      E.newHand(LG); offPrevBoard = 0; feed('newhand');
      offTimer = setTimeout(offDrive, 2600);
    }, 6000);
    return;
  }
  if(LG.phase === 'runout'){
    offTimer = setTimeout(() => { E.runoutRest(LG); offAfter(); }, 1400);
    return;
  }
  const p = LG.players[LG.toAct];
  feed('turn');
  if(p.bot){
    offTimer = setTimeout(() => {
      E.applyAction(LG, p, E.botAction(LG, p));
      offAfter();
    }, 800 + Math.random()*700);
  }
}
function offAfter(){
  if(LG.board.length !== offPrevBoard){
    offPrevBoard = LG.board.length;
    feed('street');
    offTimer = setTimeout(offDrive, 2600);
    return;
  }
  offDrive();
}
function offlineAction(act){
  if(!LG || LG.phase !== 'betting') return;
  clearTimeout(offTimer);
  E.applyAction(LG, LG.players[LG.toAct], act);
  offAfter();
}

/* ===================== dust ===================== */
(function motes(){
  try{
    if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  }catch(e){ return; }
  const app = $('app');
  for(let i=0;i<14;i++){
    const m = document.createElement('div');
    m.className = 'mote';
    m.style.left = (18+Math.random()*64)+'%';
    m.style.top  = (8+Math.random()*46)+'%';
    m.style.setProperty('--dx',(Math.random()*40-20).toFixed(0)+'px');
    m.style.setProperty('--dy',(Math.random()*60+30).toFixed(0)+'px');
    m.style.animation = `drift ${(9+Math.random()*10).toFixed(1)}s linear ${(Math.random()*10).toFixed(1)}s infinite`;
    app.appendChild(m);
  }
})();

show('welcome');
connect();
