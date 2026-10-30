import type { TrackLayout } from '../../shared/trackLayout';
// This import selects the track production drives on: to change it, point it and the name below to another file
import activeTrack from './tracks/oval.json';

export const ACTIVE_TRACK_NAME = 'oval';
export const ACTIVE_TRACK: TrackLayout = activeTrack;
