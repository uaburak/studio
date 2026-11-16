#!/bin/bash
# Instagram Reels normalization pass + ffprobe JSON.
# -threads 1: multi-threaded x264 ABR/VBV output differed run-to-run with this ffmpeg build; one thread is byte-stable (~3 s for 8 s of video).
# Usage: tools/normalize.sh <in.mp4> <out.mp4>   (writes <out>.ffprobe.json next to it)
set -euo pipefail
source "$(dirname "$0")/env.sh"
in="$1"; out="$2"
"$FFMPEG" -hide_banner -v error -y \
  -i "$in" -f lavfi -i anullsrc=r=48000:cl=stereo \
  -map 0:v:0 -map 1:a:0 -shortest \
  -c:v libx264 -threads 1 -profile:v high -pix_fmt yuv420p -r 30 \
  -g 60 -keyint_min 60 -sc_threshold 0 -flags +cgop \
  -b:v 8M -maxrate 12M -bufsize 16M \
  -color_range tv -color_primaries bt709 -color_trc bt709 -colorspace bt709 \
  -c:a aac -b:a 128k -ar 48000 -ac 2 \
  -movflags +faststart+negative_cts_offsets -use_editlist 0 \
  "$out"
"$FFPROBE" -v error -print_format json -show_format -show_streams "$out" > "${out%.mp4}.ffprobe.json"
