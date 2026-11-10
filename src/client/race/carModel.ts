import * as THREE from 'three';
import { WHEEL_POSITIONS, WHEEL_RADIUS } from './carPhysics';

// Low poly car models, built from code instead of loaded from files: no asset pipeline, and every car takes the
// color of its player. Same coordinates as the physics: meters, forward = −z, origin = ground below the car's center.
//
// The body is a side view extruded across the car, with chamfered edges and the wheel arches cut out. The cabin on top
// narrows towards the roof. Windows, stripes and lights are thin parts just in front of the surface they sit on.

// A point in the side view of the car
type ProfilePoint = readonly [z: number, y: number];
type Vec3 = readonly [x: number, y: number, z: number];

export interface CarModel {
    // Everything that moves with the car's body
    root: THREE.Group;
    // Pivot groups of all wheels, in the order of WHEEL_POSITIONS. Rotating one around y steers it, moving it
    // along y follows the suspension.
    wheels: THREE.Group[];
}

interface CabinDesign {
    // Convex side view: base of the windshield, roof from front to back, base of the rear window
    points: ProfilePoint[];
    baseHalfWidth: number;
    roofHalfWidth: number;
    // Center of the pillar between the front and the rear side window. Without it, one window per side.
    pillar?: number;
}

export interface CarDesign {
    halfWidth: number;
    // Height of the underside
    floor: number;
    // Side view of the body from the bottom of the nose over the top to the bottom of the tail. The underside with
    // the wheel arches closes the outline.
    body: ProfilePoint[];
    cabin: CabinDesign;
    rimColor: number;
    // Lights, bumpers, spoilers …
    addDetails(car: CarBuilder): void;
}

// The edges of the body are cut off this much at 45° – catches the light like the facets of a low poly model
const BEVEL = 0.05;
// Few corners on purpose: the facets are the style
const ARCH_SEGMENTS = 7;
const TIRE_SEGMENTS = 14;
// Gap between the wheel and its arch
const ARCH_CLEARANCE = 0.1;
// Between a thin part (window, stripe) and the surface below it. Large enough against z-fighting in the overview.
const DECAL_OFFSET = 0.01;
// Body-colored frame around each window
const WINDOW_FRAME = 0.07;
const PILLAR_WIDTH = 0.12;
const WHEEL_WIDTH = 0.3;
const MIRROR_SIZE: Vec3 = [0.16, 0.09, 0.18];

// Axles from back to front, in the order the underside is drawn
const AXLES = [...new Set(WHEEL_POSITIONS.map(({ z }) => z))].sort((a, b) => b - a);

// Low and wide, long hood, fastback and a rear wing
const SPORT: CarDesign = {
    halfWidth: 0.95,
    floor: 0.28,
    body: [
        [-2.05, 0.28], [-2.18, 0.38], [-2.18, 0.52], [-2.08, 0.62], [-1.2, 0.76], [-0.8, 0.8],
        [1.25, 0.8], [1.92, 0.86], [2.1, 0.82], [2.1, 0.45], [2.0, 0.28],
    ],
    cabin: {
        points: [[-0.8, 0.8], [0, 1.26], [0.45, 1.28], [1.25, 0.8]],
        baseHalfWidth: 0.85,
        roofHalfWidth: 0.62,
        pillar: 0.62,
    },
    rimColor: 0xc8a45c,
    addDetails(car) {
        const { trim, headlight, taillight, chrome, plate } = car.materials;
        // Splitter and air intake under the nose
        car.box(trim, [1.8, 0.04, 0.22], [0, 0.3, -2.1]);
        car.box(trim, [1.1, 0.1, 0.04], [0, 0.45, -2.18]);
        // Flat headlights on the edge between nose and hood
        car.pair(headlight, [0.4, 0.05, 0.17], [0.6, 0.615, -2.07], -0.16);
        // Light bar across the tail, diffuser and two pipes below
        car.box(taillight, [1.6, 0.07, 0.04], [0, 0.72, 2.1]);
        car.box(trim, [1.4, 0.12, 0.06], [0, 0.38, 2.08]);
        car.pair(chrome, [0.1, 0.1, 0.14], [0.36, 0.38, 2.12], 0, 'round');
        car.box(plate, [0.5, 0.12, 0.02], [0, 0.57, 2.11]);
        // Rear wing on two struts
        car.box(trim, [1.75, 0.04, 0.32], [0, 1.1, 1.86]);
        car.pair(trim, [0.05, 0.24, 0.12], [0.55, 0.97, 1.88]);
        // Air intakes in front of the rear wheels
        car.pair(trim, [0.02, 0.12, 0.35], [car.design.halfWidth, 0.56, 0.52]);
    },
};

