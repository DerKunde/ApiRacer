import type { WebGLRenderer } from 'three';

// Cap for the WebGL canvas: sharp on HiDPI screens, but the pixel count grows with the square of the ratio
// (3 → 9× the pixels of 1), and antialiasing comes on top
const MAX_PIXEL_RATIO = 2;

function rendererPixelRatio(): number {
  return Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
}

/**
 * Sizes the canvas to width × height CSS pixels at the current pixel ratio. Call it on every resize and on every
 * pixel ratio change (onPixelRatioChange).
 */
export function sizeRenderer(renderer: WebGLRenderer, width: number, height: number): void {
  const ratio = rendererPixelRatio();
  // setPixelRatio reallocates the canvas itself (at the old size) – skip it when nothing changed, setSize follows
  if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
  renderer.setSize(width, height);
}

/**
 * Calls onChange whenever devicePixelRatio changes. A ResizeObserver doesn't notice: moving the window to a beamer or
 * another screen with different scaling, or zooming a box with a fixed or capped size, changes the ratio but not the
 * box's size in CSS pixels.
 */
export function onPixelRatioChange(onChange: () => void): void {
  // The query only matches the current ratio, so it fires once when the ratio changes. Then it's set up again for
  // the new ratio.
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener('change', () => {
    onPixelRatioChange(onChange);
    onChange();
  }, { once: true });
}
