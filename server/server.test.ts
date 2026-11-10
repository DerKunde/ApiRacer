import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SignalData } from '../src/shared/protocol';
import { startServer, type TestClient, type TestServer } from './testServer';

// The basic flow every page relies on: rooms, joining, relaying the connection setup, leaving

const OFFER: SignalData = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } };
const ANSWER: SignalData = { kind: 'description', description: { type: 'answer', sdp: 'v=0' } };

let server: TestServer;

// How long the server keeps a phone's slot here: long enough to rejoin in the tests, short enough to wait for
// 'peer-left' (below the 2 s of next())
const REJOIN_GRACE_MS = 500;
// The shorter grace after a closed page (close code 1001)
const GOING_AWAY_GRACE_MS = 100;
// Close code a browser sends when its page is closed or reloaded
const GOING_AWAY = 1001;

beforeAll(async () => {
  server = await startServer({
    REJOIN_GRACE_MS: String(REJOIN_GRACE_MS),
    GOING_AWAY_GRACE_MS: String(GOING_AWAY_GRACE_MS),
  });
});
// server is unset if beforeAll failed: without ?. a TypeError would cover up the real error
afterEach(() => server?.closeClients());
afterAll(() => server?.stop());

async function createRoom(): Promise<{ host: TestClient; roomId: string }> {
  const host = await server.connect();
  host.send({ type: 'create-room' });
  const msg = await host.next();
  if (msg.type !== 'room-created') throw new Error(`Expected room-created, got ${JSON.stringify(msg)}`);
  return { host, roomId: msg.roomId };
}