// Long, boxy, racing stripes and lots of chrome
const MUSCLE: CarDesign = {
    halfWidth: 0.95,
    floor: 0.3,
    body: [
        [-2.12, 0.3], [-2.2, 0.4], [-2.2, 0.74], [-2.12, 0.8], [-0.6, 0.88],
        [2.12, 0.88], [2.2, 0.82], [2.2, 0.4], [2.12, 0.3],
    ],
    cabin: {
        points: [[-0.6, 0.88], [0, 1.34], [0.8, 1.35], [1.3, 0.88]],
        baseHalfWidth: 0.86,
        roofHalfWidth: 0.7,
        pillar: 0.72,
    },
    rimColor: 0xd3d7dd,
    addDetails(car) {
        const { trim, headlight, taillight, chrome, plate } = car.materials;
        const white = car.material(0xf4f4f0);
        car.stripe(white, 0.12, 0.3);
        car.stripe(white, -0.3, -0.12);
        // Hood scoop between the stripes
        car.box(trim, [0.22, 0.1, 0.6], [0, 0.88, -1.3], -0.05);
        // Chrome bumpers
        car.box(chrome, [2.0, 0.14, 0.16], [0, 0.42, -2.22]);
        car.box(chrome, [2.0, 0.14, 0.16], [0, 0.42, 2.22]);
        // Grille across the nose with two round headlights on each side
        car.box(trim, [1.5, 0.22, 0.04], [0, 0.62, -2.21]);
        car.pair(headlight, [0.15, 0.15, 0.04], [0.48, 0.62, -2.23], 0, 'round');
        car.pair(headlight, [0.15, 0.15, 0.04], [0.66, 0.62, -2.23], 0, 'round');
        car.pair(taillight, [0.55, 0.12, 0.04], [0.55, 0.7, 2.21]);
        car.box(plate, [0.5, 0.12, 0.02], [0, 0.6, 2.21]);
        // Ducktail on the trunk lid
        car.box(trim, [1.7, 0.05, 0.12], [0, 0.9, 2.1]);
    },
};

// Short and tall rally hatchback: mud flaps, extra lamps, roof spoiler
const HATCH: CarDesign = {
    halfWidth: 0.92,
    floor: 0.32,
    body: [
        [-1.95, 0.32], [-2.02, 0.42], [-2.02, 0.7], [-1.9, 0.8], [-1.0, 0.9],
        [1.95, 0.9], [2.0, 0.84], [2.0, 0.42], [1.95, 0.32],
    ],
    cabin: {
        points: [[-0.98, 0.9], [-0.15, 1.5], [1.7, 1.52], [1.92, 0.9]],
        baseHalfWidth: 0.84,
        roofHalfWidth: 0.7,
        pillar: 0.55,
    },
    rimColor: 0xeeeeee,
    addDetails(car) {
        const { trim, headlight, taillight, plate } = car.materials;
        car.box(trim, [1.9, 0.2, 0.12], [0, 0.45, -2.03]);
        car.box(trim, [1.9, 0.2, 0.12], [0, 0.45, 2.0]);
        car.box(trim, [0.7, 0.12, 0.03], [0, 0.62, -2.02]);
        car.pair(headlight, [0.36, 0.1, 0.04], [0.6, 0.64, -2.02]);
        // Rally lamps on the bumper, each in a black housing
        car.pair(trim, [0.2, 0.2, 0.05], [0.3, 0.47, -2.1], 0, 'round');
        car.pair(headlight, [0.15, 0.15, 0.03], [0.3, 0.47, -2.13], 0, 'round');
        car.pair(taillight, [0.12, 0.3, 0.04], [0.74, 0.68, 2.0]);
        car.box(plate, [0.5, 0.12, 0.02], [0, 0.65, 2.0]);
        // Roof spoiler over the rear window
        car.box(car.materials.paint, [1.4, 0.05, 0.3], [0, 1.53, 1.75], 0.1);
        // Mud flaps behind every wheel
        for (const z of AXLES) car.pair(trim, [0.3, 0.25, 0.02], [0.95, 0.3, z + WHEEL_RADIUS + ARCH_CLEARANCE + 0.03]);
        // Start number circles on the doors
        car.pair(car.material(0xf4f4f0), [0.44, 0.44, 0.02], [car.design.halfWidth, 0.6, 0], 0, 'side');
    },
};

