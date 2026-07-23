import "@testing-library/jest-dom";

function createMemoryStorage(): Storage {
  let store: Record<string, string> = {};

  return {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      store = {};
    },
    getItem: (key: string) => store[key] ?? null,
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
  };
}

const localStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

if (!localStorageDescriptor || "get" in localStorageDescriptor || localStorageDescriptor.value === undefined) {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });
}

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// ChatView uses the element-level scrolling API to follow the active turn.
// jsdom exposes scroll containers but does not implement scrollTo.
if (!HTMLElement.prototype.scrollTo) {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: () => {},
  });
}

// pdf.js (imported by artifact renderers) requires DOMMatrix, which jsdom
// does not provide. Without this stub three suites die at COLLECTION time
// (ArtifactPanel, artifact-renderers, App.restore) — their assertions
// silently stopped running. A bare class is enough: tests never render
// actual PDF pages, they only need the module graph to load.
if (!globalThis.DOMMatrix) {
  Object.defineProperty(globalThis, "DOMMatrix", {
    configurable: true,
    value: class DOMMatrix {},
  });
}

// Recharts uses ResizeObserver through ResponsiveContainer. jsdom has no
// layout engine, so a no-op observer is sufficient for deterministic tests.
if (!globalThis.ResizeObserver) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}
