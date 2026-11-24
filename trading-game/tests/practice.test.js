// Practice mode end to end: the real referee and the dummy players running against the
// in-memory store, with the test acting as the human. Timers are driven by a fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocalDb } from '../localdb.js';
import { createReferee } from '../referee.js';
import { runPractice, dummyPlayers, PRACTICE_SETTINGS, DUMMY_NAMES } from '../practice.js';
import { PHASES, sumPnl, bestQuotes } from '../engine.js';

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function world(role, seed = 3) {
  const clock = { t: 1_700_000_000_000 };
  const queue = [];
  const schedule = (fn, ms) => { const h = { at: clock.t + ms, fn, seq: queue.length }; queue.push(h); return h; };
  const cancel = h => { h.cancelled = true; };
  const db = createLocalDb({ now: () => clock.t });
  const code = 'DEMO', base = `rooms/${code}`;
  const ref = createReferee({
    hostUid: 'host',
    db: { update: obj => db.update(base, obj), get: async p => db.read(`${base}/${p}`), pushKey: db.pushKey, now: () => clock.t },
    schedule, cancel, rng: seeded(seed), onError: e => { throw e; },
  });
  // the same subscriptions app.js sets up in practice mode
  db.subscribe(`${base}/meta`, v => ref.sync({ meta: v }));
  db.subscribe(`${base}/players`, v => ref.sync({ players: v || {} }));
  db.subscribe(`${base}/public`, v => ref.sync({ pub: v || {} }));
  db.subscribe(`${base}/host`, v => ref.sync({ host: v }));
  db.subscribe(`${base}/requests/orders`, v => ref.sync({ orders: v || {} }));
  db.subscribe(`${base}/requests/pending`, v => ref.sync({ pending: v || {} }));
  db.subscribe(`${base}/public/positions`, pos => { if (pos) assert.deepEqual(sumPnl(pos), { at100: 0, at120: 0 }, 'zero-sum'); });
  const practice = runPractice({ db, referee: ref, code, youUid: 'you', role, rng: seeded(seed + 1), schedule, cancel });

  const w = {
    db, ref, practice, clock, base,
    room: () => db.read(base),
    phase: () => db.read(`${base}/meta/phase`),
    async setup() {
      await db.set(`${base}/meta`, { hostUid: 'host', phase: PHASES.LOBBY, round: 1, settings: { ...PRACTICE_SETTINGS }, hostOnline: true });
      await db.update(`${base}/players`, { you: { name: 'You', online: true }, ...dummyPlayers() });
      await ref.idle();
    },
    async fireNext() {
      const h = queue.filter(x => !x.cancelled && !x.fired).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!h) return false;
      h.fired = true;
      clock.t = Math.max(clock.t, h.at);
      h.fn();
      await ref.idle();
      return true;
    },
    // the human: as a trader, buy 1 on every turn; as a market maker, post 108/112 when asked
    async act() {
      const r = w.room();
      const pub = r.public || {};
      if (r.meta.phase === PHASES.QUOTING && role === 'mm' && !r.requests?.pending?.you) {
        clock.t += 500;
        await db.set(`${base}/requests/pending/you`, { bid: 108, ask: 112, ts: clock.t });
        await ref.idle();
        return true;
      }
      if (r.meta.phase === PHASES.TRADING && pub.turn && pub.turnOrder[pub.turn.index] === 'you') {
        const best = bestQuotes(pub.quotes);
        clock.t += 500;
        await db.set(`${base}/requests/orders/you`, { side: 'buy', qty: 1, mmUid: best.askMakers[0], turnNo: pub.turn.turnNo, ts: clock.t });
        await ref.idle();
        return true;
      }
      return false;
    },
    async runUntil(pred, max = 400) {
      for (let i = 0; i < max; i++) {
        if (pred()) return;
        if (await w.act()) continue;
        if (!(await w.fireNext())) break;
      }
      throw new Error(`did not reach the expected state; phase is ${w.phase()}`);
    },
  };
  return w;
}

