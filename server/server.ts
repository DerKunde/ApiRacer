import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { HOST_ID, type ClientMessage, type PeerId, type ServerMessage } from '../src/shared/protocol';

/**
 * Signaling server: only brokers the connection setup (offer/answer/ICE).
 * Once the WebRTC connection is up, no game traffic goes through here anymore.
 */

const PORT = Number(process.env.PORT ?? 3001);
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1 (easily confused)

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
      const room: Room = { id: createRoomId(), host: ws, controllers: new Map(), nextPeerNumber: 1 };
      rooms.set(room.id, room);
      memberships.set(ws, { room, peerId: HOST_ID });
      send(ws, { type: 'room-created', roomId: room.id, lanAddresses: lanAddresses() });
      console.log(`Raum ${room.id} erstellt`);
      return;
    }

    case 'join-room': {
      if (membership) return send(ws, { type: 'error', message: 'Bereits in einem Raum' });
      const room = rooms.get(String(msg.roomId).trim().toUpperCase());
      if (!room) return send(ws, { type: 'error', message: `Raum ${msg.roomId} nicht gefunden` });
      const peerId = `p${room.nextPeerNumber++}`;
      room.controllers.set(peerId, ws);
      memberships.set(ws, { room, peerId });
      send(ws, { type: 'joined', roomId: room.id, peerId });
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

const wss = new WebSocketServer({ port: PORT });

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

console.log(`Signaling-Server läuft auf ws://localhost:${PORT}`);
