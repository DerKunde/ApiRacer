import type { PeerId } from '../../shared/protocol';

// Split screen with 2 × 2 viewports at most – further phones can join the room but get no car
export const MAX_RACERS = 4;

export interface DriverInput {
    // −1 (full left) .. +1 (full right)
    steering: number;
    // 0 = released .. 1 = fully pressed
    throttle: number;
    brake: number;
}

export interface RaceView {
    // color: any CSS color string – chosen by the host, so the peer card on the page can use the same color
    addPlayer(id: PeerId, color: string): void;
    updateInput(id: PeerId, input: DriverInput): void;
    removePlayer(id: PeerId): void;
}
