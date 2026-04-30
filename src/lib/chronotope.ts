// Pure column→frame mapping. Mirrors column_time_scan.py.
//
// For each output column x in [0, width), we pick frame f(x) where:
//   forward: f(0)=0, f(W-1)=N-1
//   reverse: f(0)=N-1, f(W-1)=0
// f(x) = round( x * (N-1) / (W-1) ) (or its reverse)
//
// When `steps` is provided and < width, the column axis is quantised
// into that many chunks, so each chunk shows a single frame ("venetian
// blind" stripes). Useful for surfacing the discrete nature of the
// algorithm — every stripe = one moment in time.

export function frameForColumn(
  width: number,
  nFrames: number,
  reverse: boolean = false,
  steps?: number,
): Int32Array {
  if (width < 2 || nFrames < 2) {
    throw new Error("width and nFrames must both be >= 2");
  }
  const out = new Int32Array(width);
  if (!steps || steps >= width) {
    // Smooth: every column gets its own frame.
    const denom = width - 1;
    const span = nFrames - 1;
    for (let x = 0; x < width; x++) {
      const t = reverse ? denom - x : x;
      out[x] = Math.round((t * span) / denom);
    }
    return out;
  }
  // Discrete: `steps` chunks, each width/steps wide, all sampling one frame.
  const s = Math.max(2, Math.floor(steps));
  const chunkDenom = s - 1;
  const span = nFrames - 1;
  for (let x = 0; x < width; x++) {
    const chunk = Math.min(s - 1, Math.floor((x * s) / width));
    const t = reverse ? chunkDenom - chunk : chunk;
    out[x] = Math.round((t * span) / chunkDenom);
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
