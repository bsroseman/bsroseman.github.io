// Drives the host referee through whole rounds against an in-memory stand-in for the
// Realtime Database. Run with:  node --test tests/   (from the trading-game folder)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReferee } from '../referee.js';
import { DEFAULT_SETTINGS, PHASES, sumPnl, bestQuotes } from '../engine.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---- a small fake of the database: nested object + multi-path update + change listeners ----
function fakeDb() {
  const data = {};
  const listeners = [];
  const clock = { t: 1_700_000_000_000 };
  let n = 0;
  const walk = (path, create) => {
    const parts = path.split('/').filter(Boolean);
    let o = data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') { if (!create) return [null, null]; o[parts[i]] = {}; }
      o = o[parts[i]];
    }
    return [o, parts[parts.length - 1]];
  };
  const assertNoUndefined = (v, at) => {
    if (v === undefined) throw new Error(`undefined written at ${at} (Firebase would reject this)`);
    if (v && typeof v === 'object') for (const [k, c] of Object.entries(v)) assertNoUndefined(c, `${at}/${k}`);
  };
  const prune = (o) => { // Firebase drops empty objects
    for (const k of Object.keys(o)) {
      if (o[k] && typeof o[k] === 'object') { prune(o[k]); if (!Object.keys(o[k]).length) delete o[k]; }
    }
  };
  const db = {
    data, clock,
    get: async (path) => { const [o, k] = walk(path, false); return o ? structuredClone(o[k] ?? null) : null; },
    update: async (obj) => {
      for (const [path, val] of Object.entries(obj)) {
        assertNoUndefined(val, path);
        const [o, k] = walk(path, true);
        if (val === null) delete o[k]; else o[k] = structuredClone(val);
      }
      prune(data);
      // Firebase fires local listeners synchronously inside the write; mimic that.
      for (const l of listeners) l();
    },
    pushKey: () => 'k' + String(++n).padStart(5, '0'),
    now: () => clock.t,
    onChange: (l) => listeners.push(l),
    read: (path) => { const [o, k] = walk(path, false); return o ? o[k] ?? null : null; },
  };
  return db;
}

// ---- harness: wires a referee to the fake db the way app.js wires it to Firebase ----
function harness({ db = fakeDb(), seed = 5, settings = {} } = {}) {
  const timers = [];
  const room = db.read('rooms/R');
  if (!room) {
    db.data.rooms = { R: { meta: { hostUid: 'H', phase: PHASES.LOBBY, round: 1, settings: { ...DEFAULT_SETTINGS, laps: 2, ...settings } } } };
  }
  const base = 'rooms/R/';
  const adapter = {
    update: (obj) => db.update(Object.fromEntries(Object.entries(obj).map(([k, v]) => [base + k, v]))),
    get: (p) => db.get(base + p),
    pushKey: db.pushKey,
    now: db.now,
  };
  const ref = createReferee({
    hostUid: 'H', db: adapter, rng: seeded(seed),
    schedule: (fn, ms) => { const h = { fn, ms, at: db.clock.t + ms }; timers.push(h); return h; },
    cancel: (h) => { h.cancelled = true; },
    onError: (e) => { throw e; },
  });
  const feed = () => ref.sync({
    meta: db.read(base + 'meta'), pub: db.read(base + 'public') || {}, players: db.read(base + 'players') || {},
    host: db.read(base + 'host'), orders: db.read(base + 'requests/orders') || {}, pending: db.read(base + 'requests/pending') || {},
  });
  db.onChange(feed);
  // zero-sum invariant checked on every single write
  db.onChange(() => {
    const pos = db.read(base + 'public/positions');
    if (pos) assert.deepEqual(sumPnl(pos), { at100: 0, at120: 0 }, 'P&L must sum to zero after every write');
  });
  const h = {
    db, ref, timers,
    pub: () => db.read(base + 'public') || {},
    meta: () => db.read(base + 'meta'),
    priv: (uid) => db.read(base + `private/${uid}`),
    host: () => db.read(base + 'host'),
    addPlayer: async (uid, name) => { await db.update({ [`${base}players/${uid}`]: { name, online: true } }); await ref.idle(); },
    order: async (uid, o) => { db.clock.t += 1; await db.update({ [`${base}requests/orders/${uid}`]: { ...o, ts: db.clock.t } }); await ref.idle(); },
    pending: async (uid, q) => { db.clock.t += 1; await db.update({ [`${base}requests/pending/${uid}`]: { ...q, ts: db.clock.t } }); await ref.idle(); },
    pendingTimer: () => timers.filter(t => !t.cancelled && !t.fired).pop(),
    fireTimer: async () => {
      const t = h.pendingTimer();
      assert.ok(t, 'expected a window timer to be scheduled');
      t.fired = true; db.clock.t = Math.max(db.clock.t, t.at); t.fn(); await ref.idle();
    },
    start: feed,
    mms: () => Object.keys(h.pub().marketMakers || {}),
    turnUid: () => { const p = h.pub(); return p.turnOrder[p.turn.index]; },
    turnNo: () => h.pub().turn.turnNo,
  };
  return h;
}

