/**
 * Shared message types for the browsers and the signaling server.
 *
 * Flow (star topology: every phone connects only to the host PC):
 *  1. Host (PC) creates a room and receives a room code
 *  2. Controller (phone) joins with the code and gets a session token, the host gets notified
 *  3. Controller sends a WebRTC offer, the host replies with an answer,
 *     both exchange ICE candidates – the server only relays these messages
 *  4. Afterwards all data flows directly over the RTCDataChannel, the server is out of the loop
 *  5. If a phone loses its connection to the server, its slot stays reserved for a while (shorter if the page was
 *     closed): with 'rejoin-room' and its session token it gets the same peer ID back, and the host is told it's the
 *     same player again
 *  6. A broken WebRTC connection is restored with an ICE restart. Only if that's impossible (page reloaded,
 *     DataChannels closed) the phone sets up a new one, and the host swaps it in for the same player
 *  7. A player who leaves on purpose sends 'leave-room': the slot is freed right away
 */

export type PeerId = string;

/** The host always has the same ID, controllers get p1, p2, … */
export const HOST_ID: PeerId = 'host';

// Own types instead of RTCSessionDescriptionInit/RTCIceCandidateInit,
// because the server is compiled without DOM types. They are structurally compatible.
export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Payload the server passes between two peers without interpreting it. */
export type SignalData =
  // newConnection: phone → host, with the first offer of a connection that replaces the player's old one – the host
  // drops the old connection and answers on a new one, the player (car, color, role) stays
  | { kind: 'description'; description: SessionDescription; newConnection?: boolean }
  | { kind: 'candidate'; candidate: IceCandidate };

/** Browser → Server */
export type ClientMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; roomId: string }
  // sessionToken: from 'joined' – takes the reserved slot back instead of joining as a new player
  | { type: 'rejoin-room'; roomId: string; sessionToken: string }
  // Phone only: the player leaves on purpose ("Raum verlassen") – the slot is freed right away, no rejoin
  | { type: 'leave-room' }
  | { type: 'signal'; to: PeerId; data: SignalData };

/** Server → Browser */
export type ServerMessage =
  // lanAddresses: only sent by a local dev server, see server.ts
  | { type: 'room-created'; roomId: string; lanAddresses?: string[]; iceServers?: IceServer[] }
  // sessionToken: secret of this phone's slot in the room – lets it take the slot back after losing the connection
  | { type: 'joined'; roomId: string; peerId: PeerId; sessionToken: string; iceServers?: IceServer[] }
  | { type: 'peer-joined'; peerId: PeerId }
  // A phone that lost its connection is back in its slot: same player. If its WebRTC connection broke meanwhile,
  // the phone restores it with an ICE restart (a new offer on the existing connection).
  | { type: 'peer-rejoined'; peerId: PeerId }
  // A phone lost its connection to the server: its slot stays reserved for graceMs, then 'peer-left' follows unless
  // 'peer-rejoined' comes first. Lets the host show that the player is away instead of a frozen card.
  | { type: 'peer-away'; peerId: PeerId; graceMs: number }
  // Only once a phone is really gone. reason: 'left' = left on purpose ('leave-room'), 'timeout' = didn't come back
  // within its grace after losing the connection
  | { type: 'peer-left'; peerId: PeerId; reason: 'left' | 'timeout' }
  | { type: 'room-closed' }
  // Another connection rejoined with this phone's session token (e.g. a duplicated tab): this one must not rejoin,
  // or the two would keep taking the slot from each other
  | { type: 'session-taken-over' }
  | { type: 'signal'; from: PeerId; data: SignalData }
  // Answer to 'rejoin-room' when the slot can't be taken back (room closed, grace over, wrong token). Its own type:
  // the phone gives up its session only for this, not for any error that arrives while it rejoins.
  | { type: 'rejoin-failed'; message: string }
  | { type: 'error'; message: string };

/** Phone ↔ PC, directly over the RTCDataChannel */
export type ChannelMessage =
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'hello'; text: string }
  // Race controller input, the full state in every message (the channel drops lost messages instead of resending).
  // 'seq' counts up every message so late messages don't overrule newer ones.
  // steering: -1 = full left, +1 = full right. throttle/brake: 0 = released .. 1 = fully pressed (buttons send 0 or 1).
  | { type: 'input'; seq: number; steering: number; throttle: number; brake: number }
  | { type: 'orientation'; seq: number; quaternion: [x: number, y: number, z: number, w: number]; absolute: boolean }
  | { type: 'peer-color'; color: string }
  // Lobby, over the reliable channel: nothing gets lost, and the order stays as sent.
  // ready: phone → PC, toggled by the ready button. seq numbers the phone's requests, so it can tell which one an
  //   answer belongs to.
  // ready-state: PC → phone, what the host has recorded – the phone shows this, not its own guess. Answers every
  //   'ready' with its seq, also one the host ignored (spectator). Without seq when the host changes it on its own,
  //   and once the channel is open.
  // role: PC → phone, once the channel is open and whenever it changes. racer: false = spectator, no car.
  // race-start: PC → all phones when the host starts the race, and to every phone whose channel opens after that.
  | { type: 'ready'; ready: boolean; seq: number }
  | { type: 'ready-state'; ready: boolean; seq?: number }
  | { type: 'role'; racer: boolean }
  | { type: 'race-start' };