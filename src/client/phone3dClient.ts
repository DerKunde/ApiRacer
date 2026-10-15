import '../style.css';
import { HOST_ID, type ChannelMessage, type ServerMessage, type IceServer } from '../shared/protocol';
import {
  applySignal,
  candidateType,
  CONTROL_CHANNEL_LABEL,
  CONTROL_CHANNEL_OPTIONS,
  createQueue,
  createRtcConfig,
  describePath,
  getConnectionPath,
  sendMessage,
} from './rtc';
import { SignalingClient } from './signaling';
import { byId, createLogger, hasWebRtcSupport } from './ui';
import {
  detectOrientationSource,
  eulerToQuaternion,
  needsOrientationPermission,
  requestOrientationEventPermission,
  updateCompassOffset,
  type OrientationSource,
  type Quaternion,
  type WebKitDeviceOrientationEvent,
} from './mobileDeviceSensors';

/**
 * 3D demo phone. Determines the phone's absolute rotation and sends it as a quaternion to the host.
 * The WebRTC part is copied from controller.ts on purpose (duplication accepted for now).
 */

const log = createLogger(byId('log'));
const statusEl = byId('status');
const permissionButton = byId<HTMLButtonElement>('sensor-permission-btn');
const calibrateButton = byId<HTMLButtonElement>('calibrate-btn');
const sourceLabel = byId<HTMLElement>('orientation-source');
const eulerLabel = byId<HTMLElement>('orientation-euler');
const compassLabel = byId<HTMLElement>('compass-heading');
const quaternionLabel = byId<HTMLElement>('orientation-quaternion');

const SOURCE_TEXT: Record<OrientationSource, string> = {
  'deviceorientationabsolute': 'deviceorientationabsolute (absolut)',
  'webkit-compass': 'webkit-compass (absolut, sobald der Kompass gültig ist)',
  'deviceorientation': 'deviceorientation (relativ)',
  'none': 'keine – Gerät liefert keine Drehung',
};
const SEND_INTERVAL_MS = 1000 / 60;
// How long each step of the source detection waits for a real event
const SOURCE_TIMEOUT_MS = 1000;
// Max. tilt (|beta| and |gamma|) that still counts as "lying flat" for the calibration. Much stricter than the
// 30° of updateCompassOffset: a table is level, and any tilt here ends up as an error in the zero point.
const FLAT_TOLERANCE_DEG = 5;
const enqueue = createQueue((err) => log(`❌ ${String(err)}`));

let signaling: SignalingClient;
let pc: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let pathTimer: number | undefined;
let sendTimer: number | undefined;

// Latest rotation – written by the sensor handler, read by the send timer
let quaternion: Quaternion | null = null;
let absolute = false;
let orientationSeq = 0;
let source: OrientationSource = 'none';
// iOS only: alphaAbs = alpha + compassOffset, null until the compass delivered a valid flat measurement
let compassOffset: number | null = null;
let yawZero = 0;
let lastYaw = 0;
// Calibration in two steps: false = "Ausrichten starten", true = waiting until the phone lies flat
let calibrating = false;
let lastBeta: number | null = null;
let lastGamma: number | null = null;

/**
 * state picks the icon in front of the text (.status[data-state] in style.css):
 * 'connected' → link, 'disconnected' → link_off, none → no icon (while connecting).
 */
function setStatus(text: string, state?: 'connected' | 'disconnected'): void {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
  // Every status change also goes to the log → after a failure it shows how far the connection got
  // (e.g. "Raum ABCD nicht gefunden" from the server is only reported here)
  log(text);

  // Card and calibrate button only while connected. The log also stays after an error or a disconnect –
  // that's when its details (ICE candidates, connection states) are most useful. While connecting: status line only.
  const connected = state === 'connected';
  byId('peer-card').hidden = !connected;
  byId('path').hidden = !connected;
  calibrateButton.hidden = !connected;
  // Hint is empty outside the calibration – CSS (#calibrate-hint:empty) hides it then
  byId('calibrate-hint').hidden = !connected;
  byId('log-section').hidden = state === undefined;
}

async function main(roomId: string): Promise<void> {
  byId('session').hidden = false;
  byId('join-hint').hidden = true;
  // Not awaited: the sensor check (1–2 s) runs in parallel to the connection setup, usually done before the
  // card appears. Independent of WebRTC, so it starts before the WebRTC check below.
  void initOrientation();

  if (!hasWebRtcSupport()) {
    setStatus('Kein WebRTC verfügbar', 'disconnected');
    log('RTCPeerConnection fehlt – evtl. ist HTTPS nötig (npm run dev:https)');
    return;
  }

  setStatus('Verbinde mit Signaling-Server …');
  signaling = await SignalingClient.connect(handleServerMessage, () => log('Signaling-Verbindung geschlossen'));
  signaling.send({ type: 'join-room', roomId });
}

