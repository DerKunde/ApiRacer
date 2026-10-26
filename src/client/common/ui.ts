export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Element #${id} fehlt`);
  return el as T;
}

/** Writes events to the on-page log (newest first) and to the console. */
export function createLogger(list: HTMLElement): (text: string) => void {
  return (text) => {
    const item = document.createElement('li');
    item.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    list.prepend(item);
    console.log(text);
  };
}

export function hasWebRtcSupport(): boolean {
  return 'RTCPeerConnection' in window;
}
