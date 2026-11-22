#!/bin/sh
# 公開する前に実行する：版の番号（日時）を index.html・app.js・version.json にそろえて書き込む
# これで、更新後に古い画面を開いた人も、自動で新しい画面に読み込み直される
set -e
cd "$(dirname "$0")/.."
B=$(date +%Y%m%d%H%M%S)
sed -i.bak -E "s/(style\.css|app\.js)\?v=[0-9]+/\1?v=$B/g" index.html && rm -f index.html.bak
sed -i.bak -E "s/^const APP_BUILD = '[0-9]+';/const APP_BUILD = '$B';/" app.js && rm -f app.js.bak
printf '{ "build": "%s" }\n' "$B" > version.json
echo "build $B"
