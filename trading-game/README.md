# Trading game

A live, browser-based version of the classroom "trading pit" game. Students join from a laptop or phone, market makers quote, traders trade one at a time, and everyone sees their position and P&L update on every trade. The instructor runs the round from a host screen.

- Front end: this folder, served by GitHub Pages at `/trading-game/`. Plain HTML, CSS and JavaScript modules, no build step.
- Back end: Firebase Realtime Database on the free Spark plan, with anonymous sign-in. Nobody needs an account.

## One-time setup (about 15 minutes)

1. **Create a Firebase project.** Go to <https://console.firebase.google.com>, click *Add project*, give it a name, and turn Google Analytics off. The free Spark plan is enough.
2. **Enable anonymous sign-in.** In the left menu choose *Build → Authentication → Get started → Sign-in method*, pick *Anonymous*, switch it on, and save.
3. **Create the database.** Choose *Build → Realtime Database → Create database*. Pick the location closest to you and choose **locked mode**.
4. **Publish the rules.** In the database page open the *Rules* tab, replace everything with the contents of [`database.rules.json`](database.rules.json), and click *Publish*. These rules make the host the only account that can write game state, and keep each student's role card readable only by that student.
5. **Register a web app and copy the config.** Click the gear next to *Project Overview → Project settings*. Under *Your apps* click the `</>` icon, give the app a nickname, skip Firebase Hosting, and register. Copy the `firebaseConfig` object shown and paste it into [`firebase-config.js`](firebase-config.js), replacing the placeholder values. This object is a public identifier, not a secret, so it is fine to commit. Never commit a service account key.
6. **Commit and push.** GitHub Pages redeploys in a minute or two. Open `https://<your-user>.github.io/trading-game/play.html`. The landing page with the rules is `trading-game.html` at the site root, linked from the nav; `play.html` is the game itself. If you still see the yellow "Setup needed" box, the config was not pasted correctly.

If the site is served from a custom domain, add it under *Authentication → Settings → Authorized domains*. `github.io` subdomains and `localhost` work without changes.

## Running a class

**Before class**, on the computer you will project from or run the game from:

1. Open the page and click **Start a game**. You get a four-letter room code. The page remembers that you are the host of that room in this browser, so a refresh brings you straight back.
2. Optionally click **Open board** to get a second tab with quotes, the tape and the price chart, and project that one. The board shows no individual P&L.

**Students** open the same link, type their first name and the room code, and appear in your lobby. If a student's device shows them offline, the grey dot next to their name tells you.

**Start a game.** Check the settings (defaults are 6 rounds, 2 pass cards, up to 3 shares per order, a $6 maximum spread, a 3-second quote window, 2 market makers, and between 1 and 3 informed traders, the exact number drawn at random each game). Tick a player's box to make them a market maker, or leave it to the app, which favours students who have not made markets yet. Click **Start game**. The app flips the coin, deals roles, and shows each student a private role card.

**During the round** the host screen shows whose turn it is, both quotes, a tally of every player with roles (only you can see the roles and the true value), the tape, the chart and a zero-sum check. Buttons let you pause, skip a trader who has wandered off, or end the round early. The game cannot proceed while your host tab is closed; students see a banner saying so, and it resumes when you reopen the page.

**Reveal.** When the rounds are done, click **Reveal**. Everyone sees the true value, who was informed, P&L at the true value, and their rank within their role. Click **Export CSV** to download the trade log.

**Next game.** Click **New game**. Students stay in the room, positions and pass cards reset, and you can change the settings. The suggested session is: a practice round (tick *Practice round*), then a game with the default range of informed traders, then one with a wider or narrower range. Players are told the range, never the draw.

## Practice mode

Anyone can rehearse the screens alone, with no room and no Firebase, by opening `play.html?practice=noise`, `?practice=informed`, or `?practice=mm` (the landing page links to all three). The other seats are filled by dummy players named Computer1 to Computer9, so there are always 2 market makers and 8 traders: market makers post a plain opening quote and occasionally nudge it one step, traders place random orders. It runs five rounds, reveals automatically, and offers Restart. Nothing is saved. The same engine, referee and screens are used, backed by an in-memory store (`localdb.js`) instead of the database.

## Rules of the game (as implemented)

