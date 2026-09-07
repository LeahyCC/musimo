"""Create a tiny generated clip only in runtime/music, then verify index addition and deletion."""

import json
import subprocess
import time
import uuid
from pathlib import Path

import httpx


def main() -> None:
    project = Path(__file__).resolve().parents[1]
    folder = project / "runtime" / "music"
    name = "scanner-test-" + uuid.uuid4().hex + ".flac"
    path = folder / name
    output = project / ".research" / name
    output.parent.mkdir(exist_ok=True)
    subprocess.run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "musimo",
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-t",
            "1",
            "-metadata",
            "title=Scanner fixture",
            "/tmp/" + name,
        ],
        cwd=project,
        check=True,
    )
    subprocess.run(
        ["docker", "compose", "cp", "musimo:/tmp/" + name, str(output)], cwd=project, check=True
    )
    subprocess.run(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            "musimo",
            "python",
            "-c",
            "from pathlib import Path; Path('/tmp/" + name + "').unlink()",
        ],
        cwd=project,
        check=True,
    )
    with httpx.Client(base_url="http://127.0.0.1:8765", timeout=3) as client:
        before = client.get("/api/library").json()
        assert before["status"] != "scanning", "Wait for the library scan to finish"
        baseline = before["total_files"]
        timeout = float(before.get("poll_interval_seconds") or 1) + 12
        report: dict[str, object] = {
            "baseline_files": baseline,
            "poll_interval_seconds": before.get("poll_interval_seconds"),
        }
        try:
            started = time.perf_counter()
            path.write_bytes(output.read_bytes())
            while time.perf_counter() - started < timeout:
                if client.get("/api/library").json()["total_files"] == baseline + 1:
                    report["host_write_to_index_ms"] = round(
                        (time.perf_counter() - started) * 1000, 2
                    )
                    break
                time.sleep(0.05)
            else:
                raise AssertionError(f"Host file write was not indexed within {timeout} seconds")
            started = time.perf_counter()
            path.unlink()
            while time.perf_counter() - started < timeout:
                if client.get("/api/library").json()["total_files"] == baseline:
                    report["host_delete_to_index_ms"] = round(
                        (time.perf_counter() - started) * 1000, 2
                    )
                    break
                time.sleep(0.05)
            else:
                raise AssertionError(f"Host file deletion was not indexed within {timeout} seconds")
            print(json.dumps(report, indent=2))
            (project / "docs/evidence/phase2-watcher.json").write_text(
                json.dumps(report, indent=2) + "\n", encoding="utf-8"
            )
        finally:
            path.unlink(missing_ok=True)
            output.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
