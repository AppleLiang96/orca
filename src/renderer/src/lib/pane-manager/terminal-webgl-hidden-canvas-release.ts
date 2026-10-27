// Why: reallocating the backing on reveal costs about one frame, so only terminals left hidden this long pay it.
export const HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS = 30_000

type CanvasRelease = {
  resize: ResizeObserver
  mutation: MutationObserver
  timer: number | null
}

const releasesByCanvas = new WeakMap<HTMLCanvasElement, CanvasRelease>()

/** Chromium keeps a display:none WebGL canvas's drawing buffers (on macOS a back buffer plus up to four pooled full-size surfaces), so collapse the backing store once the canvas has stayed without a box; xterm's device-pixel observer restores it and redraws synchronously on reveal. `canRelease` vetoes panes whose reveal must stay allocation-free. */
export function releaseWebglCanvasBackingWhileHidden(
  canvas: HTMLCanvasElement,
  canRelease: () => boolean
): void {
  const view = canvas.ownerDocument.defaultView
  if (!view?.ResizeObserver || !view.MutationObserver || releasesByCanvas.has(canvas)) {
    return
  }
  const cancelRelease = (): void => {
    if (release.timer !== null) {
      view.clearTimeout(release.timer)
      release.timer = null
    }
  }
  const scheduleRelease = (): void => {
    release.timer = view.setTimeout(() => {
      if (!canRelease()) {
        scheduleRelease()
        return
      }
      release.timer = null
      canvas.width = 0
      canvas.height = 0
    }, HIDDEN_WEBGL_CANVAS_RELEASE_DELAY_MS)
  }
  const release: CanvasRelease = {
    resize: new view.ResizeObserver((entries) => {
      const box = entries.at(-1)?.contentRect
      if (!box || box.width > 0 || box.height > 0) {
        cancelRelease()
        return
      }
      if (release.timer === null && (canvas.width > 0 || canvas.height > 0)) {
        scheduleRelease()
      }
    }),
    // Why: a resize while hidden regrows the backing; re-observing yields a fresh box reading without forcing layout.
    mutation: new view.MutationObserver(() => {
      if (canvas.width > 0 || canvas.height > 0) {
        release.resize.unobserve(canvas)
        release.resize.observe(canvas)
      }
    }),
    timer: null
  }
  release.resize.observe(canvas)
  release.mutation.observe(canvas, { attributeFilter: ['width', 'height'] })
  releasesByCanvas.set(canvas, release)
}

export function stopReleasingWebglCanvasBacking(canvas: HTMLCanvasElement): void {
  const release = releasesByCanvas.get(canvas)
  if (!release) {
    return
  }
  if (release.timer !== null) {
    clearTimeout(release.timer)
  }
  release.resize.disconnect()
  release.mutation.disconnect()
  releasesByCanvas.delete(canvas)
}
