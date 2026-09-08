"""Bounded, offline musical analysis. Invoked in its own process, never on the API loop."""

import gzip
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import TypedDict

import librosa
import numpy as np
import numpy.typing as npt
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

FloatArray = npt.NDArray[np.float64]


class Section(TypedDict):
    start: float
    end: float
    identity: int
    energy: float


class SongMap(TypedDict):
    version: int
    duration: float
    hop: float
    energy: list[float]
    bass: list[float]
    body: list[float]
    air: list[float]
    beats: list[float]
    confidence: float
    sections: list[Section]


def unit_curve(values: FloatArray) -> list[float]:
    scale = max(float(np.percentile(values, 97)), 0.00001)
    return [round(float(value), 4) for value in np.clip(values / scale * 0.85, 0, 1)]


def analyse(source: Path) -> SongMap:
    # Local files only: FFmpeg must never receive a stream URL containing credentials.
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe,crypto",
            "-i",
            str(source),
            "-t",
            "1800",
            "-ac",
            "1",
            "-ar",
            "22050",
            "-f",
            "f32le",
            "pipe:1",
        ],
        capture_output=True,
        check=True,
        timeout=120,
    )
    signal = np.frombuffer(result.stdout, dtype="<f4")
    if signal.size < 22050:
        raise ValueError("Recording is too short to analyse")
    sr, hop = 22050, 512
    duration = float(signal.size / sr)
    spectrum = np.abs(librosa.stft(signal, n_fft=2048, hop_length=hop))
    frequencies = librosa.fft_frequencies(sr=sr, n_fft=2048)
    rms = np.sqrt(np.mean(spectrum.astype(np.float64) ** 2, axis=0))
    energy = unit_curve(gaussian_filter1d(rms, 3)[::2])
    curves = []
    for lower, upper in [(25, 220), (220, 2600), (2600, 11025)]:
        band = spectrum[(frequencies >= lower) & (frequencies < upper)]
        curves.append(unit_curve(np.sqrt(np.mean(band.astype(np.float64) ** 2, axis=0))[::2]))

    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spectrum), sr=sr, hop_length=hop)
    _, beat_times = librosa.beat.beat_track(
        onset_envelope=onset, sr=sr, hop_length=hop, units="time"
    )
    beats = [round(float(value), 4) for value in beat_times if value < duration]
    intervals = np.diff(beat_times)
    # This is a pulse-regularity heuristic, not a calibrated downbeat probability.
    confidence = (
        float(np.clip(1 - np.std(intervals) / max(float(np.mean(intervals)), 0.001) * 3, 0, 1))
        if len(intervals) > 5
        else 0.0
    )
    if float(np.max(np.abs(signal))) < 0.001:
        confidence = 0.0
        beats = []

    chroma = librosa.feature.chroma_stft(S=spectrum**2, sr=sr, hop_length=hop, tuning=0)
    step = max(1, round(sr / hop))
    blocks = [
        np.mean(chroma[:, start : start + step], axis=1)
        for start in range(0, chroma.shape[1], step)
    ]
    fingerprints = np.asarray(blocks, dtype=np.float64)
    coarse_energy = np.array(
        [float(np.mean(rms[start : start + step])) for start in range(0, len(rms), step)]
    )
    norms = np.maximum(np.linalg.norm(fingerprints, axis=1, keepdims=True), 1e-8)
    fingerprints /= norms
    harmonic_change = np.maximum(0, 1 - np.sum(fingerprints[1:] * fingerprints[:-1], axis=1))
    coarse_energy /= max(float(np.percentile(coarse_energy, 95)), 1e-8)
    energy_change = np.abs(np.diff(gaussian_filter1d(coarse_energy, 1)))
    novelty = harmonic_change + energy_change
    peaks = (
        find_peaks(novelty, distance=8, prominence=max(0.06, float(np.percentile(novelty, 70))))[0]
        if len(novelty) > 3
        else np.array([], dtype=int)
    )
    boundaries = [0.0] + [round(float((int(index) + 1) * step * hop / sr), 3) for index in peaks]
    boundaries = [value for value in boundaries if value == 0 or value < duration - 3] + [duration]
    sections: list[Section] = []
    references: list[FloatArray] = []
    for start, end in zip(boundaries, boundaries[1:], strict=False):
        first, last = int(start * sr / hop), max(int(end * sr / hop), int(start * sr / hop) + 1)
        fingerprint = np.asarray(np.mean(chroma[:, first:last], axis=1), dtype=np.float64)
        fingerprint /= max(float(np.linalg.norm(fingerprint)), 1e-8)
        matches = [float(np.dot(fingerprint, reference)) for reference in references]
        identity = int(np.argmax(matches)) if matches and max(matches) > 0.985 else len(references)
        if identity == len(references):
            references.append(fingerprint)
        first_curve, last_curve = int(first / 2), max(int(last / 2), int(first / 2) + 1)
        level = float(np.mean(energy[first_curve:last_curve]))
        sections.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "identity": identity,
                "energy": round(level, 4),
            }
        )
    return {
        "version": 1,
        "duration": round(duration, 4),
        "hop": 2 * hop / sr,
        "energy": energy,
        "bass": curves[0],
        "body": curves[1],
        "air": curves[2],
        "beats": beats,
        "confidence": round(confidence, 4),
        "sections": sections,
    }


def main() -> None:
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    mapped = analyse(source)
    temporary = output.with_suffix(".writing")
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        json.dump(mapped, stream, separators=(",", ":"), allow_nan=False)
    os.replace(temporary, output)


if __name__ == "__main__":
    main()
