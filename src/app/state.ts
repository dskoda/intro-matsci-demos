/**
 * Global App State
 *
 * Simple state management for the platform.
 */

import type { AppState, Route } from './types';

/** Default route */
const defaultRoute: Route = {
  type: 'home',
  params: {},
};

/** Application state */
const state: AppState = {
  currentRoute: defaultRoute,
  currentDemo: null,
  isTransitioning: false,
};

/** State change listeners */
type StateListener = (state: AppState) => void;
const listeners = new Set<StateListener>();

/**
 * Get current app state (read-only copy).
 */
export function getState(): Readonly<AppState> {
  return { ...state };
}

/**
 * Get current route.
 */
export function getCurrentRoute(): Readonly<Route> {
  return { ...state.currentRoute };
}

/**
 * Update current route.
 */
export function setCurrentRoute(route: Route): void {
  state.currentRoute = route;
  notifyListeners();
}

/**
 * Set transitioning state.
 */
export function setTransitioning(transitioning: boolean): void {
  state.isTransitioning = transitioning;
  notifyListeners();
}

/**
 * Subscribe to state changes.
 */
export function subscribe(listener: StateListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Notify all listeners of state change.
 */
function notifyListeners(): void {
  const currentState = getState();
  listeners.forEach((listener) => listener(currentState));
}
