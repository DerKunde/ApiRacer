import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../src/shared/protocol';

/**
 * Test helpers: the real server.ts in its own process, spoken to over WebSocket like a browser would.
 * Black box on purpose – the tests don't depend on how server.ts is built inside.
 */

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
// Compiling server.ts on the fly takes a moment, longer on a cold CI runner.
// Has to stay below hookTimeout in vitest.config.ts.
const START_TIMEOUT_MS = 10000;
// How long next() waits for a message before the test fails
const MESSAGE_TIMEOUT_MS = 2000;
// How long staysOpen() gives the server to close the socket after its answer
const STAYS_OPEN_MS = 200;
// Server output kept for error messages. The end is what explains a failure, the rest only costs memory.
const MAX_OUTPUT_CHARS = 20000;
// Printed by server.ts once it listens, with the port the OS picked for PORT=0
const LISTENING = /Signaling-Server läuft auf ws:\/\/[\d.]+:(\d+)/;
// From the developer's shell, they would change how the server behaves on one machine but not on another.
// Tests that need one pass it to startServer.
const SERVER_ENV_KEYS = [
  'NODE_ENV',
  'TURN_URLS',
  'TURN_SECRET',
  'REJOIN_GRACE_MS',
  'GOING_AWAY_GRACE_MS',
  'HEARTBEAT_INTERVAL_MS',
];

export interface TestServer {
  url: string;
  // Opens a socket like a browser page. origin: the Origin header the browser would send, none if left out.
  // autoPong: false = never answers the server's pings, like a connection that died without a close
  connect(origin?: string, autoPong?: boolean): Promise<TestClient>;
  // For afterEach: every test starts without the sockets of the previous one
  closeClients(): void;
  stop(): Promise<void>;
}

// env: extra environment variables for the server, e.g. NODE_ENV=production
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const baseEnv = { ...process.env };
  for (const key of SERVER_ENV_KEYS) delete baseEnv[key];
  // PORT=0: the OS picks a free port and the server prints which one – nothing to pick beforehand that another
  // process could take in the meantime
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...baseEnv, ...env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Decoded as a stream: a character split between two chunks stays whole (the server logs umlauts and arrows)
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Read the whole time: a full pipe would block the server's logging
  let output = '';
  const append = (text: string): void => {
    output = (output + text).slice(-MAX_OUTPUT_CHARS);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const port = await new Promise<number>((resolve, reject) => {
    const fail = (reason: string): void => {
      cleanUp();
      child.kill();
      reject(new Error(`Signaling server ${reason}:\n${output}`));
    };
    const onData = (): void => {
      const match = LISTENING.exec(output);
      if (!match) return;
      cleanUp();
      resolve(Number(match[1]));
    };
    const onError = (error: Error): void => fail(`could not be started (${error.message})`);
    const onExit = (code: number | null, signal: string | null): void => fail(`exited (${code ?? signal})`);
    const timer = setTimeout(() => fail(`not listening within ${START_TIMEOUT_MS} ms`), START_TIMEOUT_MS);
    const cleanUp = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
  });

  let stopping = false;
  // From here on, a crash shows up in the tests as refused connections or missing messages – this says why
  child.on('exit', (code, signal) => {
    if (!stopping) console.error(`Signaling server exited during the tests (${code ?? signal}):\n${output}`);
  });
  child.on('error', (error) => console.error(`Signaling server process error: ${error.message}`));

  const url = `ws://127.0.0.1:${port}`;
  const clients = new Set<TestClient>();
  return {
    url,
    async connect(origin, autoPong) {
      const client = await TestClient.connect(url, origin, autoPong);
      clients.add(client);
      return client;
    },
    closeClients() {
      for (const client of clients) client.close();
      clients.clear();
    },
    async stop() {
      stopping = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await once(child, 'exit');
    },
  };
}

// A next() call that waits for a message
interface Waiter {
  deliver(msg: ServerMessage): void;
  fail(error: Error): void;
}

export class TestClient {
  // Resolves with the close code once the socket is closed, by either side
  readonly closed: Promise<number>;
  private readonly ws: WebSocket;
  // Arrived, but not taken by next() yet
  private readonly inbox: ServerMessage[] = [];
  // next() calls still waiting, oldest first: each message goes to the oldest
  private readonly waiting: Waiter[] = [];
  // Why no message can come anymore: a socket error after the connection was open, or the close. Kept for next(), so
  // the test that waits fails with it right away instead of with a timeout.
  private error?: Error;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiting = this.waiting.shift();
      if (waiting) waiting.deliver(msg);
      else this.inbox.push(msg);
    });
    // Without a listener, an error event would be an uncaught exception, blamed on no test in particular
    ws.on('error', (error) => this.fail(error));
    this.closed = new Promise((resolve) => ws.once('close', (code: number) => resolve(code)));
    // Messages always come before the close: what is still waiting then waits in vain
    ws.once('close', (code: number) => this.fail(new Error(`Socket closed (${code}) while waiting for a message`)));
  }

  // The first reason is the one that explains the failure, the close after an error adds nothing
  private fail(error: Error): void {
    this.error ??= error;
    for (const waiting of this.waiting.splice(0)) waiting.fail(this.error);
  }

  // Rejects when the server refuses the connection
  static async connect(url: string, origin?: string, autoPong = true): Promise<TestClient> {
    const ws = new WebSocket(url, { origin, autoPong });
    await once(ws, 'open');
    return new TestClient(ws);
  }

  // Asked right when an answer arrives, a socket the server closes after that answer would still count as open:
  // its close frame isn't processed yet. So it waits a moment first.
  async staysOpen(): Promise<boolean> {
    await new Promise((resolve) => setTimeout(resolve, STAYS_OPEN_MS));
    return this.ws.readyState === WebSocket.OPEN;
  }

  // Objects are sent as JSON, strings as they are (for broken messages)
  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  // The next message, in the order they arrived
  next(): Promise<ServerMessage> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        deliver: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        // Only its own place: a next() called later keeps waiting
        this.waiting.splice(this.waiting.indexOf(waiter), 1);
        reject(new Error(`No message within ${MESSAGE_TIMEOUT_MS} ms`));
      }, MESSAGE_TIMEOUT_MS);
      this.waiting.push(waiter);
    });
  }

  // For "nothing arrives": everything that came in during the wait, ideally nothing
  async collect(ms: number): Promise<ServerMessage[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.splice(0);
  }

  // code: e.g. 1001 like a browser whose page is closed or reloaded; none = like a dropped connection
  close(code?: number): void {
    this.ws.close(code);
  }
}
