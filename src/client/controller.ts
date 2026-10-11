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
  detectHolding,
  requestOrientationEventPermission,
  steeringAngle,
  steeringValue,
  type DeviceHolding,
} from './orientation';

/** Controller = phone. Initiates the connection to the host PC (creates the offer and the DataChannel). */

const log = createLogger(byId('log'));
const statusEl = byId('status');
const helloButton = byId<HTMLButtonElement>('hello-btn');
const permissionButton = byId<HTMLButtonElement>('gyroPermissionButton');
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
const STEER_INTERVAL_MS = 1000 / 60;
const enqueue = createQueue((err) => log(`❌ ${String(err)}`));

let signaling: SignalingClient;
let pc: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let helloCount = 0;
let holding: DeviceHolding = 'portrait';
let steerValue = 0;
let steerSeq = 0;
let steerTimer: number | undefined;

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
  if (permissionResult === true) {
    window.addEventListener("deviceorientation", handleOrientation);
    window.addEventListener("devicemotion", handleMotion);
  }
  else {
    log('No gyro permission. You will play with 2D input. Which is not implemented yet. *sad noises*');
  }
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
      helloButton.disabled = true;
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
    helloButton.disabled = false;
    log('DataChannel offen');
    window.setInterval(() => void refreshPath(connection), 2000);
    steerTimer = window.setInterval(() => {
      sendMessage(channel, { type: 'steer', seq: ++steerSeq, value: steerValue });
    }, STEER_INTERVAL_MS);
    void refreshPath(connection);
  };
  channel.onclose = () => {
    setStatus('Verbindung getrennt');
    window.clearInterval(steerTimer);
    helloButton.disabled = true;
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

helloButton.addEventListener('click', () => {
  sendMessage(channel, { type: 'hello', text: `Hallo #${++helloCount} vom Handy 👋` });
});

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
