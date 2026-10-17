// React Flow measures through ResizeObserver and reads the viewport transform
// through DOMMatrixReadOnly — jsdom has neither, and the canvas would
// throw on mount. Stubs are enough: nodes get their size up front. Same
// approach as Graph Studio's tests/setup-plugin-runtime.ts.
if (typeof window !== "undefined") {
  const scope = globalThis as Record<string, unknown>;
  if (!scope.ResizeObserver) {
    scope.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!scope.DOMMatrixReadOnly) {
    scope.DOMMatrixReadOnly = class {
      m22: number;
      constructor(transform?: string) {
        const scale = transform?.match(/scale\(([^)]+)\)/)?.[1];
        this.m22 = scale ? Number(scale) : 1;
      }
    };
  }
}
