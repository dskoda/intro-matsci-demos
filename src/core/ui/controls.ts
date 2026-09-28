/**
 * UI Controls
 *
 * Reusable control builders for sliders, checkboxes, selects, and buttons.
 * All controls return a dispose function for cleanup.
 */

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  /** Format function for display value */
  format?: (value: number) => string;
  /** Callback on value change */
  onChange: (value: number) => void;
}

export interface SliderControl {
  element: HTMLElement;
  getValue: () => number;
  setValue: (value: number) => void;
  dispose: () => void;
}

/**
 * Create a slider control with label and value display.
 */
export function createSlider(options: SliderOptions): SliderControl {
  const { label, min, max, value, step = 0.01, format, onChange } = options;

  const container = document.createElement('div');
  container.className = 'control-item';

  const labelRow = document.createElement('div');
  labelRow.className = 'control-label';

  const labelText = document.createElement('span');
  labelText.textContent = label;

  const valueText = document.createElement('span');
  valueText.className = 'control-value';
  valueText.textContent = format ? format(value) : String(value);

  labelRow.appendChild(labelText);
  labelRow.appendChild(valueText);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'control-slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const handleInput = () => {
    const newValue = parseFloat(slider.value);
    valueText.textContent = format ? format(newValue) : String(newValue);
    onChange(newValue);
  };

  slider.addEventListener('input', handleInput);

  container.appendChild(labelRow);
  container.appendChild(slider);

  return {
    element: container,
    getValue: () => parseFloat(slider.value),
    setValue: (v: number) => {
      slider.value = String(v);
      valueText.textContent = format ? format(v) : String(v);
    },
    dispose: () => {
      slider.removeEventListener('input', handleInput);
    },
  };
}

export interface CheckboxOptions {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface CheckboxControl {
  element: HTMLElement;
  getChecked: () => boolean;
  setChecked: (checked: boolean) => void;
  dispose: () => void;
}

/**
 * Create a checkbox control.
 */
export function createCheckbox(options: CheckboxOptions): CheckboxControl {
  const { label, checked, onChange } = options;

  const container = document.createElement('div');
  container.className = 'control-item';

  const wrapper = document.createElement('label');
  wrapper.className = 'control-checkbox-wrapper';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'control-checkbox';
  checkbox.checked = checked;

  const labelText = document.createElement('span');
  labelText.className = 'control-checkbox-label';
  labelText.textContent = label;

  const handleChange = () => {
    onChange(checkbox.checked);
  };

  checkbox.addEventListener('change', handleChange);

  wrapper.appendChild(checkbox);
  wrapper.appendChild(labelText);
  container.appendChild(wrapper);

  return {
    element: container,
    getChecked: () => checkbox.checked,
    setChecked: (c: boolean) => {
      checkbox.checked = c;
    },
    dispose: () => {
      checkbox.removeEventListener('change', handleChange);
    },
  };
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectOptions {
  label: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}

export interface SelectControl {
  element: HTMLElement;
  getValue: () => string;
  setValue: (value: string) => void;
  dispose: () => void;
}

/**
 * Create a select dropdown control.
 */
export function createSelect(options: SelectOptions): SelectControl {
  const { label, options: selectOptions, value, onChange } = options;

  const container = document.createElement('div');
  container.className = 'control-item';

  const labelEl = document.createElement('div');
  labelEl.className = 'control-label';
  labelEl.innerHTML = `<span>${label}</span>`;

  const select = document.createElement('select');
  select.className = 'control-select';

  selectOptions.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === value) {
      option.selected = true;
    }
    select.appendChild(option);
  });

  const handleChange = () => {
    onChange(select.value);
  };

  select.addEventListener('change', handleChange);

  container.appendChild(labelEl);
  container.appendChild(select);

  return {
    element: container,
    getValue: () => select.value,
    setValue: (v: string) => {
      select.value = v;
    },
    dispose: () => {
      select.removeEventListener('change', handleChange);
    },
  };
}

export interface ButtonOptions {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'secondary';
}

export interface ButtonControl {
  element: HTMLElement;
  setLabel: (label: string) => void;
  setDisabled: (disabled: boolean) => void;
  dispose: () => void;
}

/**
 * Create a button control.
 */
export function createButton(options: ButtonOptions): ButtonControl {
  const { label, onClick, variant = 'primary' } = options;

  const container = document.createElement('div');
  container.className = 'control-item';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = `control-button ${variant === 'secondary' ? 'secondary' : ''}`;
  button.textContent = label;

  button.addEventListener('click', onClick);

  container.appendChild(button);

  return {
    element: container,
    setLabel: (l: string) => {
      button.textContent = l;
    },
    setDisabled: (disabled: boolean) => {
      button.disabled = disabled;
    },
    dispose: () => {
      button.removeEventListener('click', onClick);
    },
  };
}

/** Disposable control interface */
export interface Disposable {
  dispose: () => void;
}

/**
 * Dispose multiple controls at once.
 */
export function disposeControls(controls: Disposable[]): void {
  controls.forEach((c) => c.dispose());
}