async function setupRound(h, { players = ['P1', 'P2', 'P3', 'P4', 'P5'], fixedMMs } = {}) {
  for (const p of players) await h.addPlayer(p, `Name ${p}`);
  h.start(); await h.ref.idle();
  await h.ref.startRound({ fixedMMs });
  await h.ref.idle();
  return h;
}

async function openMarket(h, q1 = { bid: 108, ask: 112 }, q2 = { bid: 107, ask: 113 }) {
  const [m1, m2] = h.mms();
  await h.pending(m1, q1);
  await h.pending(m2, q2);
}

// =====================================================================================

test('starting a round deals roles, hides the true value from public data, and waits for opening quotes', async () => {
  const h = await setupRound(harness());
  assert.equal(h.meta().phase, PHASES.QUOTING);
  const pub = h.pub();
  assert.equal(Object.keys(pub.marketMakers).length, 2);
  assert.equal(pub.turnOrder.length, 3);
  assert.equal(pub.informedCount, 2, 'tellInformed defaults to on');
  assert.equal(Object.keys(pub.positions).length, 5);
  for (const uid of h.mms()) assert.equal(pub.positions[uid].passLeft, 0, 'market makers get no pass cards');
  for (const uid of pub.turnOrder) assert.equal(pub.positions[uid].passLeft, 2);

  const hostRec = h.host();
  assert.ok([100, 120].includes(hostRec.trueValue));
  assert.equal(hostRec.informed.length, 2);

  // private cards
  for (const uid of ['P1', 'P2', 'P3', 'P4', 'P5']) {
    const card = h.priv(uid);
    assert.equal(card.role, hostRec.roles[uid]);
    if (card.role === 'informed') assert.equal(card.trueValue, hostRec.trueValue);
    else assert.equal(card.trueValue, undefined, `${card.role} card must not carry the true value`);
  }
  // nothing public leaks the answer or who is informed
  const publicJson = JSON.stringify({ meta: h.meta(), public: pub, players: h.db.read('rooms/R/players') });
  assert.ok(!/trueValue|"informed"|roles/.test(publicJson), 'public data must not contain trueValue, informed, or roles');
});

test('hand-picked market makers are used and settings passed at start are applied', async () => {
  const h = await setupRound(harness(), { fixedMMs: ['P5', 'P2'] });
  assert.deepEqual(h.mms().sort(), ['P2', 'P5']);
});

test('market opens only when both opening quotes are valid, then the first turn starts', async () => {
  const h = await setupRound(harness());
  const [m1, m2] = h.mms();
  await h.pending(m1, { bid: 108, ask: 112 });
  assert.equal(h.meta().phase, PHASES.QUOTING, 'one quote is not enough');
  await h.pending(m2, { bid: 100, ask: 110 });
  assert.equal(h.meta().phase, PHASES.QUOTING, 'spread of 10 rejected');
  assert.match(h.priv(m2).notice.msg, /wider than/);
  await h.pending(m2, { bid: 107, ask: 113 });
  assert.equal(h.meta().phase, PHASES.TRADING);
  assert.deepEqual(h.pub().quotes, { [m1]: { bid: 108, ask: 112 }, [m2]: { bid: 107, ask: 113 } });
  assert.deepEqual(h.pub().turn, { index: 0, lap: 1, turnNo: 1 });
});

