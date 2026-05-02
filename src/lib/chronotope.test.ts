import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { frameForColumn } from "./chronotope.ts";

describe("frameForColumn", () => {
  it("linear default matches the original (W-1)→(N-1) ramp", () => {
    const W = 800;
    const N = 240;
    const fmap = frameForColumn(W, N);
    assert.equal(fmap.length, W);
    for (let x = 0; x < W; x++) {
      assert.equal(fmap[x], Math.round((x * (N - 1)) / (W - 1)));
    }
    assert.equal(fmap[0], 0);
    assert.equal(fmap[W - 1], N - 1);
  });

  it("linear + reverse matches the original reversed ramp", () => {
    const W = 800;
    const N = 240;
    const fmap = frameForColumn(W, N, { reverse: true });
    for (let x = 0; x < W; x++) {
      assert.equal(fmap[x], Math.round(((W - 1 - x) * (N - 1)) / (W - 1)));
    }
  });

  it("linear + steps matches the original chunked formula (byte-identical)", () => {
    const W = 800;
    const N = 240;
    const s = 24;
    const fmap = frameForColumn(W, N, { steps: s });
    const chunkDenom = s - 1;
    const span = N - 1;
    for (let x = 0; x < W; x++) {
      const chunk = Math.min(s - 1, Math.floor((x * s) / W));
      const expected = Math.round((chunk * span) / chunkDenom);
      assert.equal(fmap[x], expected);
    }
  });

  it("v + pivot 0.5 + reverse: edges → frame 0, centre → frame N-1", () => {
    const W = 801; // odd so there's an exact centre column
    const N = 100;
    const fmap = frameForColumn(W, N, {
      shape: "v",
      pivot: 0.5,
      reverse: true,
    });
    assert.equal(fmap[0], 0);
    assert.equal(fmap[W - 1], 0);
    assert.equal(fmap[(W - 1) / 2], N - 1);
  });

  it("parabola edges match V; midway-to-edge is later than V", () => {
    const W = 801;
    const N = 100;
    const v = frameForColumn(W, N, {
      shape: "v",
      pivot: 0.5,
      reverse: true,
    });
    const p = frameForColumn(W, N, {
      shape: "parabola",
      pivot: 0.5,
      reverse: true,
    });
    // Same edge frames as V.
    assert.equal(p[0], v[0]);
    assert.equal(p[W - 1], v[W - 1]);
    assert.equal(p[(W - 1) / 2], v[(W - 1) / 2]);
    // Halfway between centre and the right edge: t² < t for t ∈ (0, 1),
    // and reverse flips to (1 - t²) > (1 - t), so parabola yields a later
    // frame than V at the same column.
    const xMid = Math.round(((W - 1) / 2 + (W - 1)) / 2);
    assert.ok(
      p[xMid] > v[xMid],
      `expected parabola[${xMid}]=${p[xMid]} > v[${xMid}]=${v[xMid]}`,
    );
  });

  it("v with off-centre pivot still hits t=1 at both edges", () => {
    const W = 1000;
    const N = 200;
    // Forward (no reverse): apex = first frame, edges = last frame.
    const fmap = frameForColumn(W, N, { shape: "v", pivot: 0.3 });
    assert.equal(fmap[0], N - 1);
    assert.equal(fmap[W - 1], N - 1);
    // Apex column ≈ pivot * (W - 1) → frame 0.
    const apex = Math.round(0.3 * (W - 1));
    assert.equal(fmap[apex], 0);
  });
});
