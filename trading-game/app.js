// app.js — browser wiring: Firebase, routing between screens, and rendering.
// Game rules live in engine.js; the host's game loop lives in referee.js.

import * as E from './engine.js';
import { createReferee } from './referee.js';
import { createLocalDb } from './localdb.js';
import { runPractice, dummyPlayers, PRACTICE_SETTINGS } from './practice.js';
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  getDatabase, ref, set, update, get, onValue, push, onDisconnect, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

// ---------- tiny helpers ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const money = E.fmtMoney, signed = E.fmtSigned;
const cls = n => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function showView(name) {
  for (const sec of $$('main > section')) sec.hidden = sec.dataset.view !== name;
  S.view = name;
}

// ---------- state ----------

const S = {
  uid: null, code: null, name: null, mode: null,   // mode: 'player' | 'host' | 'board'
  meta: null, players: {}, pub: {}, priv: null, pending: null, host: null, orders: {}, pendingAll: {},
  offset: 0, connected: true, view: null,
  unsubs: [], referee: null,
  choice: null, sentTurn: null, lastNoticeTs: null,
  mmFormRound: null, settingsRound: null, hostPicks: new Set(),
};
let app, auth, rtdb;
let io = null; // data access layer: Firebase in a real room, an in-memory store in practice mode
const serverNow = () => Date.now() + S.offset;

function firebaseIo() {
  return {
    sub: (path, cb) => onValue(ref(rtdb, path), snap => cb(snap.val()), err => { console.error(path, err); toast(`Could not read ${path}: ${err.message}`, 'error'); }),
    set: (path, val) => set(ref(rtdb, path), val),
    update: (path, obj) => update(ref(rtdb, path), obj),
    get: async path => (await get(ref(rtdb, path))).val(),
    pushKey: path => push(ref(rtdb, path)).key,
    onDisconnectSet: (path, val) => onDisconnect(ref(rtdb, path)).set(val),
    ts: () => serverTimestamp(),
    now: serverNow,
  };
}

function localIo(db) {
  return {
    sub: (path, cb) => db.subscribe(path, cb),
    set: (path, val) => db.set(path, val),
    update: (path, obj) => db.update(path, obj),
    get: async path => db.read(path),
    pushKey: () => db.pushKey(),
    onDisconnectSet: () => {},
    ts: () => ({ '.sv': 'timestamp' }),
    now: () => db.now(),
  };
}

// ---------- boot ----------

function configMissing() {
  const c = firebaseConfig || {};
  return !c.apiKey || !c.databaseURL || /PASTE|YOUR_|xxxx/i.test(c.apiKey + c.databaseURL);
}

async function main() {
  bindStatic();
  const practiceRole = new URLSearchParams(location.search).get('practice');
  if (practiceRole) return enterPractice(practiceRole);
  if (configMissing()) {
    $('#setupNotice').hidden = false;
    showView('landing');
    for (const b of ['#btnHost', '#joinForm button']) $(b).disabled = true;
    return;
  }
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  rtdb = getDatabase(app);
  io = firebaseIo();
  onValue(ref(rtdb, '.info/serverTimeOffset'), s => { S.offset = s.val() || 0; });
  onValue(ref(rtdb, '.info/connected'), s => { S.connected = !!s.val(); renderConn(); });
  let routed = false;
  onAuthStateChanged(auth, user => {
    if (user && !routed) { routed = true; S.uid = user.uid; route().catch(err => fail(err)); }
  });
  try { await signInAnonymously(auth); }
  catch (err) { fail(err, 'Could not sign in. In the Firebase console enable Authentication → Sign-in method → Anonymous.'); }
}

function fail(err, hint) {
  console.error(err);
  const msg = hint || (err && err.message) || String(err);
  $('#connNotice').textContent = msg;
  $('#connNotice').hidden = false;
  showView('landing');
}

async function route() {
  const params = new URLSearchParams(location.search);
  const board = (params.get('board') || '').toUpperCase().trim();
  if (board) return enterRoom(board, 'board');

  const hostRoom = LS.get('tg.hostRoom');
  if (hostRoom) {
    const meta = await getVal(`rooms/${hostRoom}/meta`);
    if (meta && meta.hostUid === S.uid) return enterRoom(hostRoom, 'host');
    LS.del('tg.hostRoom');
  }
  const room = LS.get('tg.room'), name = LS.get('tg.name');
  if (room && name) {
    const meta = await getVal(`rooms/${room}/meta`);
    if (meta) return joinRoom(room, name);
    LS.del('tg.room');
  }
  showView('landing');
}

const getVal = path => io.get(path);

// ---------- joining and hosting ----------

async function joinRoom(code, name) {
  code = code.toUpperCase().trim();
  const meta = await getVal(`rooms/${code}/meta`);
  if (!meta) throw new Error('No game found with that room code.');
  if (meta.hostUid === S.uid) {       // the instructor coming back on the same device
    LS.set('tg.hostRoom', code);
    return enterRoom(code, 'host');
  }
  await io.update(`rooms/${code}/players/${S.uid}`, { name, online: true, joinedAt: io.ts() });
  io.onDisconnectSet(`rooms/${code}/players/${S.uid}/online`, false);
  LS.set('tg.room', code); LS.set('tg.name', name);
  S.name = name;
  return enterRoom(code, 'player');
}

async function hostRoom() {
  let code;
  for (let i = 0; i < 20; i++) {
    code = E.makeRoomCode();
    if (!(await getVal(`rooms/${code}/meta`))) break;
  }
  await io.set(`rooms/${code}/meta`, {
    hostUid: S.uid, createdAt: io.ts(), phase: E.PHASES.LOBBY, round: 1,
    settings: { ...E.DEFAULT_SETTINGS }, hostOnline: true,
  });
  LS.set('tg.hostRoom', code);
  return enterRoom(code, 'host');
}

function sub(path, cb) {
  S.unsubs.push(io.sub(path, cb));
}

