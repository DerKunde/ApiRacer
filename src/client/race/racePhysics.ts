import RAPIER from '@dimforge/rapier3d-compat';

// Physics always advances in steps of this size, whatever the frame rate – springs get unstable with a varying dt
const FIXED_STEP = 1 / 120;
// Longest frame the physics catches up on. The render loop pauses in a background tab; without this limit
// the next frame would have to simulate the whole pause at once.
const MAX_FRAME_TIME = 0.1;
const GRAVITY = { x: 0, y: -9.81, z: 0 };
// Ground collider, top surface at y = 0. Half extents, so the same 200 × 200 as the visible ground.
const GROUND_HALF_SIZE = 100;
const GROUND_HALF_HEIGHT = 1;

// Loads the WebAssembly module – must have finished before the first RacePhysics is created
export async function initPhysics(): Promise<void> {
    await RAPIER.init();
}

export class RacePhysics {

    private readonly world = new RAPIER.World(GRAVITY);
    // Frame time not yet simulated: less than one step, carried over to the next frame
    private accumulator = 0;

    constructor() {
        this.world.timestep = FIXED_STEP;
        this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(GROUND_HALF_SIZE, GROUND_HALF_HEIGHT, GROUND_HALF_SIZE)
                .setTranslation(0, -GROUND_HALF_HEIGHT, 0),
        );
    }

    // dt: seconds since the last frame
    update(dt: number): void {
        this.accumulator += Math.min(dt, MAX_FRAME_TIME);
        while (this.accumulator >= FIXED_STEP) {
            this.world.step();
            this.accumulator -= FIXED_STEP;
        }
    }
}
