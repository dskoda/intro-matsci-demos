/**
 * Phase diagram and microstructure of steel (Lecture 9: Steels).
 *
 * Left: the Fe–Fe₃C phase diagram up to 6.67 wt% C (cementite). Click or drag to choose the
 * carbon content C₀ and the temperature T; the region, tie line and lever rule are shown.
 * Right: the microstructure of that alloy, drawn so that the area of each phase is its
 * lever-rule weight fraction. Cooling through 727 °C shows the eutectoid reaction
 * γ → α + Fe₃C, with pearlite colonies growing in from the austenite grain boundaries.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import {
  createSlider,
  createSelect,
  createButton,
  createCheckbox,
  type Disposable,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { CMAX, T_MAX, T_MIN } from './steel';
import { SteelView } from './SteelView';

interface DemoParams {
  /** Carbon content (wt%) */
  c: number;
  /** Temperature (°C) */
  T: number;
  rate: number;
  speed: number;
  tie: boolean;
  seed: number;
}

const defaultParams: DemoParams = { c: 0.76, T: 800, rate: 5, speed: 20, tie: true, seed: 1 };

/** Alloys: composition (wt% C) and a starting temperature (°C) */
const PRESETS: Record<string, { label: string; c: number; T: number }> = {
  eutectoid: { label: 'Eutectoid steel (0.76 wt% C)', c: 0.76, T: 800 },
  hypo: { label: 'Hypoeutectoid steel (0.40 wt% C)', c: 0.4, T: 900 },
  hyper: { label: 'Hypereutectoid steel (1.20 wt% C)', c: 1.2, T: 1000 },
  hypoCI: { label: 'Hypoeutectic cast iron (3.0 wt% C)', c: 3.0, T: 1350 },
  eutecticCI: { label: 'Eutectic cast iron (4.3 wt% C)', c: 4.3, T: 1250 },
  hyperCI: { label: 'Hypereutectic cast iron (5.5 wt% C)', c: 5.5, T: 1300 },
};

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, p: DemoParams): void {
  if (src.c !== undefined) p.c = num(src.c, 0.01, 6.6, defaultParams.c);
  if (src.T !== undefined) p.T = Math.round(num(src.T, T_MIN, T_MAX, defaultParams.T));
  if (src.rate !== undefined) p.rate = num(src.rate, 1, 50, defaultParams.rate);
  if (src.speed !== undefined) p.speed = Math.round(num(src.speed, 1, 60, defaultParams.speed));
  if (src.tie !== undefined) p.tie = src.tie !== 'false';
  if (src.seed !== undefined) p.seed = Math.round(num(src.seed, 1, 9999, defaultParams.seed));
}

