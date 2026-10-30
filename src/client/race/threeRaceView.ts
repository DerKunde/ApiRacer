import type { PeerId } from '../../shared/protocol';
import { MAX_WHEEL_ANGLE, WHEEL_POSITIONS, WHEEL_RADIUS, type CarPhysics } from './carPhysics';
import { RacePhysics } from './racePhysics';
import { MAX_RACERS, type DriverInput, type RaceView } from './raceView';
import { splitScreenLayout, type Viewport } from './splitScreenLayout';
import * as THREE from 'three';

// Scene units = meters. Oval track: a ring stretched along x. Centerline radius 22, road 8 wide.
const TRACK_INNER_RADIUS = 24;
const TRACK_OUTER_RADIUS = 40;
const TRACK_STRETCH_X = 1.6;
// Start straight = the part of the ring closest to the viewer (+z); cars face −x
const START_Z = (TRACK_INNER_RADIUS + TRACK_OUTER_RADIUS) / 2;
// Chase camera relative to its car: behind (+z = backwards, the car faces −z) and above
const CHASE_CAMERA_HEIGHT = 4.5;
const CHASE_CAMERA_DISTANCE = 7;
// The camera looks at a point this far in front of the car at roof height (y = 1). Further = car lower in the image.
const CHASE_CAMERA_LOOK_AHEAD = 8;
// Share of the car's roll the camera takes over
const CHASE_CAMERA_ROLL_FOLLOW = 0.25;
// How fast the camera catches up with the car's pitch and roll (higher = faster, in 1/s). Slow enough to filter the
// suspension wobble; pitch still follows fully, so the camera will tilt with a sloped track.
const CHASE_CAMERA_SMOOTHING = 4;
// Start grid: distance of each lane from the centerline, and between rows. Row spacing must be larger than the
// chase camera distance, or the car behind sits right in front of the camera and fills the view.
const GRID_LANE_OFFSET = 2.5;
const GRID_ROW_SPACING = 12;
// Gap between the split screen views in CSS pixels, filled with the border color
const DIVIDER = 2;

// Start grid, two lanes, staggered like in real races. heading = rotation around y (car forward is −z).
// The track is an ellipse, so even the "start straight" bends: each car sits on the centerline at its x
// and faces along the tangent there, otherwise the rear cars would stand on the grass.
export function startGridPose(slot: number): { x: number; z: number; heading: number } {
    const lane = slot % 2 === 0 ? -GRID_LANE_OFFSET : GRID_LANE_OFFSET;
    const along = Math.floor(slot / 2) * GRID_ROW_SPACING + (slot % 2) * GRID_ROW_SPACING / 2;

    // Centerline ellipse (x / a)² + (z / b)² = 1, solved for z on the near side (+z)
    const a = START_Z * TRACK_STRETCH_X;
    const b = START_Z;
    const centerZ = b * Math.sqrt(1 - (along / a) ** 2);
    // Slope dz/dx of the ellipse (implicit derivative). Driving towards −x, the car points along (−1, −slope).
    const slope = -(b * b * along) / (a * a * centerZ);
    // Forward (−z) rotated by heading = (−sin, −cos) → solve for heading. slope 0 (at x = 0) gives 90°.
    const heading = Math.atan2(1, slope);
    // Lane offset sideways to the driving direction (at x = 0 simply ±z)
    return { x: along - lane * Math.cos(heading), z: centerZ + lane * Math.sin(heading), heading };
}

interface Car {
    root: THREE.Group;
    // Owns the pose: root is copied from it every frame
    body: CarPhysics;
    // Pivot groups of all wheels, in the order of WHEEL_POSITIONS – moving them along y follows the suspension
    wheels: THREE.Group[];
    // The front ones among them – rotating them around y turns the wheels
    frontWheels: THREE.Group[];
    // Start grid position, kept for the whole race
    slot: number;
    camera: THREE.PerspectiveCamera;
    // Parent of the camera, in the scene instead of in root: follows the car's position and yaw directly,
    // but only the smoothed pitch and roll below
    cameraRig: THREE.Group;
    cameraPitch: number;
    cameraRoll: number;
}

export class ThreeRaceView implements RaceView {

    private readonly scene = new THREE.Scene();
    private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
    private readonly overviewCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
    private readonly overlay = document.createElement('p');
    private readonly dividerColor: THREE.Color;
    // Canvas size in CSS pixels, reused every frame instead of allocating a new Vector2
    private readonly size = new THREE.Vector2();
    // Car rotation split into angles, reused every frame. YXZ = yaw first, so pitch and roll are the car's own.
    private readonly carAngles = new THREE.Euler(0, 0, 0, 'YXZ');

    // Map keeps insertion order → join order = viewport order
    private readonly cars = new Map<PeerId, Car>();

