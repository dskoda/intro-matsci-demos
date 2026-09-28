/**
 * Demo Mount Manager
 *
 * Handles mounting and unmounting demos with proper lifecycle management.
 */

import type { DemoInstance, DemoCreateOptions, Route } from './types';
import { getDemo } from './registry';
import { renderDemoLayout, renderHomePage, renderNotFound, setPageTitle } from './layout';
import { navigateTo, getParams, updateParams } from './router';
import { showToast } from '@core/ui/toast';

/** Currently mounted demo instance */
let currentInstance: DemoInstance | null = null;

/** Resize observer for demo container */
let resizeObserver: ResizeObserver | null = null;

/**
 * Mount a route (home, demo, or 404).
 */
export function mountRoute(route: Route): void {
  const mainContent = document.getElementById('main-content');
  if (!mainContent) {
    console.error('Main content container not found');
    return;
  }

  // Unmount current demo if any
  unmountCurrentDemo();

  switch (route.type) {
    case 'home':
      setPageTitle();
      renderHomePage(mainContent);
      break;

    case 'demo':
      if (route.demoId) {
        mountDemo(route.demoId, mainContent, route.params);
      } else {
        renderNotFound(mainContent);
      }
      break;

    case 'notfound':
    default:
      setPageTitle('Not Found');
      renderNotFound(mainContent);
      break;
  }
}

/**
 * Mount a demo by ID.
 */
function mountDemo(
  demoId: string,
  container: HTMLElement,
  params: Record<string, string>
): void {
  const demo = getDemo(demoId);

  if (!demo) {
    setPageTitle('Not Found');
    renderNotFound(container);
    showToast(`Demo "${demoId}" not found`, 'error');
    return;
  }

  // Set up the layout
  const { renderArea, controlsPanel } = renderDemoLayout(container);

  // Create demo options
  const options: DemoCreateOptions = {
    onNavigate: navigateTo,
    onError: (error: Error) => {
      console.error('Demo error:', error);
      showToast(error.message, 'error');
    },
    setTitle: (title: string) => setPageTitle(title),
    getParams: () => getParams(),
    setParams: (newParams: Record<string, string>) => updateParams(newParams),
  };

  try {
    // Create the demo instance
    // Pass both renderArea and controlsPanel to the demo
    const demoContainer = document.createElement('div');
    demoContainer.className = 'demo-container';
    demoContainer.style.width = '100%';
    demoContainer.style.height = '100%';

    // Attach controls panel reference using Object.assign
    Object.assign(demoContainer, { controlsPanel });

    renderArea.appendChild(demoContainer);

    currentInstance = demo.create(demoContainer, options);

    // Set initial params if demo supports it
    if (currentInstance.setParams && Object.keys(params).length > 0) {
      currentInstance.setParams(params);
    }

    // Set page title
    setPageTitle(demo.title);

    // Set up resize observer
    setupResizeObserver(renderArea);

    // Start the demo
    currentInstance.start();
  } catch (error) {
    console.error('Failed to mount demo:', error);
    showToast(`Failed to start demo: ${(error as Error).message}`, 'error');
    currentInstance = null;
  }
}

/**
 * Set up resize observer for demo container.
 */
function setupResizeObserver(container: HTMLElement): void {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }

  resizeObserver = new ResizeObserver(() => {
    if (currentInstance) {
      currentInstance.resize();
    }
  });

  resizeObserver.observe(container);
}

/**
 * Unmount the current demo.
 */
export function unmountCurrentDemo(): void {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }

  if (currentInstance) {
    try {
      currentInstance.stop();
      currentInstance.dispose();
    } catch (error) {
      console.error('Error disposing demo:', error);
    }
    currentInstance = null;
  }
}

/**
 * Get the current demo instance (for debugging).
 */
export function getCurrentDemoInstance(): DemoInstance | null {
  return currentInstance;
}

/**
 * Trigger resize on current demo (call on window resize).
 */
export function resizeCurrentDemo(): void {
  if (currentInstance) {
    currentInstance.resize();
  }
}
