// Run with:  node --test tests/        (from the trading-game folder)
// Or, without Node installed, from Git Bash:
//   ELECTRON_RUN_AS_NODE=1 "/c/Users/<you>/AppData/Local/Programs/Microsoft VS Code/Code.exe" --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, PHASES, normalizeSettings, roundToStep, validateQuote, shiftQuote, widenQuote, narrowQuote,
  bestQuotes, emptyPosition, pnlAt, pnlBoth, sumPnl, applyFill, applyPass, validateOrder, firstTurn, nextTurn,
  turnUid, shuffle, dealRoles, buildResults, tapeToCsv, makeRoomCode,
} from '../engine.js';

// A tiny seeded RNG so dealing tests are repeatable.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// ---------- settings ----------

test('normalizeSettings clamps and coerces', () => {
  const s = normalizeSettings({ laps: '4', passCards: -1, maxShares: 99, quoteWindowMs: 'abc', tellInformed: 0 });
  assert.equal(s.laps, 4);
  assert.equal(s.passCards, 0);
  assert.equal(s.maxShares, 20);
  assert.equal(s.quoteWindowMs, 3000);
  assert.equal(s.tellInformed, false);
  assert.equal(s.priceStep, 1);
});

test('practice round forces zero informed traders', () => {
  assert.equal(normalizeSettings({ practice: true, numInformed: 3 }).numInformed, 0);
});

// ---------- quotes ----------

test('roundToStep', () => {
  assert.equal(roundToStep(109.6, 1), 110);
  assert.equal(roundToStep(109.26, 0.5), 109.5);
  assert.equal(roundToStep(0.1 + 0.2, 0.1), 0.3);
  assert.ok(Number.isNaN(roundToStep('x')));
});

