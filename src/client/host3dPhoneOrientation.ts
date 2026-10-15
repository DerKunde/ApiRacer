import '../style.css';
import type { ChannelMessage, IceServer, PeerId, ServerMessage } from '../shared/protocol';
import {
  applySignal,
  candidateType,
  createQueue,
  createRtcConfig,
  describePath,
  getConnectionPath,
  sendMessage,
} from './rtc';
import { SignalingClient } from './signaling';
import { byId, createLogger, hasWebRtcSupport } from './ui';
import { eulerToQuaternion, type Quaternion } from './mobileDeviceSensors';
import QRCode from 'qrcode';
import { ThreeOrientationView } from './threeOrientationView';
import type { OrientationView } from './orientationView';

/**
 * 3D demo host = PC. Shows one phone model per connected phone that mirrors its absolute rotation.
 * The WebRTC part is copied from host.ts on purpose (duplication accepted for now).
 */

interface Peer {
  id: PeerId;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  enqueue: (task: () => Promise<void>) => void;
  card: PeerCard;
  rttMs?: number;
  path?: string;
  pingTimer?: number;
  orientationSeq: number;
  quaternion?: Quaternion;
  absolute?: boolean;
}

/** One card per phone in the sidebar; keeps the elements renderPeer writes into. */
interface PeerCard {
  root: HTMLLIElement;
  state: HTMLElement;
  path: HTMLElement;
  rtt: HTMLElement;
  absolute: HTMLElement;
  quaternion: HTMLElement;
}

const log = createLogger(byId('log'));
const peerList = byId<HTMLUListElement>('peers');
const QR_CODE_SIZE = 200;
let nextColorIndex = 0;
// Short enough to stay narrower than the QR code – the button then stretches to exactly its width
const COPY_LABEL = '🔗 Link kopieren';
const view: OrientationView = new ThreeOrientationView(byId('orientation-view'));

// Page the phone opens via QR code / link
const JOIN_PAGE = '/phone3dClient.html';
const peers = new Map<PeerId, Peer>();
let signaling: SignalingClient;
let iceServers: IceServer[] | undefined;

async function main(): Promise<void> {
  if (!hasWebRtcSupport()) {
    log('❌ Dieser Browser unterstützt kein WebRTC');
    return;
  }
  signaling = await SignalingClient.connect(handleServerMessage, () =>
    log('⚠️ Verbindung zum Signaling-Server verloren (bestehende WebRTC-Verbindungen laufen weiter)'),
  );
  signaling.send({ type: 'create-room' });
}

function handleServerMessage(msg: ServerMessage): void {
  switch (msg.type) {
    case 'room-created':
      iceServers = msg.iceServers;
      showRoom(msg.roomId, msg.lanAddresses ?? []);
      break;
    case 'peer-joined':
      addPeer(msg.peerId);
      break;
    case 'peer-left':
      removePeer(msg.peerId);
      break;
    case 'signal': {
      const peer = peers.get(msg.from);
      if (!peer) return;
      const { data } = msg;
      log(`[${peer.id}] empfangen: ${data.kind === 'description' ? data.description.type : `ICE-Kandidat (${candidateType(data.candidate.candidate)})`}`);
      peer.enqueue(async () => {
        const reply = await applySignal(peer.pc, data);
        if (reply) {
          signaling.send({ type: 'signal', to: peer.id, data: reply });
          log(`[${peer.id}] Answer gesendet`);
        }
      });
      break;
    }
    case 'error':
      log(`❌ Server: ${msg.message}`);
      break;
  }
}

function showRoom(roomId: string, lanAddresses: string[]): void {
  byId('room-code').textContent = roomId;

  // Dev server opened on "localhost": the phone can't use that name → offer every LAN address instead.
  // import.meta.env.DEV is replaced by `false` in the production build, so this branch is stripped there.
  const urls =
    import.meta.env.DEV && isOpenedOnLocalhost() ? buildLocalRoomURLs(roomId, lanAddresses) : [buildRoomURL(roomId)];

  byId('join-links').replaceChildren(...urls.map(createJoinOption));
  if (urls.length === 0) log('⚠️ Keine LAN-Adresse gefunden – ist der PC mit einem Netzwerk verbunden?');
  log(`Raum ${roomId} erstellt – warte auf Handys …`);
}

