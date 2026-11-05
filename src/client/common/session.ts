/**
 * Keeps the session token a phone got on joining a room ('joined', see protocol.ts), so it can take its slot in
 * the room back after losing the connection.
 * sessionStorage instead of localStorage: it survives a reload of the tab, but every tab has its own – a second
 * tab with the same link joins as a new player instead of taking over the first one's slot.
 */

const STORAGE_KEY = 'apiracer.session';

export interface StoredSession {
  roomId: string;
  sessionToken: string;
}

export function saveSession(session: StoredSession): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage blocked (e.g. some private modes): the game still works, only reconnecting after a reload won't
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked, nothing was saved (see saveSession)
  }
}
