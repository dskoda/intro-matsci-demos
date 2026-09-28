/**
 * Lennard-Jones Potential Demo
 *
 * Two particles: one fixed anchor and one the user can drag. The dragged
 * particle doesn't teleport to the cursor - it's pulled toward it by a
 * virtual spring while the Lennard-Jones force resists, so pushing into the
 * repulsive core visibly fights back, and releasing lets it spring back and
 * settle toward the equilibrium separation.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createCheckbox, createButton, type Disposable } from '@core/ui/controls';
import { createSection } from '@core/ui/panel';
import { clamp } from '@core/math/validation';

interface DemoParams {
  epsilon: number;
  sigma: number;
  showForceArrow: boolean;
}

const defaultParams: DemoParams = {
  epsilon: 1.0,
  sigma: 1.0,
  showForceArrow: true,
};

// Physics/simulation constants (not user-configurable - tuned for a good "feel")
const MASS = 1.0;
const DRAG_SPRING_K = 30;
const DAMPING = 4;
const FORCE_CAP = 300;
const R_MIN = 0.35;
const R_MAX = 4.0;
const PICK_RADIUS_PX = 30;

// Fixed axis ranges so curves stay readable across the parameter sliders
const R_PLOT_MIN = 0.15;
const R_PLOT_MAX = 4.0;
const ENERGY_PLOT_RANGE = 5;

const equilibriumR = (sigma: number): number => Math.pow(2, 1 / 6) * sigma;

/** Lennard-Jones force on the movable particle along +r (positive = repulsive). */
function ljForce(r: number, epsilon: number, sigma: number): number {
  const rc = Math.max(r, 0.05);
  const sr6 = Math.pow(sigma / rc, 6);
  const sr12 = sr6 * sr6;
  const F = (24 * epsilon / rc) * (2 * sr12 - sr6);
  return clamp(F, -FORCE_CAP, FORCE_CAP);
}

/** Lennard-Jones potential energy at separation r. */
function ljPotential(r: number, epsilon: number, sigma: number): number {
  const rc = Math.max(r, 0.05);
  const sr6 = Math.pow(sigma / rc, 6);
  const sr12 = sr6 * sr6;
  return 4 * epsilon * (sr12 - sr6);
}

