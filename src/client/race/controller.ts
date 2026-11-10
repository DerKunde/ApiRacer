import '../../style.css';
import { HOST_ID, type ChannelMessage, type ServerMessage, type IceServer } from '../../shared/protocol';
import {
  applySignal,
  candidateType,
  CONTROL_CHANNEL_LABEL,
  CONTROL_CHANNEL_OPTIONS,
  RELIABLE_CHANNEL_LABEL,
  RELIABLE_CHANNEL_OPTIONS,
  createQueue,
  createRtcConfig,
  describePath,
  getConnectionPath,
  sendMessage,
} from '../common/rtc';
import { clearSession, loadSession, saveSession, type StoredSession } from '../common/session';
import { SignalingClient } from '../common/signaling';
import { byId, createLogger, hasWebRtcSupport } from '../common/ui';
import { needsOrientationPermission, waitForSensorEvent } from '../common/mobileDeviceSensors';
import { keepScreenOn } from '../common/wakeLock';
import {
  detectHolding,
  requestOrientationEventPermission,
  steeringAngle,
  steeringValue,
  type DeviceHolding,
} from './steering';

/** Controller = phone. Initiates the connection to the host PC (creates the offer and the DataChannel). */

const log = createLogger(byId('log'));
const statusEl = byId('status');
// Visible while not in a room: no code in the URL, joining failed, or the host closed the room
const joinScreen = byId('join-screen');
const session = byId('session');
const helloButton = byId<HTMLButtonElement>('hello-btn');
const readyButton = byId<HTMLButtonElement>('ready-btn');
const sensorOverlay = byId('sensor-overlay');
const permissionButton = byId<HTMLButtonElement>('sensor-permission-btn');
const alphaLabel = byId<HTMLElement>('orientation-alpha');
const betaLabel = byId<HTMLElement>('orientation-beta');
const gammaLabel = byId<HTMLElement>('orientation-gamma');
const gravityLabel = byId<HTMLElement>('gravity');
const holdingLabel = byId<HTMLElement>('device-holding');
const steeringLabel = byId<HTMLElement>('steering');

const HOLDING_TEXT: Record<DeviceHolding, string> = {
  'portrait': 'Hochformat – bitte quer halten',
  'landscape-primary': 'Quer (primary)',
  'landscape-secondary': 'Quer (secondary)',
};
const INPUT_INTERVAL_MS = 1000 / 60;
// How long to wait for a first sensor event before assuming none will come (no permission or no sensors)
const SENSOR_TIMEOUT_MS = 1000;
// Pause between attempts to reach the signaling server again (it keeps the slot reserved for 15 s)
const REJOIN_RETRY_MS = 2000;
// Then stop trying: the server keeps the slot for 15 s after noticing the lost connection (its heartbeat takes up to
// 10 s for one that died without a close). Later the slot is gone for sure, more attempts only drain the battery.
const REJOIN_GIVE_UP_MS = 30_000;
// 'disconnected' is often only a short gap that ICE bridges on its own – restart only if it lasts longer
const ICE_RESTART_DELAY_MS = 2000;
// The host answers an ICE-restart offer within moments. No answer: the server connection is probably dead without
// the browser noticing (network switch) and the offer got lost – so reconnect to the server and restart again.
const ICE_RESTART_ANSWER_TIMEOUT_MS = 5000;
const enqueue = createQueue((err) => log(`❌ ${String(err)}`));

let signaling: SignalingClient;
// TURN credentials from the last 'joined', also for a new connection without a new 'joined'
let iceServers: IceServer[] | undefined;
// undefined = none yet, or the last one couldn't be restored and is closed
let pc: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let reliableChannel: RTCDataChannel | undefined;
let helloCount = 0;
let joined = false;
// What it takes to get the slot back after losing the server connection; undefined = nothing to take back
let roomSession: StoredSession | undefined;
// Server connection lost: reconnecting until the server answers the rejoin
let rejoining = false;
// When the server connection was lost, for REJOIN_GIVE_UP_MS
let rejoinStartedAt = 0;
let iceRestartTimer: number | undefined;
let restartAnswerTimer: number | undefined;
let ready = false;
// The ready button needs all three (updateReadyButton): steering works, a car (host's role message), still the lobby
let sensorsActive = false;
// Until the host says otherwise – its role message comes right after the reliable channel opens
let racer = true;
let raceStarted = false;
let holding: DeviceHolding = 'portrait';
let steerValue = 0;
let throttle = 0;
let brake = 0;
let inputSeq = 0;
let inputTimer: number | undefined;
let pathTimer: number | undefined;

