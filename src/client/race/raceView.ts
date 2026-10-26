import type { PeerId } from '../../shared/protocol';

// Split screen with 2 × 2 viewports at most – further phones can join the room but get no car
export const MAX_RACERS = 4;

export interface RaceView {
    // color: any CSS color string – chosen by the host, so the peer card on the page can use the same color
    addPlayer(id: PeerId, color: string): void;
    // value: steering input from the phone, −1 (full left) .. +1 (full right)
    updateSteering(id: PeerId, value: number): void;
    removePlayer(id: PeerId): void;
}