/** Interpolate between two hex colors. */
function lerpColor(a: [number, number, number], b: [number, number, number], t: number): string {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r}, ${g}, ${bl})`;
}

function particleColor(force: number): string {
  const NEUTRAL: [number, number, number] = [120, 200, 160];
  const REPULSIVE: [number, number, number] = [255, 90, 90];
  const ATTRACTIVE: [number, number, number] = [74, 158, 255];
  const t = clamp(Math.abs(force) / 40, 0, 1);
  return force >= 0 ? lerpColor(NEUTRAL, REPULSIVE, t) : lerpColor(NEUTRAL, ATTRACTIVE, t);
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  const urlParams = options.getParams();
  if (urlParams.epsilon) params.epsilon = parseFloat(urlParams.epsilon);
  if (urlParams.sigma) params.sigma = parseFloat(urlParams.sigma);
  if (urlParams.showForceArrow !== undefined) {
    params.showForceArrow = urlParams.showForceArrow === 'true';
  }

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });

  // Two stacked plots sharing one canvas: particle stage on top, V(r)/F(r) below.
  const stagePlot = new Plot2D(canvas.ctx, {
    bounds: { xMin: -0.5, xMax: 4.5, yMin: -1, yMax: 1 },
    margins: { top: 10, right: 20, bottom: 10, left: 20 },
  });
  const curvePlot = new Plot2D(canvas.ctx, {
    bounds: {
      xMin: R_PLOT_MIN,
      xMax: R_PLOT_MAX,
      yMin: -ENERGY_PLOT_RANGE,
      yMax: ENERGY_PLOT_RANGE,
    },
    margins: { top: 20, right: 20, bottom: 40, left: 55 },
  });

  // Simulation state: r is the separation between the fixed anchor (at 0) and
  // the movable particle.
  let r = equilibriumR(params.sigma);
  let v = 0;
  let isDragging = false;
  let targetR = r;
  let stageHeight = 0;

  const disposables: Disposable[] = [];

  if (controlsPanel) {
    const paramSection = createSection({ title: 'Parameters' });
    disposables.push(paramSection);

    const epsilonSlider = createSlider({
      label: 'ε (well depth)',
      min: 0.2,
      max: 3.0,
      step: 0.1,
      value: params.epsilon,
      format: (val) => val.toFixed(1),
      onChange: (val) => {
        params.epsilon = val;
        updateUrlParams();
      },
    });
    disposables.push(epsilonSlider);
    paramSection.content.appendChild(epsilonSlider.element);

    const sigmaSlider = createSlider({
      label: 'σ (particle size)',
      min: 0.5,
      max: 2.0,
      step: 0.05,
      value: params.sigma,
      format: (val) => val.toFixed(2),
      onChange: (val) => {
        params.sigma = val;
        updateUrlParams();
      },
    });
    disposables.push(sigmaSlider);
    paramSection.content.appendChild(sigmaSlider.element);

    controlsPanel.appendChild(paramSection.element);

    const displaySection = createSection({ title: 'Display' });
    disposables.push(displaySection);

    const arrowCheckbox = createCheckbox({
      label: 'Show force arrow',
      checked: params.showForceArrow,
      onChange: (checked) => {
        params.showForceArrow = checked;
        updateUrlParams();
      },
    });
    disposables.push(arrowCheckbox);
    displaySection.content.appendChild(arrowCheckbox.element);

    const resetButton = createButton({
      label: 'Reset position',
      variant: 'secondary',
      onClick: () => {
        r = equilibriumR(params.sigma);
        v = 0;
        targetR = r;
      },
    });
    disposables.push(resetButton);
    displaySection.content.appendChild(resetButton.element);

    controlsPanel.appendChild(displaySection.element);
  }

  function updateUrlParams(): void {
    options.setParams({
      epsilon: params.epsilon.toFixed(2),
      sigma: params.sigma.toFixed(2),
      showForceArrow: String(params.showForceArrow),
    });
  }

  // --- Pointer interaction on the particle stage ---

  function pointerToDataR(e: PointerEvent): number {
    const rect = canvas.canvas.getBoundingClientRect();
    const canvasX = e.clientX - rect.left;
    return stagePlot.toDataX(canvasX);
  }

  function onPointerDown(e: PointerEvent): void {
    const rect = canvas.canvas.getBoundingClientRect();
    const canvasY = e.clientY - rect.top;
    if (canvasY > stageHeight) return;

    const movableCanvasX = stagePlot.toCanvasX(r);
    const canvasX = e.clientX - rect.left;
    if (Math.abs(canvasX - movableCanvasX) > PICK_RADIUS_PX) return;

    isDragging = true;
    targetR = clamp(pointerToDataR(e), R_MIN, R_MAX);
    canvas.canvas.setPointerCapture(e.pointerId);
    canvas.canvas.style.cursor = 'grabbing';
  }

  function onPointerMove(e: PointerEvent): void {
    if (!isDragging) return;
    targetR = clamp(pointerToDataR(e), R_MIN, R_MAX);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!isDragging) return;
    isDragging = false;
    canvas.canvas.style.cursor = 'grab';
    try {
      canvas.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be released
    }
  }

  canvas.canvas.style.cursor = 'grab';
  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);
  canvas.canvas.addEventListener('pointerup', onPointerUp);
  canvas.canvas.addEventListener('pointercancel', onPointerUp);

  // --- Physics step ---

  function step(dt: number): void {
    const clampedDt = Math.min(dt, 0.05);
    const springForce = isDragging ? -DRAG_SPRING_K * (r - targetR) : 0;
    const dampingForce = -DAMPING * v;
    const netForce = ljForce(r, params.epsilon, params.sigma) + springForce + dampingForce;

    const a = netForce / MASS;
    v += a * clampedDt;
    r += v * clampedDt;
    r = clamp(r, R_MIN, R_MAX);
  }

  // --- Rendering ---

  const curveN = 300;
  const curveR = new Float64Array(curveN);
  const curveV = new Float64Array(curveN);
  const curveF = new Float64Array(curveN);

  function render(): void {
    const width = canvas.width;
    const height = canvas.height;
    stageHeight = Math.max(140, height * 0.35);
    const plotHeight = height - stageHeight;

    canvas.clear();

    renderStage(width, stageHeight);

    canvas.ctx.save();
    canvas.ctx.translate(0, stageHeight);
    renderCurves(width, plotHeight);
    canvas.ctx.restore();
  }

  function renderStage(width: number, height: number): void {
    stagePlot.setSize(width, height);

    const force = ljForce(r, params.epsilon, params.sigma);
    const potential = ljPotential(r, params.epsilon, params.sigma);
    const r0 = equilibriumR(params.sigma);

    // Line the particles sit on
    const lineY = 0;
    canvas.ctx.save();
    canvas.ctx.strokeStyle = '#333';
    canvas.ctx.lineWidth = 1;
    canvas.ctx.beginPath();
    canvas.ctx.moveTo(stagePlot.toCanvasX(-0.5), stagePlot.toCanvasY(lineY));
    canvas.ctx.lineTo(stagePlot.toCanvasX(4.5), stagePlot.toCanvasY(lineY));
    canvas.ctx.stroke();
    canvas.ctx.restore();

    // Equilibrium marker
    stagePlot.drawText('r₀', r0, 0.55, { color: '#666', align: 'center', fontSize: 11 });
    canvas.ctx.save();
    canvas.ctx.strokeStyle = '#555';
    canvas.ctx.setLineDash([4, 4]);
    canvas.ctx.beginPath();
    canvas.ctx.moveTo(stagePlot.toCanvasX(r0), stagePlot.toCanvasY(0.4));
    canvas.ctx.lineTo(stagePlot.toCanvasX(r0), stagePlot.toCanvasY(-0.4));
    canvas.ctx.stroke();
    canvas.ctx.restore();

    // Force arrow on the movable particle
    if (params.showForceArrow && Math.abs(force) > 0.05) {
      const arrowLen = clamp(Math.abs(force) / 40, 0, 1) * 0.6;
      const dir = force >= 0 ? 1 : -1;
      const startX = r;
      const endX = r + dir * arrowLen;
      const arrowY = 0.35;
      canvas.ctx.save();
      canvas.ctx.strokeStyle = force >= 0 ? '#ff5a5a' : '#4a9eff';
      canvas.ctx.fillStyle = canvas.ctx.strokeStyle;
      canvas.ctx.lineWidth = 2.5;
      canvas.ctx.beginPath();
      canvas.ctx.moveTo(stagePlot.toCanvasX(startX), stagePlot.toCanvasY(arrowY));
      canvas.ctx.lineTo(stagePlot.toCanvasX(endX), stagePlot.toCanvasY(arrowY));
      canvas.ctx.stroke();
      const headX = stagePlot.toCanvasX(endX);
      const headY = stagePlot.toCanvasY(arrowY);
      const headDir = dir * (stagePlot.toCanvasX(1) - stagePlot.toCanvasX(0) > 0 ? 1 : -1);
      canvas.ctx.beginPath();
      canvas.ctx.moveTo(headX, headY);
      canvas.ctx.lineTo(headX - headDir * 8, headY - 5);
      canvas.ctx.lineTo(headX - headDir * 8, headY + 5);
      canvas.ctx.closePath();
      canvas.ctx.fill();
      canvas.ctx.restore();
    }

    // Anchor (fixed) particle
    stagePlot.drawPoint(0, lineY, 12, '#888');
    stagePlot.drawText('fixed', 0, -0.55, { color: '#666', align: 'center', fontSize: 10 });

    // Movable particle
    stagePlot.drawPoint(r, lineY, 12, particleColor(force));

    // Readout
    stagePlot.drawText(`r = ${r.toFixed(2)}`, -0.4, 0.85, {
      color: '#ddd',
      align: 'left',
      fontSize: 13,
    });
    stagePlot.drawText(`V(r) = ${potential.toFixed(2)} ε`, -0.4, 0.7, {
      color: '#aaa',
      align: 'left',
      fontSize: 12,
    });
    stagePlot.drawText(`F(r) = ${force.toFixed(2)}`, -0.4, -0.85, {
      color: '#aaa',
      align: 'left',
      fontSize: 12,
    });
  }

  function renderCurves(width: number, height: number): void {
    curvePlot.setSize(width, height);

    for (let i = 0; i < curveN; i++) {
      const rr = R_PLOT_MIN + (i / (curveN - 1)) * (R_PLOT_MAX - R_PLOT_MIN);
      curveR[i] = rr;
      curveV[i] = ljPotential(rr, params.epsilon, params.sigma);
      curveF[i] = ljForce(rr, params.epsilon, params.sigma);
    }

    const xTicks = Plot2D.generateTicks(R_PLOT_MIN, R_PLOT_MAX, 6);
    const yTicks = Plot2D.generateTicks(-ENERGY_PLOT_RANGE, ENERGY_PLOT_RANGE, 5);
    curvePlot.drawGrid(xTicks, yTicks);
    curvePlot.drawAxes('separation r', 'V(r) / F(r)');
    curvePlot.drawTickLabels(xTicks, yTicks);

    curvePlot.drawLine(curveR, curveV, '#4a9eff', 2);
    curvePlot.drawLine(curveR, curveF, '#ff9f4a', 2);

    // Current-r marker spanning the plot height
    const ctx = canvas.ctx;
    const vx = curvePlot.toCanvasX(r);
    ctx.save();
    ctx.strokeStyle = '#666';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(vx, curvePlot.toCanvasY(ENERGY_PLOT_RANGE));
    ctx.lineTo(vx, curvePlot.toCanvasY(-ENERGY_PLOT_RANGE));
    ctx.stroke();
    ctx.restore();

    curvePlot.drawPoint(r, ljPotential(r, params.epsilon, params.sigma), 5, '#4a9eff');
    curvePlot.drawPoint(r, ljForce(r, params.epsilon, params.sigma), 5, '#ff9f4a');

    curvePlot.drawText('V(r)', R_PLOT_MAX - 0.1, ENERGY_PLOT_RANGE - 0.6, {
      color: '#4a9eff',
      align: 'right',
      fontSize: 12,
    });
    curvePlot.drawText('F(r)', R_PLOT_MAX - 0.1, ENERGY_PLOT_RANGE - 1.4, {
      color: '#ff9f4a',
      align: 'right',
      fontSize: 12,
    });
  }

  const loop = new AnimationLoop((dt) => {
    step(dt);
    render();
  });

  function handleResize(): void {
    if (loop.running) render();
  }

  canvas.onResize(handleResize);

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
      canvas.canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.canvas.removeEventListener('pointermove', onPointerMove);
      canvas.canvas.removeEventListener('pointerup', onPointerUp);
      canvas.canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.dispose();
    },
    getParams() {
      return {
        epsilon: params.epsilon.toFixed(2),
        sigma: params.sigma.toFixed(2),
        showForceArrow: String(params.showForceArrow),
      };
    },
    setParams(newParams: Record<string, string>) {
      if (newParams.epsilon) params.epsilon = parseFloat(newParams.epsilon);
      if (newParams.sigma) params.sigma = parseFloat(newParams.sigma);
      if (newParams.showForceArrow !== undefined) {
        params.showForceArrow = newParams.showForceArrow === 'true';
      }
    },
  };
}

export const lennardJonesDemo: DemoDefinition = {
  id: 'lennard-jones',
  title: 'Lennard-Jones Potential',
  description:
    'Drag a particle and feel the attractive and repulsive forces of the Lennard-Jones potential.',
  category: 'Bonding',
  tags: ['lennard-jones', 'potential', 'bonding', 'force'],
  create,
};

export default lennardJonesDemo;
