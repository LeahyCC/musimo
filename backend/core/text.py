import unicodedata


def normalize(value: str) -> str:
    return " ".join(
        "".join(
            c if c.isalnum() else " " for c in unicodedata.normalize("NFKC", value).casefold()
        ).split()
    )
