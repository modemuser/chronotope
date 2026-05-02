// Pure column→frame mapping. Mirrors column_time_scan.py.
//
// For each output column x in [0, width), we pick frame f(x) where:
//   f(x) = round(t(x) * (N - 1)),  t(x) ∈ [0, 1]
//
// Shape controls the curve of t(x):
//   linear:   t = x / (W - 1)                     — diagonal sweep edge to edge
//   v:        t = distance from pivot column, per-side normalised so each
//             arm independently reaches t = 1 at its edge even when the
//             pivot is off-centre
//   parabola: same t as v, then squared — softer apex, snaps to the edges
//
// `reverse` flips time (t → 1 - t). With v + reverse the apex column = last
// frame and the edges = first frame (motion converges inward into an
// arrowhead). With parabola + reverse the late state is held across most of
// the width and edges snap back to early frames (radial vortex / halo).
//
// When `steps` is provided and < width, the column axis is quantised into
// that many chunks first, then the shape's t is evaluated at each chunk's
// representative x. This produces "venetian blind" stripes — every stripe
// is a single moment in time. (Quantising x rather than the post-shape t
// avoids aliasing where a steep arm of the V would otherwise collapse
// adjacent stripes.)

export type Shape = "linear" | "v" | "parabola";

export interface FrameForColumnOptions {
  reverse?: boolean;
  steps?: number;
  shape?: Shape;
  // Apex column as a fraction of width, 0..1. Only meaningful for v /
  // parabola. Default 0.5 (centred).
  pivot?: number;
}

function tForX(x: number, denom: number, shape: Shape, pivot: number): number {
  if (shape === "linear") return x / denom;
  const xc = pivot * denom;
  const dLeft = Math.max(xc, 1);
  const dRight = Math.max(denom - xc, 1);
  const t = x <= xc ? (xc - x) / dLeft : (x - xc) / dRight;
  return shape === "parabola" ? t * t : t;
}

export function frameForColumn(
  width: number,
  nFrames: number,
  options: FrameForColumnOptions = {},
): Int32Array {
  if (width < 2 || nFrames < 2) {
    throw new Error("width and nFrames must both be >= 2");
  }
  const reverse = options.reverse ?? false;
  const shape = options.shape ?? "linear";
  const pivot = options.pivot ?? 0.5;
  const steps = options.steps;

  const out = new Int32Array(width);
  const span = nFrames - 1;

  if (!steps || steps >= width) {
    // Smooth: every column gets its own frame.
    const denom = width - 1;
    for (let x = 0; x < width; x++) {
      let t = tForX(x, denom, shape, pivot);
      if (reverse) t = 1 - t;
      out[x] = Math.round(t * span);
    }
    return out;
  }

  // Discrete: quantise x into `steps` chunks, then apply the shape at each
  // chunk's representative x. Representative x maps chunk c to c/(s-1) of
  // the way across the width — so chunk 0 sits at x=0 and chunk s-1 at
  // x=W-1, matching the smooth path's endpoints. Quantising before the
  // shape keeps the V's steep arms from aliasing into mismatched stripes.
  const s = Math.max(2, Math.floor(steps));
  const denom = width - 1;
  const chunkDenom = s - 1;
  for (let x = 0; x < width; x++) {
    const chunk = Math.min(s - 1, Math.floor((x * s) / width));
    const repX = (chunk * denom) / chunkDenom;
    let t = tForX(repX, denom, shape, pivot);
    if (reverse) t = 1 - t;
    out[x] = Math.round(t * span);
  }
  return out;
}

// Inverse map: for each frame index, the list of output columns that should
// be sampled from it. Length nFrames; entries are sorted column indices.
export function columnsForFrame(
  frameForCol: Int32Array,
  nFrames: number,
): Int32Array[] {
  const buckets: number[][] = Array.from({ length: nFrames }, () => []);
  for (let x = 0; x < frameForCol.length; x++) {
    buckets[frameForCol[x]].push(x);
  }
  return buckets.map((b) => Int32Array.from(b));
}
