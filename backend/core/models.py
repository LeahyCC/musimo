import re
from typing import Literal
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.core.audio_recipes import check_recipe_setting
from backend.core.naming import Naming
from backend.core.sources import toggle_ids

# A Deezer account cookie is 192 hex characters. Anything else is not one.
ARL = re.compile(r"[a-fA-F0-9]{192}")


def clean_arl(value: str) -> str:
    value = value.strip()
    if value and ARL.fullmatch(value) is None:
        raise ValueError("Paste the arl cookie from a Deezer login. It is 192 letters and numbers.")
    return value


def clean_disabled(value: list[str]) -> list[str]:
    allowed = set(toggle_ids())
    if any(item not in allowed for item in value):
        raise ValueError("That source cannot be turned off here.")
    return sorted(set(value))


# Catalog songs ask these, in the saved order. A pasted link is already one site, so it is not here.
CATALOG_ORDER = ("deezer", "youtube", "soundcloud")


def clean_order(value: list[str]) -> list[str]:
    if not value:
        raise ValueError("Keep at least one source in the list.")
    if any(item not in CATALOG_ORDER for item in value):
        raise ValueError("That source is not in the catalog list.")
    seen: list[str] = []
    for item in value:
        if item not in seen:
            seen.append(item)
    return seen


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    library_label: str = Field(default="Music", min_length=1, max_length=60)
    ollama_url: str = "http://127.0.0.1:11434"
    ollama_model: str = Field(default="", max_length=200)
    music_timezone: str = "UTC"
    # Which song characteristic rows the bot may read (docs/audio-profile-spec.md). Empty is
    # off: the bot refuses tempo, energy and sound requests and ignores any rows.
    audio_scalar_recipe: str = Field(default="", max_length=80)
    audio_embedding_recipe: str = Field(default="", max_length=80)

    @field_validator("audio_scalar_recipe")
    @classmethod
    def scalar_recipe(cls, value: str) -> str:
        return check_recipe_setting(value, "scalar")

    @field_validator("audio_embedding_recipe")
    @classmethod
    def embedding_recipe(cls, value: str) -> str:
        return check_recipe_setting(value, "embedding")

    @field_validator("ollama_url")
    @classmethod
    def ollama_address(cls, value: str) -> str:
        parsed = urlsplit(value)
        if (
            len(value) > 500
            or parsed.scheme not in {"http", "https"}
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Use an Ollama http(s) server address without credentials or a path.")
        _ = parsed.port
        return value.rstrip("/")

    @field_validator("music_timezone")
    @classmethod
    def timezone_name(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("Use a time zone such as Pacific/Honolulu or Europe/London.") from exc
        return value

    output_format: Literal["original", "m4a", "opus", "mp3"] = "original"
    concurrency: int = Field(default=2, ge=1, le=3)
    max_attempts: int = Field(default=4, ge=1, le=4)
    retry_base_seconds: int = Field(default=2, ge=1, le=30)
    retry_cap_seconds: int = Field(default=60, ge=30, le=300)
    # How many tracks may finish before a wait. 0, or a wait of 0, means no pause.
    pace_tracks: int = Field(default=0, ge=0, le=500)
    # Minutes to wait after that many tracks have finished, before the next ones start.
    pace_minutes: int = Field(default=0, ge=0, le=1440)
    destination: str = "/music"
    naming_template: str = "{album_artist}/{album}/{track:02d} - {title}"
    # Search. Off turns search off. Album pages, track details and catalog downloads still use
    # the catalog, because a download needs the track's details.
    deezer_catalog: bool = True
    # Save the account's own file when a cookie is set. Off leaves catalog tracks to other sources.
    deezer_audio: bool = True
    # Link sites and podcasts that are turned off. YouTube and SoundCloud live here too.
    disabled_sources: list[str] = Field(default_factory=list)
    # Who a catalog song asks, first to last. After the last one, the list starts again.
    source_order: list[str] = Field(default_factory=lambda: ["deezer", "youtube"])
    # Download failures on the current source before the next one. A search with no song moves on.
    tries_per_source: int = Field(default=1, ge=1, le=4)

    @field_validator("naming_template")
    @classmethod
    def template(cls, value: str) -> str:
        return Naming.validate(value)

    @field_validator("disabled_sources")
    @classmethod
    def disabled_value(cls, value: list[str]) -> list[str]:
        return clean_disabled(value)

    @field_validator("source_order")
    @classmethod
    def order_value(cls, value: list[str]) -> list[str]:
        return clean_order(value)


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    library_label: str | None = Field(default=None, min_length=1, max_length=60)
    ollama_url: str | None = Field(default=None, max_length=500)
    ollama_model: str | None = Field(default=None, max_length=200)
    music_timezone: str | None = Field(default=None, max_length=100)
    audio_scalar_recipe: str | None = Field(default=None, max_length=80)
    audio_embedding_recipe: str | None = Field(default=None, max_length=80)
    output_format: Literal["original", "m4a", "opus", "mp3"] | None = None
    concurrency: int | None = Field(default=None, ge=1, le=3)
    max_attempts: int | None = Field(default=None, ge=1, le=4)
    retry_base_seconds: int | None = Field(default=None, ge=1, le=30)
    retry_cap_seconds: int | None = Field(default=None, ge=30, le=300)
    pace_tracks: int | None = Field(default=None, ge=0, le=500)
    pace_minutes: int | None = Field(default=None, ge=0, le=1440)
    destination: str | None = None
    naming_template: str | None = None
    # The Deezer cookie. It goes to its own file, never the settings table. Empty removes it.
    deezer_arl: str | None = None
    deezer_catalog: bool | None = None
    deezer_audio: bool | None = None
    disabled_sources: list[str] | None = None
    source_order: list[str] | None = None
    tries_per_source: int | None = Field(default=None, ge=1, le=4)

    @field_validator("audio_scalar_recipe")
    @classmethod
    def scalar_recipe(cls, value: str | None) -> str | None:
        return None if value is None else check_recipe_setting(value, "scalar")

    @field_validator("audio_embedding_recipe")
    @classmethod
    def embedding_recipe(cls, value: str | None) -> str | None:
        return None if value is None else check_recipe_setting(value, "embedding")

    @field_validator("deezer_arl")
    @classmethod
    def arl_value(cls, value: str | None) -> str | None:
        return None if value is None else clean_arl(value)

    @field_validator("disabled_sources")
    @classmethod
    def disabled_value(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else clean_disabled(value)

    @field_validator("source_order")
    @classmethod
    def order_value(cls, value: list[str] | None) -> list[str] | None:
        return None if value is None else clean_order(value)
