// Cap for the WebGL canvas: sharp on HiDPI screens, but the pixel count grows with the square of the ratio
// (3 → 9× the pixels of 1), and antialiasing comes on top
const MAX_PIXEL_RATIO = 2;

/**
 * Pixel ratio for a three.js renderer. Read again on every resize: browser zoom and moving the window to a beamer
 * or another screen change devicePixelRatio.
 */
export function rendererPixelRatio(): number {
  return Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
}