/** Text below the button in the sensor overlay; empty text hides it. */
function setSensorHint(text: string): void {
  const hint = byId('sensor-hint');
  hint.textContent = text;
  hint.hidden = text === '';
}

/**
 * Runs once per session (from main), without a tap. Asks "do sensor events arrive?" instead of "is there a
 * permission?" – Safari has no way to read the permission state without prompting, and Android needs none.
 * Events arriving = permission is there, whatever the reason (Android, or iOS already allowed earlier).
 */
async function initOrientation(): Promise<void> {
  const detected = await detectOrientationSource(SOURCE_TIMEOUT_MS);
  if (detected !== 'none') {
    startOrientation(detected);
    return;
  }
  if (needsOrientationPermission()) {
    // iOS without permission yet: now the tap is needed (requestPermission only works inside a user gesture)
    permissionButton.disabled = false;
    setSensorHint('');
    return;
  }
  // No events and no permission to ask for: the device has no motion sensors (e.g. laptop)
  permissionButton.hidden = true;
  sourceLabel.textContent = SOURCE_TEXT.none;
  setSensorHint('Keine Bewegungssensoren gefunden – dieses Gerät liefert keine Drehung.');
  log('Keine Bewegungssensoren gefunden');
}

/** Sensors deliver data: reveal the values under the overlay and listen to the detected event. */
function startOrientation(detected: Exclude<OrientationSource, 'none'>): void {
  source = detected;
  sourceLabel.textContent = SOURCE_TEXT[source];
  log(`Orientierungsquelle: ${source}`);
  byId('sensor-overlay').hidden = true;

  if (source === 'deviceorientationabsolute') {
    window.addEventListener('deviceorientationabsolute', handleOrientation);
  }
  else {
    window.addEventListener('deviceorientation', handleOrientation);
  }
  // Calibration can be started
  renderCalibration();
}

permissionButton.addEventListener('click', async () => {
  const permissionResult = await requestOrientationEventPermission();
  log(`Sensor-Berechtigung: ${permissionResult ? 'erteilt' : 'verweigert'}`);
  if (!permissionResult) {
    // Overlay stays. Safari answers every further request with 'denied' (findings: "Once denied") until the tab
    // is closed → tell the user how to retry
    setSensorHint('Zugriff verweigert – Tab schließen, Link neu öffnen und „Erlauben" wählen.');
    return;
  }
  permissionButton.disabled = true;
  setSensorHint('Suche Sensoren …');
  const detected = await detectOrientationSource(SOURCE_TIMEOUT_MS);
  if (detected === 'none') {
    // Allowed, but still no events – rare, but then a retry is the only option
    permissionButton.disabled = false;
    setSensorHint('Keine Sensordaten erhalten – bitte erneut versuchen.');
    return;
  }
  startOrientation(detected);
});

calibrateButton.addEventListener('click', handleCalibration);

/** Converts every sensor event into a quaternion and only stores it – the send timer picks it up. */
function handleOrientation(event: DeviceOrientationEvent): void {
  const { alpha, beta, gamma } = event;
  if (alpha === null || beta === null || gamma === null) {
    return;
  }
  eulerLabel.textContent = `${alpha.toFixed(0)} / ${beta.toFixed(0)} / ${gamma.toFixed(0)}`;

  let yaw = alpha;
  if (source === 'webkit-compass') {
    // Missing values count as invalid (-1), like iOS reports an uncalibrated compass
    const { webkitCompassHeading: heading = -1, webkitCompassAccuracy: accuracy = -1 } = event as WebKitDeviceOrientationEvent;
    compassLabel.textContent = `${heading.toFixed(0)}° (± ${accuracy.toFixed(0)}°)`;
    compassOffset = updateCompassOffset(alpha, beta, gamma, heading, accuracy, compassOffset);
    // Until the first valid flat measurement the rotation stays relative
    if (compassOffset !== null) {
      yaw = alpha + compassOffset;
    }
    absolute = compassOffset !== null;
  }
  else {
    absolute = source === 'deviceorientationabsolute';
  }
  lastBeta = beta;
  lastGamma = gamma;
  renderCalibration();
  lastYaw = yaw;
  quaternion = eulerToQuaternion(yaw - yawZero, beta, gamma);
  quaternionLabel.textContent = quaternion.map((value) => value.toFixed(2)).join(' / ');
}

/** Step 1 starts waiting for the flat phone, step 2 takes the current heading as "towards the screen". */
function handleCalibration(): void {
  if (calibrating) {
    yawZero = lastYaw;
    log('Ausgerichtet');
  }
  calibrating = !calibrating;
  renderCalibration();
}

/**
 * Button text, enabled state and hint for the current calibration step. Runs on every sensor event (60×/s),
 * so it only writes to the DOM when something changed.
 */
