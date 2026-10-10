interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
    requestPermission?: () => Promise<'granted' | 'denied'>;
}

export type DeviceHolding = 'portrait' | 'landscape-primary' | 'landscape-secondary';

// One axis must carry clearly more gravity than the other before the holding changes
const DOMINANCE_FACTOR = 1.5;
// Steering shifts gravity from x to y, so leaving landscape needs much stronger evidence (3 ≈ 72° tilt)
const LEAVE_LANDSCAPE_FACTOR = 3;
// Below this (m/s²) the phone lies too flat to tell how it is held
const MIN_GRAVITY = 3;
// Tilt degrees which count as full steering lock
const MAX_STEERING_ANGLE = 45;

/**
 * Determines how the phone is held from the gravity vector (accelerationIncludingGravity).
 * Keeps the previous value while the result is ambiguous (phone flat or diagonal) to avoid flickering.
 */
export function detectHolding(x: number, y: number, previous: DeviceHolding): DeviceHolding{
    const absX = Math.abs(x);
    const absY = Math.abs(y);

    if(absX > MIN_GRAVITY && absX > absY * DOMINANCE_FACTOR){
        return x < 0 ? 'landscape-primary' : 'landscape-secondary';
    }
    const portraitFactor = previous === 'portrait' ? DOMINANCE_FACTOR : LEAVE_LANDSCAPE_FACTOR;
    if(absY > MIN_GRAVITY && absY > absX * portraitFactor){
        return 'portrait';
    }
    return previous;
}

/** Steering angle in degrees (positive = right). In landscape the steering axis is beta, its sign depends on the side. */
export function steeringAngle(beta: number, holding: DeviceHolding): number{
    if(holding === 'landscape-primary'){
        return beta;
    }
    if(holding === 'landscape-secondary'){
        return -beta;
    }
    return 0;
}

/** Maps a steering angle (degrees, from steeringAngle) to -1 (full left) .. +1 (full right), clamped at ±MAX_STEERING_ANGLE. */
export function steeringValue(angle: number): number{
    const clampedAngle = Math.min(Math.max(angle, -MAX_STEERING_ANGLE), MAX_STEERING_ANGLE);
    return clampedAngle / MAX_STEERING_ANGLE;
}

export async function requestOrientationEventPermission(): Promise<boolean>{
    const requestPermission = (DeviceOrientationEvent as unknown as DeviceOrientationEventiOS).requestPermission;
    const iOS = typeof requestPermission === 'function';
    if(iOS){
        try{
            const response = await requestPermission();
            if(response === 'granted'){
                return true;
            }
            else{
                return false;
            }
        }
        catch(error){
            // z. B. NotAllowedError, wenn nicht direkt durch einen Klick ausgelöst
            console.error('requestPermission fehlgeschlagen:', error);
            return false;
        }
    }else{
        return true;
    }
}