/**
 * state picks the icon in front of the text (.status[data-state] in style.css):
 * 'connected' → link, 'disconnected' → link_off, none → no icon (while connecting).
 */
function setStatus(text: string, state?: 'connected' | 'disconnected'): void {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

/** Connected to the host: what the player is doing in the room right now. */
function setConnectedStatus(): void {
  const roomId = roomSession?.roomId ?? '';
  if (raceStarted) setStatus(racer ? 'Rennen läuft' : 'Rennen läuft – du schaust zu', 'connected');
  else setStatus(racer ? `Verbunden zu ${roomId}` : 'Zuschauer – du hast kein Auto', 'connected');
}

/**
 * Back to the start: only the room code field is left, with the reason above it (empty = no reason).
 * The sensors may still be starting up in the background – startSensors and initSensors check the session first.
 */
function showJoinScreen(message: string): void {
  const messageEl = byId('join-message');
  messageEl.textContent = message;
  messageEl.hidden = message === '';
  joinScreen.hidden = false;
  session.hidden = true;
  sensorOverlay.hidden = true;
  setDebugPanelOpen(false);
  delete document.body.dataset.mode;
}

async function main(roomId: string): Promise<void> {
  joinScreen.hidden = true;
  session.hidden = false;
  byId('room').textContent = roomId;
  // Not awaited: runs in parallel to the connection setup. Independent of WebRTC, so it starts before the check below.
  void initSensors();
  // Chrome grants it right away, Safari only on the next tap (handled inside)
  keepScreenOn(log);

  if (!hasWebRtcSupport()) {
    setStatus('❌ Kein WebRTC verfügbar');
    log('RTCPeerConnection fehlt – evtl. ist HTTPS nötig (npm run dev:https)');
    return;
  }

  setStatus('Verbinde mit Signaling-Server …');
  signaling = await SignalingClient.connect(handleServerMessage, handleSignalingClose);
  // This tab was in this room before (page reloaded): take the slot back instead of joining as a new player
  const saved = loadSession();
  if (saved?.roomId === roomId) {
    roomSession = saved;
    rejoining = true;
    log('Gespeicherte Sitzung gefunden – hole den Platz zurück …');
    signaling.send({ type: 'rejoin-room', roomId, sessionToken: saved.sessionToken });
  } else {
    signaling.send({ type: 'join-room', roomId });
  }
}

/**
 * Server connection lost (screen locked, network switch, server restart). The WebRTC connection may still be up,
 * but the server only keeps the slot for a while – so take it back with the session token.
 */
function handleSignalingClose(): void {
  log('Signaling-Verbindung geschlossen');
  // Not in a room (anymore): nothing to take back
  if (!roomSession) return;
  // A WebRTC connection that still works keeps the car driving: only tell the player when it's gone too
  if (pc?.connectionState !== 'connected') setStatus('Verbindung verloren – verbinde neu …', 'disconnected');
  // First attempt right away, further ones (closed again before the server answered) after a pause
  const firstAttempt = !rejoining;
  if (firstAttempt) rejoinStartedAt = performance.now();
  rejoining = true;
  window.setTimeout(() => void rejoin(), firstAttempt ? 0 : REJOIN_RETRY_MS);
}

async function rejoin(): Promise<void> {
  // Gave up meanwhile (e.g. left the room) → stop trying
  if (!roomSession) return;
  if (performance.now() - rejoinStartedAt > REJOIN_GIVE_UP_MS) {
    const message = 'Signaling-Server nicht erreichbar';
    if (!loseSlot(message)) giveUp(message);
    return;
  }
  let client: SignalingClient;
  try {
    client = await SignalingClient.connect(handleServerMessage, handleSignalingClose);
  } catch {
    window.setTimeout(() => void rejoin(), REJOIN_RETRY_MS);
    return;
  }
  // Gave up while connecting: its answers must not bring the session back
  if (!roomSession) {
    client.close();
    return;
  }
  signaling = client;
  log('Signaling-Server wieder erreichbar – hole den Platz zurück …');
  signaling.send({ type: 'rejoin-room', roomId: roomSession.roomId, sessionToken: roomSession.sessionToken });
}

/** No session to take back anymore – a reload joins as a new player. */
function forgetSession(): void {
  roomSession = undefined;
  rejoining = false;
  clearSession();
}

/**
 * The slot is gone (room closed, away too long, server restarted): the token can't bring it back.
 * @returns true if the WebRTC connection still works – it doesn't need the server, the car keeps driving
 */
function loseSlot(message: string): boolean {
  forgetSession();
  if (pc?.connectionState !== 'connected') return false;
  log(`${message} – weiter ohne Server`);
  return true;
}

/**
 * "Raum verlassen": frees the slot right away instead of after the rejoin grace, so the host doesn't wait for a player
 * who left on purpose. Without a server connection the message is lost – then the slot is freed after the grace.
 */
function leaveRoom(): void {
  if (!confirm('Raum wirklich verlassen? Dein Auto wird entfernt.')) return;
  signaling.send({ type: 'leave-room' });
  log('Raum verlassen');
  giveUp('Du hast den Raum verlassen');
}

/** Nothing left to restore: back to the join screen, ready for the next room – joining again makes a new player. */
function giveUp(message: string): void {
  forgetSession();
  // Done with the server too: a late answer (e.g. 'joined' to a rejoin still on its way) must not bring the
  // session back. Joining again reloads the page with a new connection anyway.
  signaling.close();
  closeConnection();
  helloButton.disabled = true;
  readyButton.disabled = true;
  showJoinScreen(message);
}

/**
 * Runs once per session (from main), without a tap. Asks "do sensor events arrive?" instead of "is there a
 * permission?" – Safari has no way to read the permission state without prompting, and Android needs none.
 * Events arriving = permission is there, whatever the reason (Android, or iOS already allowed earlier).
 */
async function initSensors(): Promise<void> {
  if (await hasSensorData()) {
    startSensors();
    return;
  }
  if (needsOrientationPermission()) {
    // Joining failed meanwhile → the join screen stays alone
    if (session.hidden) return;
    // iOS without permission yet: requestPermission only works inside a tap → overlay with button
    sensorOverlay.hidden = false;
    return;
  }
  // No events and nothing to allow: the device has no motion sensors (e.g. laptop). No overlay – it couldn't
  // offer anything, and the pedals still work (handy for testing on a desktop).
  holdingLabel.textContent = 'Keine Bewegungssensoren – Lenken nicht möglich';
  log('Keine Bewegungssensoren gefunden');
}

/** true as soon as a deviceorientation event with real values arrives (desktop Chrome sends one with null values) */
async function hasSensorData(): Promise<boolean> {
  return (await waitForSensorEvent('deviceorientation', SENSOR_TIMEOUT_MS, (event) => event.beta !== null)) !== null;
}

function startSensors(): void {
  sensorOverlay.hidden = true;
  sensorsActive = true;
  updateReadyButton();
  // Race mode: only pedals and ready button fill the screen, the rest moves behind the debug button (style.css).
  // Not if joining failed meanwhile – the fixed controls would cover the join screen.
  if (!session.hidden) document.body.dataset.mode = 'race';
  window.addEventListener('deviceorientation', handleOrientation);
  window.addEventListener('devicemotion', handleMotion);
  log('Bewegungssensoren aktiv');
}

/** Text below the button in the sensor overlay; empty text hides it. */
function setSensorHint(text: string): void {
  const hint = byId('sensor-hint');
  hint.textContent = text;
  hint.hidden = text === '';
}

permissionButton.addEventListener('click', async () => {
  const granted = await requestOrientationEventPermission();
  log(`Sensor-Berechtigung: ${granted ? 'erteilt' : 'verweigert'}`);
  if (!granted) {
    // Overlay stays. Safari answers every further request with 'denied' until the tab is closed → tell the user
    // how to retry
    setSensorHint('Zugriff verweigert – Tab schließen, Link neu öffnen und „Erlauben" wählen.');
    return;
  }
  permissionButton.disabled = true;
  setSensorHint('Suche Sensoren …');
  if (await hasSensorData()) {
    startSensors();
    return;
  }
  // Allowed, but still no events – rare, but then a retry is the only option
  permissionButton.disabled = false;
  setSensorHint('Keine Sensordaten erhalten – bitte erneut versuchen.');
});

function handleOrientation(event: DeviceOrientationEvent) {
  const { alpha, beta, gamma } = event;
  if (alpha === null || beta === null || gamma === null) {
    return;
  }
  alphaLabel.textContent = alpha.toFixed(0);
  betaLabel.textContent = beta.toFixed(0);
  gammaLabel.textContent = gamma.toFixed(0);
  steerValue = Math.round(steeringValue(steeringAngle(beta, holding)) * 100) / 100;
  steeringLabel.textContent = steerValue.toFixed(2);
}

// The gravity vector tells how the phone is held (independent of screen rotation and rotation lock)
function handleMotion(event: DeviceMotionEvent) {
  const gravity = event.accelerationIncludingGravity;
  if (!gravity || gravity.x === null || gravity.y === null) {
    return;
  }
  holding = detectHolding(gravity.x, gravity.y, holding);
  gravityLabel.textContent = gravity.x.toFixed(1) + ' / ' + gravity.y.toFixed(1);
  holdingLabel.textContent = HOLDING_TEXT[holding];
}

/**
 * Pressed while at least one finger is on the button. Pointer events instead of click, because a pedal is held,
 * and they track every finger on its own – so gas and brake work at the same time (multi-touch).
 */
function setupPedal(button: HTMLButtonElement, onChange: (pressed: boolean) => void): void {
  const pointers = new Set<number>();
  const update = () => {
    const pressed = pointers.size > 0;
    button.classList.toggle('pressed', pressed);
    onChange(pressed);
  };
  button.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    // Touch is captured implicitly, the mouse (desktop testing) not: with capture, releasing outside the button
    // still ends up here instead of leaving the pedal stuck
    button.setPointerCapture(e.pointerId);
    update();
  });
  const release = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    update();
  };
  button.addEventListener('pointerup', release);
  // e.g. an incoming call or the system taking over the gesture
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  // Long press on Android opens the context menu (iOS: callout, prevented in style.css)
  button.addEventListener('contextmenu', (e) => e.preventDefault());
}

