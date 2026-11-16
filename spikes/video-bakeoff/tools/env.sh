# Source this file: local ffmpeg/ffprobe (npm-scoped, no system install) + telemetry off.
_TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}")" && pwd)"
export FFMPEG="$_TOOLS_DIR/node_modules/ffmpeg-static/ffmpeg"
export FFPROBE="$_TOOLS_DIR/node_modules/@ffprobe-installer/darwin-arm64/ffprobe"
export HYPERFRAMES_FFMPEG_PATH="$FFMPEG"
export HYPERFRAMES_FFPROBE_PATH="$FFPROBE"
export HYPERFRAMES_NO_TELEMETRY=1
export HYPERFRAMES_SKIP_SKILLS=1
export DO_NOT_TRACK=1
