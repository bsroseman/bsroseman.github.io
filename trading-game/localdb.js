// localdb.js — an in-memory stand-in for the Realtime Database.
// Used by practice mode so the real screens and the real referee can run in one tab
// with no Firebase project, no sign-in, and no network. Mirrors the behaviours the
// app relies on: multi-path updates, synchronous listener callbacks, empty objects
// and arrays being dropped, and {'.sv': 'timestamp'} resolving to the current time.

export function createLocalDb({ now = Date.now } = {}) {
  const data = {};
  const listeners = new Set();
  let n = 0;

  const parts = p => String(p).split('/').filter(Boolean);

  function readRaw(path) {
    let o = data;
    for (const k of parts(path)) {
      if (o == null || typeof o !== 'object') return null;
      o = o[k];
    }
    return o === undefined ? null : o;
  }

  function resolve(v, at) {
    if (v === undefined) throw new Error(`Cannot write undefined at ${at}`);
    if (v === null || typeof v !== 'object') return v;
    if (v['.sv'] === 'timestamp') return now();
    const out = Array.isArray(v) ? [] : {};
    for (const [k, c] of Object.entries(v)) {
      if (c === undefined) throw new Error(`Cannot write undefined at ${at}/${k}`);
      if (c === null) continue;
      out[k] = resolve(c, `${at}/${k}`);
    }
    return out;
  }

  function write(path, val) {
    const ps = parts(path);
    if (!ps.length) throw new Error('Refusing to write the root');
    let o = data;
    for (let i = 0; i < ps.length - 1; i++) {
      if (o[ps[i]] == null || typeof o[ps[i]] !== 'object') o[ps[i]] = {};
      o = o[ps[i]];
    }
    const last = ps[ps.length - 1];
    if (val === null) delete o[last];
    else o[last] = resolve(val, path);
  }

  function prune(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v && typeof v === 'object') {
        prune(v);
        if (!Object.keys(v).length) delete o[k];
      }
    }
  }

  function notify() {
    for (const l of Array.from(listeners)) l.fire();
  }

  const clone = v => (v == null ? null : JSON.parse(JSON.stringify(v)));

  return {
    now,
    read: path => clone(readRaw(path)),
    async set(path, val) { write(path, val); prune(data); notify(); },
    async update(base, obj) {
      for (const [k, v] of Object.entries(obj)) write(`${base}/${k}`, v);
      prune(data);
      notify();
    },
    /** Like onValue: fires immediately with the current value, then on every change to it. */
    subscribe(path, cb) {
      const l = {
        last: undefined,
        fire() {
          const v = readRaw(path);
          const j = JSON.stringify(v ?? null);
          if (j !== l.last) { l.last = j; cb(clone(v)); }
        },
      };
      listeners.add(l);
      l.fire();
      return () => listeners.delete(l);
    },
    pushKey: () => 'k' + String(++n).padStart(6, '0'),
  };
}
