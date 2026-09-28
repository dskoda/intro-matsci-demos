/**
 * Toast Notifications
 *
 * Simple toast notification system for showing info, success, warning, and error messages.
 */

export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  /** Duration in milliseconds (default: 3000, 0 = permanent) */
  duration?: number;
  /** Toast type (default: 'info') */
  type?: ToastType;
}

interface ToastItem {
  element: HTMLElement;
  timeoutId: number | null;
}

const activeToasts: ToastItem[] = [];
const MAX_TOASTS = 5;

/**
 * Show a toast notification.
 */
export function showToast(message: string, typeOrOptions?: ToastType | ToastOptions): void {
  const options: ToastOptions =
    typeof typeOrOptions === 'string' ? { type: typeOrOptions } : typeOrOptions ?? {};

  const type = options.type ?? 'info';
  const duration = options.duration ?? 3000;

  // Get or create container
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  // Remove oldest toast if at max
  if (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts.shift();
    if (oldest) {
      removeToast(oldest);
    }
  }

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-message">${escapeHtml(message)}</span>`;

  // Click to dismiss
  toast.addEventListener('click', () => {
    const item = activeToasts.find((t) => t.element === toast);
    if (item) {
      removeToast(item);
      const index = activeToasts.indexOf(item);
      if (index !== -1) {
        activeToasts.splice(index, 1);
      }
    }
  });

  // Add to DOM
  container.appendChild(toast);

  // Set up auto-remove
  let timeoutId: number | null = null;
  if (duration > 0) {
    timeoutId = window.setTimeout(() => {
      const item = activeToasts.find((t) => t.element === toast);
      if (item) {
        removeToast(item);
        const index = activeToasts.indexOf(item);
        if (index !== -1) {
          activeToasts.splice(index, 1);
        }
      }
    }, duration);
  }

  activeToasts.push({ element: toast, timeoutId });
}

/**
 * Remove a toast with animation.
 */
function removeToast(toast: ToastItem): void {
  if (toast.timeoutId !== null) {
    clearTimeout(toast.timeoutId);
  }

  toast.element.classList.add('toast-out');

  setTimeout(() => {
    if (toast.element.parentElement) {
      toast.element.parentElement.removeChild(toast.element);
    }
  }, 300);
}

/**
 * Clear all toasts.
 */
export function clearAllToasts(): void {
  activeToasts.forEach((toast) => {
    if (toast.timeoutId !== null) {
      clearTimeout(toast.timeoutId);
    }
    if (toast.element.parentElement) {
      toast.element.parentElement.removeChild(toast.element);
    }
  });
  activeToasts.length = 0;
}

/**
 * Escape HTML to prevent XSS.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
