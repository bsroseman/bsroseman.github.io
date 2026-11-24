// engine.js — pure game logic for the trading game. No Firebase, no DOM.
// Everything here is deterministic given its inputs, so it can be unit-tested
// (see tests/engine.test.js) and reused by the host referee and the player screens.

export const VALUES = [100, 120];

export const DEFAULT_SETTINGS = Object.freeze({
  laps: 6,
  passCards: 2,
  maxShares: 3,
  maxSpread: 6,
  quoteWindowMs: 3000,
  numMM: 2,
  numInformed: 2,
  tellInformed: true,
  priceStep: 1,
  practice: false,
});

export const PHASES = Object.freeze({
  LOBBY: 'lobby',       // players joining, host choosing settings
  QUOTING: 'quoting',   // round started, waiting for both opening quotes
  TRADING: 'trading',   // a trader's turn; live quotes frozen
  WINDOW: 'window',     // quote window after a fill; countdown running
  PAUSED: 'paused',     // host paused; resumePhase holds where to go back to
  ENDED: 'ended',       // all laps done, waiting for reveal
  REVEAL: 'reveal',     // results published
});

// ---------- settings ----------

export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const int = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  s.laps = int(s.laps, 1, 50, 6);
  s.passCards = int(s.passCards, 0, 20, 2);
  s.maxShares = int(s.maxShares, 1, 20, 3);
  s.maxSpread = int(s.maxSpread, 1, 40, 6);
  s.quoteWindowMs = int(s.quoteWindowMs, 0, 120000, 3000);
  s.numMM = int(s.numMM, 1, 6, 2);
  s.numInformed = int(s.numInformed, 0, 50, 2);
  s.priceStep = Number(s.priceStep) > 0 ? Number(s.priceStep) : 1;
  s.tellInformed = Boolean(s.tellInformed);
  s.practice = Boolean(s.practice);
  if (s.practice) s.numInformed = 0;
  return s;
}

// ---------- prices and quotes ----------

export function roundToStep(price, step = 1) {
  const p = Number(price);
  if (!Number.isFinite(p)) return NaN;
  const r = Math.round(p / step) * step;
  return Number(r.toFixed(6)); // avoid 0.1+0.2 artefacts
}

/**
 * Validate a quote {bid, ask}. Returns {ok, error} or {ok: true, quote: {bid, ask}}.
 * Both sides are required, ask must be above bid, and the spread may not exceed settings.maxSpread.
 */
export function validateQuote(q, settings = DEFAULT_SETTINGS) {
  const step = settings.priceStep || 1;
  if (!q || q.bid == null || q.ask == null || q.bid === '' || q.ask === '') {
    return { ok: false, error: 'Post both a bid and an ask.' };
  }
  const bid = roundToStep(q.bid, step);
  const ask = roundToStep(q.ask, step);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return { ok: false, error: 'Prices must be numbers.' };
  if (bid <= 0 || ask <= 0) return { ok: false, error: 'Prices must be positive.' };
  if (ask <= bid) return { ok: false, error: 'The ask must be above the bid.' };
  const spread = Number((ask - bid).toFixed(6));
  if (spread > settings.maxSpread + 1e-9) {
    return { ok: false, error: `Spread of $${spread} is wider than the $${settings.maxSpread} maximum.` };
  }
  return { ok: true, quote: { bid, ask } };
}

/** One-click quote adjustments used by the market maker screen. */
export function shiftQuote(q, delta, settings = DEFAULT_SETTINGS) {
  const step = settings.priceStep || 1;
  return { bid: roundToStep(q.bid + delta * step, step), ask: roundToStep(q.ask + delta * step, step) };
}
export function widenQuote(q, settings = DEFAULT_SETTINGS) {
  const step = settings.priceStep || 1;
  return { bid: roundToStep(q.bid - step, step), ask: roundToStep(q.ask + step, step) };
}
export function narrowQuote(q, settings = DEFAULT_SETTINGS) {
  const step = settings.priceStep || 1;
  return { bid: roundToStep(q.bid + step, step), ask: roundToStep(q.ask - step, step) };
}