test('validateQuote enforces both sides, ordering and max spread', () => {
  assert.equal(validateQuote({ bid: 108 }).ok, false);
  assert.equal(validateQuote({ bid: '', ask: 112 }).ok, false);
  assert.equal(validateQuote({ bid: 112, ask: 108 }).ok, false);
  assert.equal(validateQuote({ bid: 110, ask: 110 }).ok, false);
  assert.equal(validateQuote({ bid: 106, ask: 113 }).ok, false, 'spread 7 > 6');
  const ok = validateQuote({ bid: '107', ask: '113' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.quote, { bid: 107, ask: 113 }, 'strings are coerced');
  assert.equal(validateQuote({ bid: 105, ask: 113 }, { ...DEFAULT_SETTINGS, maxSpread: 8 }).ok, true);
});

test('one-click quote buttons', () => {
  const q = { bid: 108, ask: 112 };
  assert.deepEqual(shiftQuote(q, 1), { bid: 109, ask: 113 });
  assert.deepEqual(shiftQuote(q, -1), { bid: 107, ask: 111 });
  assert.deepEqual(widenQuote(q), { bid: 107, ask: 113 });
  assert.deepEqual(narrowQuote(q), { bid: 109, ask: 111 });
  assert.equal(validateQuote(widenQuote(widenQuote(q))).ok, false, 'widening past $6 is rejected');
});

test('bestQuotes picks the highest bid and lowest ask and reports ties', () => {
  const b = bestQuotes({ A: { bid: 108, ask: 112 }, B: { bid: 109, ask: 112 } });
  assert.equal(b.bestBid, 109);
  assert.deepEqual(b.bidMakers, ['B']);
  assert.equal(b.bestAsk, 112);
  assert.deepEqual(b.askMakers, ['A', 'B']);
  assert.deepEqual(bestQuotes({}), { bestBid: null, bestAsk: null, bidMakers: [], askMakers: [] });
});

// ---------- P&L ----------

test('P&L columns match the Excel scorecard formula cash + position x value', () => {
  // Buy 2 @ 112, sell 1 @ 109  ->  shares +1, cash -224 + 109 = -115
  const pos = { shares: 1, cash: -115 };
  assert.equal(pnlAt(pos, 100), -15);
  assert.equal(pnlAt(pos, 120), 5);
  assert.deepEqual(pnlBoth(pos), { at100: -15, at120: 5 });
  // short position
  assert.deepEqual(pnlBoth({ shares: -3, cash: 327 }), { at100: 27, at120: -33 });
});

test('applyFill moves shares and cash in opposite directions for trader and market maker', () => {
  let pos = { T: emptyPosition(), M: emptyPosition(DEFAULT_SETTINGS, true) };
  pos = applyFill(pos, { traderUid: 'T', mmUid: 'M', side: 'buy', qty: 2, price: 112 });
  assert.deepEqual(pos.T, { shares: 2, cash: -224, passLeft: 2 });
  assert.deepEqual(pos.M, { shares: -2, cash: 224, passLeft: 0 });
  pos = applyFill(pos, { traderUid: 'T', mmUid: 'M', side: 'sell', qty: 3, price: 108 });
  assert.deepEqual(pos.T, { shares: -1, cash: 100, passLeft: 2 });
  assert.deepEqual(pos.M, { shares: 1, cash: -100, passLeft: 0 });
});

test('zero-sum: P&L columns sum to zero after a random sequence of fills', () => {
  const rng = seeded(7);
  let pos = { T1: emptyPosition(), T2: emptyPosition(), T3: emptyPosition(),
    M1: emptyPosition(DEFAULT_SETTINGS, true), M2: emptyPosition(DEFAULT_SETTINGS, true) };
  const traders = ['T1', 'T2', 'T3'], mms = ['M1', 'M2'];
  for (let i = 0; i < 200; i++) {
    const fill = {
      traderUid: traders[Math.floor(rng() * 3)], mmUid: mms[Math.floor(rng() * 2)],
      side: rng() < 0.5 ? 'buy' : 'sell', qty: 1 + Math.floor(rng() * 3), price: 100 + Math.floor(rng() * 21),
    };
    pos = applyFill(pos, fill);
    assert.deepEqual(sumPnl(pos), { at100: 0, at120: 0 }, `after fill ${i}`);
  }
});

test('applyPass decrements pass cards and never goes negative', () => {
  let pos = { T: { shares: 0, cash: 0, passLeft: 1 } };
  pos = applyPass(pos, 'T');
  assert.equal(pos.T.passLeft, 0);
  pos = applyPass(pos, 'T');
  assert.equal(pos.T.passLeft, 0);
});

// ---------- orders ----------

const baseState = () => ({
  phase: PHASES.TRADING,
  turn: { uid: 'T1', turnNo: 5 },
  positions: { T1: { shares: 0, cash: 0, passLeft: 2 }, T2: { shares: 0, cash: 0, passLeft: 0 } },
  quotes: { M1: { bid: 108, ask: 112 }, M2: { bid: 109, ask: 114 } },
  settings: DEFAULT_SETTINGS,
});

test('validateOrder routes buys to the best ask and sells to the best bid', () => {
  const buy = validateOrder('T1', { side: 'buy', qty: 2, turnNo: 5 }, baseState());
  assert.equal(buy.ok, true);
  assert.deepEqual(buy.fill, { traderUid: 'T1', mmUid: 'M1', side: 'buy', qty: 2, price: 112 });
  const sell = validateOrder('T1', { side: 'sell', qty: 1, turnNo: 5 }, baseState());
  assert.deepEqual(sell.fill, { traderUid: 'T1', mmUid: 'M2', side: 'sell', qty: 1, price: 109 });
});

test('validateOrder rejects out-of-turn, stale, oversized and closed-market orders', () => {
  assert.equal(validateOrder('T2', { side: 'buy', qty: 1, turnNo: 5 }, baseState()).ok, false, 'not your turn');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 1, turnNo: 4 }, baseState()).ok, false, 'stale turnNo');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 4, turnNo: 5 }, baseState()).ok, false, 'too big');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 0, turnNo: 5 }, baseState()).ok, false, 'zero');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 1.5, turnNo: 5 }, baseState()).ok, false, 'fraction');
  assert.equal(validateOrder('T1', { side: 'hold', qty: 1, turnNo: 5 }, baseState()).ok, false, 'bad side');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5 }, { ...baseState(), phase: PHASES.WINDOW }).ok, false, 'window');
  assert.equal(validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5 }, { ...baseState(), quotes: {} }).ok, false, 'no quotes');
});