function enterRoom(code, mode) {
  S.code = code; S.mode = mode;
  $('#session').hidden = false;
  $('#sessCode').textContent = code;
  $('#sessName').textContent = mode === 'host' ? 'Host' : mode === 'board' ? 'Board' : S.name || '';
  $('#btnLeave').textContent = mode === 'host' ? 'Leave host screen' : 'Leave';

  // Create the referee BEFORE subscribing: the in-memory store used by practice mode fires
  // subscription callbacks synchronously, and the referee must be there to receive them.
  if (mode === 'host' || mode === 'practice') {
    const base = `rooms/${code}`;
    S.referee = createReferee({
      hostUid: mode === 'host' ? S.uid : 'host', // in practice mode this tab is player and referee at once
      db: {
        update: obj => io.update(base, obj),
        get: p => io.get(`${base}/${p}`),
        pushKey: () => io.pushKey(`${base}/public/tape`),
        now: io.now,
      },
      onError: err => { console.error(err); toast(`Referee error: ${err.message}`, 'error'); },
    });
  }

  sub(`rooms/${code}/meta`, v => {
    S.meta = v;
    if (!v) { toast('This room no longer exists.', 'error'); return leave(); }
    if (S.referee) S.referee.sync({ meta: v });
    render();
  });
  sub(`rooms/${code}/players`, v => { S.players = v || {}; if (S.referee) S.referee.sync({ players: S.players }); render(); });
  sub(`rooms/${code}/public`, v => { S.pub = v || {}; if (S.referee) S.referee.sync({ pub: S.pub }); render(); });

  if (mode === 'player' || mode === 'practice') {
    sub(`rooms/${code}/private/${S.uid}`, v => { S.priv = v; handleNotice(v); render(); });
    sub(`rooms/${code}/requests/pending/${S.uid}`, v => { S.pending = v; render(); });
  }
  if (mode === 'host' || mode === 'practice') {
    const base = `rooms/${code}`;
    sub(`${base}/host`, v => { S.host = v; S.referee.sync({ host: v }); render(); });
    sub(`${base}/requests/orders`, v => { S.orders = v || {}; S.referee.sync({ orders: S.orders }); });
    sub(`${base}/requests/pending`, v => { S.pendingAll = v || {}; S.referee.sync({ pending: S.pendingAll }); render(); });
    if (mode === 'host') {
      io.onDisconnectSet(`${base}/meta/hostOnline`, false);
      io.update(`${base}/meta`, { hostOnline: true }).catch(console.error);
    }
  }
}

// ---------- practice mode (no Firebase: everything runs in this tab) ----------

const ROLE_LABEL = { noise: 'a noise trader', informed: 'an informed trader', mm: 'a market maker' };

async function enterPractice(role) {
  if (!ROLE_LABEL[role]) role = 'noise';
  const db = createLocalDb();
  io = localIo(db);
  S.uid = 'you'; S.name = 'You'; S.practiceRole = role;
  const code = 'DEMO';
  await io.set(`rooms/${code}/meta`, { hostUid: 'host', createdAt: io.ts(), phase: E.PHASES.LOBBY, round: 1, settings: { ...PRACTICE_SETTINGS }, hostOnline: true });
  await io.update(`rooms/${code}/players`, { you: { name: 'You', online: true }, ...dummyPlayers() });
  enterRoom(code, 'practice');
  S.practice = runPractice({ db, referee: S.referee, code, youUid: 'you', role });
  $('#practiceBar').hidden = false;
  try { await S.practice.start(); }
  catch (err) { toast(err.message, 'error'); }
}

function renderPracticeBar() {
  $('#practiceText').textContent = `Practice mode. You are ${ROLE_LABEL[S.practiceRole]} against dummy players, ${S.practice?.settings.laps || 5} rounds. Nothing is saved.`;
  $('#btnPracticeAgain').textContent = S.meta?.phase === E.PHASES.REVEAL ? 'Play again' : 'Restart';
}

function leave() {
  if (S.mode === 'practice') { location.href = location.pathname; return; }
  for (const u of S.unsubs) { try { u(); } catch { /* ignore */ } }
  S.unsubs = [];
  if (S.referee) { S.referee.destroy(); S.referee = null; }
  if (S.mode === 'player' && S.code) {
    io.update(`rooms/${S.code}/players/${S.uid}`, { online: false }).catch(() => {});
    LS.del('tg.room');
  }
  if (S.mode === 'host') LS.del('tg.hostRoom');
  if (S.mode === 'board') { history.replaceState(null, '', location.pathname); }
  Object.assign(S, { code: null, mode: null, meta: null, players: {}, pub: {}, priv: null, pending: null, host: null, choice: null, sentTurn: null, lastNoticeTs: null, mmFormRound: null, settingsRound: null });
  S.hostPicks = new Set();
  $('#session').hidden = true;
  showView('landing');
}

// ---------- static bindings ----------

