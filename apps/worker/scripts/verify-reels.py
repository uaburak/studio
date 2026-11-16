#!/usr/bin/env python3
"""Reels delivery checks (the bake-off's 15 points, spikes/video-bakeoff/tools/verify_reels.py),
with the duration check taken from the expected length instead of the bake-off's fixed 8 s.

Usage: verify-reels.py <file.mp4> --duration <seconds> [--json out.json]
Env: FFMPEG, FFPROBE (paths to the binaries).
"""
import json, math, os, re, struct, subprocess, sys

f = sys.argv[1]
expected = float(sys.argv[sys.argv.index("--duration") + 1]) if "--duration" in sys.argv else None
FFPROBE = os.environ["FFPROBE"]; FFMPEG = os.environ["FFMPEG"]

def probe(*args):
    return json.loads(subprocess.check_output([FFPROBE, "-v", "error", "-print_format", "json", *args, f]))

info = probe("-show_streams", "-show_format")
v = next(s for s in info["streams"] if s["codec_type"] == "video")
a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
pk = probe("-select_streams", "v:0", "-show_entries", "packet=pts_time,flags")["packets"]
key_times = [round(float(p["pts_time"]), 3) for p in pk if "K" in p.get("flags", "")]

data = open(f, "rb").read()
atoms, i = [], 0
while i + 8 <= len(data):
    size, typ = struct.unpack(">I4s", data[i:i + 8]); typ = typ.decode("latin1")
    if size == 1: size = struct.unpack(">Q", data[i + 8:i + 16])[0]
    atoms.append(typ); i += size if size else len(data)
moov_start = data.find(b"moov") - 4
moov = data[moov_start:moov_start + struct.unpack(">I", data[moov_start:moov_start + 4])[0]]
has_elst = b"elst" in moov

th = subprocess.run([FFMPEG, "-hide_banner", "-i", f, "-map", "0:v", "-c", "copy", "-bsf:v", "trace_headers", "-f", "null", "-"],
                    capture_output=True, text=True).stderr
idr = len(re.findall(r"nal_unit_type\s+[01]+ = 5\b", th))
sei = re.search(rb"x264 - core [^\x00]{0,2000}", data)
x264 = sei.group(0).decode("latin1") if sei else ""
open_gop = re.search(r"open_gop=(\d)", x264)
duration = float(info["format"]["duration"])
want = expected if expected is not None else duration
min_keys = max(1, math.ceil(want / 2.0 - 1e-6))

checks = {
    "codec h264": v["codec_name"] == "h264",
    "profile High": v.get("profile") == "High",
    "pix_fmt yuv420p": v.get("pix_fmt") == "yuv420p",
    "1080x1920": (v["width"], v["height"]) == (1080, 1920),
    "30 fps (r & avg)": v["r_frame_rate"] == "30/1" and v["avg_frame_rate"] == "30/1",
    "bt709 primaries/trc/matrix": (v.get("color_primaries"), v.get("color_transfer"), v.get("color_space")) == ("bt709", "bt709", "bt709"),
    "limited (tv) range": v.get("color_range") == "tv",
    "keyframes every 2 s": key_times == [round(x * 2.0, 3) for x in range(len(key_times))] and len(key_times) >= min_keys,
    "closed GOP (x264 open_gop=0)": bool(open_gop) and open_gop.group(1) == "0",
    "every keyframe is IDR": idr >= len(key_times),
    "moov before mdat (faststart)": "moov" in atoms and "mdat" in atoms and atoms.index("moov") < atoms.index("mdat"),
    "no edit lists (elst)": not has_elst,
    "audio AAC 48 kHz stereo": bool(a) and a["codec_name"] == "aac" and a["sample_rate"] == "48000" and a["channels"] == 2,
    "video starts at pts 0": float(v.get("start_time", 1)) == 0.0,
    f"duration ~{want:.1f} s": abs(duration - want) < 0.1,
}
report = {"file": os.path.basename(f), "pass": all(checks.values()), "checks": checks,
          "top_level_atoms": atoms, "keyframe_times": key_times, "idr_nal_count": idr,
          "video_bitrate": v.get("bit_rate"), "nb_frames": v.get("nb_frames"),
          "duration": info["format"]["duration"], "size_bytes": int(info["format"]["size"])}
for k, ok in checks.items(): print(("PASS " if ok else "FAIL ") + k)
print("OVERALL:", "PASS" if report["pass"] else "FAIL", f"({sum(checks.values())}/{len(checks)})")
if "--json" in sys.argv: json.dump(report, open(sys.argv[sys.argv.index("--json") + 1], "w"), indent=2)
sys.exit(0 if report["pass"] else 1)
