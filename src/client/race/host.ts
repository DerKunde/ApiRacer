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
import { initPhysics } from './racePhysics';
import { MAX_RACERS, type DriverInput } from './raceView';
import { ThreeRaceView } from './threeRaceView';

/** Host = PC. Accepts an offer from every phone and keeps one PeerConnection per phone. */

// Peer card rows, in display order
const DETAILS = ['Weg', 'Bereit', 'Lenkwert', 'Gas', 'Bremse'] as const;
// Countdown before the race in seconds – the cars stand on the start grid meanwhile
const COUNTDOWN_SECONDS = 3;
// How long "Los!" stays on screen once the cars are released
const GO_MESSAGE_MS = 1000;
// The phone sends 60 inputs per second. This much silence = connection gone or phone asleep → release the pedals,
// or the car keeps driving with the last input until the DataChannel finally closes.
const INPUT_TIMEOUT_MS = 500;
const NEUTRAL_INPUT: DriverInput = { steering: 0, throttle: 0, brake: 0 };

// lobby: cars may drive around freely · countdown: cars stand on the grid · race: running
type RacePhase = 'lobby' | 'countdown' | 'race';

interface Peer {
  id: PeerId;
  // Missing for dev test players: they go through the same host logic, but have no phone behind them
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  reliableChannel?: RTCDataChannel;
  enqueue: (task: () => Promise<void>) => void;
  card: PeerCard<(typeof DETAILS)[number]>;
  // Button row below the card details – dev test players add their controls to it as well
  actions: HTMLElement;
  // Lobby only, for racers: takes the car away from someone who can't get ready (makeSpectator)
  spectateButton: HTMLButtonElement;
  // Dev test players: WASD radio and ready button – only shown while the player has a car
  racerControls?: HTMLElement[];
  color: string;
  // false = joined when the race was full, or made a spectator by the host → connected, but no car
  racer: boolean;
  // Set by the phone's ready button; only counts for racers
  ready: boolean;
  rttMs?: number;
  path?: string;
  pingTimer?: number;
  // Restarted with every input message, fires only once they stop (INPUT_TIMEOUT_MS)
  inputTimeout?: number;
  inputSeq: number;
  steerValue?: number;
  throttle?: number;
  brake?: number;
}

const log = createLogger(byId('log'));
const peerList = byId<HTMLUListElement>('peers');
const startButton = byId<HTMLButtonElement>('start-btn');
// Created in main() once the physics engine is loaded – before signaling, so no phone can join without it
let view: ThreeRaceView;

// Page the phone opens via QR code / link
const JOIN_PAGE = '/controller.html';
const peers = new Map<PeerId, Peer>();
let signaling: SignalingClient;
let iceServers: IceServer[] | undefined;
let phase: RacePhase = 'lobby';

