// Wheel handling for the pedalboard: tell a mouse wheel from a trackpad, and turn wheel deltas into zoom steps.

// Mouse wheels click in whole notches (legacy wheelDelta of 120, or line-mode deltas); trackpads send small,
// uneven pixel steps and often a sideways component. Once a gesture looks like a trackpad it stays one until
// the wheel has been quiet for 300 ms (a trackpad's momentum can look like notches).
export function makeWheelClassifier(quietMs = 300) {
  let kind = 'mouse';
  let at = -Infinity;
  return function classify(e, now) {
    const dx = e.deltaX || 0;
    const legacy = Math.abs(e.wheelDeltaY || 0);
    const notch = e.deltaMode === 1 || (dx === 0 && legacy >= 120 && legacy % 120 === 0);
    if (!notch) {
      kind = 'trackpad';
      at = now;
    } else if (now - at > quietMs) {
      kind = 'mouse';
    } else if (kind === 'trackpad') {
      at = now;
    }
    return kind;
  };
}

// Zoom multiplier for a vertical wheel delta in pixels: one mouse notch (100 px) is about 1.2x,
// a trackpad pinch step (a few px) is a gentle 1%. Big jumps are capped.
export function wheelZoomFactor(deltaYPx) {
  const d = Math.max(-120, Math.min(120, deltaYPx));
  return Math.pow(1.0018, -d);
}
