import '../style.css';
import {
    needsOrientationPermission,
    probeOrientationSensor,
    querySensorPermission,
    requestOrientationEventPermission,
    waitForSensorEvent,
    type OrientationSensorName,
    type SensorPermissionName,
    type WebKitDeviceOrientationEvent,
} from './mobileDeviceSensors';
import { byId, createLogger } from './ui';

/** Sensor check page: shows OS, browser and which sensor APIs exist and deliver data on this device. */

const log = createLogger(byId('log'));
const osLabel = byId('device-os');
const browserLabel = byId('device-browser');
const secureContextLabel = byId('device-secure-context');
const userAgentLabel = byId('device-user-agent');
const apiList = byId<HTMLUListElement>('api-list');
const apiEntryTemplate = byId<HTMLTemplateElement>('api-entry');

type OperatingSystem = 'iOS' | 'iPadOS' | 'Android' | 'Windows' | 'macOS' | 'Linux' | 'unbekannt';

/** Matches the data-state values styled in style.css */
type ApiState = 'available' | 'active' | 'needs-permission' | 'denied' | 'missing' | 'error';

// How long a probe waits for the first real reading before it counts as "no data"
const PROBE_TIMEOUT_MS = 2000;

// Explanations for the DOMException names a Generic Sensor reports on start()
const SENSOR_ERROR_TEXT: Record<string, string> = {
    NotReadableError: 'Sensor nicht lesbar – vermutlich keine passende Hardware.',
    NotAllowedError: 'Zugriff verweigert.',
    SecurityError: 'Blockiert – kein sicherer Kontext oder durch Permissions-Policy gesperrt.',
};

/** One card in the API list. Keeps references to its elements, so it can still be updated after being appended. */
interface ApiEntry {
    setState(state: ApiState, label: string, detail?: string): void;
    permissionButton: HTMLButtonElement;
}

async function main(): Promise<void> {
    const os = detectOS();
    osLabel.textContent = os;
    browserLabel.textContent = detectBrowser(os);
    secureContextLabel.textContent = window.isSecureContext ? 'ja' : 'nein (Sensor-APIs evtl. nicht verfügbar)';
    userAgentLabel.textContent = navigator.userAgent;

    // Probes run in parallel; the cards still appear in this order (created synchronously before the first await)
    await Promise.all([
        checkSensorEventApi('deviceorientation', () => 'DeviceOrientationEvent' in window, probeDeviceOrientation),
        checkSensorEventApi('webkitCompassHeading', () => 'DeviceOrientationEvent' in window, probeCompassHeading),
        checkSensorEventApi('deviceorientationabsolute', () => 'ondeviceorientationabsolute' in window, probeDeviceOrientationAbsolute),
        checkSensorEventApi('devicemotion', () => 'DeviceMotionEvent' in window, probeDeviceMotion),
        // Absolute = accelerometer + gyroscope + magnetometer (compass); relative works without the magnetometer
        checkGenericSensor('AbsoluteOrientationSensor', ['accelerometer', 'gyroscope', 'magnetometer']),
        checkGenericSensor('RelativeOrientationSensor', ['accelerometer', 'gyroscope']),
    ]);
}

/** Clones the #api-entry template, fills in the name and appends the card to the API list. */
function createApiEntry(name: string): ApiEntry {
    const fragment = apiEntryTemplate.content.cloneNode(true) as DocumentFragment;
    // Look up the elements before append() – afterwards the fragment is empty (its children moved into the list)
    const stateBadge = fragment.querySelector<HTMLElement>('.api-state')!;
    const detail = fragment.querySelector<HTMLElement>('.api-detail')!;
    const permissionButton = fragment.querySelector<HTMLButtonElement>('.api-permission')!;
    fragment.querySelector('.api-name')!.textContent = name;
    apiList.append(fragment);

    return {
        permissionButton,
        setState(state, label, detailText = '') {
            stateBadge.dataset.state = state;
            stateBadge.textContent = label;
            detail.textContent = detailText;
            log(`${name}: ${label}${detailText ? ` – ${detailText}` : ''}`);
        },
    };
}