function bindStatic() {
  $('#joinForm').addEventListener('submit', async ev => {
    ev.preventDefault();
    const name = $('#joinName').value.trim();
    const code = $('#joinCode').value.trim().toUpperCase();
    $('#joinErr').textContent = '';
    if (name.length < 1) return ($('#joinErr').textContent = 'Please enter your name.');
    if (!/^[A-Z]{4}$/.test(code)) return ($('#joinErr').textContent = 'Room codes are four letters.');
    try { await joinRoom(code, name); }
    catch (err) { $('#joinErr').textContent = err.message; }
  });
  $('#btnHost').addEventListener('click', async () => {
    $('#hostStartErr').textContent = '';
    try { await hostRoom(); }
    catch (err) { $('#hostStartErr').textContent = err.message.includes('PERMISSION') ? 'Permission denied. Publish database.rules.json in the Firebase console.' : err.message; }
  });
  $('#linkBoard').addEventListener('click', ev => {
    ev.preventDefault();
    const code = (prompt('Room code for the board:') || '').trim().toUpperCase();
    if (/^[A-Z]{4}$/.test(code)) location.search = `?board=${code}`;
  });
  $('#btnLeave').addEventListener('click', () => {
    if (S.mode === 'host' && !confirm('Leave the host screen? The game pauses until a host screen is open again. You can come back by hosting from this same browser, or by joining with the room code.')) return;
    leave();
  });
  $('#btnPracticeAgain').addEventListener('click', () => { if (S.practice) S.practice.restart().catch(err => toast(err.message, 'error')); });

  // trader order pad (delegated)
  $('#trPad').addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b || b.disabled) return;
    if (b.dataset.cancel) { S.choice = null; return render(); }
    if (b.dataset.mm) { const c = S.choice; S.choice = null; return submitOrder(c.side, c.qty, b.dataset.mm); }
    const side = b.dataset.side; if (!side) return;
    if (side === 'pass') return submitOrder('pass', null, null);
    const qty = Number(b.dataset.qty);
    const best = E.bestQuotes(S.pub.quotes || {});
    const makers = side === 'buy' ? best.askMakers : best.bidMakers;
    if (makers.length > 1) { S.choice = { side, qty, makers, price: side === 'buy' ? best.bestAsk : best.bestBid }; return render(); }
    submitOrder(side, qty, makers[0] || null);
  });

  // market maker quote form
  $('#mmForm').addEventListener('submit', ev => {
    ev.preventDefault();
    postQuote({ bid: $('#mmBid').value, ask: $('#mmAsk').value });
  });
  $('#mmForm').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-q]'); if (!b) return;
    const s = settings();
    const base = currentQuoteInputs();
    if (!E.validateQuote(base, s).ok) return ($('#mmMsg').textContent = 'Type a valid bid and ask first, then use the buttons to nudge them.');
    const q = { up: () => E.shiftQuote(base, 1, s), down: () => E.shiftQuote(base, -1, s), widen: () => E.widenQuote(base, s), narrow: () => E.narrowQuote(base, s) }[b.dataset.q]();
    postQuote(q);
  });

  // host
  $('#btnStart').addEventListener('click', startRound);
  $('#hostActions').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-act]'); if (!b) return;
    hostAction(b.dataset.act);
  });
  $('#hostPlayers').addEventListener('change', ev => {
    const cb = ev.target.closest('input[data-pick]'); if (!cb) return;
    if (cb.checked) S.hostPicks.add(cb.dataset.pick); else S.hostPicks.delete(cb.dataset.pick);
  });
  $('#hostPlayers').addEventListener('click', ev => {
    const b = ev.target.closest('button[data-remove]'); if (!b) return;
    if (!confirm(`Remove ${S.players[b.dataset.remove]?.name || 'this player'} from the room?`)) return;
    S.referee.removePlayer(b.dataset.remove).catch(err => toast(err.message, 'error'));
  });

  setInterval(tickCountdown, 100);
}

// ---------- player actions ----------

async function submitOrder(side, qty, mmUid) {
  const t = S.pub.turn;
  if (!t) return;
  const order = { side, turnNo: t.turnNo, ts: io.ts() };
  if (qty != null) order.qty = qty;
  if (mmUid) order.mmUid = mmUid;
  S.sentTurn = t.turnNo;
  render();
  try { await io.set(`rooms/${S.code}/requests/orders/${S.uid}`, order); }
  catch (err) { S.sentTurn = null; toast(`Order not sent: ${err.message}`, 'error'); render(); }
}

function settings() { return E.normalizeSettings(S.meta?.settings || {}); }

function currentQuoteInputs() {
  return { bid: Number($('#mmBid').value), ask: Number($('#mmAsk').value) };
}

async function postQuote(q) {
  const v = E.validateQuote(q, settings());
  if (!v.ok) { $('#mmMsg').textContent = v.error; return; }
  $('#mmBid').value = v.quote.bid; $('#mmAsk').value = v.quote.ask;
  $('#mmMsg').textContent = '';
  try {
    await io.set(`rooms/${S.code}/requests/pending/${S.uid}`, { bid: v.quote.bid, ask: v.quote.ask, ts: io.ts() });
  } catch (err) { $('#mmMsg').textContent = `Not posted: ${err.message}`; }
}

function handleNotice(priv) {
  const n = priv?.notice;
  if (S.lastNoticeTs === null) { S.lastNoticeTs = n?.ts || 0; return; }   // do not replay old notices after a refresh
  if (n && n.ts > S.lastNoticeTs) {
    S.lastNoticeTs = n.ts;
    S.sentTurn = null;
    toast(n.msg, n.kind === 'error' ? 'error' : '');
  }
}

// ---------- host actions ----------

function readSettingsForm() {
  const f = $('#settingsForm');
  const v = name => f.elements[name].value;
  return E.normalizeSettings({
    laps: v('laps'), passCards: v('passCards'), maxShares: v('maxShares'), maxSpread: v('maxSpread'),
    quoteWindowMs: Number(v('quoteWindowSec')) * 1000, priceStep: v('priceStep'), numMM: v('numMM'),
    minInformed: v('minInformed'), maxInformed: v('maxInformed'), practice: f.elements.practice.checked,
  });
}
function fillSettingsForm(s) {
  const f = $('#settingsForm');
  f.elements.laps.value = s.laps; f.elements.passCards.value = s.passCards; f.elements.maxShares.value = s.maxShares;
  f.elements.maxSpread.value = s.maxSpread; f.elements.quoteWindowSec.value = s.quoteWindowMs / 1000;
  f.elements.priceStep.value = s.priceStep; f.elements.numMM.value = s.numMM;
  f.elements.minInformed.value = s.minInformed; f.elements.maxInformed.value = s.maxInformed;
  f.elements.practice.checked = s.practice;
}

async function startRound() {
  $('#hostErr').textContent = '';
  const s = readSettingsForm();
  const players = Object.keys(S.players).filter(u => u !== S.uid);
  if (players.length < 2) return ($('#hostErr').textContent = 'You need at least two players before starting.');
  const fixedMMs = [...S.hostPicks].filter(u => players.includes(u));
  if (fixedMMs.length > s.numMM) return ($('#hostErr').textContent = `You ticked ${fixedMMs.length} market makers but the settings allow ${s.numMM}.`);
  $('#btnStart').disabled = true;
  try { await S.referee.startRound({ fixedMMs, settings: s }); S.hostPicks = new Set(); }
  catch (err) { $('#hostErr').textContent = err.message; }
  finally { $('#btnStart').disabled = false; }
}

