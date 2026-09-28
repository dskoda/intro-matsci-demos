# Creating a New Demo

This guide explains how to create a new demo for the MatSci Demos platform.

## Quick Start

1. **Copy the template**: Copy the `_template` folder to a new folder with your demo's name:
   ```
   cp -r src/demos/_template src/demos/my-demo
   ```

2. **Rename the file**: Rename `DemoTemplate.ts` to match your demo:
   ```
   mv src/demos/my-demo/DemoTemplate.ts src/demos/my-demo/MyDemo.ts
   ```

3. **Update the demo definition**: Edit the file and update:
   - `id`: Unique URL-safe identifier (e.g., `'my-demo'`)
   - `title`: Human-readable title
   - `description`: Short description for the demo card
   - `category`: Optional grouping category
   - `tags`: Optional tags for filtering

4. **Register your demo**: Add your demo to `src/demos/index.ts`:
   ```typescript
   import { myDemo } from './my-demo/MyDemo';

   export const allDemos = [
     demoTemplate,
     myDemo,
   ];
   ```

5. **Implement your visualization**: Modify the `create` function to implement your demo logic.

## Demo Structure

### DemoDefinition

```typescript
export interface DemoDefinition {
  id: string;           // URL-safe unique identifier
  title: string;        // Display title
  description: string;  // Short description
  category?: string;    // Optional category for grouping
  tags?: string[];      // Optional tags
  create(container: HTMLElement, options: DemoCreateOptions): DemoInstance;
}
```

### DemoInstance

Your `create` function must return a `DemoInstance`:

```typescript
export interface DemoInstance {
  start(): void;        // Called when demo becomes active
  stop(): void;         // Called when demo is paused or navigated away
  resize(): void;       // Called on window resize
  dispose(): void;      // Called when demo is unmounted (cleanup!)
  getParams?(): Record<string, string>;  // Optional: for URL sharing
  setParams?(params: Record<string, string>): void;  // Optional: restore from URL
}
```

### DemoCreateOptions

Your `create` function receives these options:

```typescript
export interface DemoCreateOptions {
  onNavigate: (path: string) => void;           // Navigate to another route
  onError: (error: Error) => void;              // Report errors
  setTitle: (title: string) => void;            // Set page title
  getParams: () => Record<string, string>;      // Get URL params
  setParams: (params: Record<string, string>) => void;  // Set URL params
}
```

## Available Utilities

### Canvas

```typescript
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
```

- `HiDPICanvas`: Creates a canvas with proper HiDPI scaling
- `AnimationLoop`: Manages requestAnimationFrame with delta time
- `Plot2D`: 2D plotting utilities (axes, grids, lines, labels)

### UI Controls

```typescript
import { createSlider, createCheckbox, createSelect, createButton } from '@core/ui/controls';
import { createSection } from '@core/ui/panel';
import { showToast } from '@core/ui/toast';
```

- `createSlider`: Slider with label and value display
- `createCheckbox`: Checkbox control
- `createSelect`: Dropdown select
- `createButton`: Button control
- `createSection`: Collapsible section for the control panel

### Math Utilities

```typescript
import { linspace, zeros, minMax } from '@core/math/arrays';
import { Complex, createComplexArray } from '@core/math/complex';
import { clamp, lerp, isPowerOfTwo } from '@core/math/validation';
```

### DOM/Events

```typescript
import { createElement, qs } from '@core/utils/dom';
import { EventBinder, debounce, throttle } from '@core/utils/events';
```

## Best Practices

1. **Clean up resources**: Always implement `dispose()` properly:
   - Stop animation loops
   - Remove event listeners
   - Dispose canvas and controls

2. **Track disposables**: Keep a list of things that need cleanup:
   ```typescript
   const disposables: Disposable[] = [];
   // ... create controls ...
   disposables.push(mySlider);

   // In dispose():
   disposables.forEach(d => d.dispose());
   ```

3. **Use URL params for sharing**: Implement `getParams` and `setParams` for shareable URLs.

4. **Handle resize gracefully**: Update your visualization in the `resize` method.

5. **Pre-allocate arrays**: For performance, create typed arrays once and reuse them.

## Example: Minimal Demo

```typescript
import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';

function create(container: HTMLElement, _options: DemoCreateOptions): DemoInstance {
  const canvas = new HiDPICanvas(container, { backgroundColor: '#000' });
  const ctx = canvas.ctx;

  const loop = new AnimationLoop((dt, time) => {
    canvas.clear();

    // Draw a moving circle
    const x = canvas.width / 2 + Math.cos(time) * 100;
    const y = canvas.height / 2 + Math.sin(time) * 100;

    ctx.fillStyle = '#4a9eff';
    ctx.beginPath();
    ctx.arc(x, y, 20, 0, Math.PI * 2);
    ctx.fill();
  });

  return {
    start: () => loop.start(),
    stop: () => loop.stop(),
    resize: () => {},
    dispose: () => {
      loop.dispose();
      canvas.dispose();
    },
  };
}

export const minimalDemo: DemoDefinition = {
  id: 'minimal',
  title: 'Minimal Demo',
  description: 'A minimal demo example.',
  create,
};
```

## File Structure

```
src/demos/my-demo/
├── MyDemo.ts          # Main demo file
├── README.md          # Optional: documentation
└── utils.ts           # Optional: demo-specific utilities
```
