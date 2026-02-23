#!/bin/bash
# Generate a self-signed certificate for:
#   1) OpDesk HTTPS (WebRTC Softphone in browser)
#   2) Optional: Asterisk/FreePBX TLS (WebSocket wss:// for WebRTC)
#
# Run from project root: ./generate-ssl-cert.sh [CN] [install-asterisk]
#   Creates cert/ folder and writes opdesk_cert.pem and opdesk_key.pem there.
#   CN defaults to localhost. Use your PBX hostname or IP for LAN (e.g. 172.16.11.65).
#   If second arg is "asterisk" or "install-asterisk", copies cert/key to /etc/asterisk/ and sets ownership.
#
# Examples:
#   ./generate-ssl-cert.sh
#   ./generate-ssl-cert.sh 172.16.11.65
#   sudo ./generate-ssl-cert.sh 172.16.11.65 asterisk

set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
CN="${1:-localhost}"
INSTALL_ASTERISK="${2:-}"

CERT_DIR="$DIR/cert"
mkdir -p "$CERT_DIR"
CERT="$CERT_DIR/opdesk_cert.pem"
KEY="$CERT_DIR/opdesk_key.pem"

openssl req -x509 -newkey rsa:4096 -keyout "$KEY" -out "$CERT" -days 365 -nodes \
  -subj "/CN=$CN"

chmod 600 "$KEY"
chmod 644 "$CERT"

# Verify cert and key match (avoids Asterisk "Internal SSL error" from mismatch)
CERT_MOD=$(openssl x509 -noout -modulus -in "$CERT" 2>/dev/null | openssl md5)
KEY_MOD=$(openssl rsa -noout -modulus -in "$KEY" 2>/dev/null | openssl md5)
if [[ "$CERT_MOD" != "$KEY_MOD" ]]; then
  echo "Error: Certificate and key modulus mismatch. Regenerate the pair." >&2
  exit 1
fi
echo "Created: $CERT, $KEY (CN=$CN) [cert/key match verified]"
echo ""
echo "--- OpDesk (backend/.env) ---"
echo "  HTTPS_CERT=$CERT"
echo "  HTTPS_KEY=$KEY"
echo "  OPDESK_HTTPS_PORT=8443"
echo ""

if [[ "$INSTALL_ASTERISK" == "asterisk" || "$INSTALL_ASTERISK" == "install-asterisk" ]]; then
  AST_DIR="/etc/asterisk"
  AST_CERT="$AST_DIR/opdesk_cert.pem"
  AST_KEY="$AST_DIR/opdesk_key.pem"
  if [[ ! -d "$AST_DIR" ]]; then
    echo "Error: $AST_DIR not found. Is Asterisk/FreePBX installed?"
    exit 1
  fi
  if [[ $EUID -ne 0 ]]; then
    echo "Run with sudo to install for Asterisk: sudo $0 $CN asterisk"
    exit 1
  fi
  cp "$CERT" "$AST_CERT"
  cp "$KEY"  "$AST_KEY"
  chown asterisk:asterisk "$AST_CERT" "$AST_KEY"
  chmod 644 "$AST_CERT"
  chmod 600 "$AST_KEY"
  echo "--- Asterisk/FreePBX (installed) ---"
  echo "  Cert: $AST_CERT"
  echo "  Key:  $AST_KEY"
  echo ""
  echo "In /etc/asterisk/http.conf (or FreePBX HTTP/WebSocket TLS settings) set:"
  echo "  tlsenable=yes"
  echo "  tlsbindaddr=0.0.0.0:8089"
  echo "  tlscertfile=$AST_CERT"
  echo "  tlskeyfile=$AST_KEY"
  echo ""
  echo "Then reload: asterisk -rx 'http reload'"
  echo "Use wss://YOUR_PBX_IP:8089/ws in OpDesk WEBRTC_PBX_SERVER (must be wss://, not ws://)."
  echo ""
  echo "--- If you see 'Internal SSL error' in Asterisk CLI ---"
  echo "  1) Use wss:// in OpDesk (ws:// on a TLS port causes this error)."
  echo "  2) Ensure BOTH tlscertfile and tlskeyfile are set in http.conf."
  echo "  3) Cert CN must match the host you connect to (e.g. $CN)."
  echo "  4) In browser, open https://PBX_IP:8089 once and accept the self-signed cert before using the softphone."
  echo "     In Firefox: open that URL in a new tab, accept the certificate, then try the softphone again."
else
  echo "To install the same cert for Asterisk/FreePBX (wss://):"
  echo "  sudo $0 $CN asterisk"
  echo ""
  echo "If Asterisk shows 'Internal SSL error' with peer: ensure OpDesk uses wss:// (not ws://) and http.conf has both tlscertfile and tlskeyfile."
  echo ""
fi
