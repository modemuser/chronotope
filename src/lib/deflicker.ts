// Pure deflicker logic: per-channel mean matching, the standard timelapse
// technique for removing per-frame exposure flicker. Each column of the
// chronotope comes from a different frame, so frame-to-frame jitter
// (auto-exposure hunting, quantised shutter/ISO steps) shows up as
// vertical banding in the output. Scaling every frame so its mean matches
// a sliding-window average of the frames before it removes the
// high-frequency jitter while following genuine slow light changes
// (sunset, clouds) with only a small lag — the same approach as ffmpeg's
// `deflicker` filter, but applied to R, G and B independently: measured
// on real GoPro timelapse footage, about half the banding energy is
// white-balance flicker (channels moving against each other), which a
// luma-only gain cannot touch.
//
// Canvas work stays in render.ts; this module is pure so it can be tested
// under node.

// Frames in the sliding reference window. Big enough to average out
// single-frame flicker, small enough to track a sunset without visibly
// lagging (at 30 fps timelapse playback this is a third of a second).
export const DEFLICKER_WINDOW = 10;

// Clamp for the per-frame gain. A correction outside this range means the
// scene actually changed (lights switched off, hard cut) — matching it
// would smear the change across the window, so let it through instead.
export const GAIN_MIN = 0.5;
export const GAIN_MAX = 2;

// Horizontal strips the frame is divided into for measurement. Action-cam
// local tone mapping flickers each region of the frame independently —
// on real GoPro footage the sky's flicker is nearly uncorrelated with the
// ground's (r ≈ 0.27), so one global gain cannot cancel either. Strips of
// ~1/8 frame height track the vertical structure (sky / horizon / ground)
// while staying big enough that genuine local motion averages out.
export const DEFLICKER_STRIPS = 8;

// Per-strip, per-channel level of an RGBA pixel buffer laid out as
// width × height. Returns strips rows of [r, g, b], each in [0, 255].
// Strip s covers pixel rows [s·height/strips, (s+1)·height/strips).
// The level is the INTERQUARTILE MEAN (mean of the middle half), not
// the plain mean: localized bright content drifting through a strip
// (the sun's disc, a fog wisp) drags a plain mean around and the gain
// then inversely re-prints that content motion as banding. Trimming
// the top and bottom quartile makes the level robust to such outlier
// pixels while still averaging enough samples to resolve gains far
// below the 8-bit pixel step — a plain median would quantise to
// 0.5-luma jumps. (Kept the historical name; callers only care that
// it's a per-strip level.)
// xFrom/xTo restrict the measurement to a horizontal window — the
// chronotope only slices a few columns per frame, and flicker (glare
// especially) can be horizontally localised, so the level that matters
// is the one at the slice position. Consecutive frames slice nearly the
// same region, so genuine spatial gradients cancel out of the temporal
// series. Defaults cover the full width.
export function meanRgbStrips(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  strips: number = DEFLICKER_STRIPS,
  xFrom: number = 0,
  xTo: number = width,
): Array<[number, number, number]> {
  const x0 = Math.max(0, Math.min(width, Math.floor(xFrom)));
  const x1 = Math.max(x0, Math.min(width, Math.ceil(xTo)));
  const out: Array<[number, number, number]> = [];
  for (let s = 0; s < strips; s++) {
    const yFrom = Math.ceil((s * height) / strips);
    // Row y belongs to strip floor(y·strips/height); the strip's rows
    // are exactly those where that floor equals s.
    const level: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const vals: number[] = [];
      for (let y = yFrom; y < height; y++) {
        if (Math.min(strips - 1, Math.floor((y * strips) / height)) !== s) {
          break;
        }
        let o = (y * width + x0) * 4 + c;
        for (let x = x0; x < x1; x++, o += 4) vals.push(rgba[o]);
      }
      if (vals.length === 0) continue;
      vals.sort((a, b) => a - b);
      const lo = vals.length >> 2;
      const hi = vals.length - lo;
      let sum = 0;
      for (let i = lo; i < hi; i++) sum += vals[i];
      level[c] = sum / (hi - lo);
    }
    out.push(level);
  }
  return out;
}

// Feed one channel's raw per-frame means in decode order; get back the
// gain to multiply that channel's pixels by. The reference is the average
// of the previous frames' RAW means (not the corrected ones), so slow
// trends are followed rather than frozen at the first frame's exposure.
// Mean, not median: an outlier frame shifts a mean reference by only
// outlier/window and spreads the disturbance smoothly, whereas a median
// reference flip-flops between window order statistics as outliers enter
// and leave — simulated banding metrics come out 2× worse.
export class ChannelSmoother {
  private window: number[] = [];

  next(mean: number): number {
    let gain = 1;
    if (this.window.length > 0 && mean > 1e-3) {
      let sum = 0;
      for (const m of this.window) sum += m;
      const ref = sum / this.window.length;
      gain = Math.min(GAIN_MAX, Math.max(GAIN_MIN, ref / mean));
    }
    this.window.push(mean);
    if (this.window.length > DEFLICKER_WINDOW) this.window.shift();
    return gain;
  }
}

