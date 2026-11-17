/**
 * Band diagrams and carrier density n(T) (Lecture 14: Electrical properties)
 *
 * Left: the density of carriers available for conduction against temperature, for a metal,
 * a semiconductor and an insulator (log scale by default), with a dot at the current
 * temperature. Right: the matching simplified band diagram, drawn to scale in energy, with
 * electrons (blue) and holes (red) as dots that appear, wander and annihilate.
 *
 * The physics and the dot dynamics are in bands.ts. The number of dots is schematic: it
 * follows log10(n), not n.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import { AnimationLoop } from '@core/canvas/AnimationLoop';
import {
  createSlider,
  createSelect,
  createCheckbox,
  createButton,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type CheckboxControl,
  type ButtonControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  BandSim,
  PRESETS,
  ROWS,
  COLS,
  NSLOT,
  T_MAX,
  KB_EV,
  JUMP_TIME,
  classify,
  density,
  log10Density,
  type Kind,
  type Material,
} from './bands';

interface DemoParams {
  material: Material;
  gap: number;
  temperature: number;
  log: boolean;
}

const defaultParams: DemoParams = {
  material: 'semiconductor',
  gap: 1.12,
  temperature: 300,
  log: true,
};

const COLOR_E = '#4ac3ff';
const COLOR_H = '#ff5a6e';
const COLOR_VAL = '#aab8d8';
const COLOR_METAL = '#ffb454';
const COLOR_SEMI = '#4ac3ff';
const COLOR_INS = '#b48cff';

const BAND_EV = 2.2; // schematic band width (eV)
const METAL_EV = 5; // height of the metal band (eV)
const LOG_MIN = 0;
const LOG_MAX = 24;
const SWEEP_RATE = 150; // K per s

const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹';
function sup(n: number): string {
  const s = String(Math.abs(Math.round(n)));
  return (n < 0 ? '⁻' : '') + [...s].map((c) => SUP[Number(c)]).join('');
}

/** 1.2×10¹⁶ */
function fmtSci(v: number): string {
  if (!(v > 0)) return '0';
  const e = Math.floor(Math.log10(v));
  const m = v / Math.pow(10, e);
  if (e >= -1 && e <= 2) return v.toPrecision(2);
  return `${m.toFixed(1)}×10${sup(e)}`;
}

