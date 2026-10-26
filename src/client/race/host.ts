import '../../style.css';
import type { ChannelMessage, IceServer, PeerId, ServerMessage } from '../../shared/protocol';
import {
  applySignal,
  candidateType,
  CONTROL_CHANNEL_LABEL,
  createQueue,
  createRtcConfig,
  describePath,
  getConnectionPath,
  RELIABLE_CHANNEL_LABEL,
  sendMessage,
} from '../common/rtc';
import { SignalingClient } from '../common/signaling';
import { byId, createLogger, hasWebRtcSupport } from '../common/ui';
import { buildJoinURLs, createJoinOption, createPeerCard, nextPeerColor, type PeerCard } from '../common/hostDashboard';
import { MAX_RACERS, type RaceView } from './raceView';
import { ThreeRaceView } from './threeRaceView';

/** Host = PC. Accepts an offer from every phone and keeps one PeerConnection per phone. */

// Peer card rows, in display order
const DETAILS = ['Weg', 'Bereit', 'Lenkwert', 'Gas', 'Bremse'] as const;

interface Peer {
  id: PeerId;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  reliableChannel?: RTCDataChannel;
  enqueue: (task: () => Promise<void>) => void;
  card: PeerCard<(typeof DETAILS)[number]>;
  color: string;
  // false = joined when the race was full → connected, but no car
  racer: boolean;
  // Set by the phone's ready button; only counts for racers
  ready: boolean;
  rttMs?: number;
  path?: string;
  pingTimer?: number;
  inputSeq: number;
  steerValue?: number;
  throttle?: number;
  brake?: number;
}

const log = createLogger(byId('log'));
const peerList = byId<HTMLUListElement>('peers');
const startButton = byId<HTMLButtonElement>('start-btn');
const view: RaceView = new ThreeRaceView(byId('race-view'));

// Page the phone opens via QR code / link
const JOIN_PAGE = '/controller.html';
const peers = new Map<PeerId, Peer>();
let signaling: SignalingClient;
let iceServers: IceServer[] | undefined;
let raceStarted = false;

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
  // Same color for the car and its card, so you can tell which card belongs to which car
  const color = nextPeerColor();
  const card = createPeerCard(peerList, id, color, DETAILS);
  // Only the first MAX_RACERS phones get a car; later ones stay connected (card + log) without one.
  // No moving up when a racer leaves – keeps it simple until there is a real race start.
  const racer = countRacers() < MAX_RACERS;
  const peer: Peer = { id, pc, card, color, racer, ready: false, enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), inputSeq: 0 };
  peers.set(id, peer);
  renderPeer(peer);
  // A new racer isn't ready yet → locks the start again
  updateStartButton();
  if (racer) view.addPlayer(id, color);
  else log(`⚠️ Rennen voll (max. ${MAX_RACERS}) – ${id} schaut nur zu`);
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
  pc.ondatachannel = ({ channel }) => {
    switch(channel.label) {
      case CONTROL_CHANNEL_LABEL:
        setupChannel(peer, channel);
        break;
      case RELIABLE_CHANNEL_LABEL:
        setupReliableChannel(peer, channel);
        break;
      default:
        log(`[${id}] unbekannter DataChannel: ${channel.label}`);
    }
  };
}

function countRacers(): number {
  return [...peers.values()].filter((peer) => peer.racer).length;
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
        peer.card.root.classList.remove('flash');
        void peer.card.root.offsetWidth; // restart the animation
        peer.card.root.classList.add('flash');
        break;
      case 'input':
        if (msg.seq > peer.inputSeq) {
          peer.inputSeq = msg.seq;
          peer.steerValue = msg.steering;
          peer.throttle = msg.throttle;
          peer.brake = msg.brake;
          // Spectators have no car – the view ignores unknown IDs
          view.updateSteering(peer.id, msg.steering);
          renderPeer(peer);
        }
        break;
    }
  };
}

function setupReliableChannel(peer: Peer, channel: RTCDataChannel): void {
  peer.reliableChannel = channel;

  channel.onopen = () => {
    log(`[${peer.id}] zuverlässiger DataChannel offen`);
    sendMessage(channel, { type: 'peer-color', color: peer.color });
  };
  channel.onclose = () => log(`[${peer.id}] zuverlässiger DataChannel geschlossen`);
  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    if (msg.type === 'ready') {
      peer.ready = msg.ready;
      log(`[${peer.id}] ${msg.ready ? 'bereit' : 'nicht mehr bereit'}`);
      renderPeer(peer);
      updateStartButton();
    }
  };
}

