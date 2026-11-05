import * as THREE from 'three';
import { isTrackLayout, isTrackName, type TrackLayout, type TrackPoint } from '../../shared/trackLayout';
import type { ThreeRaceView } from './threeRaceView';
import { ACTIVE_TRACK_NAME } from './track';
import {
  addPoint,
  canRemovePoint,
  clampToGround,
  isDrivable,
  movePoint,
  removePoint,
  reverseDirection,
  setStartPoint,
  trackLength,
} from './trackGeometry';

/** Dev only: host.ts loads this by dynamic import behind import.meta.env.DEV, so production never contains it. */

const ROUTE = '/__tracks';
const NEW_TRACK_WIDTH = 16;
// How close to a point a click has to be to grab it, and the size of a marker, in CSS pixels
const GRAB_RADIUS = 12;
const MARKER_RADIUS = 7;
const MARKER_HEIGHT = 1;
const POINT_COLOR = 0xffd400;
const START_COLOR = 0xffffff;
const SELECTED_COLOR = 0xff4d4d;
// Value of the layout select for "start a new one"
const NEW_OPTION = '';

function button(text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.textContent = text;
  element.addEventListener('click', onClick);
  return element;
}

function heading(text: string): HTMLHeadingElement {
  const element = document.createElement('h3');
  element.textContent = text;
  return element;
}

async function fetchNames(): Promise<string[]> {
  const res = await fetch(ROUTE);
  return (await res.json()) as string[];
}

async function fetchLayout(name: string): Promise<TrackLayout> {
  const res = await fetch(`${ROUTE}/${name}`);
  const layout: unknown = res.ok ? await res.json() : undefined;
  if (!isTrackLayout(layout)) throw new Error(`Layout ${name} nicht lesbar`);
  return layout;
}

