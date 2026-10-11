interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
    requestPermission?: () => Promise<'granted' | 'denied'>;
}

/** WebKit-only (iOS/Safari) extra fields on deviceorientation events – not in TypeScript's DOM types */
export interface WebKitDeviceOrientationEvent extends DeviceOrientationEvent {
    /** Degrees from magnetic north, clockwise (0–360); negative while the compass has no valid value */
    webkitCompassHeading?: number;
    /** Deviation of the heading in ± degrees; negative = invalid */
    webkitCompassAccuracy?: number;
}

/** Where the phone's rotation comes from, in order of preference (see detectOrientationSource) */
export type OrientationSource =
    'deviceorientationabsolute'
    | 'webkit-compass'
    | 'deviceorientation'
    | 'none';

/** iOS (13+) only delivers orientation/motion events after the user allowed it via requestPermission(). */
export function needsOrientationPermission(): boolean {
    return typeof (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission === 'function';
}

export async function requestOrientationEventPermission(): Promise<boolean> {
    const requestPermission = (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission;
    const iOS = typeof requestPermission === 'function';
    if (iOS) {
        try {
            const response = await requestPermission();
            if (response === 'granted') {
                return true;
            }
            else {
                return false;
            }
        }
        catch (error) {
            // z. B. NotAllowedError, wenn nicht direkt durch einen Klick ausgelöst
            console.error('requestPermission fehlgeschlagen:', error);
            return false;
        }
    } else {
        return true;
    }
}

/** Window events delivered by motion/orientation sensors */
type SensorEventType = 'deviceorientation' | 'deviceorientationabsolute' | 'devicemotion';

/**
 * Waits for the first `type` event on window that passes `accept`, or gives up after `timeoutMs`.
 * Resolves with the event, or null on timeout. The listener is removed in both cases.
 *
 * `accept` decides what counts as real data: all sensor events can arrive "empty" without hardware,
 * e.g. Chrome on a desktop fires one deviceorientation event whose values are all null.
 */
export function waitForSensorEvent<K extends SensorEventType>(
    type: K,
    timeoutMs: number,
    accept: (event: WindowEventMap[K]) => boolean,
): Promise<WindowEventMap[K] | null> {
    return new Promise((resolve) => {
        const timer = window.setTimeout(() => finish(null), timeoutMs);

        function onEvent(event: WindowEventMap[K]): void {
            if (accept(event)) {
                finish(event);
            }
        }

        function finish(result: WindowEventMap[K] | null): void {
            window.clearTimeout(timer);
            window.removeEventListener(type, onEvent);
            resolve(result);
        }

        window.addEventListener(type, onEvent);
    });
}

/**
 * Picks the best working orientation source via feature detection (never via OS/user agent):
 * 1. `deviceorientationabsolute` – absolute alpha (Chromium on Android)
 * 2. `deviceorientation` with `webkitCompassHeading` – relative alpha + compass heading (iOS/WebKit)
 * 3. `deviceorientation` – relative alpha only, yaw drifts / starts at an arbitrary direction
 *
 * Only call after the permission was granted, otherwise iOS delivers no events at all.
 * Each step waits up to `timeoutMs` for an event with real values.
 */
export async function detectOrientationSource(timeoutMs: number): Promise<OrientationSource> {
    // Skip the wait where the event doesn't exist at all (e.g. Safari)
    if ('ondeviceorientationabsolute' in window) {
        const absoluteEvent = await waitForSensorEvent('deviceorientationabsolute', timeoutMs, (event) => event.alpha !== null);
        if (absoluteEvent) {
            return 'deviceorientationabsolute';
        }
    }

    // One wait covers steps 2 and 3: the compass heading arrives on the same event
    const event = await waitForSensorEvent('deviceorientation', timeoutMs, (event) => event.alpha !== null);
    if (!event) {
        return 'none';
    }
    // Only check that the field exists: it is -1 while the compass is not calibrated yet,
    // validity is checked per event later
    if (typeof (event as WebKitDeviceOrientationEvent).webkitCompassHeading === 'number') {
        return 'webkit-compass';
    }
    return 'deviceorientation';
}

// Max tilt (degrees) at which the compass heading still equals the direction of the top edge
const MAX_FLAT_TILT = 30;
// Share of a new measurement that flows into the offset – smooths the noisy magnetometer
const COMPASS_SMOOTHING = 0.1;

/** Normalizes an angle to 0 ≤ angle < 360 */
function normalizeAngle(angle: number): number {
    return ((angle % 360) + 360) % 360;
}

/** Shortest signed difference a − b in degrees (−180 ≤ result < 180), e.g. 1° − 359° = 2° */
function angleDifference(a: number, b: number): number {
    return normalizeAngle(a - b + 180) - 180;
}

/**
 * iOS: offset (degrees) that turns the relative `alpha` into an absolute one: alphaAbs = alpha + offset.
 * `webkitCompassHeading` counts clockwise, alpha counter-clockwise → offset = 360 − heading − alpha.
 * Only measured while the phone lies roughly flat (only then the heading means "where the top edge points")
 * and the compass reports a valid accuracy; otherwise `previous` is kept (null = no offset yet).
 * New measurements are blended in gently, so the smooth gyro-based alpha stays smooth.
 */
export function updateCompassOffset(
    alpha: number,
    beta: number,
    gamma: number,
    heading: number,
    accuracy: number,
    previous: number | null,
): number | null {
    const isFlat = Math.abs(beta) < MAX_FLAT_TILT && Math.abs(gamma) < MAX_FLAT_TILT;
    if (!isFlat || heading < 0 || accuracy < 0) {
        return previous;
    }
    const measured = normalizeAngle(360 - heading - alpha);
    if (previous === null) {
        return measured;
    }
    return normalizeAngle(previous + angleDifference(measured, previous) * COMPASS_SMOOTHING);
}

/** Rotation as quaternion [x, y, z, w] (Generic Sensor API format) */
export type Quaternion = [x: number, y: number, z: number, w: number];

/**
 * Converts deviceorientation angles (degrees) into a quaternion in the W3C earth frame
 * (x east, y north, z up). The spec applies the rotations intrinsically in the order Z-X'-Y'':
 * q = qZ(alpha) · qX(beta) · qY(gamma), with qAxis(θ) = [axis · sin(θ/2), cos(θ/2)].
 * Below is that product multiplied out (same result as the spec's worked example).
 */
export function eulerToQuaternion(alpha: number, beta: number, gamma: number): Quaternion {
    const toHalfRadians = Math.PI / 360;
    const halfZ = alpha * toHalfRadians;
    const halfX = beta * toHalfRadians;
    const halfY = gamma * toHalfRadians;

    const cZ = Math.cos(halfZ), sZ = Math.sin(halfZ);
    const cX = Math.cos(halfX), sX = Math.sin(halfX);
    const cY = Math.cos(halfY), sY = Math.sin(halfY);

    return [
        sX * cY * cZ - cX * sY * sZ,
        cX * sY * cZ + sX * cY * sZ,
        cX * cY * sZ + sX * sY * cZ,
        cX * cY * cZ - sX * sY * sZ,
    ];
}

// Generic Sensor API (Chromium only) – not part of TypeScript's DOM types, so declared here
// with just the members we use.
interface OrientationSensor extends EventTarget {
    /** null until the first reading arrived */
    readonly quaternion: Quaternion | null;
    start(): void;
    stop(): void;
}

interface SensorErrorEvent extends Event {
    readonly error: DOMException;
}

type OrientationSensorConstructor = new (options?: { frequency?: number }) => OrientationSensor;

export type OrientationSensorName = 'AbsoluteOrientationSensor' | 'RelativeOrientationSensor';

/** Low-level sensors whose permissions the orientation sensors depend on */
export type SensorPermissionName = 'accelerometer' | 'gyroscope' | 'magnetometer';

/** Result of probing a Generic Sensor: data arrived, an error was reported, or nothing happened in time */
export type SensorProbeResult =
    | { status: 'reading'; quaternion: Quaternion }
    | { status: 'error'; error: string } // DOMException name, e.g. NotAllowedError, NotReadableError, SecurityError
    | { status: 'timeout' };

/**
 * Starts a Generic Sensor orientation sensor, waits for its first reading (or error / timeout)
 * and stops it again. Exists ≠ works: e.g. Chrome on a desktop has the class but no hardware.
 */
export function probeOrientationSensor(name: OrientationSensorName, timeoutMs: number): Promise<SensorProbeResult> {
    const SensorClass = (window as unknown as Partial<Record<OrientationSensorName, OrientationSensorConstructor>>)[name];
    if (!SensorClass) {
        return Promise.resolve({ status: 'error', error: 'nicht vorhanden' });
    }

    return new Promise((resolve) => {
        let sensor: OrientationSensor;
        try {
            // The constructor itself can throw, e.g. SecurityError when blocked by a permissions policy
            sensor = new SensorClass({ frequency: 60 });
        }
        catch (error) {
            resolve({ status: 'error', error: error instanceof Error ? error.name : String(error) });
            return;
        }

        const timer = window.setTimeout(() => finish({ status: 'timeout' }), timeoutMs);

        function finish(result: SensorProbeResult): void {
            window.clearTimeout(timer);
            sensor.stop();
            resolve(result);
        }

        sensor.addEventListener('reading', () => {
            if (sensor.quaternion) {
                finish({ status: 'reading', quaternion: [...sensor.quaternion] });
            }
        });
        sensor.addEventListener('error', (event) => {
            finish({ status: 'error', error: (event as SensorErrorEvent).error.name });
        });
        sensor.start();
    });
}

/**
 * Permission state of a sensor via the Permissions API ('granted' | 'prompt' | 'denied').
 * 'unbekannt' if the browser doesn't know the permission name (Firefox/Safari throw a TypeError).
 */
export async function querySensorPermission(name: SensorPermissionName): Promise<PermissionState | 'unbekannt'> {
    try {
        // The sensor names are missing in TypeScript's PermissionName type
        const status = await navigator.permissions.query({ name: name as PermissionName });
        return status.state;
    }
    catch {
        return 'unbekannt';
    }
}