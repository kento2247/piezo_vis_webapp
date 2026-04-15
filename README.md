# Piezo FFT Visualizer Web App

ブラウザだけで動く FFT スペクトログラムです。Python サーバは不要です。

## 使い方

1. `webapp/index.html` を HTTPS または `localhost` で開きます。
2. `開始` を押してマイク入力を許可します。
3. 必要なら入力ソース、FFT window、チャンネル数、履歴秒数、表示上限周波数を変更します。

iPad で使う場合は、USB-C または Lightning 経由で接続した class-compliant audio interface がマイク入力として認識されている必要があります。

## GitHub Pages

GitHub Pages の公開元を `webapp/` に設定するか、`webapp/` の中身を公開ブランチのルートに置いてください。外部依存やビルド手順はありません。

`getUserMedia()` は HTTPS などの secure context が必要です。GitHub Pages は HTTPS で配信されるため、そのまま動作します。
