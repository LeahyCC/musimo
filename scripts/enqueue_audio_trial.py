"""Queue songs for the audio worker. This is the only way work gets queued.

    uv run python -m scripts.enqueue_audio_trial --recipe tempo-energy-v1 --limit 100

Inside the container: docker compose exec musimo python -m scripts.enqueue_audio_trial ...

Songs without a done row measured from the file as it is now are queued, newest files first.
Failed and skipped songs count as lacking one, so they are tried again. `--all` is the
full-library scan: it prints how many songs that is and stops unless `--yes` is given too.
Nothing here starts the worker.
"""

import argparse
import os
from pathlib import Path

from backend.core.audio_recipes import SCALAR_RECIPE, recipe_for
from backend.core.store import Store
from backend.library.audio_profile import AudioProfiles


def enqueue(store: Store, recipe: str, limit: int | None) -> int:
    """Queue up to `limit` songs (None for every one). Returns how many were added."""
    return AudioProfiles(store).enqueue(recipe, limit)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--recipe", default=SCALAR_RECIPE, help=f"default {SCALAR_RECIPE}")
    parser.add_argument("--limit", type=int, default=100, help="songs to queue, default 100")
    parser.add_argument("--all", action="store_true", help="queue every song lacking a row")
    parser.add_argument("--yes", action="store_true", help="with --all, actually queue them")
    parser.add_argument(
        "--data",
        default=os.environ.get("MUSIMO_DATA_DIR", "/data"),
        help="the data directory holding musimo.sqlite3",
    )
    args = parser.parse_args(argv)
    if recipe_for(args.recipe) is None:
        parser.error(f"{args.recipe} is not a registered recipe")
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    store = Store(Path(args.data) / "musimo.sqlite3")
    try:
        profiles = AudioProfiles(store)
        if args.all:
            lacking = profiles.lacking(args.recipe)
            if not args.yes:
                print(
                    f"{lacking} songs lack a fresh {args.recipe} row and are not queued. "
                    "That is a full-library scan. Add --yes to queue them all."
                )
                return 1
            added = profiles.enqueue(args.recipe, None)
        else:
            added = profiles.enqueue(args.recipe, args.limit)
        print(f"Queued {added} songs for {args.recipe}. {profiles.queued(args.recipe)} waiting.")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