function renderCalibration(): void {
  let label = 'Ausrichten starten';
  let enabled = source !== 'none';
  let hint = '';

  if (calibrating) {
    const flat = lastBeta !== null && lastGamma !== null
      && Math.abs(lastBeta) < FLAT_TOLERANCE_DEG && Math.abs(lastGamma) < FLAT_TOLERANCE_DEG;
    // iOS: the yaw only becomes absolute once the compass delivered a valid flat measurement
    const compassReady = source !== 'webkit-compass' || absolute;

    label = 'Ausrichten abschließen';
    enabled = flat && compassReady;
    hint = !flat
      ? 'Handy flach auf den Tisch legen, Oberkante zeigt zum Host-Bildschirm.'
      : !compassReady
        ? 'Warte auf Kompass …'
        : 'Liegt flach – jetzt abschließen.';
  }

  if (calibrateButton.textContent !== label) calibrateButton.textContent = label;
  calibrateButton.disabled = !enabled;
  const hintEl = byId('calibrate-hint');
  if (hintEl.textContent !== hint) hintEl.textContent = hint;
}

/** Rounds to 4 decimals – enough precision, shorter JSON */
function roundQuaternion(q: Quaternion): Quaternion {
  return q.map((value) => Math.round(value * 10000) / 10000) as Quaternion;
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'joined':
      byId('peer-id').textContent = msg.peerId;
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
      setStatus('Host hat den Raum geschlossen', 'disconnected');
      pc?.close();
      break;
    case 'error':
      setStatus(msg.message, 'disconnected');
      break;
  }
}

function startConnection(roomId: string, iceServers?: IceServer[]): void {
  setStatus('Baue WebRTC-Verbindung auf …');
  const connection = new RTCPeerConnection(createRtcConfig(iceServers));
  pc = connection;

  // Create the DataChannel before the offer so it gets negotiated in the SDP
  channel = connection.createDataChannel(CONTROL_CHANNEL_LABEL, CONTROL_CHANNEL_OPTIONS);
  channel.onopen = () => {
    setStatus(`Verbunden mit ${roomId}`, 'connected');
    log('DataChannel offen');
    // Once per second, like the host: refresh the path and measure the round-trip time (answered by the host's pong)
    pathTimer = window.setInterval(() => {
      void refreshPath(connection);
      sendMessage(channel, { type: 'ping', t: performance.now() });
    }, 1000);
    // Fixed rate instead of sending from the sensor handler: sensor events arrive irregularly
    sendTimer = window.setInterval(() => {
      if (!quaternion) return;
      sendMessage(channel, { type: 'orientation', seq: ++orientationSeq, quaternion: roundQuaternion(quaternion), absolute });
    }, SEND_INTERVAL_MS);
    void refreshPath(connection);
  };
  channel.onclose = () => {
    setStatus('Verbindung getrennt', 'disconnected');
    window.clearInterval(pathTimer);
    window.clearInterval(sendTimer);
    // No more pongs → drop the last ping instead of showing a stale value (CSS hides the empty span incl. "·")
    byId('rtt').textContent = '';
  };
  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    if (msg.type === 'ping') sendMessage(channel, { type: 'pong', t: msg.t });
    // msg.t is our own timestamp from the ping → same clock, so the difference is the round-trip time
    if (msg.type === 'pong') byId('rtt').textContent = `${(performance.now() - msg.t).toFixed(1)} ms`;
    if (msg.type === 'peer-color') byId('peer-card').style.setProperty('--peer-color', msg.color);
  };

  connection.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    signaling.send({ type: 'signal', to: HOST_ID, data: { kind: 'candidate', candidate: candidate.toJSON() } });
    log(`eigener ICE-Kandidat gesendet (${candidate.type ?? candidateType(candidate.candidate)})`);
  };
  connection.onconnectionstatechange = () => {
    log(`Verbindungsstatus: ${connection.connectionState}`);
    // Card header shows the same state as this phone's card on the host
    byId('connection-state').textContent = connection.connectionState;
    // ICE found no working path (e.g. no TURN server reachable): the DataChannel never opens, so without this
    // the status would stay at "Baue WebRTC-Verbindung auf …" and the log hidden
    if (connection.connectionState === 'failed') setStatus('Verbindung fehlgeschlagen', 'disconnected');
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

async function refreshPath(connection: RTCPeerConnection): Promise<void> {
  const path = await getConnectionPath(connection);
  byId('path').textContent = path ? describePath(path) : '';
}

const roomInput = byId<HTMLInputElement>('room-input');
// Join form is always visible: enter a code manually, or switch to another room after joining via QR code.
// Submitting reloads the page with ?room=… → the same path as opening a QR link.
byId<HTMLFormElement>('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = roomInput.value.trim().toUpperCase();
  if (code) location.search = `?room=${encodeURIComponent(code)}`;
});

const roomId = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
if (roomId) {
  // Opened via QR code / link: show the code in the field
  roomInput.value = roomId;
  main(roomId).catch((err: unknown) => {
    setStatus('Verbindung fehlgeschlagen', 'disconnected');
    log(String(err));
  });
}