setupPedal(byId<HTMLButtonElement>('gas-btn'), (pressed) => (throttle = pressed ? 1 : 0));
setupPedal(byId<HTMLButtonElement>('brake-btn'), (pressed) => (brake = pressed ? 1 : 0));

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'joined': {
      // Rejoined = same player as before, the host still has its car
      const rejoined = rejoining;
      rejoining = false;
      joined = true;
      roomSession = { roomId: msg.roomId, sessionToken: msg.sessionToken };
      saveSession(roomSession);
      iceServers = msg.iceServers;
      byId('peer-id').textContent = msg.peerId;
      log(`Raum ${rejoined ? 'wieder ' : ''}beigetreten als ${msg.peerId}`);
      // No connection: just joined, the page was reloaded, or the old one couldn't be restored
      if (!pc) startConnection(rejoined);
      // Signals sent while away got lost: a connection that didn't survive needs a new path, and an offer still
      // waiting for its answer won't get one anymore
      else if (pc.connectionState !== 'connected' || pc.signalingState !== 'stable') restartIce(pc, true);
      break;
    }
    case 'signal': {
      const { data } = msg;
      log(`empfangen: ${data.kind === 'description' ? data.description.type : `ICE-Kandidat (${candidateType(data.candidate.candidate)})`}`);
      enqueue(async () => {
        if (pc) await applySignal(pc, data);
      });
      break;
    }
    case 'room-closed':
      // The slot is gone with the room, the token can't bring it back
      giveUp('Host hat den Raum geschlossen');
      break;
    case 'session-taken-over':
      giveUp('Sitzung wurde woanders fortgesetzt');
      break;
    case 'rejoin-failed': {
      // A late answer after giving up
      if (!rejoining || !roomSession) break;
      const { roomId } = roomSession;
      if (loseSlot(msg.message)) break;
      // Only the slot may be gone, not the room (e.g. the page was restored long after it was left): join it as a
      // new player. If the room is gone too, the error below brings the code field.
      log(`${msg.message} – trete als neuer Spieler bei`);
      setStatus('Trete dem Raum neu bei …');
      closeConnection();
      joined = false;
      signaling.send({ type: 'join-room', roomId });
      break;
    }
    case 'error':
      // Not about the rejoin (that answers with 'rejoin-failed'), e.g. a signal sent before the server knew this
      // socket again: the rejoin goes on
      if (rejoining) {
        log(`❌ ${msg.message}`);
        break;
      }
      // Before 'joined' the error is about joining (e.g. room not found) → back to the code field
      if (joined) setStatus(`❌ ${msg.message}`);
      else showJoinScreen(msg.message);
      break;
  }
}