- The stock is worth $100 or $120, 50/50. Everyone starts with zero shares and zero cash. Short positions are allowed. The game is zero-sum.
- Market makers must have both a bid and an ask posted, no further apart than the maximum spread. Both must post an opening quote before the first turn starts. They get no pass cards.
- Traders go in a fixed random order for the set number of rounds. On a turn a trader buys or sells 1 to the maximum number of shares at the best quote, or plays a pass card. With no pass cards left they must trade. If both market makers show the same best price, the trader picks one.
- Live quotes freeze during a trader's turn. After the fill there is a quote window with a visible countdown. Market makers can change their pending quote at any time, including during a turn; it only ever goes live when the window closes. The market maker screen shows live and pending quotes side by side.
- P&L is shown in two columns, "if $100" and "if $120", because most players do not know the answer. At the reveal, P&L is computed at the true value and players are ranked within role.

## How the pieces fit

| File | Role |
|---|---|
| `../trading-game.html` | Landing page at the site root, linked from the nav: overview of roles and rules, with a button into the game. |
| `play.html`, `styles.css` | The game: a single page with every screen (lobby, trader, market maker, host, board, reveal). |
| `engine.js` | Pure game rules: quote validation, best-price routing, fills, P&L, dealing roles, ranking, CSV. No Firebase, no DOM. |
| `referee.js` | The host's game loop. Validates every order and pending quote, records fills, runs the quote window, advances turns, builds the reveal. Runs only in the host's browser. |
| `app.js` | Firebase wiring, routing between screens, rendering. |
| `practice.js`, `localdb.js` | Solo practice mode: dummy players and the in-memory store they run against. |
| `firebase-config.js` | Your project's public config. |
| `database.rules.json` | Security rules to publish in the console. |
| `tests/` | Unit tests for the engine and an end-to-end test of the referee against an in-memory stand-in for the database. |

### Data layout in the database

Everything for one game lives under `rooms/<CODE>/`:

- `meta`: host uid, phase, round number, settings. Readable by anyone signed in; writable only by the host.
- `players/<uid>`: name and online flag. Each player writes only their own.
- `public`: market makers, turn order, current turn, live quotes, positions, tape, quote-window deadline, reveal. Host-only writes.
- `private/<uid>`: the player's role card (and the true value if informed) plus notices from the referee. Readable only by that player and the host.
- `host`: the true value and every role. Host only.
- `requests/orders/<uid>` and `requests/pending/<uid>`: what players are allowed to write. Each player writes their own; the host reads and clears them.

### Trust model

The host's browser is the referee: it flips the coin, deals roles, and is the only writer of fills, positions and the tape. Players can only write an order request or a pending quote under their own uid, and the referee checks turn order, pass cards, the share limit, the spread limit and quote timing before acting. Nothing public contains the true value or who is informed until the reveal. Anyone with access to the host's device could read the answer; that is an accepted trade-off for a classroom game.

A student's identity is their browser's anonymous Firebase account. Refreshing the page or coming back after a dropped connection restores their role, position and pass cards. Clearing site data or switching browsers mid-round creates a new identity; they would need to be dealt in at the next round.

## Tests

From this folder, with Node 20 or newer:

```
node --test tests/
```

Without Node installed, VS Code's bundled runtime works from Git Bash:

```
ELECTRON_RUN_AS_NODE=1 "/c/Users/<you>/AppData/Local/Programs/Microsoft VS Code/Code.exe" --test tests/engine.test.js tests/referee.test.js
```

The tests cover the fill and P&L arithmetic, the zero-sum invariant after every write, the pending-quote freeze, tie handling, pass-card exhaustion, a full round through reveal and a second round, pause and resume, skipping, and the host reloading mid-window.

### Checking the rules in the console

The Realtime Database page has a *Rules Playground*. Useful checks, each simulated as an authenticated user with a made-up uid:

- Read `rooms/ABCD/private/<someone else's uid>` as a player: should be denied.
- Read `rooms/ABCD/host` as a player: denied.
- Write `rooms/ABCD/public/positions/<own uid>` as a player: denied.
- Write `rooms/ABCD/requests/orders/<own uid>` with `{side: "buy", qty: 1, turnNo: 1, ts: 1}` as that player: allowed.

### Multi-tab dry run

Open the page in one normal window as the host and in several private or guest windows as players (each private window gets its own anonymous identity). Two market makers and three traders are enough to play a short round with 1 or 2 laps.

## Still open

- Turn timer for traders, and what happens when it runs out.
- Whether the CSV layout should match the workbook's Log sheet exactly for the pandas exercise. The current export has one row per turn with clock time, trader, action, size, price, market maker, best bid and ask at the time, and the trader's position afterward.


## Terminology

In the interface a **round** is one pass through the trading order (one turn per trader) and a **game** is a full session from deal to reveal. The code keeps the older names: `laps` for rounds and `round` for the game counter.
