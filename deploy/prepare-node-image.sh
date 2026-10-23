#!/usr/bin/env sh
set -eu

NPM_VERSION="${WORKBENCH_CONTAINER_NPM_VERSION:-11.18.0}"
APK_TIMEOUT_SECONDS="${WORKBENCH_APK_TIMEOUT_SECONDS:-300}"

case "$APK_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    echo "WORKBENCH_APK_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 1
    ;;
esac
if [ "$APK_TIMEOUT_SECONDS" -lt 1 ]; then
  echo "WORKBENCH_APK_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 1
fi

if command -v apk >/dev/null 2>&1; then
  alpine_packages=""
  for package in "$@"; do
    case "$package" in
      fonts-dejavu-core) package="font-dejavu" ;;
      fonts-noto-cjk) package="font-noto-cjk" ;;
      python3-lxml) package="py3-lxml" ;;
      python3-pillow) package="py3-pillow" ;;
      python3-virtualenv) package="py3-virtualenv" ;;
      ca-certificates|chromium|coreutils|git|libreoffice-writer|nginx|openssl|python3|tini) ;;
      *)
        echo "unsupported Alpine container package: $package" >&2
        exit 1
        ;;
    esac
    alpine_packages="${alpine_packages}${alpine_packages:+ }${package}"
  done
  if [ -n "$alpine_packages" ]; then
    # Package names are restricted by the allowlist above. The build runner
    # uses a bounded mirror fallback because the proxy occasionally truncates
    # one Alpine CDN response while the same request succeeds on a mirror.
    alpine_repositories="/etc/apk/repositories"
    alpine_mirrors="https://dl-cdn.alpinelinux.org https://mirrors.aliyun.com https://mirrors.cloud.tencent.com"
    alpine_attempt=0
    alpine_installed=0
    for alpine_mirror in $alpine_mirrors; do
      alpine_attempt=$((alpine_attempt + 1))
      if [ -f "$alpine_repositories" ]; then
        sed -i "s#https://dl-cdn.alpinelinux.org#${alpine_mirror}#g; s#https://mirrors.aliyun.com#${alpine_mirror}#g; s#https://mirrors.cloud.tencent.com#${alpine_mirror}#g" "$alpine_repositories"
      fi
      # A proxy or CDN can leave apk waiting on a response forever. Alpine's
      # BusyBox images include timeout; the fallback keeps the helper runnable
      # in the shell-only fixtures used by the contract tests.
      if command -v timeout >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        if timeout "$APK_TIMEOUT_SECONDS" apk add --no-cache $alpine_packages; then
          alpine_installed=1
          break
        fi
      # shellcheck disable=SC2086
      elif apk add --no-cache $alpine_packages; then
        alpine_installed=1
        break
      fi
      if [ "$alpine_attempt" -lt 3 ]; then
        sleep "$((alpine_attempt * 2))"
      fi
    done
    if [ "$alpine_installed" -ne 1 ]; then
      echo "unable to install Alpine image packages after bounded mirror retries" >&2
      exit 1
    fi
  fi
elif command -v apt-get >/dev/null 2>&1; then
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    sed -i \
      -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
      -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
      /etc/apt/sources.list.d/debian.sources
  fi
  if [ "$#" -gt 0 ]; then
    debian_packages=""
    for package in "$@"; do
      case "$package" in
        # The renderer uses portable package names in the Dockerfile. Debian
        # calls Pillow's system package python3-pil.
        python3-pillow) package="python3-pil" ;;
      esac
      debian_packages="${debian_packages}${debian_packages:+ }${package}"
    done
    apt-get update
    # Package names passed to this helper are fixed allowlisted image inputs.
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $debian_packages
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  fi
else
  echo "no supported container package manager found" >&2
  exit 1
fi

npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}"
npm cache clean --force
