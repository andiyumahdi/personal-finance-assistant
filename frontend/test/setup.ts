// V2 Phase 9 test setup: jsdom polyfills for browser APIs the production
// components assume (Radix UI + sonner), plus automatic RTL cleanup.
// Nothing here asserts behavior - it only makes the DOM environment honest.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

if (typeof window !== 'undefined') {
  if (!window.matchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(), // deprecated, still called by Radix
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  }

  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', {
      writable: true,
      value: ResizeObserverStub,
    });
  }

  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }

  // jsdom has no Pointer Events capture API (sonner's swipe handlers call
  // setPointerCapture on pointerdown).
  if (!window.HTMLElement.prototype.setPointerCapture) {
    window.HTMLElement.prototype.setPointerCapture = () => {};
    window.HTMLElement.prototype.releasePointerCapture = () => {};
    window.HTMLElement.prototype.hasPointerCapture = () => false;
  }
}

afterEach(() => {
  cleanup();
});