/**
 * From live quotes {uid: {bid, ask}} find the best bid and ask and who is showing them.
 * Ties are returned as multiple uids so the trader can choose.
 */
export function bestQuotes(quotes = {}) {
  let bestBid = null, bestAsk = null;
  const bidMakers = [], askMakers = [];
  for (const [uid, q] of Object.entries(quotes || {})) {
    if (!q) continue;
    if (Number.isFinite(q.bid)) {
      if (bestBid === null || q.bid > bestBid) { bestBid = q.bid; bidMakers.length = 0; bidMakers.push(uid); }
      else if (q.bid === bestBid) bidMakers.push(uid);
    }
    if (Number.isFinite(q.ask)) {
      if (bestAsk === null || q.ask < bestAsk) { bestAsk = q.ask; askMakers.length = 0; askMakers.push(uid); }
      else if (q.ask === bestAsk) askMakers.push(uid);
    }
  }
  return { bestBid, bestAsk, bidMakers, askMakers };
}

// ---------- positions and P&L ----------

export function emptyPosition(settings = DEFAULT_SETTINGS, isMarketMaker = false) {
  return { shares: 0, cash: 0, passLeft: isMarketMaker ? 0 : settings.passCards };
}

export function pnlAt(pos, value) {
  return (pos?.cash || 0) + (pos?.shares || 0) * value;
}

export function pnlBoth(pos) {
  return { at100: pnlAt(pos, 100), at120: pnlAt(pos, 120) };
}

/** Sum of P&L across all positions; must be zero in both columns because the game is zero-sum. */
export function sumPnl(positions = {}) {
  let at100 = 0, at120 = 0;
  for (const p of Object.values(positions)) { at100 += pnlAt(p, 100); at120 += pnlAt(p, 120); }
  return { at100: Number(at100.toFixed(6)), at120: Number(at120.toFixed(6)) };
}

/**
 * Apply a fill to the positions map and return a new map.
 * fill = {traderUid, mmUid, side: 'buy'|'sell', qty, price}; side is from the trader's point of view.
 */
export function applyFill(positions, fill) {
  const next = { ...positions };
  const t = { ...(next[fill.traderUid] || { shares: 0, cash: 0, passLeft: 0 }) };
  const m = { ...(next[fill.mmUid] || { shares: 0, cash: 0, passLeft: 0 }) };
  const sign = fill.side === 'buy' ? 1 : -1;
  const notional = fill.qty * fill.price;
  t.shares += sign * fill.qty;
  t.cash -= sign * notional;
  m.shares -= sign * fill.qty;
  m.cash += sign * notional;
  next[fill.traderUid] = t;
  next[fill.mmUid] = m;
  return next;
}

export function applyPass(positions, traderUid) {
  const next = { ...positions };
  const t = { ...(next[traderUid] || { shares: 0, cash: 0, passLeft: 0 }) };
  t.passLeft = Math.max(0, (t.passLeft || 0) - 1);
  next[traderUid] = t;
  return next;
}

// ---------- orders ----------

/**
 * Validate an order request against the current public state. Pure; the host calls this.
 * order  = {side: 'buy'|'sell'|'pass', qty, mmUid?, turnNo}
 * state  = {phase, turn: {uid, turnNo}, positions, quotes, settings}
 * Returns {ok: false, error} or {ok: true, kind: 'pass'} or {ok: true, kind: 'fill', fill}
 */