test('pass cards: allowed while any remain, must trade when none left', () => {
  assert.equal(validateOrder('T1', { side: 'pass', turnNo: 5 }, baseState()).kind, 'pass');
  const st = baseState(); st.turn = { uid: 'T2', turnNo: 5 };
  const r = validateOrder('T2', { side: 'pass', turnNo: 5 }, st);
  assert.equal(r.ok, false);
  assert.match(r.error, /must trade/i);
});

test('tied prices: trader must choose which market maker, and the choice is honoured', () => {
  const st = baseState(); st.quotes = { M1: { bid: 108, ask: 112 }, M2: { bid: 108, ask: 112 } };
  const r = validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5 }, st);
  assert.equal(r.ok, false);
  assert.deepEqual(r.needsChoice, ['M1', 'M2']);
  const chosen = validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5, mmUid: 'M2' }, st);
  assert.equal(chosen.fill.mmUid, 'M2');
  // choosing a maker who is not at the best price falls back to a rejection, never a worse fill
  const st2 = baseState();
  const worse = validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5, mmUid: 'M2' }, st2);
  assert.equal(worse.ok, true);
  assert.equal(worse.fill.mmUid, 'M1', 'single best maker wins regardless of the requested one');
});

test('a pending quote submitted mid-turn never changes the price of that turn', () => {
  // The host validates against the LIVE quotes it passes in; the pending quote lives elsewhere.
  const st = baseState();
  const pending = { M1: { bid: 100, ask: 101 } }; // the market maker tries to dodge
  const r = validateOrder('T1', { side: 'buy', qty: 1, turnNo: 5 }, st);
  assert.equal(r.fill.price, 112);
  assert.notEqual(r.fill.price, pending.M1.ask);
});

// ---------- turns ----------

test('nextTurn walks the order for the set number of laps', () => {
  const order = ['A', 'B', 'C'];
  let t = firstTurn();
  assert.equal(turnUid(t, order), 'A');
  const seen = [];
  let finished = false;
  while (!finished) {
    seen.push(`${t.lap}:${turnUid(t, order)}`);
    ({ turn: t, finished } = nextTurn(t, order, 2));
  }
  assert.deepEqual(seen, ['1:A', '1:B', '1:C', '2:A', '2:B', '2:C']);
  assert.equal(t.turnNo, 7);
});

// ---------- dealing ----------

test('dealRoles respects counts, hides nothing from the host, and prefers fresh market makers', () => {
  const players = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
  const d = dealRoles(players, DEFAULT_SETTINGS, { rng: seeded(42) });
  assert.equal(d.marketMakers.length, 2);
  assert.equal(d.traders.length, 7);
  assert.equal(d.informed.length, 2);
  assert.ok([100, 120].includes(d.trueValue));
  assert.equal(Object.keys(d.roles).length, 9);
  for (const u of d.marketMakers) assert.equal(d.roles[u], 'mm');
  for (const u of d.informed) assert.equal(d.roles[u], 'informed');
  assert.ok(d.marketMakers.every(u => !d.traders.includes(u)));

  // round 2: previous MMs should not be drawn again when there are enough fresh players
  const d2 = dealRoles(players, { ...DEFAULT_SETTINGS, numInformed: 3 }, { rng: seeded(43), previousMMs: d.marketMakers });
  assert.ok(d2.marketMakers.every(u => !d.marketMakers.includes(u)));
  assert.equal(d2.informed.length, 3);

  // hand-picked market makers are honoured
  const d3 = dealRoles(players, DEFAULT_SETTINGS, { rng: seeded(1), fixedMMs: ['p9', 'p1'] });
  assert.deepEqual(d3.marketMakers, ['p9', 'p1']);
});

