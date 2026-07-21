#!/usr/bin/env sh
set -eu

NPM_VERSION="${WORKBENCH_CONTAINER_NPM_VERSION:-11.18.0}"

if command -v apk >/dev/null 2>&1; then
  alpine_packages=""
  for package in "$@"; do
    case "$package" in
      fonts-dejavu-core) package="font-dejavu" ;;
      ca-certificates|chromium|coreutils|git|nginx|openssl|tini) ;;
      *)
        echo "unsupported Alpine container package: $package" >&2
        exit 1
        ;;
    esac
    alpine_packages="${alpine_packages}${alpine_packages:+ }${package}"
  done
  if [ -n "$alpine_packages" ]; then
    # Package names are restricted by the allowlist above.
    # shellcheck disable=SC2086
    apk add --no-cache $alpine_packages
  fi
elif command -v apt-get >/dev/null 2>&1; then
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    sed -i \
      -e 's#http://deb.debian.org/debian#http://mirrors.aliyun.com/debian#g' \
      -e 's#http://deb.debian.org/debian-security#http://mirrors.aliyun.com/debian-security#g' \
      /etc/apt/sources.list.d/debian.sources
  fi
  if [ "$#" -gt 0 ]; then
    apt-get update
    apt-get install -y --no-install-recommends "$@"
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*
  fi
else
  echo "no supported container package manager found" >&2
  exit 1
fi

npm install --global --ignore-scripts --no-audit --no-fund "npm@${NPM_VERSION}"
npm cache clean --force