// High, short single cab, open bed, light bar on the roof
const PICKUP: CarDesign = {
    halfWidth: 0.95,
    floor: 0.4,
    body: [
        [-2.12, 0.4], [-2.2, 0.5], [-2.2, 0.88], [-2.08, 0.98], [-1.1, 1.02], [0.38, 1.02],
        [0.38, 0.78], [2.15, 0.78], [2.2, 0.72], [2.2, 0.5], [2.12, 0.4],
    ],
    cabin: {
        points: [[-1.08, 1.02], [-0.58, 1.72], [0.3, 1.72], [0.36, 1.02]],
        baseHalfWidth: 0.88,
        roofHalfWidth: 0.78,
    },
    rimColor: 0xbfc4cc,
    addDetails(car) {
        const { paint, trim, headlight, taillight, chrome, plate } = car.materials;
        // Bed: side walls and tailgate on top of the body, a dark liner on its floor
        car.pair(paint, [0.08, 0.28, 1.82], [0.91, 0.92, 1.29]);
        car.box(paint, [1.74, 0.28, 0.08], [0, 0.92, 2.16]);
        car.box(trim, [1.72, 0.02, 1.74], [0, 0.79, 1.27]);
        // Chrome frame around a dark grille, headlights beside it
        car.box(chrome, [1.06, 0.34, 0.03], [0, 0.72, -2.2]);
        car.box(trim, [0.92, 0.24, 0.03], [0, 0.72, -2.215]);
        car.pair(headlight, [0.28, 0.16, 0.04], [0.72, 0.75, -2.2]);
        car.box(trim, [2.0, 0.2, 0.18], [0, 0.5, -2.24]);
        car.box(trim, [2.0, 0.18, 0.16], [0, 0.5, 2.24]);
        car.pair(taillight, [0.1, 0.22, 0.04], [0.89, 0.9, 2.2]);
        car.box(plate, [0.5, 0.12, 0.02], [0, 0.66, 2.2]);
        // Light bar on the front of the roof
        car.box(trim, [1.2, 0.08, 0.1], [0, 1.76, -0.42]);
        for (const x of [-0.42, -0.14, 0.14, 0.42]) car.box(headlight, [0.2, 0.05, 0.02], [x, 1.76, -0.475]);
        // Steps between the wheels
        car.pair(trim, [0.14, 0.05, 1.5], [0.95, 0.38, 0]);
    },
};

// One per start slot: with MAX_RACERS players, every car looks different
export const CAR_DESIGNS: readonly CarDesign[] = [SPORT, MUSCLE, HATCH, PICKUP];

export function createCarModel(design: CarDesign, color: THREE.Color): CarModel {
    const car = new CarBuilder(design, color);
    design.addDetails(car);
    return { root: car.root, wheels: car.wheels };
}

// Creates the body, the cabin and the wheels, and offers the details of each design a few building blocks
class CarBuilder {

    readonly root = new THREE.Group();
    readonly wheels: THREE.Group[];
    readonly materials: CarMaterials;
    readonly design: CarDesign;

    private readonly outline: THREE.Vector2[];
    private readonly cabin: CabinGeometry;