test('a buy fills at the best ask, updates both books, hits the tape, and opens a quote window', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  const [m1] = h.mms();
  const t = h.turnUid();
  await h.order(t, { side: 'buy', qty: 2, turnNo: 1 });
  const pub = h.pub();
  assert.deepEqual(pub.positions[t], { shares: 2, cash: -224, passLeft: 2 });
  assert.deepEqual(pub.positions[m1], { shares: -2, cash: 224, passLeft: 0 });
  const tape = Object.values(pub.tape);
  assert.equal(tape.length, 1);
  assert.equal(tape[0].price, 112);
  assert.equal(tape[0].mmUid, m1);
  assert.equal(tape[0].bestBid, 108);
  assert.equal(tape[0].traderSharesAfter, 2);
  assert.equal(h.meta().phase, PHASES.WINDOW);
  assert.equal(pub.windowEndsAt, h.db.clock.t + 3000);
  assert.equal(h.db.read('rooms/R/requests/orders'), null, 'request consumed');
  assert.ok(h.pendingTimer(), 'window timer scheduled');
  assert.equal(h.pendingTimer().ms, 3000);
});

test('a pending quote posted mid-turn never changes that turn\'s price; it goes live after the window', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  const [m1, m2] = h.mms();
  const t1 = h.turnUid();
  // m1 tries to dodge by posting a worse ask while it is the trader's turn
  await h.pending(m1, { bid: 112, ask: 118 });
  assert.deepEqual(h.pub().quotes[m1], { bid: 108, ask: 112 }, 'live quote frozen during the turn');
  await h.order(t1, { side: 'buy', qty: 1, turnNo: 1 });
  const fill = Object.values(h.pub().tape)[0];
  assert.equal(fill.price, 112, 'filled at the frozen live ask');
  // m2 also updates during the window
  await h.pending(m2, { bid: 109, ask: 114 });
  assert.deepEqual(h.pub().quotes[m2], { bid: 107, ask: 113 }, 'still frozen during the window');
  await h.fireTimer();
  assert.equal(h.meta().phase, PHASES.TRADING);
  assert.deepEqual(h.pub().quotes, { [m1]: { bid: 112, ask: 118 }, [m2]: { bid: 109, ask: 114 } });
  assert.deepEqual(h.pub().turn, { index: 1, lap: 1, turnNo: 2 });
  assert.equal(h.pub().windowEndsAt, undefined);
});

test('an invalid pending quote at window close is ignored with a notice and the old live quote stays', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  const [m1] = h.mms();
  await h.order(h.turnUid(), { side: 'sell', qty: 1, turnNo: 1 });
  await h.pending(m1, { bid: 100, ask: 120 });
  await h.fireTimer();
  assert.deepEqual(h.pub().quotes[m1], { bid: 108, ask: 112 });
  assert.match(h.priv(m1).notice.msg, /not applied/);
});

test('orders are rejected with a notice when out of turn, stale, during the window, or oversized', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  const [t1, t2] = h.pub().turnOrder;
  await h.order(t2, { side: 'buy', qty: 1, turnNo: 1 });
  assert.match(h.priv(t2).notice.msg, /not your turn/);
  assert.equal(h.pub().tape, undefined);
  await h.order(t1, { side: 'buy', qty: 5, turnNo: 1 });
  assert.match(h.priv(t1).notice.msg, /between 1 and 3/);
  await h.order(t1, { side: 'buy', qty: 1, turnNo: 0 });
  assert.match(h.priv(t1).notice.msg, /earlier turn/);
  await h.order(t1, { side: 'buy', qty: 1, turnNo: 1 });
  assert.equal(h.meta().phase, PHASES.WINDOW);
  await h.order(t2, { side: 'buy', qty: 1, turnNo: 2 });
  assert.match(h.priv(t2).notice.msg, /not open/);
  assert.equal(Object.keys(h.pub().tape).length, 1);
});

test('pass cards run out, then the trader must trade', async () => {
  const h = await setupRound(harness({ settings: { laps: 3 } }));
  await openMarket(h);
  const t1 = h.turnUid();
  const passAndAdvanceToT1 = async () => {
    await h.order(t1, { side: 'pass', turnNo: h.turnNo() });
    assert.equal(h.meta().phase, PHASES.WINDOW);
    await h.fireTimer();
    // other two traders trade through
    for (let i = 0; i < 2; i++) { await h.order(h.turnUid(), { side: 'buy', qty: 1, turnNo: h.turnNo() }); await h.fireTimer(); }
    assert.equal(h.turnUid(), t1);
  };
  await passAndAdvanceToT1();
  assert.equal(h.pub().positions[t1].passLeft, 1);
  await passAndAdvanceToT1();
  assert.equal(h.pub().positions[t1].passLeft, 0);
  await h.order(t1, { side: 'pass', turnNo: h.turnNo() });
  assert.match(h.priv(t1).notice.msg, /must trade/i);
  assert.equal(h.meta().phase, PHASES.TRADING, 'turn not consumed');
  await h.order(t1, { side: 'sell', qty: 3, turnNo: h.turnNo() });
  assert.equal(h.meta().phase, PHASES.WINDOW);
});

