#!/usr/bin/env bash
# Generates a self-signed TLS certificate for local development.
#
# Camera and geolocation APIs only work in a "secure context": HTTPS, or
# plain HTTP on `localhost`. Testing on a phone over the LAN needs the app
# to be reachable at a non-localhost address, which means real HTTPS — this
# cert makes that possible without a CA. It is picked up automatically by
# `loadConfig()` when present; never use it outside local development.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$DIR"

if [[ -f "$DIR/dev-key.pem" && -f "$DIR/dev-cert.pem" ]]; then
  echo "Dev certificate already exists at $DIR — remove it first to regenerate."
  exit 0
fi

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/dev-key.pem" \
  -out "$DIR/dev-cert.pem" \
  -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

echo "Self-signed dev certificate written to $DIR (not for production use)."
