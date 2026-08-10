import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFLICKER_WINDOW,
  GAIN_MAX,
  GAIN_MIN,
  ChannelSmoother,
  StripSmoother,
  meanRgbStrips,
  residualGains,
  smoothSeries,
} from "./deflicker.ts";

function rgba(pixels: Array<[number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  });
  return out;
}

describe("meanRgbStrips", () => {
  it("averages each channel independently within each strip", () => {
    // 2 columns × 4 rows, 2 strips → strip 0 = rows 0-1, strip 1 = rows 2-3.
    const buf = rgba([
      [100, 0, 40], [200, 50, 60], // row 0
      [100, 0, 40], [200, 50, 60], // row 1
      [10, 20, 30], [10, 20, 30], // row 2
      [50, 60, 70], [50, 60, 70], // row 3
    ]);
    const [top, bottom] = meanRgbStrips(buf, 2, 4, 2);
    assert.deepEqual(top, [150, 25, 50]);
    assert.deepEqual(bottom, [30, 40, 50]);
  });

  it("uneven strip boundaries cover every row exactly once", () => {
    // 1 column × 5 rows, 2 strips: floor(y·2/5) puts rows 0-2 in the top
    // strip and rows 3-4 in the bottom one.
    const buf = rgba([[10, 10, 10], [20, 20, 20], [30, 30, 30], [40, 40, 40], [50, 50, 50]]);
    const [top, bottom] = meanRgbStrips(buf, 1, 5, 2);
    assert.equal(top[0], 20);
    assert.equal(bottom[0], 45);
  });

  it("empty buffer gives zeroed strips", () => {
    assert.deepEqual(meanRgbStrips(new Uint8ClampedArray(0), 0, 0, 2), [
      [0, 0, 0],
      [0, 0, 0],
    ]);
  });
});

describe("ChannelSmoother", () => {
  it("first frame passes through with gain 1", () => {
    assert.equal(new ChannelSmoother().next(120), 1);
  });

  it("corrects a single flickered frame back to the running level", () => {
    const s = new ChannelSmoother();
    for (let i = 0; i < 5; i++) s.next(100);
    // A frame 10% too bright gets scaled by ~1/1.1.
    const gain = s.next(110);
    assert.ok(Math.abs(gain - 100 / 110) < 1e-9);
  });

  it("steady input settles at gain 1", () => {
    const s = new ChannelSmoother();
    for (let i = 0; i < 20; i++) s.next(100);
    assert.equal(s.next(100), 1);
  });

  it("alternating flicker is pulled towards the midpoint from both sides", () => {
    const s = new ChannelSmoother();
    // Warm up with the full window of alternating values.
    for (let i = 0; i < DEFLICKER_WINDOW; i++) s.next(i % 2 ? 110 : 90);
    const gLow = s.next(90);
    const gHigh = s.next(110);
    assert.ok(gLow > 1, "dim frame brightened");
    assert.ok(gHigh < 1, "bright frame dimmed");
    // Corrected values land near each other (window mean ≈ 100).
    assert.ok(Math.abs(90 * gLow - 110 * gHigh) < 2);
  });

  it("follows a slow ramp without clamping", () => {
    const s = new ChannelSmoother();
    let gain = 1;
    // Sunset: 0.5% dimmer per frame.
    let mean = 200;
    for (let i = 0; i < 100; i++) {
      gain = s.next(mean);
      mean *= 0.995;
    }
    // Small constant lag-induced gain, but nowhere near the clamp.
    assert.ok(gain > 1 && gain < 1.05);
  });

  it("clamps hard scene changes instead of matching them", () => {
    const s = new ChannelSmoother();
    for (let i = 0; i < 10; i++) s.next(200);
    assert.equal(s.next(10), GAIN_MAX);
    const s2 = new ChannelSmoother();
    for (let i = 0; i < 10; i++) s2.next(20);
    assert.equal(s2.next(250), GAIN_MIN);
  });

  it("an outlier frame only mildly disturbs later frames, then washes out", () => {
    const s = new ChannelSmoother();
    for (let i = 0; i < DEFLICKER_WINDOW; i++) s.next(100);
    s.next(30); // one badly-exposed frame (gets corrected itself)
    // Mean reference: the outlier shifts the next frame's gain by at most
    // (100-30)/(window·100) = 7%, and the shift decays away once the
    // outlier leaves the window.
    const g = s.next(100);
    assert.ok(g < 1 && g > 0.92);
    for (let i = 0; i < DEFLICKER_WINDOW; i++) s.next(100);
    assert.equal(s.next(100), 1);
  });

  it("near-black frames pass through untouched", () => {
    const s = new ChannelSmoother();
    s.next(100);
    assert.equal(s.next(0), 1);
  });
});

