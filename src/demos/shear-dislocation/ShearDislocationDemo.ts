/**
 * Dislocation glide under shear (Lecture 5: Strength).
 *
 * A 2D square crystal is sheared. Once the shear stress exceeds the lattice
 * friction stress, an edge dislocation enters from the left, glides across the
 * slip plane and leaves a step of one Burgers vector. The stress-strain curve
 * shows the elastic rise and a yield plateau at tau_P, far below the
 * rigid-slip strength G / 2 pi.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createCheckbox, createButton, type Disposable } from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import { ROLE_COLORS } from '../defects/defects';
import {
  NX,
  NY,
  SLIP_Y,
  SLIP_ROW,
  GAMMA_MAX,
  TAU_THEORY,
  newState,
  step,
  tau,
  gammaPlastic,
  displaced,
  bonds,
  atomStrain,
  xStart,
  type Params,
} from './dislocation';

interface DemoParams {
  rate: number;
  tauP: number;
  width: number;
  trail: boolean;
  ghosts: boolean;
  burgers: boolean;
}

const defaultParams: DemoParams = {
  rate: 0.012,
  tauP: 0.05,
  width: 1.2,
  trail: true,
  ghosts: true,
  burgers: true,
};

const COLOR_LOAD = '#ff6b6b';
const COLOR_UNLOAD = '#38bdf8';
const COLOR_CORE = '#ffd84a';
const COLOR_NEUTRAL: [number, number, number] = [138, 148, 163];
const COLOR_TENSION: [number, number, number] = [255, 107, 107];
const COLOR_COMPRESS: [number, number, number] = [74, 158, 255];
const STRAIN_RANGE = 0.12;
const MOBILITY = 300;
const MAX_HISTORY = 20000;

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, params: DemoParams): void {
  if (src.rate !== undefined) params.rate = num(src.rate, 0.002, 0.05, defaultParams.rate);
  if (src.tauP !== undefined) params.tauP = num(src.tauP, 0.01, 0.12, defaultParams.tauP);
  if (src.width !== undefined) params.width = num(src.width, 0.6, 2.5, defaultParams.width);
  if (src.trail !== undefined) params.trail = src.trail === 'true';
  if (src.ghosts !== undefined) params.ghosts = src.ghosts === 'true';
  if (src.burgers !== undefined) params.burgers = src.burgers === 'true';
}

function toRecord(p: DemoParams): Record<string, string> {
  return {
    rate: String(p.rate),
    tauP: String(p.tauP),
    width: String(p.width),
    trail: String(p.trail),
    ghosts: String(p.ghosts),
    burgers: String(p.burgers),
  };
}

/** Blue (compression) - grey - red (tension) colour for a bond strain. */
function strainColor(strain: number): string {
  const t = clamp(strain / STRAIN_RANGE, -1, 1);
  const end = t >= 0 ? COLOR_TENSION : COLOR_COMPRESS;
  const m = Math.abs(t);
  const c = COLOR_NEUTRAL.map((v, k) => Math.round(v + (end[k]! - v) * m));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const model = (): Params => ({ tauP: params.tauP, width: params.width, mobility: MOBILITY });
  const state = newState(model());
  let dir = 1;
  let paused = false;
  let gliding = false;

  // Stress-strain history; dirs[k] is +1 (loading) or -1 (unloading)
  const hx: number[] = [];
  const hy: number[] = [];
  const hd: number[] = [];

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: GAMMA_MAX, yMin: 0, yMax: 0.2 },
    margins: { top: 34, right: 20, bottom: 46, left: 58 },
  });

  const disposables: Disposable[] = [];
  let playButton: ReturnType<typeof createButton> | null = null;
  let dirButton: ReturnType<typeof createButton> | null = null;
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  const checks: Record<string, ReturnType<typeof createCheckbox>> = {};

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function reset() {
    Object.assign(state, newState(model()));
    dir = 1;
    gliding = false;
    hx.length = 0;
    hy.length = 0;
    hd.length = 0;
    dirButton?.setLabel('Unload');
  }

  function syncControls() {
    sliders.rate?.setValue(params.rate);
    sliders.tauP?.setValue(params.tauP);
    sliders.width?.setValue(params.width);
    checks.trail?.setChecked(params.trail);
    checks.ghosts?.setChecked(params.ghosts);
    checks.burgers?.setChecked(params.burgers);
  }

  if (controlsPanel) {
    const info = createSection({ title: 'Dislocation glide' });
    disposables.push(info);
    info.content.appendChild(
      createHelperText(
        'The crystal is sheared from the top. Above the lattice friction stress τ_P, an edge dislocation (yellow ring) enters and glides along the slip plane, one bond at a time, leaving a step of one Burgers vector b.'
      )
    );
    controlsPanel.appendChild(info.element);

    const loadSection = createSection({ title: 'Loading' });
    disposables.push(loadSection);

    sliders.rate = createSlider({
      label: 'Shear rate',
      min: 0.002,
      max: 0.05,
      step: 0.002,
      value: params.rate,
      format: (v) => v.toFixed(3) + ' /s',
      onChange: (v) => {
        params.rate = v;
        updateUrl();
      },
    });
    sliders.tauP = createSlider({
      label: 'Lattice friction τ_P / G',
      min: 0.01,
      max: 0.12,
      step: 0.005,
      value: params.tauP,
      format: (v) => v.toFixed(3),
      onChange: (v) => {
        params.tauP = v;
        updateUrl();
      },
    });
    sliders.width = createSlider({
      label: 'Core width w',
      min: 0.6,
      max: 2.5,
      step: 0.1,
      value: params.width,
      format: (v) => v.toFixed(1) + ' a',
      onChange: (v) => {
        params.width = v;
        updateUrl();
      },
    });
    for (const s of [sliders.rate, sliders.tauP, sliders.width]) {
      disposables.push(s);
      loadSection.content.appendChild(s.element);
    }

    playButton = createButton({
      label: 'Pause',
      onClick: () => {
        paused = !paused;
        playButton?.setLabel(paused ? 'Play' : 'Pause');
      },
    });
    dirButton = createButton({
      label: 'Unload',
      variant: 'secondary',
      onClick: () => {
        dir = -dir;
        dirButton?.setLabel(dir > 0 ? 'Unload' : 'Load');
      },
    });
    const resetButton = createButton({
      label: 'Reset',
      variant: 'secondary',
      onClick: reset,
    });
    for (const b of [playButton, dirButton, resetButton]) {
      disposables.push(b);
      loadSection.content.appendChild(b.element);
    }
    controlsPanel.appendChild(loadSection.element);

    const display = createSection({ title: 'Display' });
    disposables.push(display);
    const addCheck = (key: 'trail' | 'ghosts' | 'burgers', label: string) => {
      const c = createCheckbox({
        label,
        checked: params[key],
        onChange: (v) => {
          params[key] = v;
          updateUrl();
        },
      });
      checks[key] = c;
      disposables.push(c);
      display.content.appendChild(c.element);
    };
    addCheck('trail', 'Glide trail (swept slip plane)');
    addCheck('ghosts', 'Ghost atoms (undeformed)');
    addCheck('burgers', 'Burgers vector');
    controlsPanel.appendChild(display.element);
  }

  const loop = new AnimationLoop((dt) => {
    if (!paused) advance(Math.min(dt, 0.05));
    render();
  });

  function advance(dt: number) {
    const p = model();
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    const before = state.gamma;
    gliding = false;
    for (let k = 0; k < n; k++) {
      if (step(state, p, dir, params.rate, h)) gliding = true;
    }
    if (state.gamma !== before || hx.length === 0) {
      hx.push(state.gamma);
      hy.push(tau(state, p));
      hd.push(dir);
      if (hx.length > MAX_HISTORY) {
        hx.shift();
        hy.shift();
        hd.shift();
      }
    }
  }

  function stageText(): string {
    const p = model();
    const t = tau(state, p);
    if (gliding && state.xd < 0) return 'Stress exceeds τ_P: a dislocation nucleates at the left surface';
    if (gliding) return 'The dislocation glides along the slip plane: one row of bonds at a time';
    if (dir < 0 && t < 1e-6) return 'Unloaded: elastic strain recovers, the slip step stays (permanent deformation)';
    if (state.slips > 0 && state.xd <= xStart(p) + 1e-9) return 'Dislocation left the crystal: a step of height b remains';
    if (t >= p.tauP) return 'Yield: stress is pinned at τ_P while the dislocation moves';
    return 'Elastic regime: bonds stretch, no dislocation yet';
  }

  function render() {
    const W = canvas.width;
    const Hh = canvas.height;
    const ctx = canvas.ctx;
    canvas.clear();
    const wide = W >= Hh * 1.4;
    const cw = wide ? W * 0.62 : W;
    const ch = wide ? Hh : Hh * 0.58;
    renderCrystal(ctx, 0, 0, cw, ch);
    ctx.save();
    ctx.translate(wide ? cw : 0, wide ? 0 : ch);
    renderPlot(ctx, wide ? W - cw : W, wide ? Hh : Hh - ch);
    ctx.restore();
  }

  function renderCrystal(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number) {
    const p = model();
    const { x, y } = displaced(state, p);
    const bs = bonds(x, y);
    const strain = atomStrain(bs);

    // World window: leave room on the right for the slip steps, below for the caption
    const x0 = -1.5;
    const x1 = NX + 4.5;
    const y0 = -1.8;
    const y1 = NY + 0.8;
    const capH = 58;
    const scale = Math.min(w / (x1 - x0), (h - capH) / (y1 - y0));
    const px = ox + (w - scale * (x1 - x0)) / 2;
    const py = oy + 4;
    const X = (v: number) => px + (v - x0) * scale;
    const Y = (v: number) => py + (y1 - v) * scale;
    const r = scale * 0.3;

    // Fixed bottom grip and moving top grip
    ctx.fillStyle = '#2a303c';
    ctx.fillRect(X(-0.8), Y(-0.5), (NX + 0.6 + 4) * scale, 0.5 * scale);
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('fixed', X(-0.8), Y(-0.9));

    // Slip plane: swept (solid) and unswept (dashed)
    // Upper atoms are rigidly shifted by one b per completed slip, so the core,
    // the trail and the ring all live in that shifted frame.
    const elOff = (state.gamma - gammaPlastic(state, p)) * SLIP_Y + state.slips;
    const sy = Y(SLIP_Y);
    const swept = clamp(state.xd, -0.5, NX - 0.5);
    ctx.save();
    if (params.trail) {
      ctx.fillStyle = 'rgba(255,216,74,0.14)';
      ctx.fillRect(X(-0.5 + elOff), sy - 0.5 * scale, (swept + 0.5) * scale, scale);
      ctx.strokeStyle = COLOR_CORE;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(X(-0.5 + elOff), sy);
      ctx.lineTo(X(swept + elOff), sy);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(X(params.trail ? swept + elOff : -0.5 + elOff), sy);
    ctx.lineTo(X(NX - 0.5 + elOff), sy);
    ctx.stroke();
    ctx.restore();

    // Ghost atoms at the undeformed positions
    if (params.ghosts) {
      ctx.strokeStyle = 'rgba(200,200,200,0.2)';
      ctx.lineWidth = 1;
      for (let j = 0; j < NY; j++) {
        for (let i = 0; i < NX; i++) {
          ctx.beginPath();
          ctx.arc(X(i), Y(j), r, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // Bonds coloured by strain
    ctx.lineWidth = Math.max(1.5, scale * 0.09);
    for (const bd of bs) {
      ctx.strokeStyle = strainColor(bd.strain);
      ctx.beginPath();
      ctx.moveTo(X(x[bd.a]!), Y(y[bd.a]!));
      ctx.lineTo(X(x[bd.b]!), Y(y[bd.b]!));
      ctx.stroke();
    }

    // Atoms; the extra half-plane at the core gets a green ring
    const inside = state.xd >= -0.5 && state.xd <= NX - 0.5;
    const col = Math.round(clamp(state.xd, 0, NX - 1));
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        ctx.fillStyle = strainColor(strain[k]! * 2);
        ctx.beginPath();
        ctx.arc(X(x[k]!), Y(y[k]!), r, 0, Math.PI * 2);
        ctx.fill();
        if (j === 0 || j === NY - 1) {
          ctx.strokeStyle = 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        if (inside && i === col && j >= SLIP_ROW && j < NY - 1) {
          ctx.strokeStyle = ROLE_COLORS.extra;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    // Core marker
    if (inside) {
      const cx = X(state.xd + 0.5 + elOff);
      const glow = ctx.createRadialGradient(cx, sy, 0, cx, sy, scale * 2.2);
      glow.addColorStop(0, 'rgba(255,216,74,0.45)');
      glow.addColorStop(1, 'rgba(255,216,74,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, sy, scale * 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = COLOR_CORE;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, sy, scale * 1.1, 0, Math.PI * 2);
      ctx.stroke();
      // Edge-dislocation symbol (extra half-plane above the slip plane)
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx - scale * 0.5, sy);
      ctx.lineTo(cx + scale * 0.5, sy);
      ctx.moveTo(cx, sy);
      ctx.lineTo(cx, sy - scale * 0.9);
      ctx.stroke();
      ctx.fillStyle = COLOR_CORE;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('dislocation', cx, Y(NY - 0.2) - 4);
      ctx.strokeStyle = 'rgba(255,216,74,0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(cx, Y(NY - 0.2));
      ctx.lineTo(cx, sy - scale * 1.1);
      ctx.stroke();
      ctx.setLineDash([]);

      if (params.burgers) {
        const ay = sy + scale * 1.8;
        drawArrow(ctx, cx - scale * 0.5, ay, cx + scale * 0.5, ay, ROLE_COLORS.extra);
        ctx.fillStyle = ROLE_COLORS.extra;
        ctx.font = 'italic bold 14px sans-serif';
        ctx.fillText('b', cx, ay + 16);
      }
    }

    // Shear force arrow on the top grip
    const topY = Y(NY - 1 - 0.7);
    const topX = X(x[(NY - 1) * NX + NX - 1]! + 1);
    const f = clamp(tau(state, p) / 0.1, 0, 1.4);
    if (f > 0.02) {
      drawArrow(ctx, topX - scale * (0.5 + 2.5 * f), topY - scale * 0.8, topX, topY - scale * 0.8, COLOR_LOAD);
      ctx.fillStyle = COLOR_LOAD;
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText('shear force', topX, topY - scale * 1.1);
    }

    // Slip step counter
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`slip steps: ${state.slips}   γ = ${state.gamma.toFixed(3)}`, ox + w - 10, py + 14);

    // Strain legend
    const lx = ox + 12;
    const ly = oy + h - capH + 8;
    const grad = ctx.createLinearGradient(lx, 0, lx + 110, 0);
    grad.addColorStop(0, strainColor(-STRAIN_RANGE));
    grad.addColorStop(0.5, strainColor(0));
    grad.addColorStop(1, strainColor(STRAIN_RANGE));
    ctx.fillStyle = grad;
    ctx.fillRect(lx, ly, 110, 8);
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('compressed', lx, ly + 22);
    ctx.textAlign = 'right';
    ctx.fillText('stretched', lx + 110, ly + 22);
    ctx.textAlign = 'left';
    ctx.strokeStyle = ROLE_COLORS.extra;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx + 135, ly + 4, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillText('extra half-plane', lx + 145, ly + 8);

    // Caption
    ctx.fillStyle = '#e6e9ef';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(stageText(), ox + w / 2, oy + h - 8);
  }

  function drawArrow(
    ctx: CanvasRenderingContext2D,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string
  ) {
    const a = Math.atan2(y1 - y0, x1 - x0);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - 9 * Math.cos(a - 0.4), y1 - 9 * Math.sin(a - 0.4));
    ctx.lineTo(x1 - 9 * Math.cos(a + 0.4), y1 - 9 * Math.sin(a + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function renderPlot(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const p = model();
    plot.setSize(w, h);
    const xTicks = Plot2D.generateTicks(0, GAMMA_MAX, 4);
    const yTicks = Plot2D.generateTicks(0, 0.2, 4);
    plot.drawGrid(xTicks, yTicks);
    plot.drawAxes('shear strain γ', 'shear stress τ / G');
    plot.drawTickLabels(xTicks, yTicks);

    // Reference lines
    const line = (v: number, color: string, label: string, above: boolean) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(plot.toCanvasX(0), plot.toCanvasY(v));
      ctx.lineTo(plot.toCanvasX(GAMMA_MAX), plot.toCanvasY(v));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(label, plot.toCanvasX(GAMMA_MAX) - 4, plot.toCanvasY(v) + (above ? -5 : 13));
      ctx.restore();
    };
    line(TAU_THEORY, 'rgba(255,255,255,0.5)', 'rigid slip (no dislocation): G/2π', true);
    line(p.tauP, COLOR_CORE, 'dislocation glide: τ_P', false);

    // Curve, split into loading / unloading runs
    let start = 0;
    for (let k = 1; k <= hx.length; k++) {
      if (k === hx.length || hd[k] !== hd[start]) {
        const end = Math.min(k + 1, hx.length);
        plot.drawLine(hx.slice(start, end), hy.slice(start, end), hd[start]! > 0 ? COLOR_LOAD : COLOR_UNLOAD, 2);
        start = k;
      }
    }

    // Live point; glow while the dislocation moves
    const lx = state.gamma;
    const ly = tau(state, p);
    if (gliding) plot.drawPoint(lx, ly, 10, 'rgba(255,216,74,0.35)');
    plot.drawPoint(lx, ly, 5, dir > 0 ? COLOR_LOAD : COLOR_UNLOAD);

    // Legend
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    let lxp = plot.toCanvasX(0) + 6;
    const lyp = 16;
    for (const [c, t] of [
      [COLOR_LOAD, 'loading'],
      [COLOR_UNLOAD, 'unloading'],
    ] as const) {
      ctx.fillStyle = c;
      ctx.fillRect(lxp, lyp - 2, 12, 3);
      ctx.fillStyle = '#ccc';
      ctx.fillText(t, lxp + 17, lyp + 3);
      lxp += 85;
    }
  }

  function handleResize() {
    render();
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
      canvas.dispose();
    },
    getParams() {
      return toRecord(params);
    },
    setParams(p: Record<string, string>) {
      parseParams(p, params);
      syncControls();
    },
  };
}

export const shearDislocationDemo: DemoDefinition = {
  id: 'shear-dislocation',
  title: 'Dislocation glide under shear',
  description:
    'A 2D square crystal under shear: an edge dislocation nucleates, glides across the slip plane and leaves a step, producing yielding at a stress far below the rigid-slip strength.',
  category: 'Mechanical',
  tags: ['dislocation', 'shear', 'slip', 'yield', 'strength', 'peierls'],
  create,
};

export default shearDislocationDemo;
