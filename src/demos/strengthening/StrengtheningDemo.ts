/**
 * Strengthening mechanisms in metals (Lecture 5: Strength).
 *
 * Schematic 2D discrete-dislocation simulation. Edge dislocations (drawn as
 * the usual perpendicular symbol) glide on three slip systems at 0/60/120
 * degrees and interact elastically. Grain boundaries, solutes, precipitates
 * and pre-existing dislocations (cold work) obstruct their motion; the
 * resulting stress-strain curve is measured live and curves can be overlaid.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import { Plot2D } from '@core/canvas/Plot2D';
import { createSlider, createCheckbox, createButton, createSelect, type Disposable } from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  Crystal,
  LX,
  LY,
  GAMMA_END,
  GRAIN_MAX,
  SIM_DT,
  SYS_ANGLE,
  MISFIT_REF,
  flowStress,
  runCurve,
  type Settings,
} from './strengthening';

interface DemoParams {
  systems: number;
  grain: number;
  solute: number;
  misfit: number;
  prec: number;
  radius: number;
  density: number;
  speed: number;
  seed: number;
  trails: boolean;
}

const defaultParams: DemoParams = {
  systems: 1,
  grain: GRAIN_MAX,
  solute: 0,
  misfit: MISFIT_REF,
  prec: 0,
  radius: 4,
  density: 0,
  speed: 4,
  seed: 1,
  trails: true,
};

const RATE = 0.002;
const SYS_COLORS = ['#ff6b6b', '#4ade80', '#60a5fa'];
const COLOR_LIVE = '#ffd84a';
const SAVED_COLORS = ['#a78bfa', '#38bdf8', '#fb923c', '#f472b6', '#34d399', '#e5e7eb'];
const PLOT_MAX = 0.2;
const TRAIL_LEN = 14;

const PRESETS: { label: string; values: Partial<DemoParams>; name: string }[] = [
  { label: 'Pure crystal', name: 'pure', values: {} },
  { label: 'Grain boundaries', name: 'grain boundaries', values: { grain: 15 } },
  { label: 'Solid solution', name: 'solid solution', values: { solute: 0.02 } },
  { label: 'Precipitates', name: 'precipitates', values: { prec: 0.2, radius: 4 } },
  { label: 'Cold work', name: 'cold work', values: { density: 0.03 } },
];

interface SavedCurve {
  label: string;
  color: string;
  gamma: number[];
  sigma: number[];
  flow: number;
}

function num(v: string | undefined, lo: number, hi: number, fb: number): number {
  const x = parseFloat(v ?? '');
  return clamp(Number.isFinite(x) ? x : fb, lo, hi);
}

function parseParams(src: Record<string, string>, p: DemoParams): void {
  if (src.systems !== undefined) p.systems = src.systems === '3' ? 3 : 1;
  if (src.misfit !== undefined) p.misfit = num(src.misfit, -0.2, 0.2, defaultParams.misfit);
  if (src.grain !== undefined) p.grain = Math.round(num(src.grain, 8, GRAIN_MAX, defaultParams.grain));
  if (src.solute !== undefined) p.solute = num(src.solute, 0, 0.03, defaultParams.solute);
  if (src.prec !== undefined) p.prec = num(src.prec, 0, 0.3, defaultParams.prec);
  if (src.radius !== undefined) p.radius = num(src.radius, 1, 8, defaultParams.radius);
  if (src.density !== undefined) p.density = num(src.density, 0, 0.04, defaultParams.density);
  if (src.speed !== undefined) p.speed = Math.round(num(src.speed, 1, 12, defaultParams.speed));
  if (src.seed !== undefined) p.seed = Math.round(num(src.seed, 1, 9999, defaultParams.seed));
  if (src.trails !== undefined) p.trails = src.trails === 'true';
}

function toRecord(p: DemoParams): Record<string, string> {
  return {
    systems: String(p.systems),
    grain: String(p.grain),
    solute: String(p.solute),
    misfit: String(p.misfit),
    prec: String(p.prec),
    radius: String(p.radius),
    density: String(p.density),
    speed: String(p.speed),
    seed: String(p.seed),
    trails: String(p.trails),
  };
}

function toSettings(p: DemoParams): Settings {
  return {
    rate: RATE,
    systems: p.systems,
    grainSize: p.grain,
    solute: p.solute,
    misfit: p.misfit,
    precFrac: p.prec,
    precRadius: p.radius,
    density: p.density,
    seed: p.seed,
  };
}

function describe(p: DemoParams): string {
  const parts: string[] = [];
  if (p.grain < GRAIN_MAX) parts.push(`grains ${p.grain}b`);
  if (p.systems === 3) parts.push('3 slip systems');
  if (p.solute > 0) parts.push(`solute ${(p.solute * 100).toFixed(1)}% (${p.misfit >= 0 ? '+' : ''}${(p.misfit * 100).toFixed(0)}% size)`);
  if (p.prec > 0) parts.push(`precip. ${(p.prec * 100).toFixed(0)}%, r=${p.radius.toFixed(1)}`);
  if (p.density > 0) parts.push(`ρ=${p.density.toFixed(3)}`);
  return parts.length ? parts.join(', ') : 'pure crystal';
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  let crystal = new Crystal(toSettings(params));
  let paused = false;
  let computing = '';
  let cancelCompare = false;
  const saved: SavedCurve[] = [];
  const hx: number[] = [];
  const hy: number[] = [];
  const trails = new Map<number, { x: number; y: number }[]>();
  let stepCount = 0;

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0b0e14', autoResize: true });
  const plot = new Plot2D(canvas.ctx, {
    bounds: { xMin: 0, xMax: PLOT_MAX, yMin: 0, yMax: PLOT_MAX },
    margins: { top: 34, right: 20, bottom: 46, left: 58 },
  });

  const disposables: Disposable[] = [];
  const sliders: Record<string, ReturnType<typeof createSlider>> = {};
  let systemsSelect: ReturnType<typeof createSelect> | null = null;
  let trailBox: ReturnType<typeof createCheckbox> | null = null;
  let playButton: ReturnType<typeof createButton> | null = null;

  function updateUrl() {
    options.setParams(toRecord(params));
  }

  function restart() {
    crystal = new Crystal(toSettings(params));
    hx.length = 0;
    hy.length = 0;
    trails.clear();
    stepCount = 0;
  }

  function syncControls() {
    systemsSelect?.setValue(String(params.systems));
    sliders.grain?.setValue(params.grain);
    sliders.solute?.setValue(params.solute);
    sliders.prec?.setValue(params.prec);
    sliders.radius?.setValue(params.radius);
    sliders.misfit?.setValue(params.misfit);
    sliders.density?.setValue(params.density);
    sliders.speed?.setValue(params.speed);
    trailBox?.setChecked(params.trails);
  }

  function applyPreset(values: Partial<DemoParams>) {
    params.grain = GRAIN_MAX;
    params.solute = 0;
    params.prec = 0;
    params.density = 0;
    Object.assign(params, values);
    syncControls();
    updateUrl();
    restart();
  }

  function saveCurve() {
    if (hx.length < 2) return;
    saved.push({
      label: describe(params),
      color: SAVED_COLORS[saved.length % SAVED_COLORS.length]!,
      gamma: hx.slice(),
      sigma: hy.slice(),
      flow: flowStress(hx, hy),
    });
  }

  function compare() {
    cancelCompare = false;
    saved.length = 0;
    let k = 0;
    const next = () => {
      if (cancelCompare || k >= PRESETS.length) {
        computing = '';
        return;
      }
      const preset = PRESETS[k]!;
      computing = `Computing ${preset.name} (${k + 1}/${PRESETS.length})…`;
      setTimeout(() => {
        if (cancelCompare) {
          computing = '';
          return;
        }
        const p: DemoParams = { ...defaultParams, seed: params.seed, systems: params.systems, misfit: params.misfit, ...preset.values };
        const r = runCurve(toSettings(p));
        saved.push({
          label: preset.name,
          color: SAVED_COLORS[k % SAVED_COLORS.length]!,
          gamma: r.gamma,
          sigma: r.sigma,
          flow: r.flow,
        });
        k++;
        next();
      }, 30);
    };
    next();
  }

  if (controlsPanel) {
    const info = createSection({ title: 'Strengthening mechanisms' });
    disposables.push(info);
    info.content.appendChild(
      createHelperText(
        'Edge dislocations (⊥) glide on three slip systems (0°, 60°, 120°) and push on each other. Anything that makes gliding harder raises the stress needed to keep deforming the crystal.'
      )
    );
    controlsPanel.appendChild(info.element);

    const geom = createSection({ title: 'Slip systems' });
    disposables.push(geom);
    systemsSelect = createSelect({
      label: 'Active slip systems (dislocation sources)',
      options: [
        { value: '1', label: '0° only (simplest)' },
        { value: '3', label: 'All three: 0°, 60°, 120°' },
      ],
      value: String(params.systems),
      onChange: (v) => {
        params.systems = v === '3' ? 3 : 1;
        updateUrl();
        restart();
      },
    });
    disposables.push(systemsSelect);
    geom.content.appendChild(systemsSelect.element);
    geom.content.appendChild(
      createHelperText('Cold-work dislocations are always present on all three systems.')
    );
    controlsPanel.appendChild(geom.element);

    const presets = createSection({ title: 'Presets' });
    disposables.push(presets);
    for (const preset of PRESETS) {
      const b = createButton({
        label: preset.label,
        variant: 'secondary',
        onClick: () => applyPreset(preset.values),
      });
      disposables.push(b);
      presets.content.appendChild(b.element);
    }
    const cmp = createButton({ label: 'Compare all mechanisms', onClick: compare });
    disposables.push(cmp);
    presets.content.appendChild(cmp.element);
    controlsPanel.appendChild(presets.element);

    const mech = createSection({ title: 'Mechanisms' });
    disposables.push(mech);
    const add = (
      key: 'grain' | 'solute' | 'misfit' | 'prec' | 'radius' | 'density',
      label: string,
      min: number,
      max: number,
      step: number,
      format: (v: number) => string
    ) => {
      const s = createSlider({
        label,
        min,
        max,
        step,
        value: params[key],
        format,
        onChange: (v) => {
          params[key] = v;
          updateUrl();
          restart();
        },
      });
      sliders[key] = s;
      disposables.push(s);
      mech.content.appendChild(s.element);
    };
    add('grain', 'Grain size (GB strengthening)', 8, GRAIN_MAX, 1, (v) => (v >= GRAIN_MAX ? 'none' : v.toFixed(0) + ' b'));
    add('solute', 'Solute concentration', 0, 0.03, 0.001, (v) => (v * 100).toFixed(1) + ' %');
    add('misfit', 'Solute size vs host atom', -0.2, 0.2, 0.01, (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(0) + ' %');
    add('prec', 'Precipitate fraction', 0, 0.3, 0.01, (v) => (v * 100).toFixed(0) + ' %');
    add('radius', 'Precipitate radius', 1, 8, 0.5, (v) => v.toFixed(1) + ' b');
    add('density', 'Initial dislocation density (cold work)', 0, 0.04, 0.001, (v) => v.toFixed(3));
    controlsPanel.appendChild(mech.element);

    const run = createSection({ title: 'Simulation' });
    disposables.push(run);
    const speed = createSlider({
      label: 'Speed',
      min: 1,
      max: 12,
      step: 1,
      value: params.speed,
      format: (v) => v.toFixed(0) + '×',
      onChange: (v) => {
        params.speed = v;
        updateUrl();
      },
    });
    sliders.speed = speed;
    disposables.push(speed);
    run.content.appendChild(speed.element);

    trailBox = createCheckbox({
      label: 'Show glide trails',
      checked: params.trails,
      onChange: (v) => {
        params.trails = v;
        updateUrl();
      },
    });
    disposables.push(trailBox);
    run.content.appendChild(trailBox.element);

    playButton = createButton({
      label: 'Pause',
      onClick: () => {
        paused = !paused;
        playButton?.setLabel(paused ? 'Play' : 'Pause');
      },
    });
    const restartBtn = createButton({ label: 'Restart test', variant: 'secondary', onClick: restart });
    const seedBtn = createButton({
      label: 'New random structure',
      variant: 'secondary',
      onClick: () => {
        params.seed = 1 + Math.floor(Math.random() * 9999);
        updateUrl();
        restart();
      },
    });
    const saveBtn = createButton({ label: 'Save curve (overlay)', variant: 'secondary', onClick: saveCurve });
    const clearBtn = createButton({
      label: 'Clear saved curves',
      variant: 'secondary',
      onClick: () => {
        cancelCompare = true;
        computing = '';
        saved.length = 0;
      },
    });
    for (const b of [playButton, restartBtn, seedBtn, saveBtn, clearBtn]) {
      disposables.push(b);
      run.content.appendChild(b.element);
    }
    controlsPanel.appendChild(run.element);
  }

  const loop = new AnimationLoop(() => {
    if (!paused) advance();
    render();
  });

  function advance() {
    for (let k = 0; k < params.speed; k++) {
      if (crystal.gamma >= GAMMA_END) break;
      crystal.step(SIM_DT);
      if (stepCount++ % 5 === 0) {
        hx.push(crystal.gamma);
        hy.push(crystal.sigma);
      }
    }
    // Trails: last positions per dislocation
    const alive = new Set<number>();
    for (const d of crystal.disl) {
      alive.add(d.id);
      let t = trails.get(d.id);
      if (!t) {
        t = [];
        trails.set(d.id, t);
      }
      const last = t[t.length - 1];
      if (!last || Math.hypot(last.x - d.x, last.y - d.y) > 0.3) {
        t.push({ x: d.x, y: d.y });
        if (t.length > TRAIL_LEN) t.shift();
      }
    }
    if (trails.size > alive.size) {
      for (const id of trails.keys()) if (!alive.has(id)) trails.delete(id);
    }
  }

  function render() {
    const W = canvas.width;
    const H = canvas.height;
    const ctx = canvas.ctx;
    canvas.clear();
    const wide = W >= H * 1.3;
    const bw = wide ? W * 0.55 : W;
    const bh = wide ? H : H * 0.55;
    renderBox(ctx, 0, 0, bw, bh);
    ctx.save();
    ctx.translate(wide ? bw : 0, wide ? 0 : bh);
    renderPlot(ctx, wide ? W - bw : W, wide ? H : H - bh);
    ctx.restore();
  }

  function drawDislocation(
    ctx: CanvasRenderingContext2D,
    X: number,
    Y: number,
    sys: number,
    sign: number,
    scale: number,
    color: string
  ) {
    const th = SYS_ANGLE[sys]!;
    const ex = Math.cos(th);
    const ey = -Math.sin(th);
    // Normal pointing towards the extra half-plane (up for + dislocations)
    const nx = -Math.sin(th) * sign;
    const ny = -Math.cos(th) * sign;
    const a = scale * 1.1;
    const h = scale * 1.9;
    ctx.beginPath();
    ctx.moveTo(X - ex * a, Y - ey * a);
    ctx.lineTo(X + ex * a, Y + ey * a);
    ctx.moveTo(X, Y);
    ctx.lineTo(X + nx * h, Y + ny * h);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, scale * 0.28);
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function renderBox(ctx: CanvasRenderingContext2D, ox: number, oy: number, w: number, h: number) {
    const capH = 70;
    const pad = 22;
    const scale = Math.min((w - 2 * pad) / LX, (h - capH - 2 * pad) / LY);
    const px = ox + (w - LX * scale) / 2;
    const py = oy + pad + 10;
    const X = (x: number) => px + x * scale;
    const Y = (y: number) => py + (LY - y) * scale;

    // Box
    ctx.fillStyle = '#10151f';
    ctx.fillRect(X(0), Y(LY), LX * scale, LY * scale);

    ctx.save();
    ctx.beginPath();
    ctx.rect(X(0), Y(LY), LX * scale, LY * scale);
    ctx.clip();

    // Grain boundaries (hexagonal grains)
    if (crystal.hasGrains) {
      ctx.strokeStyle = '#8aa0c8';
      ctx.lineWidth = 2;
      for (const c of crystal.grainCenters()) {
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 180) * (30 + 60 * k);
          const x = X(c.x + c.R * Math.cos(a));
          const y = Y(c.y + c.R * Math.sin(a));
          if (k === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }

    // Precipitates
    for (const p of crystal.precs) {
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), p.r * scale, 0, Math.PI * 2);
      ctx.fillStyle = '#2b3550';
      ctx.fill();
      ctx.strokeStyle = '#6f84b8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Solutes: all the same size, relative to the host atom radius (0.5 b)
    for (const sol of crystal.solutes) {
      ctx.beginPath();
      ctx.arc(X(sol.x), Y(sol.y), Math.max(1.5, scale * 0.5 * (1 + sol.misfit * 3)), 0, Math.PI * 2);
      ctx.fillStyle = sol.misfit >= 0 ? '#f59e0b' : '#34d399';
      ctx.fill();
    }

    // Sources
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    for (const s of crystal.sources) {
      const x = X(s.x);
      const y = Y(s.y);
      const r = Math.max(2, scale * 0.35);
      ctx.beginPath();
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      ctx.fill();
    }

    // Trails
    if (params.trails) {
      ctx.lineWidth = 2;
      for (const d of crystal.disl) {
        const t = trails.get(d.id);
        if (!t || t.length < 2) continue;
        for (let k = 1; k < t.length; k++) {
          ctx.strokeStyle = SYS_COLORS[d.sys]!;
          ctx.globalAlpha = 0.5 * (k / t.length);
          ctx.beginPath();
          ctx.moveTo(X(t[k - 1]!.x), Y(t[k - 1]!.y));
          ctx.lineTo(X(t[k]!.x), Y(t[k]!.y));
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Dislocations
    const sym = Math.max(3, scale * 0.9);
    for (const d of crystal.disl) {
      const x = X(d.x);
      const y = Y(d.y);
      const color = SYS_COLORS[d.sys]!;
      if (d.moving) {
        const glow = ctx.createRadialGradient(x, y, 0, x, y, sym * 2.2);
        glow.addColorStop(0, 'rgba(255,255,255,0.35)');
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, sym * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      if (d.blocked) {
        ctx.beginPath();
        ctx.arc(x, y, sym * 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      drawDislocation(ctx, x, y, d.sys, d.sign, sym, color);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(X(0), Y(LY), LX * scale, LY * scale);

    // Shear arrows on the top (right) and bottom (left)
    const f = clamp(crystal.sigma / 0.1, 0, 1.5);
    if (f > 0.02) {
      const len = 20 + 50 * f;
      arrow(ctx, X(LX / 2) - len / 2, Y(LY) - 10, X(LX / 2) + len / 2, Y(LY) - 10, '#ff6b6b');
      arrow(ctx, X(LX / 2) + len / 2, Y(0) + 10, X(LX / 2) - len / 2, Y(0) + 10, '#ff6b6b');
    }

    // Readout
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(
      `dislocations: ${crystal.disl.length}   moving: ${crystal.disl.filter((d) => d.moving).length}   blocked: ${crystal.disl.filter((d) => d.blocked).length}`,
      px,
      oy + 16
    );

    // Legend
    const ly = oy + h - capH + 14;
    let lx = px;
    ctx.font = '12px sans-serif';
    ['0°', '60°', '120°'].forEach((label, k) => {
      drawDislocation(ctx, lx + 8, ly + 4, k, 1, 5, SYS_COLORS[k]!);
      ctx.fillStyle = '#ccc';
      ctx.fillText(label, lx + 20, ly + 6);
      lx += 56;
    });
    ctx.fillStyle = '#ccc';
    ctx.fillText('slip system', lx - 6, ly + 6);
    lx += 82;
    ctx.beginPath();
    ctx.arc(lx + 5, ly + 4, 7, 0, Math.PI * 2);
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ccc';
    ctx.fillText('blocked', lx + 17, ly + 6);
    lx += 78;
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(lx, ly, 8, 8);
    ctx.fillStyle = '#ccc';
    ctx.fillText('source', lx + 14, ly + 7);

    const ly2 = ly + 22;
    lx = px;
    const items: [string, string][] = [];
    if (crystal.hasGrains) items.push(['#8aa0c8', 'grain boundary']);
    if (crystal.solutes.length) items.push([params.misfit >= 0 ? '#f59e0b' : '#34d399', params.misfit >= 0 ? 'oversized solute' : 'undersized solute']);
    if (crystal.precs.length) items.push(['#6f84b8', 'precipitate']);
    for (const [c, t] of items) {
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(lx + 5, ly2 + 4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ccc';
      ctx.fillText(t, lx + 14, ly2 + 8);
      lx += 28 + t.length * 6.2;
    }

    ctx.fillStyle = '#e6e9ef';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(caption(), ox + w / 2, oy + h - 8);
  }

  function caption(): string {
    if (computing) return computing;
    if (crystal.gamma >= GAMMA_END) return 'Test complete: save the curve and change a mechanism to compare';
    const nb = crystal.disl.filter((d) => d.blocked).length;
    if (crystal.disl.length === 0) return 'Elastic loading: no dislocations yet';
    if (nb > crystal.disl.length * 0.4) return 'Many dislocations are blocked: the stress must rise to keep deforming';
    return 'Dislocations glide, driven by the applied shear and by each other';
  }

  function arrow(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color: string) {
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
    plot.setSize(w, h);
    const ticks = Plot2D.generateTicks(0, PLOT_MAX, 4);
    plot.drawGrid(ticks, ticks);
    plot.drawAxes('shear strain γ', 'shear stress τ / G');
    plot.drawTickLabels(ticks, ticks);

    for (const c of saved) {
      plot.drawLine(c.gamma, c.sigma, c.color, 2);
      if (Number.isFinite(c.flow)) {
        ctx.save();
        ctx.strokeStyle = c.color;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(plot.toCanvasX(0.75 * GAMMA_END), plot.toCanvasY(c.flow));
        ctx.lineTo(plot.toCanvasX(GAMMA_END), plot.toCanvasY(c.flow));
        ctx.stroke();
        ctx.restore();
      }
    }
    plot.drawLine(hx, hy, COLOR_LIVE, 2.5);
    plot.drawPoint(crystal.gamma, crystal.sigma, 5, COLOR_LIVE);

    // Legend: live curve then saved curves, with flow stress
    ctx.save();
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    const entries: [string, string][] = [[COLOR_LIVE, `now: ${describe(params)}`]];
    for (const c of saved) entries.push([c.color, `${c.label}  (σ_flow ≈ ${c.flow.toFixed(3)})`]);
    let y = 16;
    const x = plot.toCanvasX(0) + 6;
    for (const [c, t] of entries) {
      ctx.fillStyle = c;
      ctx.fillRect(x, y - 3, 14, 3);
      ctx.fillStyle = '#ccc';
      ctx.fillText(t, x + 20, y + 2);
      y += 14;
    }
    ctx.restore();
    void h;
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
      cancelCompare = true;
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
      restart();
    },
  };
}

export const strengtheningDemo: DemoDefinition = {
  id: 'strengthening',
  title: 'Strengthening mechanisms',
  description:
    'Discrete dislocations glide on three slip systems and interact elastically. Grain boundaries, solutes, precipitates and cold work obstruct them and raise the stress-strain curve.',
  category: 'Mechanical',
  tags: ['dislocation', 'strengthening', 'hall-petch', 'solid solution', 'precipitate', 'cold work'],
  create,
};

export default strengtheningDemo;
