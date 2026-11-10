import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect as connectTcp, createServer, type AddressInfo } from 'node:net';
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

export interface TestServer {
  url: string;
  // Opens a socket like a browser page. origin: the Origin header the browser would send, none if left out.
  connect(origin?: string): Promise<TestClient>;
  // For afterEach: every test starts without the sockets of the previous one
  closeClients(): void;
  stop(): Promise<void>;
}

// env: extra environment variables for the server, e.g. NODE_ENV=production
export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Kept for the error message if it doesn't start. Read the whole time: a full pipe would block the server's logging.
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => output += chunk.toString());
  child.stderr.on('data', (chunk: Buffer) => output += chunk.toString());

  // Ready once the port takes connections. Not the start message: the server prints it before it listens.
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await acceptsConnections(port))) {
    if (exited() || Date.now() > deadline) {
      const reason = exited() ? `exited (${child.exitCode ?? child.signalCode})` : `not listening within ${START_TIMEOUT_MS} ms`;
      child.kill();
      throw new Error(`Signaling server ${reason}:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const url = `ws://127.0.0.1:${port}`;
  const clients = new Set<TestClient>();
  return {
    url,
    async connect(origin) {
      const client = await TestClient.connect(url, origin);
      clients.add(client);
      return client;
    },
    closeClients() {
      for (const client of clients) client.close();
      clients.clear();
    },
    async stop() {
      const running = !exited();
      child.kill();
      if (running) await once(child, 'exit');
    },
  };
}

export class TestClient {
  // Resolves with the close code once the socket is closed, by either side
  readonly closed: Promise<number>;
  private readonly ws: WebSocket;
  // Arrived, but not taken by next() yet
  private readonly inbox: ServerMessage[] = [];
  private waiting?: (msg: ServerMessage) => void;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiting = this.waiting;
      this.waiting = undefined;
      if (waiting) waiting(msg);
      else this.inbox.push(msg);
    });
    this.closed = new Promise((resolve) => ws.once('close', (code: number) => resolve(code)));
  }

  // Rejects when the server refuses the connection
  static async connect(url: string, origin?: string): Promise<TestClient> {
    const ws = new WebSocket(url, { origin });
    await once(ws, 'open');
    return new TestClient(ws);
  }

  get isOpen(): boolean {
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new Error(`No message within ${MESSAGE_TIMEOUT_MS} ms`));
      }, MESSAGE_TIMEOUT_MS);
      this.waiting = (msg) => {
        clearTimeout(timer);
        resolve(msg);
      };
    });
  }

  // For "nothing arrives": everything that came in during the wait, ideally nothing
  async collect(ms: number): Promise<ServerMessage[]> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return this.inbox.splice(0);
  }

  close(): void {
    this.ws.close();
  }
}

function acceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectTcp(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

// Port 0 lets the OS pick a free one. Tiny race until the server takes it – fine for tests.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
