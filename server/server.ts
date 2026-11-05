import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST_ID, type ClientMessage, type IceServer, type PeerId, type ServerMessage } from '../src/shared/protocol';
import { createHmac, randomUUID } from 'node:crypto';

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
  controllers: Map<PeerId, Controller>;
  nextPeerNumber: number;
}

/** Which room does a socket belong to, and what is its peer ID there? */
interface Membership {
  room: Room;
  peerId: PeerId;
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

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
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
      if (!room) return send(ws, { type: 'error', message: `Raum ${msg.roomId} nicht gefunden` });
      const peerId = `p${room.nextPeerNumber++}`;
      // Unguessable (crypto RNG): whoever holds the token can claim the slot. Never logged for the same reason.
      const sessionToken = randomUUID();
      const turn = createTurnIceServer(peerId);
      room.controllers.set(peerId, { ws, sessionToken });
      memberships.set(ws, { room, peerId });
      send(ws, { type: 'joined', roomId: room.id, peerId, sessionToken, iceServers: turn ? [turn] : undefined });
      send(room.host, { type: 'peer-joined', peerId });
      console.log(`[${room.id}] ${peerId} beigetreten`);
      return;
    }

    case 'rejoin-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const room = rooms.get(String(msg.roomId).trim().toUpperCase());
      if (!room) return send(ws, { type: 'error', message: `Raum ${msg.roomId} nicht gefunden` });
      const slot = [...room.controllers].find(([, controller]) => controller.sessionToken === msg.sessionToken);
      if (!slot) return send(ws, { type: 'error', message: 'Sitzung abgelaufen – bitte neu beitreten' });
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

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(ws, { type: 'error', message: 'Ungültige Nachricht' });
      return;
    }
    handleMessage(ws, msg);
  });
  ws.on('close', () => handleClose(ws));
});

console.log(`Signaling-Server läuft auf ws://${HOST}:${PORT}`);
