// referee.js — the host's game loop. Runs only in the host's browser.
//
// It never touches Firebase directly. It is given a tiny `db` adapter
// ({ update(pathsToValues), pushKey(), now() }) and is fed mirrors of the database
// through sync(). That keeps it testable without a browser or an emulator
// (see tests/referee.test.js), and keeps every rule decision in one place.
//
// All database paths are relative to rooms/<code>/.

import * as E from './engine.js';

export function createReferee({ hostUid, db, schedule = setTimeout, cancel = clearTimeout, rng = Math.random, onError = console.error }) {
  // mirrors of the database, kept current by sync()
  const m = { meta: null, pub: {}, players: {}, host: null, orders: {}, pending: {} };
  const noticed = {};            // mmUid -> ts of the last pending quote we complained about
  let chain = Promise.resolve(); // all work is serialised through this promise chain
  let timer = null, timerKey = null;

  const now = () => (db.now ? db.now() : Date.now());
  const phase = () => m.meta?.phase;
  const settings = () => E.normalizeSettings(m.meta?.settings || {});
  const mmUids = () => Object.keys(m.pub?.marketMakers || {});
  const turnOrder = () => m.pub?.turnOrder || [];
  const nameOf = uid => m.players?.[uid]?.name || '?';
  const turnInfo = () => {
    const t = m.pub?.turn;
    return t ? { ...t, uid: E.turnUid(t, turnOrder()) } : null;
  };

  // Host actions return their own promise so a rejected action reaches the caller without
  // poisoning the queue. Internal work (reconcile, timers) reports through onError instead.
  function enqueue(fn, { internal = false } = {}) {
    const p = chain.then(fn);
    chain = p.catch(e => { if (internal) onError(e); });
    return p;
  }
  async function idle() {
    let c;
    do { c = chain; await c; } while (c !== chain);
  }

  /** Feed fresh database state. partial may contain any of: meta, pub, players, host, orders, pending. */
  function sync(partial) {
    for (const k of Object.keys(partial)) m[k] = partial[k] ?? (k === 'meta' || k === 'host' ? null : {});
    enqueue(reconcile, { internal: true });
  }

  // ---------- reconciliation: look at the state and do whatever is due ----------

  async function reconcile() {
    const p = phase();
    if (p === E.PHASES.WINDOW && m.pub?.windowEndsAt) ensureTimer(m.pub.windowEndsAt);
    else clearTimer();
    if (p === E.PHASES.QUOTING) await tryOpenMarket();
    await processOrders();
  }

  function ensureTimer(endsAt) {
    if (timer != null && timerKey === endsAt) return;
    clearTimer();
    timerKey = endsAt;
    timer = schedule(() => { timer = null; enqueue(() => closeWindow(endsAt), { internal: true }); }, Math.max(0, endsAt - now()));
  }
  function clearTimer() {
    if (timer != null) cancel(timer);
    timer = null; timerKey = null;
  }

  function notice(uid, msg, kind = 'error') {
    return { [`private/${uid}/notice`]: { msg, kind, ts: now() } };
  }

  // Opening quotes: once every market maker has a valid pending quote, make them live and start turn 1.
  async function tryOpenMarket() {
    const s = settings();
    const mms = mmUids();
    if (!mms.length) return;
    const quotes = {}, updates = {};
    let allValid = true;
    for (const uid of mms) {
      const pq = m.pending?.[uid];
      const v = E.validateQuote(pq, s);
      if (v.ok) quotes[uid] = v.quote;
      else {
        allValid = false;
        if (pq && pq.ts && noticed[uid] !== pq.ts) { noticed[uid] = pq.ts; Object.assign(updates, notice(uid, v.error)); }
      }
    }
    if (allValid) {
      updates['public/quotes'] = quotes;
      updates['public/turn'] = E.firstTurn();
      updates['meta/phase'] = E.PHASES.TRADING;
    }
    if (Object.keys(updates).length) await db.update(updates);
  }

  async function processOrders() {
    const entries = Object.entries(m.orders || {}).sort((a, b) => (a[1]?.ts || 0) - (b[1]?.ts || 0));
    for (const [uid, order] of entries) {
      if (!m.orders || !(uid in m.orders)) continue; // handled by an earlier pass
      await handleOrder(uid, order);
    }
  }

  async function handleOrder(uid, order) {
    const s = settings();
    const t = turnInfo();
    const state = { phase: phase(), turn: t, positions: m.pub?.positions || {}, quotes: m.pub?.quotes || {}, settings: s };
    const r = E.validateOrder(uid, order, state);
    const updates = { [`requests/orders/${uid}`]: null };
    delete m.orders[uid]; // so a re-entrant pass does not see it again
    if (!r.ok) {
      Object.assign(updates, notice(uid, r.error));
      await db.update(updates);
      return;
    }
    const best = E.bestQuotes(state.quotes);
    let positions = state.positions;
    const entry = {
      turnNo: t.turnNo, lap: t.lap, ts: now(), traderUid: uid, traderName: nameOf(uid), side: order.side,
      bestBid: best.bestBid, bestAsk: best.bestAsk,
    };
    if (r.kind === 'fill') {
      positions = E.applyFill(positions, r.fill);
      Object.assign(entry, { qty: r.fill.qty, price: r.fill.price, mmUid: r.fill.mmUid, mmName: nameOf(r.fill.mmUid) });
      updates[`public/positions/${r.fill.mmUid}`] = positions[r.fill.mmUid];
    } else {
      positions = E.applyPass(positions, uid);
    }
    updates[`public/positions/${uid}`] = positions[uid];
    entry.traderSharesAfter = positions[uid].shares;
    entry.traderCashAfter = positions[uid].cash;
    updates[`public/tape/${db.pushKey()}`] = entry;
    Object.assign(updates, windowUpdates(s));
    await db.update(updates);
  }

  function windowUpdates(s) {
    return { 'meta/phase': E.PHASES.WINDOW, 'public/windowEndsAt': now() + s.quoteWindowMs };
  }

  // End of the quote window: pending quotes go live, then the next trader is up.
  async function closeWindow(key) {
    if (phase() !== E.PHASES.WINDOW || m.pub?.windowEndsAt !== key) return; // stale timer (paused, ended, ...)
    timerKey = null;
    const s = settings();
    const updates = {};
    const quotes = { ...(m.pub?.quotes || {}) };
    for (const uid of mmUids()) {
      const pq = m.pending?.[uid];
      if (!pq) continue;
      const v = E.validateQuote(pq, s);
      if (v.ok) quotes[uid] = v.quote;
      else if (noticed[uid] !== pq.ts) {
        noticed[uid] = pq.ts;
        Object.assign(updates, notice(uid, `Pending quote not applied: ${v.error}`));
      }
    }
    updates['public/quotes'] = quotes;
    updates['public/windowEndsAt'] = null;
    const { turn, finished } = E.nextTurn(m.pub.turn, turnOrder(), s.laps);
    if (finished) {
      updates['meta/phase'] = E.PHASES.ENDED;
    } else {
      updates['public/turn'] = turn;
      updates['meta/phase'] = E.PHASES.TRADING;
    }
    await db.update(updates);
  }

  // ---------- host actions (each returns a promise that resolves when written) ----------

  function requirePhase(...allowed) {
    const p = phase();
    if (!allowed.includes(p)) throw new Error(`Not allowed while the round is in the "${p}" phase.`);
  }

  function startRound({ fixedMMs = [], settings: sIn } = {}) {
    return enqueue(async () => {
      requirePhase(E.PHASES.LOBBY);
      const s = E.normalizeSettings(sIn || m.meta?.settings || {});
      const players = Object.keys(m.players || {}).filter(u => u !== hostUid);
      const deal = E.dealRoles(players, s, { fixedMMs, previousMMs: Object.keys(m.pub?.mmHistory || {}), rng });
      const round = m.meta?.round || 1;
      const positions = {};
      for (const u of players) positions[u] = E.emptyPosition(s, deal.roles[u] === 'mm');
      const updates = {
        'meta/phase': E.PHASES.QUOTING,
        'meta/settings': s,
        'meta/resumePhase': null,
        'public/round': round,
        'public/marketMakers': Object.fromEntries(deal.marketMakers.map(u => [u, true])),
        'public/turnOrder': deal.traders,
        'public/turn': null,
        'public/quotes': null,
        'public/tape': null,
        'public/positions': positions,
        'public/windowEndsAt': null,
        'public/reveal': null,
        'public/informedCount': s.tellInformed ? deal.informed.length : null,
        'public/roundStartedAt': now(),
        'host': { trueValue: deal.trueValue, roles: deal.roles, informed: deal.informed, round },
        'requests': null,
      };
      for (const u of deal.marketMakers) updates[`public/mmHistory/${u}`] = true;
      for (const u of players) {
        const role = deal.roles[u];
        updates[`private/${u}`] = role === 'informed'
          ? { role, round, trueValue: deal.trueValue }
          : { role, round };
      }
      for (const k of Object.keys(noticed)) delete noticed[k];
      await db.update(updates);
    });
  }

  function pause() {
    return enqueue(async () => {
      requirePhase(E.PHASES.QUOTING, E.PHASES.TRADING, E.PHASES.WINDOW);
      await db.update({ 'meta/phase': E.PHASES.PAUSED, 'meta/resumePhase': phase(), 'public/windowEndsAt': null });
    });
  }

  function resume() {
    return enqueue(async () => {
      requirePhase(E.PHASES.PAUSED);
      const rp = m.meta?.resumePhase || E.PHASES.TRADING;
      const updates = { 'meta/phase': rp, 'meta/resumePhase': null };
      if (rp === E.PHASES.WINDOW) updates['public/windowEndsAt'] = now() + settings().quoteWindowMs;
      await db.update(updates);
    });
  }

  /** Host skips the current trader without using one of their pass cards. */
  function skipTurn() {
    return enqueue(async () => {
      requirePhase(E.PHASES.TRADING);
      const s = settings();
      const t = turnInfo();
      const best = E.bestQuotes(m.pub?.quotes || {});
      const pos = m.pub?.positions?.[t.uid] || { shares: 0, cash: 0 };
      const entry = {
        turnNo: t.turnNo, lap: t.lap, ts: now(), traderUid: t.uid, traderName: nameOf(t.uid), side: 'skip',
        bestBid: best.bestBid, bestAsk: best.bestAsk, traderSharesAfter: pos.shares || 0, traderCashAfter: pos.cash || 0,
      };
      const updates = { [`public/tape/${db.pushKey()}`]: entry, [`requests/orders/${t.uid}`]: null, ...windowUpdates(s) };
      delete m.orders[t.uid];
      await db.update(updates);
    });
  }

  function endRound() {
    return enqueue(async () => {
      requirePhase(E.PHASES.QUOTING, E.PHASES.TRADING, E.PHASES.WINDOW, E.PHASES.PAUSED);
      await db.update({ 'meta/phase': E.PHASES.ENDED, 'meta/resumePhase': null, 'public/windowEndsAt': null, 'requests/orders': null });
    });
  }

  function reveal() {
    return enqueue(async () => {
      requirePhase(E.PHASES.ENDED);
      if (!m.host?.roles) throw new Error('The host record for this round is missing, so the reveal cannot be built.');
      const s = settings();
      const results = E.buildResults(m.players || {}, m.pub?.positions || {}, m.host.roles, m.host.trueValue);
      await db.update({
        'public/reveal': { trueValue: m.host.trueValue, informed: m.host.informed || [], results, practice: s.practice, round: m.meta?.round || 1 },
        'meta/phase': E.PHASES.REVEAL,
      });
    });
  }

  function newRound() {
    return enqueue(async () => {
      requirePhase(E.PHASES.REVEAL, E.PHASES.ENDED);
      await db.update({
        'meta/phase': E.PHASES.LOBBY,
        'meta/resumePhase': null,
        'meta/round': (m.meta?.round || 1) + 1,
        'public': { mmHistory: m.pub?.mmHistory || null },
        'private': null,
        'host': null,
        'requests': null,
      });
    });
  }

  function removePlayer(uid) {
    return enqueue(async () => {
      requirePhase(E.PHASES.LOBBY);
      await db.update({ [`players/${uid}`]: null });
    });
  }

  // ---------- read helpers ----------

  function tapeArray() {
    return Object.values(m.pub?.tape || {}).sort((a, b) => (a.turnNo - b.turnNo) || (a.ts - b.ts));
  }
  function csv() {
    return E.tapeToCsv(tapeArray(), { round: m.meta?.round || 1 });
  }
  function destroy() { clearTimer(); }

  return {
    sync, idle, startRound, pause, resume, skipTurn, endRound, reveal, newRound, removePlayer,
    tapeArray, csv, destroy,
    get state() { return m; },
  };
}
