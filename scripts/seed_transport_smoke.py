"""Seed the previously verified open-film transport fixture in an isolated test database."""

from pathlib import Path

from backend.job_models import Metadata
from backend.job_store import Jobs
from backend.store import Store

store = Store(Path("/data/musimo.sqlite3"))
store.update({"concurrency": 1, "navidrome_mode": "off"})
jobs = Jobs(store, lambda: None)
job = jobs.enqueue(1, "original", "/music")
jobs.update(
    job.id,
    meta=Metadata(
        id=1,
        title="Big Buck Bunny transport fixture",
        artist="Blender Foundation",
        album_artist="Blender Foundation",
        album="Transport Test",
        duration=634,
    ).model_dump(),
    selected="aqz-KE-bpKQ",
)
print(job.id)
store.close()
