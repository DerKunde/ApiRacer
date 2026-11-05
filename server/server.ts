import type { AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST_ID, type ClientMessage, type IceServer, type PeerId, type ServerMessage, type SignalData } from '../src/shared/protocol';
import { createHmac, randomUUID } from 'node:crypto';

// ws 8.22 (package.json asks for at least that) has this option, @types/ws 8.18 doesn't know it yet
declare module 'ws' {
  namespace WebSocket {
    interface ServerOptions {
      closeTimeout?: number;
    }
  }
}

/**
 * Signaling server: only brokers the connection setup (offer/answer/ICE).
 * Once the WebRTC connection is up, no game traffic goes through here anymore.
 */

const PORT = Number(process.env.PORT ?? 3001);
// Loopback only: clients never connect directly, they always go through a reverse proxy
// (Vite dev server locally, Caddy on the VPS).
const HOST = '127.0.0.1';
// Set in the systemd unit on the VPS. LAN addresses are only needed when playing locally.
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 (easily confused)
// Room codes have 4 characters, peer IDs are "host" or "p<n>": anything longer is no ID. Also caps what the
// error messages echo back ("Raum … nicht gefunden").
const MAX_ID_LENGTH = 16;
// Session tokens are UUIDs (36 characters)
const MAX_SESSION_TOKEN_LENGTH = 36;

// Limits against scripts. Real clients stay far below them: the join form opens a new socket for every code, and
// after the connection setup a socket is silent.
// Wrong room codes per socket, then it is closed: guessing codes over one connection is no longer possible
const MAX_FAILED_JOINS = 5;
// Phones per room, racers and spectators together: a script could otherwise send thousands, and the host browser
// would set up a PeerConnection for each of them
const MAX_CONTROLLERS_PER_ROOM = 16;
// Messages per socket as a token bucket: up to MESSAGE_BURST at once, then MESSAGE_RATE per second
const MESSAGE_BURST = 100;
const MESSAGE_RATE = 20;
// On top for the host, per phone in its room: it sends each phone an answer and all its ICE candidates, on a PC with
// several network adapters and TURN 8–15 of them. Several phones can need that at the same moment (joining, ICE
// restart after a Wi-Fi dropout), and closing the host's socket would end the room for every phone.
const MESSAGE_BURST_PER_PHONE = 40;
// Open sockets in total. Every limit above is per socket and starts fresh on a new one, and a script can open as many
// as it likes: this caps what all of them together hold. It also caps the rooms (each one needs its host socket), so
// createRoomId always finds a free code right away (at most 500 of 32^4 codes taken).
const MAX_CONNECTIONS = 500;
// Time a socket has to create or join a room. The pages send that right after connecting. Without it a socket that
// never joins, or stays after a wrong code (the join form opens a new one for the next code), would stay open forever.
const JOIN_TIMEOUT_MS = 10_000;
// Time a closed socket has to answer the close frame, then the server drops it. ws waits 30 s by default: a script
// that never answers would keep its room and its place under MAX_CONNECTIONS that long. A real browser answers at once.
const CLOSE_TIMEOUT_MS = 2000;
// Close codes (RFC 6455): done, nothing wrong / a client that breaks the rules
const NORMAL_CLOSURE = 1000;
const POLICY_VIOLATION = 1008;

// Only the own pages may connect in production. Keeps other websites out – scripts can still fake the origin.
const ALLOWED_ORIGIN = 'https://stud.messy-desk-studio.de';
const TURN_URLS = process.env.TURN_URLS?.split(',');
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_CREDENTIAL_TTL_S = 12 * 60 * 60;
// How long a phone's slot stays reserved after its connection broke (screen locked, network switch, reload).
// Not much longer: until then the host keeps the player, so a racer who really left blocks the start meanwhile.
const REJOIN_GRACE_MS = 30000;

/** A phone in a room. */
interface Controller {
  /** undefined while the phone is away: the slot stays reserved for a rejoin until releaseTimer fires */
  ws: WebSocket | undefined;
  /** Secret the phone got with 'joined': lets it take this slot back after losing the connection. */
  sessionToken: string;
  releaseTimer?: NodeJS.Timeout;
}

interface Room {
  id: string;
  host: WebSocket;
  // The host socket's limits: every phone that joins adds to its bucket
  hostLimits: Limits;
  controllers: Map<PeerId, Controller>;
  nextPeerNumber: number;
}

