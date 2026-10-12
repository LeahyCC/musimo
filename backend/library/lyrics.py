import re

LRC_LINE = re.compile(r"^\[(\d+):(\d+(?:\.\d+)?)\](.*)$")


def lyric_lines(synced: str, plain: str) -> tuple[list[dict[str, object]], bool]:
    lines: list[dict[str, object]] = []
    for raw in synced.splitlines():
        match = LRC_LINE.match(raw)
        if not match:
            continue
        start = round((int(match.group(1)) * 60 + float(match.group(2))) * 1000)
        lines.append({"start": start, "value": match.group(3).strip()})
    if lines:
        return lines, True
    return [{"value": line} for line in plain.splitlines() if line.strip()], False