export function validateOrder(uid, order, state) {
  const { phase, turn, positions = {}, quotes = {}, settings = DEFAULT_SETTINGS } = state;
  if (phase !== PHASES.TRADING) return { ok: false, error: 'Trading is not open right now.' };
  if (!turn || turn.uid !== uid) return { ok: false, error: 'It is not your turn.' };
  if (order == null || typeof order !== 'object') return { ok: false, error: 'Malformed order.' };
  if (order.turnNo !== turn.turnNo) return { ok: false, error: 'That order was for an earlier turn.' };
  const pos = positions[uid] || { shares: 0, cash: 0, passLeft: 0 };

  if (order.side === 'pass') {
    if ((pos.passLeft || 0) <= 0) return { ok: false, error: 'No pass cards left. You must trade.' };
    return { ok: true, kind: 'pass' };
  }
  if (order.side !== 'buy' && order.side !== 'sell') return { ok: false, error: 'Order must be buy, sell, or pass.' };
  const qty = Number(order.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > settings.maxShares) {
    return { ok: false, error: `Size must be between 1 and ${settings.maxShares} shares.` };
  }
  const best = bestQuotes(quotes);
  const price = order.side === 'buy' ? best.bestAsk : best.bestBid;
  const makers = order.side === 'buy' ? best.askMakers : best.bidMakers;
  if (price === null || makers.length === 0) return { ok: false, error: 'No live quote to trade against.' };
  let mmUid;
  if (makers.length === 1) {
    mmUid = makers[0];
  } else if (order.mmUid && makers.includes(order.mmUid)) {
    mmUid = order.mmUid;
  } else {
    return { ok: false, error: 'Both market makers show the same price. Choose one.', needsChoice: makers };
  }
  if (mmUid === uid) return { ok: false, error: 'You cannot trade with yourself.' };
  return { ok: true, kind: 'fill', fill: { traderUid: uid, mmUid, side: order.side, qty, price } };
}

// ---------- turns ----------

export function firstTurn() {
  return { index: 0, lap: 1, turnNo: 1 };
}

/** Advance the turn pointer. Returns {turn, finished}. turnOrder is the array of trader uids. */
export function nextTurn(turn, turnOrder, laps) {
  const n = turnOrder.length;
  if (n === 0) return { turn, finished: true };
  let index = turn.index + 1;
  let lap = turn.lap;
  if (index >= n) { index = 0; lap += 1; }
  const finished = lap > laps;
  return { turn: { index, lap, turnNo: turn.turnNo + 1 }, finished };
}

export function turnUid(turn, turnOrder) {
  if (!turn || !turnOrder || !turnOrder.length) return null;
  return turnOrder[turn.index] ?? null;
}

// ---------- dealing ----------

