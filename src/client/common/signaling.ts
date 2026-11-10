import type { ClientMessage, ServerMessage } from '../../shared/protocol';

/**
 * Thin wrapper around the WebSocket to the signaling server.
 * Only needed to set up the connection – afterwards everything runs over WebRTC.
 */
export class SignalingClient {
  private constructor(
    private readonly ws: WebSocket,
    private readonly handleMessage: (messageEvent: MessageEvent) => void,
    private readonly handleClose: () => void,
  ) { }

  static connect(onMessage: (msg: ServerMessage) => void, onClose: () => void): Promise<SignalingClient> {

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const localFallbackURL = `${protocol}//${location.host}/ws`;

    // Production: VITE_SIGNALING_URI is read from .env.production at build time and points to the VPS.
    // Locally it is unset. That means same host as the page, the Vite dev server proxies /ws to server.ts.
    const url = import.meta.env.VITE_SIGNALING_URI ?? localFallbackURL;
    const ws = new WebSocket(url);

    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => {
        const handleMessage = (messageEvent: MessageEvent) => onMessage(JSON.parse(messageEvent.data as string) as ServerMessage);
        ws.addEventListener('message', handleMessage);
        ws.addEventListener('close', onClose);
        resolve(new SignalingClient(ws, handleMessage, onClose));
      }, { once: true });
      ws.addEventListener('error', () => reject(new Error('Signaling-Server nicht erreichbar!')), { once: true });
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Done with this connection: nothing it still receives is handled, and onClose isn't called. Also for a
   * connection that died without a close – the browser would only fire 'close' once its close frame times out,
   * which can take minutes. What was sent before still goes out first (e.g. 'leave-room').
   */
  close(): void {
    this.ws.removeEventListener('message', this.handleMessage);
    this.ws.removeEventListener('close', this.handleClose);
    this.ws.close();
  }
}
