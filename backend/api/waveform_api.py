from collections.abc import Callable

from fastapi import FastAPI, HTTPException

from backend.api.player_api import checked_id
from backend.library.waveform import WaveformBusy, WaveformService, WaveformUnavailable


def install_waveform_routes(app: FastAPI, get: Callable[[], WaveformService]) -> None:
    @app.get("/api/player/waveform/{song_id}")
    async def waveform(song_id: str) -> dict[str, object]:
        try:
            return {"peaks": await get().peaks(checked_id(song_id))}
        except WaveformUnavailable as exc:
            raise HTTPException(404, str(exc)) from exc
        except WaveformBusy as exc:
            raise HTTPException(503, str(exc), headers={"Retry-After": "10"}) from exc
