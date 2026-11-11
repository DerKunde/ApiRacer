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
// Header of the peer card: the WebRTC connection state. When it breaks, the overlay over the card explains more.
const CONNECTION_STATE_TEXT: Record<RTCPeerConnectionState, string> = {
  new: 'verbindet …',
  connecting: 'verbindet …',
  connected: 'verbunden',
  disconnected: 'unterbrochen',
  failed: 'fehlgeschlagen',
  closed: 'getrennt',
};

/** Covers a peer card while its connection is broken (renderOverlay). */
interface ConnectionOverlay {
  root: HTMLElement;
  title: HTMLElement;
  detail: HTMLElement;
  // Shrinks until the slot is freed – only while the phone is away from the server (setAway)
  countdownBar: HTMLElement;
}

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
  // Dev test players: their ready button, which renderPeer labels from peer.ready
  testReadyButton?: HTMLButtonElement;
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
  // The inputs stopped (inputTimeout fired): the phone isn't sending anymore, even if the WebRTC connection still
  // says 'connected' – it only notices a dead path after a few seconds
  inputsStopped?: boolean;
  // Lost its server connection ('peer-away'): its slot is kept until then (performance.now() time), the overlay counts
  // down. undefined = not away.
  awayUntil?: number;
  awayTimer?: number;
  overlay: ConnectionOverlay;
  // The phone can't drive right now (updateInterrupted). The overlay shows it, and in the lobby it takes back the
  // ready state: ready means "I'm here", so after an interruption the player confirms it again.
  interrupted: boolean;
  inputSeq: number;
  steerValue?: number;
  throttle?: number;
  brake?: number;
}

const log = createLogger(byId('log'));
const peerList = byId<HTMLUListElement>('peers');
const startButton = byId<HTMLButtonElement>('start-btn');
const endButton = byId<HTMLButtonElement>('end-btn');
// Created in main() once the physics engine is loaded – before signaling, so no phone can join without it
let view: ThreeRaceView;

// Page the phone opens via QR code / link
const JOIN_PAGE = '/controller.html';
const peers = new Map<PeerId, Peer>();
let signaling: SignalingClient;
let iceServers: IceServer[] | undefined;
let phase: RacePhase = 'lobby';
// Counts the started races: a countdown whose race was ended meanwhile stops (startRace)
let raceRun = 0;

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
    case 'peer-away': {
      const peer = peers.get(msg.peerId);
      if (peer) setAway(peer, msg.graceMs);
      log(`[${msg.peerId}] Verbindung verloren – Platz bleibt ${Math.round(msg.graceMs / 1000)} s reserviert`);
      break;
    }
    case 'peer-rejoined': {
      // Same player as before – its connection is restored by the phone (ICE restart or a new connection)
      const peer = peers.get(msg.peerId);
      // Stays interrupted until its inputs arrive again (updateInterrupted)
      if (peer) setAway(peer, undefined);
      log(`[${msg.peerId}] ✅ wieder da`);
      break;
    }
    case 'peer-left':
      removePeer(msg.peerId, msg.reason === 'left' ? 'hat den Raum verlassen' : 'ist nicht zurückgekommen');
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
  const overlay = createConnectionOverlay();
  card.root.append(actions, overlay.root);
  const peer: Peer = {
    id, pc, card, actions, spectateButton, color, racer, ready: false,
    enqueue: createQueue((err) => log(`❌ [${id}] ${String(err)}`)), inputSeq: 0,
    overlay, interrupted: false,
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
  // The old connection is gone: interrupted until the first input arrives over the new one. Its input timeout would
  // have released the pedals – it's cancelled here, so release them now, or the car keeps driving with the last input.
  window.clearTimeout(peer.inputTimeout);
  peer.inputsStopped = true;
  applyInput(peer, NEUTRAL_INPUT);
  setInterrupted(peer, true);
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
    updateInterrupted(peer);
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
        flashCard(peer);
        break;
      case 'input':
        // Before the seq check: a late message still proves the phone is there
        window.clearTimeout(peer.inputTimeout);
        peer.inputTimeout = window.setTimeout(() => {
          peer.inputsStopped = true;
          updateInterrupted(peer);
          applyInput(peer, NEUTRAL_INPUT);
        }, INPUT_TIMEOUT_MS);
        if (peer.inputsStopped) {
          peer.inputsStopped = false;
          updateInterrupted(peer);
        }
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
  startButton.hidden = phase !== 'lobby';
  endButton.hidden = phase === 'lobby';
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
    // Everything the phone has missed until now: its role, its ready state, and whether the lobby is already over –
    // a phone that joins during the countdown or the race, or whose channel only opens then, never got the race-start
    sendMessage(channel, { type: 'role', racer: peer.racer });
    sendMessage(channel, { type: 'ready-state', ready: peer.ready });
    if (phase !== 'lobby') sendMessage(channel, { type: 'race-start' });
  };
  channel.onclose = () => log(`[${peer.id}] zuverlässiger DataChannel geschlossen`);
  channel.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ChannelMessage;
    if (msg.type !== 'ready') return;
    // Only racers count for the start – e.g. a message sent just before the host made the phone a spectator
    if (peer.racer) setReady(peer, msg.ready);
    // Answered either way: until the answer arrives, the phone shows the request as on its way
    sendMessage(channel, { type: 'ready-state', ready: peer.ready, seq: msg.seq });
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
  sendMessage(peer.reliableChannel, { type: 'ready-state', ready: false });
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
  const run = ++raceRun;
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
    // Ended during the countdown (endRace)
    if (run !== raceRun) return;
  }

  // Released with whatever the players hold right now – flooring it during the countdown is allowed
  setPhase('race');
  byId('ready-count').textContent = 'Rennen läuft';
  view.showBanner('Los!');
  log('🏁 Rennen gestartet');
  await delay(GO_MESSAGE_MS);
  if (run === raceRun) view.showBanner(undefined);
}