/** Which room does a socket belong to, and what is its peer ID there? */
interface Membership {
  room: Room;
  peerId: PeerId;
}

/** Per socket, lives as long as the socket */
interface Limits {
  failedJoins: number;
  // Token bucket: every message takes one, they refill with MESSAGE_RATE per second
  tokens: number;
  refilledAt: number;
}

const rooms = new Map<string, Room>();
const memberships = new Map<WebSocket, Membership>();

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function createRoomId(): string {
  let id: string;
  do {
    id = Array.from(
      { length: 4 },
      () => ROOM_ID_ALPHABET[Math.floor(Math.random() * ROOM_ID_ALPHABET.length)],
    ).join('');
  } while (rooms.has(id));
  return id;
}

/**
 * Creates the TURN entry for `peerId` with time-limited credentials
 * (TURN REST API scheme, coturn `use-auth-secret`):
 * - username: `"<expiry as unix seconds>:<peerId>"`
 * - credential: `base64(HMAC-SHA1(secret, username))`
 *
 * coturn recomputes the HMAC with the same secret, so the secret itself never leaves the VPS.
 *
 * @returns `undefined` when TURN is not configured (local dev).
 * @see https://github.com/coturn/coturn/wiki/turnserver#turn-rest-api
 */
function createTurnIceServer(peerId: PeerId): IceServer | undefined {
  if (TURN_SECRET != undefined && TURN_URLS != undefined) {
    const username = `${Math.floor((Date.now() / 1000)) + TURN_CREDENTIAL_TTL_S}:${peerId}`;
    const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return { urls: TURN_URLS, username, credential };
  }
  return undefined;
}

