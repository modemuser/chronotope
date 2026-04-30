// Glue: drive decodeVideo, paint the chronotope column-by-column, and run a
// live composite preview on a viz canvas. Render goes as fast as the codec
// allows — no real-time pacing — yielding to the event loop only when the
// main thread has been blocked for more than a vsync, so the UI stays
// responsive while the chronotope builds.

import { decodeVideo, type VideoMeta } from "./decode";
import { columnsForFrame, frameForColumn } from "./chronotope";

export interface RenderProgress {
  frame: number;
  total: number;
}

export interface RenderResult {
  meta: VideoMeta;
  // The chronotope canvas. Held off-DOM. Pass to exportChronotopeJpeg.
  chronotope: HTMLCanvasElement;
}

export interface RenderOptions {
  reverse?: boolean;
  // Show the faint vertical sweep marker on the live preview / recorded
  // viz. Defaults to true.
  sweep?: boolean;
  // If set, quantise the chronotope into this many vertical stripes —
  // each stripe shows columns from a single source frame, surfacing the
  // discrete nature of the algorithm. Smooth (1 frame per column) when
  // omitted or >= source width.
  steps?: number;
  signal?: AbortSignal;
  onMeta?: (m: VideoMeta) => void;
  onProgress?: (p: RenderProgress) => void;
  // Visible canvas for the live composite preview: source frame →
  // chronotope (so far) → sweep marker.
  viz?: HTMLCanvasElement | null;
  // Fires once when the (off-DOM) chronotope canvas has been allocated and
  // sized. Lets callers snapshot mid-render — the same canvas reference is
  // then returned in the final RenderResult.
  onChronotopeReady?: (chronotope: HTMLCanvasElement) => void;
  // Fires after each composite paint of the viz canvas. Callers use this
  // to capture the canvas state for recording (WebCodecs VideoEncoder).
  // The viz canvas reference is stable for the whole render. Awaited so
  // the recorder can apply backpressure (encodeQueueSize) without losing
  // frames.
  onVizFrame?: (frameIndex: number) => void | Promise<void>;
  // Pace the render to the source's fps (real-time playback). Used when
  // there's no encoder backpressure to throttle the loop — without this
  // the viz canvas updates faster than the eye can follow and looks
  // juddery. If the decode/paint can't keep up, frames just process as
  // fast as they can (no catch-up sleep).
  livePace?: boolean;
}

// Cap the viz canvas's longest edge. The chronotope canvas always stays at
// full source resolution for export; this only sizes the live preview /
// recorded MP4. A 5K source would otherwise force two 85 MB drawImage
// calls per frame, which the GPU can't sustain.
const VIZ_MAX_DIM = 1600;

// If the main thread has been blocked for more than this, yield to rAF
// before the next frame so the compositor + React can repaint. Bigger
// values render faster; smaller values feel more responsive.
const YIELD_AFTER_MS = 16;

