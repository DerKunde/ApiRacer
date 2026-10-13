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
const permissionButton = byId<HTMLButtonElement>('gyroPermissionButton');
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

function setStatus(text: string): void {
  statusEl.textContent = text;
}

async function main(roomId: string): Promise<void> {
  byId('session').hidden = false;
  byId('room').textContent = roomId;

  if (!hasWebRtcSupport()) {
    setStatus('❌ Kein WebRTC verfügbar');
    log('RTCPeerConnection fehlt – evtl. ist HTTPS nötig (npm run dev:https)');
    return;
  }

  setStatus('Verbinde mit Signaling-Server …');
  signaling = await SignalingClient.connect(handleServerMessage, () => log('Signaling-Verbindung geschlossen'));
  signaling.send({ type: 'join-room', roomId });
}

permissionButton.addEventListener('click', async () => {
  const permissionResult = await requestOrientationEventPermission();
  log('Gyro permissions are ' + permissionResult);
  if (!permissionResult) {
    log('Keine Sensor-Berechtigung – ohne sie gibt es keine Drehung.');
    return;
  }
  permissionButton.disabled = true;
  sourceLabel.textContent = 'suche …';
  source = await detectOrientationSource(SOURCE_TIMEOUT_MS);
  sourceLabel.textContent = SOURCE_TEXT[source];
  log(`Orientierungsquelle: ${source}`);

  if (source === 'deviceorientationabsolute') {
    window.addEventListener('deviceorientationabsolute', handleOrientation);
  }
  else if (source !== 'none') {
    window.addEventListener('deviceorientation', handleOrientation);
  }
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
  calibrateButton.disabled = source === 'webkit-compass' && !absolute;
  lastYaw = yaw;
  quaternion = eulerToQuaternion(yaw - yawZero, beta, gamma);
  quaternionLabel.textContent = quaternion.map((value) => value.toFixed(2)).join(' / ');
}

function handleCalibration(): void {
  yawZero = lastYaw;
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
      startConnection(msg.iceServers);
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
      setStatus('Host hat den Raum geschlossen');
      pc?.close();
      break;
    case 'error':
      setStatus(`❌ ${msg.message}`);
      break;
  }
}

function startConnection(iceServers?: IceServer[]): void {
  setStatus('Baue WebRTC-Verbindung auf …');
  const connection = new RTCPeerConnection(createRtcConfig(iceServers));
  pc = connection;

  // Create the DataChannel before the offer so it gets negotiated in the SDP
  channel = connection.createDataChannel(CONTROL_CHANNEL_LABEL, CONTROL_CHANNEL_OPTIONS);
  channel.onopen = () => {
    setStatus('✅ Verbunden (Peer-to-Peer)');
    log('DataChannel offen');
    pathTimer = window.setInterval(() => void refreshPath(connection), 2000);
    // Fixed rate instead of sending from the sensor handler: sensor events arrive irregularly
    sendTimer = window.setInterval(() => {
      if (!quaternion) return;
      sendMessage(channel, { type: 'orientation', seq: ++orientationSeq, quaternion: roundQuaternion(quaternion), absolute });
    }, SEND_INTERVAL_MS);
    void refreshPath(connection);
  };
  channel.onclose = () => {
    setStatus('Verbindung getrennt');
    window.clearInterval(pathTimer);
    window.clearInterval(sendTimer);
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
  connection.onconnectionstatechange = () => log(`Verbindungsstatus: ${connection.connectionState}`);

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
  byId('path').textContent = path ? describePath(path) : '–';
}

const roomId = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
if (roomId) {
  main(roomId).catch((err: unknown) => {
    setStatus('❌ Verbindung fehlgeschlagen');
    log(String(err));
  });
} else {
  // No room code in the URL: let the user enter it manually
  const form = byId<HTMLFormElement>('join-form');
  form.hidden = false;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = byId<HTMLInputElement>('room-input').value.trim().toUpperCase();
    if (code) location.search = `?room=${encodeURIComponent(code)}`;
  });
}
