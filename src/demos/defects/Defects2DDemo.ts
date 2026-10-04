/**
 * Crystal Defects in 2D (square lattice)
 *
 * Shows a vacancy, a self-interstitial and an edge dislocation in a 2D square
 * lattice. Atoms around the defect are coloured by how strongly their bonding
 * is disturbed, and the opacity of each group can be changed to see the
 * underlying structure.
 *
 * Lengths are in units of the lattice constant a.
 */

import type { DemoDefinition, DemoInstance, DemoCreateOptions } from '@app/types';
import { HiDPICanvas } from '@core/canvas/HiDPICanvas';
import {
  createSlider,
  createSelect,
  createCheckbox,
  type Disposable,
  type SliderControl,
  type SelectControl,
  type CheckboxControl,
} from '@core/ui/controls';
import { createSection, createHelperText } from '@core/ui/panel';
import { clamp } from '@core/math/validation';
import {
  buildDefect,
  burgersCircuit,
  defectTypes,
  DEFECT_INFO,
  ROLE_COLORS,
  ROLE_LABELS,
  type DefectStructure,
  type DefectType,
  type Role,
} from './defects';

interface DemoParams {
  defect: DefectType;
  size: number;
  shell: number;
  bulkOpacity: number;
  shellOpacity: number;
  coreOpacity: number;
  bonds: boolean;
  circuit: boolean;
}

const defaultParams: DemoParams = {
  defect: 'vacancy',
  size: 12,
  shell: 2.5,
  bulkOpacity: 1,
  shellOpacity: 1,
  coreOpacity: 1,
  bonds: true,
  circuit: false,
};

const TYPES_2D = defectTypes(2);
const FONT = '13px -apple-system, BlinkMacSystemFont, sans-serif';

function parseParams(src: Record<string, string>, params: DemoParams): void {
  const num = (v: string, lo: number, hi: number, fallback: number) => {
    const x = parseFloat(v);
    return clamp(Number.isFinite(x) ? x : fallback, lo, hi);
  };
  if (src.defect && TYPES_2D.includes(src.defect as DefectType)) {
    params.defect = src.defect as DefectType;
  }
  if (src.size) params.size = Math.round(num(src.size, 6, 24, 12));
  if (src.shell) params.shell = num(src.shell, 1, 5, 2.5);
  if (src.bulkOpacity) params.bulkOpacity = num(src.bulkOpacity, 0, 1, 1);
  if (src.shellOpacity) params.shellOpacity = num(src.shellOpacity, 0, 1, 1);
  if (src.coreOpacity) params.coreOpacity = num(src.coreOpacity, 0, 1, 1);
  if (src.bonds !== undefined) params.bonds = src.bonds === 'true';
  if (src.circuit !== undefined) params.circuit = src.circuit === 'true';
}