async function hostAction(act) {
  $('#hostErr').textContent = '';
  try {
    switch (act) {
      case 'pause': return await S.referee.pause();
      case 'resume': return await S.referee.resume();
      case 'skip': if (confirm('Skip the current trader without using a pass card?')) return await S.referee.skipTurn(); return;
      case 'end': if (confirm('End the game now? No more turns will be played.')) return await S.referee.endRound(); return;
      case 'reveal': return await S.referee.reveal();
      case 'newround': return await S.referee.newRound();
      case 'csv': return downloadCsv();
      case 'board': return window.open(`${location.pathname}?board=${S.code}`, '_blank');
    }
  } catch (err) { $('#hostErr').textContent = err.message; }
}

function downloadCsv() {
  const csv = S.referee.csv();
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trading-game-${S.code}-game${S.meta?.round || 1}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- rendering ----------

function render() {
  if (!S.mode || !S.meta) return;
  renderConn();
  if (S.mode === 'board') return renderBoard();
  if (S.mode === 'host') return renderHost();
  if (S.mode === 'practice') renderPracticeBar();
  renderPlayer();
}

function renderConn() {
  const el = $('#connNotice');
  if (!S.connected) { el.textContent = 'Connection lost. Reconnecting…'; el.hidden = false; return; }
  if (S.mode === 'player' && S.meta && S.meta.hostOnline === false && S.meta.phase !== E.PHASES.LOBBY) {
    el.textContent = 'The host screen is closed, so the game is paused until the instructor reopens it.'; el.hidden = false; return;
  }
  el.hidden = true;
}

const nameOf = uid => S.players?.[uid]?.name || '?';
const mmUids = () => Object.keys(S.pub.marketMakers || {});
const tapeArr = () => Object.values(S.pub.tape || {}).sort((a, b) => (a.turnNo - b.turnNo) || (a.ts - b.ts));

function turnCtx() {
  const order = S.pub.turnOrder || [];
  const t = S.pub.turn;
  const cur = t ? order[t.index] : null;
  const nextIdx = t ? (t.index + 1) % (order.length || 1) : 0;
  const lastTurn = t && t.lap === settings().laps && t.index === order.length - 1;
  return { phase: S.meta.phase, t, cur, next: t && !lastTurn ? order[nextIdx] : null, laps: settings().laps, order };
}

function bannerHtml(me) {
  const { phase, t, cur, next, laps } = turnCtx();
  const sub = t ? `Turn ${t.turnNo} · Round ${t.lap} of ${laps}` : '';
  const nextTxt = next ? ` · Next: ${esc(nameOf(next))}` : '';
  let klass = 'turn-banner', main = '', extra = '';
  switch (phase) {
    case E.PHASES.LOBBY: main = 'Waiting for the host to start the game.'; break;
    case E.PHASES.QUOTING: {
      const waiting = mmUids().filter(u => !S.pub.quotes?.[u]).map(nameOf);
      main = 'Waiting for opening quotes';
      extra = waiting.length ? `From ${esc(waiting.join(' and '))}` : '';
      break;
    }
    case E.PHASES.TRADING:
      if (cur === me) { klass += ' mine'; main = 'Your turn'; }
      else main = `${esc(nameOf(cur))}'s turn`;
      extra = sub + nextTxt;
      break;
    case E.PHASES.WINDOW:
      klass += ' window';
      main = `Market maker quote delay: trading paused <span class="countdown" data-countdown></span>`;
      extra = next ? `Next up: <b>${esc(nameOf(next))}</b>${next === me ? ' (you)' : ''}` : 'Last turn played';
      break;
    case E.PHASES.PAUSED: main = 'Paused by the host'; extra = sub; break;
    case E.PHASES.ENDED: main = 'Game over'; extra = 'Waiting for the host to reveal the true value.'; break;
    case E.PHASES.REVEAL: main = 'Results are in'; break;
  }
  return `<div class="${klass}"><div class="main">${main}</div>${extra ? `<div class="sub">${extra}</div>` : ''}</div>`;
}

function quotesHtml(me) {
  const q = S.pub.quotes || {};
  const best = E.bestQuotes(q);
  const mms = mmUids();
  if (!mms.length) return '<p class="muted">No market makers yet.</p>';
  const rows = mms.map((uid, i) => {
    const x = q[uid];
    const bidC = x && x.bid === best.bestBid ? ' best' : '';
    const askC = x && x.ask === best.bestAsk ? ' best' : '';
    return `<tr class="${uid === me ? 'me' : ''}"><td>Market maker #${i + 1}: ${esc(nameOf(uid))}${uid === me ? ' (you)' : ''}</td>
      <td class="num price bid${bidC}">${x ? money(x.bid) : '—'}</td><td class="num price ask${askC}">${x ? money(x.ask) : '—'}</td></tr>`;
  }).join('');
  const nbbo = `<tr class="nbbo"><td>NBBO <span class="tiny muted">best bid / best ask</span></td>
      <td class="num price bid">${best.bestBid != null ? money(best.bestBid) : '—'}</td><td class="num price ask">${best.bestAsk != null ? money(best.bestAsk) : '—'}</td></tr>`;
  return `<table class="quotes"><thead><tr><th>Quotes</th><th class="num">Bid</th><th class="num">Ask</th></tr></thead><tbody>${rows}</tbody><tfoot>${nbbo}</tfoot></table>`;
}

function tapeHtml(limit = 80) {
  const rows = tapeArr().slice(-limit).reverse();
  if (!rows.length) return '<p class="muted">No trades yet.</p>';
  return rows.map(e => {
    let txt, p = '';
    if (e.side === 'buy' || e.side === 'sell') {
      txt = `${esc(e.traderName)} ${e.side === 'buy' ? 'bought' : 'sold'} ${e.qty} ${e.qty === 1 ? 'share' : 'shares'}`;
      p = money(e.price);
    } else if (e.side === 'pass') txt = `${esc(e.traderName)} passed`;
    else txt = `${esc(e.traderName)} skipped by host`;
    return `<div class="row ${e.side}"><span class="n">#${e.turnNo}</span><span>${txt}</span><span class="p">${p}</span></div>`;
  }).join('');
}

function bookHtml(uid, isMM) {
  const pos = S.pub.positions?.[uid] || { shares: 0, cash: 0, passLeft: 0 };
  const pnl = E.pnlBoth(pos);
  const n = Math.abs(pos.shares);
  const posTxt = pos.shares > 0 ? `Long ${n} ${n === 1 ? 'share' : 'shares'}` : pos.shares < 0 ? `Short ${n} ${n === 1 ? 'share' : 'shares'}` : 'Flat';
  const warn = isMM && n >= 5;
  return `<div class="book-group">
    <div class="book-title">Position</div>
    <div class="book">
      <div class="stat ${warn ? 'warn' : ''}"><div class="k">Shares</div><div class="v ${cls(pos.shares)}">${posTxt}</div>${warn ? '<div class="tiny">Large inventory</div>' : ''}</div>
      <div class="stat"><div class="k">Cash</div><div class="v ${cls(pos.cash)}">${signed(pos.cash)}</div></div>
      ${isMM ? '' : `<div class="stat"><div class="k">Pass cards</div><div class="v">${pos.passLeft ?? 0} left</div></div>`}
    </div>
  </div>
  <div class="book-group">
    <div class="book-title">P&amp;L when settled at the true value</div>
    <div class="book">
      <div class="stat"><div class="k">If the stock is $100</div><div class="v ${cls(pnl.at100)}">${signed(pnl.at100)}</div></div>
      <div class="stat"><div class="k">If the stock is $120</div><div class="v ${cls(pnl.at120)}">${signed(pnl.at120)}</div></div>
    </div>
  </div>`;
}

function roleCardHtml(role, trueValue) {
  const s = settings();
  const rg = S.pub.informedRange;
  const nTr = (S.pub.turnOrder || []).length;
  const told = !rg ? ''
    : rg.min === rg.max ? ` Exactly <b>${rg.min}</b> of the ${nTr} traders ${rg.min === 1 ? 'is' : 'are'} informed.`
    : ` Between <b>${rg.min}</b> and <b>${rg.max}</b> of the ${nTr} traders are informed; the exact number was drawn at random.`;
  if (role === 'informed') {
    const tip = trueValue === 120
      ? 'You want to build a large long position, buying at prices as low as you can. Trade so the price does not trend toward $120 too soon.'
      : 'You want to build a large short position, selling at prices as high as you can. Trade so the price does not trend toward $100 too soon.';
    return `<div class="role-name">Role: Informed trader</div><p>You know the answer: the stock is worth <span class="value">${money(trueValue)}</span>.</p><p class="small muted">Keep it to yourself. Everyone else only knows it is 50/50 between $100 and $120.${told}</p><p class="small"><b>Tip:</b> ${tip}</p>`;
  }
  if (role === 'noise') {
    return `<div class="role-name">Role: Uninformed trader</div><p>The stock is worth <b>$100</b> or <b>$120</b>, 50/50. Fair value is $110.</p><p class="small muted">Some traders know the answer.${told}</p>
      <p class="small"><b>Tip:</b> You don't know the value, but you can learn it by watching how others trade. Informed traders have to trade to profit, so steady buying points to $120 and steady selling points to $100.</p>
      <p class="small">While you're unsure, trade small or pass. Once you think you know, lean with it. Every trade costs you the spread, so don't trade just to trade.</p>`;
  }
  return `<div class="role-name">Role: Market maker</div><p>Keep a bid and an ask posted, no more than <b>${money(s.maxSpread)}</b> apart. You take the other side of every trade at your quoted price.</p><p class="small muted">Quotes are frozen while a trader decides. Change your pending quote any time; it goes live when the quote window closes.${told}</p>
    <p class="small" style="margin-bottom:2px"><b>Tips:</b></p>
    <p class="small" style="margin-top:0"><b>When your position is long:</b> move both quotes down, to encourage others to buy from you and discourage selling to you.</p>
    <p class="small"><b>When your position is short:</b> move both quotes up, to encourage others to sell to you and discourage buying from you.</p>
    <p class="small"><b>When the flow leans one way:</b> shift your quotes in that direction and consider widening the spread. The informed traders are probably on that side.</p>`;
}

// ---- player screens ----

function renderPlayer() {
  const phase = S.meta.phase;
  const role = S.priv?.role;
  if (phase === E.PHASES.LOBBY || !role) return renderWait();
  if (phase === E.PHASES.REVEAL) { showView('reveal'); $('#rvCard').innerHTML = revealHtml(S.pub.reveal, { me: S.uid }); return; }
  if (role === 'mm') return renderMM();
  renderTrader();
}

function renderWait() {
  showView('wait');
  const names = Object.values(S.players).map(p => `<span class="pill"><span class="dot ${p.online ? 'on' : ''}"></span>${esc(p.name)}</span>`).join('');
  const inRound = S.meta.phase !== E.PHASES.LOBBY;
  $('#waitMsg').innerHTML = inRound
    ? `A game is already in progress. You will be dealt in when the host starts the next one.`
    : `You joined room <b>${esc(S.code)}</b> as <b>${esc(S.name || nameOf(S.uid))}</b>. ${S.meta.round > 1 ? `Game ${S.meta.round} is being set up.` : 'Waiting for the host to start.'}`;
  $('#waitPlayers').innerHTML = names;
}

function renderTrader() {
  showView('trader');
  const role = S.priv.role;
  $('#trRole').className = `card role-card ${role}`;
  $('#trRole').innerHTML = roleCardHtml(role, S.priv.trueValue);
  $('#trTurn').innerHTML = bannerHtml(S.uid);
  $('#trQuotes').innerHTML = quotesHtml(S.uid);
  const { phase, t, cur } = turnCtx();
  const s = settings();
  const pos = S.pub.positions?.[S.uid] || { passLeft: 0 };
  const myTurn = phase === E.PHASES.TRADING && cur === S.uid && S.sentTurn !== t?.turnNo;
  const quotesLive = !!S.pub.quotes && Object.keys(S.pub.quotes).length > 0;
  const dis = myTurn && quotesLive ? '' : 'disabled';
  const sizes = Array.from({ length: s.maxShares }, (_, i) => i + 1);
  let pad = '';
  if (S.choice && myTurn) {
    pad = `<div class="chooser">Both market makers show <b>${money(S.choice.price)}</b>. ${S.choice.side === 'buy' ? 'Buy' : 'Sell'} ${S.choice.qty} from:
      ${S.choice.makers.map(u => `<button class="btn" data-mm="${esc(u)}">${esc(nameOf(u))}</button>`).join(' ')}
      <button class="btn small" data-cancel="1">Cancel</button></div>`;
  } else {
    const best = E.bestQuotes(S.pub.quotes || {});
    const at = v => (v != null ? ` ${money(v)}` : '');
    pad = `<div class="sides">
        <div class="side">
          <div class="btns">${sizes.map(n => `<button class="btn sell" data-side="sell" data-qty="${n}" ${dis}>Sell ${n}</button>`).join('')}</div>
          <div class="cap">Sell at best bid${at(best.bestBid)}</div>
        </div>
        <div class="side">
          <div class="btns">${sizes.map(n => `<button class="btn buy" data-side="buy" data-qty="${n}" ${dis}>Buy ${n}</button>`).join('')}</div>
          <div class="cap">Buy at best ask${at(best.bestAsk)}</div>
        </div>
      </div>
      <div class="row"><button class="btn" data-side="pass" ${dis || (pos.passLeft > 0 ? '' : 'disabled')}>Pass (${pos.passLeft ?? 0} left)</button></div>`;
  }
  $('#trPad').innerHTML = pad;
  $('#trMsg').textContent = S.sentTurn === t?.turnNo && phase === E.PHASES.TRADING ? 'Order sent, waiting for the host…' : (myTurn && pos.passLeft === 0 ? 'No pass cards left: you must trade.' : '');
  $('#trBook').innerHTML = bookHtml(S.uid, false);
  drawChart($('#trChart'), tapeArr(), chartSecrets());
  $('#trTape').innerHTML = tapeHtml();
}

function renderMM() {
  showView('mm');
  const s = settings();
  $('#mmRole').innerHTML = roleCardHtml('mm');
  $('#mmTurn').innerHTML = bannerHtml(S.uid);
  const live = S.pub.quotes?.[S.uid] || null;
  const pend = S.pending && E.validateQuote(S.pending, s).ok ? E.validateQuote(S.pending, s).quote : null;
  const changed = pend && (!live || live.bid !== pend.bid || live.ask !== pend.ask);
  const rivals = mmUids().filter(u => u !== S.uid);
  const q = v => (v ? `${money(v.bid)} / ${money(v.ask)}` : '—');
  $('#mmQuotes').innerHTML = `
    <div class="quote-pair">
      <div class="qbox live"><div class="k">Your live quote</div><div class="v">${q(live)}</div><div class="tiny muted">${live ? 'What traders trade against right now' : 'Not posted yet'}</div></div>
      <div class="qbox pending ${changed ? 'changed' : ''}"><div class="k">Your pending quote</div><div class="v">${q(pend)}</div><div class="tiny muted">${pend ? (changed ? (S.meta.phase === E.PHASES.QUOTING ? 'Goes live when the market opens' : 'Goes live when the quote window closes') : 'Same as live') : 'Post one below'}</div></div>
    </div>
    ${rivals.map(u => `<div class="small">Rival <b>${esc(nameOf(u))}</b>: ${q(S.pub.quotes?.[u])}</div>`).join('')}`;
  // pre-fill the inputs once per round so typing is never overwritten
  if (S.mmFormRound !== S.meta.round) {
    S.mmFormRound = S.meta.round;
    const src = pend || live || { bid: 110 - Math.min(2, s.maxSpread / 2), ask: 110 + Math.min(2, s.maxSpread / 2) };
    $('#mmBid').value = src.bid; $('#mmAsk').value = src.ask;
    $('#mmMsg').textContent = '';
  }
  $('#mmPost').textContent = S.meta.phase === E.PHASES.QUOTING && !pend ? 'Post opening quote' : 'Post';
  const locked = [E.PHASES.ENDED, E.PHASES.REVEAL, E.PHASES.LOBBY].includes(S.meta.phase);
  for (const b of $$('#mmForm button, #mmForm input')) b.disabled = locked;
  $('#mmBook').innerHTML = bookHtml(S.uid, true);
  drawChart($('#mmChart'), tapeArr(), chartSecrets());
  $('#mmTape').innerHTML = tapeHtml();
}

// ---- host screen ----

function phaseLabel(p) {
  return { lobby: 'Lobby', quoting: 'Waiting for opening quotes', trading: 'Trading', window: 'Quote window', paused: 'Paused', ended: 'Game over', reveal: 'Revealed' }[p] || p;
}

function renderHost() {
  showView('host');
  const phase = S.meta.phase;
  $('#hostCode').textContent = S.code;
  $('#hostPhase').textContent = `Game ${S.meta.round || 1} · ${phaseLabel(phase)}`;

  const acts = [];
  if ([E.PHASES.QUOTING, E.PHASES.TRADING, E.PHASES.WINDOW].includes(phase)) acts.push(['pause', 'Pause']);
  if (phase === E.PHASES.PAUSED) acts.push(['resume', 'Resume']);
  if (phase === E.PHASES.TRADING) acts.push(['skip', 'Skip turn']);
  if ([E.PHASES.QUOTING, E.PHASES.TRADING, E.PHASES.WINDOW, E.PHASES.PAUSED].includes(phase)) acts.push(['end', 'End game', 'danger']);
  if (phase === E.PHASES.ENDED) acts.push(['reveal', 'Reveal', 'primary']);
  if (phase === E.PHASES.REVEAL) acts.push(['newround', 'New game', 'primary']);
  if (S.pub.tape) acts.push(['csv', 'Export CSV']);
  acts.push(['board', 'Open board']);
  $('#hostActions').innerHTML = acts.map(([a, l, k = '']) => `<button class="btn ${k}" data-act="${a}">${l}</button>`).join('');

  const inLobby = phase === E.PHASES.LOBBY;
  $('#hostLobby').hidden = !inLobby;
  $('#hostLive').hidden = inLobby;
  $('#hostReveal').hidden = phase !== E.PHASES.REVEAL;

  if (inLobby) {
    if (S.settingsRound !== S.meta.round) { S.settingsRound = S.meta.round; fillSettingsForm(settings()); }
    const players = Object.entries(S.players).filter(([u]) => u !== S.uid);
    $('#hostPlayerCount').textContent = players.length ? `(${players.length})` : '';
    const hist = S.pub.mmHistory || {};
    $('#hostPlayers').innerHTML = players.length
      ? players.sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([u, p]) => `<div class="row">
          <span class="dot ${p.online ? 'on' : ''}" title="${p.online ? 'online' : 'offline'}"></span>
          <span class="name">${esc(p.name)} ${hist[u] ? '<span class="tiny muted">(made markets before)</span>' : ''}</span>
          <label class="small"><input type="checkbox" data-pick="${esc(u)}" ${S.hostPicks.has(u) ? 'checked' : ''}> Market maker</label>
          <button class="btn small" data-remove="${esc(u)}" title="Remove">×</button></div>`).join('')
      : '<p class="muted">Nobody has joined yet.</p>';
    return;
  }

  $('#hostTurn').innerHTML = bannerHtml(null) + (phase === E.PHASES.QUOTING ? quotingStatusHtml() : '');
  $('#hostQuotes').innerHTML = quotesHtml(null);
  $('#hostTally').innerHTML = tallyHtml();
  const z = E.sumPnl(S.pub.positions || {});
  const ok = z.at100 === 0 && z.at120 === 0;
  $('#hostZero').className = `small zero ${ok ? 'ok' : 'bad'}`;
  $('#hostZero').textContent = ok ? 'Zero-sum check: both P&L columns sum to $0.' : `Zero-sum check FAILED: ${signed(z.at100)} / ${signed(z.at120)}.`;
  drawChart($('#hostChart'), tapeArr(), chartSecrets());
  $('#hostTape').innerHTML = tapeHtml(200);
  if (phase === E.PHASES.REVEAL) $('#hostReveal').innerHTML = revealHtml(S.pub.reveal, { host: true });
}

