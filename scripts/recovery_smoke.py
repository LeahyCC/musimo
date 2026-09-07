"""Kill and restart a disposable Docker app during a generated-audio album batch."""

import argparse
import json
import shutil
import sqlite3
import subprocess
import tempfile
import time
import uuid
from contextlib import closing
from pathlib import Path, PurePosixPath

import httpx

from backend.downloads import digest
from backend.job_models import RUNNING, Metadata
from backend.job_store import Jobs
from backend.store import Store


def seed() -> None:
    store = Store(Path("/data/musimo.sqlite3"))
    try:
        store.update({"concurrency": 3, "navidrome_mode": "off"})
        store.db.execute("UPDATE queue_control SET paused=1")
        source = Path("/tmp/fixture.opus")
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=30",
                "-c:a",
                "libopus",
                str(source),
            ],
            check=True,
            capture_output=True,
        )
        jobs = Jobs(store, lambda: None)
        for job in jobs.enqueue_many(list(range(1, 13)), "mp3", "/music", "recovery-album"):
            jobs.update(
                job.id,
                meta=Metadata(
                    id=job.track_id,
                    title=f"Recovery {job.track_id:02d}",
                    artist="Generated Artist",
                    album_artist="Generated Artist",
                    album="Recovery Album",
                    track=job.track_id,
                    tracks=12,
                    duration=30,
                ).model_dump(),
            )
            folder = Path("/music/.musimo") / job.id
            folder.mkdir(parents=True)
            shutil.copyfile(source, folder / "source.opus")
            (folder / "download.json").write_text(
                json.dumps({"selected": "", "file": "source.opus"}), encoding="utf-8"
            )
    finally:
        store.close()


def docker(*arguments: str) -> str:
    return subprocess.run(
        ["docker", *arguments], check=True, capture_output=True, text=True, timeout=120
    ).stdout.strip()


def wait_ready(client: httpx.Client) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if client.get("/api/health").is_success:
                return
        except httpx.HTTPError:
            pass
        time.sleep(0.1)
    raise TimeoutError("Disposable application did not become ready")


def run(image: str) -> dict[str, object]:
    name = "musimo-recovery-" + uuid.uuid4().hex[:8]
    with tempfile.TemporaryDirectory(prefix="musimo-recovery-") as temporary:
        root = Path(temporary).resolve()
        data, music = root / "data", root / "music"
        data.mkdir()
        music.mkdir()
        mounts = [
            "--mount",
            f"type=bind,source={data},target=/data",
            "--mount",
            f"type=bind,source={music},target=/music",
        ]
        script = Path(__file__).resolve()
        docker(
            "run",
            "--rm",
            *mounts,
            "--mount",
            f"type=bind,source={script},target=/checks/recovery_smoke.py,readonly",
            "-e",
            "PYTHONPATH=/app",
            image,
            "python",
            "/checks/recovery_smoke.py",
            "--seed",
        )
        try:
            docker("run", "-d", "--name", name, "--init", "-p", "127.0.0.1::8765", *mounts, image)
            port = docker("port", name, "8765/tcp").rsplit(":", 1)[1]
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=3) as client:
                wait_ready(client)
                before = client.get("/api/jobs").json()["jobs"]
                assert len(before) == 12
                client.post("/api/queue/resume").raise_for_status()
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if any(
                        row["stage"] in RUNNING for row in client.get("/api/jobs").json()["jobs"]
                    ):
                        break
                    time.sleep(0.01)
                else:
                    raise AssertionError("No active work was observed before the kill")
                docker("kill", "--signal", "KILL", name)
                with closing(
                    sqlite3.connect((data / "musimo.sqlite3").as_uri() + "?mode=ro", uri=True)
                ) as db:
                    killed = [json.loads(row[0]) for row in db.execute("SELECT payload FROM jobs")]
                interrupted = [row["id"] for row in killed if row["stage"] in RUNNING]
                assert interrupted, "No running job was actually interrupted"
                started = time.perf_counter()
                docker("start", name)
                # Docker may assign a different ephemeral host port after a restart.
                port = docker("port", name, "8765/tcp").rsplit(":", 1)[1]
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=3) as client:
                wait_ready(client)
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline:
                    rows = client.get("/api/jobs").json()["jobs"]
                    assert not [row for row in rows if row["stage"] == "failed"], rows
                    if len(rows) == 12 and all(row["stage"] == "done" for row in rows):
                        break
                    time.sleep(0.05)
                else:
                    raise TimeoutError("Recovered jobs did not finish")
                elapsed = time.perf_counter() - started
                assert {row["id"] for row in rows} == {row["id"] for row in before}
                assert client.get("/api/library").json()["total_files"] == 12
                assert len(list(music.rglob("*.mp3"))) == 12
                for row in rows:
                    final = music.joinpath(
                        *PurePosixPath(row["final_path"]).relative_to("/music").parts
                    )
                    assert digest(final) == row["artifact_hash"]
                return {
                    "fixture": "12 generated 30-second tones converted to MP3",
                    "completed": 12,
                    "interrupted_jobs": len(interrupted),
                    "same_job_ids": True,
                    "indexed": 12,
                    "duplicate_files": 0,
                    "restart_to_finished_seconds": round(elapsed, 3),
                    "provider_downloads": False,
                }
        finally:
            docker("rm", "-f", name)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--image", default="musimo:ci")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.seed:
        seed()
        return
    if not args.output:
        parser.error("--output is required")
    report = run(args.image)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
