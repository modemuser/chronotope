// hqdn3d-style temporal denoise, specialised for the chronotope slicer.
//
// Grain in the source (high-ISO timelapse, dusk footage) survives into the
// chronotope because every output column is a single frame's pixels — there
// is nothing to average it against spatially without smearing detail. But
// temporally there is: the camera is (typically) static, so the same column
// in neighbouring frames shows the same scene plus independent noise.
//
// So instead of denoising whole frames, we denoise exactly the columns the
// chronotope keeps: each output column, owned by frame i, is blended from
// that same column sampled across frames [i - R .. i + R]. Neighbour
// samples are weighted by how much they differ from the owner's pixel —
// near-identical values (noise) average at almost full weight, large
// differences (real motion: the shadow edge, a bird, headlights) fall off
// fast and leave the owner pixel untouched. This is the essence of
// hqdn3d's temporal pass; the spatial pass is deliberately omitted — on
// static footage the temporal taps do the heavy lifting without costing
// any sharpness.
//
// Frames arrive serially from the decoder, so the denoiser is a delay
// line: samples are harvested as frames stream past, and a column is
// finalised (blended + ready to paint) once its last future tap — owner
// index + R — has been seen. Memory stays tiny: only the column slices
// inside the sliding window are buffered, never whole frames.

// Temporal radius: taps at owner ± R frames. 3 → up to 7 samples per
// column, ~8.5× noise-power reduction where the scene is static.
export const DENOISE_RADIUS = 3;

// Soft threshold, in 8-bit channel units, where a neighbour's difference
// from the owner stops counting as noise. Chosen against ISO ~1600
// action-cam footage: sensor noise sits at ±3-8 counts, real edges are
// tens of counts.
export const DENOISE_STRENGTH = 8;

// Weight of a neighbour sample whose channel differs from the owner's by
// |d|. Cubic falloff: ≈1 inside the noise band, ≈0 beyond ~2× strength.
// (hqdn3d uses a comparable soft-knee curve via LUT.)
export function tapWeight(d: number, strength: number): number {
  const x = Math.abs(d) / strength;
  return 1 / (1 + x * x * x);
}

// Blend one column from its temporal taps. `taps` holds RGBA slices of
// the same source column across consecutive frames; `ownerTap` indexes
// the slice belonging to the frame that owns the column. Channels are
// weighted independently, matching hqdn3d's per-plane treatment. Alpha
// is copied from the owner.
export function blendColumn(
  taps: Uint8ClampedArray[],
  ownerTap: number,
  strength: number,
): Uint8ClampedArray<ArrayBuffer> {
  const ref = taps[ownerTap];
  const out = new Uint8ClampedArray(ref.length);
  for (let o = 0; o < ref.length; o += 4) {
    for (let c = 0; c < 3; c++) {
      const r = ref[o + c];
      let num = r;
      let den = 1;
      for (let t = 0; t < taps.length; t++) {
        if (t === ownerTap) continue;
        const s = taps[t][o + c];
        const w = tapWeight(s - r, strength);
        num += w * s;
        den += w;
      }
      out[o + c] = num / den;
    }
    out[o + 3] = ref[o + 3];
  }
  return out;
}

export interface DenoisedColumn {
  x: number;
  data: Uint8ClampedArray<ArrayBuffer>; // RGBA, height rows × 1 column
}

// Reads a horizontal run [x0, x0 + w) of the CURRENT source frame and
// returns its RGBA pixels (row-major, w × height). Provided by the render
// loop; backed by getImageData on the frame canvas.
export type RunReader = (x0: number, w: number) => Uint8ClampedArray;

interface PendingColumn {
  owner: number;
  taps: Uint8ClampedArray[];
  ownerTap: number;
}

