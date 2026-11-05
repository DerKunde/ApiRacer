/**
 * Screen Wake Lock API: keeps the phone's screen on while the page is open – steering only by tilting means
 * nobody touches the screen, and without a lock it would dim and lock after the system timeout.
 */

// Events that count as a user gesture in every browser (Safari: touchend; click as the fallback for mouse/desktop)
const TAP_EVENTS = ['touchend', 'click'] as const;

let sentinel: WakeLockSentinel | undefined;
let log: (text: string) => void = () => {};
let started = false;
let waitingForTap = false;

export function hasWakeLockSupport(): boolean {
  return 'wakeLock' in navigator;
}

/**
 * Requests the lock and keeps it: the browser releases it on its own as soon as the page is hidden (other tab/app,
 * screen off), so it is requested again on every return to the page.
 * Safari only grants it inside a user gesture: if a request is rejected, the next tap anywhere on the page
 * (button, pedal, …) tries again. Call once per page.
 */
export function keepScreenOn(logger: (text: string) => void): void {
  if (!hasWakeLockSupport()) {
    logger('Wake Lock nicht unterstützt – Bildschirm kann sich sperren');
    return;
  }
  if (started) return;
  started = true;
  log = logger;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void requestLock();
  });
  void requestLock();
}

async function requestLock(): Promise<void> {
  if (sentinel && !sentinel.released) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => log('Wake Lock freigegeben'));
    stopWaitingForTap();
    log('Wake Lock aktiv – Bildschirm bleibt an');
  } catch (err) {
    // NotAllowedError: no user gesture (Safari), power saving mode, low battery, or the page is not visible
    log(`Wake Lock abgelehnt: ${String(err)} – nächster Tap versucht es erneut`);
    waitForTap();
  }
}

// Capture phase: runs before the page's own handlers, so even a tap the page handles itself counts
function waitForTap(): void {
  if (waitingForTap) return;
  waitingForTap = true;
  for (const type of TAP_EVENTS) document.addEventListener(type, onTap, { capture: true });
}

function stopWaitingForTap(): void {
  waitingForTap = false;
  for (const type of TAP_EVENTS) document.removeEventListener(type, onTap, { capture: true });
}

function onTap(): void {
  void requestLock();
}
