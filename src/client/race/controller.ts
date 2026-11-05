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
import { clearSession, saveSession, type StoredSession } from '../common/session';
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
// Pause between attempts to reach the signaling server again (it keeps the slot reserved for 30 s)
const REJOIN_RETRY_MS = 2000;
// 'disconnected' is often only a short gap that ICE bridges on its own – restart only if it lasts longer
const ICE_RESTART_DELAY_MS = 2000;
const enqueue = createQueue((err) => log(`❌ ${String(err)}`));

let signaling: SignalingClient;
let pc: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let reliableChannel: RTCDataChannel | undefined;
let helloCount = 0;
let joined = false;
// What it takes to get the slot back after losing the server connection; undefined = nothing to take back
let roomSession: StoredSession | undefined;
// Server connection lost: reconnecting until the server answers the rejoin
let rejoining = false;
let iceRestartTimer: number | undefined;
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

function setStatus(text: string): void {
  statusEl.textContent = text;
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
  signaling.send({ type: 'join-room', roomId });
}

/**
 * Server connection lost (screen locked, network switch, server restart). The WebRTC connection may still be up,
 * but the server only keeps the slot for a while – so take it back with the session token.
 */
function handleSignalingClose(): void {
  log('Signaling-Verbindung geschlossen');
  // Not in a room (anymore): nothing to take back
  if (!roomSession) return;
  // First attempt right away, further ones (closed again before the server answered) after a pause
  window.setTimeout(() => void rejoin(), rejoining ? REJOIN_RETRY_MS : 0);
  rejoining = true;
}

async function rejoin(): Promise<void> {
  try {
    signaling = await SignalingClient.connect(handleServerMessage, handleSignalingClose);
  } catch {
    if (roomSession) window.setTimeout(() => void rejoin(), REJOIN_RETRY_MS);
    return;
  }
  // Both checks: gave up meanwhile (e.g. the DataChannel closed) → stop trying
  if (!roomSession) return;
  log('Signaling-Server wieder erreichbar – hole den Platz zurück …');
  signaling.send({ type: 'rejoin-room', roomId: roomSession.roomId, sessionToken: roomSession.sessionToken });
}

/** Nothing left to restore: back to the join screen, ready for the next room – joining again makes a new player. */
function giveUp(message: string): void {
  roomSession = undefined;
  rejoining = false;
  clearSession();
  window.clearTimeout(iceRestartTimer);
  pc?.close();
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
    case 'joined':
      roomSession = { roomId: msg.roomId, sessionToken: msg.sessionToken };
      saveSession(roomSession);
      byId('peer-id').textContent = msg.peerId;
      if (rejoining) {
        rejoining = false;
        log(`Raum wieder beigetreten als ${msg.peerId}`);
        // Signals sent while away got lost: a connection that didn't survive needs a new path
        if (pc && pc.connectionState !== 'connected') restartIce(pc);
        break;
      }
      joined = true;
      log(`Raum beigetreten als ${msg.peerId}`);
      startConnection(msg.roomId, msg.iceServers);
      break;
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
    case 'error':
      if (rejoining) {
        // Slot or room gone (away too long, host left, server restarted): nothing to take back
        rejoining = false;
        roomSession = undefined;
        clearSession();
        // A connection that still works doesn't need the server
        if (pc?.connectionState === 'connected') log(`${msg.message} – weiter ohne Server`);
        else giveUp(msg.message);
        break;
      }
      // Before 'joined' the error is about joining (e.g. room not found) → back to the code field
      if (joined) setStatus(`❌ ${msg.message}`);
      else showJoinScreen(msg.message);
      break;
  }
}

function startConnection(roomId: string, iceServers?: IceServer[]): void {
  setStatus('Baue WebRTC-Verbindung auf …');
  const connection = new RTCPeerConnection(createRtcConfig(iceServers));
  pc = connection;

  // Create the DataChannel before the offer so it gets negotiated in the SDP
  reliableChannel = connection.createDataChannel(RELIABLE_CHANNEL_LABEL, RELIABLE_CHANNEL_OPTIONS);
  reliableChannel.onopen = () => {
    log('Zuverlässiger DataChannel offen');
    readyButton.disabled = false;
  };
  reliableChannel.onclose = () => {
    log('Zuverlässiger DataChannel geschlossen');
    readyButton.disabled = true;
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
        if (!racer) {
          setStatus('Zuschauer – du hast kein Auto');
          log('Kein Auto: du schaust zu');
        }
        break;
      // Lobby is over: changing your mind about being ready no longer matters
      case 'race-start':
        raceStarted = true;
        updateReadyButton();
        setStatus(racer ? 'Rennen läuft' : 'Rennen läuft – du schaust zu');
        log('🏁 Rennen gestartet');
        break;
    }
  };

  channel = connection.createDataChannel(CONTROL_CHANNEL_LABEL, CONTROL_CHANNEL_OPTIONS);
  channel.onopen = () => {
    setStatus(`Verbunden zu ${roomId}`);
    helloButton.disabled = false;
    log('DataChannel offen');
    window.setInterval(() => void refreshPath(connection), 2000);
    inputTimer = window.setInterval(() => {
      sendMessage(channel, { type: 'input', seq: ++inputSeq, steering: steerValue, throttle, brake });
    }, INPUT_INTERVAL_MS);
    void refreshPath(connection);
  };
  channel.onclose = () => {
    setStatus('Verbindung getrennt');
    window.clearInterval(inputTimer);
    helloButton.disabled = true;
    // Closed by the host, or the connection is dead for good: an ICE restart can't bring a DataChannel back.
    // 'closed' = closed here on purpose (giveUp), the join screen is up already.
    if (connection.connectionState !== 'closed') giveUp('Verbindung zum Host verloren');
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
      data: { kind: 'description', description: connection.localDescription!.toJSON() },
    });
    log('Offer gesendet');
  });
}

/**
 * Restores a broken connection instead of replacing it: an ICE restart looks for a new network path (e.g. after
 * switching from Wi-Fi to mobile data), while the DataChannels and the host's player stay the same.
 */
function handleConnectionState(connection: RTCPeerConnection): void {
  window.clearTimeout(iceRestartTimer);
  if (connection.connectionState === 'disconnected') {
    iceRestartTimer = window.setTimeout(() => restartIce(connection), ICE_RESTART_DELAY_MS);
  } else if (connection.connectionState === 'failed') {
    restartIce(connection);
  }
}

/** The phone always makes the offer, also for a restart – the host answers it on its existing connection. */
function restartIce(connection: RTCPeerConnection): void {
  window.clearTimeout(iceRestartTimer);
  // The new path is negotiated over the server: while rejoining, 'joined' starts the restart
  if (rejoining) return;
  // The server refused the rejoin: without it a failed connection can't be restored
  if (!roomSession) {
    if (connection.connectionState === 'failed') giveUp('Verbindung zum Host verloren');
    return;
  }
  log('ICE-Neustart …');
  enqueue(async () => {
    await connection.setLocalDescription(await connection.createOffer({ iceRestart: true }));
    signaling.send({
      type: 'signal',
      to: HOST_ID,
      data: { kind: 'description', description: connection.localDescription!.toJSON() },
    });
    log('ICE-Neustart: Offer gesendet');
  });
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