    private readonly physics = new RacePhysics();
    // Time of the previous frame in ms, unset until the first frame
    private lastFrameTime?: number;

    constructor(container: HTMLElement) {
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        // Without the scissor test, every render() would clear the WHOLE canvas, not only its viewport
        this.renderer.setScissorTest(true);
        container.append(this.renderer.domElement);

        this.overlay.className = 'race-overlay';
        this.overlay.textContent = 'Warte auf Spieler …';
        container.append(this.overlay);

        const style = getComputedStyle(container);
        this.scene.background = new THREE.Color(style.getPropertyValue('--surface').trim());
        this.dividerColor = new THREE.Color(style.getPropertyValue('--border').trim());

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(20, 50, 30);
        this.scene.add(sun);
        this.scene.add(this.createGround(), this.createTrack());

        // Oblique view from above the start straight onto the whole track
        this.overviewCamera.position.set(0, 60, 45);
        this.overviewCamera.lookAt(0, 0, 0);

        new ResizeObserver(() => this.resize(container)).observe(container);
        this.renderer.setAnimationLoop((time) => this.render(time));
    }

    addPlayer(id: PeerId, color: string): void {
        // Safety net: the host already decides who races
        if (this.cars.has(id) || this.cars.size >= MAX_RACERS) return;
        const car = this.createCar(new THREE.Color(color), this.freeSlot());
        this.cars.set(id, car);
        this.scene.add(car.root, car.cameraRig);
        // Only the new car: the others may already be driving
        const { x, z, heading } = startGridPose(car.slot);
        car.body.place(x, z, heading);
    }

    // Only stores the values – physics and render loop read them, so 60 messages/s don't each touch the scene
    updateInput(id: PeerId, input: DriverInput): void {
        const car = this.cars.get(id);
        if (car != null) car.body.input = input;
    }

    removePlayer(id: PeerId): void {
        const car = this.cars.get(id);
        if (car == null) return;
        this.disposeCar(car);
        this.physics.removeCar(car.body);
        // The others move up to the next viewport, but stay where they are on the track
        this.cars.delete(id);
    }

    private render(time: number): void {
        // Before the size check: a hidden view must not stop the race
        const dt = (time - (this.lastFrameTime ?? time)) / 1000;
        this.physics.update(dt);
        this.lastFrameTime = time;

        this.renderer.getSize(this.size);
        // Hidden container (0 × 0) would make the aspect NaN (0 / 0)
        if (this.size.x === 0 || this.size.y === 0) return;

        for (const car of this.cars.values()) {
            car.body.copyPoseTo(car.root);
            car.wheels.forEach((wheel, i) => wheel.position.y = car.body.wheelHeights[i]);
            // Positive y rotation = counterclockwise seen from above = left → minus for "+1 = right"
            for (const wheel of car.frontWheels) wheel.rotation.y = -car.body.input.steering * MAX_WHEEL_ANGLE;
            this.updateChaseCamera(car, dt);
        }

        // Clear the whole canvas in the divider color first; the views below leave a DIVIDER gap around them
        this.renderer.setScissor(0, 0, this.size.x, this.size.y);
        this.renderer.setClearColor(this.dividerColor);
        this.renderer.clear();

        const layout = splitScreenLayout(this.cars.size);
        const cameras = [...this.cars.values()].map((car) => car.camera);
        layout.players.forEach((viewport, i) => this.renderView(viewport, cameras[i]));
        if (layout.overview) this.renderView(layout.overview, this.overviewCamera);

        this.overlay.hidden = this.cars.size > 0;
    }

    private updateChaseCamera(car: Car, dt: number): void {
        this.carAngles.setFromQuaternion(car.root.quaternion);
        // damp() instead of a fixed factor per frame: same camera behavior at any frame rate
        car.cameraPitch = THREE.MathUtils.damp(car.cameraPitch, this.carAngles.x, CHASE_CAMERA_SMOOTHING, dt);
        car.cameraRoll = THREE.MathUtils.damp(car.cameraRoll, this.carAngles.z * CHASE_CAMERA_ROLL_FOLLOW, CHASE_CAMERA_SMOOTHING, dt);
        car.cameraRig.position.copy(car.root.position);
        car.cameraRig.rotation.set(car.cameraPitch, this.carAngles.y, car.cameraRoll, 'YXZ');
    }

