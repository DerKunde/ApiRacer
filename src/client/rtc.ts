import type { ChannelMessage, IceServer, SignalData } from '../shared/protocol';

const STUN_SERVER = 'stun:relay.messy-desk-studio.de:3478';

export const CONTROL_CHANNEL_LABEL = 'control';

/**
 * Unreliable and unordered (like UDP): a lost steering value is not retransmitted,
 * because for real-time control only the latest value matters.
 */
export const CONTROL_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

/**
 * Builds the `RTCConfiguration` for a new `RTCPeerConnection` from the available ICE servers:
 * - STUN (own coturn) is always included – tells each device its public address for hole punching.
 * - TURN (same coturn) relays the traffic when no direct path works.
 *
 * `?relay=1` in the page URL (host or controller) sets `iceTransportPolicy: 'relay'`, i.e. only
 * TURN relay candidates are allowed – forces the TURN path for the demo. Locally (no TURN) the
 * connection then fails on purpose.
 *
 * @param iceServers TURN entries with time-limited credentials from the signaling server
 *   (`room-created` / `joined`). Undefined locally.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection#configuration
 */
export function createRtcConfig(iceServers?: IceServer[]): RTCConfiguration {
  const forceRelay = new URLSearchParams(location.search).get('relay') === '1';

  return {
    iceServers: [{ urls: STUN_SERVER }, ...(iceServers ?? [])],
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  };
}

export function sendMessage(channel: RTCDataChannel | undefined, msg: ChannelMessage): void {
  if (channel?.readyState === 'open') channel.send(JSON.stringify(msg));
}

/**
 * Applies incoming signaling data to the PeerConnection.
 * For an offer, the answer is created and returned.
 */
export async function applySignal(pc: RTCPeerConnection, data: SignalData): Promise<SignalData | null> {
  if (data.kind === 'candidate') {
    await pc.addIceCandidate(data.candidate);
    return null;
  }
  await pc.setRemoteDescription(data.description);
  if (data.description.type !== 'offer') return null;
  await pc.setLocalDescription(); // automatically creates the matching answer
  return { kind: 'description', description: pc.localDescription!.toJSON() };
}

/**
 * Runs async steps strictly one after another. Needed because ICE candidates
 * can arrive while the offer is still being processed.
 */
export function createQueue(onError: (err: unknown) => void): (task: () => Promise<void>) => void {
  let tail = Promise.resolve();
  return (task) => {
    tail = tail.then(task).catch(onError);
  };
}

/** Reads the candidate type from the SDP line, e.g. "candidate:… typ srflx …" → "srflx" */
export function candidateType(candidate: string | undefined): string {
  // Empty string = end-of-candidates indication (sent by Firefox before the final null event)
  if (candidate === '') return 'Ende der Kandidaten';
  return candidate?.match(/ typ (\w+)/)?.[1] ?? '?';
}

export interface ConnectionPath {
  local: string;
  remote: string;
  protocol: string;
}

// Fields from the WebRTC stats we need (not all of them are typed in lib.dom)
interface CandidatePairStats {
  localCandidateId: string;
  remoteCandidateId: string;
  nominated?: boolean;
  state?: string;
  selected?: boolean;
}
interface CandidateStats {
  candidateType?: string;
  protocol?: string;
}

/** Which path was actually chosen? Reads the active candidate pair from getStats(). */
export async function getConnectionPath(pc: RTCPeerConnection): Promise<ConnectionPath | null> {
  const stats = await pc.getStats();
  let pair: CandidatePairStats | undefined;

  stats.forEach((report) => {
    // Chrome/Safari: the transport points to the selected pair
    if (report.type === 'transport' && report.selectedCandidatePairId) {
      pair = stats.get(report.selectedCandidatePairId);
    }
  });
  if (!pair) {
    // Fallback (e.g. Firefox): look for a succeeded, nominated pair
    stats.forEach((report) => {
      if (report.type === 'candidate-pair' && (report.selected || (report.nominated && report.state === 'succeeded'))) {
        pair = report;
      }
    });
  }
  if (!pair) return null;

  const local = stats.get(pair.localCandidateId) as CandidateStats | undefined;
  const remote = stats.get(pair.remoteCandidateId) as CandidateStats | undefined;
  return {
    local: local?.candidateType ?? '?',
    remote: remote?.candidateType ?? '?',
    protocol: local?.protocol ?? '?',
  };
}

export function describePath(path: ConnectionPath): string {
  const types = [path.local, path.remote];
  const summary = types.includes('relay')
    ? 'Relay über TURN-Server'
    : types.includes('srflx')
      ? 'direkt durch NAT (STUN)'
      : 'direkt im lokalen Netz';
  return `${summary} · ${path.local} ↔ ${path.remote} · ${path.protocol.toUpperCase()}`;
}
