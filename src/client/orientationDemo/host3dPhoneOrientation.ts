import '../../style.css';
import type { ChannelMessage, IceServer, PeerId, ServerMessage } from '../../shared/protocol';
import {
  applySignal,
  candidateType,
  createQueue,
  createRtcConfig,
  describePath,
  getConnectionPath,
  sendMessage,
} from '../common/rtc';
import { SignalingClient } from '../common/signaling';
import { byId, createLogger, hasWebRtcSupport } from '../common/ui';
import { eulerToQuaternion, type Quaternion } from '../common/mobileDeviceSensors';
import { buildJoinURLs, createJoinOption, createPeerCard, nextPeerColor, type PeerCard } from '../common/hostDashboard';
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
  card: PeerCard<(typeof DETAILS)[number]>;
  color: string;
  rttMs?: number;
  path?: string;
  pingTimer?: number;
  orientationSeq: number;
  quaternion?: Quaternion;
  absolute?: boolean;
}

// Peer card rows, in display order
const DETAILS = ['Weg', 'Absolut', 'Quaternion'] as const;

const log = createLogger(byId('log'));
const peerList = byId<HTMLUListElement>('peers');
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

  const urls = buildJoinURLs(JOIN_PAGE, roomId, lanAddresses);
  byId('join-links').replaceChildren(...urls.map((url) => createJoinOption(url, log)));
  if (urls.length === 0) log('⚠️ Keine LAN-Adresse gefunden – ist der PC mit einem Netzwerk verbunden?');
  log(`Raum ${roomId} erstellt – warte auf Handys …`);
}

function addPeer(id: PeerId): void {
  const pc = new RTCPeerConnection(createRtcConfig(iceServers));
  // Same color for the phone model and its card, so you can tell which card belongs to which phone
  const color = nextPeerColor();
  const card = createPeerCard(peerList, id, color, DETAILS);
  card.details.Quaternion.className = 'quaternion';
  const peer: Peer = { id, pc, card, color, enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), orientationSeq: 0 };
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
      // Send the peer color to the phone, currently happens also on every ping (1 s) – could be optimized to only send it once after the channel opens.
      // That would need an additional DataChannel which is reliable and ordered, otherwise the color could be dropped.
      sendMessage(channel, { type: 'peer-color', color: peer.color });
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

function renderPeer(peer: Peer): void {
  const { state, rtt, details } = peer.card;
  state.textContent = peer.pc.connectionState;
  details.Weg.textContent = peer.path ?? '–';
  details.Quaternion.textContent = peer.quaternion?.map((value) => value.toFixed(2)).join(' / ') ?? '–';
  details.Absolut.textContent = peer.absolute === undefined ? '–' : peer.absolute ? 'ja' : 'nein';
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
