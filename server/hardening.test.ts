import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SignalData } from '../src/shared/protocol';
import { startServer, type TestClient, type TestServer } from './testServer';

// What the server does with clients that don't behave like the own pages: broken messages, oversized messages,
// foreign origins, invalid WebSocket frames

const OFFER: SignalData = { kind: 'description', description: { type: 'offer', sdp: 'v=0' } };
const INVALID = { type: 'error', message: 'Ungültige Nachricht' };

let server: TestServer;

beforeAll(async () => {
  server = await startServer();
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

// The server still answers a new socket: it didn't crash
async function expectServerAlive(): Promise<void> {
  const { roomId } = await createRoom();
  expect(roomId).toHaveLength(4);
}

describe('message checks', () => {
  it.each([
    ['JSON that is no object', 'null'],
    ['an array', '[]'],
    ['an unknown type', { type: 'bogus' }],
    ['join-room without a code', { type: 'join-room' }],
    ['join-room with a number as code', { type: 'join-room', roomId: 42 }],
    ['join-room with a code longer than 16 characters', { type: 'join-room', roomId: 'X'.repeat(17) }],
    ['signal without a receiver', { type: 'signal', data: OFFER }],
    ['signal with a receiver longer than 16 characters', { type: 'signal', to: 'h'.repeat(17), data: OFFER }],
    ['signal without data', { type: 'signal', to: 'host' }],
    ['signal with an unknown kind', { type: 'signal', to: 'host', data: { kind: 'bogus' } }],
    ['signal with an unknown description type', { type: 'signal', to: 'host', data: { kind: 'description', description: { type: 'x' } } }],
    ['signal with a number as SDP', { type: 'signal', to: 'host', data: { kind: 'description', description: { type: 'offer', sdp: 1 } } }],
    ['signal with a candidate that is no object', { type: 'signal', to: 'host', data: { kind: 'candidate', candidate: 'x' } }],
  ])('rejects %s and keeps the socket', async (_, msg) => {
    const client = await server.connect();
    client.send(msg);
    expect(await client.next()).toEqual(INVALID);
    expect(await client.staysOpen()).toBe(true);
  });

  it('still takes a code of exactly 16 characters as a code', async () => {
    const phone = await server.connect();
    phone.send({ type: 'join-room', roomId: 'Y'.repeat(16) });
    expect(await phone.next()).toEqual({ type: 'error', message: `Raum ${'Y'.repeat(16)} nicht gefunden` });
  });

  it('relays no invalid signal', async () => {
    const { host, roomId } = await createRoom();
    const phone = await server.connect();
    phone.send({ type: 'join-room', roomId });
    await phone.next();
    await host.next();

    phone.send({ type: 'signal', to: 'host', data: { kind: 'description', description: { type: 'x' } } });
    expect(await phone.next()).toEqual(INVALID);
    expect(await host.collect(200)).toEqual([]);
  });
});

describe('transport', () => {
  it('closes a socket that sends more than 64 KiB in one message (1009) and keeps serving the others', async () => {
    const client = await server.connect();
    client.send('x'.repeat(65 * 1024));
    expect(await client.closed).toBe(1009);
    await expectServerAlive();
  });

  it('survives an invalid WebSocket frame', async () => {
    // Handshake by hand, then a frame without the mask every client frame must have. The ws library can't send
    // such a frame, so a raw TCP socket does.
    const { hostname, port } = new URL(server.url);
    const socket = connectTcp(Number(port), hostname);
    // The server may also answer the broken frame with a reset: no reason to fail, whether it survived is what counts.
    // Without a listener, that error would be an uncaught exception.
    socket.on('error', () => {});
    try {
      // Rejects if the connection fails
      await once(socket, 'connect');
      socket.write([
        'GET / HTTP/1.1',
        `Host: ${hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
      const response = await new Promise<string>((resolve) => socket.once('data', (data: Buffer) => resolve(data.toString())));
      expect(response).toMatch(/^HTTP\/1\.1 101/);

      // FIN + text frame, 2 bytes payload "hi", mask bit not set
      socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
      await new Promise((resolve) => socket.once('close', resolve));
    } finally {
      // closeClients() doesn't know this socket: without this, a failed expectation would leave it open
      socket.destroy();
    }
    await expectServerAlive();
  });
});

describe('limits', () => {
  const CANDIDATE: SignalData = { kind: 'candidate', candidate: { candidate: '' } };
  const ANSWER: SignalData = { kind: 'description', description: { type: 'answer', sdp: 'v=0' } };

  async function joinRoom(host: TestClient, roomId: string): Promise<{ phone: TestClient; peerId: string }> {
    const phone = await server.connect();
    phone.send({ type: 'join-room', roomId });
    const msg = await phone.next();
    if (msg.type !== 'joined') throw new Error(`Expected joined, got ${JSON.stringify(msg)}`);
    await host.next();
    return { phone, peerId: msg.peerId };
  }

  it('closes a socket after 5 wrong room codes (1008)', async () => {
    const guesser = await server.connect();
    for (let i = 0; i < 4; i++) {
      guesser.send({ type: 'join-room', roomId: 'ZZZZ' });
      expect(await guesser.next()).toEqual({ type: 'error', message: 'Raum ZZZZ nicht gefunden' });
    }
    expect(await guesser.staysOpen()).toBe(true);

    guesser.send({ type: 'join-room', roomId: 'ZZZZ' });
    expect(await guesser.closed).toBe(1008);
  });

  it('takes 16 phones per room, refuses the 17th, and has room again once one leaves', async () => {
    const { host, roomId } = await createRoom();
    const phones: TestClient[] = [];
    for (let i = 0; i < 16; i++) phones.push((await joinRoom(host, roomId)).phone);

    const extra = await server.connect();
    extra.send({ type: 'join-room', roomId });
    expect(await extra.next()).toEqual({ type: 'error', message: 'Raum voll' });

    phones[0].close();
    expect(await host.next()).toMatchObject({ type: 'peer-left' });
    const replacement = await server.connect();
    replacement.send({ type: 'join-room', roomId });
    expect(await replacement.next()).toMatchObject({ type: 'joined' });
  });

  it('relays a burst of 90 messages, and more after the bucket refilled', { timeout: 10000 }, async () => {
    const { host, roomId } = await createRoom();
    const { phone } = await joinRoom(host, roomId);

    for (let i = 0; i < 90; i++) phone.send({ type: 'signal', to: 'host', data: CANDIDATE });
    expect(await host.collect(500)).toHaveLength(90);

    // About 10 left after the burst. The 500 ms of collect and the 2 s wait refill 50: about 60 for the next 40.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (let i = 0; i < 40; i++) phone.send({ type: 'signal', to: 'host', data: CANDIDATE });
    expect(await host.collect(300)).toHaveLength(40);
    expect(await phone.staysOpen()).toBe(true);
  });

  it('closes a socket that floods the server (1008), tells the host and keeps serving the others', async () => {
    const { host, roomId } = await createRoom();
    const flooder = await joinRoom(host, roomId);
    const other = await joinRoom(host, roomId);

    for (let i = 0; i < 500; i++) flooder.phone.send({ type: 'signal', to: 'host', data: CANDIDATE });
    expect(await flooder.phone.closed).toBe(1008);
    const atHost = await host.collect(300);
    // The burst got through (plus the little that refilled while the server worked through it), then the leave
    expect(atHost.filter((msg) => msg.type === 'signal').length).toBeLessThan(150);
    expect(atHost.at(-1)).toEqual({ type: 'peer-left', peerId: flooder.peerId });

    other.phone.send({ type: 'signal', to: 'host', data: CANDIDATE });
    expect(await host.next()).toEqual({ type: 'signal', from: other.peerId, data: CANDIDATE });
  });

  // Like a Wi-Fi dropout where every phone restarts ICE at the same moment. The host's socket closing would end the
  // room for all of them.
  it('lets the host answer 16 phones at once, each with an answer and 15 ICE candidates', async () => {
    const { host, roomId } = await createRoom();
    const phones: { phone: TestClient; peerId: string }[] = [];
    for (let i = 0; i < 16; i++) phones.push(await joinRoom(host, roomId));

    for (const { peerId } of phones) {
      host.send({ type: 'signal', to: peerId, data: ANSWER });
      for (let i = 0; i < 15; i++) host.send({ type: 'signal', to: peerId, data: CANDIDATE });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const { phone } of phones) expect(await phone.collect(0)).toHaveLength(16);
    expect(await host.staysOpen()).toBe(true);
  });

  it('still closes a host that floods the server (1008)', async () => {
    const { host, roomId } = await createRoom();
    const { phone, peerId } = await joinRoom(host, roomId);

    // Room for 100 + 40 for its one phone
    for (let i = 0; i < 500; i++) host.send({ type: 'signal', to: peerId, data: CANDIDATE });
    expect(await host.closed).toBe(1008);
    expect((await phone.collect(300)).at(-1)).toEqual({ type: 'room-closed' });
  });
});

describe('origin check in production', () => {
  let production: TestServer;

  beforeAll(async () => {
    production = await startServer({ NODE_ENV: 'production' });
  });
  afterEach(() => production?.closeClients());
  afterAll(() => production?.stop());

  it('accepts the own pages', async () => {
    const client = await production.connect('https://stud.messy-desk-studio.de');
    expect(await client.staysOpen()).toBe(true);
  });

  it.each([
    ['another website', 'https://example.com'],
    ['no origin at all', undefined],
  ])('refuses %s', async (_, origin) => {
    await expect(production.connect(origin)).rejects.toThrow(/401/);
  });
});
