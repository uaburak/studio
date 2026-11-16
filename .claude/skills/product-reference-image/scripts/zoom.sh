#!/bin/bash
# Bir görselin bir bölgesini kırpıp büyütür (etiket okumak ve doğrulamak için).
# Kullanım: zoom.sh <girdi> <x> <y> <genişlik> <yükseklik> <çıktı.png> [ölçek=2]
set -euo pipefail
if [ "$#" -lt 6 ]; then
  echo "Kullanım: zoom.sh <girdi> <x> <y> <genişlik> <yükseklik> <çıktı.png> [ölçek]" >&2
  exit 2
fi
in="$1"; x="$2"; y="$3"; w="$4"; h="$5"; out="$6"; scale="${7:-2}"
mkdir -p "$(dirname "$out")"
sips -s format png -c "$h" "$w" --cropOffset "$y" "$x" "$in" --out "$out" >/dev/null
sips --resampleWidth "$(( w * scale ))" "$out" >/dev/null
echo "$out"
