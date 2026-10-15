import type { PeerId } from '../shared/protocol';
import type { Quaternion } from './mobileDeviceSensors';

export interface OrientationView {
    // color: any CSS color string – chosen by the host, so the peer card on the page can use the same color
    addPeer(id: PeerId, color: string): void;
    updatePeer(id: PeerId, quaternion: Quaternion): void;
    removePeer(id: PeerId): void;
}