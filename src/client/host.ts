import '../style.css';
import type { ChannelMessage, PeerId, ServerMessage } from '../shared/protocol';
import {
  applySignal,
  candidateType,
  createQueue,
  describePath,
  getConnectionPath,
  RTC_CONFIG,
  sendMessage,
} from './rtc';
import { SignalingClient } from './signaling';
import { byId, createLogger, hasWebRtcSupport } from './ui';
import QRCode from 'qrcode';

/** Host = PC. Accepts an offer from every phone and keeps one PeerConnection per phone. */

interface Peer {
  id: PeerId;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  enqueue: (task: () => Promise<void>) => void;
  row: HTMLTableRowElement;
  rttMs?: number;
  path?: string;
  pingTimer?: number;
  steerSeq: number;
  steerValue?: number;
}

const log = createLogger(byId('log'));
const peersTable = byId<HTMLTableSectionElement>('peers');
const QR_CODE_SIZE = 200;
const peers = new Map<PeerId, Peer>();
let signaling: SignalingClient;

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

/** Production: the phone opens the controller under the same address as this page. */
function buildRoomURL(roomId: string): string {
  // URL keeps protocol and port of the current page and omits default ports (no "host:/…")
  const url = new URL('/controller.html', location.origin);
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

/** One way to join: QR code to scan with the phone, plus the link as text. */
function createJoinOption(url: string): HTMLLIElement {
  const item = document.createElement('li');
  const canvas = document.createElement('canvas');
  const link = document.createElement('a');
  link.href = link.textContent = url;
  item.append(canvas, link);
  createSessionQrCode(canvas, url);
  return item;
}

function addPeer(id: PeerId): void {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const row = peersTable.insertRow();
  row.insertCell().textContent = id;
  row.insertCell();
  row.insertCell();
  row.insertCell();
  row.insertCell();
  const peer: Peer = { id, pc, row, enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), steerSeq: 0 };
  peers.set(id, peer);
  renderPeer(peer);
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
        peer.row.classList.remove('flash');
        void peer.row.offsetWidth; // restart the animation
        peer.row.classList.add('flash');
        break;
      case 'steer':
        if (msg.seq > peer.steerSeq) {
          peer.steerSeq = msg.seq;
          peer.steerValue = msg.value;
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

function renderPeer(peer: Peer): void {
  const [, state, path, steerValue, rtt] = peer.row.cells;
  state.textContent = peer.pc.connectionState;
  path.textContent = peer.path ?? '–';
  steerValue.textContent = peer.steerValue?.toFixed(2) ?? 'nA';
  rtt.textContent = peer.rttMs === undefined ? '–' : `${peer.rttMs.toFixed(1)} ms`;
}

function removePeer(id: PeerId): void {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearInterval(peer.pingTimer);
  peer.pc.close();
  peer.row.remove();
  peers.delete(id);
  log(`[${id}] hat den Raum verlassen`);
}

// Fixed width: the canvas is not in the page yet, so it has no clientWidth to read
function createSessionQrCode(canvas: HTMLCanvasElement, lobbyURL: string) {
  QRCode.toCanvas(canvas, lobbyURL, { width: QR_CODE_SIZE, margin: 2 }).catch((err: unknown) =>
    log(`❌ QR-Code konnte nicht erzeugt werden: ${String(err)}`),
  );
}

main().catch((err: unknown) => log(`❌ ${String(err)}`));