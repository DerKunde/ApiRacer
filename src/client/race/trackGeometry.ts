import * as THREE from 'three';
import type { TrackLayout, TrackPoint } from '../../shared/trackLayout';

// Half of the ground's side length, for the visible ground and its collider alike
export const GROUND_HALF_SIZE = 100;
// Start grid: distance of each lane from the centerline, and between rows. Row spacing must be larger than the
// chase camera distance, or the car behind sits right in front of the camera and fills the view.
const GRID_LANE_OFFSET = 2.5;
const GRID_ROW_SPACING = 12;
// Distance of the first row behind the start line, so the first car doesn't stand on it
const GRID_START_SETBACK = 3;
// Road mesh: one sample every 2 m, but enough for a smooth curve on a short track
const ROAD_SAMPLE_SPACING = 2;
const ROAD_MIN_SAMPLES = 64;
// Slightly above the ground (no z-fighting)
const ROAD_HEIGHT = 0.01;
const MIN_TRACK_LENGTH = 1;
// Curve samples per segment when looking for the stretch closest to a new point
const NEAREST_SAMPLES_PER_SEGMENT = 40;

// Goes through all points and closes the loop. Centripetal: no overshoot or loops when points are unevenly spaced.
export function createCenterline(layout: TrackLayout): THREE.CatmullRomCurve3 {
    const points = layout.points.map(({ x, y, z }) => new THREE.Vector3(x, y, z));
    return new THREE.CatmullRomCurve3(points, true, 'centripetal');
}

export function trackLength(layout: TrackLayout): number {
    return createCenterline(layout).getLength();
}

// Enough points for a curve, and not all of them on one spot: a curve of length 0 has no direction to drive in
export function isDrivable(layout: TrackLayout): boolean {
    return layout.points.length >= 3 && trackLength(layout) >= MIN_TRACK_LENGTH;
}

// Start grid, two lanes, staggered like in real races, behind the first point against the driving direction.
// heading = rotation around y (car forward is −z).
export function startGridPose(layout: TrackLayout, slot: number): { x: number; z: number; heading: number } {
    // Still being drawn in the editor, while a player may join: the real pose follows when the race mode resets the cars
    if (!isDrivable(layout)) return { x: layout.points[0]?.x ?? 0, z: layout.points[0]?.z ?? 0, heading: 0 };

    const curve = createCenterline(layout);
    const lane = slot % 2 === 0 ? -GRID_LANE_OFFSET : GRID_LANE_OFFSET;
    const along = Math.floor(slot / 2) * GRID_ROW_SPACING + (slot % 2) * GRID_ROW_SPACING / 2 + GRID_START_SETBACK;

    // Modulo: a grid longer than the track wraps around instead of leaving the curve's range
    const u = THREE.MathUtils.euclideanModulo(-along / curve.getLength(), 1);
    const center = curve.getPointAt(u);
    const tangent = curve.getTangentAt(u);
    // Forward (−z) rotated by heading = (−sin, −cos) → solve for heading
    const heading = Math.atan2(-tangent.x, -tangent.z);
    return { x: center.x + lane * tangent.z, z: center.z - lane * tangent.x, heading };
}

// Flat ribbon along the centerline
export function createRoadGeometry(layout: TrackLayout): THREE.BufferGeometry {
    const curve = createCenterline(layout);
    const samples = Math.max(ROAD_MIN_SAMPLES, Math.ceil(curve.getLength() / ROAD_SAMPLE_SPACING));
    const halfWidth = layout.width / 2;

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < samples; i++) {
        const u = i / samples;
        const center = curve.getPointAt(u);
        const tangent = curve.getTangentAt(u);
        // Side vector within the ground plane
        const sideX = tangent.z * halfWidth;
        const sideZ = -tangent.x * halfWidth;
        positions.push(center.x - sideX, ROAD_HEIGHT, center.z - sideZ);
        positions.push(center.x + sideX, ROAD_HEIGHT, center.z + sideZ);
        normals.push(0, 1, 0, 0, 1, 0);

        // Modulo: the last quad connects back to the first pair
        const next = (i + 1) % samples;
        const [a, b, c, d] = [i * 2, i * 2 + 1, next * 2, next * 2 + 1];
        // Counterclockwise seen from above, so the top face is the visible one
        indices.push(a, c, b, b, c, d);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    return geometry;
}

// Below three points there is no curve yet: clicks append, so their order sets the driving direction.
// After that the point goes into the closest stretch, so it doesn't cut across the track.
export function addPoint(layout: TrackLayout, point: TrackPoint): TrackLayout {
    const { points } = layout;
    if (points.length < 3) return { ...layout, points: [...points, point] };

    const curve = createCenterline(layout);
    const target = new THREE.Vector3(point.x, 0, point.z);
    const sample = new THREE.Vector3();
    const samples = points.length * NEAREST_SAMPLES_PER_SEGMENT;
    let nearest = 0;
    let nearestDistance = Infinity;
    for (let i = 0; i < samples; i++) {
        curve.getPoint(i / samples, sample);
        sample.y = 0;
        const distance = sample.distanceToSquared(target);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearest = i;
        }
    }
    // getPoint: each segment takes the same share of t, whatever its length
    const insertAt = Math.floor(nearest / NEAREST_SAMPLES_PER_SEGMENT) + 1;
    return { ...layout, points: [...points.slice(0, insertAt), point, ...points.slice(insertAt)] };
}

// Exactly three is the minimum for a track. Below that, a layout is still being drawn and points may go.
export function canRemovePoint(layout: TrackLayout): boolean {
    return layout.points.length !== 3;
}

export function removePoint(layout: TrackLayout, index: number): TrackLayout {
    return { ...layout, points: layout.points.filter((_, i) => i !== index) };
}

export function movePoint(layout: TrackLayout, index: number, point: TrackPoint): TrackLayout {
    return { ...layout, points: layout.points.map((old, i) => (i === index ? point : old)) };
}

// Rotates the list: the order, and so the driving direction, stays the same
export function setStartPoint(layout: TrackLayout, index: number): TrackLayout {
    const { points } = layout;
    return { ...layout, points: [...points.slice(index), ...points.slice(0, index)] };
}

// The start point stays first
export function reverseDirection(layout: TrackLayout): TrackLayout {
    const [start, ...rest] = layout.points;
    return { ...layout, points: [start, ...rest.reverse()] };
}

export function clampToGround(point: TrackPoint): TrackPoint {
    const { clamp } = THREE.MathUtils;
    return {
        x: clamp(point.x, -GROUND_HALF_SIZE, GROUND_HALF_SIZE),
        y: point.y,
        z: clamp(point.z, -GROUND_HALF_SIZE, GROUND_HALF_SIZE),
    };
}
