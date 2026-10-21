"""The Beat This! model behind `beat.Tracker`, on the graphics card when there is one.

Only the `tempo-beat-v1` images have torch. The device is chosen once, at start: CUDA when
torch sees a card and a small operation on it works, otherwise the CPU. A card the installed
CUDA build cannot drive fails that operation, so the fallback catches it rather than the
first song.
"""

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from audio_worker.beat import Tracker
from audio_worker.recipe import SAMPLE_RATE, Samples

CHECKPOINT = Path(os.environ.get("MUSIMO_BEAT_CHECKPOINT", "/opt/beat-this/final0.ckpt"))


@dataclass(frozen=True)
class Device:
    name: str  # "cuda" or "cpu"
    gpu: str
    # Why a requested card is not used, or "".
    note: str


def choose_device(preference: str) -> Device:
    import torch

    if preference == "cpu":
        return Device("cpu", "", "")
    if not torch.cuda.is_available():
        note = "no graphics card visible to torch" if preference == "cuda" else ""
        return Device("cpu", "", note)
    try:
        probe = torch.ones(8, device="cuda")
        float((probe * 2).sum().item())
        name = torch.cuda.get_device_name(0)
    except Exception as exc:  # noqa: BLE001 - any CUDA failure means the CPU is used
        return Device("cpu", "", f"graphics card unusable: {type(exc).__name__}: {exc}"[:200])
    return Device("cuda", name, "")


def load_tracker(preference: str, threads: int) -> tuple[Tracker, Device]:
    """The model on the chosen device, as a function of one window's samples."""
    import torch
    from beat_this.inference import Audio2Beats

    torch.set_num_threads(max(1, threads))
    device = choose_device(preference)
    model = Audio2Beats(checkpoint_path=str(CHECKPOINT), device=device.name, dbn=False)

    def track(samples: Samples) -> Sequence[float]:
        beats, _ = model(samples, SAMPLE_RATE)
        if device.name == "cuda":
            torch.cuda.synchronize()
        return [float(beat) for beat in beats]

    return track, device