/** Production: the phone opens the 3D client under the same address as this page. */
function buildRoomURL(roomId: string): string {
  // URL keeps protocol and port of the current page and omits default ports (no "host:/…")
  const url = new URL(JOIN_PAGE, location.origin);
  url.searchParams.set('room', roomId);
  return url.href;
}

/**
 * Local dev: one URL per LAN address of the PC. The server can only list all interfaces
 * (incl. virtual adapters like WSL/Hyper-V/VPN), so we offer all of them – at least one works.
 */
function buildLocalRoomURLs(roomId: string, lanAddresses: string[]): string[] {
  return lanAddresses.map((address) => {
    const url = new URL(buildRoomURL(roomId));
    url.hostname = address;
    return url.href;
  });
}

function isOpenedOnLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/** One way to join: QR code to scan with the phone, plus a button that copies the link (e.g. to send it via chat). */
function createJoinOption(url: string): HTMLLIElement {
  const item = document.createElement('li');
  const canvas = document.createElement('canvas');
  const copyButton = document.createElement('button');
  copyButton.textContent = COPY_LABEL;
  // Link is no longer shown as text – hovering the button still reveals it (handy with several LAN links in dev)
  copyButton.title = url;
  copyButton.addEventListener('click', () => void copyJoinLink(copyButton, url));
  item.append(canvas, copyButton);
  createSessionQrCode(canvas, url);
  return item;
}

// Clipboard API only exists in a secure context (https or localhost) → on plain http via LAN IP
// navigator.clipboard is undefined and the call throws, which ends up in the catch.
async function copyJoinLink(button: HTMLButtonElement, url: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = '✓ Kopiert';
    window.setTimeout(() => (button.textContent = COPY_LABEL), 2000);
  } catch (err) {
    log(`❌ Link konnte nicht kopiert werden: ${String(err)} – Link: ${url}`);
  }
}

function addPeer(id: PeerId): void {
  const pc = new RTCPeerConnection(createRtcConfig(iceServers));
  // Same color for the phone model and its card, so you can tell which card belongs to which phone
  const color = nextPeerColor();
  const card = createPeerCard(id, color);
  const peer: Peer = { id, pc, card, enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), orientationSeq: 0 };
  peers.set(id, peer);
  renderPeer(peer);
  view.addPeer(id, color);
  log(`[${id}] beigetreten`);

  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    signaling.send({ type: 'signal', to: id, data: { kind: 'candidate', candidate: candidate.toJSON() } });
    log(`[${id}] eigener ICE-Kandidat gesendet (${candidate.type ?? candidateType(candidate.candidate)})`);
  };
  pc.onconnectionstatechange = () => {
    log(`[${id}] Verbindungsstatus: ${pc.connectionState}`);
    renderPeer(peer);
  };
  // The phone creates the DataChannel, the PC receives it here
  pc.ondatachannel = ({ channel }) => setupChannel(peer, channel);
}

function setupChannel(peer: Peer, channel: RTCDataChannel): void {
  peer.channel = channel;

  channel.onopen = () => {
    log(`[${peer.id}] ✅ DataChannel offen – ab jetzt direkt Peer-to-Peer`);
    peer.pingTimer = window.setInterval(() => {
      sendMessage(channel, { type: 'ping', t: performance.now() });
      void refreshPath(peer);
    }, 1000);
  };
  channel.onclose = () => window.clearInterval(peer.pingTimer);

  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    switch (msg.type) {
      case 'pong':
        peer.rttMs = performance.now() - msg.t;
        renderPeer(peer);
        break;
      case 'ping':
        sendMessage(channel, { type: 'pong', t: msg.t });
        break;
      case 'hello':
        log(`[${peer.id}] 💬 ${msg.text}`);
        break;
      case 'orientation':
        // Unordered channel: drop packets older than the last one shown
        if (msg.seq > peer.orientationSeq) {
          peer.orientationSeq = msg.seq;
          peer.quaternion = msg.quaternion;
          peer.absolute = msg.absolute;
          view.updatePeer(peer.id, msg.quaternion);
          renderPeer(peer);
        }
        break;
    }
  };
}

async function refreshPath(peer: Peer): Promise<void> {
  const path = await getConnectionPath(peer.pc);
  peer.path = path ? describePath(path) : undefined;
  renderPeer(peer);
}

/**
 * Hue steps by the golden ratio (0.381966 of the circle ≈ 137.5°), so consecutive colors are far apart and never
 * repeat exactly. The counter only goes up – a phone that leaves doesn't hand its color to the next one.
 * Comma syntax for hsl(), because THREE.Color's parser expects it.
 */
