// Pure column→frame mapping. Mirrors column_time_scan.py.
//
// For each output column x in [0, width), we pick frame f(x) where:
//   forward: f(0)=0, f(W-1)=N-1
//   reverse: f(0)=N-1, f(W-1)=0
// f(x) = round( x * (N-1) / (W-1) ) (or its reverse)

export function frameForColumn(
  width: number,
  nFrames: number,
  reverse: boolean = false,
): Int32Array {
  if (width < 2 || nFrames < 2) {
    throw new Error("width and nFrames must both be >= 2");
  }
  const out = new Int32Array(width);
  const denom = width - 1;
  const span = nFrames - 1;
  for (let x = 0; x < width; x++) {
    const t = reverse ? (denom - x) : x;
    out[x] = Math.round((t * span) / denom);
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
