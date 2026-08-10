// Glue: drive decodeVideo, paint the chronotope column-by-column, and run a
// live composite preview on a viz canvas. Render goes as fast as the codec
// allows — no real-time pacing — yielding to the event loop only when the
// main thread has been blocked for more than a vsync, so the UI stays
// responsive while the chronotope builds.

import { decodeVideo, type VideoMeta } from "./decode";
import { columnsForFrame, frameForColumn, type Shape } from "./chronotope";
import {
  DEFLICKER_MEDIAN_RADIUS,
  DEFLICKER_STRIPS,
  StripSmoother,
  meanRgbStrips,
  residualGains,
} from "./deflicker";

export interface RenderProgress {
  frame: number;
  total: number;
}

// Downsampled-thumbnail strip captured during render, so the caller can
// resample any (x, y) on the source over time without re-decoding. Each
// frame's thumbnail is one cell in a 2D grid (cols × rows), aspect ratio
// preserved, longest edge capped at THUMB_LONGEST_EDGE. data is a flat
// RGBA buffer of the whole strip.
export interface ThumbnailStrip {
  thumbW: number;
  thumbH: number;
  cols: number;
  rows: number;
  stripW: number;
  nFrames: number;
  data: Uint8ClampedArray;
}

export interface RenderResult {
  meta: VideoMeta;
  // The chronotope canvas. Held off-DOM. Pass to exportChronotopeJpeg.
  chronotope: HTMLCanvasElement;
  thumbnails: ThumbnailStrip;
}

export interface RenderOptions {
  reverse?: boolean;
  // Curve of the column→frame mapping. "linear" is the default diagonal
  // sweep; "v" / "parabola" fold time symmetrically around `pivot` for
  // radial / halo effects (esp. in combination with `reverse`).
  shape?: Shape;
  // Apex column as a fraction of width, 0..1 (only used by v / parabola).
  pivot?: number;
  // Show the faint vertical sweep marker on the live preview / recorded
  // viz. Defaults to true.
  sweep?: boolean;
  // If set, quantise the chronotope into this many vertical stripes —
  // each stripe shows columns from a single source frame, surfacing the
  // discrete nature of the algorithm. Smooth (1 frame per column) when
  // omitted or >= source width.
  steps?: number;
  // Match each frame's mean luminance to a sliding-window average of the
  // frames before it (timelapse deflicker). Removes the vertical banding
  // that per-frame exposure flicker in the source produces. Defaults to
  // true.
  deflicker?: boolean;
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

// Longest edge of each thumbnail in the per-frame strip (aspect ratio
// preserved). 128 is a balance between memory (12 MB for 240 frames at
// 16:9) and spatial precision when the user picks a sample point.
const THUMB_LONGEST_EDGE = 128;

// Longest edge of the canvas used to measure each frame's per-strip
// levels for deflicker. 256 px keeps the per-frame getImageData under
// 200 KB (CPU-backed) while a 15%-of-width local window still gives
// each of the 8 strips several hundred samples for the interquartile
// mean to resolve sub-0.1% gains.
const MEASURE_LONGEST_EDGE = 256;

// Half-width of the local measurement window, as a fraction of frame
// width. The window is centred on the columns a frame contributes, so
// horizontally-localised flicker (lens glare around the sun) is measured
// where it will actually be sliced.
const MEASURE_WINDOW_HALF = 0.075;

// Split a frame's sorted column list into contiguous [start, end] runs.
function columnRuns(cols: Int32Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  if (cols.length === 0) return runs;
  let start = cols[0];
  let end = cols[0];
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === end + 1) {
      end = cols[i];
    } else {
      runs.push([start, end]);
      start = cols[i];
      end = cols[i];
    }
  }
  runs.push([start, end]);
  return runs;
}

// Skip the gain pass when the correction would be below what 8-bit
// compositing can express anyway.
const GAIN_EPSILON = 1 / 255;