    constructor(design: CarDesign, color: THREE.Color) {
        this.design = design;
        this.materials = createMaterials(color, design.rimColor);
        this.outline = bodyOutline(design);
        const body = new THREE.Mesh(extrudeOutline(this.outline, -design.halfWidth, design.halfWidth, 0), this.materials.paint);
        this.cabin = new CabinGeometry(design.cabin);
        const cabin = new THREE.Mesh(this.cabin.shell(), this.materials.paint);
        const windows = new THREE.Mesh(this.cabin.windows(), this.materials.glass);
        this.root.add(body, cabin, windows);
        this.addMirrors();
        this.wheels = this.createWheels();
    }

    // For colors only one design needs
    material(color: THREE.ColorRepresentation): THREE.MeshStandardMaterial {
        return flatMaterial(color);
    }

    // Box centered at position. tilt: rotation around x, positive = front edge up.
    // shape 'round': a cylinder facing forward instead, size = diameter × diameter × depth.
    // shape 'side': the same, facing sideways (diameter × diameter along y and z, depth along x).
    box(material: THREE.Material, size: Vec3, position: Vec3, tilt = 0, shape: 'box' | 'round' | 'side' = 'box'): void {
        const [width, height, depth] = size;
        let geometry: THREE.BufferGeometry;
        if (shape === 'box') {
            geometry = new THREE.BoxGeometry(width, height, depth);
        } else {
            // Cylinder axis is y → turn it onto z (forward) or x (sideways)
            geometry = new THREE.CylinderGeometry(width / 2, width / 2, depth, 12);
            if (shape === 'round') geometry.rotateX(Math.PI / 2);
            else geometry.rotateZ(Math.PI / 2);
        }
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(...position);
        // Positive rotation around x lifts the front (−z)
        mesh.rotation.x = tilt;
        this.root.add(mesh);
    }

    // The same part on both sides: position.x is the one on the right
    pair(material: THREE.Material, size: Vec3, [x, y, z]: Vec3, tilt = 0, shape: 'box' | 'round' | 'side' = 'box'): void {
        this.box(material, size, [x, y, z], tilt, shape);
        this.box(material, size, [-x, y, z], tilt, shape);
    }

    // Stripe from front to back over the body and the roof, between x = from and x = to. It follows the whole outline
    // of the body (also over the nose and the tail), but on the cabin only the roof, not the windows.
    stripe(material: THREE.Material, from: number, to: number): void {
        const body = new THREE.Mesh(extrudeOutline(this.outline, from, to, DECAL_OFFSET), material);
        const roof = new THREE.Mesh(this.cabin.roofStripe(from, to), material);
        this.root.add(body, roof);
    }

    // On the doors, just behind the windshield's lower corners
    private addMirrors(): void {
        const [[baseZ, baseY], [topZ, topY]] = this.design.cabin.points;
        const y = baseY + 0.13;
        const windshieldZ = THREE.MathUtils.mapLinear(y, baseY, topY, baseZ, topZ);
        // Slightly into the cabin, so no gap shows
        const x = this.cabin.halfWidthAt(y) + MIRROR_SIZE[0] / 2 - 0.02;
        this.pair(this.materials.paint, MIRROR_SIZE, [x, y, windshieldZ + MIRROR_SIZE[2] / 2 + 0.03]);
    }

