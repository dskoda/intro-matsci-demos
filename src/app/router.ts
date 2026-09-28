/**
 * Hash-based Router
 *
 * Handles URL routing using hash fragments.
 * Routes:
 *   #/           -> Home page
 *   #/demo/<id>  -> Demo page
 *   #/demo/<id>?param=value -> Demo with params
 */

import type { Route } from './types';
import { setCurrentRoute, getCurrentRoute } from './state';

/** Route change callback type */
type RouteChangeCallback = (route: Route) => void;

/** Registered route change listeners */
const routeListeners = new Set<RouteChangeCallback>();

/**
 * Parse the current hash into a Route object.
 */
export function parseHash(hash: string): Route {
  // Remove leading # if present
  const cleanHash = hash.startsWith('#') ? hash.slice(1) : hash;

  // Split path and query string
  const [path, queryString] = cleanHash.split('?');
  const params = parseQueryString(queryString ?? '');

  // Parse path
  if (!path || path === '/') {
    return { type: 'home', params };
  }

  // Match /demo/<id>
  const demoMatch = path.match(/^\/demo\/([^/]+)$/);
  if (demoMatch?.[1]) {
    return { type: 'demo', demoId: demoMatch[1], params };
  }

  return { type: 'notfound', params };
}

/**
 * Parse query string into object.
 */
function parseQueryString(query: string): Record<string, string> {
  if (!query) return {};

  const params: Record<string, string> = {};
  const pairs = query.split('&');

  for (const pair of pairs) {
    const [key, value] = pair.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }

  return params;
}

/**
 * Serialize params to query string.
 */
export function serializeParams(params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([_, v]) => v !== '');
  if (entries.length === 0) return '';

  return (
    '?' +
    entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
  );
}

/**
 * Build hash string from route.
 */
export function buildHash(route: Route): string {
  const paramString = serializeParams(route.params);

  switch (route.type) {
    case 'home':
      return '#/' + paramString;
    case 'demo':
      return `#/demo/${route.demoId}${paramString}`;
    default:
      return '#/';
  }
}

/**
 * Navigate to a route.
 */
export function navigate(route: Route): void {
  const hash = buildHash(route);
  window.location.hash = hash;
}

/**
 * Navigate to a path string.
 */
export function navigateTo(path: string): void {
  if (!path.startsWith('#')) {
    path = '#' + path;
  }
  window.location.hash = path;
}

/**
 * Navigate to home.
 */
export function navigateHome(): void {
  navigate({ type: 'home', params: {} });
}

/**
 * Navigate to a demo by ID.
 */
export function navigateToDemo(id: string, params: Record<string, string> = {}): void {
  navigate({ type: 'demo', demoId: id, params });
}

/**
 * Update current route params without full navigation.
 */
export function updateParams(params: Record<string, string>): void {
  const current = getCurrentRoute();
  const newRoute = { ...current, params: { ...current.params, ...params } };
  const hash = buildHash(newRoute);

  // Use replaceState to avoid adding to history
  window.history.replaceState(null, '', hash);
  setCurrentRoute(newRoute);
}

/**
 * Get current route params.
 */
export function getParams(): Record<string, string> {
  return getCurrentRoute().params;
}

/**
 * Subscribe to route changes.
 */
export function onRouteChange(callback: RouteChangeCallback): () => void {
  routeListeners.add(callback);
  return () => routeListeners.delete(callback);
}

/**
 * Handle hash change event.
 */
function handleHashChange(): void {
  const route = parseHash(window.location.hash);
  setCurrentRoute(route);

  // Notify listeners
  routeListeners.forEach((callback) => callback(route));
}

/**
 * Initialize the router.
 */
export function initRouter(): Route {
  // Listen for hash changes
  window.addEventListener('hashchange', handleHashChange);

  // Parse initial route
  const initialRoute = parseHash(window.location.hash);
  setCurrentRoute(initialRoute);

  return initialRoute;
}

/**
 * Dispose router listeners.
 */
export function disposeRouter(): void {
  window.removeEventListener('hashchange', handleHashChange);
  routeListeners.clear();
}