function toRecord(p: DemoParams): Record<string, string> {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  let view = new SteelView(params.seed, params.c, params.T);
  let frame = 0;
  let ramp = 0; // −1 cooling, +1 heating
  const path: { x: number; T: number }[] = [];

  let dragging = false;
  let hover: { x: number; T: number } | null = null;

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: CMAX, yMin: 0, yMax: T_MAX },
    margins: { top: 16, right: 16, bottom: 42, left: 64 },
  });
  const layout = { dx: 0, dy: 0, dw: 1, dh: 1, mx: 0, my: 0, ms: 1, ry: 0, wide: true };

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const selects: Record<string, ReturnType<typeof createSelect>> = {};
  const checks: Record<string, ReturnType<typeof createCheckbox>> = {};
  let applyingPreset = false;

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function resetView() {
    ramp = 0;
    path.length = 0;
    view = new SteelView(params.seed, params.c, params.T);
  }

  /** Move the state point; a pointer/slider choice shows the finished microstructure there */
  function setState(c: number, T: number) {
    params.c = clamp(Math.round(c * 100) / 100, 0.01, 6.6);
    params.T = Math.round(clamp(T, T_MIN, T_MAX));
    ramp = 0;
    path.length = 0;
    view.set(params.c, params.T, true);
    sliders.c?.setValue(params.c);
    sliders.T?.setValue(params.T);
    if (!applyingPreset) selects.preset?.setValue('custom');
    updateUrl();
  }

  function stopRamp() {
    ramp = 0;
    updateUrl();
  }

  if (controlsPanel) {
    const info = createSection({ title: 'Steel' });
    disposables.push(info);
    info.content.appendChild(
      createHelperText(
        'Click or drag on the Fe–Fe₃C diagram to choose the carbon content C₀ and the temperature T. The microstructure shows what slow cooling gives at that point; the area of each phase equals its lever-rule weight fraction. Start from an austenite state above 727 °C and press Cool to watch γ turn into pearlite.'
      )
    );
    controlsPanel.appendChild(info.element);

    const state = createSection({ title: 'State' });
    disposables.push(state);
    selects.preset = createSelect({
      label: 'Alloy',
      options: [
        { value: 'custom', label: 'Custom (sliders / click)' },
        ...Object.entries(PRESETS).map(([value, v]) => ({ value, label: v.label })),
      ],
      value: 'custom',
      onChange: (v) => {
        const pr = PRESETS[v];
        if (!pr) return;
        applyingPreset = true;
        setState(pr.c, pr.T);
        applyingPreset = false;
        selects.preset?.setValue(v);
      },
    });
    disposables.push(selects.preset);
    state.content.appendChild(selects.preset.element);
    sliders.c = createSlider({
      label: 'Carbon content C₀',
      min: 0.01,
      max: 6.6,
      step: 0.01,
      value: params.c,
      format: (v) => v.toFixed(2) + ' wt% C',
      onChange: (v) => setState(v, params.T),
    });
    sliders.T = createSlider({
      label: 'Temperature T',
      min: T_MIN,
      max: T_MAX,
      step: 1,
      value: params.T,
      format: (v) => v.toFixed(0) + ' °C',
      onChange: (v) => setState(params.c, v),
    });
    const melt = createButton({
      label: 'Melt & restart',
      variant: 'secondary',
      onClick: () => {
        params.T = T_MAX;
        sliders.T?.setValue(params.T);
        resetView();
        updateUrl();
      },
    });
    for (const c of [sliders.c, sliders.T, melt]) {
      disposables.push(c);
      state.content.appendChild(c.element);
    }
    controlsPanel.appendChild(state.element);

    const rampSec = createSection({ title: 'Cooling / heating' });
    disposables.push(rampSec);
    rampSec.content.appendChild(
      createHelperText(
        'Change T steadily from the current state. Below 727 °C the pearlite needs undercooling to form: the faster you pass through, the finer the lamellae.'
      )
    );
    sliders.rate = createSlider({
      label: 'Rate',
      min: 1,
      max: 50,
      step: 1,
      value: params.rate,
      format: (v) => v.toFixed(0) + ' °C / 100 steps',
      onChange: (v) => {
        params.rate = v;
        updateUrl();
      },
    });
    const cool = createButton({
      label: 'Cool',
      onClick: () => {
        if (ramp === 0) path.length = 0;
        ramp = -1;
      },
    });
    const heat = createButton({
      label: 'Heat',
      variant: 'secondary',
      onClick: () => {
        if (ramp === 0) path.length = 0;
        ramp = 1;
      },
    });
    const stop = createButton({ label: 'Stop', variant: 'secondary', onClick: stopRamp });
    for (const c of [sliders.rate, cool, heat, stop]) {
      disposables.push(c);
      rampSec.content.appendChild(c.element);
    }
    controlsPanel.appendChild(rampSec.element);

    const disp = createSection({ title: 'Display' });
    disposables.push(disp);
    checks.tie = createCheckbox({
      label: 'Tie line & lever rule',
      checked: params.tie,
      onChange: (v) => {
        params.tie = v;
        updateUrl();
      },
    });
    disposables.push(checks.tie);
    disp.content.appendChild(checks.tie.element);
    sliders.speed = createSlider({
      label: 'Speed',
      min: 1,
      max: 60,
      step: 1,
      value: params.speed,
      format: (v) => v.toFixed(0) + ' steps / frame',
      onChange: (v) => {
        params.speed = v;
        updateUrl();
      },
    });
    const seed = createButton({
      label: 'New grain structure',
      variant: 'secondary',
      onClick: () => {
        params.seed = 1 + Math.floor(Math.random() * 9999);
        resetView();
        updateUrl();
      },
    });
    for (const c of [sliders.speed, seed]) {
      disposables.push(c);
      disp.content.appendChild(c.element);
    }
    controlsPanel.appendChild(disp.element);
  }

  function syncControls() {
    sliders.c?.setValue(params.c);
    sliders.T?.setValue(params.T);
    sliders.rate?.setValue(params.rate);
    sliders.speed?.setValue(params.speed);
    checks.tie?.setChecked(params.tie);
  }

  // ---------------------------------------------------------------------------
  // Simulation and rendering
  // ---------------------------------------------------------------------------

  function advance() {
    frame++;
    const n = params.speed;
    if (ramp !== 0) {
      const Tc = clamp(params.T + (ramp * params.rate * n) / 100, T_MIN, T_MAX);
      params.T = Tc;
      if (frame % 3 === 0) sliders.T?.setValue(Math.round(Tc));
      if (Tc <= T_MIN || Tc >= T_MAX) {
        params.T = Math.round(Tc);
        sliders.T?.setValue(params.T);
        stopRamp();
      }
    }
    view.step(params.c, params.T, n);
    if (ramp !== 0 && frame % 4 === 0) {
      path.push({ x: params.c, T: params.T });
      if (path.length > 3000) path.splice(0, path.length - 3000);
    }
  }

  const readoutH = () => (layout.wide ? 112 : 156);

  function computeLayout() {
    const W = canvas.width;
    const H = canvas.height;
    const wide = W >= H * 1.25;
    layout.wide = wide;
    const avail = H - readoutH();
    layout.dx = 0;
    layout.dy = 4;
    if (wide) {
      layout.dw = W * 0.52;
      layout.dh = avail - 8;
      layout.ms = Math.max(60, Math.min(W - layout.dw - 28, avail - 40));
      layout.mx = layout.dw + (W - layout.dw - layout.ms) / 2;
      layout.my = 10;
    } else {
      layout.dw = W;
      layout.dh = Math.max(180, avail * 0.48);
      layout.ms = Math.max(60, Math.min(W - 20, avail - layout.dh - 36));
      layout.mx = (W - layout.ms) / 2;
      layout.my = layout.dy + layout.dh + 4;
    }
    layout.ry = H - readoutH() + 6;
  }

  function render() {
    canvas.clear();
    computeLayout();
    const ctx = canvas.ctx;
    const st = { c: params.c, T: params.T, tie: params.tie, ramp, path, hover, dragging };
    view.drawDiagram(ctx, plot, layout, st);
    view.drawMicro(ctx, layout, st);
    view.drawReadout(ctx, canvas.width, layout, readoutH(), st);
  }

  const loop = new AnimationLoop(() => {
    advance();
    render();
  });

  // ---------------------------------------------------------------------------
  // Pointer interaction on the diagram
  // ---------------------------------------------------------------------------

  function toState(e: PointerEvent): { c: number; T: number; inside: boolean } {
    const rect = canvas.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - layout.dx;
    const py = e.clientY - rect.top - layout.dy;
    const c = plot.toDataX(px);
    const T = plot.toDataY(py);
    return {
      c: clamp(c, 0.01, 6.6),
      T: clamp(T, T_MIN, T_MAX),
      inside: px >= 0 && px <= layout.dw && c >= -0.2 && c <= CMAX + 0.2 && T >= -30 && T <= T_MAX + 15,
    };
  }

  function onPointerDown(e: PointerEvent) {
    const s = toState(e);
    if (!s.inside) return;
    dragging = true;
    canvas.canvas.setPointerCapture(e.pointerId);
    setState(s.c, s.T);
  }

  function onPointerMove(e: PointerEvent) {
    const s = toState(e);
    if (dragging) {
      setState(s.c, s.T);
      return;
    }
    hover = s.inside ? { x: s.c, T: s.T } : null;
    canvas.canvas.style.cursor = s.inside ? 'crosshair' : 'default';
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try {
      canvas.canvas.releasePointerCapture(e.pointerId);
    } catch {
      // pointer capture may already be released
    }
  }

  function onPointerLeave() {
    hover = null;
  }

  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);
  canvas.canvas.addEventListener('pointerup', onPointerUp);
  canvas.canvas.addEventListener('pointercancel', onPointerUp);
  canvas.canvas.addEventListener('pointerleave', onPointerLeave);

  canvas.onResize(render);

  return {
    start() {
      loop.start();
    },
    stop() {
      loop.stop();
    },
    resize() {
      render();
    },
    dispose() {
      loop.dispose();
      disposables.forEach((d) => d.dispose());
      canvas.canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.canvas.removeEventListener('pointermove', onPointerMove);
      canvas.canvas.removeEventListener('pointerup', onPointerUp);
      canvas.canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.dispose();
    },
    getParams() {
      return toRecord(params);
    },
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      syncControls();
      resetView();
    },
  };
}

export const steelDemo: DemoDefinition = {
  id: 'steel',
  title: 'Phase diagram and microstructure of steel',
  description:
    'The Fe–Fe₃C phase diagram up to 6.67 wt% C: click any point to see its phases, tie line, lever rule and microstructure, and cool through the eutectoid to watch austenite turn into pearlite.',
  category: 'Phase diagrams',
  tags: ['steel', 'Fe-C', 'phase diagram', 'cementite', 'austenite', 'ferrite', 'pearlite', 'eutectoid', 'lever rule'],
  create,
};

export default steelDemo;