function quotingStatusHtml() {
  const s = settings();
  return `<div class="small muted">${mmUids().map(u => {
    const v = E.validateQuote(S.pendingAll[u], s);
    return `${esc(nameOf(u))}: ${v.ok ? `<span class="ok">${money(v.quote.bid)} / ${money(v.quote.ask)}</span>` : (S.pendingAll[u] ? `<span class="neg">${esc(v.error)}</span>` : 'nothing yet')}`;
  }).join(' · ')}</div>`;
}

function tallyHtml() {
  const roles = S.host?.roles || {};
  const { cur } = turnCtx();
  const order = S.pub.turnOrder || [];
  const uids = [...mmUids(), ...order];
  const roleName = { mm: 'Market maker', informed: 'Informed', noise: 'Noise' };
  const rows = uids.map(u => {
    const pos = S.pub.positions?.[u] || { shares: 0, cash: 0, passLeft: 0 };
    const p = E.pnlBoth(pos);
    const r = roles[u];
    return `<tr class="${u === cur ? 'turn' : ''}"><td>${esc(nameOf(u))} <span class="dot ${S.players[u]?.online ? 'on' : ''}"></span></td>
      <td class="role">${roleName[r] || '—'}${r === 'informed' ? ` (${money(S.host?.trueValue)})` : ''}</td>
      <td class="num">${pos.shares}</td><td class="num">${signed(pos.cash)}</td><td class="num">${r === 'mm' ? '—' : pos.passLeft ?? 0}</td>
      <td class="num ${cls(p.at100)}">${signed(p.at100)}</td><td class="num ${cls(p.at120)}">${signed(p.at120)}</td></tr>`;
  }).join('');
  return `<table class="tally"><thead><tr><th>Player</th><th>Role (host only)</th><th class="num">Shares</th><th class="num">Cash</th><th class="num">Passes</th><th class="num">If $100</th><th class="num">If $120</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="tiny muted">True value this game: <b>${money(S.host?.trueValue)}</b>. Only you can see this column and this line.</p>`;
}

