/**
 * Keeps the session token a phone got on joining a room ('joined', see protocol.ts), so it can take its slot in
 * the room back after losing the connection.
 * sessionStorage instead of localStorage: it survives a reload of the tab, and a second tab opened with the same
 * link joins as a new player instead of taking over the first one's slot. Exception: a duplicated tab gets a copy
 * of the original's sessionStorage, so it takes the slot over ('session-taken-over' sends the original back to the
 * join screen).
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

/** The session this tab saved last, e.g. before a reload. */
export function loadSession(): StoredSession | undefined {
  try {
    return (JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as StoredSession | null) ?? undefined;
  } catch {
    // Storage blocked or a broken value: the phone joins as a new player
    return undefined;
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked, nothing was saved (see saveSession)
  }
}
