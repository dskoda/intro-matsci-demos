/**
 * Demo Template
 *
 * This is a template for creating new demos. Copy this file and modify it
 * to create your own demo.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createCheckbox, createButton, type Disposable } from '@core/ui/controls';
import { createSection } from '@core/ui/panel';

/**
 * Demo parameters - define your configurable parameters here.
 */
interface DemoParams {
  amplitude: number;
  frequency: number;
  showGrid: boolean;
}

/**
 * Default parameter values.
 */
const defaultParams: DemoParams = {
  amplitude: 1.0,
  frequency: 1.0,
  showGrid: true,
};

/**
 * Create the demo instance.
 */
function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  // Get the controls panel from the container
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  // Current parameters
  const params: DemoParams = { ...defaultParams };

  // Apply URL params if any
  const urlParams = options.getParams();
  if (urlParams.amplitude) params.amplitude = parseFloat(urlParams.amplitude);
  if (urlParams.frequency) params.frequency = parseFloat(urlParams.frequency);
  if (urlParams.showGrid !== undefined) params.showGrid = urlParams.showGrid === 'true';

  // Create canvas
  const canvas = new HiDPICanvas(container, {
    backgroundColor: '#000',
    autoResize: true,
  });

  // Create plot
  const plot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: 10, yMin: -2, yMax: 2 },
    margins: { top: 30, right: 30, bottom: 50, left: 60 },
  });

  // Pre-allocate data arrays
  const N = 500;
  const xData = new Float64Array(N);
  const yData = new Float64Array(N);

  // Initialize x data
  for (let i = 0; i < N; i++) {
    xData[i] = (i / (N - 1)) * 10;
  }

  // Track disposables
  const disposables: Disposable[] = [];

  // Create controls
  if (controlsPanel) {
    // Parameters section
    const paramSection = createSection({ title: 'Parameters' });
    disposables.push(paramSection);

    const amplitudeSlider = createSlider({
      label: 'Amplitude',
      min: 0.1,
      max: 2.0,
      step: 0.1,
      value: params.amplitude,
      format: (v) => v.toFixed(1),
      onChange: (v) => {
        params.amplitude = v;
        updateUrlParams();
      },
    });
    disposables.push(amplitudeSlider);
    paramSection.content.appendChild(amplitudeSlider.element);

    const frequencySlider = createSlider({
      label: 'Frequency',
      min: 0.1,
      max: 5.0,
      step: 0.1,
      value: params.frequency,
      format: (v) => v.toFixed(1) + ' Hz',
      onChange: (v) => {
        params.frequency = v;
        updateUrlParams();
      },
    });
    disposables.push(frequencySlider);
    paramSection.content.appendChild(frequencySlider.element);

    controlsPanel.appendChild(paramSection.element);

    // Display section
    const displaySection = createSection({ title: 'Display' });
    disposables.push(displaySection);

    const gridCheckbox = createCheckbox({
      label: 'Show Grid',
      checked: params.showGrid,
      onChange: (checked) => {
        params.showGrid = checked;
        updateUrlParams();
      },
    });
    disposables.push(gridCheckbox);
    displaySection.content.appendChild(gridCheckbox.element);

    const resetButton = createButton({
      label: 'Reset',
      variant: 'secondary',
      onClick: () => {
        params.amplitude = defaultParams.amplitude;
        params.frequency = defaultParams.frequency;
        params.showGrid = defaultParams.showGrid;
        amplitudeSlider.setValue(params.amplitude);
        frequencySlider.setValue(params.frequency);
        gridCheckbox.setChecked(params.showGrid);
        updateUrlParams();
      },
    });
    disposables.push(resetButton);
    displaySection.content.appendChild(resetButton.element);

    controlsPanel.appendChild(displaySection.element);
  }

  // Animation loop
  const loop = new AnimationLoop((_dt, time) => {
    render(time);
  });

  // Update URL params
  function updateUrlParams() {
    options.setParams({
      amplitude: String(params.amplitude),
      frequency: String(params.frequency),
      showGrid: String(params.showGrid),
    });
  }

  // Render function
  function render(time: number) {
    // Update canvas size
    plot.setSize(canvas.width, canvas.height);

    // Clear
    canvas.clear();

    // Update data
    for (let i = 0; i < N; i++) {
      const x = xData[i]!;
      yData[i] = params.amplitude * Math.sin(2 * Math.PI * params.frequency * x - time);
    }

    // Draw grid
    if (params.showGrid) {
      const xTicks = Plot2D.generateTicks(0, 10, 10);
      const yTicks = Plot2D.generateTicks(-2, 2, 4);
      plot.drawGrid(xTicks, yTicks);
    }

    // Draw axes
    plot.drawAxes('Time (s)', 'Amplitude');

    // Draw tick labels
    const xTicks = Plot2D.generateTicks(0, 10, 5);
    const yTicks = Plot2D.generateTicks(-2, 2, 4);
    plot.drawTickLabels(xTicks, yTicks);

    // Draw the wave
    plot.drawLine(xData, yData, '#4a9eff', 2);
  }

  // Resize handler
  function handleResize() {
    // Canvas auto-resizes, just need to re-render
    if (loop.running) {
      render(loop.elapsed / 1000);
    }
  }

  canvas.onResize(handleResize);

  // Return demo instance
  return {
    start() {
      loop.start();
    },

    stop() {
      loop.stop();
    },

    resize() {
      handleResize();
    },

    dispose() {
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },

    getParams() {
      return {
        amplitude: String(params.amplitude),
        frequency: String(params.frequency),
        showGrid: String(params.showGrid),
      };
    },

    setParams(newParams: Record<string, string>) {
      if (newParams.amplitude) params.amplitude = parseFloat(newParams.amplitude);
      if (newParams.frequency) params.frequency = parseFloat(newParams.frequency);
      if (newParams.showGrid !== undefined) params.showGrid = newParams.showGrid === 'true';
    },
  };
}

/**
 * Demo definition - register this with the platform.
 */
export const demoTemplate: DemoDefinition = {
  id: 'template',
  title: 'Template: sine wave',
  description: 'A template demo showing a simple animated sine wave with configurable parameters.',
  category: 'Examples',
  tags: ['template', 'sine', 'wave'],
  create,
};

export default demoTemplate;