// ---- board ----

function renderBoard() {
  showView('board');
  $('#bdCode').textContent = S.code;
  $('#bdPhase').textContent = `Game ${S.meta.round || 1} · ${phaseLabel(S.meta.phase)}`;
  $('#bdTurn').innerHTML = bannerHtml(null).replace('class="turn-banner', 'class="turn-banner big');
  $('#bdQuotes').innerHTML = quotesHtml(null);
  $('#bdTape').innerHTML = tapeHtml(40);
  drawChart($('#bdChart'), tapeArr(), chartSecrets());
  const rv = S.meta.phase === E.PHASES.REVEAL;
  $('#bdReveal').hidden = !rv;
  if (rv) $('#bdReveal').innerHTML = revealHtml(S.pub.reveal, {});
}

// ---- reveal ----

function revealHtml(rv, { me, host } = {}) {
  if (!rv) return '<p class="muted">Waiting for results…</p>';
  const roleName = { mm: 'Market makers', informed: 'Informed traders', noise: 'Noise traders' };
  const groups = ['mm', 'informed', 'noise'].map(role => {
    const rows = (rv.results || []).filter(r => r.role === role);
    if (!rows.length) return '';
    return `<h3>${roleName[role]}</h3><table><thead><tr><th>Rank</th><th>Player</th><th class="num">Shares</th><th class="num">Cash</th><th class="num">P&amp;L at ${money(rv.trueValue)}</th></tr></thead><tbody>
      ${rows.map(r => `<tr class="${r.rank === 1 ? 'rank1' : ''} ${r.uid === me ? 'me' : ''}"><td>${r.rank} of ${r.roleSize}</td><td>${esc(r.name)}${r.uid === me ? ' (you)' : ''}</td>
        <td class="num">${r.shares}</td><td class="num">${signed(r.cash)}</td><td class="num ${cls(r.pnl)}">${signed(r.pnl)}</td></tr>`).join('')}</tbody></table>`;
  }).join('');
  return `<div class="reveal-head"><h2>Game ${rv.round || ''} reveal</h2><span class="value">The stock was worth ${money(rv.trueValue)}</span>${rv.practice ? '<span class="pill">Practice game: nothing scored</span>' : ''}</div>${groups}`;
}

