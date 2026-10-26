#!/bin/sh
set -e

MIRROR="${APK_MIRROR:-}"
MIRROR="${MIRROR%/}"

case "$MIRROR" in
  http://*|https://*) ;;
  *)
    echo "APK_MIRROR 需以 http:// 或 https:// 开头，当前为 '${MIRROR}'" >&2
    exit 1
    ;;
esac

if [ $# -eq 0 ]; then
  echo "未指定要安装的 apk 包" >&2
  exit 1
fi

if [ ! -r /etc/alpine-release ]; then
  echo "缺少 /etc/alpine-release，无法确定 Alpine 版本" >&2
  exit 1
fi

VERSION="$(cut -d. -f1,2 /etc/alpine-release)"
BRANCH="v${VERSION}"

REPOSITORIES=/etc/apk/repositories
BACKUP="${REPOSITORIES}.modelgate"

if ! cp -f "$REPOSITORIES" "$BACKUP"; then
  echo "备份 ${REPOSITORIES} 失败" >&2
  exit 1
fi

trap 'mv -f "$BACKUP" "$REPOSITORIES" || echo "恢复 ${REPOSITORIES} 失败" >&2' EXIT

printf '%s/alpine/%s/main\n%s/alpine/%s/community\n' \
  "$MIRROR" "$BRANCH" "$MIRROR" "$BRANCH" > "$REPOSITORIES"

echo "apk 镜像源：${MIRROR}/alpine/${BRANCH}" >&2

ATTEMPTS=3
TIMEOUT=120

attempt=1
while [ "$attempt" -le "$ATTEMPTS" ]; do
  rm -f /lib/apk/db/lock
  if timeout "$TIMEOUT" apk add --no-cache "$@"; then
    exit 0
  fi
  echo "apk add 失败（第 ${attempt}/${ATTEMPTS} 次，单次上限 ${TIMEOUT}s），镜像源 ${MIRROR}/alpine/${BRANCH}" >&2
  attempt=$((attempt + 1))
  if [ "$attempt" -le "$ATTEMPTS" ]; then
    sleep 10
  fi
done

echo "apk add 重试 ${ATTEMPTS} 次仍失败，请检查镜像源 ${MIRROR} 与网络连通性" >&2
exit 1
