#!/usr/bin/env bash
set -euo pipefail
d=$(mktemp -d); trap 'rm -rf "$d"' EXIT
here=$(cd "$(dirname "$0")" && pwd)
pw=$(openssl rand -hex 16)
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$d/k.pem" -out "$here/canary-cert.pem" -days 3650 \
  -subj "/CN=Developer ID Application: Canary (CANARY0001)/OU=CANARY0001" \
  -addext "extendedKeyUsage=critical,codeSigning" -addext "keyUsage=critical,digitalSignature" 2>/dev/null
/usr/bin/openssl pkcs12 -export -in "$here/canary-cert.pem" -inkey "$d/k.pem" -out "$d/c.p12" -passout "pass:$pw"
/usr/bin/openssl ecparam -name prime256v1 -genkey -noout | /usr/bin/openssl pkcs8 -topk8 -nocrypt > "$d/n.p8"
base64 -i "$d/c.p12" | gh secret set CI_CANARY_P12 --repo doguyilmaz/tapster
printf %s "$pw" | gh secret set CI_CANARY_P12_PASSWORD --repo doguyilmaz/tapster
base64 -i "$d/n.p8" | gh secret set CI_CANARY_NOTARY_KEY --repo doguyilmaz/tapster
printf %s "CANARYKEY1" | gh secret set CI_CANARY_NOTARY_KEY_ID --repo doguyilmaz/tapster
printf %s "00000000-0000-4000-8000-0000000c4a72" | gh secret set CI_CANARY_NOTARY_ISSUER_ID --repo doguyilmaz/tapster
echo "canary secrets set; commit tests/leak/canary-cert.pem (public certificate only)"
