/**
 * Demo Interface Types
 *
 * Defines the contract for all demos in the platform.
 */

/** Options passed to demo's create function */
export interface DemoCreateOptions {
  /** Navigate to another route */
  onNavigate: (path: string) => void;
  /** Report an error to the platform */
  onError: (error: Error) => void;
  /** Set the page title */
  setTitle: (title: string) => void;
  /** Get current URL parameters */
  getParams: () => Record<string, string>;
  /** Set URL parameters (updates URL without navigation) */
  setParams: (params: Record<string, string>) => void;
}

/** Instance returned by demo's create function */
export interface DemoInstance {
  /** Start the demo (called after mounting) */
  start(): void;
  /** Stop the demo (called before unmounting or when pausing) */
  stop(): void;
  /** Handle container resize */
  resize(): void;
  /** Clean up all resources */
  dispose(): void;
  /** Optional: Get current parameters for URL sharing */
  getParams?(): Record<string, string>;
  /** Optional: Set parameters from URL */
  setParams?(params: Record<string, string>): void;
}

/** Demo definition for registry */
export interface DemoDefinition {
  /** Unique identifier used in URL routing */
  id: string;
  /** Display title */
  title: string;
  /** Short description */
  description: string;
  /** Optional category for grouping */
  category?: string;
  /** Optional tags for filtering */
  tags?: string[];
  /** Factory function to create the demo instance */
  create(container: HTMLElement, options: DemoCreateOptions): DemoInstance;
}

/** Route information */
export interface Route {
  type: 'home' | 'demo' | 'notfound';
  demoId?: string;
  params: Record<string, string>;
}

/** Global app state */
export interface AppState {
  currentRoute: Route;
  currentDemo: DemoInstance | null;
  isTransitioning: boolean;
}