// ---- chart ----

/**
 * Price chart in the style of a microstructure textbook figure: a shaded bid-to-ask band with a
 * midpoint step line, hollow triangles for trades (up = buy, down = sell) sized by order quantity,
 * filled triangles for informed traders when that is known, and a dashed true-value line.
 * opts: { informed: Set<uid>, trueValue: number }
 */
function drawChart(svg, tape, opts = {}) {
  if (!svg) return;
  const W = 640, H = 320, L = 52, R = 16, T = 48, B = 36;
  const n = tape.length;
  if (!n) { svg.innerHTML = `<text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No trades yet</text>`; return; }
  const informed = opts.informed || new Set();
  const vals = [99, 121];
  for (const e of tape) { if (e.bestBid != null) vals.push(e.bestBid - 1); if (e.bestAsk != null) vals.push(e.bestAsk + 1); if (e.price != null) vals.push(e.price); }
  if (opts.trueValue != null) vals.push(opts.trueValue - 2, opts.trueValue + 2);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const slot = (W - L - R) / n;
  const x0 = i => L + slot * i, x1 = i => L + slot * (i + 1), xc = i => L + slot * (i + 0.5);
  const y = v => T + (hi - v) * (H - T - B) / (hi - lo);
  const f = v => v.toFixed(1);
  let out = '';

  // bid-to-ask band and midpoint step line
  const quoted = tape.map((e, i) => ({ e, i })).filter(({ e }) => e.bestBid != null && e.bestAsk != null);
  if (quoted.length) {
    const top = quoted.map(({ e, i }) => `L${f(x0(i))},${f(y(e.bestAsk))} L${f(x1(i))},${f(y(e.bestAsk))}`).join(' ');
    const bottom = quoted.slice().reverse().map(({ e, i }) => `L${f(x1(i))},${f(y(e.bestBid))} L${f(x0(i))},${f(y(e.bestBid))}`).join(' ');
    out += `<path class="band" d="M${f(x0(quoted[0].i))},${f(y(quoted[0].e.bestAsk))} ${top} ${bottom} Z"/>`;
    const mid = quoted.map(({ e, i }) => { const m = y((e.bestBid + e.bestAsk) / 2); return `${f(x0(i))},${f(m)} ${f(x1(i))},${f(m)}`; }).join(' ');
    out += `<polyline class="midline" points="${mid}"/>`;
  }

  // y axis labels (no gridlines, like the reference figure)
  for (const v of [100, 110, 120]) if (v >= lo && v <= hi) out += `<text x="${L - 10}" y="${f(y(v) + 4)}" text-anchor="end">$${v}</text>`;

  // true value, when the viewer is allowed to know it
  if (opts.trueValue != null) {
    out += `<line class="truth" x1="${L}" x2="${W - R}" y1="${f(y(opts.trueValue))}" y2="${f(y(opts.trueValue))}"/>`;
    out += `<text class="truth-label" x="${W - R}" y="${f(y(opts.trueValue) - 8)}" text-anchor="end">True value $${opts.trueValue}</text>`;
  }

  // trades as triangles; size grows with quantity, filled when the trader is known to be informed
  const tri = (cx, cy, r, up) => up
    ? `${f(cx)},${f(cy - r)} ${f(cx - r * 0.95)},${f(cy + r * 0.75)} ${f(cx + r * 0.95)},${f(cy + r * 0.75)}`
    : `${f(cx)},${f(cy + r)} ${f(cx - r * 0.95)},${f(cy - r * 0.75)} ${f(cx + r * 0.95)},${f(cy - r * 0.75)}`;
  for (let i = 0; i < n; i++) {
    const e = tape[i];
    if (e.price == null) continue;
    const r = 5 + 1.8 * Math.min(e.qty || 1, 5);
    const filled = informed.has(e.traderUid);
    out += `<polygon class="tri ${e.side} ${filled ? 'filled' : 'hollow'}" points="${tri(xc(i), y(e.price), r, e.side === 'buy')}">`
      + `<title>#${e.turnNo} ${esc(e.traderName)} ${e.side === 'buy' ? 'bought' : 'sold'} ${e.qty} @ $${e.price}${filled ? ' (informed)' : ''}</title></polygon>`;
  }

  // x axis labels
  out += `<text x="${L}" y="${H - 10}">First turn</text><text x="${W - R}" y="${H - 10}" text-anchor="end">Last turn</text>`;

  // legend
  let lx = L, ly = 20;
  const item = (shape, label) => { out += shape; out += `<text x="${lx + 14}" y="${ly + 4}">${label}</text>`; lx += 14 + label.length * 7 + 22; };
  item(`<polygon class="tri buy hollow" points="${tri(lx, ly, 6, true)}"/>`, 'Buy');
  item(`<polygon class="tri sell hollow" points="${tri(lx, ly, 6, false)}"/>`, 'Sell');
  if (informed.size) item(`<polygon class="tri buy filled" points="${tri(lx, ly, 6, true)}"/>`, 'Informed');
  item(`<rect class="band" x="${lx - 7}" y="${ly - 5}" width="14" height="10"/>`, 'Bid to ask');

  svg.innerHTML = out;
}

/** Who is known to be informed, and the true value, for the current viewer. */
function chartSecrets() {
  if (S.mode === 'host' && S.host?.roles) {
    const roles = S.host.roles;
    return { informed: new Set(Object.keys(roles).filter(u => roles[u] === 'informed')), trueValue: S.host.trueValue };
  }
  const rv = S.pub?.reveal;
  if (rv && S.meta?.phase === E.PHASES.REVEAL) {
    const inf = rv.informed && rv.informed.length ? rv.informed : (rv.results || []).filter(r => r.role === 'informed').map(r => r.uid);
    return { informed: new Set(inf), trueValue: rv.trueValue };
  }
  return {};
}

// ---- countdown ----

function tickCountdown() {
  const els = $$('[data-countdown]');
  if (!els.length) return;
  const endsAt = S.pub?.windowEndsAt;
  const txt = endsAt ? `${Math.max(0, Math.ceil((endsAt - serverNow()) / 1000))}s` : '';
  for (const el of els) el.textContent = txt;
}

main().catch(err => fail(err));
