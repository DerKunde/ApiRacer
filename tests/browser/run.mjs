// Browser test for reconnect, the ready confirmation and the race end: the host and the phones run as headless Chrome
// tabs, driven over the Chrome DevTools Protocol. Phones have no motion sensors there, so the test clicks the buttons
// itself and fakes connection states where a real network failure can't be produced.
//
// Run: npm run test:browser (about 3 minutes, it waits for the real rejoin grace)
// Needs Google Chrome; CHROME_PATH overrides where to find it. Starts its own signaling server (3101), Vite (5199) and
// Chrome (9333) – these ports must be free, so it can run next to `npm run dev`.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DEFAULT_CHROME = {
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] ?? 'google-chrome';
const CHROME = process.env.CHROME_PATH ?? DEFAULT_CHROME;
// Not below the project folder's watched files: Vite would reload the pages whenever Chrome writes its profile
const PROFILE = join(ROOT, 'node_modules', '.cache', 'browser-test-profile');
const BASE = 'http://127.0.0.1:5199';
const CDP = 'http://127.0.0.1:9333';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (text, needle) => text.split(needle).length - 1;
let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
async function waitUntil(fn, what, timeout = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      if (await fn()) return;
    } catch {}
    await sleep(250);
  }
  throw new Error(`Timeout: ${what}`);
}

const children = [];
function start(name, cmd, args, { env = {}, show = false } = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env } });
  const print = (d) => show && process.stdout.write(String(d).replace(/^(?=.)/gm, `      [${name}] `));
  child.stdout.on('data', print);
  child.stderr.on('data', print);
  children.push(child);
  return child;
}
const startServer = () => start('server', process.execPath, ['--import', 'tsx', 'server/server.ts'], { env: { PORT: '3101' }, show: true });
const serverUp = () =>
  new Promise((r) => {
    const ws = new WebSocket('ws://127.0.0.1:3101');
    ws.on('open', () => (ws.close(), r(true)));
    ws.on('error', () => r(false));
  });

// Wraps WebSocket and RTCPeerConnection so the test can reach the page's instances
const INJECT = `
  window.__sockets = [];
  window.__blockWs = false;
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(window.__blockWs ? 'ws://127.0.0.1:1/' : url, protocols);
      window.__sockets.push(this);
    }
  };
  // Without Vite's HMR socket
  window.__sig = () => window.__sockets.filter((s) => !s.url.includes('token='));
  window.__pcs = [];
  window.__channels = [];
  const NativePeerConnection = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeerConnection {
    constructor(config) {
      super(config);
      window.__pcs.push(this);
    }
    createDataChannel(label, options) {
      const channel = super.createDataChannel(label, options);
      window.__channels.push(channel);
      return channel;
    }
  };
`;

class Page {
  static async open(name, url, inject) {
    const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' })).json();
    const page = new Page(name, target.id, new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false }));
    await new Promise((r, j) => (page.ws.once('open', r), page.ws.once('error', j)));
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    if (inject) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: inject });
    await page.send('Page.navigate', { url });
    return page;
  }

  constructor(name, targetId, ws) {
    Object.assign(this, { name, targetId, ws, nextId: 0, pending: new Map() });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        console.log(`      [${this.name} Exception] ${d.exception?.description ?? d.text}`);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  waitFor(expression, what, timeout = 15000) {
    return waitUntil(() => this.eval(expression), `${this.name}: ${what}`, timeout);
  }

  log() {
    return this.eval(`document.getElementById('log').textContent`);
  }

  close() {
    return fetch(`${CDP}/json/close/${this.targetId}`);
  }
}

