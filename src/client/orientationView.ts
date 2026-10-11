import type { PeerId } from '../shared/protocol';
import type { Quaternion } from './mobileDeviceSensors';

export interface OrientationView {
    addPeer(id: PeerId): void;
    updatePeer(id: PeerId, quaternion: Quaternion): void;
    removePeer(id: PeerId): void;
}