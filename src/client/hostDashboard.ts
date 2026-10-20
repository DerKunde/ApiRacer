import type { PeerId } from '../shared/protocol';
import QRCode from 'qrcode';

/** UI pieces shared by both host pages (race host.ts and the 3D phone host). */

const QR_CODE_SIZE = 200;
// Short enough to stay narrower than the QR code – the button then stretches to exactly its width
const COPY_LABEL = '🔗 Link kopieren';
let nextColorIndex = 0;

/**
 * Links the phone opens to join. Normally one, under the same address as this page.
 * Dev server opened on "localhost": the phone can't use that name → one link per LAN address instead.
 * import.meta.env.DEV is replaced by `false` in the production build, so this branch is stripped there.
 */
export function buildJoinURLs(joinPage: string, roomId: string, lanAddresses: string[]): string[] {
  return import.meta.env.DEV && isOpenedOnLocalhost()
    ? buildLocalRoomURLs(joinPage, roomId, lanAddresses)
    : [buildRoomURL(joinPage, roomId)];
}

/** Production: the phone opens the join page under the same address as this page. */
function buildRoomURL(joinPage: string, roomId: string): string {
  // URL keeps protocol and port of the current page and omits default ports (no "host:/…")
  const url = new URL(joinPage, location.origin);
  url.searchParams.set('room', roomId);
  return url.href;
}

/**
 * Local dev: one URL per LAN address of the PC. The server can only list all interfaces
 * (incl. virtual adapters like WSL/Hyper-V/VPN), so we offer all of them – at least one works.
 */
function buildLocalRoomURLs(joinPage: string, roomId: string, lanAddresses: string[]): string[] {
  return lanAddresses.map((address) => {
    const url = new URL(buildRoomURL(joinPage, roomId));
    url.hostname = address;
    return url.href;
  });
}

function isOpenedOnLocalhost(): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

/** One way to join: QR code to scan with the phone, plus a button that copies the link (e.g. to send it via chat). */
export function createJoinOption(url: string, log: (text: string) => void): HTMLLIElement {
  const item = document.createElement('li');
  const canvas = document.createElement('canvas');
  const copyButton = document.createElement('button');
  copyButton.textContent = COPY_LABEL;
  // Link is no longer shown as text – hovering the button still reveals it (handy with several LAN links in dev)
  copyButton.title = url;
  copyButton.addEventListener('click', () => void copyJoinLink(copyButton, url, log));
  item.append(canvas, copyButton);
  // Fixed width: the canvas is not in the page yet, so it has no clientWidth to read
  QRCode.toCanvas(canvas, url, { width: QR_CODE_SIZE, margin: 2 }).catch((err: unknown) =>
    log(`❌ QR-Code konnte nicht erzeugt werden: ${String(err)}`),
  );
  return item;
}

// Clipboard API only exists in a secure context (https or localhost) → on plain http via LAN IP
// navigator.clipboard is undefined and the call throws, which ends up in the catch.
async function copyJoinLink(button: HTMLButtonElement, url: string, log: (text: string) => void): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = '✓ Kopiert';
    window.setTimeout(() => (button.textContent = COPY_LABEL), 2000);
  } catch (err) {
    log(`❌ Link konnte nicht kopiert werden: ${String(err)} – Link: ${url}`);
  }
}

/**
 * Hue steps by the golden ratio (0.381966 of the circle ≈ 137.5°), so consecutive colors are far apart and never
 * repeat exactly. The counter only goes up – a phone that leaves doesn't hand its color to the next one.
 * Comma syntax for hsl(), because THREE.Color's parser expects it.
 */
export function nextPeerColor(): string {
  const hue = (++nextColorIndex * 0.381966 % 1) * 360;
  return `hsl(${hue.toFixed(1)}, 70%, 55%)`;
}

/** One card per phone in the sidebar; keeps the elements the host writes into. */
export interface PeerCard<L extends string> {
  root: HTMLLIElement;
  state: HTMLElement;
  rtt: HTMLElement;
  // One <dd> per label passed to createPeerCard, e.g. details.Weg
  details: Record<L, HTMLElement>;
}

/** Card header: ID + connection state, below it the details as label/value pairs (<dl>), in the given order. */
export function createPeerCard<L extends string>(
  list: HTMLElement,
  id: PeerId,
  color: string,
  detailLabels: readonly L[],
): PeerCard<L> {
  const root = document.createElement('li');
  root.className = 'peer-card';
  // Read by .peer-card in style.css (colored left edge)
  root.style.setProperty('--peer-color', color);

  const head = document.createElement('div');
  head.className = 'peer-head';
  const name = document.createElement('strong');
  name.textContent = id;
  // Right side of the header: "connected · 12.3 ms"
  const status = document.createElement('span');
  status.className = 'peer-status';
  const state = document.createElement('span');
  const rtt = document.createElement('span');
  rtt.className = 'peer-rtt';
  status.append(state, rtt);
  head.append(name, status);

  const dl = document.createElement('dl');
  // Filled in the loop below – one entry per label, so the cast doesn't hide a missing key
  const details = {} as Record<L, HTMLElement>;
  for (const label of detailLabels) {
    const term = document.createElement('dt');
    const value = document.createElement('dd');
    term.textContent = label;
    dl.append(term, value);
    details[label] = value;
  }

  root.append(head, dl);
  list.append(root);
  return { root, state, rtt, details };
}
