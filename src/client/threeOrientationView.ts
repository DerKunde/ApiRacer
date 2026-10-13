import type { PeerId } from '../shared/protocol';
import type { Quaternion } from './mobileDeviceSensors';
import type { OrientationView } from './orientationView';
import * as THREE from 'three';

const PHONES_PER_ROW = 3;
// Center-to-center distance of the grid cells. Larger than the phone's diagonal (≈ 1.8 for 0.78 × 1.61),
// so neighbors never overlap however they're rotated.
const PHONE_SPACING = 2;
// Extra distance factor for the camera, so the grid doesn't fill the view edge to edge
const CAMERA_MARGIN = 1.15;

export class ThreeOrientationView implements OrientationView {

    private readonly scene = new THREE.Scene();
    private readonly camera: THREE.PerspectiveCamera;
    private readonly renderer: THREE.WebGLRenderer;

    private readonly phoneViews = new Map<PeerId, THREE.Mesh>();
    private nextColorIndex = 0;

    constructor(container: HTMLElement) {
        this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer();

        this.renderer.setSize(container.clientWidth, container.clientHeight);
        container.append(this.renderer.domElement);

        const bg = getComputedStyle(container).getPropertyValue('--bg').trim();
        this.scene.background = new THREE.Color(bg);

        // Ambient: weak base brightness from everywhere, so sides facing away from the sun aren't pitch black
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambientLight);

        // Directional: parallel rays like sunlight, shining from `position` towards the origin.
        // Every side gets a different brightness depending on its angle to the light → the box looks 3D.
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(1, 3, 2);
        this.scene.add(directionalLight);

        this.fitCameraToPhones();

        new ResizeObserver(() => this.resize(container)).observe(container);

        this.renderer.setAnimationLoop(() => this.render());
    }

    // One mock phone per peer with its own color, laid out in a grid (layoutPhones)
    addPeer(id: PeerId): void {
        const mesh = this.createNewPhoneMesh(this.colorForIndex(++this.nextColorIndex));
        this.phoneViews.set(id, mesh);
        this.scene.add(mesh);
        this.layoutPhones();
    }

    updatePeer(id: PeerId, quaternion: Quaternion): void {
        this.phoneViews.get(id)?.quaternion.fromArray(quaternion);
    }

    removePeer(id: PeerId): void {
        const mesh = this.phoneViews.get(id);
        if (mesh != null) {
            this.disposePhoneMesh(mesh);
            this.phoneViews.delete(id);
            this.layoutPhones();
        }
    }

    private render(): void {
        this.renderer.render(this.scene, this.camera);
    }

    private createNewPhoneMesh(phoneColor: THREE.Color): THREE.Mesh {
        // Device coordinates (1 unit = 10 cm, iPhone 13 Pro Max): x width, y towards the top edge, z out of the screen
        const width = 0.78, height = 1.61, depth = 0.08;
        const geometry = new THREE.BoxGeometry(width, height, depth);
        // One material per box side, fixed order: +x, -x, +y, -y, +z (screen), -z (back)
        const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.3, roughness: 0.5 });
        const screenMaterial = new THREE.MeshStandardMaterial({ color: phoneColor, roughness: 0.2 });
        const materials = [bodyMaterial, bodyMaterial, bodyMaterial, bodyMaterial, screenMaterial, bodyMaterial];
        const mockPhone = new THREE.Mesh(geometry, materials);

        // Notch with the front camera at the top of the screen – a plain box would look the same rotated by 180°
        const notch = new THREE.Mesh(
            new THREE.BoxGeometry(0.26, 0.05, 0.004),
            new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.4 }),
        );
        // Child of the phone → rotates with it; slightly in front of the screen so it doesn't flicker (z-fighting)
        notch.position.set(0, height / 2 - 0.045, depth / 2 + 0.002);
        mockPhone.add(notch);
        return mockPhone;
    }

    // Grid with PHONES_PER_ROW columns, centered around the origin (where the camera looks). Re-run after every
    // add/remove so the remaining phones close the gaps. Map keeps insertion order → oldest phone top left.
    private layoutPhones(): void {
        const count = this.phoneViews.size;
        const rows = Math.ceil(count / PHONES_PER_ROW);

        let i = 0;
        for (const phone of this.phoneViews.values()) {
            const row = Math.floor(i / PHONES_PER_ROW);
            const col = i % PHONES_PER_ROW;
            // A non-full last row is centered on its own phones, not on the full row width
            const phonesInRow = Math.min(PHONES_PER_ROW, count - row * PHONES_PER_ROW);

            // (index - (n - 1) / 2) spreads n slots symmetrically around 0, e.g. n = 3 → -1, 0, +1
            const x = (col - (phonesInRow - 1) / 2) * PHONE_SPACING;
            // Minus: row 0 at the top (+y is up on the screen)
            const y = -(row - (rows - 1) / 2) * PHONE_SPACING;
            phone.position.set(x, y, 0);
            i++;
        }
        this.fitCameraToPhones();
    }

    // Moves the camera back just far enough that the whole grid fits. Width always counts a full row, so the
    // camera only zooms out when a new row starts (and an empty view looks the same as one with 1–3 phones).
    private fitCameraToPhones(): void {
        const rows = Math.max(1, Math.ceil(this.phoneViews.size / PHONES_PER_ROW));
        const gridWidth = PHONES_PER_ROW * PHONE_SPACING;
        const gridHeight = rows * PHONE_SPACING;

        // Visible height at distance d: 2 · d · tan(fov / 2) → solve for d. Visible width = height · aspect.
        // `fov` is vertical and in degrees, Math.tan wants radians.
        const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
        const distanceForHeight = gridHeight / 2 / tanHalfFov;
        const distanceForWidth = gridWidth / 2 / (tanHalfFov * this.camera.aspect);

        // The tighter side decides; margin so tilted phones (closer to the camera) don't touch the edge
        this.camera.position.z = Math.max(distanceForHeight, distanceForWidth) * CAMERA_MARGIN;
    }

    // Removing from the scene only stops drawing – geometries and materials keep their GPU buffers until disposed.
    // traverse() visits the phone and all children (notch). A Set collects each material once, since the body
    // material sits in the array five times.
    private disposePhoneMesh(phone: THREE.Mesh): void {
        phone.removeFromParent();

        const materials = new Set<THREE.Material>();
        phone.traverse((obj) => {
            if (!(obj instanceof THREE.Mesh)) return;
            obj.geometry.dispose();
            const objMaterials: THREE.Material[] = Array.isArray(obj.material) ? obj.material : [obj.material];
            objMaterials.forEach((material) => materials.add(material));
        });
        materials.forEach((material) => material.dispose());
    }

    private colorForIndex(index: number): THREE.Color {
        return new THREE.Color().setHSL((index * 0.381966) % 1, 0.7, 0.55);
    }

    // Called by the ResizeObserver whenever the container changes size (window resize, fullscreen, beamer, zoom)
    private resize(container: HTMLElement): void {
        const width = container.clientWidth;
        const height = container.clientHeight;
        // Hidden container (0 × 0) would make the aspect NaN (0 / 0)
        if (width === 0 || height === 0) return;

        this.renderer.setSize(width, height);
        this.camera.aspect = width / height;
        // three.js caches the projection matrix. Changing 'aspect' alone has no effect until it's rebuilt
        this.camera.updateProjectionMatrix();
        // The needed camera distance depends on the aspect
        this.fitCameraToPhones();
    }
}