    private createWheels(): THREE.Group[] {
        // Tire: side view of half a tire, turned around its axis (y). Chamfered edges, a hole for the rim.
        const r = WHEEL_RADIUS;
        const w = WHEEL_WIDTH / 2;
        const tireGeometry = new THREE.LatheGeometry([
            new THREE.Vector2(r * 0.65, -w * 0.85),
            new THREE.Vector2(r * 0.82, -w),
            new THREE.Vector2(r, -w * 0.65),
            new THREE.Vector2(r, w * 0.65),
            new THREE.Vector2(r * 0.82, w),
            new THREE.Vector2(r * 0.65, w * 0.85),
        ], TIRE_SEGMENTS);
        // Fills the hole, slightly set back from the tire's sides; the hub stands out a bit
        const rimGeometry = new THREE.CylinderGeometry(r * 0.67, r * 0.67, WHEEL_WIDTH * 0.8, 10);
        const hubGeometry = new THREE.CylinderGeometry(r * 0.2, r * 0.2, WHEEL_WIDTH * 0.95, 6);

        return WHEEL_POSITIONS.map(({ x, z }) => {
            const wheel = new THREE.Group();
            wheel.add(
                new THREE.Mesh(tireGeometry, this.materials.tire),
                new THREE.Mesh(rimGeometry, this.materials.rim),
                new THREE.Mesh(hubGeometry, this.materials.trim),
            );
            // Axis y → x, so the wheel rolls forward
            wheel.rotation.z = Math.PI / 2;
            // Own pivot group: steering rotates the pivot around y, the wheel keeps its own tilt inside it.
            // Its height comes from the suspension every frame.
            const pivot = new THREE.Group();
            pivot.position.set(x, WHEEL_RADIUS, z);
            pivot.add(wheel);
            this.root.add(pivot);
            return pivot;
        });
    }
}

type CarMaterials = ReturnType<typeof createMaterials>;

// One set per car: the paint has the player's color, and removing a car disposes all of them
function createMaterials(color: THREE.Color, rimColor: number) {
    return {
        paint: flatMaterial(color, { roughness: 0.45, metalness: 0.1 }),
        glass: flatMaterial(0x1c2733, { roughness: 0.2, metalness: 0.3 }),
        trim: flatMaterial(0x26282c, { roughness: 0.8 }),
        // Real chrome needs something to reflect – without an environment map, low metalness looks brighter
        chrome: flatMaterial(0xcfd3d9, { roughness: 0.3, metalness: 0.3 }),
        headlight: flatMaterial(0xfff8e7, { emissive: 0xfff3d0, emissiveIntensity: 0.6 }),
        taillight: flatMaterial(0xff3040, { emissive: 0xc00010, emissiveIntensity: 0.7 }),
        plate: flatMaterial(0xf2f2ea),
        tire: flatMaterial(0x1e1f22, { roughness: 0.9 }),
        rim: flatMaterial(rimColor, { roughness: 0.4, metalness: 0.3 }),
    };
}

// Flat shaded: every face gets one color, so the model shows its facets
function flatMaterial(color: THREE.ColorRepresentation, options: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({ color, roughness: 0.6, flatShading: true, ...options });
}

// Outline of the body in the side view: the design's upper part plus the underside with an arch over every axle
function bodyOutline(design: CarDesign): THREE.Vector2[] {
    const points = design.body.map(([z, y]) => new THREE.Vector2(z, y));
    // Arch around the wheel center at rest (WHEEL_RADIUS above the ground), from where it leaves the underside
    // behind the wheel, over the top, to where it meets the underside again in front of it
    const radius = WHEEL_RADIUS + ARCH_CLEARANCE;
    const below = design.floor - WHEEL_RADIUS;
    const start = Math.atan2(below, Math.sqrt(radius * radius - below * below));
    for (const axle of AXLES) {
        for (let i = 0; i <= ARCH_SEGMENTS; i++) {
            const angle = start + (Math.PI - 2 * start) * i / ARCH_SEGMENTS;
            points.push(new THREE.Vector2(axle + radius * Math.cos(angle), WHEEL_RADIUS + radius * Math.sin(angle)));
        }
    }
    return points;
}

// The outline extruded across the car from x = from to x = to, with chamfered edges. offset > 0 puts every surface
// that far outside the outline, for parts lying on the body.
function extrudeOutline(outline: THREE.Vector2[], from: number, to: number, offset: number): THREE.ExtrudeGeometry {
    // A stripe needs no chamfer: it only has to lie on the body
    const bevel = offset > 0 ? 0 : BEVEL;
    const depth = to - from - 2 * bevel;
    const geometry = new THREE.ExtrudeGeometry(new THREE.Shape(outline), {
        depth,
        // Chamfer inwards: the side view stays exactly the outline, the caps lie at from and to
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel,
        bevelOffset: offset - bevel,
        bevelSegments: 1,
    });
    // The shape lies in the xy plane and is extruded along z. Turned by −90° around y, its x becomes the car's z and
    // the extrusion runs along −x – so first move it to −to … −from.
    geometry.translate(0, 0, -to + bevel);
    geometry.rotateY(-Math.PI / 2);
    return geometry;
}

