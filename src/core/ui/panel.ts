/**
 * Panel Components
 *
 * Collapsible sections and panel helpers for the controls panel.
 */

export interface SectionOptions {
  title: string;
  collapsed?: boolean;
}

export interface Section {
  element: HTMLElement;
  content: HTMLElement;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
  dispose: () => void;
}

/**
 * Create a collapsible section.
 */
export function createSection(options: SectionOptions): Section {
  const { title, collapsed = false } = options;

  const section = document.createElement('div');
  section.className = `panel-section${collapsed ? ' collapsed' : ''}`;

  const header = document.createElement('div');
  header.className = 'panel-section-header';

  const titleEl = document.createElement('h3');
  titleEl.textContent = title;

  const toggle = document.createElement('span');
  toggle.className = 'panel-section-toggle';
  toggle.textContent = '▼';

  header.appendChild(titleEl);
  header.appendChild(toggle);

  const content = document.createElement('div');
  content.className = 'panel-section-content';

  const handleClick = () => {
    section.classList.toggle('collapsed');
  };

  header.addEventListener('click', handleClick);

  section.appendChild(header);
  section.appendChild(content);

  return {
    element: section,
    content,
    setCollapsed: (c: boolean) => {
      if (c) {
        section.classList.add('collapsed');
      } else {
        section.classList.remove('collapsed');
      }
    },
    toggle: () => {
      section.classList.toggle('collapsed');
    },
    dispose: () => {
      header.removeEventListener('click', handleClick);
    },
  };
}

/**
 * Create a simple panel divider.
 */
export function createDivider(): HTMLElement {
  const divider = document.createElement('hr');
  divider.style.border = 'none';
  divider.style.borderTop = '1px solid var(--color-border)';
  divider.style.margin = 'var(--spacing-md) 0';
  return divider;
}

/**
 * Create a panel title/header text.
 */
export function createPanelTitle(text: string): HTMLElement {
  const title = document.createElement('h3');
  title.style.fontSize = 'var(--font-size-md)';
  title.style.fontWeight = '600';
  title.style.marginBottom = 'var(--spacing-sm)';
  title.style.color = 'var(--color-text)';
  title.textContent = text;
  return title;
}

/**
 * Create a helper text paragraph.
 */
export function createHelperText(text: string): HTMLElement {
  const p = document.createElement('p');
  p.style.fontSize = 'var(--font-size-sm)';
  p.style.color = 'var(--color-text-muted)';
  p.style.marginBottom = 'var(--spacing-md)';
  p.textContent = text;
  return p;
}

/**
 * Create a panel that manages multiple sections.
 */
export interface Panel {
  container: HTMLElement;
  addSection: (options: SectionOptions) => Section;
  clear: () => void;
  dispose: () => void;
}

export function createPanel(container: HTMLElement): Panel {
  const sections: Section[] = [];

  return {
    container,
    addSection: (options: SectionOptions) => {
      const section = createSection(options);
      sections.push(section);
      container.appendChild(section.element);
      return section;
    },
    clear: () => {
      sections.forEach((s) => s.dispose());
      sections.length = 0;
      container.innerHTML = '';
    },
    dispose: () => {
      sections.forEach((s) => s.dispose());
      sections.length = 0;
    },
  };
}
