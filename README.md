# MAT SCI 104 Demo

An interactive visualization platform for MAT SCI 104.
The platform and demos were built with TypeScript and Canvas 2D.
LLMs were used to code part of this repository, whose main goal is to support teaching endeavors.
Initially written by Daniel Schwalbe-Koda during Fall 2026 at UCLA.

## Course content

These visualizations were created to support the course MAT SCI 104 at UCLA.

## Overview

This platform hosts interactive physics demonstrations for a course on Science of Engineering Materials. Technical benefits:

- **Consistent Layout**: All demos share a common layout with a render area and controls panel
- **Demo Registry**: Easy registration and discovery of demos
- **URL Sharing**: Shareable URLs with demo parameters
- **Responsive Design**: Works on desktop and mobile devices
- **HiDPI Support**: Crisp rendering on Retina and high-DPI displays

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
# Clone the repository
git clone https://github.com/dskoda/intro-matsci-demos.git
cd physics-demos

# Install dependencies
npm install
```

### Development

```bash
# Start development server
npm run dev

# Type checking
npm run typecheck

# Linting
npm run lint

# Format code
npm run format
```

### Building

```bash
# Build for production
npm run build

# Preview production build locally
npm run preview
```

## Project Structure

```
intro-matsci-demos/
├── src/
│   ├── app/                    # Application core
│   │   ├── router.ts           # Hash-based routing
│   │   ├── layout.ts           # Page layouts
│   │   ├── registry.ts         # Demo registry
│   │   ├── mount.ts            # Demo lifecycle management
│   │   ├── state.ts            # Global state
│   │   └── types.ts            # TypeScript interfaces
│   │
│   ├── core/                   # Shared utilities
│   │   ├── canvas/             # Canvas utilities
│   │   │   ├── HiDPICanvas.ts  # HiDPI-aware canvas
│   │   │   ├── AnimationLoop.ts # RAF loop management
│   │   │   └── Plot2D.ts       # 2D plotting primitives
│   │   │
│   │   ├── ui/                 # UI components
│   │   │   ├── controls.ts     # Slider, checkbox, etc.
│   │   │   ├── panel.ts        # Control panel sections
│   │   │   └── toast.ts        # Notifications
│   │   │
│   │   ├── math/               # Math utilities
│   │   │   ├── complex.ts      # Complex number operations
│   │   │   ├── arrays.ts       # Typed array helpers
│   │   │   ├── units.ts        # Physical constants/units
│   │   │   └── validation.ts   # Value validation
│   │   │
│   │   └── utils/              # General utilities
│   │       ├── dom.ts          # DOM helpers
│   │       ├── events.ts       # Event management
│   │       └── hashParams.ts   # URL parameter handling
│   │
│   ├── demos/                  # Demo implementations
│   │   ├── _template/          # Demo template
│   │   └── index.ts            # Demo exports
│   │
│   ├── main.ts                 # Application entry point
│   └── style.css               # Global styles
│
├── public/                     # Static assets
├── index.html                  # HTML entry point
├── package.json
├── tsconfig.json
├── vite.config.ts
└── .github/workflows/
    └── deploy.yml              # GitHub Pages deployment
```

## Adding a New Demo

### Quick Start

1. **Copy the template**:
   ```bash
   cp -r src/demos/_template src/demos/my-demo
   mv src/demos/my-demo/DemoTemplate.ts src/demos/my-demo/MyDemo.ts
   ```

2. **Update the demo definition** in your new file:
   ```typescript
   export const myDemo: DemoDefinition = {
     id: 'my-demo',                    // URL-safe identifier
     title: 'My Demo',                 // Display title
     description: 'Demo description',  // For the home page
     category: 'Physics',              // Optional grouping
     create,
   };
   ```

3. **Register your demo** in `src/demos/index.ts`:
   ```typescript
   import { myDemo } from './my-demo/MyDemo';

   export const allDemos: DemoDefinition[] = [
     demoTemplate,
     myDemo,  // Add your demo here
   ];
   ```

4. **Implement the `create` function** that returns a `DemoInstance`:
   ```typescript
   function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
     // Set up canvas, controls, animation loop

     return {
       start() { /* Start animation */ },
       stop() { /* Stop animation */ },
       resize() { /* Handle resize */ },
       dispose() { /* Clean up resources */ },
     };
   }
   ```

See [src/demos/_template/README.md](src/demos/_template/README.md) for detailed instructions.

## Demo Interface

### DemoDefinition

```typescript
interface DemoDefinition {
  id: string;           // Unique URL-safe identifier
  title: string;        // Display title
  description: string;  // Short description
  category?: string;    // Optional category
  tags?: string[];      // Optional tags
  create(container: HTMLElement, options: DemoCreateOptions): DemoInstance;
}
```

### DemoInstance

```typescript
interface DemoInstance {
  start(): void;      // Called when demo becomes active
  stop(): void;       // Called when leaving the demo
  resize(): void;     // Called on container resize
  dispose(): void;    // Clean up all resources

  // Optional: for URL sharing
  getParams?(): Record<string, string>;
  setParams?(params: Record<string, string>): void;
}
```

## Routing

The platform uses hash-based routing:

- `#/` - Home page (demo grid)
- `#/demo/<id>` - Individual demo
- `#/demo/<id>?param=value` - Demo with parameters

### URL Parameters

Demos can read and write URL parameters for shareable presets:

```typescript
// In your create function
const params = options.getParams();  // Read current params

// Update params (updates URL without navigation)
options.setParams({ frequency: '2.5', amplitude: '1.0' });
```

## Available Utilities

### Canvas

- `HiDPICanvas` - Canvas with devicePixelRatio handling
- `AnimationLoop` - requestAnimationFrame with delta time
- `Plot2D` - 2D plotting (axes, grids, lines, labels)

### UI Controls

- `createSlider()` - Slider with label and value
- `createCheckbox()` - Checkbox control
- `createSelect()` - Dropdown select
- `createButton()` - Button control
- `createSection()` - Collapsible section

### Math

- `linspace()`, `zeros()`, `arange()` - Array creation
- `Complex`, `createComplexArray()` - Complex numbers
- `clamp()`, `lerp()`, `isPowerOfTwo()` - Validation

## GitHub Pages Deployment

The repository includes a GitHub Actions workflow that automatically deploys to GitHub Pages on push to `main`.

### Setup

1. Go to your repository's **Settings** → **Pages**
2. Under "Build and deployment", select **GitHub Actions**
3. Push to `main` branch to trigger deployment

### Manual Deployment

You can also trigger deployment manually:

1. Go to **Actions** → **Deploy to GitHub Pages**
2. Click **Run workflow**

## Tech Stack

- **Vite** - Build tool and dev server
- **TypeScript** - Type-safe JavaScript
- **Canvas 2D** - Rendering
- **ESLint + Prettier** - Code quality

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-demo`)
3. Commit your changes (`git commit -m 'Add amazing demo'`)
4. Push to the branch (`git push origin feature/amazing-demo`)
5. Open a Pull Request

## License

MIT License - see [LICENSE](LICENSE) for details.