async function main(): Promise<void> {
  await initPhysics();
  view = new ThreeRaceView(byId('race-view'));
  // Dynamic import behind the DEV check: this is what keeps the editor out of the production build
  if (import.meta.env.DEV) {
    const { addTrackEditor } = await import('./trackEditor');
    await addTrackEditor(view, byId('test-bar'));
  }

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
    case 'peer-rejoined':
      // Same player as before – its connection is restored by the phone (ICE restart or a new connection)
      log(`[${msg.peerId}] wieder mit dem Server verbunden`);
      break;
    case 'peer-left':
      removePeer(msg.peerId);
      break;
    case 'signal': {
      const peer = peers.get(msg.from);
      if (!peer?.pc) return;
      const { data } = msg;
      // The phone's old connection is gone for good (page reloaded, or it couldn't be restored)
      const pc = data.kind === 'description' && data.newConnection ? replaceConnection(peer) : peer.pc;
      log(`[${peer.id}] empfangen: ${data.kind === 'description' ? data.description.type : `ICE-Kandidat (${candidateType(data.candidate.candidate)})`}`);
      peer.enqueue(async () => {
        const reply = await applySignal(pc, data);
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

/** Everything a new player needs on the host, with or without a connection. */
function createPeer(id: PeerId, pc?: RTCPeerConnection): Peer {
  // Same color for the car and its card, so you can tell which card belongs to which car
  const color = nextPeerColor();
  const card = createPeerCard(peerList, id, color, DETAILS);
  // Only the first MAX_RACERS phones get a car; later ones stay connected (card + log) without one.
  // No moving up when a racer leaves – keeps it simple until there is a real race start.
  const racer = countRacers() < MAX_RACERS;
  const actions = document.createElement('div');
  actions.className = 'peer-actions';
  const spectateButton = document.createElement('button');
  spectateButton.textContent = 'Zum Zuschauer';
  spectateButton.title = 'Auto wegnehmen – für einen Fahrer, der nicht bereit werden kann und so den Start blockiert';
  actions.append(spectateButton);
  card.root.append(actions);
  const peer: Peer = {
    id, pc, card, actions, spectateButton, color, racer, ready: false,
    enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), inputSeq: 0,
  };
  spectateButton.addEventListener('click', () => makeSpectator(peer));
  peers.set(id, peer);
  renderPeer(peer);
  // A new racer isn't ready yet → locks the start again
  updateStartButton();
  if (racer) view.addPlayer(id, color);
  else log(`⚠️ Rennen voll (max. ${MAX_RACERS}) – ${id} schaut nur zu`);
  log(`[${id}] beigetreten`);
  return peer;
}

function addPeer(id: PeerId): void {
  const pc = new RTCPeerConnection(createRtcConfig(iceServers));
  setupConnection(createPeer(id, pc), pc);
}

/**
 * Same player, new connection: the old one can't be restored. The car, color and role stay; the phone gets them
 * again once the new reliable channel opens (setupReliableChannel).
 */
function replaceConnection(peer: Peer): RTCPeerConnection {
  window.clearInterval(peer.pingTimer);
  peer.pc?.close();
  const pc = new RTCPeerConnection(createRtcConfig(iceServers));
  peer.pc = pc;
  // The new connection counts its inputs from the start again (a reloaded page does)
  peer.inputSeq = 0;
  peer.rttMs = undefined;
  peer.path = undefined;
  // A reloaded phone isn't ready anymore – a phone that still is says so again on the new channel
  if (peer.ready) setReady(peer, false);
  setupConnection(peer, pc);
  renderPeer(peer);
  log(`[${peer.id}] neue Verbindung`);
  return pc;
}

function setupConnection(peer: Peer, pc: RTCPeerConnection): void {
  const { id } = peer;
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
  // Not for a replaced connection: its channel may only close once the new one's ping is running
  channel.onclose = () => {
    if (peer.channel === channel) window.clearInterval(peer.pingTimer);
  };

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
        // Before the seq check: a late message still proves the phone is there
        window.clearTimeout(peer.inputTimeout);
        peer.inputTimeout = window.setTimeout(() => applyInput(peer, NEUTRAL_INPUT), INPUT_TIMEOUT_MS);
        if (msg.seq > peer.inputSeq) {
          peer.inputSeq = msg.seq;
          applyInput(peer, { steering: msg.steering, throttle: msg.throttle, brake: msg.brake });
        }
        break;
    }
  };
}

function applyInput(peer: Peer, input: DriverInput): void {
  peer.steerValue = input.steering;
  peer.throttle = input.throttle;
  peer.brake = input.brake;
  // Spectators have no car – the view ignores unknown IDs
  view.updateInput(peer.id, carInput(peer));
  renderPeer(peer);
}

// The card always shows what the phone sends (the player sees it works), but during the countdown the car stands still
function carInput(peer: Peer): DriverInput {
  if (phase === 'countdown') return NEUTRAL_INPUT;
  return { steering: peer.steerValue ?? 0, throttle: peer.throttle ?? 0, brake: peer.brake ?? 0 };
}

// Applies to every car right away, not only with its next input – a test player sends nothing while no key changes.
// renderPeer: the lobby-only buttons on the cards go away.
function setPhase(next: RacePhase): void {
  phase = next;
  for (const peer of peers.values()) {
    view.updateInput(peer.id, carInput(peer));
    renderPeer(peer);
  }
}

function setupReliableChannel(peer: Peer, channel: RTCDataChannel): void {
  peer.reliableChannel = channel;

  channel.onopen = () => {
    log(`[${peer.id}] zuverlässiger DataChannel offen`);
    sendMessage(channel, { type: 'peer-color', color: peer.color });
    // Everything the phone has missed until now: its role, and whether the lobby is already over – a phone that
    // joins during the countdown or the race, or whose channel only opens then, never got the race-start
    sendMessage(channel, { type: 'role', racer: peer.racer });
    if (phase !== 'lobby') sendMessage(channel, { type: 'race-start' });
  };
  channel.onclose = () => log(`[${peer.id}] zuverlässiger DataChannel geschlossen`);
  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    // Only racers count for the start – e.g. a message sent just before the host made the phone a spectator
    if (msg.type === 'ready' && peer.racer) setReady(peer, msg.ready);
  };
}

