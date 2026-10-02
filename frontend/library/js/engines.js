// The PDF and EPUB engines are big, so they are only loaded on pages that need them.
const loaded = new Map();

export function loadScript(src) {
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(s);
    }));
  }
  return loaded.get(src);
}

export async function pdfjs() {
  await loadScript('vendor/pdfjs/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
  return window.pdfjsLib;
}

export async function epubjs() {
  await loadScript('vendor/epub/jszip.min.js');
  await loadScript('vendor/epub/epub.min.js');
  return window.ePub;
}

export const PDF_OPTIONS = { cMapUrl: 'vendor/pdfjs/cmaps/', cMapPacked: true };