/**
 * For the event-based sensor APIs (deviceorientation…, devicemotion): `exists` (feature detection)?
 * → (iOS: permission via button) → `probe`.
 * On iOS one permission covers all of them; asking again after it was granted resolves without a prompt.
 */
async function checkSensorEventApi(
    name: string,
    exists: () => boolean,
    probe: (entry: ApiEntry) => Promise<void>,
): Promise<void> {
    const entry = createApiEntry(name);

    if (!exists()) {
        entry.setState('missing', 'nicht vorhanden');
        return;
    }
    if (needsOrientationPermission()) {
        entry.setState('needs-permission', 'Berechtigung nötig', 'iOS liefert Bewegungsdaten erst nach Zustimmung (muss per Klick angefragt werden).');
        entry.permissionButton.hidden = false;
        entry.permissionButton.addEventListener('click', async () => {
            entry.permissionButton.hidden = true;
            if (await requestOrientationEventPermission()) {
                await probe(entry);
            } else {
                entry.setState('denied', 'verweigert', 'Erneut fragen ist ggf. erst nach Neuladen bzw. Neustart von Safari möglich.');
            }
        });
        return;
    }
    await probe(entry);
}

async function probeDeviceOrientation(entry: ApiEntry): Promise<void> {
    entry.setState('available', 'wird getestet …');
    // beta/gamma come from the accelerometer, alpha additionally needs gyroscope/compass → beta decides "has data"
    const event = await waitForSensorEvent('deviceorientation', PROBE_TIMEOUT_MS, (e) => e.beta !== null);
    if (!event) {
        entry.setState('error', 'keine Daten', `Kein Messwert innerhalb von ${PROBE_TIMEOUT_MS / 1000} s – vermutlich kein Sensor.`);
        return;
    }
    entry.setState(
        'active',
        'liefert Daten',
        `alpha ${formatAngle(event.alpha)} · beta ${formatAngle(event.beta)} · gamma ${formatAngle(event.gamma)} · absolute: ${formatAbsolute(event.absolute)}`,
    );
}

/** deviceorientationabsolute (Chromium): like deviceorientation, but alpha is relative to north */
async function probeDeviceOrientationAbsolute(entry: ApiEntry): Promise<void> {
    entry.setState('available', 'wird getestet …');
    const event = await waitForSensorEvent('deviceorientationabsolute', PROBE_TIMEOUT_MS, (e) => e.alpha !== null);
    if (!event) {
        entry.setState('error', 'keine Daten', `Kein Messwert innerhalb von ${PROBE_TIMEOUT_MS / 1000} s – vermutlich kein Sensor/Kompass.`);
        return;
    }
    entry.setState(
        'active',
        'liefert Daten',
        `alpha ${formatAngle(event.alpha)} · beta ${formatAngle(event.beta)} · gamma ${formatAngle(event.gamma)} · absolute: ${formatAbsolute(event.absolute)}`,
    );
}

/** devicemotion: gravity vector (used to detect how the phone is held) */
async function probeDeviceMotion(entry: ApiEntry): Promise<void> {
    entry.setState('available', 'wird getestet …');
    const event = await waitForSensorEvent('devicemotion', PROBE_TIMEOUT_MS, (e) => e.accelerationIncludingGravity?.x != null);
    if (!event) {
        entry.setState('error', 'keine Daten', `Kein Messwert innerhalb von ${PROBE_TIMEOUT_MS / 1000} s – vermutlich kein Sensor.`);
        return;
    }
    const gravity = event.accelerationIncludingGravity;
    const rotation = event.rotationRate;
    entry.setState(
        'active',
        'liefert Daten',
        `Schwerkraft x/y/z ${formatNumber(gravity?.x)} / ${formatNumber(gravity?.y)} / ${formatNumber(gravity?.z)} m/s² · ` +
            `Drehrate ${rotation?.alpha != null ? 'vorhanden' : 'fehlt'} · Intervall ${event.interval.toFixed(0)} ms`,
    );
}