/** newConnection: replaces this player's old connection (see SignalData) – the host swaps it in for the same car. */
function startConnection(newConnection: boolean): void {
  setStatus('Baue WebRTC-Verbindung auf …');
  const connection = new RTCPeerConnection(createRtcConfig(iceServers));
  pc = connection;

  // Create the DataChannel before the offer so it gets negotiated in the SDP
  reliableChannel = connection.createDataChannel(RELIABLE_CHANNEL_LABEL, RELIABLE_CHANNEL_OPTIONS);
  reliableChannel.onopen = () => {
    log('Zuverlässiger DataChannel offen');
    readyButton.disabled = false;
    // The host starts every new connection as not ready
    if (ready) sendMessage(reliableChannel, { type: 'ready', ready });
  };
  reliableChannel.onclose = () => {
    log('Zuverlässiger DataChannel geschlossen');
    // A replaced connection's channel may only close once the new one is open
    if (connection === pc) readyButton.disabled = true;
  };
  reliableChannel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    switch (msg.type) {
      case 'peer-color':
        byId('body').style.backgroundColor = msg.color;
        break;
      // Race full when joining, or the host took the car away (e.g. because this phone can't get ready)
      case 'role':
        racer = msg.racer;
        updateReadyButton();
        setConnectedStatus();
        if (!racer) log('Kein Auto: du schaust zu');
        break;
      // Lobby is over: changing your mind about being ready no longer matters
      case 'race-start':
        raceStarted = true;
        updateReadyButton();
        setConnectedStatus();
        log('🏁 Rennen gestartet');
        break;
    }
  };

  channel = connection.createDataChannel(CONTROL_CHANNEL_LABEL, CONTROL_CHANNEL_OPTIONS);
  channel.onopen = () => {
    setConnectedStatus();
    helloButton.disabled = false;
    log('DataChannel offen');
    pathTimer = window.setInterval(() => void refreshPath(connection), 2000);
    inputTimer = window.setInterval(() => {
      sendMessage(channel, { type: 'input', seq: ++inputSeq, steering: steerValue, throttle, brake });
    }, INPUT_INTERVAL_MS);
    void refreshPath(connection);
  };
  channel.onclose = () => {
    // Closed here on purpose (closeConnection): whoever closed it takes care of what comes next
    if (connection !== pc) return;
    setStatus('Verbindung getrennt – baue sie neu auf …', 'disconnected');
    helloButton.disabled = true;
    // Closed by the host, or the connection is dead for good: an ICE restart can't bring a DataChannel back
    replaceConnection();
  };
  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    if (msg.type === 'ping') sendMessage(channel, { type: 'pong', t: msg.t });
  };

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    signaling.send({ type: 'signal', to: HOST_ID, data: { kind: 'candidate', candidate: candidate.toJSON() } });
    log(`eigener ICE-Kandidat gesendet (${candidate.type ?? candidateType(candidate.candidate)})`);
  };
  connection.onconnectionstatechange = () => {
    log(`Verbindungsstatus: ${connection.connectionState}`);
    handleConnectionState(connection);
  };

  enqueue(async () => {
    await connection.setLocalDescription(); // creates the offer
    signaling.send({
      type: 'signal',
      to: HOST_ID,
      data: { kind: 'description', description: connection.localDescription!.toJSON(), newConnection },
    });
    log(newConnection ? 'Offer für eine neue Verbindung gesendet' : 'Offer gesendet');
  });
}