function nextPeerColor(): string {
  const hue = (++nextColorIndex * 0.381966 % 1) * 360;
  return `hsl(${hue.toFixed(1)}, 70%, 55%)`;
}

/** Card header: ID + connection state, below it the details as label/value pairs (<dl>). */
function createPeerCard(id: PeerId, color: string): PeerCard {
  const root = document.createElement('li');
  root.className = 'peer-card';
  // Read by .peer-card in style.css (colored left edge)
  root.style.setProperty('--peer-color', color);

  const head = document.createElement('div');
  head.className = 'peer-head';
  const name = document.createElement('strong');
  name.textContent = id;
  // Right side of the header: "connected · 12.3 ms"
  const status = document.createElement('span');
  status.className = 'peer-status';
  const state = document.createElement('span');
  const rtt = document.createElement('span');
  rtt.className = 'peer-rtt';
  status.append(state, rtt);
  head.append(name, status);

  const details = document.createElement('dl');
  const addDetail = (label: string): HTMLElement => {
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    term.textContent = label;
    details.append(term, value);
    return value;
  };
  // Display order = call order
  const path = addDetail('Weg');
  const absolute = addDetail('Absolut');
  const quaternion = addDetail('Quaternion');

  root.append(head, details);
  peerList.append(root);
  return { root, state, path, rtt, absolute, quaternion };
}

function renderPeer(peer: Peer): void {
  const { state, path, quaternion, absolute, rtt } = peer.card;
  state.textContent = peer.pc.connectionState;
  path.textContent = peer.path ?? '–';
  quaternion.textContent = peer.quaternion?.map((value) => value.toFixed(2)).join(' / ') ?? '–';
  absolute.textContent = peer.absolute === undefined ? '–' : peer.absolute ? 'ja' : 'nein';
  // Empty until the first pong → CSS hides it together with its "·" separator (.peer-rtt:empty)
  rtt.textContent = peer.rttMs === undefined ? '' : `${peer.rttMs.toFixed(1)} ms`;
}

function removePeer(id: PeerId): void {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearInterval(peer.pingTimer);
  peer.pc.close();
  peer.card.root.remove();
  view.removePeer(id);
  peers.delete(id);
  log(`[${id}] hat den Raum verlassen`);
}

// Fixed width: the canvas is not in the page yet, so it has no clientWidth to read
function createSessionQrCode(canvas: HTMLCanvasElement, lobbyURL: string) {
  QRCode.toCanvas(canvas, lobbyURL, { width: QR_CODE_SIZE, margin: 2 }).catch((err: unknown) =>
    log(`❌ QR-Code konnte nicht erzeugt werden: ${String(err)}`),
  );
}

// Dev-only test buttons: add/remove fake phones without real controllers, to check grid layout and camera fit.
// They only talk to the view – no WebRTC, no peer card.
function addTestButtons(): void {
  const testIds: PeerId[] = [];
  let nextTestId = 1;

  const addButton = document.createElement('button');
  addButton.textContent = '+ Test-Handy';
  addButton.addEventListener('click', () => {
    const id = `test-${nextTestId++}`;
    testIds.push(id);
    view.addPeer(id, nextPeerColor());
    // Random rotation, so you can see whether tilted neighbors overlap
    view.updatePeer(id, eulerToQuaternion(Math.random() * 360, Math.random() * 180 - 90, Math.random() * 180 - 90));
  });

  const removeButton = document.createElement('button');
  removeButton.textContent = '− Test-Handy';
  removeButton.addEventListener('click', () => {
    // Removes a random one, so the re-layout after removing from the middle gets tested too
    const [id] = testIds.splice(Math.floor(Math.random() * testIds.length), 1);
    if (id != null) view.removePeer(id);
  });

  const testBar = document.createElement('p');
  testBar.className = 'test-buttons';
  testBar.append(addButton, removeButton);
  // Above the view, not below: the phone list in the sidebar ends where the view section ends → stays aligned
  // with the bottom edge of the canvas
  byId('orientation-view').before(testBar);
}

// import.meta.env.DEV is replaced by `false` in the production build, so the test buttons are stripped there.
if (import.meta.env.DEV) addTestButtons();

main().catch((err: unknown) => log(`❌ ${String(err)}`));
