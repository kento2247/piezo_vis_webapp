# Piezo FFT Visualizer Web App

ブラウザだけで動く FFT スペクトログラムです。Python サーバは不要です。

## 使い方

1. `webapp/index.html` を HTTPS または `localhost` で開きます。
2. `開始` を押してマイク入力を許可します。
3. 必要なら入力ソース、FFT window、チャンネル数、履歴秒数、表示上限周波数を変更します。
4. `録音開始` / `録音停止` でブラウザ内に録音を保存できます。
5. `STFT履歴` で録音を選択し、STFT図の PNG と録音 WAV をダウンロードできます。
6. 録音一覧のメモ欄に、タスク内容や測定条件を書けます。
7. STFT表示では `min Hz` / `max Hz` と、凡例横のスライダーで dB 表示レンジを調整できます。

録音履歴はブラウザの IndexedDB に保存されます。同じブラウザ内では残りますが、別端末や別ブラウザには共有されません。

iPad で使う場合は、USB-C または Lightning 経由で接続した class-compliant audio interface がマイク入力として認識されている必要があります。

## GitHub Pages

GitHub Pages の公開元を `webapp/` に設定するか、`webapp/` の中身を公開ブランチのルートに置いてください。外部依存やビルド手順はありません。

`getUserMedia()` は HTTPS などの secure context が必要です。GitHub Pages は HTTPS で配信されるため、そのまま動作します。
