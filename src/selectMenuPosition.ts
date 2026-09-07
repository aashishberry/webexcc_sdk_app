export function menuViewportShift(
  bounds: {left: number; right: number},
  viewportWidth: number,
  gutter = 8,
): number {
  if (bounds.left < gutter) return gutter - bounds.left;
  if (bounds.right > viewportWidth - gutter) return viewportWidth - gutter - bounds.right;
  return 0;
}
