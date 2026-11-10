import type { AddressInfo } from 'node:net';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST_ID, type ClientMessage, type IceServer, type PeerId, type ServerMessage, type SignalData } from '../src/shared/protocol';
import { createHmac } from 'node:crypto';

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

// Limits against scripts. Real clients stay far below them: the join form opens a new socket for every code, and
// after the connection setup a socket is silent.
// Wrong room codes per socket, then it is closed: guessing codes over one connection is no longer possible
const MAX_FAILED_JOINS = 5;
// Phones per room, racers and spectators together: a script could otherwise send thousands, and the host browser
// would set up a PeerConnection for each of them
const MAX_CONTROLLERS_PER_ROOM = 16;
// Messages per socket as a token bucket: up to MESSAGE_BURST at once, then MESSAGE_RATE per second. The burst is
// for the host: when several phones join at once, it sends an answer and its ICE candidates to each of them.
const MESSAGE_BURST = 100;
const MESSAGE_RATE = 20;
// Close code for a client that breaks the rules (RFC 6455)
const POLICY_VIOLATION = 1008;

// Only the own pages may connect in production. Keeps other websites out – scripts can still fake the origin.
const ALLOWED_ORIGIN = 'https://stud.messy-desk-studio.de';
const TURN_URLS = process.env.TURN_URLS?.split(',');
const TURN_SECRET = process.env.TURN_SECRET;
const TURN_CREDENTIAL_TTL_S = 12 * 60 * 60;

interface Room {
  id: string;
  host: WebSocket;
  controllers: Map<PeerId, WebSocket>;
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

function handleMessage(ws: WebSocket, msg: ClientMessage, limits: Limits): void {
  const membership = memberships.get(ws);

  switch (msg.type) {
    case 'create-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const turn = createTurnIceServer(HOST_ID);
      const room: Room = { id: createRoomId(), host: ws, controllers: new Map(), nextPeerNumber: 1 };
      rooms.set(room.id, room);
      memberships.set(ws, { room, peerId: HOST_ID });
      send(ws, { type: 'room-created', roomId: room.id, lanAddresses: IS_PRODUCTION ? undefined : lanAddresses(), iceServers: turn ? [turn] : undefined });
      console.log(`Raum ${room.id} erstellt`);
      return;
    }

    case 'join-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const room = rooms.get(String(msg.roomId).trim().toUpperCase());
      if (!room) {
        send(ws, { type: 'error', message: `Raum ${msg.roomId} nicht gefunden` });
        if (++limits.failedJoins >= MAX_FAILED_JOINS) {
          ws.close(POLICY_VIOLATION, 'Zu viele falsche Raumcodes');
          console.log(`Verbindung nach ${MAX_FAILED_JOINS} falschen Raumcodes geschlossen`);
        }
        return;
      }
      if (room.controllers.size >= MAX_CONTROLLERS_PER_ROOM) return send(ws, { type: 'error', message: 'Raum voll' });
      const peerId = `p${room.nextPeerNumber++}`;
      const turn = createTurnIceServer(peerId);
      room.controllers.set(peerId, ws);
      memberships.set(ws, { room, peerId });
      send(ws, { type: 'joined', roomId: room.id, peerId, iceServers: turn ? [turn] : undefined });
      send(room.host, { type: 'peer-joined', peerId });
      console.log(`[${room.id}] ${peerId} beigetreten`);
      return;
    }

    case 'signal': {
      if (!membership) return send(ws, { type: 'error', message: 'Nicht in einem Raum' });
      const { room, peerId } = membership;
      // Star topology: controllers only talk to the host, the host talks to all controllers
      const target =
        peerId === HOST_ID
          ? room.controllers.get(msg.to)
          : msg.to === HOST_ID
            ? room.host
            : undefined;
      if (!target) return send(ws, { type: 'error', message: `Empfänger ${msg.to} unbekannt` });
      send(target, { type: 'signal', from: peerId, data: msg.data });
      const detail = msg.data.kind === 'description' ? msg.data.description.type : 'ICE-Kandidat';
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
      send(controller, { type: 'room-closed' });
      memberships.delete(controller);
    }
    rooms.delete(room.id);
    console.log(`Raum ${room.id} geschlossen`);
  } else {
    room.controllers.delete(peerId);
    send(room.host, { type: 'peer-left', peerId });
    console.log(`[${room.id}] ${peerId} gegangen`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Refills the bucket for the time since the last message, then takes one token. false = bucket empty.
function takeToken(limits: Limits): boolean {
  const now = Date.now();
  limits.tokens = Math.min(MESSAGE_BURST, limits.tokens + (now - limits.refilledAt) / 1000 * MESSAGE_RATE);
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
      return isObject(value.candidate);
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
  verifyClient: ({ origin }: { origin: string }) => !IS_PRODUCTION || origin === ALLOWED_ORIGIN,
});

// Only once the port is really open. With PORT=0 the OS picks a free one (the tests do that), printed here.
wss.on('listening', () => {
  const { port } = wss.address() as AddressInfo;
  console.log(`Signaling-Server läuft auf ws://${HOST}:${port}`);
});
// E.g. the port is taken. Without a listener, the error event would end the process with a bare stack trace.
wss.on('error', (error) => {
  console.error(`Signaling-Server konnte nicht starten: ${error.message}`);
  process.exit(1);
});

wss.on('connection', (ws) => {
  const limits: Limits = { failedJoins: 0, tokens: MESSAGE_BURST, refilledAt: Date.now() };

  ws.on('message', (raw) => {
    // Closed for breaking a limit: whatever the client still sends until the socket is gone is dropped
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!takeToken(limits)) {
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
  ws.on('close', () => handleClose(ws));
});