// Cabin: a convex side view, narrowing linearly from the base to the roof
class CabinGeometry {

    private readonly points: THREE.Vector2[];
    private readonly center: THREE.Vector2;
    private readonly design: CabinDesign;
    private readonly base: number;
    private readonly roof: number;

    constructor(design: CabinDesign) {
        this.design = design;
        this.points = design.points.map(([z, y]) => new THREE.Vector2(z, y));
        const ys = this.points.map((p) => p.y);
        this.base = Math.min(...ys);
        this.roof = Math.max(...ys);
        this.center = this.points.reduce((sum, p) => sum.add(p), new THREE.Vector2()).divideScalar(this.points.length);
    }

    halfWidthAt(y: number): number {
        const t = (y - this.base) / (this.roof - this.base);
        return THREE.MathUtils.lerp(this.design.baseHalfWidth, this.design.roofHalfWidth, t);
    }

    shell(): THREE.BufferGeometry {
        const faces = new Faces();
        const { points } = this;
        points.forEach((p, i) => {
            const q = points[(i + 1) % points.length];
            faces.quad(this.corner(p, -1), this.corner(p, 1), this.corner(q, 1), this.corner(q, -1), this.outward(p, q));
        });
        const triangles = THREE.ShapeUtils.triangulateShape(points, []);
        for (const side of [-1, 1]) {
            for (const [a, b, c] of triangles) {
                faces.add(this.corner(points[a], side), this.corner(points[b], side), this.corner(points[c], side), new THREE.Vector3(side, 0, 0));
            }
        }
        return faces.toGeometry();
    }

    // Windshield (first edge), rear window (last edge before the base) and the side windows
    windows(): THREE.BufferGeometry {
        const faces = new Faces();
        const { points } = this;
        const last = points.length - 1;
        this.wallWindow(faces, points[0], points[1]);
        this.wallWindow(faces, points[last - 1], points[last]);

        const inset = insetConvex(points, WINDOW_FRAME);
        const { pillar } = this.design;
        const panes = pillar === undefined ? [inset] : [
            clipZ(inset, pillar - PILLAR_WIDTH / 2, true),
            clipZ(inset, pillar + PILLAR_WIDTH / 2, false),
        ];
        for (const pane of panes) {
            if (pane.length < 3) continue;
            for (const side of [-1, 1]) {
                const corners = pane.map((p) => new THREE.Vector3(side * (this.halfWidthAt(p.y) + DECAL_OFFSET), p.y, p.x));
                // Convex → a fan from the first corner
                for (let i = 1; i < corners.length - 1; i++) faces.add(corners[0], corners[i], corners[i + 1], new THREE.Vector3(side, 0, 0));
            }
        }
        return faces.toGeometry();
    }

    // On every roof edge (all except windshield, rear window and base), between x = from and x = to
    roofStripe(from: number, to: number): THREE.BufferGeometry {
        const faces = new Faces();
        const { points } = this;
        for (let i = 1; i < points.length - 2; i++) {
            const p = points[i];
            const q = points[i + 1];
            const up = DECAL_OFFSET;
            faces.quad(
                new THREE.Vector3(from, p.y + up, p.x), new THREE.Vector3(to, p.y + up, p.x),
                new THREE.Vector3(to, q.y + up, q.x), new THREE.Vector3(from, q.y + up, q.x),
                this.outward(p, q),
            );
        }
        return faces.toGeometry();
    }

