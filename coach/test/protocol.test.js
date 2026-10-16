// node --test test/
// 期待するバイト列は、ファーム側 coach/tests_host/test_coach_proto.c の期待値と同じ（C と JS の両側から同じバイト列で確かめる）。
const test = require("node:test");
const assert = require("node:assert");
const Coach = require("../coach.js");

const METRICS = Uint8Array.from([
  30, 0x01, 0x01, 0x34, 0x12, 0x03, 0x00,
  0x00, 0x00, 0x80, 0x3f, // lateral 1.0
  0x00, 0x00, 0x00, 0xc0, // yaw -2.0
  0x00, 0x00, 0x00, 0x3f, // left 0.5
  0x00, 0x00, 0x00, 0x00, // right 0.0
  0x00, 0x00, 0x80, 0x3f, // total 1.0
  0x00, 0x00, 0x00, 0xc0, // balance -2.0
]);

function lfccFrame(slideFrames) {
  const f = new Uint8Array(1 + 158);
  f[0] = 158; f[1] = 0x02; f[2] = 0x01; f[3] = 7; f[4] = 0; f[5] = 13; f[6] = slideFrames;
  const dv = new DataView(f.buffer);
  for (let i = 0; i < 19; i++) { dv.setFloat32(7 + 4 * i, 1.0, true); dv.setFloat32(7 + 4 * (19 + i), 0.5, true); }
  return f;
}

function collect(chunks) {
  const out = [];
  const p = Coach.createFrameParser((f) => out.push(f));
  for (const c of chunks) p.push(c);
  return { out, parser: p };
}

test("METRICSを読む", () => {
  const { out } = collect([METRICS]);
  assert.strictEqual(out.length, 1);
  const m = out[0];
  assert.strictEqual(m.type, "metrics");
  assert.strictEqual(m.seq, 0x1234);
  assert.ok(m.sliding && m.tared && !m.loadValid && !m.adcSaturated);
  assert.deepStrictEqual([m.lateralRmsG, m.yawRmsDps, m.leftV, m.rightV, m.totalLoadV, m.lrBalance], [1, -2, 0.5, 0, 1, -2]);
});

test("LFCCを読む", () => {
  const { out } = collect([lfccFrame(12)]);
  assert.strictEqual(out[0].type, "lfcc");
  assert.strictEqual(out[0].frames, 13);
  assert.strictEqual(out[0].slideFrames, 12);
  assert.strictEqual(out[0].mean.length, 19);
  assert.ok(out[0].mean.every((v) => v === 1) && out[0].std.every((v) => v === 0.5));
});

test("通知が途中で分かれても連結して読む（MTU 23）", () => {
  const all = new Uint8Array([...METRICS, ...lfccFrame(13), ...METRICS]);
  const chunks = [];
  for (let i = 0; i < all.length; i += 20) chunks.push(all.subarray(i, i + 20));
  const { out } = collect(chunks);
  assert.deepStrictEqual(out.map((f) => f.type), ["metrics", "lfcc", "metrics"]);
});

test("文字列のフレーム", () => {
  const { out } = collect([Uint8Array.from([4, 0x10, 0x01, 0x4f, 0x4b])]);
  assert.deepStrictEqual(out, [{ type: "text", text: "OK" }]);
});

test("壊れたバイトを読み飛ばして、次のフレームから読み直す", () => {
  const { out, parser } = collect([Uint8Array.from([0, 99, 5, 5]), METRICS]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].type, "metrics");
  assert.ok(parser.resyncs >= 1);
});

test("版が違うフレームは捨てる", () => {
  const bad = Uint8Array.from(METRICS);
  bad[2] = 2;
  const { out } = collect([bad]);
  assert.strictEqual(out.length, 0);
});

test("基準からの距離: 基準と同じなら小さく、離れれば大きい", () => {
  const t = Coach.createSurfaceTracker(3);
  const win = (v, slide = 13) => ({ frames: 13, slideFrames: slide, mean: new Array(19).fill(v), std: new Array(19).fill(0) });
  assert.strictEqual(t.push(win(1)), null); // 基準なし
  t.startBaseline();
  assert.strictEqual(t.push(win(1)), null);
  assert.strictEqual(t.push(win(1, 5)), null); // 滑走中が少ない窓は使わない（基準にも入れない）
  assert.ok(t.collecting);
  t.push(win(1));
  t.push(win(1));
  assert.ok(!t.collecting && t.hasBaseline);
  assert.ok(t.push(win(1)) < 1e-9);
  // 基準の標準偏差は0なので、尺度は下限0.3。差0.6なら2.0
  assert.ok(Math.abs(t.push(win(1.6)) - 2.0) < 1e-6);
  assert.strictEqual(t.push(win(1.6, 3)), null);
});
