/* 画面の制御。BLE（Web Bluetooth）の接続、フレームの受信、グラフ、CSV保存、デモ。 */
(function () {
  "use strict";

  const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
  const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"; // 画面→台（書き込み）
  const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"; // 台→画面（通知）
  const HISTORY = 1200; // 20Hzで60秒
  // 2026-10-14 のUsed 83本（slider_sensors_analytics_v2 の src/v3/1.3-wobble_check.py）の、横の加速度Xの中央値。参考値。
  const LATERAL_REFS = [
    { y: 0.051, label: "経験者の中央値 0.05" },
    { y: 0.139, label: "初心者の中央値 0.14" },
  ];

  const $ = (id) => document.getElementById(id);
  const hist = { lr: [], lat: [], yaw: [], load: [], surf: [], sliding: [], surfSliding: [] };
  const rows = []; // CSV用
  const tracker = Coach.createSurfaceTracker(8);
  let parser = null;
  let characteristicRx = null;
  let device = null;
  let t0 = 0;
  let lastSeq = null;
  let received = 0;
  let lost = 0;
  let demoTimer = null;
  let lastSurf = null;
  let dirty = true;
  // 動画: 撮影中は、動画の時刻（撮影開始からの ms）ごとに、同じフレームの系列を取っておく。再生中はこれをグラフに出す
  const clipHist = Object.fromEntries(Object.keys(hist).map((k) => [k, []]));
  const clipTimes = [];
  const clipFrames = [];
  const REPLAY_POINTS = 400; // 再生中に出す窓（20Hzで20秒）
  let stream = null;
  let recorder = null;
  let clipStart = null; // 撮影が実際に始まった時刻（performance.now）。nullなら撮影していない
  let videoBlob = null;
  let replay = false;

  function push(arr, v) {
    arr.push(v);
    if (arr.length > HISTORY) arr.shift();
  }

  function onFrame(f) {
    if (f.type === "metrics") {
      if (lastSeq !== null) lost += (f.seq - lastSeq - 1 + 65536) % 65536;
      lastSeq = f.seq;
      received++;
      push(hist.lr, f.loadValid ? f.lrBalance : null);
      push(hist.lat, f.lateralRmsG);
      push(hist.yaw, f.yawRmsDps);
      push(hist.load, f.totalLoadV);
      push(hist.sliding, f.sliding);
      push(hist.surf, lastSurf);
      rows.push([Math.round(performance.now() - t0), f.seq, f.sliding ? 1 : 0, f.tared ? 1 : 0, f.loadValid ? 1 : 0,
        f.adcSaturated ? 1 : 0, f.recording ? 1 : 0, f.lateralRmsG, f.yawRmsDps, f.leftV, f.rightV, f.totalLoadV, f.lrBalance,
        lastSurf === null ? "" : lastSurf].join(","));
      ui.latest = f;
      if (clipStart !== null) {
        clipTimes.push(performance.now() - clipStart);
        clipFrames.push(f);
        for (const k of Object.keys(clipHist)) clipHist[k].push(hist[k][hist[k].length - 1]);
      }
      dirty = true;
    } else if (f.type === "lfcc") {
      const d = tracker.push(f);
      if (d !== null) lastSurf = d;
      ui.surfCollecting = tracker.collecting;
      ui.surfProgress = tracker.progress;
      dirty = true;
    } else if (f.type === "text") {
      $("log").textContent = "台: " + f.text;
    }
  }

  const ui = { latest: null, surfCollecting: false, surfProgress: 0 };

  function fmt(v, n) {
    return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(n);
  }

  function render() {
    requestAnimationFrame(render);
    if (replay) dirty = true; // 再生位置は、フレームごとに変わる
    if (!dirty) return;
    dirty = false;
    let h = hist;
    let f = ui.latest;
    if (replay) {
      const n = Coach.lastIndexAtOrBefore(clipTimes, $("cam").currentTime * 1000);
      const from = Math.max(0, n - REPLAY_POINTS + 1);
      h = Object.fromEntries(Object.keys(clipHist).map((k) => [k, clipHist[k].slice(from, n + 1)]));
      f = n >= 0 ? clipFrames[n] : null;
    }
    if (f) {
      $("lrVal").textContent = f.loadValid ? (f.lrBalance >= 0 ? "右 " : "左 ") + Math.abs(f.lrBalance * 100).toFixed(0) + "%" : "—";
      $("barDot").style.left = (f.loadValid ? 50 + 50 * Math.max(-1, Math.min(1, f.lrBalance)) : 50) + "%";
      $("loadBadge").textContent = f.loadValid ? "荷重あり" : "荷重なし";
      $("loadBadge").className = "badge" + (f.loadValid ? " on" : "");
      $("latVal").textContent = fmt(f.lateralRmsG, 3);
      $("yawVal").textContent = fmt(f.yawRmsDps, 1);
      $("loadVal").textContent = fmt(f.totalLoadV, 3);
      $("slideBadge").textContent = f.sliding ? "滑走中" : "静止";
      $("slideBadge").className = "badge" + (f.sliding ? " on" : "");
      $("recBadge").textContent = f.recording ? "SD に記録中" : "SD 未記録";
      $("recBadge").className = "badge" + (f.recording ? " warn" : "");
      $("satBadge").textContent = f.adcSaturated ? "頭打ち" : f.tared ? "0点合わせ済み" : "0点合わせ前";
      $("satBadge").className = "badge" + (f.adcSaturated ? " warn" : f.tared ? " on" : "");
    }
    $("surfVal").textContent = fmt(lastSurf, 2);
    $("surfBadge").textContent = ui.surfCollecting ? `基準を取得中 ${Math.round(ui.surfProgress * 100)}%` : tracker.hasBaseline ? "基準あり" : "基準なし";
    $("surfBadge").className = "badge" + (ui.surfCollecting ? " warn" : tracker.hasBaseline ? " on" : "");
    $("stats").textContent = `受信 ${received}、欠落 ${lost}、読み直し ${parser ? parser.resyncs : 0}`;
    CoachChart.drawLine($("cLr"), { values: h.lr, sliding: h.sliding, yMin: -1, yMax: 1, refs: [{ y: 0, label: "" }] });
    CoachChart.drawLine($("cLat"), { values: h.lat, sliding: h.sliding, yMin: 0, refs: LATERAL_REFS });
    CoachChart.drawLine($("cYaw"), { values: h.yaw, sliding: h.sliding, yMin: 0 });
    CoachChart.drawLine($("cLoad"), { values: h.load, sliding: h.sliding, yMin: 0 });
    CoachChart.drawLine($("cSurf"), { values: h.surf, sliding: h.sliding, yMin: 0 });
  }

  async function toggleCamera() {
    if (stream) {
      if (recorder) recorder.stop();
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      replay = false;
      $("videoBox").hidden = true;
      $("vidRec").disabled = true;
      $("vidLive").hidden = true;
      $("vidSave").hidden = true;
      $("camBtn").textContent = "カメラ";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (e) {
      $("log").textContent = "カメラを開けません: " + (e && e.message ? e.message : e);
      return;
    }
    $("videoBox").hidden = false;
    $("vidRec").disabled = false;
    $("camBtn").textContent = "カメラを閉じる";
    showLive();
  }

  function showLive() {
    const v = $("cam");
    replay = false;
    v.removeAttribute("src");
    v.srcObject = stream;
    v.controls = false;
    v.muted = true;
    v.play();
    $("vidBadge").textContent = "ライブ";
    $("vidBadge").className = "badge";
    $("vidLive").hidden = true;
    dirty = true;
  }

  function toggleVideo() {
    if (recorder) {
      recorder.stop();
      return;
    }
    if (!stream || typeof MediaRecorder === "undefined") {
      $("log").textContent = "このブラウザは動画の撮影に対応していません";
      return;
    }
    const chunks = [];
    clipTimes.length = 0;
    clipFrames.length = 0;
    Coach.clearHistory(clipHist);
    const rec = new MediaRecorder(stream);
    recorder = rec;
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstart = () => (clipStart = performance.now());
    rec.onstop = () => {
      clipStart = null;
      recorder = null;
      $("vidRec").textContent = "動画を撮る";
      if (!chunks.length || !stream) return;
      videoBlob = new Blob(chunks, { type: rec.mimeType });
      const v = $("cam");
      v.srcObject = null;
      v.src = URL.createObjectURL(videoBlob);
      v.controls = true;
      v.muted = false;
      replay = true;
      $("vidBadge").textContent = "再生（グラフは動画の時刻）";
      $("vidBadge").className = "badge warn";
      $("vidLive").hidden = false;
      $("vidSave").hidden = false;
    };
    rec.start();
    $("vidRec").textContent = "撮影停止";
    $("vidBadge").textContent = "撮影中";
    $("vidBadge").className = "badge warn";
  }

  function saveVideo() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(videoBlob);
    a.download = "coach_" + new Date().toISOString().replace(/[:.]/g, "-") + (videoBlob.type.includes("mp4") ? ".mp4" : ".webm");
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function setConnected(on, text) {
    $("status").textContent = text;
    for (const id of ["tare", "rec", "recStop", "baseline", "csv"]) $(id).disabled = !on && id !== "csv";
    $("csv").disabled = rows.length === 0;
    $("connect").textContent = on ? "切断" : "接続";
  }

  function reset() {
    for (const k of Object.keys(hist)) hist[k].length = 0;
    rows.length = 0;
    lastSeq = null;
    received = 0;
    lost = 0;
    lastSurf = null;
    t0 = performance.now();
    parser = Coach.createFrameParser(onFrame);
  }

  async function connect() {
    if (device && device.gatt.connected) {
      device.gatt.disconnect();
      return;
    }
    if (!navigator.bluetooth) {
      $("status").textContent = "このブラウザはWeb Bluetoothに対応していません（Android・PCのChrome、iPadはBluefy）";
      return;
    }
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "COACH" }],
        optionalServices: [NUS_SERVICE],
      });
      device.addEventListener("gattserverdisconnected", () => setConnected(false, "切断されました"));
      $("status").textContent = "接続中…";
      const server = await device.gatt.connect();
      const service = await server.getPrimaryService(NUS_SERVICE);
      const tx = await service.getCharacteristic(NUS_TX);
      characteristicRx = await service.getCharacteristic(NUS_RX);
      reset();
      tx.addEventListener("characteristicvaluechanged", (e) => {
        const dv = e.target.value;
        parser.push(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      });
      await tx.startNotifications();
      setConnected(true, `接続中: ${device.name}`);
      // 台のSDに残るファイルの作成・更新日時のために、いまの日時を送る（記録用の操作ページと同じ形式）
      send("T " + Math.floor(Date.now() / 1000) + " " + -new Date().getTimezoneOffset());
    } catch (e) {
      setConnected(false, "接続できませんでした: " + (e && e.message ? e.message : e));
    }
  }

  async function send(cmd) {
    if (!characteristicRx) return;
    const data = new TextEncoder().encode(cmd);
    try {
      if (characteristicRx.writeValueWithoutResponse) await characteristicRx.writeValueWithoutResponse(data);
      else await characteristicRx.writeValue(data);
    } catch (e) {
      $("log").textContent = "送信に失敗: " + (e && e.message ? e.message : e);
    }
  }

  function saveCsv() {
    const head = "t_ms,seq,sliding,tared,load_valid,adc_saturated,sd_recording,lateral_rms_g,yaw_rms_dps,left_v,right_v,total_load_v,lr_balance,surface_distance";
    const blob = new Blob([head + "\n" + rows.join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "coach_" + new Date().toISOString().replace(/[:.]/g, "-") + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* 台が無くても見た目を確かめるためのデモ。実機と同じ形のフレームオブジェクトを流す。 */
  function demo() {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
      $("demo").textContent = "デモ";
      setConnected(false, "未接続");
      return;
    }
    reset();
    let n = 0;
    let seq = 0;
    let lfccSeq = 0;
    demoTimer = setInterval(() => {
      const t = n / 20;
      const cycle = t % 14;
      const sliding = cycle > 3 && cycle < 11;
      const lat = sliding ? 0.06 + 0.05 * Math.abs(Math.sin(t * 0.9)) + (t > 40 ? 0.05 : 0) : 0.002;
      const left = sliding ? 0.12 + 0.03 * Math.sin(t * 1.3) : 0.0005;
      const right = sliding ? 0.2 + 0.03 * Math.cos(t * 0.8) : 0.0005;
      onFrame({
        type: "metrics", seq: seq++ & 0xffff, sliding, tared: true, loadValid: sliding, adcSaturated: false, recording: false,
        lateralRmsG: lat, yawRmsDps: sliding ? 6 + 4 * Math.abs(Math.sin(t)) : 0.2,
        leftV: left, rightV: right, totalLoadV: left + right + 0.05, lrBalance: (right - left) / (right + left),
      });
      if (n % 10 === 0) {
        const shift = t > 40 ? 0.8 : 0; // 40秒を過ぎたら氷が変わった想定
        onFrame({ type: "lfcc", seq: lfccSeq++, frames: 13, slideFrames: sliding ? 13 : 0,
          mean: Array.from({ length: 19 }, (_, i) => 2 / (i + 1) + shift * (i < 4 ? 1 : 0.2) + 0.1 * Math.sin(n + i)), std: [] });
      }
      n++;
    }, 50);
    $("demo").textContent = "デモ停止";
    setConnected(false, "デモ表示中（実機のデータではありません）");
    $("tare").disabled = true;
    $("baseline").disabled = false;
    $("csv").disabled = false;
  }

  $("connect").addEventListener("click", connect);
  $("demo").addEventListener("click", demo);
  $("tare").addEventListener("click", () => send("Z"));
  $("rec").addEventListener("click", () => send("S")); // 20秒で自動で止まる。記録の開始は、画面を操作する人が決める
  $("recStop").addEventListener("click", () => send("P"));
  $("baseline").addEventListener("click", () => {
    tracker.startBaseline();
    lastSurf = null;
    ui.surfCollecting = true;
    ui.surfProgress = 0;
    dirty = true;
  });
  $("csv").addEventListener("click", saveCsv);
  $("camBtn").addEventListener("click", toggleCamera);
  $("vidRec").addEventListener("click", toggleVideo);
  $("vidLive").addEventListener("click", showLive);
  $("vidSave").addEventListener("click", saveVideo);
  // グラフの履歴だけを消す。接続・CSV用のデータ・氷の基準・受信数の表示は、そのまま
  $("resetGraph").addEventListener("click", () => {
    Coach.clearHistory(hist);
    dirty = true;
  });
  window.addEventListener("resize", () => (dirty = true));
  reset();
  render();
  if (location.search.includes("demo=1")) demo(); // 画面の確認用（?demo=1 で、台なしでデモを始める）
})();
