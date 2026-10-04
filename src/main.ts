/**
 * MSE104 Demos Platform
 *
 * Main entry point for the application.
 */

import './style.css';
import { initRouter, onRouteChange } from '@app/router';
import { registerDemos } from '@app/registry';
import { mountRoute } from '@app/mount';
import { allDemos } from '@demos/index';

/**
 * Initialize the application.
 */
function init(): void {
  // Register all demos
  registerDemos(allDemos);

  // Render navbar dropdown with demo links

  // Initialize router and get initial route
  const initialRoute = initRouter();

  // Mount the initial route
  mountRoute(initialRoute);

  // Listen for route changes
  onRouteChange((route) => {
    void mountRoute(route);
  });

  // Handle global resize events (for non-demo pages)
  window.addEventListener('resize', () => {
    // Resize handling is done by ResizeObserver in mount.ts
  });

  // Log startup
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.log(`MatSci Demos initialized with ${allDemos.length} demo(s)`);
  }
}

// Start the app
try {
  init();
} catch (error) {
  console.error('Failed to initialize app:', error);
}