    // Window on the face between the side view points p and q, with the frame left free around it
    private wallWindow(faces: Faces, p: THREE.Vector2, q: THREE.Vector2): void {
        const along = WINDOW_FRAME / p.distanceTo(q);
        const across = WINDOW_FRAME / (2 * this.halfWidthAt((p.y + q.y) / 2));
        const pLeft = this.corner(p, -1);
        const pRight = this.corner(p, 1);
        const qLeft = this.corner(q, -1);
        const qRight = this.corner(q, 1);
        const normal = new THREE.Vector3().crossVectors(pRight.clone().sub(pLeft), qLeft.clone().sub(pLeft)).normalize();
        if (normal.dot(this.outward(p, q)) < 0) normal.negate();
        // s across the car, t from p to q. The face is a flat trapezoid, so every point mixed from its corners lies on it.
        const at = (s: number, t: number) => new THREE.Vector3()
            .lerpVectors(pLeft.clone().lerp(pRight, s), qLeft.clone().lerp(qRight, s), t)
            .addScaledVector(normal, DECAL_OFFSET);
        faces.quad(at(across, along), at(1 - across, along), at(1 - across, 1 - along), at(across, 1 - along), normal);
    }

    private corner(p: THREE.Vector2, side: number): THREE.Vector3 {
        return new THREE.Vector3(side * this.halfWidthAt(p.y), p.y, p.x);
    }

    // Away from the cabin, for the face between p and q. Good enough to tell outside from inside: the cabin is convex.
    private outward(p: THREE.Vector2, q: THREE.Vector2): THREE.Vector3 {
        return new THREE.Vector3(0, (p.y + q.y) / 2 - this.center.y, (p.x + q.x) / 2 - this.center.x);
    }
}

// Triangles collected one by one, for shapes that no built-in geometry has
class Faces {

    private readonly positions: number[] = [];

    // Winding decides which side is the front (back faces aren't drawn) – flipped if needed to face outward
    add(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, outward: THREE.Vector3): void {
        const normal = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a));
        const [second, third] = normal.dot(outward) < 0 ? [c, b] : [b, c];
        this.positions.push(a.x, a.y, a.z, second.x, second.y, second.z, third.x, third.y, third.z);
    }

    // Corners in order around the quad
    quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, outward: THREE.Vector3): void {
        this.add(a, b, c, outward);
        this.add(a, c, d, outward);
    }

    toGeometry(): THREE.BufferGeometry {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
        // Without an index, every triangle has its own corners → one normal per face
        geometry.computeVertexNormals();
        return geometry;
    }
}

// Moves every edge of a convex polygon inwards by distance; the new corners are where neighboring edges meet
function insetConvex(points: THREE.Vector2[], distance: number): THREE.Vector2[] {
    const counterclockwise = !THREE.ShapeUtils.isClockWise(points);
    const edges = points.map((p, i) => {
        const direction = points[(i + 1) % points.length].clone().sub(p).normalize();
        // Inside is left of a counterclockwise edge
        const inward = counterclockwise ? new THREE.Vector2(-direction.y, direction.x) : new THREE.Vector2(direction.y, -direction.x);
        return { start: p.clone().addScaledVector(inward, distance), direction };
    });
    return edges.map((edge, i) => {
        const previous = edges[(i - 1 + edges.length) % edges.length];
        // previous.start + previous.direction · s = edge.start + edge.direction · t, solved for s
        const cross = previous.direction.cross(edge.direction);
        if (Math.abs(cross) < 1e-9) return edge.start;
        const s = edge.start.clone().sub(previous.start).cross(edge.direction) / cross;
        return previous.start.clone().addScaledVector(previous.direction, s);
    });
}

// The part of a convex polygon in front of (keepFront) or behind z = limit (z = x in the side view)
function clipZ(points: THREE.Vector2[], limit: number, keepFront: boolean): THREE.Vector2[] {
    const inside = (p: THREE.Vector2) => keepFront ? p.x <= limit : p.x >= limit;
    const result: THREE.Vector2[] = [];
    points.forEach((p, i) => {
        const q = points[(i + 1) % points.length];
        if (inside(p)) result.push(p);
        if (inside(p) !== inside(q)) result.push(p.clone().lerp(q, (limit - p.x) / (q.x - p.x)));
    });
    return result;
}