/** Racers that are ready and racers in total – spectators don't count, they have no car. */
function countReady(): { ready: number; total: number } {
  const racers = [...peers.values()].filter((peer) => peer.racer);
  return { ready: racers.filter((peer) => peer.ready).length, total: racers.length };
}

/** Start is only possible with at least one racer and once all of them are ready. */
function updateStartButton(): void {
  if (raceStarted) return;
  const { ready, total } = countReady();
  startButton.disabled = total === 0 || ready < total;
  byId('ready-count').textContent = total === 0 ? 'Warte auf Fahrer …' : `${ready}/${total} bereit`;
}

startButton.addEventListener('click', () => {
  raceStarted = true;
  startButton.disabled = true;
  byId('ready-count').textContent = 'Rennen läuft';
  // Spectators get it too, so every phone knows the lobby is over
  for (const peer of peers.values()) sendMessage(peer.reliableChannel, { type: 'race-start' });
  log('🏁 Rennen gestartet');
});

async function refreshPath(peer: Peer): Promise<void> {
  const path = await getConnectionPath(peer.pc);
  peer.path = path ? describePath(path) : undefined;
  renderPeer(peer);
}

function renderPeer(peer: Peer): void {
  const { state, rtt, details } = peer.card;
  state.textContent = peer.pc.connectionState;
  details.Weg.textContent = peer.path ?? '–';
  details.Bereit.textContent = peer.racer ? (peer.ready ? 'ja' : 'nein') : '–';
  details.Lenkwert.textContent = peer.racer ? (peer.steerValue?.toFixed(2) ?? 'nA') : 'Zuschauer';
  details.Gas.textContent = peer.racer ? (peer.throttle?.toFixed(2) ?? 'nA') : '–';
  details.Bremse.textContent = peer.racer ? (peer.brake?.toFixed(2) ?? 'nA') : '–';
  // Empty until the first pong → CSS hides it together with its "·" separator (.peer-rtt:empty)
  rtt.textContent = peer.rttMs === undefined ? '' : `${peer.rttMs.toFixed(1)} ms`;
}

function removePeer(id: PeerId): void {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearInterval(peer.pingTimer);
  peer.pc.close();
  peer.card.root.remove();
  if (peer.racer) view.removePlayer(id);
  peers.delete(id);
  log(`[${id}] hat den Raum verlassen`);
  // If the last one who wasn't ready leaves, everyone left is ready
  updateStartButton();
}

// Dev-only test buttons: add/remove fake players without real phones, to check the split screen.
// They only talk to the view – no WebRTC, no peer card.
function addTestButtons(): void {
  const testIds: PeerId[] = [];
  let nextTestId = 1;

  const addButton = document.createElement('button');
  addButton.textContent = '+ Test-Spieler';
  addButton.addEventListener('click', () => {
    // The view ignores players beyond MAX_RACERS – don't keep IDs that the "−" button could then "remove"
    if (testIds.length >= MAX_RACERS) return;
    const id = `test-${nextTestId++}`;
    testIds.push(id);
    view.addPlayer(id, nextPeerColor());
    // Random steering value, so the turned front wheels are visible
    view.updateSteering(id, Math.random() * 2 - 1);
  });

  const removeButton = document.createElement('button');
  removeButton.textContent = '− Test-Spieler';
  removeButton.addEventListener('click', () => {
    // Removes a random one, so moving up after removing from the middle gets tested too
    const [id] = testIds.splice(Math.floor(Math.random() * testIds.length), 1);
    if (id != null) view.removePlayer(id);
  });

  const testBar = document.createElement('p');
  testBar.className = 'test-buttons';
  testBar.append(addButton, removeButton);
  byId('race-view').before(testBar);
}

// import.meta.env.DEV is replaced by `false` in the production build, so the test buttons are stripped there.
if (import.meta.env.DEV) addTestButtons();

main().catch((err: unknown) => log(`❌ ${String(err)}`));
