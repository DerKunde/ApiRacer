import { readdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { isTrackLayout, isTrackName } from './src/shared/trackLayout';

const TRACKS_DIR = fileURLToPath(new URL('./src/client/race/tracks/', import.meta.url));
const ROUTE = '/__tracks';
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// oval.json has 1 KB, so a layout with thousands of points still fits easily
const MAX_BODY_BYTES = 1_000_000;

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body !== undefined) res.setHeader('Content-Type', 'application/json');
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function handlePut(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
  // The dev server listens on the LAN so phones can join (vite.config.ts): they must not write into the repo
  if (!LOOPBACK.includes(req.socket.remoteAddress ?? '')) return send(res, 403);
  // Only the editor's own page may write. CORS is off (vite.config.ts), so other pages already fail the
  // preflight: this still holds if that setting changes. "same-site" isn't enough, a site ignores the port
  if (req.headers['sec-fetch-site'] !== 'same-origin') return send(res, 403);
  if (req.headers['content-type'] !== 'application/json') return send(res, 415);
  // Node passes on exactly Content-Length bytes, so checking the header caps the body
  const length = Number(req.headers['content-length']);
  if (!Number.isInteger(length)) return send(res, 411);
  if (length > MAX_BODY_BYTES) return send(res, 413);
  if (!isTrackName(name)) return send(res, 400);

  const layout = parseJson(await readBody(req));
  if (!isTrackLayout(layout)) return send(res, 400);
  // Only the checked fields go into the file, anything else in the request stays out of the repo
  const { width, points } = layout;
  const clean = { width, points: points.map(({ x, y, z }) => ({ x, y, z })) };
  await writeFile(`${TRACKS_DIR}${name}.json`, `${JSON.stringify(clean, null, 2)}\n`);
  send(res, 204);
}

async function handleGet(res: ServerResponse, name: string): Promise<void> {
  if (!isTrackName(name)) return send(res, 400);
  try {
    res.setHeader('Content-Type', 'application/json');
    res.end(await readFile(`${TRACKS_DIR}${name}.json`, 'utf8'));
  } catch {
    send(res, 404);
  }
}

async function handleList(res: ServerResponse): Promise<void> {
  const files = await readdir(TRACKS_DIR);
  const names = files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -'.json'.length));
  send(res, 200, names.sort());
}

// Dev only (apply: 'serve'): lists, reads and writes the layout files for the track editor
export function trackFilesPlugin(): Plugin {
  return {
    name: 'track-files',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res, next) => {
        // connect strips the route, so req.url is "/" or "/<name>"
        const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1);
        let name: string;
        try {
          name = decodeURIComponent(path);
        } catch {
          return send(res, 400);
        }

        let handled: Promise<void>;
        if (req.method === 'PUT') handled = handlePut(req, res, name);
        else if (req.method === 'GET') handled = name === '' ? handleList(res) : handleGet(res, name);
        else return send(res, 405);
        handled.catch(next);
      });
    },
  };
}