endButton.addEventListener('click', endRace);

/**
 * Back to the lobby, also during the countdown: every racer gets ready again for the next race. The cars stay where
 * they are and may drive around freely until the next start puts them back on the grid.
 */
function endRace(): void {
  if (phase === 'lobby') return;
  // Stops a countdown that is still running
  raceRun++;
  view.showBanner(undefined);
  for (const peer of peers.values()) {
    peer.ready = false;
    sendMessage(peer.reliableChannel, { type: 'race-end' });
    sendMessage(peer.reliableChannel, { type: 'ready-state', ready: false });
  }
  // Renders every card with the reset ready state and the lobby-only buttons
  setPhase('lobby');
  updateStartButton();
  log('🏁 Rennen beendet – zurück in der Lobby');
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

function flashCard(peer: Peer): void {
  peer.card.root.classList.remove('flash');
  void peer.card.root.offsetWidth; // restart the animation
  peer.card.root.classList.add('flash');
}

function createConnectionOverlay(): ConnectionOverlay {
  const root = document.createElement('div');
  root.className = 'connection-overlay';
  // Read out by screen readers when it appears or its text changes
  root.setAttribute('role', 'status');
  root.hidden = true;
  const title = document.createElement('strong');
  const detail = document.createElement('p');
  const countdownBar = document.createElement('div');
  countdownBar.className = 'countdown-bar';
  countdownBar.append(document.createElement('span'));
  root.append(title, detail, countdownBar);
  return { root, title, detail, countdownBar };
}

/**
 * graceMs: the phone lost its server connection, the overlay counts down until its slot is freed. undefined: back
 * again. Its car stays meanwhile – the pedals were already released by the input timeout.
 */
function setAway(peer: Peer, graceMs: number | undefined): void {
  window.clearInterval(peer.awayTimer);
  peer.awayTimer = undefined;
  peer.awayUntil = graceMs === undefined ? undefined : performance.now() + graceMs;
  if (graceMs !== undefined) {
    peer.awayTimer = window.setInterval(() => renderPeer(peer), 1000);
    // The bar runs on its own as a CSS animation; restarted for every 'peer-away'
    const bar = peer.overlay.countdownBar.firstElementChild as HTMLElement;
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `countdown ${graceMs}ms linear forwards`;
  }
  updateInterrupted(peer);
  renderPeer(peer);
}

/**
 * Recomputes peer.interrupted after every change it depends on: connection state, inputs stopped or arriving again,
 * away from the server. Interrupted = away from the server and silent on WebRTC too, or the WebRTC connection broke
 * and the phone is restoring it. Only the server gone while the inputs still arrive doesn't count: the car still
 * drives. Once interrupted, the phone is only back when its inputs arrive again – e.g. after a rejoin, it may still
 * be setting up a new connection (replaceConnection).
 */
function updateInterrupted(peer: Peer): void {
  const connection = peer.pc?.connectionState;
  const silentAway = peer.awayUntil !== undefined && (connection !== 'connected' || peer.inputsStopped === true);
  const broken = connection === 'disconnected' || connection === 'failed';
  const stillSilent = peer.interrupted && peer.inputsStopped === true;
  setInterrupted(peer, silentAway || broken || stillSilent);
}

function setInterrupted(peer: Peer, interrupted: boolean): void {
  if (interrupted === peer.interrupted) return;
  peer.interrupted = interrupted;
  if (interrupted) {
    // Lobby only: once the race runs, the ready state doesn't count anymore
    if (peer.ready && phase === 'lobby') {
      log(`[${peer.id}] Verbindung unterbrochen – muss sich erneut bereit melden`);
      setReady(peer, false);
      // A broken path: the reliable channel delivers it once the path works again. A replaced connection: its new
      // channel sends the ready state when it opens (setupReliableChannel).
      sendMessage(peer.reliableChannel, { type: 'ready-state', ready: false });
    }
  } else {
    // Back again: the card flashes, so the change is noticed
    flashCard(peer);
  }
  renderPeer(peer);
}

/** Covers the card while the phone is interrupted, and tells why. */
function renderOverlay(peer: Peer): void {
  const { overlay } = peer;
  const connection = peer.pc?.connectionState;
  const away = peer.interrupted && peer.awayUntil !== undefined;
  overlay.root.hidden = !peer.interrupted;
  overlay.countdownBar.hidden = !away;
  if (away) {
    const seconds = Math.max(0, Math.ceil((peer.awayUntil! - performance.now()) / 1000));
    overlay.title.textContent = '⚠️ Verbindung verloren';
    overlay.detail.textContent = `Platz bleibt noch ${seconds} s reserviert`;
  } else if (connection === 'disconnected' || connection === 'failed') {
    overlay.title.textContent = '⚠️ Verbindung unterbrochen';
    overlay.detail.textContent = 'Das Handy stellt sie wieder her …';
  } else if (peer.interrupted) {
    overlay.title.textContent = '⚠️ Verbindung unterbrochen';
    overlay.detail.textContent = connection === 'connected' ? 'Warte auf das Handy …' : 'Neue Verbindung wird aufgebaut …';
  }
}

function stateText(peer: Peer): string {
  if (!peer.pc) return 'Test-Spieler';
  const text = CONNECTION_STATE_TEXT[peer.pc.connectionState];
  // Only the server connection is gone (e.g. server restart): the car still drives, no overlay
  return peer.awayUntil !== undefined && !peer.interrupted ? `${text} · ohne Server` : text;
}

function renderPeer(peer: Peer): void {
  const { state, rtt, details } = peer.card;
  // Overlay first: the header text depends on whether it's shown
  renderOverlay(peer);
  state.textContent = stateText(peer);
  details.Weg.textContent = peer.path ?? '–';
  details.Bereit.textContent = peer.racer ? (peer.ready ? 'ja' : 'nein') : '–';
  details.Lenkwert.textContent = peer.racer ? (peer.steerValue?.toFixed(2) ?? 'nA') : 'Zuschauer';
  details.Gas.textContent = peer.racer ? (peer.throttle?.toFixed(2) ?? 'nA') : '–';
  details.Bremse.textContent = peer.racer ? (peer.brake?.toFixed(2) ?? 'nA') : '–';
  // Empty until the first pong → CSS hides it together with its "·" separator (.peer-rtt:empty)
  rtt.textContent = peer.rttMs === undefined ? '' : `${peer.rttMs.toFixed(1)} ms`;
  peer.spectateButton.hidden = !peer.racer || phase !== 'lobby';
  for (const control of peer.racerControls ?? []) control.hidden = !peer.racer;
  if (peer.testReadyButton) peer.testReadyButton.textContent = peer.ready ? '✅ Bereit' : 'Bereit';
}

/** why: ends the log line, e.g. 'hat den Raum verlassen' */
function removePeer(id: PeerId, why = 'hat den Raum verlassen'): void {
  const peer = peers.get(id);
  if (!peer) return;
  window.clearInterval(peer.pingTimer);
  window.clearInterval(peer.awayTimer);
  window.clearTimeout(peer.inputTimeout);
  peer.pc?.close();
  peer.card.root.remove();
  if (peer.racer) view.removePlayer(id);
  peers.delete(id);
  log(`[${id}] ${why}`);
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
      readyButton.addEventListener('click', () => setReady(peer, !peer.ready));
      // In front of "Zum Zuschauer"; renderPeer hides them once the player is a spectator
      peer.actions.prepend(controlLabel, readyButton);
      peer.racerControls = [controlLabel, readyButton];
      peer.testReadyButton = readyButton;
      renderPeer(peer);
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