// Split a sorted column list into contiguous [start, end] runs, so the
// harvest can batch one read per run instead of one per column.
function runsOf(cols: number[]): Array<[number, number]> {
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

export class TemporalColumnDenoiser {
  private pending = new Map<number, PendingColumn>();
  private readonly lastFrame: number;
  private readonly columnsByFrame: Int32Array[];
  private readonly height: number;
  private readonly radius: number;
  private readonly strength: number;

  constructor(
    columnsByFrame: Int32Array[],
    height: number,
    radius = DENOISE_RADIUS,
    strength = DENOISE_STRENGTH,
  ) {
    this.columnsByFrame = columnsByFrame;
    this.height = height;
    this.radius = radius;
    this.strength = strength;
    this.lastFrame = columnsByFrame.length - 1;
  }

  // Feed the next decoded frame. Harvests this frame's pixels for every
  // column whose owner lies within ±radius, and returns the columns that
  // became complete (owner === index - radius), blended and ready to
  // paint. Frames must be fed in order, each index exactly once.
  onFrame(index: number, read: RunReader): DenoisedColumn[] {
    // 1) Which columns need a sample from THIS frame?
    const want: number[] = [];
    const lo = Math.max(0, index - this.radius);
    const hi = Math.min(this.lastFrame, index + this.radius);
    for (let i = lo; i <= hi; i++) {
      const cols = this.columnsByFrame[i];
      for (let k = 0; k < cols.length; k++) want.push(cols[k]);
    }
    want.sort((a, b) => a - b);

    // 2) Harvest, one read per contiguous run.
    const H = this.height;
    for (const [rs, re] of runsOf(want)) {
      const w = re - rs + 1;
      const px = read(rs, w);
      for (let x = rs; x <= re; x++) {
        let p = this.pending.get(x);
        if (!p) {
          p = { owner: this.ownerOf(x, lo, hi), taps: [], ownerTap: -1 };
          this.pending.set(x, p);
        }
        const slice = new Uint8ClampedArray(H * 4);
        const cx = x - rs;
        for (let y = 0; y < H; y++) {
          const src = (y * w + cx) * 4;
          const dst = y * 4;
          slice[dst] = px[src];
          slice[dst + 1] = px[src + 1];
          slice[dst + 2] = px[src + 2];
          slice[dst + 3] = px[src + 3];
        }
        if (p.owner === index) p.ownerTap = p.taps.length;
        p.taps.push(slice);
      }
    }

    // 3) Columns owned by (index - radius) have now seen their last tap.
    const doneOwner = index - this.radius;
    return doneOwner >= 0 ? this.complete(doneOwner) : [];
  }

  // Blend + release everything still pending (owners within the trailing
  // radius after the final frame). Call once after the last onFrame.
  flush(): DenoisedColumn[] {
    const out: DenoisedColumn[] = [];
    const owners = new Set<number>();
    for (const p of this.pending.values()) owners.add(p.owner);
    for (const owner of [...owners].sort((a, b) => a - b)) {
      out.push(...this.complete(owner));
    }
    return out;
  }

  private ownerOf(x: number, lo: number, hi: number): number {
    for (let i = lo; i <= hi; i++) {
      const cols = this.columnsByFrame[i];
      for (let k = 0; k < cols.length; k++) if (cols[k] === x) return i;
    }
    // Unreachable: `want` was built from these frames' column lists.
    throw new Error(`No owner for column ${x} in [${lo}, ${hi}]`);
  }

  private complete(owner: number): DenoisedColumn[] {
    const out: DenoisedColumn[] = [];
    const cols = this.columnsByFrame[owner];
    if (!cols) return out;
    for (let k = 0; k < cols.length; k++) {
      const x = cols[k];
      const p = this.pending.get(x);
      if (!p) continue;
      this.pending.delete(x);
      // ownerTap can be -1 only if frames were skipped; fall back to the
      // middle tap so we still emit something sane.
      const ownerTap =
        p.ownerTap >= 0 ? p.ownerTap : Math.min(p.taps.length - 1, this.radius);
      out.push({ x, data: blendColumn(p.taps, ownerTap, this.strength) });
    }
    return out;
  }
}