/**
 * Last resort, when nothing can be restored anymore: a new connection for the same player. The host swaps it in
 * and keeps the car.
 */
function replaceConnection(): void {
  closeConnection();
  // While rejoining, 'joined' starts it (there's no connection anymore)
  if (rejoining) return;
  // The server refused the rejoin: without it no new connection can be negotiated either
  if (!roomSession) return giveUp('Verbindung zum Host verloren');
  startConnection(true);
}

/** Its channels' close events come later and are ignored (connection !== pc). */
function closeConnection(): void {
  window.clearTimeout(iceRestartTimer);
  window.clearTimeout(restartAnswerTimer);
  window.clearInterval(inputTimer);
  window.clearInterval(pathTimer);
  pc?.close();
  pc = undefined;
}

/**
 * Restores a broken connection instead of replacing it: an ICE restart looks for a new network path (e.g. after
 * switching from Wi-Fi to mobile data), while the DataChannels and the host's player stay the same.
 */
function handleConnectionState(connection: RTCPeerConnection): void {
  window.clearTimeout(iceRestartTimer);
  switch (connection.connectionState) {
    // Also after an ICE restart: the channels stayed open, so channel.onopen doesn't say it again
    case 'connected':
      setConnectedStatus();
      break;
    case 'disconnected':
      setStatus('Verbindung unterbrochen – stelle sie wieder her …', 'disconnected');
      iceRestartTimer = window.setTimeout(() => restartIce(connection), ICE_RESTART_DELAY_MS);
      break;
    case 'failed':
      setStatus('Verbindung unterbrochen – stelle sie wieder her …', 'disconnected');
      restartIce(connection);
      break;
  }
}