function setReady(peer: Peer, ready: boolean): void {
  peer.ready = ready;
  log(`[${peer.id}] ${ready ? 'bereit' : 'nicht mehr bereit'}`);
  renderPeer(peer);
  updateStartButton();
}

/**
 * Lobby only: takes the car away from a racer who can't get ready – no motion sensors, sensor permission denied, or
 * simply away. Otherwise that one racer blocks the start for everyone. The phone stays connected as a spectator.
 */
function makeSpectator(peer: Peer): void {
  if (!peer.racer || phase !== 'lobby') return;
  peer.racer = false;
  peer.ready = false;
  view.removePlayer(peer.id);
  sendMessage(peer.reliableChannel, { type: 'role', racer: false });
  log(`[${peer.id}] ist jetzt Zuschauer`);
  renderPeer(peer);
  // Maybe the last one who wasn't ready → the start unlocks
  updateStartButton();
}

/** Racers that are ready and racers in total – spectators don't count, they have no car. */
function countReady(): { ready: number; total: number } {
  const racers = [...peers.values()].filter((peer) => peer.racer);
  return { ready: racers.filter((peer) => peer.ready).length, total: racers.length };
}

/** Start is only possible with at least one racer and once all of them are ready (or made spectators). */
function updateStartButton(): void {
  if (phase !== 'lobby') return;
  const { ready, total } = countReady();
  startButton.disabled = total === 0 || ready < total;
  byId('ready-count').textContent = total === 0 ? 'Warte auf Fahrer …' : `${ready}/${total} bereit`;
}

startButton.addEventListener('click', () => void startRace());

async function startRace(): Promise<void> {
  startButton.disabled = true;
  // Spectators get it too, so every phone knows the lobby is over
  for (const peer of peers.values()) sendMessage(peer.reliableChannel, { type: 'race-start' });
  setPhase('countdown');
  // Everyone back on the grid, also whoever drove around in the lobby
  view.resetCars();
  byId('ready-count').textContent = 'Countdown …';
  log('🚦 Countdown');
  for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
    view.showBanner(String(n));
    await delay(1000);
  }

  // Released with whatever the players hold right now – flooring it during the countdown is allowed
  setPhase('race');
  byId('ready-count').textContent = 'Rennen läuft';
  view.showBanner('Los!');
  log('🏁 Rennen gestartet');
  await delay(GO_MESSAGE_MS);
  view.showBanner(undefined);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function refreshPath(peer: Peer): Promise<void> {
  if (!peer.pc) return;
  const path = await getConnectionPath(peer.pc);
  peer.path = path ? describePath(path) : undefined;
  renderPeer(peer);
}

function renderPeer(peer: Peer): void {
  const { state, rtt, details } = peer.card;
  state.textContent = peer.pc?.connectionState ?? 'Test-Spieler';
  details.Weg.textContent = peer.path ?? '–';
  details.Bereit.textContent = peer.racer ? (peer.ready ? 'ja' : 'nein') : '–';
  details.Lenkwert.textContent = peer.racer ? (peer.steerValue?.toFixed(2) ?? 'nA') : 'Zuschauer';
  details.Gas.textContent = peer.racer ? (peer.throttle?.toFixed(2) ?? 'nA') : '–';
  details.Bremse.textContent = peer.racer ? (peer.brake?.toFixed(2) ?? 'nA') : '–';
  // Empty until the first pong → CSS hides it together with its "·" separator (.peer-rtt:empty)
  rtt.textContent = peer.rttMs === undefined ? '' : `${peer.rttMs.toFixed(1)} ms`;
  peer.spectateButton.hidden = !peer.racer || phase !== 'lobby';
  for (const control of peer.racerControls ?? []) control.hidden = !peer.racer;
}

