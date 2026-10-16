# SL 指導コンソール

指導用ファーム（`slider_sensors` の `coach/`、台の名前 `COACH1`・`COACH2`）に BLE でつなぎ、指標をリアルタイムのグラフにするページ。
記録用の操作ページ（一つ上の `index.html`）とは別のページで、台は別のファームです。

https://being24.github.io/sl-ble-console/coach/

## 使い方

1. 台に指導用ファームを書き込む（`slider_sensors` の `docs/coach_manual.md`）。
2. Web Bluetooth に対応したブラウザ（Android・PC の Chrome、iPad は Bluefy）で上の URL を開く。
3. 「接続」で `COACH` から始まる台を選ぶ。
4. 台を静止させたまま「0点合わせ」（足圧の0点を取る）。
5. 氷の変化を見たいときは、「氷の基準を取る」を押して滑る（滑走中の約8窓、約4秒ぶんの平均を基準にする）。

台なしで見た目だけ確かめるには、「デモ」ボタン、または `?demo=1` を付けて開く。

## 画面の指標

| 表示 | 中身 | 注意 |
|---|---|---|
| 左右の荷重バランス | (右−左)/(右+左) | 足圧の位置は台ごと・日ごとに違い、出力も小さいので参考値 |
| 横ぶれ | 横の加速度 X の5Hz以下の0.5秒窓 RMS [g] | 点線は 2026-10-14 の Used の中央値（経験者 0.05 g、初心者 0.14 g）。**良し悪しの判定はしない**。MOCAP での照合は未実施 |
| 向きの回転 | ジャイロ Z の5Hz以下の0.5秒窓 RMS [dps] | |
| 総荷重 | 足圧センサの出力の合計（0点合わせ後）[V] | 頭打ちのときはバッジで知らせる |
| 氷の基準からの距離（参考） | 滑走中の約0.5秒ごとの LFCC（IIS3DWB）が、基準の平均からどれだけ離れたか | 氷の種類（used / fine / rough_fine）は判定しない。人をまたぐ識別の精度が弱いため |

## ファイル

- `coach.js` — パケットの読み取り、基準からの距離（Web Bluetooth に依存しない）。`node --test` でテスト（`test/protocol.test.js`）
- `chart.js` — 依存なしの折れ線グラフ（canvas）
- `app.js` — 接続、画面の更新、CSV 保存、デモ
- `index.html` — 画面

パケットの形式は `slider_sensors` の `docs/coach_protocol.md`。ファームの `coach/tests_host/test_coach_proto.c` と
`test/protocol.test.js` は、同じバイト列を期待値にしている。

## 未確認

実機（台）との接続は、まだ確認していない（デモと、バイト列のテストだけ）。
