import type { PeerId } from '../shared/protocol';
import type { Quaternion } from './mobileDeviceSensors';
import type { OrientationView } from './orientationView';
import * as THREE from 'three';

export class ThreeOrientationView implements OrientationView {

    private readonly scene = new THREE.Scene();
    private readonly camera: THREE.PerspectiveCamera;
    private readonly renderer: THREE.WebGLRenderer;
    private readonly handyMesh: THREE.Mesh;

    private latestQuaternion: Quaternion | null = null;

    constructor(container: HTMLElement) {
        this.camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer();

        this.renderer.setSize(container.clientWidth, container.clientHeight);
        container.append(this.renderer.domElement);

        const bg = getComputedStyle(container).getPropertyValue('--bg').trim();
        this.scene.background = new THREE.Color(bg);

        // Device coordinates (1 unit = 10 cm, iPhone 13 Pro Max): x width, y towards the top edge, z out of the screen
        const width = 0.78, height = 1.61, depth = 0.08;
        const geometry = new THREE.BoxGeometry(width, height, depth);
        // One material per box side, fixed order: +x, -x, +y, -y, +z (screen), -z (back)
        const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x8a8f98, metalness: 0.3, roughness: 0.5 });
        const screenMaterial = new THREE.MeshStandardMaterial({ color: 0x1a3a8f, roughness: 0.2 });
        const materials = [bodyMaterial, bodyMaterial, bodyMaterial, bodyMaterial, screenMaterial, bodyMaterial];
        const mockPhone = new THREE.Mesh(geometry, materials);
        this.handyMesh = mockPhone;

        // Notch with the front camera at the top of the screen – a plain box would look the same rotated by 180°
        const notch = new THREE.Mesh(
            new THREE.BoxGeometry(0.26, 0.05, 0.004),
            new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.4 }),
        );
        // Child of the phone → rotates with it; slightly in front of the screen so it doesn't flicker (z-fighting)
        notch.position.set(0, height / 2 - 0.045, depth / 2 + 0.002);
        mockPhone.add(notch);

        // Ambient: weak base brightness from everywhere, so sides facing away from the sun aren't pitch black
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
        this.scene.add(ambientLight);

        // Directional: parallel rays like sunlight, shining from `position` towards the origin.
        // Every side gets a different brightness depending on its angle to the light → the box looks 3D.
        const directionalLight = new THREE.DirectionalLight(0xffffff, 2);
        directionalLight.position.set(1, 3, 2);
        this.scene.add(directionalLight);

        this.scene.add(mockPhone);

        this.camera.position.z = 5;

        this.renderer.setAnimationLoop(() => this.render());
    }

    // TODO: one mock phone per peer (Map<PeerId, …>, placed in a row, distinct colors). Until then all phones
    // drive the same mesh and the id is unused – the leading `_` tells TypeScript that's intended
    // (noUnusedParameters would otherwise fail `npm run build`).
    addPeer(_id: PeerId): void {

    }

    updatePeer(_id: PeerId, quaternion: Quaternion): void {
        this.latestQuaternion = quaternion;
    }

    removePeer(_id: PeerId): void {

    }

    private render(): void {
        if (this.latestQuaternion != null) {
            this.handyMesh.quaternion.fromArray(this.latestQuaternion);
        }
        this.renderer.render(this.scene, this.camera);
    }
}