test('tied prices force a choice of market maker, and the choice is honoured', async () => {
  const h = await setupRound(harness());
  await openMarket(h, { bid: 108, ask: 112 }, { bid: 108, ask: 112 });
  const [m1, m2] = h.mms();
  const t = h.turnUid();
  await h.order(t, { side: 'buy', qty: 1, turnNo: 1 });
  assert.match(h.priv(t).notice.msg, /Choose one/);
  assert.equal(h.meta().phase, PHASES.TRADING);
  await h.order(t, { side: 'buy', qty: 1, turnNo: 1, mmUid: m2 });
  const fill = Object.values(h.pub().tape)[0];
  assert.equal(fill.mmUid, m2);
  assert.equal(h.pub().positions[m2].shares, -1);
  assert.equal(h.pub().positions[m1].shares, 0);
});

test('a full round runs to the end, reveals with ranks within role, and a new round resets the room', async () => {
  const h = await setupRound(harness({ seed: 11 }));
  await openMarket(h);
  const rng = seeded(99);
  let guard = 0;
  while (h.meta().phase !== PHASES.ENDED && guard++ < 100) {
    const t = h.turnUid();
    const pos = h.pub().positions[t];
    const side = pos.passLeft > 0 && rng() < 0.2 ? 'pass' : (rng() < 0.5 ? 'buy' : 'sell');
    const best = bestQuotes(h.pub().quotes);
    const makers = side === 'buy' ? best.askMakers : best.bidMakers;
    await h.order(t, { side, qty: 1 + Math.floor(rng() * 3), turnNo: h.turnNo(), mmUid: makers[0] });
    assert.equal(h.meta().phase, PHASES.WINDOW);
    // market makers sometimes move their quotes
    for (const m of h.mms()) if (rng() < 0.5) {
      const q = h.pub().quotes[m];
      const d = rng() < 0.5 ? -1 : 1;
      await h.pending(m, { bid: q.bid + d, ask: q.ask + d });
    }
    await h.fireTimer();
  }
  assert.equal(h.meta().phase, PHASES.ENDED);
  const tape = h.ref.tapeArray();
  assert.equal(tape.length, 2 * 3, 'laps x traders turns');
  assert.deepEqual(tape.map(e => e.turnNo), [1, 2, 3, 4, 5, 6]);

  // CSV export
  const csv = h.ref.csv();
  assert.equal(csv.split('\n').length, 7);
  assert.match(csv.split('\n')[1], /^1,1,1,/);

  // reveal
  await h.ref.reveal(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.REVEAL);
  const rv = h.pub().reveal;
  assert.equal(rv.trueValue, h.host().trueValue);
  assert.equal(rv.results.length, 5);
  for (const r of rv.results) {
    assert.ok(r.rank >= 1 && r.rank <= r.roleSize);
    assert.equal(r.pnl, r.cash + r.shares * rv.trueValue);
  }
  assert.equal(rv.results.filter(r => r.role === 'mm').length, 2);
  assert.equal(rv.results.filter(r => r.role === 'informed').length, 2);
  assert.equal(rv.results.filter(r => r.role === 'noise').length, 1);

  // round 2
  const round1MMs = h.mms();
  await h.ref.newRound(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.LOBBY);
  assert.equal(h.meta().round, 2);
  assert.equal(h.pub().positions, undefined);
  assert.equal(h.pub().tape, undefined);
  assert.equal(h.pub().reveal, undefined);
  assert.deepEqual(Object.keys(h.pub().mmHistory).sort(), round1MMs.slice().sort());
  assert.equal(h.db.read('rooms/R/private'), null);
  assert.equal(h.db.read('rooms/R/host'), null);
  assert.equal(Object.keys(h.db.read('rooms/R/players')).length, 5, 'players stay in the room');

  await h.ref.startRound({ settings: { ...DEFAULT_SETTINGS, laps: 2, numInformed: 3, tellInformed: false } });
  await h.ref.idle();
  assert.ok(h.mms().every(u => !round1MMs.includes(u)), 'new market makers in round 2');
  assert.equal(h.host().informed.length, 3);
  assert.equal(h.pub().informedCount, undefined, 'count hidden when tellInformed is off');
  assert.equal(h.pub().round, 2);
});

