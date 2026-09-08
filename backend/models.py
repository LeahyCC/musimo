from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.naming import Naming


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
    navidrome_url: str = ""
    navidrome_mode: Literal["off", "watcher", "api"] = "off"
    navidrome_library_id: int = Field(default=1, ge=1)

    @field_validator("naming_template")
    @classmethod
    def template(cls, value: str) -> str:
        return Naming.validate(value)

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
    navidrome_url: str | None = None
    navidrome_mode: Literal["off", "watcher", "api"] | None = None
    navidrome_library_id: int | None = Field(default=None, ge=1)

    @field_validator("navidrome_url")
    @classmethod
    def navidrome_address(cls, value: str | None) -> str | None:
        return clean_navidrome_url(value) if value is not None else None