export async function renderChronotope(
  file: File,
  opts: RenderOptions = {},
): Promise<RenderResult> {
  // Off-DOM chronotope target. Transparent — JPEG export flattens onto a
  // chosen background.
  const chronotope = document.createElement("canvas");
  let chronoCtx: CanvasRenderingContext2D | null = null;

  // Intermediate canvas we paint each VideoFrame onto before slicing.
  // Drawing partial source rects directly from a VideoFrame is unreliable
  // on iOS WebKit (the chroma-subsampling-aligned cropping produces
  // garbled stripes); slicing from a canvas works consistently everywhere.
  const frameCanvas = document.createElement("canvas");
  let frameCtx: CanvasRenderingContext2D | null = null;

  const viz = opts.viz ?? null;
  let vizCtx: CanvasRenderingContext2D | null = null;
  let vizW = 0;
  let vizH = 0;

  let meta: VideoMeta | null = null;
  let columnsByFrame: Int32Array[] = [];
  // Leading edge of the chronotope build. Forward fills left→right; reverse
  // fills right→left.
  let sweepCol = opts.reverse ? Number.POSITIVE_INFINITY : -1;
  let lastYieldMs = performance.now();
  // Wall-clock anchor for live-pace mode; set on the first frame.
  let paceStartMs = -1;

  const compositeViz = (drawSource: boolean) => {
    if (!viz || !vizCtx || !meta) return;
    if (drawSource && frameCtx) vizCtx.drawImage(frameCanvas, 0, 0, vizW, vizH);
    vizCtx.drawImage(chronotope, 0, 0, vizW, vizH);
    if (
      opts.sweep !== false &&
      Number.isFinite(sweepCol) &&
      sweepCol >= 0 &&
      sweepCol < meta.width
    ) {
      const x = (sweepCol / meta.width) * vizW;
      vizCtx.save();
      vizCtx.globalAlpha = 0.22;
      vizCtx.fillStyle = "#ffffff";
      vizCtx.fillRect(x, 0, Math.max(2, (vizW / meta.width) * 2), vizH);
      vizCtx.restore();
    }
  };

  await decodeVideo(
    file,
    (m) => {
      meta = m;
      chronotope.width = m.width;
      chronotope.height = m.height;
      chronoCtx = chronotope.getContext("2d");
      if (!chronoCtx) throw new Error("No 2d context on chronotope canvas");
      chronoCtx.clearRect(0, 0, m.width, m.height);

      frameCanvas.width = m.width;
      frameCanvas.height = m.height;
      // alpha:false: source video frames are opaque; skipping the alpha
      // channel saves per-pixel work on the per-frame full draw below.
      frameCtx = frameCanvas.getContext("2d", { alpha: false });
      if (!frameCtx) throw new Error("No 2d context on frame canvas");

      if (viz) {
        const scale = Math.min(1, VIZ_MAX_DIM / Math.max(m.width, m.height));
        vizW = Math.max(2, Math.round(m.width * scale));
        vizH = Math.max(2, Math.round(m.height * scale));
        viz.width = vizW;
        viz.height = vizH;
        vizCtx = viz.getContext("2d");
        if (!vizCtx) throw new Error("No 2d context on viz canvas");
        vizCtx.fillStyle = "#000";
        vizCtx.fillRect(0, 0, vizW, vizH);
      }

      const fmap = frameForColumn(
        m.width,
        m.totalFrames,
        opts.reverse ?? false,
        opts.steps,
      );
      columnsByFrame = columnsForFrame(fmap, m.totalFrames);

      opts.onChronotopeReady?.(chronotope);
      opts.onMeta?.(m);

      lastYieldMs = performance.now();
    },
    async (frame, index) => {
      if (!chronoCtx || !frameCtx || !meta) return;

      // 1) Yield to the event loop if we've been hogging the main thread
      //    for more than a vsync. Keeps the UI responsive (progress bar,
      //    React state updates, layout) without forcing real-time pacing.
      //    Skipped in livePace mode — the per-frame wait below already
      //    yields enough.
      if (!opts.livePace) {
        const now = performance.now();
        if (now - lastYieldMs >= YIELD_AFTER_MS) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          lastYieldMs = performance.now();
        }
      }
      if (opts.signal?.aborted) return;

      // 2) Paint the full VideoFrame onto frameCanvas — this is the only
      //    place we draw a VideoFrame as a source. All subsequent
      //    column-slicing reads from frameCanvas, which is RGBA and has
      //    no chroma-subsampling alignment quirks. Apply the container's
      //    display rotation here so frameCanvas (and downstream chronotope
      //    + viz) is in display orientation.
      if (meta.rotation === 0) {
        frameCtx.drawImage(frame, 0, 0);
      } else {
        const dw = frame.displayWidth;
        const dh = frame.displayHeight;
        frameCtx.save();
        frameCtx.translate(meta.width / 2, meta.height / 2);
        frameCtx.rotate((meta.rotation * Math.PI) / 180);
        frameCtx.drawImage(frame, -dw / 2, -dh / 2);
        frameCtx.restore();
      }

      // 3) Paint columns owned by this frame onto the chronotope canvas.
      const cols = columnsByFrame[index];
      if (cols && cols.length > 0) {
        if (opts.reverse) {
          sweepCol = Math.min(sweepCol, cols[0]);
        } else {
          sweepCol = Math.max(sweepCol, cols[cols.length - 1]);
        }
        let runStart = cols[0];
        let runEnd = cols[0];
        for (let i = 1; i < cols.length; i++) {
          const c = cols[i];
          if (c === runEnd + 1) {
            runEnd = c;
          } else {
            const w = runEnd - runStart + 1;
            chronoCtx.drawImage(
              frameCanvas,
              runStart, 0, w, meta.height,
              runStart, 0, w, meta.height,
            );
            runStart = c;
            runEnd = c;
          }
        }
        const w = runEnd - runStart + 1;
        chronoCtx.drawImage(
          frameCanvas,
          runStart, 0, w, meta.height,
          runStart, 0, w, meta.height,
        );
      }

      // 4) Composite the live preview + signal the recorder. Awaited so
      //    the recorder can apply queue-size backpressure.
      compositeViz(true);
      const vizP = opts.onVizFrame?.(index);
      if (vizP) await vizP;

      opts.onProgress?.({ frame: index + 1, total: meta.totalFrames });

      // 5) In live-pace mode: yield to rAF so the just-painted frame is
      //    actually visible, then wait until this frame's wall-clock slot
      //    elapses. If we're already behind schedule, skip the wait.
      if (opts.livePace && meta.fps > 0) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (paceStartMs < 0) paceStartMs = performance.now();
        const targetMs = paceStartMs + ((index + 1) * 1000) / meta.fps;
        const waitMs = targetMs - performance.now();
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
        }
        lastYieldMs = performance.now();
      }
    },
    opts.signal,
  );

  if (!meta) throw new Error("Decoder finished without metadata");

  // Final composite paint so the viz canvas (and last recorded frame)
  // ends on the completed chronotope rather than mid-build.
  compositeViz(false);

  return { meta, chronotope };
}

// Flatten a (possibly transparent) chronotope canvas onto black and produce
// a JPEG. Mirrors the `cv2.imwrite` output of the Python script.
export function exportChronotopeJpeg(
  canvas: HTMLCanvasElement,
  quality = 0.92,
): Promise<Blob> {
  const tmp = document.createElement("canvas");
  tmp.width = canvas.width;
  tmp.height = canvas.height;
  const ctx = tmp.getContext("2d");
  if (!ctx) throw new Error("Could not get 2d context for export canvas");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve, reject) => {
    tmp.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/jpeg",
      quality,
    );
  });
}
