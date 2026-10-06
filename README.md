# SL 操作ページ

計測基板（SL1・SL2 など）に Bluetooth（Nordic UART Service）でつなぎ、コマンドを送るための Web ページです。

- Android の Chrome で https://being24.github.io/sl-ble-console/ を開いて使います（Web Bluetooth を使うため、iPhone・iPad の Safari では動きません）
- 接続した直後に、スマホの現在日時を `T <Unix秒> <UTCからの分>` で送ります。基板は記録ファイルの作成・更新日時にこれを使います
- `S`（記録開始）・`P`（停止）・`R`（現在値）・`Q`（状態）・`I`（識別情報）・`L`（一覧）・`X`（再起動、確認あり）をボタンで送れ、任意のコマンドも打てます
- ハブ（名前 `HUB`）にもつなげます。ハブ経由の通知は `<台名>|` で始まり、台ごとに色を分けて表示します

コマンドの内容は基板のリポジトリの `docs/ble_operation_manual.md` を参照してください。
