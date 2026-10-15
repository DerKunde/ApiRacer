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
afterEach(() => server.closeClients());
afterAll(() => server.stop());

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
    expect(client.isOpen).toBe(true);
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
    await new Promise((resolve) => socket.once('connect', resolve));
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
    await expectServerAlive();
  });
});

describe('origin check in production', () => {
  let production: TestServer;

  beforeAll(async () => {
    production = await startServer({ NODE_ENV: 'production' });
  });
  afterEach(() => production.closeClients());
  afterAll(() => production.stop());

  it('accepts the own pages', async () => {
    const client = await production.connect('https://stud.messy-desk-studio.de');
    expect(client.isOpen).toBe(true);
  });

  it.each([
    ['another website', 'https://example.com'],
    ['no origin at all', undefined],
  ])('refuses %s', async (_, origin) => {
    await expect(production.connect(origin)).rejects.toThrow(/401/);
  });
});