/** Deterministic shuffle given an rng() in [0,1). Fisher-Yates. */
export function shuffle(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

/**
 * Deal roles for a round.
 * players: array of uids (host excluded).
 * opts: {fixedMMs: [uids], previousMMs: [uids], rng, forceRole: {uid, role}}
 *   forceRole pins one player to a role (used by practice mode); the rest is dealt at random.
 * Returns {trueValue, marketMakers, traders (in turn order), informed, roles: {uid: 'mm'|'informed'|'noise'}}
 */
export function dealRoles(players, settings = DEFAULT_SETTINGS, opts = {}) {
  const rng = opts.rng || Math.random;
  const uids = players.slice();
  if (uids.length < 2) throw new Error('Need at least two players: one market maker and one trader.');
  const numMM = Math.min(settings.numMM, uids.length - 1);
  const force = opts.forceRole && uids.includes(opts.forceRole.uid) ? opts.forceRole : null;

  // market makers: hand-picked first, then fill with players who have not made markets yet
  let fixed = (opts.fixedMMs || []).slice();
  if (force?.role === 'mm' && !fixed.includes(force.uid)) fixed.unshift(force.uid);
  let mms = fixed.filter(u => uids.includes(u)).slice(0, numMM);
  if (mms.length < numMM) {
    const prev = new Set(opts.previousMMs || []);
    const pool = uids.filter(u => !mms.includes(u) && !(force && force.role !== 'mm' && u === force.uid));
    const fresh = shuffle(pool.filter(u => !prev.has(u)), rng);
    const stale = shuffle(pool.filter(u => prev.has(u)), rng);
    mms = mms.concat(fresh.concat(stale).slice(0, numMM - mms.length));
  }
  const traders = shuffle(uids.filter(u => !mms.includes(u)), rng);
  const numInformed = Math.min(settings.practice ? 0 : settings.numInformed, traders.length);
  let informed = shuffle(traders, rng).slice(0, numInformed);
  if (force && traders.includes(force.uid)) {
    const isInf = informed.includes(force.uid);
    if (force.role === 'informed' && !isInf && informed.length) informed = [force.uid, ...informed.slice(1)];
    if (force.role === 'noise' && isInf) {
      const swap = traders.find(u => !informed.includes(u));
      informed = informed.filter(u => u !== force.uid).concat(swap ? [swap] : []);
    }
  }
  const trueValue = VALUES[rng() < 0.5 ? 0 : 1];
  const roles = {};
  for (const u of mms) roles[u] = 'mm';
  for (const u of traders) roles[u] = informed.includes(u) ? 'informed' : 'noise';
  return { trueValue, marketMakers: mms, traders, informed, roles };
}

// ---------- reveal ----------

/**
 * Build results with P&L at the true value and rank within role.
 * players: {uid: {name}}, positions: {uid: pos}, roles: {uid: role}
 */
export function buildResults(players, positions, roles, trueValue) {
  const rows = Object.keys(roles).map(uid => {
    const pos = positions[uid] || { shares: 0, cash: 0 };
    return {
      uid,
      name: players[uid]?.name || '?',
      role: roles[uid],
      shares: pos.shares || 0,
      cash: pos.cash || 0,
      pnl: pnlAt(pos, trueValue),
    };
  });
  for (const role of ['mm', 'informed', 'noise']) {
    const group = rows.filter(r => r.role === role).sort((a, b) => b.pnl - a.pnl);
    let rank = 0, prevPnl = null;
    group.forEach((r, i) => {
      if (prevPnl === null || r.pnl !== prevPnl) rank = i + 1; // ties share a rank
      r.rank = rank;
      r.roleSize = group.length;
      prevPnl = r.pnl;
    });
  }
  const order = { mm: 0, informed: 1, noise: 2 };
  return rows.sort((a, b) => order[a.role] - order[b.role] || a.rank - b.rank || a.name.localeCompare(b.name));
}

// ---------- export ----------

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * tape: array of fills/passes in order. Each has turnNo, lap, ts, traderName, side, qty, price, mmName,
 * plus the best bid/ask the trader saw and the trader's position after the turn.
 */
export function tapeToCsv(tape, meta = {}) {
  const header = ['round', 'turn', 'lap', 'clock_time', 'trader', 'action', 'shares', 'price', 'market_maker',
    'best_bid', 'best_ask', 'mid', 'trader_shares_after', 'trader_cash_after'];
  const lines = [header.join(',')];
  for (const t of tape) {
    const mid = (t.bestBid != null && t.bestAsk != null) ? (t.bestBid + t.bestAsk) / 2 : '';
    const isPass = t.side === 'pass';
    lines.push([
      meta.round ?? '', t.turnNo, t.lap, t.ts ? new Date(t.ts).toISOString() : '', t.traderName, t.side,
      isPass ? '' : t.qty, isPass ? '' : t.price, isPass ? '' : t.mmName,
      t.bestBid ?? '', t.bestAsk ?? '', mid, t.traderSharesAfter ?? '', t.traderCashAfter ?? '',
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

// ---------- misc ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, to avoid confusion with 1 and 0
export function makeRoomCode(rng = Math.random, len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length)];
  return s;
}

export function fmtMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '−' : '';
  const abs = Math.abs(n);
  return `${sign}$${Number.isInteger(abs) ? abs.toLocaleString() : abs.toFixed(2)}`;
}
export function fmtSigned(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  return (n > 0 ? '+' : '−') + '$' + (Number.isInteger(abs) ? abs.toLocaleString() : abs.toFixed(2));
}
