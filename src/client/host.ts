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
}

const log = createLogger(byId('log'));
const peersTable = byId<HTMLTableSectionElement>('peers');
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
      showRoom(msg.roomId, msg.lanAddresses);
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
  // Opened on "localhost" → offer the PC's LAN addresses to the phone instead
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const hosts = isLocal ? lanAddresses : [location.hostname];
  const links = byId('join-links');
  links.replaceChildren(
    ...hosts.map((host) => {
      const url = `${location.protocol}//${host}:${location.port}/controller.html?room=${roomId}`;
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = link.textContent = url;
      item.append(link);
      return item;
    }),
  );
  log(`Raum ${roomId} erstellt – warte auf Handys …`);
}

function addPeer(id: PeerId): void {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const row = peersTable.insertRow();
  row.insertCell().textContent = id;
  row.insertCell();
  row.insertCell();
  row.insertCell();
  const peer: Peer = { id, pc, row, enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)) };
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
    }
  };
}

async function refreshPath(peer: Peer): Promise<void> {
  const path = await getConnectionPath(peer.pc);
  peer.path = path ? describePath(path) : undefined;
  renderPeer(peer);
}

function renderPeer(peer: Peer): void {
  const [, state, path, rtt] = peer.row.cells;
  state.textContent = peer.pc.connectionState;
  path.textContent = peer.path ?? '–';
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

main().catch((err: unknown) => log(`❌ ${String(err)}`));
