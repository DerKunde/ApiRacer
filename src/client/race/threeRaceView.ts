import type { PeerId } from '../../shared/protocol';
import type { TrackLayout } from '../../shared/trackLayout';
import { onPixelRatioChange, sizeRenderer } from '../common/pixelRatio';
import { MAX_WHEEL_ANGLE, WHEEL_POSITIONS, type CarPhysics } from './carPhysics';
import { CAR_DESIGNS, createCarModel } from './carModel';
import { RaceAudio, viewportPan, type EngineSound } from './raceAudio';
import { RacePhysics } from './racePhysics';
import { MAX_RACERS, type DriverInput, type RaceView } from './raceView';
import { splitScreenLayout, type Viewport } from './splitScreenLayout';
import { ACTIVE_TRACK } from './track';
import { createCenterline, createRoadGeometry, GROUND_HALF_SIZE, isDrivable, startGridPose } from './trackGeometry';
import * as THREE from 'three';

// Scene units = meters.
// Slightly above the road (no z-fighting)
const START_LINE_HEIGHT = 0.02;
const START_LINE_DEPTH = 1;
// Top-down camera of the edit mode, far enough above everything that may be on the map
const EDIT_CAMERA_HEIGHT = 100;
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
// Gap between the split screen views in CSS pixels, filled with the border color
const DIVIDER = 2;

interface Car {
    root: THREE.Group;
    // Owns the pose: root is copied from it every frame
    body: CarPhysics;
    engine: EngineSound;
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
    private readonly banner = document.createElement('p');
    private readonly dividerColor: THREE.Color;
    // Canvas size in CSS pixels, reused every frame instead of allocating a new Vector2
    private readonly size = new THREE.Vector2();
    // Car rotation split into angles, reused every frame. YXZ = yaw first, so pitch and roll are the car's own.
    private readonly carAngles = new THREE.Euler(0, 0, 0, 'YXZ');

    // Map keeps insertion order → join order = viewport order
    private readonly cars = new Map<PeerId, Car>();

    private readonly physics = new RacePhysics();
    private readonly audio = new RaceAudio();
    // Time of the previous frame in ms, unset until the first frame
    private lastFrameTime?: number;

    private track = ACTIVE_TRACK;
    private readonly road = new THREE.Group();

    // Edit mode: physics pauses, cars are hidden, the whole canvas shows the map from above
    private editing = false;
    private editOverlay?: THREE.Object3D;
    private readonly editCamera = new THREE.OrthographicCamera();

    constructor(container: HTMLElement) {
        sizeRenderer(this.renderer, container.clientWidth, container.clientHeight);
        this.renderer.getSize(this.size);
        // Without the scissor test, every render() would clear the WHOLE canvas, not only its viewport
        this.renderer.setScissorTest(true);
        container.append(this.renderer.domElement);

        this.overlay.className = 'race-overlay';
        this.overlay.textContent = 'Warte auf Spieler …';
        container.append(this.overlay);

        this.banner.className = 'race-banner';
        this.banner.hidden = true;
        container.append(this.banner);

        const style = getComputedStyle(container);
        this.scene.background = new THREE.Color(style.getPropertyValue('--surface').trim());
        this.dividerColor = new THREE.Color(style.getPropertyValue('--border').trim());

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 2);
        sun.position.set(20, 50, 30);
        this.scene.add(sun);
        this.scene.add(this.createGround(), this.road);
        this.setTrack(this.track);

        // Oblique view from above the start straight onto the whole track
        this.overviewCamera.position.set(0, 60, 45);
        this.overviewCamera.lookAt(0, 0, 0);

        // up = −z: +x is right and −z is up on the screen
        this.editCamera.position.set(0, EDIT_CAMERA_HEIGHT, 0);
        this.editCamera.up.set(0, 0, -1);
        this.editCamera.lookAt(0, 0, 0);
        this.editCamera.far = EDIT_CAMERA_HEIGHT * 2;

