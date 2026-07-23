// pdfjs worker entry (used via `?worker&url` → GlobalWorkerOptions.workerSrc).
// LEGACY build on purpose: the modern worker uses bleeding-edge JS APIs
// (Math.sumPrecise, Map.prototype.getOrInsertComputed, …) missing from
// Electron's Chromium. Each embedded font translation then throws, pdfjs
// swallows the error per font and paints raw subset charcodes — garbled text.
// The legacy build bundles its own shims, so no polyfill wrapper is needed.
import "pdfjs-dist/legacy/build/pdf.worker.mjs";
