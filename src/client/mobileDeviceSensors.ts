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

type OrientationSource =
    'absolute-sensor'
    | 'deviceorientationabsolute'
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

/** Rotation as quaternion [x, y, z, w] (Generic Sensor API format) */
export type Quaternion = [x: number, y: number, z: number, w: number];

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