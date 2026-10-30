import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

const CAR_MASS = 800;
// Mass properties set by hand: derived from the collider, the center of mass would sit in the middle of the body
// and the car would tip over easily. Inertia of a box with the size of the body (1.8 × 1.1 × 4 m).
const CENTER_OF_MASS_HEIGHT = 0.5;
const INERTIA = { x: 1147, y: 1283, z: 297 };
// Half extents of the body without the wheels. The car origin is where the ground is when the car stands still.
const COLLIDER_HALF_WIDTH = 0.9;
const COLLIDER_HALF_HEIGHT = 0.55;
const COLLIDER_HALF_LENGTH = 2;
const COLLIDER_CENTER_HEIGHT = 0.85;

// Car forward is −z, so the first two wheels are the front wheels
export const WHEEL_POSITIONS = [
    { x: -0.95, z: -1.3 },
    { x: 0.95, z: -1.3 },
    { x: -0.95, z: 1.3 },
    { x: 0.95, z: 1.3 },
];
export const WHEEL_RADIUS = 0.4;

// Where each strut starts, in car coordinates. The strut extends straight down from here.
const STRUT_TOP_HEIGHT = 0.9;
// Strut length without load. Standing still it compresses by 0.15 m (weight per wheel / stiffness), which puts
// the wheel center 0.4 above the car origin – exactly where the wheel touches the ground.
const REST_LENGTH = 0.65;
// Soft on purpose. With a quarter of the car per wheel: about 1.3 Hz and a damping ratio of 0.35, so the car
// visibly dives and bounces. A real car has a similar frequency, but about twice the damping ratio.
const SPRING_STRENGTH = 13000;
const DAMPING = 1100;

// Temporary, to see the physics at work: cars are dropped tilted from above their start position
const DROP_HEIGHT = 3;
const DROP_TILT = 0.2;

// Rigid body of one car with a raycast suspension. The view only reads the results, so it stays
// independent of Rapier.
export class CarPhysics {

    // Height of each wheel center in car coordinates, for the wheel meshes. Fully extended until the first step.
    readonly wheelHeights = WHEEL_POSITIONS.map(() => STRUT_TOP_HEIGHT - REST_LENGTH);

    private readonly world: RAPIER.World;
    private readonly body: RAPIER.RigidBody;
    // Reused for every wheel and step, only filled with new values
    private readonly up = new THREE.Vector3();
    private readonly strutTop = new THREE.Vector3();
    private readonly rotation = new THREE.Quaternion();
    private readonly ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    constructor(world: RAPIER.World) {
        this.world = world;
        // Forces keep it moving, so it must never be put to sleep
        this.body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCanSleep(false));
        world.createCollider(
            RAPIER.ColliderDesc.cuboid(COLLIDER_HALF_WIDTH, COLLIDER_HALF_HEIGHT, COLLIDER_HALF_LENGTH)
                .setTranslation(0, COLLIDER_CENTER_HEIGHT, 0)
                // Rapier expects the center of mass relative to the collider, not to the car origin
                .setMassProperties(CAR_MASS, { x: 0, y: CENTER_OF_MASS_HEIGHT - COLLIDER_CENTER_HEIGHT, z: 0 }, INERTIA, { x: 0, y: 0, z: 0, w: 1 }),
            this.body,
        );
    }

    // Teleports the car above the given spot and drops it. heading = rotation around y (car forward is −z).
    place(x: number, z: number, heading: number): void {
        // YXZ: turn around the world's y first, then tilt around the car's own axes
        const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(DROP_TILT, heading, DROP_TILT, 'YXZ'));
        this.body.setTranslation({ x, y: DROP_HEIGHT, z }, true);
        this.body.setRotation(rotation, true);
        // A teleport keeps the velocity – without the reset the car would fly on from where it was
        this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    // Called once per physics step, before the world steps
    applyForces(): void {
        // Rapier keeps added forces across steps – without the reset they would pile up
        this.body.resetForces(false);
        this.body.resetTorques(false);

        this.rotation.copy(this.body.rotation());
        this.up.set(0, 1, 0).applyQuaternion(this.rotation);
        const position = this.body.translation();

        WHEEL_POSITIONS.forEach(({ x, z }, i) => {
            this.strutTop.set(x, STRUT_TOP_HEIGHT, z).applyQuaternion(this.rotation).add(position);
            this.wheelHeights[i] = STRUT_TOP_HEIGHT - this.applySuspension();
        });
    }

    // Spring and damper of one strut (top in this.strutTop). Returns the current strut length.
    private applySuspension(): number {
        const { ray, up, strutTop } = this;
        ray.origin = strutTop;
        ray.dir = { x: -up.x, y: -up.y, z: -up.z };

        // Against every collider except this car's own. The ray ends where a fully extended wheel would touch.
        const hit = this.world.castRayAndGetNormal(ray, REST_LENGTH + WHEEL_RADIUS, true, undefined, undefined, undefined, this.body);
        // No contact: the spring has nothing to push against. A strut that starts inside the ground (car
        // on its side) also hits, with a zero normal – without this check its full compression would shoot the car away.
        if (hit == null || up.dot(hit.normal) <= 0) return REST_LENGTH;

        const length = hit.timeOfImpact - WHEEL_RADIUS;
        const compression = REST_LENGTH - length;
        // Speed along the strut: negative while the car moves towards the ground
        const velocity = up.dot(this.body.velocityAtPoint(strutTop));

        // A strut can only push: on rebound the damper must not pull the car back onto the ground
        const load = Math.max(0, compression * SPRING_STRENGTH - velocity * DAMPING);
        this.body.addForceAtPoint({ x: up.x * load, y: up.y * load, z: up.z * load }, strutTop, true);

        return length;
    }

    copyPoseTo(target: THREE.Object3D): void {
        target.position.copy(this.body.translation());
        target.quaternion.copy(this.body.rotation());
    }

    // Also removes the collider attached to the body
    remove(): void {
        this.world.removeRigidBody(this.body);
    }
}
