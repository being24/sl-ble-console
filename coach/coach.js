/*
 * 指導用ファーム（slider_sensors の coach/）のBLEパケットの読み取りと、指標の状態管理。
 * 形式は slider_sensors の docs/coach_protocol.md。ブラウザでもNodeでも動く（Web Bluetoothに依存しない）。
 *
 * フレーム = [長さ u8（以降のバイト数）][種類 u8][版 u8][本文]、数値はリトルエンディアン、小数はfloat32。
 * 受け側は通知をまたいで連結する（MTUが小さいと1フレームが複数の通知に分かれる）。
 */
(function (root) {
  "use strict";

  const PROTO_VERSION = 1;
  const TYPE_METRICS = 0x01;
  const TYPE_LFCC = 0x02;
  const TYPE_TEXT = 0x10;
  const METRICS_BODY = 30; // 種類・版を含む
  const LFCC_BODY = 158;
  const NCOEF = 19;

  const FLAG_SLIDING = 1 << 0;
  const FLAG_TARED = 1 << 1;
  const FLAG_LOAD_VALID = 1 << 2;
  const FLAG_ADC_SATURATED = 1 << 3;
  const FLAG_RECORDING = 1 << 4; // 台のSDに記録中（Sで始めた20秒の間）

  function f32(view, off) {
    return view.getFloat32(off, true);
  }

  function decodeMetrics(body) {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const flags = body[4];
    return {
      type: "metrics",
      seq: v.getUint16(2, true),
      flags,
      sliding: !!(flags & FLAG_SLIDING),
      tared: !!(flags & FLAG_TARED),
      loadValid: !!(flags & FLAG_LOAD_VALID),
      adcSaturated: !!(flags & FLAG_ADC_SATURATED),
      recording: !!(flags & FLAG_RECORDING),
      lateralRmsG: f32(v, 6),
      yawRmsDps: f32(v, 10),
      leftV: f32(v, 14),
      rightV: f32(v, 18),
      totalLoadV: f32(v, 22),
      lrBalance: f32(v, 26),
    };
  }

  function decodeLfcc(body) {
    const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const mean = [];
    const std = [];
    for (let i = 0; i < NCOEF; i++) {
      mean.push(f32(v, 6 + 4 * i));
      std.push(f32(v, 6 + 4 * (NCOEF + i)));
    }
    return { type: "lfcc", seq: v.getUint16(2, true), frames: body[4], slideFrames: body[5], mean, std };
  }

  function decodeFrame(body) {
    if (body.length < 2 || body[1] !== PROTO_VERSION) return null;
    if (body[0] === TYPE_METRICS && body.length === METRICS_BODY) return decodeMetrics(body);
    if (body[0] === TYPE_LFCC && body.length === LFCC_BODY) return decodeLfcc(body);
    if (body[0] === TYPE_TEXT) return { type: "text", text: new TextDecoder().decode(body.subarray(2)) };
    return null;
  }

  const TEXT_BODY_MAX = 100; // ファームの文字列フレームは96バイト以下

  function plausible(type, len) {
    if (type === TYPE_METRICS) return len === METRICS_BODY;
    if (type === TYPE_LFCC) return len === LFCC_BODY;
    if (type === TYPE_TEXT) return len >= 2 && len <= TEXT_BODY_MAX;
    return false;
  }

  /* 通知のバイト列を渡すと、完成したフレームごとに onFrame(フレーム) を呼ぶ。壊れたら1バイト進めて探し直す。 */
  function createFrameParser(onFrame) {
    let buf = new Uint8Array(0);
    let resyncs = 0;
    return {
      push(chunk) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf, 0);
        merged.set(chunk, buf.length);
        buf = merged;
        for (;;) {
          if (buf.length < 1) return;
          const len = buf[0];
          if (len === 0) {
            buf = buf.subarray(1);
            resyncs++;
            continue;
          }
          // 種類のバイトが読めたら、長さの整合を先に確かめる。壊れた長さを待ち続けないため。
          if (buf.length >= 2 && !plausible(buf[1], len)) {
            buf = buf.subarray(1);
            resyncs++;
            continue;
          }
          if (buf.length < 1 + len) return;
          const frame = decodeFrame(buf.subarray(1, 1 + len));
          if (frame === null) {
            buf = buf.subarray(1);
            resyncs++;
            continue;
          }
          buf = buf.subarray(1 + len);
          onFrame(frame);
        }
      },
      get resyncs() {
        return resyncs;
      },
    };
  }

  /*
   * 氷の表面の「基準からの距離（参考）」。基準を取る間（滑走中の窓だけ）のLFCCの平均を基準にして、
   * その後の窓が、基準からどれだけ離れたかを、係数ごとの尺度（基準の標準偏差、ただし下限あり）で割って、
   * 二乗平均の平方根にする。氷の種類の分類はしない（人をまたぐ精度が弱いため。slider_sensors の 20_survey.md）。
   */
  const SCALE_FLOOR = 0.3; // LFCCの窓の平均が、同じ氷・同じ人で揺れる大きさの目安（中央値の小さい方）
  const MIN_SLIDE_RATIO = 0.7; // 窓のうち滑走中だったフレームの割合がこれ未満の窓は使わない

  function createSurfaceTracker(baselineWindows) {
    const need = baselineWindows || 8;
    let collecting = false;
    let samples = [];
    let base = null;
    return {
      startBaseline() {
        collecting = true;
        samples = [];
        base = null;
      },
      get collecting() {
        return collecting;
      },
      get progress() {
        return collecting ? samples.length / need : base ? 1 : 0;
      },
      get hasBaseline() {
        return base !== null;
      },
      /* 使えた窓なら、基準からの距離（基準取得中・基準なしならnull）を返す。 */
      push(lfcc) {
        if (lfcc.frames === 0 || lfcc.slideFrames / lfcc.frames < MIN_SLIDE_RATIO) return null;
        if (collecting) {
          samples.push(lfcc.mean);
          if (samples.length >= need) {
            const mu = lfcc.mean.map((_, i) => samples.reduce((s, m) => s + m[i], 0) / samples.length);
            const sd = lfcc.mean.map((_, i) =>
              Math.max(SCALE_FLOOR, Math.sqrt(samples.reduce((s, m) => s + (m[i] - mu[i]) ** 2, 0) / samples.length))
            );
            base = { mu, sd };
            collecting = false;
          }
          return null;
        }
        if (!base) return null;
        let acc = 0;
        for (let i = 0; i < lfcc.mean.length; i++) acc += ((lfcc.mean[i] - base.mu[i]) / base.sd[i]) ** 2;
        return Math.sqrt(acc / lfcc.mean.length);
      },
    };
  }

  /* グラフの履歴（系列ごとの配列）を、全部空にする。配列そのものは、そのまま使い続ける。 */
  function clearHistory(hist) {
    for (const k of Object.keys(hist)) hist[k].length = 0;
  }

  const api = {
    PROTO_VERSION, NCOEF, createFrameParser, createSurfaceTracker, decodeFrame, clearHistory,
    SCALE_FLOOR, MIN_SLIDE_RATIO,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Coach = api;
})(typeof self !== "undefined" ? self : this);