/**
 * The phone always makes the offer, also for a restart – the host answers it on its existing connection.
 * afterRejoin: the server connection was new, so an offer still waiting for its answer won't get one anymore.
 */
function restartIce(connection: RTCPeerConnection, afterRejoin = false): void {
  window.clearTimeout(iceRestartTimer);
  // The new path is negotiated over the server: while rejoining, 'joined' starts the restart
  if (rejoining) return;
  // The server refused the rejoin: without it a failed connection can't be restored
  if (!roomSession) {
    if (connection.connectionState === 'failed') giveUp('Verbindung zum Host verloren');
    return;
  }
  enqueue(async () => {
    // Replaced or closed meanwhile
    if (connection !== pc) return;
    // One restart at a time ('disconnected' and then 'failed' both ask for one): a second offer would get answers
    // mixed up between the two. If the answer doesn't come, restartAnswerTimer takes care of it. After a rejoin,
    // the new offer simply replaces the waiting one (allowed in 'have-local-offer').
    if (connection.signalingState !== 'stable' && !afterRejoin) {
      log('ICE-Neustart läuft schon – warte auf die Antwort');
      return;
    }
    log('ICE-Neustart …');
    await connection.setLocalDescription(await connection.createOffer({ iceRestart: true }));
    signaling.send({
      type: 'signal',
      to: HOST_ID,
      data: { kind: 'description', description: connection.localDescription!.toJSON() },
    });
    log('ICE-Neustart: Offer gesendet');
    window.clearTimeout(restartAnswerTimer);
    restartAnswerTimer = window.setTimeout(() => checkRestartAnswer(connection), ICE_RESTART_ANSWER_TIMEOUT_MS);
  });
}

/**
 * Still no answer to the restart offer: the server connection is probably dead, but still OPEN for the browser – it
 * notices that only after minutes. Drop it and rejoin like after a close; 'joined' starts the restart again.
 */
function checkRestartAnswer(connection: RTCPeerConnection): void {
  if (connection !== pc || connection.signalingState !== 'have-local-offer' || rejoining || !roomSession) return;
  log('Keine Antwort auf den ICE-Neustart – verbinde neu mit dem Server');
  signaling.close();
  handleSignalingClose();
}

async function refreshPath(connection: RTCPeerConnection): Promise<void> {
  const path = await getConnectionPath(connection);
  byId('path').textContent = path ? describePath(path) : '–';
}

/**
 * Shown only with steering (no point in racing without it), with a car and while the lobby lasts. The sensors and
 * the host's messages arrive in any order – e.g. a late joiner gets race-start before its sensors are found.
 */
function updateReadyButton(): void {
  readyButton.hidden = !sensorsActive || !racer || raceStarted;
}

readyButton.addEventListener('click', () => {
  ready = !ready;
  readyButton.setAttribute('aria-pressed', String(ready));
  readyButton.textContent = ready ? '✅ Bereit – tippen zum Zurücknehmen' : 'Bereit';
  sendMessage(reliableChannel, { type: 'ready', ready });
});

function setDebugPanelOpen(open: boolean): void {
  byId('debug-panel').classList.toggle('open', open);
  byId('debug-open-btn').setAttribute('aria-expanded', String(open));
}

byId('leave-btn').addEventListener('click', leaveRoom);
byId('debug-open-btn').addEventListener('click', () => setDebugPanelOpen(true));
byId('debug-close-btn').addEventListener('click', () => setDebugPanelOpen(false));

helloButton.addEventListener('click', () => {
  sendMessage(channel, { type: 'hello', text: `Hallo #${++helloCount} vom Handy 👋` });
});

// Submitting reloads the page with ?room=… → the same path as opening a QR link
byId<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = byId<HTMLInputElement>('room-input').value.trim().toUpperCase();
  if (code) location.search = `?room=${encodeURIComponent(code)}`;
});

const roomId = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
if (roomId) {
  main(roomId).catch((err: unknown) => {
    showJoinScreen('Verbindung zum Server fehlgeschlagen');
    log(String(err));
  });
}