function create(container: HTMLElement, options: DemoCreateOptions): DemoInstance {
  const controlsPanel = (container as HTMLElement & { controlsPanel?: HTMLElement }).controlsPanel;

  const params: DemoParams = { ...defaultParams };
  parseParams(options.getParams(), params);

  const canvas = new HiDPICanvas(container, { backgroundColor: '#0a0a0a', autoResize: true });
  let structure: DefectStructure;

  function rebuild(): void {
    structure = buildDefect(params.defect, {
      dim: 2,
      size: params.size,
      shellRadius: params.shell,
      tilt: 0,
    });
    render();
  }

  // --- controls ---------------------------------------------------------
  const disposables: Disposable[] = [];
  let defectSelect: SelectControl | null = null;
  let sizeSlider: SliderControl | null = null;
  let shellSlider: SliderControl | null = null;
  let bulkSlider: SliderControl | null = null;
  let shellOpSlider: SliderControl | null = null;
  let coreOpSlider: SliderControl | null = null;
  let bondsCheckbox: CheckboxControl | null = null;
  let circuitCheckbox: CheckboxControl | null = null;
  let description: HTMLElement | null = null;

  function syncControls(): void {
    defectSelect?.setValue(params.defect);
    sizeSlider?.setValue(params.size);
    shellSlider?.setValue(params.shell);
    bulkSlider?.setValue(params.bulkOpacity);
    shellOpSlider?.setValue(params.shellOpacity);
    coreOpSlider?.setValue(params.coreOpacity);
    bondsCheckbox?.setChecked(params.bonds);
    circuitCheckbox?.setChecked(params.circuit);
    if (circuitCheckbox) {
      circuitCheckbox.element.style.display = params.defect === 'edge' ? '' : 'none';
    }
    if (description) description.textContent = DEFECT_INFO[params.defect].description;
  }

  function onChange(rebuildNeeded: boolean): void {
    syncControls();
    if (rebuildNeeded) rebuild();
    else render();
    options.setParams(getParamRecord());
  }

  if (controlsPanel) {
    const defectSection = createSection({ title: 'Defect' });
    disposables.push(defectSection);

    defectSelect = createSelect({
      label: 'Defect type',
      options: TYPES_2D.map((t) => ({ value: t, label: DEFECT_INFO[t].label })),
      value: params.defect,
      onChange: (v) => {
        params.defect = v as DefectType;
        onChange(true);
      },
    });
    disposables.push(defectSelect);
    defectSection.content.appendChild(defectSelect.element);

    description = createHelperText(DEFECT_INFO[params.defect].description);
    defectSection.content.appendChild(description);

    sizeSlider = createSlider({
      label: 'Crystal size',
      min: 6,
      max: 24,
      step: 1,
      value: params.size,
      format: (v) => `${v.toFixed(0)} × ${v.toFixed(0)} atoms`,
      onChange: (v) => {
        params.size = Math.round(v);
        onChange(true);
      },
    });
    disposables.push(sizeSlider);
    defectSection.content.appendChild(sizeSlider.element);

    circuitCheckbox = createCheckbox({
      label: 'Burgers circuit',
      checked: params.circuit,
      onChange: (checked) => {
        params.circuit = checked;
        onChange(false);
      },
    });
    disposables.push(circuitCheckbox);
    defectSection.content.appendChild(circuitCheckbox.element);
    controlsPanel.appendChild(defectSection.element);

    const highlightSection = createSection({ title: 'Highlight & Opacity' });
    disposables.push(highlightSection);

    shellSlider = createSlider({
      label: 'Highlight radius',
      min: 1,
      max: 5,
      step: 0.5,
      value: params.shell,
      format: (v) => `${v.toFixed(1)} a`,
      onChange: (v) => {
        params.shell = v;
        onChange(true);
      },
    });
    disposables.push(shellSlider);
    highlightSection.content.appendChild(shellSlider.element);

    const opacitySlider = (
      label: string,
      get: () => number,
      set: (v: number) => void
    ): SliderControl => {
      const s = createSlider({
        label,
        min: 0,
        max: 1,
        step: 0.05,
        value: get(),
        format: (v) => `${(v * 100).toFixed(0)}%`,
        onChange: (v) => {
          set(v);
          onChange(false);
        },
      });
      disposables.push(s);
      highlightSection.content.appendChild(s.element);
      return s;
    };
    bulkSlider = opacitySlider(
      'Bulk atoms opacity',
      () => params.bulkOpacity,
      (v) => (params.bulkOpacity = v)
    );
    shellOpSlider = opacitySlider(
      'Nearby atoms opacity',
      () => params.shellOpacity,
      (v) => (params.shellOpacity = v)
    );
    coreOpSlider = opacitySlider(
      'Core atoms opacity',
      () => params.coreOpacity,
      (v) => (params.coreOpacity = v)
    );

    bondsCheckbox = createCheckbox({
      label: 'Show bonds',
      checked: params.bonds,
      onChange: (checked) => {
        params.bonds = checked;
        onChange(false);
      },
    });
    disposables.push(bondsCheckbox);
    highlightSection.content.appendChild(bondsCheckbox.element);
    controlsPanel.appendChild(highlightSection.element);
  }

  function getParamRecord(): Record<string, string> {
    return {
      defect: params.defect,
      size: String(params.size),
      shell: params.shell.toFixed(1),
      bulkOpacity: params.bulkOpacity.toFixed(2),
      shellOpacity: params.shellOpacity.toFixed(2),
      coreOpacity: params.coreOpacity.toFixed(2),
      bonds: String(params.bonds),
      circuit: String(params.circuit),
    };
  }

  // --- rendering ----------------------------------------------------------
  function roleOpacity(role: Role): number {
    if (role === 'bulk') return params.bulkOpacity;
    if (role === 'shell') return params.shellOpacity;
    return params.coreOpacity; // core and the extra atom
  }

  function render(): void {
    const ctx = canvas.ctx;
    const width = canvas.width;
    const height = canvas.height;
    canvas.clear();
    if (width === 0 || height === 0) return;

    const extent = structure.n + 1; // crystal width plus a margin, in units of a
    const side = Math.max(100, Math.min(width - 20, height - 70));
    const scale = side / extent;
    const cx = width / 2;
    const cy = (height - 40) / 2 + 10;
    const sx = (x: number) => cx + x * scale;
    const sy = (y: number) => cy - y * scale;
    const radius = scale * 0.33;
    const { atoms } = structure;

    ctx.save();

    if (params.bonds) {
      ctx.lineWidth = Math.max(1, scale * 0.05);
      for (const [i, j] of structure.bonds) {
        const a = atoms[i]!;
        const b = atoms[j]!;
        ctx.globalAlpha = Math.min(roleOpacity(a.role), roleOpacity(b.role)) * 0.8;
        ctx.strokeStyle = '#8a94a3';
        ctx.beginPath();
        ctx.moveTo(sx(a.pos[0]), sy(a.pos[1]));
        ctx.lineTo(sx(b.pos[0]), sy(b.pos[1]));
        ctx.stroke();
      }
    }

    for (const g of structure.ghosts) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#ddd';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(sx(g[0]), sy(g[1]), radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const a of atoms) {
      ctx.globalAlpha = roleOpacity(a.role);
      ctx.fillStyle = ROLE_COLORS[a.role];
      ctx.beginPath();
      ctx.arc(sx(a.pos[0]), sy(a.pos[1]), radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    if (params.defect === 'edge' && params.circuit) drawCircuit(sx, sy, scale);
    ctx.restore();

    drawLegend();
    drawCaption(width, height);
  }

  function drawCircuit(sx: (x: number) => number, sy: (y: number) => number, scale: number): void {
    const ctx = canvas.ctx;
    const k = Math.max(1, Math.min(3, Math.floor(structure.n / 2) - 2));
    const circuit = burgersCircuit(structure, k);
    if (!circuit) return;
    ctx.strokeStyle = '#ffd84a';
    ctx.lineWidth = Math.max(2, scale * 0.09);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    circuit.path.forEach((p, i) => {
      if (i === 0) ctx.moveTo(sx(p[0]), sy(p[1]));
      else ctx.lineTo(sx(p[0]), sy(p[1]));
    });
    ctx.stroke();

    // Closure failure = Burgers vector, from the end back to the start
    const x0 = sx(circuit.end[0]);
    const y0 = sy(circuit.end[1]);
    const x1 = sx(circuit.start[0]);
    const y1 = sy(circuit.start[1]);
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const head = Math.max(8, scale * 0.3);
    ctx.strokeStyle = '#ff5ad1';
    ctx.fillStyle = '#ff5ad1';
    ctx.lineWidth = Math.max(3, scale * 0.12);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(ang - 0.4), y1 - head * Math.sin(ang - 0.4));
    ctx.lineTo(x1 - head * Math.cos(ang + 0.4), y1 - head * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('b', (x0 + x1) / 2, Math.max(y0, y1) + 6);
  }

  function drawLegend(): void {
    const ctx = canvas.ctx;
    ctx.save();
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const roles: Role[] = ['bulk', 'shell', 'core'];
    if (params.defect === 'interstitial' || params.defect === 'edge') roles.push('extra');
    ctx.fillStyle = '#ddd';
    ctx.fillText(DEFECT_INFO[params.defect].label, 10, 16);
    roles.forEach((role, i) => {
      const y = 38 + i * 18;
      ctx.fillStyle = ROLE_COLORS[role];
      ctx.beginPath();
      ctx.arc(16, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#bbb';
      ctx.fillText(
        role === 'extra' && params.defect === 'edge' ? 'Extra half-plane' : ROLE_LABELS[role],
        28,
        y
      );
    });
    if (params.defect === 'vacancy') {
      const y = 38 + roles.length * 18;
      ctx.strokeStyle = '#ddd';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(16, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#bbb';
      ctx.fillText('Empty lattice site', 28, y);
    }
    ctx.restore();
  }

  function drawCaption(width: number, height: number): void {
    const ctx = canvas.ctx;
    const counts: Record<Role, number> = { bulk: 0, shell: 0, core: 0, extra: 0 };
    for (const a of structure.atoms) counts[a.role]++;
    ctx.save();
    ctx.font = FONT;
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(
      `${structure.atoms.length} atoms · ${counts.core + counts.extra} core · ${counts.shell} nearby`,
      width / 2,
      height - 8
    );
    ctx.restore();
  }

  function handleResize(): void {
    render();
  }
  canvas.onResize(handleResize);

  rebuild();
  syncControls();

  return {
    start() {
      render();
    },
    stop() {},
    resize() {
      handleResize();
    },
    dispose() {
      disposables.forEach((d) => d.dispose());
      canvas.dispose();
    },
    getParams() {
      return getParamRecord();
    },
    setParams(newParams: Record<string, string>) {
      parseParams(newParams, params);
      rebuild();
      syncControls();
    },
  };
}

export const defects2DDemo: DemoDefinition = {
  id: 'defects-2d',
  title: 'Crystal Defects in 2D',
  description:
    'Vacancy, self-interstitial and edge dislocation in a 2D square lattice. Atoms around each defect are coloured, and their opacity can be adjusted.',
  category: 'Crystallography',
  tags: ['defects', 'vacancy', 'interstitial', 'dislocation', 'crystal'],
  create,
};

export default defects2DDemo;