const pages = [];
async function openHost(name) {
  const host = await Page.open(name, `${BASE}/host.html`, INJECT);
  pages.push(host);
  await host.waitFor(`document.getElementById('room-code').textContent.trim().length === 4`, 'Raumcode', 30000);
  host.roomId = await host.eval(`document.getElementById('room-code').textContent.trim()`);
  return host;
}
async function openPhone(name, roomId) {
  const phone = await Page.open(name, `${BASE}/controller.html?room=${roomId}`, INJECT);
  pages.push(phone);
  await phone.waitFor(`document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'DataChannel offen', 20000);
  return phone;
}
/** Hello button on the phone → does the message reach the host over the DataChannel? */
async function helloArrives(host, phone, peerId) {
  const before = count(await host.log(), `[${peerId}] 💬`);
  await phone.eval(`document.getElementById('hello-btn').click()`);
  try {
    await host.waitFor(`document.getElementById('log').textContent.split('[${peerId}] 💬').length - 1 > ${before}`, 'hello', 5000);
    return true;
  } catch {
    return false;
  }
}
const UFRAG = `__pcs[0].localDescription.sdp.match(/a=ice-ufrag:(\\S+)/)[1]`;
const fakeState = (state, dispatch) => `(() => {
  const pc = __pcs[0];
  Object.defineProperty(pc, 'connectionState', { get: () => '${state}', configurable: true });
  ${dispatch ? `pc.dispatchEvent(new Event('connectionstatechange'));` : ''}
})()`;
const REAL_STATE = `delete __pcs[0].connectionState`;
const joinScreen = (phone) => phone.eval(`document.getElementById('join-screen').hidden ? null : document.getElementById('join-message').textContent`);

try {
  mkdirSync(PROFILE, { recursive: true });
  startServer();
  start('vite', process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'tests/browser/vite.config.ts']);
  start('chrome', CHROME, [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${PROFILE}`, '--no-first-run',
    '--no-default-browser-check', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-features=WebRtcHideLocalIpsWithMdns', 'about:blank',
  ]);
  await waitUntil(serverUp, 'Server');
  await waitUntil(() => fetch(`${BASE}/controller.html`).then((r) => r.ok), 'Vite');
  await waitUntil(() => fetch(`${CDP}/json/version`).then((r) => r.ok), 'Chrome');

  const host = await openHost('host');
  console.log(`Raum ${host.roomId}`);

  console.log('\nA: nur die WebSocket bricht ab, WebRTC läuft weiter');
  const p1 = await openPhone('handy1', host.roomId);
  const ufrag0 = await p1.eval(UFRAG);
  check('hello vorher', await helloArrives(host, p1, 'p1'));
  await p1.eval(`__sig().at(-1).close()`);
  await p1.waitFor(`document.getElementById('log').textContent.includes('Raum wieder beigetreten als p1')`, 'Rejoin');
  check('WebRTC blieb verbunden', (await p1.eval(`__pcs[0].connectionState`)) === 'connected');
  check('kein ICE-Neustart, dieselbe Verbindung', !(await p1.log()).includes('ICE-Neustart') && (await p1.eval(UFRAG)) === ufrag0 && (await p1.eval('__pcs.length')) === 1);
  check('hello nachher', await helloArrives(host, p1, 'p1'));
  check('Host hat p1 behalten, kein neuer Spieler', !(await host.log()).includes('[p1] hat den Raum verlassen') && !(await host.log()).includes('[p2]'));

  console.log('\nB: Verbindung "failed" bei laufendem Server → ICE-Neustart');
  await p1.eval(fakeState('failed', true));
  await p1.eval(REAL_STATE);
  await p1.waitFor(`${UFRAG} !== '${ufrag0}' && __pcs[0].signalingState === 'stable' && __pcs[0].connectionState === 'connected'`, 'ICE-Neustart fertig');
  // The real state never left 'connected' (only faked), so the browser fires no event – a real failed → connected does
  await p1.eval(`__pcs[0].dispatchEvent(new Event('connectionstatechange'))`);
  const ufrag1 = await p1.eval(UFRAG);
  check('ICE-Neustart ausgehandelt (neues ice-ufrag)', ufrag1 !== ufrag0, `${ufrag0} → ${ufrag1}`);
  { const n = await p1.eval('__pcs.length'); const st = await p1.eval(`document.getElementById('status').textContent`); check('dieselbe RTCPeerConnection, DataChannel offen', n === 1 && st.startsWith('Verbunden zu'), `pcs=${n}, status=${st}`); }
  check('hello nach ICE-Neustart', await helloArrives(host, p1, 'p1'));

  console.log('\nC: WebSocket weg und Verbindung "disconnected" → Rejoin, dann ICE-Neustart');
  await p1.eval(fakeState('disconnected', false));
  await p1.eval(`__sig().at(-1).close()`);
  await p1.waitFor(`document.getElementById('log').textContent.split('Raum wieder beigetreten').length - 1 === 2`, 'zweiter Rejoin');
  await p1.eval(REAL_STATE);
  await p1.waitFor(`${UFRAG} !== '${ufrag1}' && __pcs[0].signalingState === 'stable' && __pcs[0].connectionState === 'connected'`, 'ICE-Neustart nach Rejoin');
  check('ICE-Neustart nach Rejoin', true);
  check('hello', await helloArrives(host, p1, 'p1'));

  const hostPeerCards = () => host.eval(`document.getElementById('peers').children.length`);

  console.log('\nH: Seite neu laden → derselbe Spieler, neue Verbindung');
  await p1.eval(`document.getElementById('ready-btn').click()`);
  await host.waitFor(`document.getElementById('log').textContent.includes('[p1] bereit')`, 'bereit');
  await p1.waitFor(`document.getElementById('ready-btn').getAttribute('aria-pressed') === 'true'`, 'Bereit bestätigt', 5000);
  check('Handy zeigt die Bestätigung des Hosts', (await p1.eval(`document.getElementById('ready-btn').textContent`)).startsWith('✅'));
  await p1.send('Page.reload');
  await p1.waitFor(`document.getElementById('log').textContent.includes('Raum wieder beigetreten als p1') && document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'Rejoin nach Reload', 20000);
  const hostLogH = await host.log();
  check('Handy ist wieder p1', (await p1.eval(`document.getElementById('peer-id').textContent`)) === 'p1');
  check('Host: kein neuer Spieler, Verbindung getauscht', count(hostLogH, '[p1] beigetreten') === 1 && hostLogH.includes('[p1] neue Verbindung') && !hostLogH.includes('[p1] hat den Raum verlassen') && (await hostPeerCards()) === 1);
  check('Host: nach Reload nicht mehr bereit', hostLogH.includes('[p1] nicht mehr bereit'));
  check('hello nach Reload', await helloArrives(host, p1, 'p1'));

  console.log('\nI: DataChannel geht zu → neue Verbindung für denselben Spieler');
  await p1.eval(`document.getElementById('ready-btn').click()`);
  await host.waitFor(`document.getElementById('log').textContent.split('[p1] bereit').length - 1 === 2`, 'wieder bereit');
  const readyBtn = (expr) => p1.eval(`document.getElementById('ready-btn').${expr}`);
  const visibleOverlays = () => host.eval(`document.querySelectorAll('.connection-overlay:not([hidden])').length`);
  const RESET_LOG = '[p1] Verbindung unterbrochen – muss sich erneut bereit melden';
  // The reload in H took it back once already
  const resets = async () => count(await host.log(), RESET_LOG);
  const resetsI = await resets();
  await p1.eval(`__channels.find((c) => c.label === 'control').close()`);
  await p1.waitFor(`__pcs.length === 2 && __pcs[1].connectionState === 'connected' && document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'neue Verbindung', 20000);
  await p1.waitFor(`document.getElementById('ready-btn').textContent === 'Bereit'`, 'wieder „Bereit“', 5000).catch(() => {});
  await host.waitFor(`document.querySelectorAll('.connection-overlay:not([hidden])').length === 0`, 'Overlay weg', 5000).catch(() => {});
  const hostLogI = await host.log();
  check('Host: Verbindung getauscht, kein neuer Spieler', count(hostLogI, '[p1] neue Verbindung') === 2 && count(hostLogI, '[p1] beigetreten') === 1 && (await hostPeerCards()) === 1);
  check('Host: nach der neuen Verbindung nicht mehr bereit', count(hostLogI, '[p1] bereit') === 2 && count(hostLogI, RESET_LOG) === resetsI + 1);
  check('Handy: zeigt wieder „Bereit“', (await readyBtn('textContent')) === 'Bereit' && (await readyBtn(`getAttribute('aria-pressed')`)) === 'false', await readyBtn('textContent'));
  check('Host: Overlay weg, sobald die Eingaben wieder ankommen', (await visibleOverlays()) === 0);
  check('hello über die neue Verbindung', await helloArrives(host, p1, 'p1'));

  console.log('\nR: Host beantwortet „Bereit“ nicht → Warnung, erneuter Tipp');
  // Drops the host's ready-state answers while __dropReadyState is set
  await host.eval(`(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      if (window.__dropReadyState && typeof data === 'string' && data.includes('"ready-state"')) return;
      return send.call(this, data);
    };
    window.__dropReadyState = true;
  })()`);
  const readyBefore = count(await host.log(), '[p1] bereit');
  await p1.eval(`document.getElementById('ready-btn').click()`);
  check('wartet gesperrt auf die Antwort', (await readyBtn('disabled')) === true && (await readyBtn('textContent')).startsWith('⏳'), await readyBtn('textContent'));
  await p1.waitFor(`document.getElementById('ready-btn').textContent.startsWith('⚠️')`, 'Warnung', 6000);
  check('Warnung nach 3 s, Button wieder antippbar', (await readyBtn('disabled')) === false, await readyBtn('textContent'));
  await host.eval(`window.__dropReadyState = false`);
  await p1.eval(`document.getElementById('ready-btn').click()`);
  await p1.waitFor(`document.getElementById('ready-btn').getAttribute('aria-busy') === 'false'`, 'Antwort', 5000);
  check('erneuter Tipp wiederholt die Anfrage, Host bestätigt', (await readyBtn(`getAttribute('aria-pressed')`)) === 'true' && (await readyBtn('textContent')).startsWith('✅') && count(await host.log(), '[p1] bereit') > readyBefore, await readyBtn('textContent'));

  console.log('\nS: nur der Server weg → bleibt bereit; Verbindung beim Host unterbrochen → muss neu bestätigen');
  const resetsS = await resets();
  const rejoinsS = count(await p1.log(), 'Raum wieder beigetreten');
  const backS = count(await host.log(), '[p1] ✅ wieder da');
  await p1.eval(`__sig().at(-1).close()`);
  await p1.waitFor(`document.getElementById('log').textContent.split('Raum wieder beigetreten').length - 1 > ${rejoinsS}`, 'Rejoin', 15000);
  await host.waitFor(`document.getElementById('log').textContent.split('[p1] ✅ wieder da').length - 1 > ${backS}`, 'Host: wieder da', 5000).catch(() => {});
  check('nur Server weg: bleibt bereit, kein Overlay', (await resets()) === resetsS &&(await readyBtn(`getAttribute('aria-pressed')`)) === 'true' && (await visibleOverlays()) === 0);
  // The host's current connection to p1 is the last one it created (no other phone yet)
  await host.eval(`(() => {
    const pc = __pcs.at(-1);
    Object.defineProperty(pc, 'connectionState', { get: () => 'disconnected', configurable: true });
    pc.dispatchEvent(new Event('connectionstatechange'));
  })()`);
  await p1.waitFor(`document.getElementById('ready-btn').textContent === 'Bereit'`, '„Bereit“ nach Unterbrechung', 5000).catch(() => {});
  check('Host: Overlay und „Bereit“ zurückgesetzt', (await resets()) === resetsS + 1 &&(await visibleOverlays()) === 1);
  check('Handy: zeigt wieder „Bereit“', (await readyBtn('textContent')) === 'Bereit', await readyBtn('textContent'));
  await host.eval(`(() => {
    const pc = __pcs.at(-1);
    delete pc.connectionState;
    pc.dispatchEvent(new Event('connectionstatechange'));
  })()`);
  check('Host: Overlay weg, die Eingaben kamen die ganze Zeit an', (await visibleOverlays()) === 0);

  console.log('\nK: duplizierter Tab mit derselben Sitzung übernimmt den Spieler');
  const stored = await p1.eval(`sessionStorage.getItem('apiracer.session')`);
  check('Token im sessionStorage', JSON.parse(stored)?.roomId === host.roomId);
  const p1b = await Page.open('handy1-kopie', `${BASE}/controller.html?room=${host.roomId}`, `${INJECT}\ntry { sessionStorage.setItem('apiracer.session', ${JSON.stringify(stored)}); } catch {}`);
  pages.push(p1b);
  await p1b.waitFor(`document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'Kopie verbunden', 20000);
  await p1.waitFor(`!document.getElementById('join-screen').hidden`, 'Original: Join-Screen');
  check('Original: Übernahme gemeldet', (await joinScreen(p1)) === 'Sitzung wurde woanders fortgesetzt', await joinScreen(p1));
  check('Kopie ist p1', (await p1b.eval(`document.getElementById('peer-id').textContent`)) === 'p1');
  const socketsK = await p1.eval('__sig().length');
  await sleep(5000);
  check('Original holt sich den Platz nicht zurück', (await p1.eval('__sig().length')) === socketsK && (await joinScreen(p1b)) === null);
  check('Original: Token gelöscht', (await p1.eval(`sessionStorage.getItem('apiracer.session')`)) === null);
  const hostLogK = await host.log();
  check('Host: Verbindung getauscht, kein neuer Spieler', count(hostLogK, '[p1] neue Verbindung') === 3 && count(hostLogK, '[p1] beigetreten') === 1 && (await hostPeerCards()) === 1);
  check('hello von der Kopie', await helloArrives(host, p1b, 'p1'));

  // J runs alongside E: the copy leaves the page now and only comes back once its slot has expired
  await p1b.send('Page.navigate', { url: 'about:blank' });

  console.log('\nE: Server nicht erreichbar, bis der Platz verfällt');
  const p2 = await openPhone('handy2', host.roomId);
  await p2.eval(`window.__blockWs = true; __sig().at(-1).close()`);
  const t0 = Date.now();
  await host.waitFor(`document.getElementById('log').textContent.includes('[p2] ist nicht zurückgekommen')`, 'Platz verfallen', 45000);
  console.log(`   Host hat p2 nach ${Math.round((Date.now() - t0) / 1000)} s entfernt`);
  const attemptsBefore = await p2.eval('__sig().length');
  await sleep(4000);
  check('Handy versucht es weiter, solange der Server weg ist', (await joinScreen(p2)) === null && (await p2.eval('__sig().length')) > attemptsBefore);
  await p2.eval(`window.__blockWs = false`);
  // Only the slot expired, the room is still there → joins it again as a new player
  await p2.waitFor(`document.getElementById('log').textContent.includes('trete als neuer Spieler bei') && document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'neu beigetreten', 20000);
  const p2newId = await p2.eval(`document.getElementById('peer-id').textContent`);
  check('Server wieder da: als neuer Spieler beigetreten', (await joinScreen(p2)) === null && p2newId !== 'p2', p2newId);
  check('hello als neuer Spieler', await helloArrives(host, p2, p2newId));
  const attemptsE = await p2.eval('__sig().length');
  await sleep(5000);
  check('keine weiteren Verbindungsversuche', (await p2.eval('__sig().length')) === attemptsE, `${attemptsE} Versuche`);

  console.log('\nJ: Neu laden, nachdem der Platz verfallen ist');
  check('Host hat p1 nach Ablauf entfernt', (await host.log()).includes('[p1] hat den Raum verlassen'));
  await p1b.send('Page.navigate', { url: `${BASE}/controller.html?room=${host.roomId}` });
  // The room is still there → joins it as a new player instead of showing the join screen
  await p1b.waitFor(`document.getElementById('log').textContent.includes('Gespeicherte Sitzung gefunden') && document.getElementById('log').textContent.includes('trete als neuer Spieler bei') && document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'neu beigetreten', 20000);
  const p1bId = await p1b.eval(`document.getElementById('peer-id').textContent`);
  check('Reload nach Ablauf: als neuer Spieler beigetreten', (await joinScreen(p1b)) === null && p1bId !== 'p1', p1bId);

  console.log('\nG: Server-Neustart (Raum weg), WebRTC läuft weiter');
  const p3 = await openPhone('handy3', host.roomId);
  children.find((c) => c.spawnargs.includes('server/server.ts') && c.exitCode === null).kill();
  await sleep(1000);
  startServer();
  await waitUntil(serverUp, 'Server nach Neustart');
  await p3.waitFor(`document.getElementById('log').textContent.includes('weiter ohne Server')`, 'weiter ohne Server', 20000);
  check('Join-Screen bleibt zu', (await joinScreen(p3)) === null);
  check('hello ohne Server', await helloArrives(host, p3, await p3.eval(`document.getElementById('peer-id').textContent`)));

  console.log('\nF: Host schließt den Raum');
  const host2 = await openHost('host2');
  const p4 = await openPhone('handy4', host2.roomId);
  await host2.close();
  await p4.waitFor(`!document.getElementById('join-screen').hidden`, 'Join-Screen');
  await sleep(3000);
  check('Meldung bleibt "Host hat den Raum geschlossen"', (await joinScreen(p4)) === 'Host hat den Raum geschlossen', await joinScreen(p4));

  console.log('\nL: Rennen beenden → zurück in die Lobby (im Countdown und im Rennen)');
  const host3 = await openHost('host3');
  const p5 = await openPhone('handy5', host3.roomId);
  const h3 = (expr) => host3.eval(expr);
  const p5Text = (id) => p5.eval(`document.getElementById('${id}').textContent`);
  const getReadyAndStart = async () => {
    const before = count(await host3.log(), '[p1] bereit');
    await p5.eval(`document.getElementById('ready-btn').click()`);
    await host3.waitFor(`document.getElementById('log').textContent.split('[p1] bereit').length - 1 > ${before} && !document.getElementById('start-btn').disabled`, 'Start frei', 5000);
    await h3(`document.getElementById('start-btn').click()`);
  };
  const backInLobby = async () =>
    (await h3(`!document.getElementById('start-btn').hidden && document.getElementById('start-btn').disabled && document.getElementById('end-btn').hidden`)) &&
    (await h3(`document.getElementById('ready-count').textContent`)) === '0/1 bereit' &&
    (await p5Text('status')).startsWith('Verbunden zu') &&
    (await p5Text('ready-btn')) === 'Bereit';

  await getReadyAndStart();
  check('Countdown: Beenden-Button statt Start', await h3(`document.getElementById('start-btn').hidden && !document.getElementById('end-btn').hidden`));
  await sleep(1000);
  await h3(`document.getElementById('end-btn').click()`);
  await p5.waitFor(`document.getElementById('log').textContent.includes('Rennen beendet')`, 'race-end', 5000);
  // Past the end of the countdown: it must not start the race anyway
  await sleep(3500);
  check('im Countdown beendet: Lobby, Rennen startet nicht', (await backInLobby()) && !(await host3.log()).includes('🏁 Rennen gestartet'), `${await h3(`document.getElementById('ready-count').textContent`)} · ${await p5Text('status')}`);

  await getReadyAndStart();
  await host3.waitFor(`document.getElementById('ready-count').textContent === 'Rennen läuft'`, 'Rennen läuft', 6000);
  check('Handy: Rennen läuft', (await p5Text('status')).startsWith('Rennen läuft'));
  await h3(`document.getElementById('end-btn').click()`);
  await p5.waitFor(`document.getElementById('status').textContent.startsWith('Verbunden zu')`, 'Lobby', 5000).catch(() => {});
  check('im Rennen beendet: Lobby, alle wieder nicht bereit', await backInLobby(), `${await h3(`document.getElementById('ready-count').textContent`)} · ${await p5Text('ready-btn')}`);
  await getReadyAndStart();
  check('nächstes Rennen startbar', await h3(`document.getElementById('ready-count').textContent === 'Countdown …'`));
} catch (err) {
  failures++;
  console.log(`\n❌ ${err.message}`);
  for (const page of pages) {
    try {
      console.log(`--- Log ${page.name} (neueste zuerst):\n${(await page.eval(`[...document.querySelectorAll('#log li')].slice(0, 25).map((li) => li.textContent).join('\\n')`))}`);
    } catch {}
  }
} finally {
  try {
    const { webSocketDebuggerUrl } = await (await fetch(`${CDP}/json/version`)).json();
    const browser = new WebSocket(webSocketDebuggerUrl);
    await new Promise((r) => browser.once('open', r));
    browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
    await sleep(1500);
  } catch {}
  for (const child of children) if (child.exitCode === null) child.kill();
  await sleep(500);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {}
  console.log(`\n${failures === 0 ? 'Alle Checks bestanden' : `${failures} Fehler`}`);
  process.exit(failures === 0 ? 0 : 1);
}
