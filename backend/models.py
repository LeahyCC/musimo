import re
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.naming import Naming
from backend.sources import toggle_ids

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
    if any(item not in CATALOG_ORDER for item in value):
        raise ValueError("That source is not in the catalog list.")
    seen: list[str] = []
    for item in value:
        if item not in seen:
            seen.append(item)
    return seen


def clean_navidrome_url(value: str) -> str:
    if not value:
        return value
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Use a plain http or https Navidrome URL without credentials or a query")
    return value.rstrip("/")


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    library_label: str = Field(default="Music", min_length=1, max_length=60)
    output_format: Literal["original", "m4a", "opus", "mp3"] = "original"
    concurrency: int = Field(default=2, ge=1, le=3)
    max_attempts: int = Field(default=4, ge=1, le=4)
    retry_base_seconds: int = Field(default=2, ge=1, le=30)
    retry_cap_seconds: int = Field(default=60, ge=30, le=300)
    destination: str = "/music"
    naming_template: str = "{album_artist}/{album}/{track:02d} - {title}"
    # Search SoundCloud for a catalog track when YouTube has no match or cannot be used. Off
    # until the match benchmark has measured SoundCloud precision.
    soundcloud_fallback: bool = False
    # Empty, or a Deezer arl cookie. Editable in Settings, so a new cookie does not need a rebuild.
    deezer_arl: str = ""
    # Search, album pages and track details. Off means the catalog is not asked.
    deezer_catalog: bool = True
    # Save the account's own file when a cookie is set. Off leaves catalog tracks to other sources.
    deezer_audio: bool = True
    # Link sites and podcasts that are turned off. YouTube and SoundCloud live here too.
    disabled_sources: list[str] = Field(default_factory=list)
    # Who a catalog song asks, first to last. After the last one, the list starts again.
    source_order: list[str] = Field(default_factory=lambda: ["deezer", "youtube"])
    # Download failures on the current source before the next one. A search with no song moves on.
    tries_per_source: int = Field(default=1, ge=1, le=4)
    navidrome_url: str = ""
    navidrome_mode: Literal["off", "watcher", "api"] = "off"
    navidrome_library_id: int = Field(default=1, ge=1)

    @field_validator("naming_template")
    @classmethod
    def template(cls, value: str) -> str:
        return Naming.validate(value)

    @field_validator("deezer_arl")
    @classmethod
    def arl_value(cls, value: str) -> str:
        return clean_arl(value)

    @field_validator("disabled_sources")
    @classmethod
    def disabled_value(cls, value: list[str]) -> list[str]:
        return clean_disabled(value)

    @field_validator("source_order")
    @classmethod
    def order_value(cls, value: list[str]) -> list[str]:
        return clean_order(value)

    @field_validator("navidrome_url")
    @classmethod
    def navidrome_address(cls, value: str) -> str:
        return clean_navidrome_url(value)


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    library_label: str | None = Field(default=None, min_length=1, max_length=60)
    output_format: Literal["original", "m4a", "opus", "mp3"] | None = None
    concurrency: int | None = Field(default=None, ge=1, le=3)
    max_attempts: int | None = Field(default=None, ge=1, le=4)
    retry_base_seconds: int | None = Field(default=None, ge=1, le=30)
    retry_cap_seconds: int | None = Field(default=None, ge=30, le=300)
    destination: str | None = None
    naming_template: str | None = None
    soundcloud_fallback: bool | None = None
    deezer_arl: str | None = None
    deezer_catalog: bool | None = None
    deezer_audio: bool | None = None
    disabled_sources: list[str] | None = None
    source_order: list[str] | None = None
    tries_per_source: int | None = Field(default=None, ge=1, le=4)
    navidrome_url: str | None = None
    navidrome_mode: Literal["off", "watcher", "api"] | None = None
    navidrome_library_id: int | None = Field(default=None, ge=1)

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

    @field_validator("navidrome_url")
    @classmethod
    def navidrome_address(cls, value: str | None) -> str | None:
        return clean_navidrome_url(value) if value is not None else None
