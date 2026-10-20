"""Beat This! on the fresh 100, on cuda or cpu. Same windows and decoding as the bake-off.

Usage: python -I /gpu-code/run_gpu.py <checkpoint> <device> <out dir>
Reads /gpu/sample.json. Keeps every beat time so the steady-gap BPM is worked out afterwards,
as the bake-off did.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/harness")

import numpy as np  # noqa: E402
import torch  # noqa: E402
from common import Clock, DecodeError, decode, memory, windows, write_json  # noqa: E402

RATE = 22050


def main() -> None:
    checkpoint, device, out_dir = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(1)
    clock = Clock()
    from beat_this.inference import Audio2Beats

    tracker = Audio2Beats(checkpoint_path=f"/models/beat_this/{checkpoint}.ckpt", device=device)
    load_seconds = clock.seconds()
    sample = json.loads(Path("/gpu/sample.json").read_text(encoding="utf-8"))
    run_clock = Clock()
    for song_id in sample["tempo_ids"]:
        song = sample["songs"][song_id]
        record = {"song_id": song_id, "windows": {}}
        song_clock = Clock()
        decode_s = infer_s = 0.0
        for name, (start, seconds) in windows(song["duration"] or 0).items():
            part = Clock()
            try:
                audio = decode(song["path"], start, seconds, RATE)
            except DecodeError as exc:
                record["windows"][name] = {"error": str(exc)}
                continue
            decode_s += part.seconds()
            part = Clock()
            beats, _ = tracker(audio, RATE)
            if device == "cuda":
                torch.cuda.synchronize()
            infer_s += part.seconds()
            record["windows"][name] = {
                "beat_times": [round(float(b), 3) for b in np.asarray(beats)]
            }
        record["seconds_total"] = song_clock.seconds()
        record["seconds_decode"] = round(decode_s, 4)
        record["seconds_infer"] = round(infer_s, 4)
        write_json(out_dir / f"{song_id}.json", record)
    end = {
        "checkpoint": checkpoint,
        "device": device,
        "torch": torch.__version__,
        "load_seconds": load_seconds,
        "run_seconds": run_clock.seconds(),
        "memory": memory(),
    }
    if device == "cuda":
        end["gpu"] = torch.cuda.get_device_name(0)
        end["gpu_peak_mb"] = round(torch.cuda.max_memory_allocated() / 1e6, 1)
    write_json(out_dir / "_end.json", end)
    print(json.dumps(end), flush=True)


if __name__ == "__main__":
    main()
