import { MAX_RACERS } from './raceView';

/** Part of the canvas in normalized coordinates (0..1). Origin bottom left, like WebGL's setViewport. */
export interface Viewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SplitScreen {
    // One viewport per player, in join order
    players: Viewport[];
    // Free area that shows the whole track from above (no players yet, or the empty 4th field with 3 players)
    overview?: Viewport;
}

const FULL: Viewport = { x: 0, y: 0, width: 1, height: 1 };
// y = 0.5 is the TOP half: WebGL counts from the bottom edge
const TOP: Viewport = { x: 0, y: 0.5, width: 1, height: 0.5 };
const BOTTOM: Viewport = { x: 0, y: 0, width: 1, height: 0.5 };
// Reading order: top left, top right, bottom left, bottom right
const QUADRANTS: Viewport[] = [
    { x: 0, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    { x: 0, y: 0, width: 0.5, height: 0.5 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5 },
];

// Classic racing game split: 1 = full screen, 2 = top/bottom (wide views suit a chase camera), 3–4 = 2 × 2
export function splitScreenLayout(playerCount: number): SplitScreen {
    const count = Math.min(playerCount, MAX_RACERS);
    switch (count) {
        case 0:
            return { players: [], overview: FULL };
        case 1:
            return { players: [FULL] };
        case 2:
            return { players: [TOP, BOTTOM] };
        case 3:
            return { players: QUADRANTS.slice(0, 3), overview: QUADRANTS[3] };
        default:
            return { players: QUADRANTS.slice(0, 4) };
    }
}