/** This machine's IPv4 addresses on the local network – the host builds the join link from them. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter(
      (iface): iface is NetworkInterfaceInfo =>
        iface !== undefined &&
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('169.254.'),
    )
    .map((iface) => iface.address);
}

// Every join that doesn't get the socket into a room counts as a wrong code. Also "Raum voll": otherwise it would
// confirm that a code exists without using up the guesses.
function failJoin(ws: WebSocket, limits: Limits, message: string): void {
  send(ws, { type: 'error', message });
  if (++limits.failedJoins >= MAX_FAILED_JOINS) {
    ws.close(POLICY_VIOLATION, 'Zu viele falsche Raumcodes');
    console.log(`Verbindung nach ${MAX_FAILED_JOINS} falschen Raumcodes geschlossen`);
  }
}

function handleMessage(ws: WebSocket, msg: ClientMessage, limits: Limits): void {
  const membership = memberships.get(ws);

  switch (msg.type) {
    case 'create-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const turn = createTurnIceServer(HOST_ID);
      const room: Room = { id: createRoomId(), host: ws, hostLimits: limits, controllers: new Map(), nextPeerNumber: 1 };
      rooms.set(room.id, room);
      memberships.set(ws, { room, peerId: HOST_ID });
      send(ws, { type: 'room-created', roomId: room.id, lanAddresses: IS_PRODUCTION ? undefined : lanAddresses(), iceServers: turn ? [turn] : undefined });
      console.log(`Raum ${room.id} erstellt`);
      return;
    }

    case 'join-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const room = rooms.get(msg.roomId.trim().toUpperCase());
      if (!room) return failJoin(ws, limits, `Raum ${msg.roomId} nicht gefunden`);
      if (room.controllers.size >= MAX_CONTROLLERS_PER_ROOM) return failJoin(ws, limits, 'Raum voll');
      const peerId = `p${room.nextPeerNumber++}`;
      // Unguessable (crypto RNG): whoever holds the token can claim the slot. Never logged for the same reason.
      const sessionToken = randomUUID();
      const turn = createTurnIceServer(peerId);
      const hostBurstBefore = messageBurst(room.host);
      room.controllers.set(peerId, { ws, sessionToken });
      memberships.set(ws, { room, peerId });
      // What the host's bucket grew by is available right away, not only after the refill: the host answers the new
      // phone now. messageBurst stays the one place that says how much that is.
      room.hostLimits.tokens += messageBurst(room.host) - hostBurstBefore;
      send(ws, { type: 'joined', roomId: room.id, peerId, sessionToken, iceServers: turn ? [turn] : undefined });
      send(room.host, { type: 'peer-joined', peerId });
      console.log(`[${room.id}] ${peerId} beigetreten`);
      return;
    }

    case 'rejoin-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const room = rooms.get(msg.roomId.trim().toUpperCase());
      if (!room) return failJoin(ws, limits, `Raum ${msg.roomId} nicht gefunden`);
      const slot = [...room.controllers].find(([, controller]) => controller.sessionToken === msg.sessionToken);
      // Counts as a failed join too: otherwise tokens could be guessed over one connection without limit
      if (!slot) return failJoin(ws, limits, 'Sitzung abgelaufen – bitte neu beitreten');
      const [peerId, controller] = slot;
      clearTimeout(controller.releaseTimer);
      controller.releaseTimer = undefined;
      // The old connection still counts as open (dead connection not noticed yet, or a duplicated tab):
      // the newer one wins, the old one is dropped without its close counting as leaving
      if (controller.ws) {
        memberships.delete(controller.ws);
        send(controller.ws, { type: 'session-taken-over' });
        controller.ws.close();
      }
      controller.ws = ws;
      memberships.set(ws, { room, peerId });
      const turn = createTurnIceServer(peerId);
      send(ws, { type: 'joined', roomId: room.id, peerId, sessionToken: controller.sessionToken, iceServers: turn ? [turn] : undefined });
      send(room.host, { type: 'peer-rejoined', peerId });
      console.log(`[${room.id}] ${peerId} wieder verbunden`);
      return;
    }

    case 'signal': {
      if (!membership) return send(ws, { type: 'error', message: 'Nicht in einem Raum' });
      const { room, peerId } = membership;
      // Star topology: controllers only talk to the host, the host talks to all controllers
      const target =
        peerId === HOST_ID
          ? room.controllers.get(msg.to)?.ws
          : msg.to === HOST_ID
            ? room.host
            : undefined;
      // Also when the phone is away and its slot only reserved
      if (!target) return send(ws, { type: 'error', message: `Empfänger ${msg.to} nicht erreichbar` });
      send(target, { type: 'signal', from: peerId, data: msg.data });
      const detail =
        msg.data.kind === 'description'
          ? `${msg.data.description.type}${msg.data.newConnection ? ' (neue Verbindung)' : ''}`
          : 'ICE-Kandidat';
      console.log(`[${room.id}] ${peerId} → ${msg.to}: ${detail}`);
      return;
    }
  }
}

function handleClose(ws: WebSocket): void {
  const membership = memberships.get(ws);
  if (!membership) return;
  memberships.delete(ws);
  const { room, peerId } = membership;

  if (peerId === HOST_ID) {
    for (const controller of room.controllers.values()) {
      clearTimeout(controller.releaseTimer);
      if (!controller.ws) continue;
      send(controller.ws, { type: 'room-closed' });
      memberships.delete(controller.ws);
      // Without a room the socket is of no use anymore: the join screen opens a new one for the next code
      controller.ws.close(NORMAL_CLOSURE, 'Raum geschlossen');
    }
    rooms.delete(room.id);
    console.log(`Raum ${room.id} geschlossen`);
  } else {
    const controller = room.controllers.get(peerId);
    if (!controller) return;
    // Not gone yet: the phone may only have lost its connection. Its slot stays reserved for a rejoin with the
    // session token, and the host keeps the player meanwhile.
    controller.ws = undefined;
    controller.releaseTimer = setTimeout(() => {
      room.controllers.delete(peerId);
      send(room.host, { type: 'peer-left', peerId });
      console.log(`[${room.id}] ${peerId} nicht zurückgekommen – gegangen`);
    }, REJOIN_GRACE_MS);
    console.log(`[${room.id}] ${peerId} Verbindung verloren, Platz bleibt ${REJOIN_GRACE_MS / 1000} s reserviert`);
  }
}

// Arrays are objects too, but never a message or a part of one
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The host's bucket grows with its phones, see MESSAGE_BURST_PER_PHONE
function messageBurst(ws: WebSocket): number {
  const membership = memberships.get(ws);
  if (membership?.peerId !== HOST_ID) return MESSAGE_BURST;
  return MESSAGE_BURST + membership.room.controllers.size * MESSAGE_BURST_PER_PHONE;
}

// Refills the bucket for the time since the last message, then takes one token. false = bucket empty.
// performance.now() instead of Date.now(): a clock set back (NTP) would take tokens instead of adding them.
function takeToken(limits: Limits, burst: number): boolean {
  const now = performance.now();
  limits.tokens = Math.min(burst, limits.tokens + (now - limits.refilledAt) / 1000 * MESSAGE_RATE);
  limits.refilledAt = now;
  if (limits.tokens < 1) return false;
  limits.tokens--;
  return true;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH;
}

// Only the shape: the server relays SDP and candidates without reading them, the receiving browser parses them
function isSignalData(value: unknown): value is SignalData {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'description':
      return (
        isObject(value.description) &&
        ['offer', 'answer', 'pranswer', 'rollback'].includes(value.description.type as string) &&
        (value.description.sdp === undefined || typeof value.description.sdp === 'string')
      );
    case 'candidate':
      // The receiving page reads candidate.candidate as a string (candidateType in rtc.ts), it may be missing
      return (
        isObject(value.candidate) &&
        (value.candidate.candidate === undefined || typeof value.candidate.candidate === 'string')
      );
    default:
      return false;
  }
}

function isClientMessage(value: unknown): value is ClientMessage {
  if (!isObject(value)) return false;
  switch (value.type) {
    case 'create-room':
      return true;
    case 'join-room':
      return isId(value.roomId);
    case 'rejoin-room':
      return isId(value.roomId) && typeof value.sessionToken === 'string' && value.sessionToken.length <= MAX_SESSION_TOKEN_LENGTH;
    case 'signal':
      return isId(value.to) && isSignalData(value.data);
    default:
      return false;
  }
}

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  maxPayload: 64 * 1024,
  closeTimeout: CLOSE_TIMEOUT_MS,
  // accept() is called right away, so ws counts the socket in wss.clients in the same step: handshakes running in
  // parallel can't all slip past the check before one of them is counted
  verifyClient: ({ origin }: { origin: string }, accept: (result: boolean, code?: number, message?: string) => void) => {
    if (IS_PRODUCTION && origin !== ALLOWED_ORIGIN) return accept(false, 401);
    // 503: the page shows "Signaling-Server nicht erreichbar" instead of waiting for an answer that never comes
    if (wss.clients.size >= MAX_CONNECTIONS) return accept(false, 503, 'Server voll');
    accept(true);
  },
});

let listening = false;
// Only once the port is really open. With PORT=0 the OS picks a free one (the tests do that), printed here.
wss.on('listening', () => {
  listening = true;
  const { port } = wss.address() as AddressInfo;
  console.log(`Signaling-Server läuft auf ws://${HOST}:${port}`);
});
// Without a listener, the error event would end the process with a bare stack trace
wss.on('error', (error) => {
  // After the start, e.g. accepting a connection failed: ending the process would drop every room
  if (listening) {
    console.error(`Signaling-Server-Fehler: ${error.message}`);
    return;
  }
  // E.g. the port is taken
  console.error(`Signaling-Server konnte nicht starten: ${error.message}`);
  process.exit(1);
});

wss.on('connection', (ws) => {
  const limits: Limits = { failedJoins: 0, tokens: MESSAGE_BURST, refilledAt: performance.now() };
  const joinTimer = setTimeout(() => {
    if (!memberships.has(ws)) ws.close(NORMAL_CLOSURE, 'Keinem Raum beigetreten');
  }, JOIN_TIMEOUT_MS);

  ws.on('message', (raw) => {
    // Closed for breaking a limit: whatever the client still sends until the socket is gone is dropped
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!takeToken(limits, messageBurst(ws))) {
      ws.close(POLICY_VIOLATION, 'Zu viele Nachrichten');
      console.log('Verbindung wegen zu vieler Nachrichten geschlossen');
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Ungültige Nachricht' });
      return;
    }
    if (!isClientMessage(parsed)) {
      send(ws, { type: 'error', message: 'Ungültige Nachricht' });
      return;
    }
    // Safety net for bugs in handleMessage: one bad message must not take down every room
    try {
      handleMessage(ws, parsed, limits);
    } catch (error) {
      console.error('Fehler beim Verarbeiten der Nachricht:', error);
      send(ws, { type: 'error', message: 'Fehler beim Verarbeiten der Nachricht' });
    }
  });
  ws.on('error', (error) => console.error('WebSocket-Fehler:', error.message));
  ws.on('close', () => {
    clearTimeout(joinTimer);
    handleClose(ws);
  });
});
