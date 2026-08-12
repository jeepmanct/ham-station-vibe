/**
 * Saves any Blob (image, ADIF/CSV export, etc.), working around iOS Safari's
 * refusal to honor the `download` attribute on data:/blob: URLs (the classic
 * `<a download>` click does nothing there — no error, no dialog, just
 * silence). Prefers the native share sheet (works on iOS/Android, gives a
 * direct "Save" option for any file type, not just images), falls back to
 * opening it in a new tab so it can still be saved via long-press/right-click
 * when Web Share isn't available.
 */
export async function downloadOrShareBlob(blob: Blob, filename: string): Promise<void> {
  if (navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        return;
      }
    } catch (err) {
      // The user dismissing the share sheet rejects with AbortError — respect
      // that instead of then forcing a new tab open behind their back.
      if (err instanceof Error && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Convenience wrapper for the canvas.toDataURL() case (certificates, QSL cards). */
export async function downloadOrShareImage(dataUrl: string, filename: string): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return downloadOrShareBlob(blob, filename);
}