function removePeer(id: PeerId): void {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearInterval(peer.pingTimer);
  window.clearTimeout(peer.inputTimeout);
  peer.pc?.close();
  peer.card.root.remove();
  if (peer.racer) view.removePlayer(id);
  peers.delete(id);
  log(`[${id}] hat den Raum verlassen`);
  // If the last one who wasn't ready leaves, everyone left is ready
  updateStartButton();
}

// Dev-only test players: test the lobby and the race without real phones. They are normal entries in peers, only
// without a connection, so the host treats them like phones. The buttons on their card replace the phone.
function addTestButtons(): void {
  // The test player that WASD drives
  let controlled: Peer | undefined;
  let nextTestId = 1;

  const takeControl = (peer: Peer): void => {
    // Release the pedals of the previous one, or it would keep driving with the last input
    if (controlled) applyInput(controlled, NEUTRAL_INPUT);
    controlled = peer;
    sendKeyboardInput();
  };

  const addButton = document.createElement('button');
  addButton.textContent = '+ Test-Spieler';
  addButton.addEventListener('click', () => {
    const peer = createPeer(`test-${nextTestId++}`);

    // Spectators have no car to drive and can't get ready, same as on the host's count
    if (peer.racer) {
      // Same name = the browser keeps only one of them checked
      const controlRadio = document.createElement('input');
      controlRadio.type = 'radio';
      controlRadio.name = 'test-control';
      controlRadio.addEventListener('change', () => takeControl(peer));
      // Ready to drive right away if WASD drives nothing yet – or only a spectator, whose radio is hidden
      if (!controlled?.racer) {
        controlRadio.checked = true;
        takeControl(peer);
      }
      const controlLabel = document.createElement('label');
      controlLabel.append(controlRadio, ' Steuern');

      const readyButton = document.createElement('button');
      readyButton.textContent = 'Bereit';
      readyButton.addEventListener('click', () => {
        setReady(peer, !peer.ready);
        readyButton.textContent = peer.ready ? '✅ Bereit' : 'Bereit';
      });
      // In front of "Zum Zuschauer"; renderPeer hides them once the player is a spectator
      peer.actions.prepend(controlLabel, readyButton);
      peer.racerControls = [controlLabel, readyButton];
    }
    const removeButton = document.createElement('button');
    removeButton.textContent = 'Entfernen';
    removeButton.addEventListener('click', () => {
      if (controlled === peer) controlled = undefined;
      removePeer(peer.id);
    });
    peer.actions.append(removeButton);
  });

  // KeyboardEvent.code = physical key, independent of layout and caps lock.
  const pressed = new Set<string>();
  const sendKeyboardInput = (): void => {
    if (!controlled) return;
    applyInput(controlled, {
      steering: Number(pressed.has('KeyD')) - Number(pressed.has('KeyA')),
      throttle: Number(pressed.has('KeyW')),
      brake: Number(pressed.has('KeyS')),
    });
  };
  window.addEventListener('keydown', (e) => {
    pressed.add(e.code);
    sendKeyboardInput();
  });
  window.addEventListener('keyup', (e) => {
    pressed.delete(e.code);
    sendKeyboardInput();
  });
  // The keyup never arrives when the window loses focus while a key is held – the car would keep driving
  window.addEventListener('blur', () => {
    pressed.clear();
    sendKeyboardInput();
  });

  const testBar = document.createElement('p');
  testBar.className = 'test-buttons';
  testBar.id = 'test-bar';
  testBar.append(addButton);
  byId('race-view').before(testBar);
}

// import.meta.env.DEV is replaced by `false` in the production build, so the test buttons are stripped there.
if (import.meta.env.DEV) addTestButtons();

main().catch((err: unknown) => log(`❌ ${String(err)}`));
