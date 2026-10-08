import type { ClientMessage, ServerMessage } from '../shared/protocol';

/**
 * Thin wrapper around the WebSocket to the signaling server.
 * Only needed to set up the connection – afterwards everything runs over WebRTC.
 */
export class SignalingClient {
  private constructor(private readonly ws: WebSocket) {}

  static connect(onMessage: (msg: ServerMessage) => void, onClose: () => void): Promise<SignalingClient> {
    // Same host/port as the page – Vite proxies /ws to the signaling server
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws`);

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.addEventListener('message', (e) => onMessage(JSON.parse(e.data as string) as ServerMessage));
        ws.addEventListener('close', onClose);
        resolve(new SignalingClient(ws));
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('Signaling-Server nicht erreichbar')), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }
}