test('practice as a noise trader runs a whole round against dummies and reveals on its own', async () => {
  const w = world('noise');
  await w.setup();
  await w.practice.start();
  await w.ref.idle();
  assert.equal(w.phase(), PHASES.QUOTING);
  const priv = w.db.read(`${w.base}/private/you`);
  assert.equal(priv.role, 'noise');
  assert.equal(priv.trueValue, undefined);
  assert.equal(Object.keys(w.room().players).length, DUMMY_NAMES.length + 1);

  await w.runUntil(() => w.phase() === PHASES.TRADING);
  assert.equal(Object.keys(w.room().public.quotes).length, 2, 'both dummy market makers opened');

  await w.runUntil(() => w.phase() === PHASES.REVEAL);
  const rv = w.room().public.reveal;
  assert.equal(rv.results.length, 6);
  assert.equal(rv.results.find(r => r.uid === 'you').role, 'noise');
  const tape = Object.values(w.room().public.tape);
  assert.equal(tape.length, 2 * 4, 'two laps of four traders');
  assert.ok(tape.some(e => e.traderUid === 'you' && e.side === 'buy'));
  assert.ok(tape.filter(e => e.traderUid !== 'you').every(e => ['buy', 'sell', 'pass'].includes(e.side)));

  // restart deals a fresh round with the same role
  await w.practice.restart();
  await w.ref.idle();
  assert.equal(w.room().meta.round, 2);
  assert.equal(w.phase(), PHASES.QUOTING);
  assert.equal(w.db.read(`${w.base}/private/you`).role, 'noise');
  assert.equal(w.room().public.tape, undefined);
  await w.runUntil(() => w.phase() === PHASES.REVEAL);
  w.practice.stop();
});

test('practice as an informed trader shows the true value on the role card', async () => {
  const w = world('informed', 9);
  await w.setup();
  await w.practice.start();
  await w.ref.idle();
  const priv = w.db.read(`${w.base}/private/you`);
  assert.equal(priv.role, 'informed');
  assert.equal(priv.trueValue, w.db.read(`${w.base}/host/trueValue`));
  await w.runUntil(() => w.phase() === PHASES.REVEAL);
  assert.equal(w.room().public.reveal.results.find(r => r.uid === 'you').role, 'informed');
  w.practice.stop();
});

test('practice as a market maker waits for your opening quote, then dummies trade against you', async () => {
  const w = world('mm', 5);
  await w.setup();
  await w.practice.start();
  await w.ref.idle();
  assert.ok(w.room().public.marketMakers.you);
  assert.equal(w.db.read(`${w.base}/private/you`).role, 'mm');

  // let the dummy market maker post, but hold back our own quote: the market must not open
  for (let i = 0; i < 3; i++) await w.fireNext();
  assert.equal(w.phase(), PHASES.QUOTING);
  const dummyMM = Object.keys(w.room().public.marketMakers).find(u => u !== 'you');
  assert.ok(w.room().requests.pending[dummyMM], 'dummy posted its opening quote');

  await w.runUntil(() => w.phase() === PHASES.TRADING);
  assert.deepEqual(w.room().public.quotes.you, { bid: 108, ask: 112 });

  await w.runUntil(() => w.phase() === PHASES.REVEAL);
  const tape = Object.values(w.room().public.tape);
  assert.equal(tape.length, 2 * 4);
  assert.ok(tape.some(e => e.mmUid === 'you'), 'at least one dummy traded with the human market maker');
  const you = w.room().public.reveal.results.find(r => r.uid === 'you');
  assert.equal(you.role, 'mm');
  assert.equal(you.roleSize, 2);
  w.practice.stop();
});

test('regression: the referee must exist before the in-memory store fires its first callbacks', async () => {
  // Mirrors enterRoom() in app.js. The store calls back synchronously on subscribe, so a referee
  // created after the subscriptions would never see the lobby and startRound would fail with an
  // "undefined phase" error. This test wires it the way the app does and expects it to work.
  const db = createLocalDb();
  const base = 'rooms/DEMO';
  await db.set(`${base}/meta`, { hostUid: 'host', phase: PHASES.LOBBY, round: 1, settings: { ...PRACTICE_SETTINGS } });
  await db.update(`${base}/players`, { you: { name: 'You', online: true }, ...dummyPlayers() });
  let referee = null;
  const subs = () => {
    db.subscribe(`${base}/meta`, v => { if (referee) referee.sync({ meta: v }); });
    db.subscribe(`${base}/players`, v => { if (referee) referee.sync({ players: v || {} }); });
    db.subscribe(`${base}/public`, v => { if (referee) referee.sync({ pub: v || {} }); });
  };
  const make = () => createReferee({ hostUid: 'host', db: { update: o => db.update(base, o), get: async p => db.read(`${base}/${p}`), pushKey: db.pushKey, now: db.now }, schedule: () => 0, cancel: () => {} });

  // wrong order: subscriptions before the referee exists -> clear error, not a crash
  subs();
  referee = make();
  await assert.rejects(referee.startRound({ forceRole: { uid: 'you', role: 'noise' } }), /not loaded yet/);

  // right order (what app.js does now): referee first, then subscribe
  referee = make();
  subs();
  await referee.startRound({ forceRole: { uid: 'you', role: 'noise' } });
  assert.equal(db.read(`${base}/meta/phase`), PHASES.QUOTING);
});