// Also takes the host's peer-joined, so the host's next message is whatever comes after it
async function joinRoom(
  host: TestClient,
  roomId: string,
): Promise<{ phone: TestClient; peerId: string; sessionToken: string }> {
  const phone = await server.connect();
  phone.send({ type: 'join-room', roomId });
  const msg = await phone.next();
  if (msg.type !== 'joined') throw new Error(`Expected joined, got ${JSON.stringify(msg)}`);
  expect(await host.next()).toEqual({ type: 'peer-joined', peerId: msg.peerId });
  return { phone, peerId: msg.peerId, sessionToken: msg.sessionToken };
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

  it('tells the host right away when a phone is away, and that it left once the rejoin grace is over', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId } = await joinRoom(host, roomId);
    phone.close();
    expect(await host.next()).toEqual({ type: 'peer-away', peerId, graceMs: REJOIN_GRACE_MS });
    expect(await host.collect(REJOIN_GRACE_MS / 2)).toEqual([]);
    expect(await host.next()).toEqual({ type: 'peer-left', peerId, reason: 'timeout' });
  });

  it('keeps the slot only briefly when the page was closed (1001): a reload is back by then', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId } = await joinRoom(host, roomId);
    phone.close(GOING_AWAY);
    expect(await host.next()).toEqual({ type: 'peer-away', peerId, graceMs: GOING_AWAY_GRACE_MS });
    // Well before the normal grace would be over
    const [left] = await host.collect(GOING_AWAY_GRACE_MS + 150);
    expect(left).toEqual({ type: 'peer-left', peerId, reason: 'left' });
  });

  it('frees the slot right away when a phone leaves on purpose', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId, sessionToken } = await joinRoom(host, roomId);
    phone.send({ type: 'leave-room' });
    expect(await host.next()).toEqual({ type: 'peer-left', peerId, reason: 'left' });
    // Nothing to keep the socket for: closed like after room-closed, and its close is no second leave
    expect(await phone.closed).toBe(1000);
    expect(await host.collect(REJOIN_GRACE_MS + 200)).toEqual([]);

    const back = await server.connect();
    back.send({ type: 'rejoin-room', roomId, sessionToken });
    expect(await back.next()).toEqual({ type: 'error', message: 'Sitzung abgelaufen – bitte neu beitreten' });
  });

  it('lets only a phone in a room leave it', async () => {
    const stranger = await server.connect();
    stranger.send({ type: 'leave-room' });
    expect(await stranger.next()).toEqual({ type: 'error', message: 'Nicht in einem Raum' });

    // The host closes its page instead – leaving would end the room for every phone
    const { host } = await createRoom();
    host.send({ type: 'leave-room' });
    expect(await host.next()).toEqual({ type: 'error', message: 'Nur Handys können den Raum verlassen' });
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

describe('rejoining', () => {
  it('gives a phone that lost its socket its slot back with the session token', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId, sessionToken } = await joinRoom(host, roomId);
    phone.close();
    expect(await host.next()).toMatchObject({ type: 'peer-away', peerId });

    const back = await server.connect();
    back.send({ type: 'rejoin-room', roomId, sessionToken });
    expect(await back.next()).toMatchObject({ type: 'joined', roomId, peerId, sessionToken });
    expect(await host.next()).toEqual({ type: 'peer-rejoined', peerId });
    // The slot is taken again: no 'peer-left' once the grace is over
    expect(await host.collect(REJOIN_GRACE_MS + 200)).toEqual([]);

    back.send({ type: 'signal', to: 'host', data: OFFER });
    expect(await host.next()).toEqual({ type: 'signal', from: peerId, data: OFFER });
  });

  it('hands the slot to the newer socket and drops the old one', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId, sessionToken } = await joinRoom(host, roomId);

    const duplicate = await server.connect();
    duplicate.send({ type: 'rejoin-room', roomId, sessionToken });
    expect(await duplicate.next()).toMatchObject({ type: 'joined', peerId });
    expect(await phone.next()).toEqual({ type: 'session-taken-over' });
    await phone.closed;
    // The old socket's close is no leave
    expect(await host.next()).toEqual({ type: 'peer-rejoined', peerId });
    expect(await host.collect(REJOIN_GRACE_MS + 200)).toEqual([]);
  });

  it('refuses a wrong token and a slot whose grace is over', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId, sessionToken } = await joinRoom(host, roomId);

    const guesser = await server.connect();
    guesser.send({ type: 'rejoin-room', roomId, sessionToken: 'not-the-token' });
    expect(await guesser.next()).toEqual({ type: 'error', message: 'Sitzung abgelaufen – bitte neu beitreten' });

    phone.close();
    expect(await host.next()).toMatchObject({ type: 'peer-away', peerId });
    expect(await host.next()).toEqual({ type: 'peer-left', peerId, reason: 'timeout' });
    const late = await server.connect();
    late.send({ type: 'rejoin-room', roomId, sessionToken });
    expect(await late.next()).toEqual({ type: 'error', message: 'Sitzung abgelaufen – bitte neu beitreten' });
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
    expect(await phone.next()).toEqual({ type: 'error', message: `Empfänger ${other.peerId} nicht erreichbar` });
    expect(await other.phone.collect(200)).toEqual([]);
  });

  it('relays nothing for a socket that is in no room', async () => {
    const stranger = await server.connect();
    stranger.send({ type: 'signal', to: 'host', data: OFFER });
    expect(await stranger.next()).toEqual({ type: 'error', message: 'Nicht in einem Raum' });
  });
});

describe('broken messages', () => {
  it('answers a message that is no JSON with an error and keeps the socket', async () => {
    const client = await server.connect();
    client.send('not json');
    expect(await client.next()).toEqual({ type: 'error', message: 'Ungültige Nachricht' });
    expect(await client.staysOpen()).toBe(true);
  });

  // Valid JSON, but not the shape of a message: one of them must not take down the server and with it every room
  it('answers JSON that is no valid message with an error and keeps running', async () => {
    const { host, roomId } = await createRoom();
    const { phone } = await joinRoom(host, roomId);
    for (const msg of ['null', { type: 'signal', to: 'host' }, { type: 'signal', to: 'host', data: { kind: 'description' } }]) {
      phone.send(msg);
      expect(await phone.next()).toMatchObject({ type: 'error' });
    }
    // Still serves new sockets
    await createRoom();
  });
});
