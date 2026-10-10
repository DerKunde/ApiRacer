/**
 * Shared message types for the browsers and the signaling server.
 *
 * Flow (star topology: every phone connects only to the host PC):
 *  1. Host (PC) creates a room and receives a room code
 *  2. Controller (phone) joins with the code, the host gets notified
 *  3. Controller sends a WebRTC offer, the host replies with an answer,
 *     both exchange ICE candidates – the server only relays these messages
 *  4. Afterwards all data flows directly over the RTCDataChannel, the server is out of the loop
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

export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** Payload the server passes between two peers without interpreting it. */
export type SignalData =
  | { kind: 'description'; description: SessionDescription }
  | { kind: 'candidate'; candidate: IceCandidate };

/** Browser → Server */
export type ClientMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; roomId: string }
  | { type: 'signal'; to: PeerId; data: SignalData };

/** Server → Browser */
export type ServerMessage =
  // lanAddresses: only sent by a local dev server, see server.ts
  | { type: 'room-created'; roomId: string; lanAddresses?: string[] }
  | { type: 'joined'; roomId: string; peerId: PeerId }
  | { type: 'peer-joined'; peerId: PeerId }
  | { type: 'peer-left'; peerId: PeerId }
  | { type: 'room-closed' }
  | { type: 'signal'; from: PeerId; data: SignalData }
  | { type: 'error'; message: string };

/** Phone ↔ PC, directly over the RTCDataChannel */
export type ChannelMessage =
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'hello'; text: string }
  // message type related to user/client steering input.
  // 'seq' counts up every message so late messages don't overrule newer ones, 'value' is the payload/steering input.
  // (-1 = full left, +1 = full right).
  | { type: 'steer'; seq: number; value: number };