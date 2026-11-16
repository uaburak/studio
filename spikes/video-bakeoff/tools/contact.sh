#!/bin/bash
# Usage: tools/contact.sh <video.mp4> <out.png> <t1> <t2> ... — one row of frames scaled to 360x640.
source "$(dirname "$0")/env.sh"
in="$1"; out="$2"; shift 2
args=(); filt=""; i=0
for t in "$@"; do args+=(-ss "$t" -i "$in"); filt+="[$i:v]scale=360:640,drawtext=fontfile=$(dirname "$0")/../shared-assets/Montserrat_600SemiBold.ttf:text='t=$t':x=10:y=10:fontsize=28:fontcolor=red[v$i];"; i=$((i+1)); done
stack=""; for ((j=0;j<i;j++)); do stack+="[v$j]"; done
"$FFMPEG" -v error -y "${args[@]}" -filter_complex "${filt}${stack}hstack=inputs=$i" -frames:v 1 "$out"