function parseParams(raw: Record<string, string>, base: DemoParams): DemoParams {
  const num = (key: string, fallback: number): number => {
    const v = parseFloat(raw[key] ?? '');
    return Number.isFinite(v) ? v : fallback;
  };
  const gap = clamp(num('eg', base.gap), 0.3, 6);
  const m = raw.mat as Material | undefined;
  const material: Material =
    m === 'metal' || m === 'semiconductor' || m === 'insulator' ? m : base.material;
  return {
    material: material === 'metal' ? 'metal' : classify('gap', gap),
    gap,
    temperature: clamp(num('T', base.temperature), 0, T_MAX),
    log: raw.log !== undefined ? raw.log !== '0' : base.log,
  };
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  let params: DemoParams = parseParams(options.getParams(), defaultParams);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  const ctx = canvas.ctx;

  const sim = new BandSim();
  let sweeping = false;
  let sweepDir = 1;
  let plotRect: Rect = { x: 0, y: 0, w: 1, h: 1 };

  const kindOf = (): Kind => (params.material === 'metal' ? 'metal' : 'gap');

  function applyParams(reset: boolean): void {
    const kindChanged = sim.kind !== kindOf();
    sim.kind = kindOf();
    sim.gap = params.gap;
    sim.temperature = params.temperature;
    if (reset || kindChanged) sim.reset();
  }

  // ---- controls -----------------------------------------------------------------------
  const disposables: Disposable[] = [];
  let tSlider: SliderControl | undefined;
  let gapSlider: SliderControl | undefined;
  let matSelect: SelectControl | undefined;
  let logBox: CheckboxControl | undefined;
  let sweepButton: ButtonControl | undefined;

  function syncControls(): void {
    tSlider?.setValue(params.temperature);
    gapSlider?.setValue(params.gap);
    matSelect?.setValue(params.material);
    logBox?.setChecked(params.log);
    sweepButton?.setLabel(sweeping ? 'Stop temperature sweep' : 'Sweep temperature');
  }

  function currentUrlParams(): Record<string, string> {
    return {
      mat: params.material,
      eg: params.gap.toFixed(2),
      T: params.temperature.toFixed(0),
      log: params.log ? '1' : '0',
    };
  }

  function onChange(reset = false): void {
    applyParams(reset);
    options.setParams(currentUrlParams());
  }

  if (controlsPanel) {
    controlsPanel.appendChild(
      createHelperText(
        'At absolute zero a metal has a partly filled band, so electrons next to empty states can always move. In a semiconductor or an insulator the valence band is full and the conduction band is empty. Heat lifts electrons across the gap Eg, leaving holes behind, and the number of carriers rises as exp(−Eg/2kT). Drag the temperature slider (or click the plot) and watch the dot travel along n(T). The dots in the diagram are schematic: their number follows log₁₀ n.'
      )
    );

    const matSection = createSection({ title: 'Material' });
    disposables.push(matSection);
    matSelect = createSelect({
      label: 'Template',
      options: PRESETS.map((p) => ({ value: p.id, label: p.label })),
      value: params.material,
      onChange: (v) => {
        const preset = PRESETS.find((p) => p.id === v)!;
        params.material = preset.id;
        if (preset.id !== 'metal') params.gap = preset.gap;
        syncControls();
        onChange(true);
      },
    });
    disposables.push(matSelect);
    matSection.content.appendChild(matSelect.element);

    gapSlider = createSlider({
      label: 'Band gap Eg (not used by a metal)',
      min: 0.3,
      max: 6,
      step: 0.05,
      value: params.gap,
      format: (v) => `${v.toFixed(2)} eV`,
      onChange: (v) => {
        params.gap = v;
        params.material = classify('gap', v);
        matSelect?.setValue(params.material);
        onChange(true);
      },
    });
    disposables.push(gapSlider);
    matSection.content.appendChild(gapSlider.element);
    controlsPanel.appendChild(matSection.element);

    const condSection = createSection({ title: 'Temperature' });
    disposables.push(condSection);
    tSlider = createSlider({
      label: 'Temperature',
      min: 0,
      max: T_MAX,
      step: 5,
      value: params.temperature,
      format: (v) => `${v.toFixed(0)} K`,
      onChange: (v) => {
        params.temperature = v;
        onChange();
      },
    });
    disposables.push(tSlider);
    condSection.content.appendChild(tSlider.element);

    sweepButton = createButton({
      label: 'Sweep temperature',
      variant: 'secondary',
      onClick: () => {
        sweeping = !sweeping;
        syncControls();
      },
    });
    disposables.push(sweepButton);
    condSection.content.appendChild(sweepButton.element);

    logBox = createCheckbox({
      label: 'Logarithmic density axis',
      checked: params.log,
      onChange: (c) => {
        params.log = c;
        onChange();
      },
    });
    disposables.push(logBox);
    condSection.content.appendChild(logBox.element);
    controlsPanel.appendChild(condSection.element);
  }

  // ---- plot interaction ---------------------------------------------------------------
  function pointerToTemperature(ev: PointerEvent): void {
    const r = canvas.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    if (x < plotRect.x - 10 || x > plotRect.x + plotRect.w + 10) return;
    if (y < plotRect.y - 10 || y > plotRect.y + plotRect.h + 10) return;
    params.temperature =
      Math.round(clamp(((x - plotRect.x) / plotRect.w) * T_MAX, 0, T_MAX) / 5) * 5;
    sweeping = false;
    syncControls();
    onChange();
  }
  const onPointerDown = (ev: PointerEvent): void => {
    if (ev.buttons & 1) pointerToTemperature(ev);
  };
  const onPointerMove = (ev: PointerEvent): void => {
    if (ev.buttons & 1) pointerToTemperature(ev);
  };
  canvas.canvas.addEventListener('pointerdown', onPointerDown);
  canvas.canvas.addEventListener('pointermove', onPointerMove);

  // ---- drawing ------------------------------------------------------------------------
  function text(
    s: string,
    x: number,
    y: number,
    color: string,
    size = 12,
    align: CanvasTextAlign = 'left',
    weight = ''
  ): void {
    ctx.fillStyle = color;
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  const colorOf = (m: Material): string =>
    m === 'metal' ? COLOR_METAL : m === 'semiconductor' ? COLOR_SEMI : COLOR_INS;

  function drawPlot(r: Rect): void {
    plotRect = r;
    const kind = kindOf();
    const logMode = params.log;
    const T = params.temperature;

    // The curves: three references and the current material.
    const curveT: number[] = [];
    for (let i = 0; i <= 240; i++) curveT.push(Math.max(1, (i / 240) * T_MAX));
    const own = curveT.map((t) => log10Density(kind, params.gap, t));
    let yMaxLin = 1;
    if (!logMode) {
      for (const l of own) if (Number.isFinite(l)) yMaxLin = Math.max(yMaxLin, Math.pow(10, l));
      yMaxLin *= 1.1;
    }

    const yOf = (l: number): number => {
      if (logMode) return r.y + r.h - ((l - LOG_MIN) / (LOG_MAX - LOG_MIN)) * r.h;
      const v = Number.isFinite(l) ? Math.pow(10, l) : 0;
      return r.y + r.h - (v / yMaxLin) * r.h;
    };
    const xOf = (t: number): number => r.x + (t / T_MAX) * r.w;

    // Grid and ticks.
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#222';
    for (let t = 0; t <= T_MAX; t += 300) {
      ctx.beginPath();
      ctx.moveTo(xOf(t), r.y);
      ctx.lineTo(xOf(t), r.y + r.h);
      ctx.stroke();
      text(String(t), xOf(t), r.y + r.h + 12, '#999', 11, 'center');
    }
    if (logMode) {
      for (let k = LOG_MIN; k <= LOG_MAX; k += 4) {
        const y = yOf(k);
        ctx.beginPath();
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
        ctx.stroke();
        text(`10${sup(k)}`, r.x - 6, y, '#999', 11, 'right');
      }
    } else {
      for (let i = 0; i <= 4; i++) {
        const v = (yMaxLin / 1.1) * (i / 4);
        const y = r.y + r.h - (v / yMaxLin) * r.h;
        ctx.beginPath();
        ctx.moveTo(r.x, y);
        ctx.lineTo(r.x + r.w, y);
        ctx.stroke();
        text(i === 0 ? '0' : fmtSci(v), r.x - 6, y, '#999', 11, 'right');
      }
    }
    ctx.strokeStyle = '#666';
    ctx.strokeRect(r.x, r.y, r.w, r.h);

    // Room temperature marker.
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#555';
    ctx.beginPath();
    ctx.moveTo(xOf(300), r.y);
    ctx.lineTo(xOf(300), r.y + r.h);
    ctx.stroke();
    ctx.setLineDash([]);
    text('room T', xOf(300) + 4, r.y + 8, '#777', 10);

    // Curves, clipped to the plot area.
    ctx.save();
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    const trace = (kd: Kind, gap: number, color: string, width: number, alpha: number): void => {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      let started = false;
      for (const t of curveT) {
        const l = log10Density(kd, gap, t);
        if (!Number.isFinite(l)) continue;
        const x = xOf(t);
        const y = yOf(l);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    if (logMode) {
      for (const p of PRESETS) {
        trace(p.id === 'metal' ? 'metal' : 'gap', p.gap, colorOf(p.id), 1.5, 0.35);
      }
    }
    trace(kind, params.gap, colorOf(params.material), 3, 1);
    ctx.restore();

    if (logMode) {
      const refs: Array<[Material, string, Kind, number]> = [
        ['metal', 'metal', 'metal', 0],
        ['semiconductor', 'Si', 'gap', 1.12],
        ['insulator', 'diamond', 'gap', 5.5],
      ];
      for (const [id, name, kd, gap] of refs) {
        if (id === params.material) continue;
        const yy = yOf(log10Density(kd, gap, T_MAX));
        text(name, r.x + r.w - 6, yy - 9, colorOf(id), 11, 'right');
      }
    }

    // The dot for the current temperature.
    const l = log10Density(kind, params.gap, T);
    const offScale = logMode && !(l >= LOG_MIN);
    const dx = xOf(T);
    const dy = offScale ? r.y + r.h : yOf(l);
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx, r.y + r.h);
    ctx.lineTo(dx, dy);
    if (!offScale) ctx.lineTo(r.x, dy);
    ctx.stroke();
    ctx.setLineDash([]);
    const col = colorOf(params.material);
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(dx, dy, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(dx, dy, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Axis labels and title.
    text('Temperature T (K)', r.x + r.w / 2, r.y + r.h + 32, '#bbb', 12, 'center');
    ctx.save();
    ctx.translate(r.x - 48, r.y + r.h / 2);
    ctx.rotate(-Math.PI / 2);
    text('Carriers available for conduction, n (cm⁻³)', 0, 0, '#bbb', 12, 'center');
    ctx.restore();
    text('Carrier density n(T)', r.x, r.y - 18, '#eee', 14, 'left', '600');

    if (offScale) text('n < 1 cm⁻³ (below the axis)', dx + 12, dy - 14, '#ddd', 11);
    else {
      const label = `n = ${fmtSci(density(kind, params.gap, T))} cm⁻³`;
      const right = dx > r.x + r.w * 0.6;
      text(
        label,
        right ? dx - 14 : dx + 14,
        dy + (dy < r.y + 30 ? 18 : -16),
        '#fff',
        12,
        right ? 'right' : 'left',
        '600'
      );
    }
  }

  function drawBands(r: Rect, time: number): void {
    const kind = kindOf();
    const T = params.temperature;
    const mat = params.material;
    const reserve = 78; // readout at the bottom
    const top = r.y + 8;
    const availH = r.h - reserve - 8;
    const ppe = availH / (2 * BAND_EV + 6.2); // pixels per eV, same scale for every material
    const cy = top + availH / 2;

    text('Band diagram', r.x, r.y - 18, '#eee', 14, 'left', '600');

    const axisX = r.x + 10;
    const bx = r.x + 40;
    const bw = Math.max(80, Math.min(r.w - 40 - 128, 340));
    const textX = bx + bw + 14;

    // Energy axis.
    ctx.strokeStyle = '#999';
    ctx.fillStyle = '#999';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(axisX, top + availH);
    ctx.lineTo(axisX, top);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(axisX, top - 6);
    ctx.lineTo(axisX - 4, top + 3);
    ctx.lineTo(axisX + 4, top + 3);
    ctx.closePath();
    ctx.fill();
    ctx.save();
    ctx.translate(axisX - 0, top + availH + 0);
    ctx.restore();
    text('E', axisX + 10, top, '#999', 12);

    interface Band {
      yTop: number;
      yBot: number;
    }
    const slotXY = (band: Band, slot: number, wobble: boolean): [number, number] => {
      const row = Math.floor(slot / COLS);
      const col = slot % COLS;
      let x = bx + ((col + 0.5) / COLS) * bw;
      let y = band.yBot - ((row + 0.5) / ROWS) * (band.yBot - band.yTop);
      if (wobble) {
        const amp = 0.6 + (1.6 * T) / T_MAX;
        x += Math.sin(time * 4 + slot * 1.7) * amp;
        y += Math.cos(time * 3.3 + slot * 2.3) * amp;
      }
      return [x, y];
    };
    const slotR = (band: Band): number =>
      clamp(Math.min(bw / COLS, (band.yBot - band.yTop) / ROWS) * 0.3, 1.8, 4.6);

    const drawBox = (band: Band, color: string, label: string, labelY?: number): void => {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.1;
      ctx.fillRect(bx, band.yTop, bw, band.yBot - band.yTop);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx, band.yTop, bw, band.yBot - band.yTop);
      text(label, textX, labelY ?? (band.yTop + band.yBot) / 2 - 10, color, 12, 'left', '600');
    };
    const drawEmpty = (band: Band, rad: number, skip?: Uint8Array): void => {
      ctx.strokeStyle = '#3a4258';
      ctx.lineWidth = 1;
      for (let i = 0; i < NSLOT; i++) {
        if (skip && skip[i]) continue;
        const [x, y] = slotXY(band, i, false);
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    const dot = (x: number, y: number, rad: number, color: string): void => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    };

    let line1 = '';
    let line2 = '';
    let line3 = '';

    if (kind === 'metal') {
      const band: Band = { yTop: cy - (METAL_EV / 2) * ppe, yBot: cy + (METAL_EV / 2) * ppe };
      drawBox(band, COLOR_METAL, 'Partly filled band', band.yTop + 12);
      const rad = slotR(band);
      drawEmpty(band, rad, sim.occupied);
      let count = 0;
      for (let i = 0; i < NSLOT; i++) {
        if (!sim.occupied[i]) continue;
        count++;
        const [x, y] = slotXY(band, i, true);
        dot(x, y, rad, COLOR_E);
      }
      // Fermi level.
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx - 6, cy);
      ctx.lineTo(bx + bw + 6, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      text('E_F', textX, cy, '#ddd', 12);
      text('electrons next to empty', textX, cy + 22, '#aaa', 11);
      text('states: free to move', textX, cy + 36, '#aaa', 11);
      text(`${count} electrons drawn`, textX, band.yBot - 10, COLOR_E, 11);
      line1 = 'Metal: the band is only partly filled';
      line2 = `n ≈ ${fmtSci(density('metal', 0, T))} cm⁻³, nearly independent of T`;
      line3 = 'Electron smearing around E_F is exaggerated.';
    } else {
      const gapPx = params.gap * ppe;
      const vb: Band = { yTop: cy + gapPx / 2, yBot: cy + gapPx / 2 + BAND_EV * ppe };
      const cb: Band = { yTop: cy - gapPx / 2 - BAND_EV * ppe, yBot: cy - gapPx / 2 };
      drawBox(cb, COLOR_E, 'Conduction band');
      drawBox(vb, COLOR_VAL, 'Valence band');
      const rad = slotR(vb);

      // Valence band: every slot filled except the holes.
      drawEmpty(cb, rad, sim.cbUsed);
      for (let i = 0; i < NSLOT; i++) {
        if (sim.vbHole[i]) continue;
        const [x, y] = slotXY(vb, i, true);
        dot(x, y, rad, COLOR_VAL);
      }
      for (const p of sim.pairs) {
        // Hole.
        const [hx, hy] = slotXY(vb, p.vb, true);
        ctx.strokeStyle = COLOR_H;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(hx, hy, rad + 0.5, 0, Math.PI * 2);
        ctx.stroke();
        // Electron, possibly in flight.
        const [cx, cyy] = slotXY(cb, p.cb, true);
        let ex = cx;
        let ey = cyy;
        if (p.phase !== 1) {
          const f = clamp(p.t / JUMP_TIME, 0, 1);
          const s = f * f * (3 - 2 * f);
          const w = p.phase === 0 ? s : 1 - s;
          ex = hx + (cx - hx) * w;
          ey = hy + (cyy - hy) * w;
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([2, 3]);
          ctx.beginPath();
          ctx.moveTo(hx, hy);
          ctx.lineTo(cx, cyy);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        dot(ex, ey, rad + 0.5, COLOR_E);
      }

      // Fermi level (mid-gap for an intrinsic material) and the gap arrow.
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx - 6, cy);
      ctx.lineTo(bx + bw + 6, cy);
      ctx.stroke();
      ctx.setLineDash([]);
      text('E_F (mid-gap)', textX, cy + 12, '#999', 11);
      const ax = bx + bw * 0.5;
      ctx.strokeStyle = '#eee';
      ctx.fillStyle = '#eee';
      ctx.lineWidth = 1.3;
      if (gapPx > 14) {
        const y1 = cy - gapPx / 2 + 1;
        const y2 = cy + gapPx / 2 - 1;
        ctx.beginPath();
        ctx.moveTo(ax, y1 + 5);
        ctx.lineTo(ax, y2 - 5);
        ctx.stroke();
        for (const [yy, dir] of [
          [y1, 1],
          [y2, -1],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(ax, yy);
          ctx.lineTo(ax - 4, yy + 7 * dir);
          ctx.lineTo(ax + 4, yy + 7 * dir);
          ctx.closePath();
          ctx.fill();
        }
      }
      text(`E_g = ${params.gap.toFixed(2)} eV`, textX, cy - 12, '#eee', 12, 'left', '600');

      const nE = sim.electrons;
      text(`${nE} electron${nE === 1 ? '' : 's'}`, textX, cb.yBot - 10, COLOR_E, 11);
      text(`${nE} hole${nE === 1 ? '' : 's'}`, textX, vb.yTop + 12, COLOR_H, 11);

      const kT = KB_EV * T;
      line1 = `${mat === 'insulator' ? 'Insulator' : 'Semiconductor'}: full valence band, E_g = ${params.gap.toFixed(2)} eV`;
      const n = density('gap', params.gap, T);
      line2 = `kT = ${kT.toFixed(3)} eV,  E_g/2kT = ${T > 0 ? (params.gap / (2 * kT)).toFixed(1) : '∞'},  n = p = ${n > 0 ? fmtSci(n) : '0'} cm⁻³`;
      line3 = 'Number of dots is schematic (∝ log₁₀ n).';
    }

    const ry = r.y + r.h - reserve + 18;
    text(line1, r.x, ry, colorOf(mat), 12, 'left', '600');
    text(line2, r.x, ry + 20, '#ddd', 12);
    text(line3, r.x, ry + 38, '#888', 11);
  }

  let lastTime = 0;
  const loop = new AnimationLoop((_dt, time) => {
    const dt = Math.min(0.05, Math.max(0, time - lastTime));
    lastTime = time;
    if (sweeping) {
      params.temperature += sweepDir * SWEEP_RATE * dt;
      if (params.temperature >= T_MAX) {
        params.temperature = T_MAX;
        sweepDir = -1;
      } else if (params.temperature <= 0) {
        params.temperature = 0;
        sweepDir = 1;
      }
      tSlider?.setValue(params.temperature);
      sim.temperature = params.temperature;
    }
    sim.step(dt);
    render(time);
  });

  function render(time: number): void {
    const W = canvas.width;
    const H = canvas.height;
    canvas.clear();
    const stacked = W < 640 || W < H * 0.85;
    let plot: Rect;
    let bands: Rect;
    if (stacked) {
      plot = { x: 70, y: 34, w: W - 90, h: H * 0.38 - 70 };
      bands = { x: 20, y: H * 0.42 + 24, w: W - 40, h: H * 0.58 - 36 };
    } else {
      const split = Math.floor(W * 0.5);
      plot = { x: 76, y: 44, w: split - 76 - 28, h: H - 44 - 66 };
      bands = { x: split + 24, y: 44, w: W - split - 44, h: H - 44 - 16 };
    }
    drawPlot(plot);
    drawBands(bands, time);
  }

  applyParams(true);
  syncControls();

  function handleResize(): void {
    render(loop.elapsed / 1000);
  }
  canvas.onResize(handleResize);

  return {
    start() {
      lastTime = loop.elapsed / 1000;
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
      canvas.canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.canvas.removeEventListener('pointermove', onPointerMove);
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },
    getParams() {
      return currentUrlParams();
    },
    setParams(newParams: Record<string, string>) {
      params = parseParams(newParams, params);
      syncControls();
      applyParams(true);
    },
  };
}

export const bandDiagramsDemo: DemoDefinition = {
  id: 'band-diagrams',
  title: 'Band diagrams and carrier density n(T)',
  description:
    'Compare a metal, a semiconductor and an insulator through simplified band diagrams. Change temperature and band gap and watch electrons and holes appear in the bands while a dot follows the carrier density n(T) on the plot.',
  category: 'Electrical properties',
  tags: [
    'band diagram',
    'band gap',
    'semiconductor',
    'insulator',
    'metal',
    'carrier density',
    'holes',
    'Fermi level',
  ],
  create,
};

export default bandDiagramsDemo;
