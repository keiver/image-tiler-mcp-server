/**
 * Module-level session state for tracking recommend-settings calls.
 * Single-session stdio server — module-level state is the right fit.
 */

const recommendedDimensions = new Set<string>();

export function recordRecommendation(width: number, height: number): void {
  recommendedDimensions.add(`${width}x${height}`);
}

export function wasRecommended(width: number, height: number): boolean {
  return recommendedDimensions.has(`${width}x${height}`);
}

export function clearRecommendations(): void {
  recommendedDimensions.clear();
}
