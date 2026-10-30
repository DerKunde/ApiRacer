// A track as plain data: stored as a JSON file per layout, no dependencies so the Vite plugin can use it as well

export interface TrackPoint {
    x: number;
    // Height, 0 for now: stored already so the files stay valid once the track gets elevation
    y: number;
    z: number;
}

export interface TrackLayout {
    // Road width in meters, the same for the whole track
    width: number;
    // Closed loop in driving order, the first point is the start
    points: TrackPoint[];
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isTrackPoint(value: unknown): value is TrackPoint {
    if (typeof value !== 'object' || value === null) return false;
    const { x, y, z } = value as Record<string, unknown>;
    return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z);
}

export function isTrackLayout(value: unknown): value is TrackLayout {
    if (typeof value !== 'object' || value === null) return false;
    const { width, points } = value as Record<string, unknown>;
    return isFiniteNumber(width) && width > 0
        && Array.isArray(points) && points.length >= 3 && points.every(isTrackPoint);
}

// The name is also the file name, so this is what keeps a name from leaving the tracks folder
export function isTrackName(name: string): boolean {
    return /^[a-z0-9-]{1,40}$/.test(name);
}