test('practice round deals no informed traders and the reveal is flagged as practice', async () => {
  const h = await setupRound(harness({ settings: { practice: true, laps: 1 } }));
  assert.equal((h.host().informed || []).length, 0);
  assert.equal(h.pub().informedCount, 0);
  await openMarket(h);
  while (h.meta().phase !== PHASES.ENDED) {
    await h.order(h.turnUid(), { side: 'buy', qty: 1, turnNo: h.turnNo() });
    await h.fireTimer();
  }
  await h.ref.reveal(); await h.ref.idle();
  assert.equal(h.pub().reveal.practice, true);
});

test('pause cancels the window timer; resume restarts the window; end round and skip work', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  await h.order(h.turnUid(), { side: 'buy', qty: 1, turnNo: 1 });
  const timer = h.pendingTimer();
  await h.ref.pause(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.PAUSED);
  assert.equal(h.meta().resumePhase, PHASES.WINDOW);
  assert.equal(timer.cancelled, true);
  assert.equal(h.pub().windowEndsAt, undefined);
  // a stale timer firing while paused must do nothing
  timer.fn(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.PAUSED);
  await h.ref.resume(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.WINDOW);
  assert.ok(h.pendingTimer());
  await h.fireTimer();
  assert.equal(h.meta().phase, PHASES.TRADING);
  assert.equal(h.pub().turn.turnNo, 2);

  // skip: no pass card used, tape gets a skip row, window opens
  const skipped = h.turnUid();
  await h.ref.skipTurn(); await h.ref.idle();
  assert.equal(h.pub().positions[skipped].passLeft, 2);
  assert.equal(h.ref.tapeArray().at(-1).side, 'skip');
  assert.equal(h.meta().phase, PHASES.WINDOW);
  await h.fireTimer();
  assert.equal(h.pub().turn.turnNo, 3);

  await h.ref.endRound(); await h.ref.idle();
  assert.equal(h.meta().phase, PHASES.ENDED);
  await assert.rejects(h.ref.startRound(), /Not allowed/);
});

test('host reload mid-window: a fresh referee picks up the expired window and continues', async () => {
  const h = await setupRound(harness());
  await openMarket(h);
  await h.order(h.turnUid(), { side: 'sell', qty: 2, turnNo: 1 });
  assert.equal(h.meta().phase, PHASES.WINDOW);
  // simulate the tab closing: throw the referee away, let time pass, build a new one on the same db
  h.ref.destroy();
  h.db.clock.t += 10_000;
  const h2 = harness({ db: h.db });
  h2.start(); await h2.ref.idle();
  const t = h2.pendingTimer();
  assert.ok(t);
  assert.equal(t.ms, 0, 'expired window fires immediately');
  await h2.fireTimer();
  assert.equal(h2.meta().phase, PHASES.TRADING);
  assert.equal(h2.pub().turn.turnNo, 2);
  assert.equal(h2.pub().positions[h.pub().turnOrder[0]].shares, -2, 'positions survived');
});

test('removePlayer only in the lobby; a player who rejoins keeps their position', async () => {
  const h = harness();
  await h.addPlayer('P1', 'A'); await h.addPlayer('P2', 'B'); await h.addPlayer('P3', 'C');
  h.start(); await h.ref.idle();
  await h.ref.removePlayer('P3'); await h.ref.idle();
  assert.equal(h.db.read('rooms/R/players/P3'), null);
  await h.ref.startRound(); await h.ref.idle();
  await assert.rejects(h.ref.removePlayer('P2'), /Not allowed/);
  // "rejoin": the player record is rewritten with the same uid; positions and private card are untouched
  const t = h.pub().turnOrder[0];
  const before = h.pub().positions[t];
  await h.addPlayer(t, 'A again');
  assert.deepEqual(h.pub().positions[t], before);
  assert.ok(h.priv(t).role);
});
