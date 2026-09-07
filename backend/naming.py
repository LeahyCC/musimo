import re
import string
from pathlib import PurePosixPath

from backend.job_models import Metadata


def clean_component(value: str) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value).strip(" .")[:80].rstrip(" .") or "Unknown"
    if text.split(".")[0].upper() in {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{i}" for i in range(1, 10)),
        *(f"LPT{i}" for i in range(1, 10)),
    }:
        text = "_" + text
    return text


class Naming:
    fields = {"title", "artist", "album_artist", "album", "year", "track", "disc"}

    @classmethod
    def validate(cls, template: str) -> str:
        if (
            not template
            or template.startswith(("/", "\\"))
            or "\\" in template
            or len(template) > 240
        ):
            raise ValueError("Use a relative naming template under the selected music folder")
        for _, field, spec, conversion in string.Formatter().parse(template):
            if field is not None and (
                field not in cls.fields
                or conversion
                or spec not in {"", "02d", "03d"}
                or (spec and field not in {"track", "disc"})
            ):
                raise ValueError("Unknown template field or format")
        if (
            any(part in {"", ".", ".."} for part in template.split("/"))
            or len(template.split("/")) > 5
        ):
            raise ValueError("Use one to five named path components")
        return template

    def path(self, template: str, meta: Metadata, extension: str) -> str:
        self.validate(template)
        values: dict[str, str | int] = {
            key: clean_component(str(getattr(meta, key)))
            for key in ("title", "artist", "album_artist", "album")
        }
        values.update(year=meta.date[:4] or "Unknown", track=meta.track, disc=meta.disc)
        rendered = template.format_map(values)
        parts = [clean_component(part) for part in PurePosixPath(rendered).parts]
        return "/".join(parts) + "." + extension