/**
 * webkitCompassHeading (WebKit only, non-standard): degrees from magnetic north, clockwise.
 * It sits on every deviceorientation event – so first wait for a real event, then look at the field:
 * undefined = browser doesn't have it, negative = compass not ready (e.g. needs calibration).
 */
async function probeCompassHeading(entry: ApiEntry): Promise<void> {
    entry.setState('available', 'wird getestet …');
    const event = await waitForSensorEvent('deviceorientation', PROBE_TIMEOUT_MS, (e) => e.beta !== null);
    if (!event) {
        entry.setState('error', 'keine Daten', `Kein deviceorientation-Event innerhalb von ${PROBE_TIMEOUT_MS / 1000} s.`);
        return;
    }
    if ((event as WebKitDeviceOrientationEvent).webkitCompassHeading === undefined) {
        entry.setState('missing', 'nicht vorhanden', 'Das Event hat kein webkitCompassHeading – nur WebKit (iOS/Safari) kennt das Feld.');
        return;
    }

    // The field exists – wait a bit longer for a valid value in case the compass is still starting up
    const compassEvent = await waitForSensorEvent('deviceorientation', PROBE_TIMEOUT_MS, (e) => {
        const heading = (e as WebKitDeviceOrientationEvent).webkitCompassHeading;
        return heading !== undefined && heading >= 0;
    });
    if (!compassEvent) {
        entry.setState('error', 'kein Kompasswert', 'Feld vorhanden, aber nur ungültige Werte (< 0) – Kompass evtl. nicht kalibriert oder gestört.');
        return;
    }
    const { webkitCompassHeading: heading, webkitCompassAccuracy: accuracy } = compassEvent as WebKitDeviceOrientationEvent;
    entry.setState(
        'active',
        'liefert Daten',
        `Richtung ${formatAngle(heading ?? null)} von Nord · Genauigkeit ${accuracy !== undefined && accuracy >= 0 ? `±${accuracy.toFixed(0)}°` : 'unbekannt'} · absolut`,
    );
}

/**
 * Generic Sensor API (Chromium only): class exists? → permissions (Permissions API) → start and wait for a reading.
 * There is no method to request these permissions – the browser decides on start(); a denied permission
 * can only be changed by the user in the site settings, so no button here.
 */
async function checkGenericSensor(name: OrientationSensorName, permissionNames: SensorPermissionName[]): Promise<void> {
    const entry = createApiEntry(name);

    if (!(name in window)) {
        entry.setState('missing', 'nicht vorhanden', 'Generic Sensor API fehlt – gibt es nur in Chromium-Browsern.');
        return;
    }

    const states = await Promise.all(permissionNames.map(querySensorPermission));
    const permissionSummary = permissionNames.map((permission, i) => `${permission}: ${states[i]}`).join(' · ');
    if (states.includes('denied')) {
        entry.setState('denied', 'verweigert', `${permissionSummary} – nur in den Website-Einstellungen änderbar.`);
        return;
    }

    entry.setState('available', 'wird getestet …', permissionSummary);
    const result = await probeOrientationSensor(name, PROBE_TIMEOUT_MS);
    switch (result.status) {
        case 'reading':
            entry.setState('active', 'liefert Daten', `Quaternion [${result.quaternion.map((v) => v.toFixed(2)).join(', ')}] · ${permissionSummary}`);
            break;
        case 'timeout':
            entry.setState('error', 'keine Daten', `Kein Messwert innerhalb von ${PROBE_TIMEOUT_MS / 1000} s. ${permissionSummary}`);
            break;
        case 'error':
            entry.setState(
                result.error === 'NotAllowedError' ? 'denied' : 'error',
                result.error,
                `${SENSOR_ERROR_TEXT[result.error] ?? 'Fehler beim Start des Sensors.'} ${permissionSummary}`,
            );
            break;
    }
}

