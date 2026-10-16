/* 依存なしの折れ線グラフ（canvas）。滑走中の区間を薄く塗り、基準線を引ける。 */
(function (root) {
  "use strict";

  /*
   * canvas:  描画先
   * o.values: 数値の配列（古い順。nullは線を切る）
   * o.sliding: 同じ長さの真偽値の配列（任意。trueの区間を塗る）
   * o.yMin, o.yMax: 縦軸の範囲（省略すると値から決める。yMinは0以上のときだけ0に揃える）
   * o.refs: [{y, label}]（基準線）
   * o.color, o.unit
   */
  function drawLine(canvas, o) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
    if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
    const g = canvas.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(canvas);
    const fg = css.getPropertyValue("--fg").trim() || "#222";
    const grid = css.getPropertyValue("--grid").trim() || "#8884";
    const shade = css.getPropertyValue("--shade").trim() || "#4a90d922";
    const line = o.color || css.getPropertyValue("--accent").trim() || "#2a6fdb";

    const padL = 44, padR = 8, padT = 8, padB = 8;
    const vals = o.values;
    const finite = vals.filter((v) => v !== null && Number.isFinite(v));
    let lo = o.yMin !== undefined ? o.yMin : finite.length ? Math.min(...finite) : 0;
    let hi = o.yMax !== undefined ? o.yMax : finite.length ? Math.max(...finite) : 1;
    for (const r of o.refs || []) {
      if (o.yMax === undefined) hi = Math.max(hi, r.y * 1.1);
    }
    if (o.yMin === undefined && lo > 0) lo = 0;
    if (hi - lo < 1e-9) hi = lo + 1;
    const x = (i) => padL + ((w - padL - padR) * i) / Math.max(1, vals.length - 1);
    const y = (v) => padT + (h - padT - padB) * (1 - (v - lo) / (hi - lo));

    if (o.sliding) {
      g.fillStyle = shade;
      let start = -1;
      for (let i = 0; i <= o.sliding.length; i++) {
        const on = i < o.sliding.length && o.sliding[i];
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          g.fillRect(x(start), padT, Math.max(1, x(i - 1) - x(start)), h - padT - padB);
          start = -1;
        }
      }
    }

    g.font = "11px system-ui, sans-serif";
    g.textBaseline = "middle";
    g.fillStyle = fg;
    g.strokeStyle = grid;
    g.lineWidth = 1;
    for (const t of [lo, (lo + hi) / 2, hi]) {
      g.beginPath();
      g.moveTo(padL, y(t));
      g.lineTo(w - padR, y(t));
      g.stroke();
      g.fillText(Math.abs(t) >= 100 ? t.toFixed(0) : Math.abs(t) >= 1 ? t.toFixed(1) : t.toFixed(2), 4, y(t));
    }
    g.setLineDash([5, 4]);
    for (const r of o.refs || []) {
      if (r.y < lo || r.y > hi) continue;
      g.strokeStyle = fg;
      g.globalAlpha = 0.6;
      g.beginPath();
      g.moveTo(padL, y(r.y));
      g.lineTo(w - padR, y(r.y));
      g.stroke();
      g.globalAlpha = 1;
      g.textAlign = "right";
      g.fillText(r.label, w - padR - 2, y(r.y) - 7);
      g.textAlign = "left";
    }
    g.setLineDash([]);

    g.strokeStyle = line;
    g.lineWidth = 2;
    g.lineJoin = "round";
    g.beginPath();
    let pen = false;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        continue;
      }
      if (!pen) g.moveTo(x(i), y(v));
      else g.lineTo(x(i), y(v));
      pen = true;
    }
    g.stroke();
  }

  root.CoachChart = { drawLine };
})(self);
