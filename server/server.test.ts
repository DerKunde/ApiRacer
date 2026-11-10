import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SignalData } from '../src/shared/protocol';
import { startServer, type TestClient, type TestServer } from './testServer';

// The basic flow every page relies on: rooms, joining, relaying the connection setup, leaving

const OFFER: SignalData = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } };
const ANSWER: SignalData = { kind: 'description', description: { type: 'answer', sdp: 'v=0' } };

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
});
afterEach(() => server.closeClients());
afterAll(() => server.stop());

async function createRoom(): Promise<{ host: TestClient; roomId: string }> {
  const host = await server.connect();
  host.send({ type: 'create-room' });
  const msg = await host.next();
  if (msg.type !== 'room-created') throw new Error(`Expected room-created, got ${JSON.stringify(msg)}`);
  return { host, roomId: msg.roomId };
}

// Also takes the host's peer-joined, so the host's next message is whatever comes after it
async function joinRoom(host: TestClient, roomId: string): Promise<{ phone: TestClient; peerId: string }> {
  const phone = await server.connect();
  phone.send({ type: 'join-room', roomId });
  const msg = await phone.next();
  if (msg.type !== 'joined') throw new Error(`Expected joined, got ${JSON.stringify(msg)}`);
  expect(await host.next()).toEqual({ type: 'peer-joined', peerId: msg.peerId });
  return { phone, peerId: msg.peerId };
}

describe('rooms', () => {
  it('gives the host a code of 4 characters that are hard to confuse', async () => {
    const { roomId } = await createRoom();
    expect(roomId).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
  });

  it('lets phones join with the code, each with its own peer ID, and tells the host', async () => {
    const { host, roomId } = await createRoom();
    const first = await joinRoom(host, roomId);
    const second = await joinRoom(host, roomId);
    expect([first.peerId, second.peerId]).toEqual(['p1', 'p2']);
  });

  it('accepts the code in lower case and with spaces around it', async () => {
    const { host, roomId } = await createRoom();
    const phone = await server.connect();
    phone.send({ type: 'join-room', roomId: `  ${roomId.toLowerCase()} ` });
    expect(await phone.next()).toMatchObject({ type: 'joined', roomId });
    expect(await host.next()).toEqual({ type: 'peer-joined', peerId: 'p1' });
  });

  it('answers an unknown code with an error', async () => {
    const phone = await server.connect();
    phone.send({ type: 'join-room', roomId: 'ZZZZ' });
    expect(await phone.next()).toEqual({ type: 'error', message: 'Raum ZZZZ nicht gefunden' });
  });

  it('keeps a socket in one room', async () => {
    const { host, roomId } = await createRoom();
    host.send({ type: 'create-room' });
    expect(await host.next()).toEqual({ type: 'error', message: 'Bereits in einem Raum' });

    const { phone } = await joinRoom(host, roomId);
    phone.send({ type: 'join-room', roomId });
    expect(await phone.next()).toEqual({ type: 'error', message: 'Bereits in einem Raum' });
  });

  it('tells the host when a phone leaves', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId } = await joinRoom(host, roomId);
    phone.close();
    expect(await host.next()).toEqual({ type: 'peer-left', peerId });
  });

  it('closes the room for every phone when the host leaves', async () => {
    const { host, roomId } = await createRoom();
    const { phone } = await joinRoom(host, roomId);
    host.close();
    expect(await phone.next()).toEqual({ type: 'room-closed' });

    const latecomer = await server.connect();
    latecomer.send({ type: 'join-room', roomId });
    expect(await latecomer.next()).toEqual({ type: 'error', message: `Raum ${roomId} nicht gefunden` });
  });
});

describe('relaying the connection setup', () => {
  it('relays from phone to host and back, with the sender as from', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId } = await joinRoom(host, roomId);

    phone.send({ type: 'signal', to: 'host', data: OFFER });
    expect(await host.next()).toEqual({ type: 'signal', from: peerId, data: OFFER });
    host.send({ type: 'signal', to: peerId, data: ANSWER });
    expect(await phone.next()).toEqual({ type: 'signal', from: 'host', data: ANSWER });
  });

  it('relays nothing between phones: star topology, phones only talk to the host', async () => {
    const { host, roomId } = await createRoom();
    const { phone } = await joinRoom(host, roomId);
    const other = await joinRoom(host, roomId);

    phone.send({ type: 'signal', to: other.peerId, data: OFFER });
    expect(await phone.next()).toEqual({ type: 'error', message: `Empfänger ${other.peerId} unbekannt` });
    expect(await other.phone.collect(200)).toEqual([]);
  });

  it('relays nothing for a socket that is in no room', async () => {
    const stranger = await server.connect();
    stranger.send({ type: 'signal', to: 'host', data: OFFER });
    expect(await stranger.next()).toEqual({ type: 'error', message: 'Nicht in einem Raum' });
  });
});

it('answers a message that is no JSON with an error and keeps the socket', async () => {
  const client = await server.connect();
  client.send('not json');
  expect(await client.next()).toEqual({ type: 'error', message: 'Ungültige Nachricht' });
  expect(client.isOpen).toBe(true);
});
