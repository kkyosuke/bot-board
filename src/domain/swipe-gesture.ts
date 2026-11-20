export const PROVISIONAL_UNDO_WINDOW_MS = 5_000;
export const EDGE_GUARD_PX = 24;
export const DRAG_INTENT_THRESHOLD_PX = 8;
export const VERTICAL_LOCK_RATIO = 1.15;
export const SWIPE_COMMIT_DISTANCE_PX = 96;
export const SWIPE_COMMIT_VELOCITY_PX_PER_MS = 0.55;
export const SWIPE_FLICK_MIN_DISTANCE_PX = 48;
export const SWIPE_MAX_ROTATION_DEG = 11;

export type DragAxisLock = "pending" | "horizontal" | "vertical";
export type SwipeOutcome = "accepted" | "declined" | "cancel";

export interface SwipeVisualState {
  readonly translateX: number;
  readonly translateY: number;
  readonly rotationDeg: number;
  readonly progress: number;
  readonly direction: "right" | "left" | "neutral";
}

export function isProtectedScreenEdge(
  pointerClientX: number,
  containerLeft: number,
  containerWidth: number,
  isCompactTouchViewport: boolean,
): boolean {
  if (!isCompactTouchViewport || containerWidth <= EDGE_GUARD_PX * 2) {
    return false;
  }
  const offsetX = pointerClientX - containerLeft;
  return offsetX < EDGE_GUARD_PX || offsetX > containerWidth - EDGE_GUARD_PX;
}

export function resolveDragAxis(dx: number, dy: number): DragAxisLock {
  const distance = Math.hypot(dx, dy);
  if (distance < DRAG_INTENT_THRESHOLD_PX) {
    return "pending";
  }
  if (Math.abs(dy) > Math.abs(dx) * VERTICAL_LOCK_RATIO) {
    return "vertical";
  }
  return "horizontal";
}

export function resolveSwipeOutcome(dx: number, elapsedMs: number): SwipeOutcome {
  const absX = Math.abs(dx);
  const safeElapsed = Math.max(1, elapsedMs);
  const velocity = absX / safeElapsed;

  const reachedDistance = absX >= SWIPE_COMMIT_DISTANCE_PX;
  const reachedFastFlick =
    velocity >= SWIPE_COMMIT_VELOCITY_PX_PER_MS && absX >= SWIPE_FLICK_MIN_DISTANCE_PX;

  if (!reachedDistance && !reachedFastFlick) {
    return "cancel";
  }

  return dx > 0 ? "accepted" : "declined";
}

export function computeSwipeVisuals(dx: number, dy: number): SwipeVisualState {
  const progress = Math.min(1, Math.abs(dx) / SWIPE_COMMIT_DISTANCE_PX);
  const rotationDeg = Math.max(-SWIPE_MAX_ROTATION_DEG, Math.min(SWIPE_MAX_ROTATION_DEG, dx / 22));
  const direction = dx > 12 ? "right" : dx < -12 ? "left" : "neutral";

  return {
    translateX: dx,
    translateY: dy * 0.12,
    rotationDeg,
    progress,
    direction,
  };
}
