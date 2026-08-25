#!/bin/sh
# Проставляет версию во входной модуль перед деплоем.
#
# GitHub Pages отдаёт файлы с max-age=600, поэтому без смены адреса браузер
# десять минут берёт старый JS из кеша и может склеить его со свежим HTML.
# Версия из адреса app.js протаскивается во все импорты (см. js/app.js).
set -e
cd "$(dirname "$0")"
V=$(date -u +%Y%m%d%H%M)
perl -pi -e "s|(js/app\.js\?v=)\d+|\${1}$V|" index.html
printf '{"build": "%s"}\n' "$V" > version.json
echo "версия $V"
