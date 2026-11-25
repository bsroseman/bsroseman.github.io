// practice.js — solo practice mode. Fills the other seats with dummy players so one
// person can learn the screens before class. The dummies are deliberately simple:
// market makers post a plain opening quote and occasionally nudge it by one step,
// traders place random orders. No strategy, nothing saved.

import * as E from './engine.js';

export const DUMMY_NAMES = ['Computer1', 'Computer2', 'Computer3', 'Computer4', 'Computer5'];

export function dummyPlayers() {
  return Object.fromEntries(DUMMY_NAMES.map((name, i) => [`dummy${i + 1}`, { name, online: true }]));
}

export const PRACTICE_SETTINGS = Object.freeze({ ...E.DEFAULT_SETTINGS, laps: 5 });

/**
 * Drive the dummy players against a referee that is already wired to `db`.
 * role: 'noise' | 'informed' | 'mm' for the human player (youUid).
 * schedule/cancel/rng are injectable for tests.
 */
export function runPractice({ db, referee, code, youUid, role, settings = {}, rng = Math.random, schedule = setTimeout, cancel = clearTimeout }) {
  const base = `rooms/${code}`;
  const s = E.normalizeSettings({ ...PRACTICE_SETTINGS, ...settings });
  const timers = new Set();
  const done = new Set();
  let stopped = false;

  const rand = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const isDummy = uid => uid !== youUid;
  const ts = () => db.now();

  function delay(ms, fn) {
    const h = schedule(() => { timers.delete(h); if (!stopped) fn(); }, ms);
    timers.add(h);
  }
  function once(key, ms, fn) {
    if (done.has(key)) return;
    done.add(key);
    delay(ms, fn);
  }
  function clearTimers() {
    for (const h of timers) cancel(h);
    timers.clear();
  }

  // ---- dummy behaviours (each re-reads the database when it fires) ----

  function openingQuote(uid, i) {
    const room = db.read(base);
    if (room?.meta?.phase !== E.PHASES.QUOTING || room.requests?.pending?.[uid]) return;
    const half = Math.min(i % 2 === 0 ? 2 : 3, Math.floor(s.maxSpread / 2));
    db.set(`${base}/requests/pending/${uid}`, { bid: 110 - half, ask: 110 + half, ts: ts() });
  }

  function placeOrder(uid, turnNo) {
    const room = db.read(base);
    const pub = room?.public || {};
    if (room?.meta?.phase !== E.PHASES.TRADING || !pub.turn || pub.turn.turnNo !== turnNo) return;
    if ((pub.turnOrder || [])[pub.turn.index] !== uid) return;
    const pos = pub.positions?.[uid] || { passLeft: 0 };
    let order;
    if ((pos.passLeft || 0) > 0 && rng() < 0.15) {
      order = { side: 'pass', turnNo, ts: ts() };
    } else {
      const side = rng() < 0.5 ? 'buy' : 'sell';
      const best = E.bestQuotes(pub.quotes || {});
      const makers = side === 'buy' ? best.askMakers : best.bidMakers;
      if (!makers.length) return;
      order = { side, qty: rand(1, s.maxShares), mmUid: makers[rand(0, makers.length - 1)], turnNo, ts: ts() };
    }
    db.set(`${base}/requests/orders/${uid}`, order);
  }

  function maybeNudge(uid) {
    const room = db.read(base);
    const live = room?.public?.quotes?.[uid];
    if (!live || rng() >= 0.4) return;
    const nq = E.shiftQuote(live, rng() < 0.5 ? -1 : 1, s);
    if (E.validateQuote(nq, s).ok) db.set(`${base}/requests/pending/${uid}`, { ...nq, ts: ts() });
  }

  function react(room) {
    if (stopped || !room?.meta) return;
    const phase = room.meta.phase;
    const round = room.meta.round || 1;
    const pub = room.public || {};
    const dummyMMs = Object.keys(pub.marketMakers || {}).filter(isDummy);

    if (phase === E.PHASES.QUOTING) {
      dummyMMs.forEach((uid, i) => once(`open:${round}:${uid}`, rand(700, 1500), () => openingQuote(uid, i)));
    }
    if (phase === E.PHASES.TRADING && pub.turn) {
      const cur = (pub.turnOrder || [])[pub.turn.index];
      if (cur && isDummy(cur)) once(`order:${round}:${pub.turn.turnNo}`, rand(1200, 2400), () => placeOrder(cur, pub.turn.turnNo));
    }
    if (phase === E.PHASES.WINDOW && pub.windowEndsAt) {
      for (const uid of dummyMMs) once(`nudge:${round}:${pub.windowEndsAt}:${uid}`, 0, () => maybeNudge(uid));
    }
    if (phase === E.PHASES.ENDED) {
      once(`reveal:${round}`, 1000, () => referee.reveal().catch(() => {}));
    }
  }

  const unsub = db.subscribe(base, react);

  async function start() {
    const fixedMMs = role === 'mm' ? [youUid] : [];
    await referee.startRound({ fixedMMs, settings: s, forceRole: { uid: youUid, role } });
  }

  async function restart() {
    clearTimers();
    const phase = () => db.read(`${base}/meta/phase`);
    if ([E.PHASES.QUOTING, E.PHASES.TRADING, E.PHASES.WINDOW, E.PHASES.PAUSED].includes(phase())) await referee.endRound();
    if ([E.PHASES.ENDED, E.PHASES.REVEAL].includes(phase())) await referee.newRound();
    await start();
  }

  function stop() {
    stopped = true;
    clearTimers();
    unsub();
  }

  return { start, restart, stop, settings: s };
}