describe("smoothSeries", () => {
  it("removes an episode shorter than the median window, keeps the level", () => {
    // 300 flat frames with a 25-frame glare swell of +10.
    const v = Array.from({ length: 300 }, (_, i) =>
      i >= 150 && i < 175 ? 110 : 100,
    );
    const ref = smoothSeries(v);
    for (let i = 100; i < 200; i++) {
      assert.ok(Math.abs(ref[i] - 100) < 0.5, `ref[${i}]=${ref[i]}`);
    }
  });

  it("follows a genuine long trend", () => {
    // Linear sunrise ramp over 400 frames.
    const v = Array.from({ length: 400 }, (_, i) => 80 + i * 0.2);
    const ref = smoothSeries(v);
    for (let i = 60; i < 340; i++) {
      assert.ok(Math.abs(ref[i] - v[i]) < 0.5, `ref[${i}]=${ref[i]}`);
    }
  });
});

describe("residualGains", () => {
  it("targets the smooth trend and divides out the causal gain", () => {
    const n = 300;
    // One strip; a 25-frame +10% swell that the causal pass left alone.
    const rawMeans = Array.from({ length: n }, (_, i) => [
      [i >= 150 && i < 175 ? 110 : 100, 100, 100] as [number, number, number],
    ]);
    const applied = Array.from({ length: n }, () => [
      [1, 1, 1] as [number, number, number],
    ]);
    const res = residualGains(rawMeans, applied);
    // Inside the swell the red channel gets pulled back down ~10%…
    const inSwell = res[160]![0][0];
    assert.ok(Math.abs(inSwell - 100 / 110) < 0.01, `got ${inSwell}`);
    // …and far outside it, frames need no repaint at all.
    assert.equal(res[50], null);
  });

  it("accounts for gains the causal pass already applied", () => {
    const n = 300;
    const rawMeans = Array.from({ length: n }, (_, i) => [
      [i === 150 ? 110 : 100, 100, 100] as [number, number, number],
    ]);
    // Causal pass already fully corrected frame 150.
    const applied = Array.from({ length: n }, (_, i) => [
      [i === 150 ? 100 / 110 : 1, 1, 1] as [number, number, number],
    ]);
    const res = residualGains(rawMeans, applied);
    // Nothing (or almost nothing) left to do on frame 150's red channel.
    const r = res[150] ? res[150][0][0] : 1;
    assert.ok(Math.abs(r - 1) < 0.005, `got ${r}`);
  });
});

describe("StripSmoother", () => {
  it("channels are corrected independently (white-balance flicker)", () => {
    const s = new StripSmoother(1);
    for (let i = 0; i < 5; i++) s.next([[100, 100, 100]]);
    // Warm shift: red up 10%, blue down 10%, green steady.
    const [[gr, gg, gb]] = s.next([[110, 100, 90]]);
    assert.ok(Math.abs(gr - 100 / 110) < 1e-9);
    assert.equal(gg, 1);
    assert.ok(Math.abs(gb - 100 / 90) < 1e-9);
  });

  it("strips are corrected independently (local tone-mapping flicker)", () => {
    const s = new StripSmoother(2);
    for (let i = 0; i < 5; i++) s.next([[200, 200, 200], [50, 50, 50]]);
    // Sky brightens 5%, ground dims 10% — each strip gets its own gain.
    const [sky, ground] = s.next([[210, 210, 210], [45, 45, 45]]);
    assert.ok(Math.abs(sky[0] - 200 / 210) < 1e-9);
    assert.ok(Math.abs(ground[0] - 50 / 45) < 1e-9);
  });
});