// Two-pass reference (post-pass): the causal window above can only
// correct flicker shorter than its own length — glare/auto-exposure
// episodes of 15-50 frames (the sun cresting behind trees) sail right
// through it and print as wide bright bands. Once the whole video has
// been measured, a robust trend fit — sliding median (kills episodes up
// to MEDIAN_RADIUS frames, ~1s of video) followed by a sliding mean
// (smooths the median's plateaus) — gives a lag-free reference that
// keeps genuine long light changes like the sunrise itself.
export const DEFLICKER_MEDIAN_RADIUS = 30;
export const DEFLICKER_SMOOTH_RADIUS = 15;

export function smoothSeries(
  values: ArrayLike<number>,
  medianRadius: number = DEFLICKER_MEDIAN_RADIUS,
  meanRadius: number = DEFLICKER_SMOOTH_RADIUS,
): Float64Array {
  const n = values.length;
  const med = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - medianRadius);
    const hi = Math.min(n - 1, i + medianRadius);
    const win: number[] = [];
    for (let j = lo; j <= hi; j++) win.push(values[j]);
    win.sort((a, b) => a - b);
    const m = win.length >> 1;
    med[i] = win.length % 2 ? win[m] : (win[m - 1] + win[m]) / 2;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - meanRadius);
    const hi = Math.min(n - 1, i + meanRadius);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += med[j];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

// Radius (frames) of the centred mean applied to the LOCAL excess before
// it is corrected. Glare episodes span 15-50 frames and survive a ±2
// smoothing intact; single-frame level noise from content drifting
// through the local window (tree branches, fog wisps) is white in time
// and gets averaged down ~√5 instead of being re-printed as banding.
export const EXCESS_SMOOTH_RADIUS = 2;

// For each frame/strip/channel: the gain that takes the pixels as
// already corrected by the causal pass (applied[i]) to the two-pass
// target. The target combines two separately-validated components:
//   - the GLOBAL deviation (full-width strip levels vs their smooth
//     trend): exposure / white-balance flicker. Corrected per frame with
//     no temporal smoothing — full-width averaging already makes the
//     measurement content-noise-robust, and real flicker is often
//     single-frame.
//   - the LOCAL EXCESS (slice-window deviation minus the global one):
//     lens glare around the slice position. Corrected only after a
//     centred ±EXCESS_SMOOTH_RADIUS mean, so temporally-coherent glare
//     episodes are removed while frame-to-frame content noise in the
//     small window shrinks toward zero.
// On footage with no flicker at all both components vanish and the
// output stays raw — the correction cannot inject banding of its own.
// Returns null for frames whose residual is negligible everywhere
// (callers skip repainting those).
export function residualGains(
  globalMeans: Array<Array<[number, number, number]>>,
  localMeans: Array<Array<[number, number, number]>>,
  applied: Array<Array<[number, number, number]>>,
): Array<Array<[number, number, number]> | null> {
  const nFrames = globalMeans.length;
  if (nFrames === 0) return [];
  const nStrips = globalMeans[0].length;
  const out: Array<Array<[number, number, number]> | null> = Array.from(
    { length: nFrames },
    () => null,
  );
  for (let s = 0; s < nStrips; s++) {
    for (let c = 0; c < 3; c++) {
      const g = globalMeans.map((f) => f[s][c]);
      const l = localMeans.map((f) => f[s][c]);
      const refG = smoothSeries(g);
      const refL = smoothSeries(l);
      // Local excess in log space: what the slice window saw beyond the
      // full-frame deviation.
      const e = new Float64Array(nFrames);
      for (let i = 0; i < nFrames; i++) {
        if (g[i] > 1e-3 && l[i] > 1e-3 && refG[i] > 1e-3 && refL[i] > 1e-3) {
          e[i] = Math.log(l[i] / refL[i]) - Math.log(g[i] / refG[i]);
        }
      }
      for (let i = 0; i < nFrames; i++) {
        const lo = Math.max(0, i - EXCESS_SMOOTH_RADIUS);
        const hi = Math.min(nFrames - 1, i + EXCESS_SMOOTH_RADIUS);
        let sum = 0;
        for (let j = lo; j <= hi; j++) sum += e[j];
        const eHat = sum / (hi - lo + 1);
        const target =
          g[i] > 1e-3
            ? Math.min(
                GAIN_MAX,
                Math.max(GAIN_MIN, (refG[i] / g[i]) * Math.exp(-eHat)),
              )
            : 1;
        const r = target / applied[i][s][c];
        if (out[i] === null && Math.abs(r - 1) < 1e-4) continue;
        if (out[i] === null) {
          out[i] = Array.from({ length: nStrips }, () => [1, 1, 1]);
        }
        out[i]![s][c] = r;
      }
    }
  }
  return out;
}

// A ChannelSmoother per strip per RGB channel: feed the meanRgbStrips
// grid, get back the same-shaped grid of gains.
export class StripSmoother {
  private strips: ChannelSmoother[][];

  constructor(strips: number = DEFLICKER_STRIPS) {
    this.strips = Array.from({ length: strips }, () => [
      new ChannelSmoother(),
      new ChannelSmoother(),
      new ChannelSmoother(),
    ]);
  }

  next(
    means: Array<[number, number, number]>,
  ): Array<[number, number, number]> {
    return means.map((rgb, s) => [
      this.strips[s][0].next(rgb[0]),
      this.strips[s][1].next(rgb[1]),
      this.strips[s][2].next(rgb[2]),
    ]);
  }
}
