#!/bin/bash
# Installs the e2e site's package with apt and dnf. Usage: install.sh <site dir>
set -euo pipefail
site=$1
docker network create tapster-e2e >/dev/null
trap 'docker rm -f repo >/dev/null 2>&1 || true; docker network rm tapster-e2e >/dev/null 2>&1 || true' EXIT
docker run -d --rm --name repo --network tapster-e2e -v "$site:/srv:ro" -w /srv python:3.12-alpine python -m http.server 8000 >/dev/null
sleep 2
docker run --rm --network tapster-e2e ubuntu:24.04 bash -c '
  set -euo pipefail
  apt-get update -qq >/dev/null && apt-get install -y -qq curl >/dev/null
  dpkg --add-architecture "$([ "$(dpkg --print-architecture)" = amd64 ] && echo i386 || echo armhf)"
  curl -fsSLo /etc/apt/keyrings/o-tapster.pgp http://repo:8000/o-tapster.pgp
  printf "Types: deb\nURIs: http://repo:8000/apt\nSuites: stable\nComponents: main\nSigned-By: /etc/apt/keyrings/o-tapster.pgp\n" > /etc/apt/sources.list.d/o-tapster.sources
  apt-get update > /tmp/update.log 2>&1 || true
  grep "repo:8000" /tmp/update.log
  if grep -E "^(W|E):.*repo:8000" /tmp/update.log; then exit 1; fi
  apt-get install -y -qq fixture >/dev/null
  fixture
  test -f /usr/share/bash-completion/completions/fixture'
docker run --rm --network tapster-e2e fedora:42 bash -c '
  set -euo pipefail
  curl -fsSLo /etc/yum.repos.d/o-tapster.repo http://repo:8000/rpm/o-tapster.repo
  dnf -y -q install fixture
  fixture
  rpm -q --qf "%{SIGPGP:pgpsig}%{RSAHEADER:pgpsig}\n" fixture'
echo "apt and dnf installed the hub-built package"
