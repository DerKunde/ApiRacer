import type { ClientMessage, ServerMessage } from '../shared/protocol';

/**
 * Thin wrapper around the WebSocket to the signaling server.
 * Only needed to set up the connection – afterwards everything runs over WebRTC.
 */
export class SignalingClient {
  private constructor(private readonly ws: WebSocket) { }

  static connect(onMessage: (msg: ServerMessage) => void, onClose: () => void): Promise<SignalingClient> {

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const localFallbackURL = `${protocol}//${location.host}/ws`;

    // Production: VITE_SIGNALING_URI is read from .env.production at build time and points to the VPS.
    // Locally it is unset. That means same host as the page, the Vite dev server proxies /ws to server.ts.
    const url = import.meta.env.VITE_SIGNALING_URI ?? localFallbackURL;
    const ws = new WebSocket(url);

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.addEventListener('message', (messageEvent) => onMessage(JSON.parse(messageEvent.data as string) as ServerMessage));
        ws.addEventListener('close', onClose);
        resolve(new SignalingClient(ws));
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('Signaling-Server nicht erreichbar!')), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}