        new ResizeObserver(() => this.resize(container)).observe(container);
        onPixelRatioChange(() => this.resize(container));
        this.renderer.setAnimationLoop((time) => this.render(time));
    }

    addPlayer(id: PeerId, color: string): void {
        // Safety net: the host already decides who races
        if (this.cars.has(id) || this.cars.size >= MAX_RACERS) return;
        const car = this.createCar(new THREE.Color(color), this.freeSlot());
        this.cars.set(id, car);
        this.scene.add(car.root, car.cameraRig);
        // Only the new car: the others may already be driving
        this.placeOnGrid(car);
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
        this.audio.removeEngine(car.engine);
        // The others move up to the next viewport, but stay where they are on the track
        this.cars.delete(id);
    }

    // Without a usable curve there is no road either
    setTrack(layout: TrackLayout): void {
        this.track = layout;
        this.disposeObject(this.road);
        this.road.clear();
        if (!isDrivable(layout)) return;

        const road = new THREE.Mesh(
            createRoadGeometry(layout),
            new THREE.MeshStandardMaterial({ color: 0x55585e, roughness: 0.9 }),
        );
        const curve = createCenterline(layout);
        const start = curve.getPointAt(0);
        const tangent = curve.getTangentAt(0);
        const startLine = new THREE.Mesh(
            new THREE.PlaneGeometry(layout.width, START_LINE_DEPTH),
            new THREE.MeshStandardMaterial({ color: 0xffffff }),
        );
        // Flat on the ground first (x), then around y: the plane's depth lies along the driving direction
        startLine.rotation.set(-Math.PI / 2, Math.atan2(-tangent.x, -tangent.z), 0, 'YXZ');
        startLine.position.set(start.x, START_LINE_HEIGHT, start.z);
        this.road.add(road, startLine);
    }

    resetCars(): void {
        for (const car of this.cars.values()) this.placeOnGrid(car);
    }

    // Big text across the middle of the view (countdown), shown until called with undefined
    showBanner(text: string | undefined): void {
        this.banner.textContent = text ?? '';
        this.banner.hidden = text === undefined;
    }

    // overlay: whatever the editor wants to show on the map, shown until stopEditing
    startEditing(overlay: THREE.Object3D): void {
        this.editing = true;
        this.audio.setSilent(true);
        this.editOverlay = overlay;
        this.scene.add(overlay);
    }

    stopEditing(): void {
        this.editing = false;
        this.audio.setSilent(false);
        this.editOverlay?.removeFromParent();
        this.editOverlay = undefined;
        this.resetCars();
    }

    get canvas(): HTMLCanvasElement {
        return this.renderer.domElement;
    }

    // Where a pointer position lies on the ground in edit mode
    pointerToGround(clientX: number, clientY: number): { x: number; z: number } {
        const rect = this.canvas.getBoundingClientRect();
        const point = new THREE.Vector3(
            (clientX - rect.left) / rect.width * 2 - 1,
            -(clientY - rect.top) / rect.height * 2 + 1,
            0,
        ).unproject(this.editCamera);
        return { x: point.x, z: point.z };
    }

    // Size of one CSS pixel on the ground in edit mode
    metersPerPixel(): number {
        return this.editHalfHeight(this.size.x, this.size.y) * 2 / this.size.y;
    }

    // Half of the map height the edit camera shows: the whole ground stays visible at any canvas shape
    private editHalfHeight(width: number, height: number): number {
        return GROUND_HALF_SIZE * Math.max(1, height / width);
    }

    private placeOnGrid(car: Car): void {
        const { x, z, heading } = startGridPose(this.track, car.slot);
        car.body.place(x, z, heading);
    }

    private render(time: number): void {
        // Before the size check: a hidden view must not stop the race
        const dt = (time - (this.lastFrameTime ?? time)) / 1000;
        if (!this.editing) this.physics.update(dt);
        this.lastFrameTime = time;
        // Also before the size check: a hidden view keeps the race going, and so its sound
        this.updateEngines();

        this.renderer.getSize(this.size);
        // Hidden container (0 × 0) would make the aspect NaN (0 / 0)
        if (this.size.x === 0 || this.size.y === 0) return;

        for (const car of this.cars.values()) car.root.visible = !this.editing;
        if (this.editing) {
            this.renderEditView();
            return;
        }

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

    // Each engine sits in the stereo field where its car's view is on the screen
    private updateEngines(): void {
        const { players } = splitScreenLayout(this.cars.size);
        [...this.cars.values()].forEach(({ body, engine }, i) => {
            engine.update(body.forwardSpeed, body.input.throttle, viewportPan(players[i]));
        });
    }

    private updateChaseCamera(car: Car, dt: number): void {
        this.carAngles.setFromQuaternion(car.root.quaternion);
        // damp() instead of a fixed factor per frame: same camera behavior at any frame rate
        car.cameraPitch = THREE.MathUtils.damp(car.cameraPitch, this.carAngles.x, CHASE_CAMERA_SMOOTHING, dt);
        car.cameraRoll = THREE.MathUtils.damp(car.cameraRoll, this.carAngles.z * CHASE_CAMERA_ROLL_FOLLOW, CHASE_CAMERA_SMOOTHING, dt);
        car.cameraRig.position.copy(car.root.position);
        car.cameraRig.rotation.set(car.cameraPitch, this.carAngles.y, car.cameraRoll, 'YXZ');
    }

    private renderEditView(): void {
        this.overlay.hidden = true;
        const halfHeight = this.editHalfHeight(this.size.x, this.size.y);
        const halfWidth = halfHeight * this.size.x / this.size.y;
        this.editCamera.left = -halfWidth;
        this.editCamera.right = halfWidth;
        this.editCamera.top = halfHeight;
        this.editCamera.bottom = -halfHeight;
        this.editCamera.updateProjectionMatrix();

        this.renderer.setViewport(0, 0, this.size.x, this.size.y);
        this.renderer.setScissor(0, 0, this.size.x, this.size.y);
        this.renderer.render(this.scene, this.editCamera);
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
            new THREE.PlaneGeometry(GROUND_HALF_SIZE * 2, GROUND_HALF_SIZE * 2),
            new THREE.MeshStandardMaterial({ color: 0x4f7f3a, roughness: 1 }),
        );
        // PlaneGeometry lies in the xy plane → tilt it flat onto the ground (xz)
        ground.rotation.x = -Math.PI / 2;
        return ground;
    }

    // Car model: forward = −z (three.js convention, like cameras). The slot picks the model, so cars in a race differ.
    private createCar(color: THREE.Color, slot: number): Car {
        const { root, wheels } = createCarModel(CAR_DESIGNS[slot % CAR_DESIGNS.length], color);
        const frontWheels = wheels.filter((_, i) => WHEEL_POSITIONS[i].z < 0);

        // Aspect is set per frame in renderView (depends on the viewport)
        const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
        camera.position.set(0, CHASE_CAMERA_HEIGHT, CHASE_CAMERA_DISTANCE);
        // Tilt down to the look-ahead point. Set directly instead of lookAt(): lookAt expects world coordinates,
        // the camera lives in the rig's.
        camera.rotation.x = -Math.atan2(CHASE_CAMERA_HEIGHT - 1, CHASE_CAMERA_DISTANCE + CHASE_CAMERA_LOOK_AHEAD);
        const cameraRig = new THREE.Group();
        cameraRig.add(camera);

        return {
            root, body: this.physics.addCar(), engine: this.audio.addEngine(slot), wheels, frontWheels, slot, camera, cameraRig,
            cameraPitch: 0, cameraRoll: 0,
        };
    }

    // Lowest slot nobody holds: after a player left, the size of the map could point to a slot still in use
    private freeSlot(): number {
        const taken = new Set([...this.cars.values()].map((car) => car.slot));
        let slot = 0;
        while (taken.has(slot)) slot++;
        return slot;
    }

    // Removing from the scene only stops drawing – geometries and materials keep their GPU buffers until disposed.
    // A Set collects each material once (a car shares its materials between many parts, e.g. all four wheels).
    private disposeCar(car: Car): void {
        car.root.removeFromParent();
        car.cameraRig.removeFromParent();
        this.disposeObject(car.root);
    }

    private disposeObject(root: THREE.Object3D): void {
        const materials = new Set<THREE.Material>();
        root.traverse((obj) => {
            if (!(obj instanceof THREE.Mesh)) return;
            obj.geometry.dispose();
            const objMaterials: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
            objMaterials.forEach((material) => materials.add(material));
        });
        materials.forEach((material) => material.dispose());
    }

    // Called by the ResizeObserver and on pixel ratio changes; the camera aspects are updated per view in renderView
    private resize(container: HTMLElement): void {
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width === 0 || height === 0) return;
        sizeRenderer(this.renderer, width, height);
        // metersPerPixel and the editor's resize handling read it before the next frame
        this.renderer.getSize(this.size);
    }
}
