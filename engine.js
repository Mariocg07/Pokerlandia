/*
  PokerLandia — rules engine.
  Runs unchanged in Node (the server) and in the browser (offline play).

  Every function takes the game object `G` explicitly, so one process can run
  as many tables as it likes without them touching each other.
*/
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PokerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['s', 'h', 'd', 'c'];
  const SUIT_CH = { s: '\u2660', h: '\u2665', d: '\u2666', c: '\u2663' };
  const RANK_CH = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const CAT_NAME = ['high card','a pair','two pair','three of a kind','a straight',
                    'a flush','a full house','four of a kind','a straight flush'];

  const fmt = n => Number(n).toLocaleString('en-US');

  /* ---------------- cards ---------------- */

  function makeDeck(){
    const d = [];
    for (let r = 0; r < 13; r++) for (const s of SUITS) d.push({ r, s });
    for (let i = d.length - 1; i > 0; i--){
      const j = Math.floor(Math.random() * (i + 1));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  const COMBO_CACHE = {};
  function combos(n, k){
    const key = n + ':' + k;
    if (COMBO_CACHE[key]) return COMBO_CACHE[key];
    const out = [], cur = [];
    (function rec(start){
      if (cur.length === k){ out.push(cur.slice()); return; }
      for (let i = start; i < n; i++){ cur.push(i); rec(i + 1); cur.pop(); }
    })(0);
    return (COMBO_CACHE[key] = out);
  }

  function score5(cards){
    const ranks = cards.map(c => c.r).sort((x, y) => y - x);
    const flush = cards.every(c => c.s === cards[0].s);

    const counts = {};
    for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
    const groups = Object.keys(counts).map(Number)
      .sort((a, b) => counts[b] - counts[a] || b - a);

    const uniq = [...new Set(ranks)];
    let straightTop = -1;
    if (uniq.length === 5){
      if (uniq[0] - uniq[4] === 4) straightTop = uniq[0];
      else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) straightTop = 3; // wheel
    }

    let cat, tb;
    if (flush && straightTop >= 0){ cat = 8; tb = [straightTop]; }
    else if (counts[groups[0]] === 4){ cat = 7; tb = [groups[0], groups[1]]; }
    else if (counts[groups[0]] === 3 && counts[groups[1]] === 2){ cat = 6; tb = [groups[0], groups[1]]; }
    else if (flush){ cat = 5; tb = ranks; }
    else if (straightTop >= 0){ cat = 4; tb = [straightTop]; }
    else if (counts[groups[0]] === 3){ cat = 3; tb = groups; }
    else if (counts[groups[0]] === 2 && counts[groups[1]] === 2){ cat = 2; tb = groups; }
    else if (counts[groups[0]] === 2){ cat = 1; tb = groups; }
    else { cat = 0; tb = ranks; }

    let v = cat;
    for (let i = 0; i < 5; i++) v = v * 15 + (tb[i] === undefined ? 0 : tb[i] + 1);
    return { value: v, cat, cards };
  }

  function bestHand(cards){
    if (cards.length < 5) return null;
    let best = null;
    for (const combo of combos(cards.length, 5)){
      const s = score5(combo.map(i => cards[i]));
      if (!best || s.value > best.value) best = s;
    }
    return best;
  }

  /* ---------------- structure ---------------- */

  function blindSchedule(stack){
    const base = Math.max(5, Math.round(stack * 0.005 / 5) * 5);
    const steps = [1,1.5,2,3,4,6,8,12,16,24,32,48,64,96,128,192,256,384,512];
    return steps.map(m => {
      const bb = Math.max(10, Math.round(base * 2 * m / 5) * 5);
      return { sb: Math.round(bb / 2), bb, ante: m >= 6 ? Math.round(bb / 5) : 0 };
    });
  }

  function buildPots(players){
    const levels = [...new Set(players.filter(p => p.committed > 0).map(p => p.committed))]
      .sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels){
      let amount = 0;
      const eligible = [];
      for (const p of players){
        amount += Math.min(p.committed, lvl) - Math.min(p.committed, prev);
        if (p.committed >= lvl && !p.folded) eligible.push(p);
      }
      // a tier nobody live contested goes back to whoever put it in
      if (!eligible.length)
        for (const p of players) if (p.committed >= lvl) eligible.push(p);
      if (amount > 0) pots.push({ amount, eligible });
      prev = lvl;
    }
    return pots;
  }

  /* ---------------- game lifecycle ---------------- */

  function createGame(seats, stack, handsPerLevel){
    const G = {
      players: seats.map((s, i) => ({
        id: i, name: s.name, bot: !!s.bot, chips: stack,
        bet: 0, committed: 0, cards: [], folded: false, allIn: false,
        alive: true, lastAction: ''
      })),
      startStack: stack,
      handsPerLevel: handsPerLevel,
      schedule: blindSchedule(stack),
      button: -1, handNo: 0, level: 0,
      deck: [], board: [], street: 0,
      currentBet: 0, minRaise: 0, toAct: -1, acted: [],
      pot: 0, phase: 'idle', revealed: false,
      finished: [], winners: [], winningCards: [], message: '',
      sbId: -1, bbId: -1
    };
    G.button = Math.floor(Math.random() * G.players.length) - 1;
    newHand(G);
    return G;
  }

  const alivePlayers = G => G.players.filter(p => p.alive);
  const inHand      = G => G.players.filter(p => p.alive && !p.folded);
  const canAct      = G => G.players.filter(p => p.alive && !p.folded && !p.allIn);

  function nextAlive(G, from){
    const n = G.players.length;
    for (let i = 1; i <= n; i++){
      const p = G.players[(from + i + n * 2) % n];
      if (p.alive) return p.id;
    }
    return -1;
  }
  function nextActor(G, from){
    let n = from;
    for (let i = 0; i < G.players.length * 2; i++){
      n = nextAlive(G, n);
      if (n < 0) return -1;
      const p = G.players[n];
      if (!p.folded && !p.allIn) return n;
    }
    return -1;
  }
  function actorAtOrAfter(G, id){
    const p = G.players[id];
    if (p && p.alive && !p.folded && !p.allIn) return id;
    return nextActor(G, id);
  }

  function postChips(G, p, amt, isAnte){
    p.chips -= amt;
    if (isAnte){ G.pot += amt; p.committed += amt; }
    else { p.bet += amt; p.committed += amt; }
    if (p.chips === 0) p.allIn = true;
  }

  function newHand(G){
    G.handNo++;
    G.level = Math.min(G.schedule.length - 1, Math.floor((G.handNo - 1) / G.handsPerLevel));
    const bl = G.schedule[G.level];

    G.deck = makeDeck();
    G.board = [];
    G.street = 0;
    G.pot = 0;
    G.revealed = false;
    G.winners = [];
    G.winningCards = [];
    G.message = '';

    for (const p of G.players){
      p.bet = 0; p.committed = 0; p.cards = []; p.folded = !p.alive;
      p.allIn = false; p.lastAction = '';
    }

    G.button = nextAlive(G, G.button);
    const live = alivePlayers(G);
    for (let k = 0; k < 2; k++) for (const p of live) p.cards.push(G.deck.pop());

    if (bl.ante) for (const p of live) postChips(G, p, Math.min(bl.ante, p.chips), true);

    let sbId, bbId;
    if (live.length === 2){ sbId = G.button; bbId = nextAlive(G, G.button); }
    else { sbId = nextAlive(G, G.button); bbId = nextAlive(G, sbId); }
    postChips(G, G.players[sbId], Math.min(bl.sb, G.players[sbId].chips));
    postChips(G, G.players[bbId], Math.min(bl.bb, G.players[bbId].chips));

    G.currentBet = bl.bb;
    G.minRaise = bl.bb;
    G.acted = [];
    G.sbId = sbId;
    G.bbId = bbId;
    G.toAct = actorAtOrAfter(G, live.length === 2 ? sbId : nextAlive(G, bbId));
    G.phase = 'betting';

    if (G.toAct < 0 || canAct(G).length <= 1) finishBetting(G);
  }

  function legalActions(G, p){
    const toCall = Math.min(G.currentBet - p.bet, p.chips);
    const canCheck = toCall === 0;
    const minTotal = Math.min(G.currentBet + G.minRaise, p.bet + p.chips);
    const maxTotal = p.bet + p.chips;
    return { toCall, canCheck, minTotal, maxTotal, canRaise: maxTotal > G.currentBet };
  }

  function applyAction(G, p, act){
    if (G.phase !== 'betting' || G.toAct !== p.id) return false;
    const L = legalActions(G, p);

    if (act.type === 'fold'){
      p.folded = true; p.lastAction = 'folds';
    } else if (act.type === 'check'){
      if (!L.canCheck) return applyAction(G, p, { type: 'call' });
      p.lastAction = 'checks';
    } else if (act.type === 'call'){
      if (L.canCheck){ p.lastAction = 'checks'; }
      else {
        postChips(G, p, L.toCall);
        p.lastAction = p.allIn ? 'all in' : 'calls ' + fmt(L.toCall);
      }
    } else if (act.type === 'raise'){
      if (!L.canRaise) return applyAction(G, p, { type: L.canCheck ? 'check' : 'call' });
      const to = Math.max(L.minTotal, Math.min(Number(act.to) || 0, L.maxTotal));
      const wasBet = G.currentBet > 0;
      postChips(G, p, to - p.bet);
      // an all-in short of the current bet does not reopen the round
      if (to > G.currentBet){
        if (to - G.currentBet >= G.minRaise) G.minRaise = to - G.currentBet;
        G.currentBet = to;
        G.acted = [];
      }
      p.lastAction = p.allIn ? 'all in ' + fmt(to)
                   : (wasBet ? 'raises to ' : 'bets ') + fmt(to);
    } else return false;

    if (G.acted.indexOf(p.id) < 0) G.acted.push(p.id);
    advance(G);
    return true;
  }

  function bettingClosed(G){
    if (inHand(G).length <= 1) return true;
    const actors = canAct(G);
    if (actors.length === 0) return true;
    if (actors.length === 1 && actors[0].bet >= G.currentBet && G.acted.indexOf(actors[0].id) >= 0)
      return true;
    return actors.every(p => G.acted.indexOf(p.id) >= 0 && p.bet === G.currentBet);
  }

  function advance(G){
    if (bettingClosed(G)){ finishBetting(G); return; }
    const n = nextActor(G, G.toAct);
    if (n < 0){ finishBetting(G); return; }
    G.toAct = n;
  }

  function finishBetting(G){
    // hand back the uncalled part of the largest bet
    const sorted = G.players.slice().sort((a, b) => b.bet - a.bet);
    if (sorted.length > 1 && sorted[0].bet > sorted[1].bet){
      const top = sorted[0], refund = top.bet - sorted[1].bet;
      top.chips += refund; top.bet -= refund; top.committed -= refund;
      if (top.chips > 0) top.allIn = false;
    }
    for (const p of G.players){ G.pot += p.bet; p.bet = 0; }
    G.currentBet = 0;
    G.minRaise = G.schedule[G.level].bb;
    G.acted = [];

    if (inHand(G).length <= 1){ G.street = 4; showdown(G); return; }

    G.street++;
    if (G.street === 1){ G.deck.pop(); G.board.push(G.deck.pop(), G.deck.pop(), G.deck.pop()); }
    else if (G.street === 2 || G.street === 3){ G.deck.pop(); G.board.push(G.deck.pop()); }
    else { showdown(G); return; }

    if (canAct(G).length <= 1){ G.phase = 'runout'; return; }

    G.toAct = nextActor(G, G.button);
    if (G.toAct < 0){ G.phase = 'runout'; return; }
    G.phase = 'betting';
  }

  function runoutRest(G){
    while (G.street < 4){
      G.street++;
      if (G.street === 1){ G.deck.pop(); G.board.push(G.deck.pop(), G.deck.pop(), G.deck.pop()); }
      else if (G.street < 4){ G.deck.pop(); G.board.push(G.deck.pop()); }
    }
    showdown(G);
  }

  function showdown(G){
    G.phase = 'showdown';
    G.revealed = inHand(G).length > 1;

    const pots = buildPots(G.players);
    const results = {};
    for (const p of inHand(G))
      results[p.id] = G.board.length === 5 ? bestHand(p.cards.concat(G.board)) : null;

    const wins = {};
    let bestLine = '';

    for (const pot of pots){
      if (!pot.eligible.length) continue;
      const contest = pot.eligible.filter(p => results[p.id]);
      let winners;
      if (contest.length > 1){
        let top = -1; winners = [];
        for (const p of contest){
          const v = results[p.id].value;
          if (v > top){ top = v; winners = [p]; }
          else if (v === top) winners.push(p);
        }
        bestLine = CAT_NAME[results[winners[0].id].cat];
      } else if (contest.length === 1) winners = contest;
      else winners = pot.eligible;               // uncontested tier: a refund

      const share = Math.floor(pot.amount / winners.length);
      let extra = pot.amount - share * winners.length;
      for (const w of winners){
        let amt = share;
        if (extra > 0){ amt++; extra--; }
        w.chips += amt;
        wins[w.id] = (wins[w.id] || 0) + amt;
      }
    }

    G.winners = Object.keys(wins).map(Number);
    G.winAmounts = wins;
    G.winningCards = [];
    if (G.revealed && G.winners.length && results[G.winners[0]])
      G.winningCards = results[G.winners[0]].cards;

    const names = G.winners.map(id => G.players[id].name);
    const total = Object.keys(wins).reduce((a, k) => a + wins[k], 0);
    G.message = names.length === 1
      ? `${names[0]} wins ${fmt(total)}` + (bestLine ? ` with ${bestLine}` : '')
      : `${names.join(' and ')} split ${fmt(total)}`;

    G.pot = 0;

    const busted = G.players.filter(p => p.alive && p.chips === 0);
    busted.sort((a, b) => a.committed - b.committed);
    for (const p of busted){ p.alive = false; G.finished.push(p.id); }
    if (busted.length) G.message += ' \u00b7 ' + busted.map(p => p.name).join(', ') + ' out';

    if (alivePlayers(G).length <= 1){
      const champ = alivePlayers(G)[0];
      if (champ) G.finished.push(champ.id);
      G.phase = 'over';
    }
  }

  /* ---------------- computer opponents ---------------- */

  function handStrength(G, p){
    if (G.board.length === 0){
      const a = p.cards[0], b = p.cards[1];
      const hi = Math.max(a.r, b.r), lo = Math.min(a.r, b.r);
      let v;
      if (a.r === b.r) v = 0.5 + (a.r / 12) * 0.5;
      else {
        v = (hi / 12) * 0.42 + (lo / 12) * 0.18;
        if (a.s === b.s) v += 0.08;
        if (hi - lo === 1) v += 0.05;
        else if (hi - lo === 2) v += 0.02;
      }
      return Math.max(0, Math.min(1, v));
    }
    const best = bestHand(p.cards.concat(G.board));
    if (!best) return 0.3;
    const base = [0.12,0.34,0.55,0.7,0.8,0.86,0.93,0.98,1][best.cat];
    if (G.board.length === 5){
      const boardOnly = score5(G.board);
      if (boardOnly.value === best.value) return base * 0.4;
    }
    return base;
  }

  function botAction(G, p){
    const L = legalActions(G, p);
    const bl = G.schedule[G.level];
    const live = G.pot + G.players.reduce((a, x) => a + x.bet, 0);
    const s = handStrength(G, p) + (Math.random() * 0.12 - 0.06);
    const potOdds = L.toCall / Math.max(1, live + L.toCall);

    if (p.chips < bl.bb * 8 && s > 0.55 && L.canRaise)
      return { type: 'raise', to: L.maxTotal };

    if (L.canCheck){
      if (s > 0.72 && L.canRaise && Math.random() < 0.75)
        return { type: 'raise', to: Math.min(L.maxTotal,
          Math.max(bl.bb, Math.round(live * (0.5 + Math.random() * 0.3)))) };
      if (s < 0.3 && L.canRaise && Math.random() < 0.18)
        return { type: 'raise', to: Math.min(L.maxTotal, Math.max(bl.bb, Math.round(live * 0.5))) };
      return { type: 'check' };
    }
    if (s > 0.8 && L.canRaise && Math.random() < 0.6)
      return { type: 'raise', to: Math.min(L.maxTotal,
        Math.max(G.currentBet + G.minRaise, Math.round((live + L.toCall) * (0.7 + Math.random() * 0.5)))) };
    if (s > potOdds + 0.15) return { type: 'call' };
    if (L.toCall <= bl.bb && s > 0.3) return { type: 'call' };
    return { type: 'fold' };
  }

  /* ---------------- what a given player is allowed to see ---------------- */

  function view(G, youId){
    const bl = G.schedule[G.level];
    return {
      you: youId,
      handNo: G.handNo, level: G.level, phase: G.phase,
      button: G.button, sbId: G.sbId, bbId: G.bbId,
      toAct: G.phase === 'betting' ? G.toAct : -1,
      board: G.board.slice(),
      pot: G.pot,
      currentBet: G.currentBet, minRaise: G.minRaise,
      blinds: { sb: bl.sb, bb: bl.bb, ante: bl.ante },
      revealed: G.revealed,
      winners: G.winners.slice(),
      winningCards: G.winningCards.slice(),
      message: G.message,
      finished: G.finished.slice(),
      players: G.players.map(p => ({
        id: p.id, name: p.name, bot: p.bot, chips: p.chips, bet: p.bet,
        folded: p.folded, allIn: p.allIn, alive: p.alive, lastAction: p.lastAction,
        hasCards: p.cards.length > 0,
        // hole cards only ever leave the table for their owner, or at a showdown
        cards: (p.id === youId || (G.revealed && !p.folded && p.alive)) ? p.cards.slice() : null
      }))
    };
  }

  return {
    SUIT_CH, RANK_CH, CAT_NAME, fmt,
    makeDeck, score5, bestHand, blindSchedule, buildPots,
    createGame, newHand, legalActions, applyAction, runoutRest, botAction,
    view, alivePlayers, inHand, canAct
  };
});