export async function addTrackEditor(view: ThreeRaceView, testBar: HTMLElement): Promise<void> {
  let name: string | null = ACTIVE_TRACK_NAME;
  // Fresh from disk: the static import in track.ts can be stale, tracks/ isn't watched in dev
  let layout = await fetchLayout(ACTIVE_TRACK_NAME);
  let names = await fetchNames();
  let selected: number | null = null;
  let dirty = false;
  let editing = false;
  let dragging = false;
  // Grabbed point minus pointer: a point grabbed off center must not jump to the pointer
  let grabOffset = { x: 0, z: 0 };
  view.setTrack(layout);

  const markers = new THREE.Group();
  const markerGeometry = new THREE.CircleGeometry(1, 24);
  // Flat on the ground, facing the camera above
  markerGeometry.rotateX(-Math.PI / 2);
  const markerMaterials = {
    point: new THREE.MeshBasicMaterial({ color: POINT_COLOR }),
    start: new THREE.MeshBasicMaterial({ color: START_COLOR }),
    selected: new THREE.MeshBasicMaterial({ color: SELECTED_COLOR }),
  };

  const editButton = button('Edit', () => setEditing(true));
  const raceButton = button('Race', () => setEditing(false));
  testBar.append(editButton, raceButton);

  // Map and panel side by side, around the existing view
  const raceView = view.canvas.parentElement!;
  const row = document.createElement('div');
  row.className = 'track-editor';
  raceView.before(row);
  const panel = document.createElement('aside');
  panel.className = 'track-editor-panel';
  row.append(raceView, panel);

  const trackName = document.createElement('p');
  const widthInput = document.createElement('input');
  widthInput.type = 'number';
  widthInput.min = '4';
  widthInput.step = '1';
  widthInput.addEventListener('change', () => {
    const width = widthInput.valueAsNumber;
    if (width > 0) change({ ...layout, width });
    else refresh();
  });
  const widthLabel = document.createElement('label');
  widthLabel.append('Breite (m): ', widthInput);
  const lengthText = document.createElement('p');
  const reverseButton = button('Richtung umkehren', () => {
    selected = null;
    change(reverseDirection(layout));
  });

  const pointHeading = heading('');
  const startButton = button('Als Start', () => {
    if (selected === null) return;
    change(setStartPoint(layout, selected));
    selected = 0;
    refresh();
  });
  const removeButton = button('Löschen', () => {
    if (selected === null) return;
    const index = selected;
    selected = null;
    change(removePoint(layout, index));
  });
  const pointSection = document.createElement('section');
  pointSection.append(pointHeading, startButton, removeButton);

  const layoutSelect = document.createElement('select');
  layoutSelect.addEventListener('change', () => void switchLayout(layoutSelect.value));
  const saveButton = button('Speichern', () => {
    if (name !== null) void save(name);
  });
  const saveAsButton = button('Unter neuem Namen speichern', () => void saveAs());
  const status = document.createElement('p');

  panel.append(
    heading('Strecke'), trackName, widthLabel, lengthText, reverseButton,
    pointSection,
    heading('Layouts'), layoutSelect, saveButton, saveAsButton, status,
  );

  function change(next: TrackLayout): void {
    layout = next;
    dirty = true;
    view.setTrack(layout);
    refresh();
  }

  // Brings everything on screen in line with the state
  function refresh(): void {
    const drawable = isDrivable(layout);
    editButton.disabled = editing;
    raceButton.disabled = !editing || !drawable;
    panel.hidden = !editing;

    trackName.textContent = (name ?? 'Neu') + (dirty ? ' (ungespeichert)' : '');
    // Don't overwrite what's being typed
    if (document.activeElement !== widthInput) widthInput.value = String(layout.width);
    lengthText.textContent = `Länge: ${drawable ? `${Math.round(trackLength(layout))} m` : '–'}`;
    reverseButton.disabled = !drawable;

    pointSection.hidden = selected === null;
    if (selected !== null) pointHeading.textContent = `Punkt ${selected + 1}`;
    startButton.disabled = selected === 0;
    removeButton.disabled = !canRemovePoint(layout);

    layoutSelect.replaceChildren(
      ...names.map((option) => new Option(option, option)),
      new Option('Neu', NEW_OPTION),
    );
    layoutSelect.value = name ?? NEW_OPTION;
    saveButton.disabled = !drawable || name === null;
    saveAsButton.disabled = !drawable;

    updateMarkers();
  }

  function updateMarkers(): void {
    markers.clear();
    const radius = MARKER_RADIUS * view.metersPerPixel();
    layout.points.forEach(({ x, z }, i) => {
      let material = markerMaterials.point;
      if (i === 0) material = markerMaterials.start;
      if (i === selected) material = markerMaterials.selected;
      const marker = new THREE.Mesh(markerGeometry, material);
      marker.position.set(x, MARKER_HEIGHT, z);
      marker.scale.setScalar(radius);
      markers.add(marker);
    });
  }

  function setEditing(next: boolean): void {
    editing = next;
    if (editing) {
      view.startEditing(markers);
    } else {
      view.setTrack(layout);
      view.stopEditing();
    }
    refresh();
  }

  // Showing the panel shrinks the canvas, and the marker size depends on it. Registered after the view's observer,
  // so the view already has the new size.
  new ResizeObserver(updateMarkers).observe(raceView);

  function pointAt(event: PointerEvent): TrackPoint {
    const { x, z } = view.pointerToGround(event.clientX, event.clientY);
    return clampToGround({ x, y: 0, z });
  }

  function indexAt(point: TrackPoint): number | null {
    const reach = GRAB_RADIUS * view.metersPerPixel();
    let nearest: number | null = null;
    let nearestDistance = reach;
    layout.points.forEach(({ x, z }, i) => {
      const distance = Math.hypot(x - point.x, z - point.z);
      if (distance <= nearestDistance) {
        nearest = i;
        nearestDistance = distance;
      }
    });
    return nearest;
  }

  view.canvas.addEventListener('pointerdown', (event) => {
    if (!editing) return;
    const point = pointAt(event);
    selected = indexAt(point);
    grabOffset = { x: 0, z: 0 };
    if (selected !== null) {
      const grabbed = layout.points[selected];
      grabOffset = { x: grabbed.x - point.x, z: grabbed.z - point.z };
    }
    if (selected === null) {
      const before = layout.points;
      const next = addPoint(layout, point);
      selected = next.points.findIndex((p, i) => p !== before[i]);
      change(next);
    } else {
      refresh();
    }
    dragging = true;
    view.canvas.setPointerCapture(event.pointerId);
  });
  view.canvas.addEventListener('pointermove', (event) => {
    if (!dragging || selected === null) return;
    const { x, z } = view.pointerToGround(event.clientX, event.clientY);
    change(movePoint(layout, selected, clampToGround({ x: x + grabOffset.x, y: 0, z: z + grabOffset.z })));
  });
  const endDrag = (): void => {
    dragging = false;
  };
  view.canvas.addEventListener('pointerup', endDrag);
  view.canvas.addEventListener('pointercancel', endDrag);

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  async function switchLayout(value: string): Promise<void> {
    if (dirty && !confirm('Ungespeicherte Änderungen verwerfen?')) {
      refresh();
      return;
    }
    try {
      layout = value === NEW_OPTION ? { width: NEW_TRACK_WIDTH, points: [] } : await fetchLayout(value);
      name = value === NEW_OPTION ? null : value;
      selected = null;
      dirty = false;
      status.textContent = '';
      view.setTrack(layout);
    } catch (err) {
      status.textContent = `❌ ${String(err)}`;
    }
    refresh();
  }

  async function save(target: string): Promise<void> {
    const res = await fetch(`${ROUTE}/${target}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    if (!res.ok) {
      status.textContent = `❌ Speichern fehlgeschlagen (${res.status})`;
      return;
    }
    name = target;
    dirty = false;
    status.textContent = `Gespeichert als ${target}`;
    names = await fetchNames();
    refresh();
  }

  async function saveAs(): Promise<void> {
    const target = prompt('Name (Kleinbuchstaben, Ziffern, Bindestriche):');
    if (target === null) return;
    if (!isTrackName(target)) {
      status.textContent = '❌ Ungültiger Name';
      return;
    }
    if (names.includes(target) && !confirm(`${target} überschreiben?`)) return;
    await save(target);
  }

  refresh();
}
