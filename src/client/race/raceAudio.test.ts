import { describe, expect, it } from 'vitest';
import { TOP_SPEED } from './carPhysics';
import { engineTargets, viewportPan, type EngineTargets } from './raceAudio';
import { splitScreenLayout } from './splitScreenLayout';

// Standing still without throttle, and flat out at top speed: every target has to stay between the two
const IDLE = engineTargets(0, 0, 0, 1);
const FLAT_OUT = engineTargets(TOP_SPEED, 1, 0, 1);

describe('engineTargets', () => {
    it('keeps every target finite and in range, whatever comes in', () => {
        // AudioParam methods throw on NaN and ±Infinity – inside the render loop, that freezes the picture. The type
        // says number, but the host doesn't check the phone's messages: a tampered phone can send anything JSON allows.
        const hostile = [NaN, Infinity, -Infinity, 1e30, -1e30, 5, -3, 'x', '', null, undefined] as unknown as number[];
        const broken: { speed: number; throttle: number; pan: number; targets: EngineTargets }[] = [];
        for (const speed of hostile) {
            for (const throttle of hostile) {
                for (const pan of hostile) {
                    const targets = engineTargets(speed, throttle, pan, 1);
                    if (!inRange(targets)) broken.push({ speed, throttle, pan, targets });
                }
            }
        }
        expect(broken).toEqual([]);
    });

    it('sounds the same forward and in reverse', () => {
        expect(engineTargets(-10, 0, 0, 1)).toEqual(engineTargets(10, 0, 0, 1));
    });

    it('rises with the speed up to top speed, not beyond', () => {
        const cruising = engineTargets(TOP_SPEED / 2, 1, 0, 1);
        expect(cruising.frequency).toBeGreaterThan(IDLE.frequency);
        expect(cruising.frequency).toBeLessThan(FLAT_OUT.frequency);
        expect(engineTargets(TOP_SPEED * 2, 1, 0, 1)).toEqual(FLAT_OUT);
    });

    it('gets brighter and louder with throttle, but not higher', () => {
        const coasting = engineTargets(10, 0, 0, 1);
        const pulling = engineTargets(10, 1, 0, 1);
        expect(pulling.frequency).toBe(coasting.frequency);
        expect(pulling.cutoff).toBeGreaterThan(coasting.cutoff);
        expect(pulling.gain).toBeGreaterThan(coasting.gain);
    });

    it('scales the frequency with the pitch', () => {
        expect(engineTargets(10, 0, 0, 1.25).frequency).toBeCloseTo(engineTargets(10, 0, 0, 1).frequency * 1.25);
    });

    it('passes the pan through', () => {
        expect(engineTargets(0, 0, -0.5, 1).pan).toBe(-0.5);
    });
});

describe('viewportPan', () => {
    it('puts full screen and top/bottom in the middle', () => {
        expect(splitScreenLayout(1).players.map(viewportPan)).toEqual([0]);
        expect(splitScreenLayout(2).players.map(viewportPan)).toEqual([0, 0]);
    });

    it('splits 2 × 2 into a left and a right column, mirrored and inside the stereo field', () => {
        const [topLeft, topRight, bottomLeft, bottomRight] = splitScreenLayout(4).players.map(viewportPan);
        expect(topLeft).toBeLessThan(0);
        expect(topLeft).toBeGreaterThanOrEqual(-1);
        expect(topRight).toBe(-topLeft);
        expect(bottomLeft).toBe(topLeft);
        expect(bottomRight).toBe(topRight);
    });
});

function inRange(targets: EngineTargets): boolean {
    return [
        [targets.frequency, IDLE.frequency, FLAT_OUT.frequency],
        [targets.cutoff, IDLE.cutoff, FLAT_OUT.cutoff],
        [targets.gain, IDLE.gain, FLAT_OUT.gain],
        [targets.pan, -1, 1],
    ].every(([value, min, max]) => Number.isFinite(value) && value >= min && value <= max);
}