// Per-row, per-channel gains for a frame: rows × [r, g, b], linearly
// interpolated between the strip centres (matching the gradient used for
// the composite-op path). Float-precision — real flicker needs median
// corrections of ~0.4%, right at the 1/255 step composite ops quantise
// to, so the chronotope columns are corrected in float instead.
function rowGainsFor(
  gains: Array<[number, number, number]>,
  height: number,
): Float32Array {
  const s = gains.length;
  const out = new Float32Array(height * 3);
  for (let y = 0; y < height; y++) {
    const pos = ((y + 0.5) / height) * s - 0.5;
    const s0 = Math.max(0, Math.min(s - 1, Math.floor(pos)));
    const s1 = Math.min(s - 1, s0 + 1);
    const t = Math.max(0, Math.min(1, pos - s0));
    for (let c = 0; c < 3; c++) {
      out[y * 3 + c] = gains[s0][c] * (1 - t) + gains[s1][c] * t;
    }
  }
  return out;
}

// Multiply a canvas's pixels by per-strip, per-channel gains using
// composite ops — works on every browser that runs WebCodecs, unlike
// ctx.filter = "brightness()" (long unsupported on iOS WebKit). The
// spatial variation rides in a vertical linear gradient (one colour stop
// per strip centre, canvas interpolates between them) multiply-blended
// over the frame, normalised by the largest gain M; when M > 1 the frame
// is additively re-drawn onto itself scaled by (M - 1), i.e.
// (frame·g/M)·(1 + (M-1)) = frame·g, exact for gains up to 2 (GAIN_MAX).
// Quantises each gain to ~1/255.
function applyGain(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  gains: Array<[number, number, number]>,
) {
  let m = 0;
  let maxDev = 0;
  for (const [gr, gg, gb] of gains) {
    m = Math.max(m, gr, gg, gb);
    maxDev = Math.max(
      maxDev,
      Math.abs(gr - 1),
      Math.abs(gg - 1),
      Math.abs(gb - 1),
    );
  }
  if (maxDev < GAIN_EPSILON) return;
  const scale = m > 1 ? m : 1;
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gains.forEach(([gr, gg, gb], s) => {
    grad.addColorStop(
      (s + 0.5) / gains.length,
      `rgb(${Math.round((255 * gr) / scale)},${Math.round(
        (255 * gg) / scale,
      )},${Math.round((255 * gb) / scale)})`,
    );
  });
  ctx.save();
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (m > 1) {
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = Math.min(1, m - 1);
    ctx.drawImage(canvas, 0, 0);
  }
  ctx.restore();
}

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

  // Off-DOM strip that accumulates one thumbnail per frame in a 2D grid.
  // willReadFrequently asks the browser to back the canvas with CPU pixel
  // data so the single getImageData at the end is a copy rather than a
  // GPU readback. Per-frame drawImage is small + pipelines on the GPU
  // (or stays CPU-side under that hint) so the render hot path stays
  // unblocked.
  const thumbStrip = document.createElement("canvas");
  let thumbCtx: CanvasRenderingContext2D | null = null;
  let thumbW = 0;
  let thumbH = 0;
  let thumbCols = 0;

  // Tiny canvas for the per-frame luminance measurement (deflicker).
  const deflicker = opts.deflicker ?? true;
  const measureCanvas = document.createElement("canvas");
  let measureCtx: CanvasRenderingContext2D | null = null;
  // The causal (streaming) pass corrects from FULL-WIDTH strip levels
  // only — content drifting through a small window would make local
  // gains noisy, and the preview applies them to the whole frame, so
  // conservative wins here. The slice-local levels are only LOGGED, per
  // run ordinal, for the two-pass polish to correct glare afterwards.
  const smoother = new StripSmoother();
  const globalLog: Array<Array<[number, number, number]>> = [];
  const localLog: Array<Array<Array<[number, number, number]>>> = [];
  const appliedLog: Array<Array<[number, number, number]>> = [];

  // Both V and parabola read better with their "into the centre" variant
  // as the default: V → arrowhead, parabola → radial halo. So for any
  // non-linear shape, swap the meaning of `reverse` — UI-reverse=false
  // maps to underlying reverse=true and vice versa. Linear keeps its
  // original semantics.
  const reverse =
    opts.shape && opts.shape !== "linear"
      ? !(opts.reverse ?? false)
      : opts.reverse ?? false;

  let meta: VideoMeta | null = null;
  let columnsByFrame: Int32Array[] = [];
  let pivotCol = 0;
  // Leading edges of the chronotope build. Linear uses sweepCol only and
  // grows monotonically across the width. V/parabola use both: each frame
  // paints columns on both sides of the pivot, and we track the boundary
  // between painted and unpainted on each side so the markers show two
  // diverging (forward) or converging (reverse) wave fronts.
  // sweepCol2 = -1 means "no second marker active".
  let sweepCol = reverse ? Number.POSITIVE_INFINITY : -1;
  let sweepCol2 = -1;
  let lastYieldMs = performance.now();
  // Wall-clock anchor for live-pace mode; set on the first frame.
  let paceStartMs = -1;

  const compositeViz = (drawSource: boolean) => {
    if (!viz || !vizCtx || !meta) return;
    if (drawSource && frameCtx) vizCtx.drawImage(frameCanvas, 0, 0, vizW, vizH);
    vizCtx.drawImage(chronotope, 0, 0, vizW, vizH);
    if (opts.sweep === false) return;
    const w = meta.width;
    const stripeW = Math.max(2, (vizW / w) * 2);
    const drawMarker = (col: number) => {
      if (!Number.isFinite(col) || col < 0 || col >= w) return;
      vizCtx!.fillRect((col / w) * vizW, 0, stripeW, vizH);
    };
    vizCtx.save();
    vizCtx.globalAlpha = 0.22;
    vizCtx.fillStyle = "#ffffff";
    drawMarker(sweepCol);
    if (sweepCol2 !== sweepCol) drawMarker(sweepCol2);
    vizCtx.restore();
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
      // willReadFrequently only when deflicker will actually read the
      // column slices back each frame — a CPU-backed canvas slows every
      // blit, so the default path stays on the GPU.
      frameCtx = frameCanvas.getContext("2d", {
        alpha: false,
        willReadFrequently: deflicker,
      });
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

      const fmap = frameForColumn(m.width, m.totalFrames, {
        reverse,
        steps: opts.steps,
        shape: opts.shape,
        pivot: opts.pivot,
      });
      columnsByFrame = columnsForFrame(fmap, m.totalFrames);

      // Lay out thumbnails in a near-square grid so the strip canvas
      // stays within sane dimensions even for long videos (5k frames at
      // 16:9 = ~9k × 5k px instead of one absurdly tall stripe).
      const longest = Math.max(m.width, m.height);
      const thumbScale = Math.min(1, THUMB_LONGEST_EDGE / longest);
      thumbW = Math.max(1, Math.round(m.width * thumbScale));
      thumbH = Math.max(1, Math.round(m.height * thumbScale));
      thumbCols = Math.ceil(Math.sqrt(m.totalFrames));
      const thumbRows = Math.ceil(m.totalFrames / thumbCols);
      thumbStrip.width = thumbCols * thumbW;
      thumbStrip.height = thumbRows * thumbH;
      thumbCtx = thumbStrip.getContext("2d", { willReadFrequently: true });
      if (!thumbCtx) throw new Error("No 2d context on thumb strip");
      pivotCol = Math.round((opts.pivot ?? 0.5) * (m.width - 1));

      if (deflicker) {
        const mScale = Math.min(1, MEASURE_LONGEST_EDGE / longest);
        measureCanvas.width = Math.max(1, Math.round(m.width * mScale));
        measureCanvas.height = Math.max(1, Math.round(m.height * mScale));
        measureCtx = measureCanvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
        if (!measureCtx) throw new Error("No 2d context on measure canvas");
      }

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

      // 2a) Deflicker: measure this frame's per-strip, per-channel
      //     levels on a downsample of the raw frame, in a local window
      //     centred on the columns this frame contributes, against a
      //     sliding-window average of the frames before it. Per channel
      //     because white-balance flicker (channels moving against each
      //     other) is as strong as exposure flicker on real footage; per
      //     strip because action-cam local tone mapping flickers sky and
      //     ground independently; per slice-position window because lens
      //     glare is horizontally localised too. Without this, per-frame
      //     flicker in the source shows up as vertical banding —
      //     adjacent columns come from adjacent frames. The gains are
      //     applied in two ways below: float-precision on the chronotope
      //     columns (real corrections are ~0.4%, at the edge of what
      //     8-bit composite ops can express), approximate on the
      //     preview surfaces.
      const cols = columnsByFrame[index];
      const runs = cols && cols.length > 0 ? columnRuns(cols) : [];
      let gains: Array<[number, number, number]> | null = null;
      let rowGains: Float32Array | null = null;
      if (measureCtx && runs.length > 0) {
        measureCtx.drawImage(
          frameCanvas,
          0, 0, measureCanvas.width, measureCanvas.height,
        );
        const img = measureCtx.getImageData(
          0, 0, measureCanvas.width, measureCanvas.height,
        );
        const mw = measureCanvas.width;
        const mh = measureCanvas.height;
        const globalMeans = meanRgbStrips(img.data, mw, mh);
        gains = smoother.next(globalMeans);
        globalLog[index] = globalMeans;
        appliedLog[index] = gains;
        if (gains.some((g) => g.some((v) => Math.abs(v - 1) > 1e-4))) {
          rowGains = rowGainsFor(gains, meta.height);
        }
        // Log slice-local levels per run for the two-pass polish.
        // Degenerate mappings (steps mode can in principle fragment)
        // fall back to a single full-width window.
        const local = runs.length <= 4;
        const nWindows = local ? runs.length : 1;
        const localByRun: Array<Array<[number, number, number]>> = [];
        for (let r = 0; r < nWindows; r++) {
          if (!local) {
            localByRun.push(globalMeans);
            break;
          }
          const [rs, re] = runs[r];
          const cx = (((rs + re) / 2 + 0.5) / meta.width) * mw;
          const half = Math.max(12, Math.round(mw * MEASURE_WINDOW_HALF));
          let x0 = Math.max(0, Math.round(cx - half));
          let x1 = Math.min(mw, Math.round(cx + half));
          if (x1 - x0 < 2 * half) {
            // Clamped at an edge — keep the window width by extending
            // the other side.
            if (x0 === 0) x1 = Math.min(mw, 2 * half);
            else x0 = Math.max(0, x1 - 2 * half);
          }
          localByRun.push(
            meanRgbStrips(img.data, mw, mh, DEFLICKER_STRIPS, x0, x1),
          );
        }
        localLog[index] = localByRun;
      }

      // 3) Paint columns owned by this frame onto the chronotope canvas.
      if (cols && cols.length > 0) {
        // Linear: a single marker tracks the monotonic leading edge.
        // V/parabola: two markers, one per side of the pivot. The marker
        // sits on the boundary between painted and unpainted —
        //   forward (apex = frame 0): painted region grows outward, so
        //     the marker is the OUTER edge of the current frame's cols
        //     (cols[0] on the left, cols[last] on the right).
        //   reverse (apex = frame N-1): painted region grows inward from
        //     the edges, so the marker is the INNER edge — the col
        //     closest to the pivot on each side. Using cols[0]/cols[last]
        //     here would leave the markers stuck at the outer rim of the
        //     current frame's band; in particular for parabola the apex
        //     frame owns a wide stripe around the pivot and the markers
        //     would never meet in the middle.
        if (!opts.shape || opts.shape === "linear") {
          if (reverse) {
            sweepCol = Math.min(sweepCol, cols[0]);
          } else {
            sweepCol = Math.max(sweepCol, cols[cols.length - 1]);
          }
        } else if (reverse) {
          let i = 0;
          while (i < cols.length && cols[i] <= pivotCol) i++;
          // cols[i-1] = closest left-arm col to pivot; cols[i] = closest
          // right-arm col. Either side may be empty if the entire frame
          // landed on one arm (off-centre pivot near the apex).
          if (i > 0) sweepCol = cols[i - 1];
          if (i < cols.length) sweepCol2 = cols[i];
        } else {
          sweepCol = cols[0];
          sweepCol2 = cols[cols.length - 1];
        }
        // Paint each run of contiguous columns. With deflicker gains the
        // run's pixels are read back, multiplied in float by the per-row
        // gains, and written straight into the chronotope (putImageData)
        // — runs are only a few columns wide, so this stays cheap even
        // at 5K. Without gains, a plain GPU-side blit.
        for (let r = 0; r < runs.length; r++) {
          const [rs, re] = runs[r];
          const w = re - rs + 1;
          if (rowGains && frameCtx && chronoCtx) {
            const rg = rowGains;
            const img = frameCtx.getImageData(rs, 0, w, meta.height);
            const d = img.data;
            for (let y = 0; y < meta.height; y++) {
              const gr = rg[y * 3];
              const gg = rg[y * 3 + 1];
              const gb = rg[y * 3 + 2];
              let o = y * w * 4;
              for (let x = 0; x < w; x++, o += 4) {
                d[o] = d[o] * gr;
                d[o + 1] = d[o + 1] * gg;
                d[o + 2] = d[o + 2] * gb;
              }
            }
            chronoCtx.putImageData(img, rs, 0);
          } else if (chronoCtx) {
            chronoCtx.drawImage(
              frameCanvas,
              rs, 0, w, meta.height,
              rs, 0, w, meta.height,
            );
          }
        }
      }

      // 3b) Apply the approximate composite-op gain to the full frame
      //     canvas for the preview surfaces (viz backdrop, thumbnails /
      //     colour bar) — after the columns were sliced from the raw
      //     frame, so the float correction isn't applied twice. Then
      //     drop this frame's thumbnail into its slot in the strip.
      if (gains) applyGain(frameCtx, frameCanvas, gains);
      if (thumbCtx) {
        const c = index % thumbCols;
        const r = Math.floor(index / thumbCols);
        thumbCtx.drawImage(
          frameCanvas,
          0, 0, meta.width, meta.height,
          c * thumbW, r * thumbH, thumbW, thumbH,
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
  if (!thumbCtx) throw new Error("Thumb strip never initialised");
  const finalMeta: VideoMeta = meta;
  const finalThumbCtx: CanvasRenderingContext2D = thumbCtx;

  // Two-pass polish: the causal window can only cancel flicker shorter
  // than itself — glare / auto-exposure episodes of 15-50 frames (sun
  // cresting behind trees) survive it as wide bright bands. With the
  // whole video measured, correct every frame's columns towards a
  // robust smooth trend (median + mean over the full series, lag-free).
  // Skipped for clips too short to distinguish trend from episode.
  {
    const nF = finalMeta.totalFrames;
    let measured = 0;
    let maxRuns = 0;
    for (let i = 0; i < nF; i++) {
      if (globalLog[i]) {
        measured++;
        maxRuns = Math.max(maxRuns, localLog[i]?.length ?? 0);
      }
    }
    if (
      chronoCtx &&
      !opts.signal?.aborted &&
      maxRuns > 0 &&
      measured > 4 * DEFLICKER_MEDIAN_RADIUS
    ) {
      // Per run ordinal: build dense per-frame global/local series
      // (holes filled by carrying the nearest measurement, so the trend
      // fit stays sane), compute the two-pass residual, then null out
      // frames that never had that run so nothing gets repainted there.
      const residualByRun: Array<
        Array<Array<[number, number, number]> | null>
      > = [];
      for (let r = 0; r < maxRuns; r++) {
        const gS: Array<Array<[number, number, number]>> = new Array(nF);
        const lS: Array<Array<[number, number, number]>> = new Array(nF);
        const appS: Array<Array<[number, number, number]>> = new Array(nF);
        let lastG: Array<[number, number, number]> | null = null;
        let lastL: Array<[number, number, number]> | null = null;
        let lastA: Array<[number, number, number]> | null = null;
        for (let i = 0; i < nF; i++) {
          const lm = localLog[i]?.[r];
          if (lm) {
            lastG = globalLog[i];
            lastL = lm;
            lastA = appliedLog[i];
          }
          gS[i] = lastG!;
          lS[i] = lastL!;
          appS[i] = lastA!;
        }
        let first = -1;
        for (let i = 0; i < nF; i++) {
          if (lS[i]) {
            first = i;
            break;
          }
        }
        if (first < 0) {
          residualByRun.push(new Array(nF).fill(null));
          continue;
        }
        for (let i = 0; i < first; i++) {
          gS[i] = gS[first];
          lS[i] = lS[first];
          appS[i] = appS[first];
        }
        const res = residualGains(gS, lS, appS);
        for (let i = 0; i < nF; i++) {
          if (!localLog[i]?.[r]) res[i] = null;
        }
        residualByRun.push(res);
      }
      const H = finalMeta.height;
      const W = finalMeta.width;
      // Process in column bands so peak ImageData memory stays bounded
      // on 5K sources; one readback + one write per band.
      const BAND = 512;
      let lastYieldMs = performance.now();
      for (let x0 = 0; x0 < W; x0 += BAND) {
        if (opts.signal?.aborted) break;
        const rowGainCache = new Map<number, Float32Array>();
        const bw = Math.min(BAND, W - x0);
        const img = (chronoCtx as CanvasRenderingContext2D).getImageData(
          x0, 0, bw, H,
        );
        const d = img.data;
        let touched = false;
        for (let i = 0; i < nF; i++) {
          const frameRuns = localLog[i];
          if (!frameRuns) continue;
          const cols = columnsByFrame[i];
          if (!cols || cols.length === 0) continue;
          const runs = columnRuns(cols);
          for (let r = 0; r < runs.length; r++) {
            const [rs, re] = runs[r];
            if (re < x0 || rs >= x0 + bw) continue;
            const rIdx = Math.min(r, frameRuns.length - 1);
            const res = residualByRun[rIdx][i];
            if (!res) continue;
            const key = i * 8 + rIdx;
            let rg = rowGainCache.get(key);
            if (!rg) {
              rg = rowGainsFor(res, H);
              rowGainCache.set(key, rg);
            }
            touched = true;
            const from = Math.max(rs, x0);
            const to = Math.min(re, x0 + bw - 1);
            for (let c = from; c <= to; c++) {
              const cx = c - x0;
              for (let y = 0; y < H; y++) {
                const o = (y * bw + cx) * 4;
                d[o] = d[o] * rg[y * 3];
                d[o + 1] = d[o + 1] * rg[y * 3 + 1];
                d[o + 2] = d[o + 2] * rg[y * 3 + 2];
              }
            }
          }
        }
        if (touched) {
          (chronoCtx as CanvasRenderingContext2D).putImageData(img, x0, 0);
        }
        if (performance.now() - lastYieldMs >= 50) {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
          lastYieldMs = performance.now();
        }
      }
    }
  }

  // Single batched readback of the whole thumbnail strip — one sync vs.
  // one per frame.
  const stripImg = finalThumbCtx.getImageData(
    0, 0, thumbStrip.width, thumbStrip.height,
  );
  const thumbnails: ThumbnailStrip = {
    thumbW,
    thumbH,
    cols: thumbCols,
    rows: Math.ceil(finalMeta.totalFrames / thumbCols),
    stripW: thumbStrip.width,
    nFrames: finalMeta.totalFrames,
    data: stripImg.data,
  };

  // Final composite paint so the viz canvas (and last recorded frame)
  // ends on the completed chronotope rather than mid-build. Clear the
  // sweep markers first — the build is done, so the lingering wave-front
  // indicator should disappear and reveal the whole chronotope. Record
  // one extra clean frame too: the MP4 plays back in the UI and otherwise
  // would freeze on a marker-laden last frame.
  sweepCol = -1;
  sweepCol2 = -1;
  compositeViz(false);
  if (opts.onVizFrame) {
    const tailP = opts.onVizFrame(finalMeta.totalFrames);
    if (tailP) await tailP;
  }

  return { meta: finalMeta, chronotope, thumbnails };
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
