const observersByCanvas = new WeakMap<HTMLCanvasElement, ResizeObserver>()

/** Chromium keeps a display:none WebGL canvas's drawing buffers (on macOS a back buffer plus up to four pooled full-size surfaces), so collapse the backing store while the canvas has no box; xterm's device-pixel observer restores it and redraws synchronously on reveal. */
export function releaseWebglCanvasBackingWhileHidden(canvas: HTMLCanvasElement): void {
  const ResizeObserverConstructor = canvas.ownerDocument.defaultView?.ResizeObserver
  if (!ResizeObserverConstructor || observersByCanvas.has(canvas)) {
    return
  }
  const observer = new ResizeObserverConstructor((entries) => {
    const box = entries.at(-1)?.contentRect
    if (box && box.width === 0 && box.height === 0 && (canvas.width > 0 || canvas.height > 0)) {
      canvas.width = 0
      canvas.height = 0
    }
  })
  observer.observe(canvas)
  observersByCanvas.set(canvas, observer)
}

export function stopReleasingWebglCanvasBacking(canvas: HTMLCanvasElement): void {
  observersByCanvas.get(canvas)?.disconnect()
  observersByCanvas.delete(canvas)
}
