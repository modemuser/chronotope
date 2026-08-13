import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DENOISE_RADIUS,
  DENOISE_STRENGTH,
  TemporalColumnDenoiser,
  blendColumn,
  tapWeight,
} from "./denoise.ts";
import { columnsForFrame, frameForColumn } from "./chronotope.ts";

// One-pixel RGBA column with the given grey level.
function greyCol(v: number): Uint8ClampedArray {
  return Uint8ClampedArray.from([v, v, v, 255]);
}

describe("tapWeight", () => {
  it("is ~1 for differences well inside the noise band", () => {
    assert.ok(tapWeight(0, 8) === 1);
    assert.ok(tapWeight(2, 8) > 0.98);
  });

  it("falls off hard beyond the strength threshold", () => {
    assert.ok(tapWeight(8, 8) === 0.5); // knee: x = 1
    assert.ok(tapWeight(32, 8) < 0.02); // real edges barely count
  });

  it("is symmetric in the sign of the difference", () => {
    assert.equal(tapWeight(-5, 8), tapWeight(5, 8));
  });
});

describe("blendColumn", () => {
  it("averages small (noise-like) deviations towards the mean", () => {
    const taps = [greyCol(98), greyCol(104), greyCol(101)];
    const out = blendColumn(taps, 1, DENOISE_STRENGTH);
    // Owner is 104; noisy neighbours pull it towards ~101.
    assert.ok(out[0] > 99 && out[0] < 104);
  });

  it("keeps the owner pixel when neighbours differ strongly (motion)", () => {
    const taps = [greyCol(20), greyCol(200), greyCol(30)];
    const out = blendColumn(taps, 1, DENOISE_STRENGTH);
    // Differences of ~180 get ~zero weight — the edge must not bleed.
    assert.ok(Math.abs(out[0] - 200) < 2);
  });

  it("treats channels independently", () => {
    const owner = Uint8ClampedArray.from([100, 100, 100, 255]);
    // Red close (noise), green far (motion) — only red should move.
    const nb = Uint8ClampedArray.from([104, 220, 100, 255]);
    const out = blendColumn([nb, owner], 1, DENOISE_STRENGTH);
    assert.ok(out[0] > 100 && out[0] < 104); // red blended
    assert.ok(Math.abs(out[1] - 100) < 2); // green kept
    assert.equal(out[2], 100); // blue identical anyway
  });

  it("copies alpha from the owner", () => {
    const owner = Uint8ClampedArray.from([50, 50, 50, 255]);
    const nb = Uint8ClampedArray.from([52, 52, 52, 128]);
    const out = blendColumn([nb, owner], 1, DENOISE_STRENGTH);
    assert.equal(out[3], 255);
  });
});

describe("TemporalColumnDenoiser", () => {
  // Small linear mapping: width 12, 6 frames → 2 columns per frame.
  const WIDTH = 12;
  const N = 6;
  const HEIGHT = 1;

  function makeDenoiser() {
    const fmap = frameForColumn(WIDTH, N);
    const byFrame = columnsForFrame(fmap, N);
    return { d: new TemporalColumnDenoiser(byFrame, HEIGHT), byFrame };
  }

  // A frame reader where every pixel of frame f has grey level v(f).
  function flatReader(v: number) {
    return (x0: number, w: number) => {
      const out = new Uint8ClampedArray(w * HEIGHT * 4);
      for (let i = 0; i < w * HEIGHT; i++) {
        out[i * 4] = v;
        out[i * 4 + 1] = v;
        out[i * 4 + 2] = v;
        out[i * 4 + 3] = 255;
      }
      return out;
    };
  }

  it("emits every column exactly once, after its closing tap", () => {
    const { d } = makeDenoiser();
    const seen = new Set<number>();
    for (let f = 0; f < N; f++) {
      for (const col of d.onFrame(f, flatReader(100))) {
        assert.ok(!seen.has(col.x), `column ${col.x} emitted twice`);
        seen.add(col.x);
      }
    }
    for (const col of d.flush()) {
      assert.ok(!seen.has(col.x), `column ${col.x} emitted twice (flush)`);
      seen.add(col.x);
    }
    assert.equal(seen.size, WIDTH);
  });

  it("no column is finalised before owner + radius has been fed", () => {
    const { d, byFrame } = makeDenoiser();
    for (let f = 0; f < N; f++) {
      for (const col of d.onFrame(f, flatReader(100))) {
        // Owner of an emitted column must be at least radius behind.
        let owner = -1;
        byFrame.forEach((cols, i) => {
          if (cols.includes(col.x)) owner = i;
        });
        assert.ok(
          owner <= f - DENOISE_RADIUS ||
            // ...unless the video is shorter than the window.
            N - 1 - owner < DENOISE_RADIUS,
        );
      }
    }
  });

  it("static scene with per-frame noise converges towards the mean", () => {
    const { d } = makeDenoiser();
    const levels = [100, 106, 94, 103, 97, 100]; // mean 100, ±6 jitter
    const emitted: number[] = [];
    for (let f = 0; f < N; f++) {
      for (const col of d.onFrame(f, flatReader(levels[f]))) {
        emitted.push(col.data[0]);
      }
    }
    for (const col of d.flush()) emitted.push(col.data[0]);
    assert.equal(emitted.length, WIDTH);
    // Every output level must sit strictly inside the jitter range and
    // closer to the mean than the worst-case input.
    for (const v of emitted) {
      assert.ok(v > 95 && v < 105, `level ${v} not denoised`);
    }
  });

  it("a hard scene cut does not bleed across the edge", () => {
    const { d, byFrame } = makeDenoiser();
    // Frames 0-2 dark, frames 3-5 bright: a real edge, not noise.
    const emitted = new Map<number, number>();
    for (let f = 0; f < N; f++) {
      const v = f < 3 ? 20 : 220;
      for (const col of d.onFrame(f, flatReader(v))) {
        emitted.set(col.x, col.data[0]);
      }
    }
    for (const col of d.flush()) emitted.set(col.x, col.data[0]);
    for (const [x, v] of emitted) {
      let owner = -1;
      byFrame.forEach((cols, i) => {
        if (cols.includes(x)) owner = i;
      });
      const expected = owner < 3 ? 20 : 220;
      assert.ok(
        Math.abs(v - expected) < 3,
        `column ${x} (owner ${owner}) bled: ${v} vs ${expected}`,
      );
    }
  });
});
