# ムービー・モーションキャプチャ

先生と初心者が映った練習動画から、骨格つき動画（MP4）と骨格データ（CSV）を作るWebアプリ。
iPhoneのSafariで開いて使う。動画はブラウザの中だけで処理され、外部には送られない。

公開予定のアドレス：https://asmintt.github.io/movie-motion-capture/

## 使い方

1. 動画を選ぶ
2. 解析の範囲・速さ・AIの精度を決める
3. 先生と初心者をタップで選ぶ
4. 解析する
5. 取り違えがあれば「ここから入れ替える」で直す
6. 動画（写真アプリ）とCSV（ファイルアプリ）を保存する

CSVはClaudeのプロジェクト「ダンス練習分析」に添えて分析してもらう。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面 |
| `style.css` | 見た目 |
| `app.js` | 骨格検出・追跡・動画とCSVの書き出し |
| `lib/vision_bundle.mjs`, `lib/wasm/` | MediaPipe Tasks Vision 0.10.14（Apache-2.0） |
| `lib/models/` | MediaPipe Pose Landmarker の full / heavy モデルと、顎先を取るための Face Landmarker モデル |
| `lib/mp4-muxer.mjs` | mp4-muxer 5.1.3（MIT）。MP4ファイルを組み立てる |

## しくみのメモ

- 画面全体だと遠い人や暗い服の人を見落とすため、人ごとに前のコマの位置の周りを縦長に切り出し、拡大して検出している
- 頭の点：顎先は顔用AI（Face Landmarker）の点、頭頂部は顎先と額の上端から推定した位置（AIの点ではない）。顔用AIが顔を見つけられないコマは、骨格AIの目と口から両方を推定して灰色で表示する
- 頭頂部 → 顎先 → 両肩の真ん中 を線でつなぎ、頭と首の傾きが見えるようにしている
- 保存するファイル名は `元の名前_MediaPipePose.mp4` と `元の名前_MediaPipePose.csv`
- 動画の書き出しはWebCodecs（H.264）。iPhoneはiOS 16.4以降が必要
- 動作確認用に `?src=動画のURL` で動画を読み込める

## ローカルで動かす

```bash
cd ~/Desktop/movie-motion-capture && python3 -m http.server 8765
```

ブラウザで http://localhost:8765/ を開く。