    // Draws the scene through one camera into one part of the canvas
    private renderView(viewport: Viewport, camera: THREE.PerspectiveCamera): void {
        // Normalized → CSS pixels (three.js multiplies by the pixel ratio itself), inset by half the divider
        const x = viewport.x * this.size.x + DIVIDER / 2;
        const y = viewport.y * this.size.y + DIVIDER / 2;
        const width = viewport.width * this.size.x - DIVIDER;
        const height = viewport.height * this.size.y - DIVIDER;

        // Viewport = where the image is mapped to, scissor = which pixels may be touched (incl. clearing)
        this.renderer.setViewport(x, y, width, height);
        this.renderer.setScissor(x, y, width, height);
        // Each view has its own shape (full, half, quarter) → the camera needs that aspect, or the image is squashed
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        this.renderer.render(this.scene, camera);
    }

    private createGround(): THREE.Mesh {
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(200, 200),
            new THREE.MeshStandardMaterial({ color: 0x4f7f3a, roughness: 1 }),
        );
        // PlaneGeometry lies in the xy plane → tilt it flat onto the ground (xz)
        ground.rotation.x = -Math.PI / 2;
        return ground;
    }

    // Placeholder oval: a flat ring stretched along x, slightly above the ground (no z-fighting)
    private createTrack(): THREE.Group {
        const track = new THREE.Group();
        const road = new THREE.Mesh(
            new THREE.RingGeometry(TRACK_INNER_RADIUS, TRACK_OUTER_RADIUS, 96),
            new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.9 }),
        );
        road.rotation.x = -Math.PI / 2;
        road.position.y = 0.01;
        road.scale.x = TRACK_STRETCH_X;

        const startLine = new THREE.Mesh(
            new THREE.PlaneGeometry(1, TRACK_OUTER_RADIUS - TRACK_INNER_RADIUS),
            new THREE.MeshStandardMaterial({ color: 0xffffff }),
        );
        startLine.rotation.x = -Math.PI / 2;
        startLine.position.set(-3, 0.02, START_Z);

        track.add(road, startLine);
        return track;
    }

    // Car model: forward = −z (three.js convention, like cameras)
    private createCar(color: THREE.Color, slot: number): Car {
        const root = new THREE.Group();

        const body = new THREE.Mesh(
            new THREE.BoxGeometry(1.8, 0.6, 4),
            new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.5 }),
        );
        body.position.y = 0.6;
        const cabin = new THREE.Mesh(
            new THREE.BoxGeometry(1.5, 0.5, 2),
            new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.3 }),
        );
        cabin.position.set(0, 1.15, 0.3);
        root.add(body, cabin);

        const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 });
        const wheels = WHEEL_POSITIONS.map(({ x, z }) => {
            // Cylinder axis is y → turn it onto x so the wheel rolls forward
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 16), wheelMaterial);
            wheel.rotation.z = Math.PI / 2;
            // Own pivot group: steering rotates the pivot around y, the wheel keeps its own tilt inside it.
            // Its height comes from the suspension every frame.
            const pivot = new THREE.Group();
            pivot.position.set(x, WHEEL_RADIUS, z);
            pivot.add(wheel);
            root.add(pivot);
            return pivot;
        });
        const frontWheels = wheels.filter((_, i) => WHEEL_POSITIONS[i].z < 0);

        // Aspect is set per frame in renderView (depends on the viewport)
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
        camera.position.set(0, CHASE_CAMERA_HEIGHT, CHASE_CAMERA_DISTANCE);
        // Tilt down to the look-ahead point. Set directly instead of lookAt(): lookAt expects world coordinates,
        // the camera lives in the rig's.
        camera.rotation.x = -Math.atan2(CHASE_CAMERA_HEIGHT - 1, CHASE_CAMERA_DISTANCE + CHASE_CAMERA_LOOK_AHEAD);
        const cameraRig = new THREE.Group();
        cameraRig.add(camera);

        return { root, body: this.physics.addCar(), wheels, frontWheels, slot, camera, cameraRig, cameraPitch: 0, cameraRoll: 0 };
    }

    // Lowest slot nobody holds: after a player left, the size of the map could point to a slot still in use
    private freeSlot(): number {
        const taken = new Set([...this.cars.values()].map((car) => car.slot));
        let slot = 0;
        while (taken.has(slot)) slot++;
        return slot;
    }

    // Removing from the scene only stops drawing – geometries and materials keep their GPU buffers until disposed.
    // A Set collects each material once (the wheel material is shared by all four wheels).
    private disposeCar(car: Car): void {
        car.root.removeFromParent();
        car.cameraRig.removeFromParent();
        const materials = new Set<THREE.Material>();
        car.root.traverse((obj) => {
            if (!(obj instanceof THREE.Mesh)) return;
            obj.geometry.dispose();
            const objMaterials: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
            objMaterials.forEach((material) => materials.add(material));
        });
        materials.forEach((material) => material.dispose());
    }

    // Called by the ResizeObserver; the camera aspects are updated per view in renderView
    private resize(container: HTMLElement): void {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;
        this.renderer.setSize(width, height);
    }
}