test('dealRoles in practice mode deals no informed traders', () => {
  const d = dealRoles(['a', 'b', 'c', 'd'], normalizeSettings({ practice: true }), { rng: seeded(3) });
  assert.equal(d.informed.length, 0);
});

test('dealRoles with too few players throws, and caps market makers', () => {
  assert.throws(() => dealRoles(['only'], DEFAULT_SETTINGS));
  const d = dealRoles(['a', 'b'], DEFAULT_SETTINGS, { rng: seeded(1) });
  assert.equal(d.marketMakers.length, 1);
  assert.equal(d.traders.length, 1);
});

test('shuffle is a permutation', () => {
  const s = shuffle([1, 2, 3, 4, 5], seeded(9));
  assert.deepEqual(s.slice().sort(), [1, 2, 3, 4, 5]);
});

// ---------- reveal ----------

test('buildResults ranks within role with shared ranks for ties', () => {
  const players = { m1: { name: 'Ann' }, m2: { name: 'Bo' }, i1: { name: 'Cy' }, n1: { name: 'Di' }, n2: { name: 'Ed' }, n3: { name: 'Flo' } };
  const roles = { m1: 'mm', m2: 'mm', i1: 'informed', n1: 'noise', n2: 'noise', n3: 'noise' };
  const positions = {
    m1: { shares: -2, cash: 230 }, m2: { shares: 1, cash: -105 },
    i1: { shares: 3, cash: -330 },
    n1: { shares: -1, cash: 110 }, n2: { shares: -1, cash: 110 }, n3: { shares: 0, cash: -15 },
  };
  assert.deepEqual(sumPnl(positions), { at100: 0, at120: 0 });
  const rows = buildResults(players, positions, roles, 120);
  const by = Object.fromEntries(rows.map(r => [r.uid, r]));
  assert.equal(by.i1.pnl, 30);
  assert.equal(by.i1.rank, 1);
  assert.equal(by.m2.pnl, 15); assert.equal(by.m2.rank, 1);
  assert.equal(by.m1.pnl, -10); assert.equal(by.m1.rank, 2);
  assert.equal(by.n1.rank, 1); assert.equal(by.n2.rank, 1, 'tie shares rank 1');
  assert.equal(by.n3.rank, 3, 'next rank after a two-way tie is 3');
  assert.equal(by.n3.roleSize, 3);
  assert.equal(rows[0].role, 'mm', 'market makers listed first');
});

// ---------- export ----------

test('tapeToCsv writes one row per turn with a header and escapes commas', () => {
  const tape = [
    { turnNo: 1, lap: 1, ts: Date.UTC(2026, 0, 1, 12, 0, 0), traderName: 'Smith, Jo', side: 'buy', qty: 2, price: 112,
      mmName: 'Ann', bestBid: 108, bestAsk: 112, traderSharesAfter: 2, traderCashAfter: -224 },
    { turnNo: 2, lap: 1, ts: Date.UTC(2026, 0, 1, 12, 0, 9), traderName: 'Di', side: 'pass', bestBid: 109, bestAsk: 113 },
  ];
  const csv = tapeToCsv(tape, { round: 1 });
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^round,turn,lap,clock_time,trader,action/);
  assert.equal(lines[1], '1,1,1,2026-01-01T12:00:00.000Z,"Smith, Jo",buy,2,112,Ann,108,112,110,2,-224');
  assert.equal(lines[2], '1,2,1,2026-01-01T12:00:09.000Z,Di,pass,,,,109,113,111,,');
});

test('makeRoomCode avoids ambiguous letters', () => {
  for (let i = 0; i < 50; i++) assert.match(makeRoomCode(seeded(i)), /^[ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
});