// Typed as boolean in lib.dom, but Safari doesn't implement the property at all → undefined
function formatAbsolute(absolute: boolean | undefined): string {
    return absolute === undefined ? 'nicht angegeben (Browser kennt das Feld nicht)' : String(absolute);
}

function formatAngle(angle: number | null): string {
    return angle === null ? '–' : `${angle.toFixed(0)}°`;
}

function formatNumber(value: number | null | undefined): string {
    return value == null ? '–' : value.toFixed(1);
}

/**
 * Reads the OS from the user agent string – only for display, never to decide which API to use.
 * Order matters: Android user agents also contain "Linux", iPads since iPadOS 13 pretend to be a Mac.
 */
function detectOS(): OperatingSystem {
    const userAgent = navigator.userAgent;

    if (/iPhone|iPod/.test(userAgent)) {
        return 'iOS';
    }
    if (/iPad/.test(userAgent)) {
        return 'iPadOS';
    }
    if (/Android/.test(userAgent)) {
        return 'Android';
    }
    if (/Windows/.test(userAgent)) {
        return 'Windows';
    }
    if (/Macintosh/.test(userAgent)) {
        // A "Mac" with a touchscreen is an iPad in desktop mode (Safari's default on iPads)
        return navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS';
    }
    if (/Linux/.test(userAgent)) {
        return 'Linux';
    }
    return 'unbekannt';
}

/**
 * Reads browser name and major version from the user agent string – only for display.
 * Order matters: Edge and Electron also contain "Chrome", almost every browser contains "Safari".
 */
function detectBrowser(os: OperatingSystem): string {
    const userAgent = navigator.userAgent;

    // On iOS/iPadOS every browser has to use Apple's WebKit engine, only the name token differs
    if (os === 'iOS' || os === 'iPadOS') {
        if (/CriOS\//.test(userAgent)) {
            return `Chrome ${browserVersion(/CriOS\/(\d+)/)} (WebKit)`;
        }
        if (/FxiOS\//.test(userAgent)) {
            return `Firefox ${browserVersion(/FxiOS\/(\d+)/)} (WebKit)`;
        }
        if (/EdgiOS\//.test(userAgent)) {
            return `Edge ${browserVersion(/EdgiOS\/(\d+)/)} (WebKit)`;
        }
        return `Safari ${browserVersion(/Version\/(\d+)/)} (WebKit)`;
    }

    if (/Edg\//.test(userAgent)) {
        return `Edge ${browserVersion(/Edg\/(\d+)/)}`;
    }
    if (/SamsungBrowser\//.test(userAgent)) {
        return `Samsung Internet ${browserVersion(/SamsungBrowser\/(\d+)/)}`;
    }
    if (/Firefox\//.test(userAgent)) {
        return `Firefox ${browserVersion(/Firefox\/(\d+)/)}`;
    }
    if (/Electron\//.test(userAgent)) {
        return `Electron-App (Chromium ${browserVersion(/Chrome\/(\d+)/)})`;
    }
    if (/Chrome\//.test(userAgent)) {
        return `Chrome ${browserVersion(/Chrome\/(\d+)/)}`;
    }
    if (/Safari\//.test(userAgent)) {
        return `Safari ${browserVersion(/Version\/(\d+)/)}`;
    }
    return 'unbekannt';
}

/** First capture group of `pattern` in the user agent (the version number), '?' if it is missing. */
function browserVersion(pattern: RegExp): string {
    return navigator.userAgent.match(pattern)?.[1] ?? '?';
}

main().catch((err: unknown) => log(`❌ ${String(err)}`));
