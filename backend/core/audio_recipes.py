"""The recipes a song characteristic row can belong to.

A recipe is a constant in code, not a per-row flag. Its id names a measurement formula: the
worker writes rows under that id, the bot reads rows under the active id, and a changed formula
is a new id so old rows stay readable until the operator switches. `tempo-energy-v1` (librosa)
and `tempo-beat-v1` (Beat This!) are the production recipes, both scalar. Tests may register a
small embedding recipe; nothing in production does.
"""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Literal

RecipeKind = Literal["scalar", "embedding"]
# What a text-aligned embedding recipe turns a phrase into: a list of `dim` floats, unnormalised.
TextEncoder = Callable[[str], list[float]]


@dataclass(frozen=True)
class Recipe:
    id: str
    kind: RecipeKind
    # Vector length. 0 for a scalar recipe, whose rows have a null vector.
    dim: int = 0
    # Whether the vector lives in a space a phrase can be encoded into, so `sound` can rank.
    text_aligned: bool = False
    # Whether a done scalar row may carry energy with no tempo: measured, but not sure enough
    # to use. Such a song answers energy requests and is not covered for tempo.
    tempo_optional: bool = False


SCALAR_RECIPE = "tempo-energy-v1"
# The recipe the Song analysis page measures and switches on.
BEAT_RECIPE = "tempo-beat-v1"

RECIPES: dict[str, Recipe] = {
    SCALAR_RECIPE: Recipe(SCALAR_RECIPE, "scalar"),
    BEAT_RECIPE: Recipe(BEAT_RECIPE, "scalar", tempo_optional=True),
}
_ENCODERS: dict[str, TextEncoder] = {}


def recipe_for(recipe_id: str) -> Recipe | None:
    return RECIPES.get(recipe_id)


def text_encoder(recipe_id: str) -> TextEncoder | None:
    return _ENCODERS.get(recipe_id)


def check_recipe_setting(value: str, kind: RecipeKind) -> str:
    """A settings value: empty is off, anything else must be a registered recipe of this kind."""
    if not value:
        return value
    recipe = RECIPES.get(value)
    if recipe is None or recipe.kind != kind:
        raise ValueError(f"Unknown {kind} recipe. Leave it empty to keep analysis off.")
    return value


@contextmanager
def registered(recipe: Recipe, encoder: TextEncoder | None = None) -> Iterator[Recipe]:
    """Register a recipe for the duration of a test. Production never calls this."""
    if recipe.id in RECIPES:
        raise ValueError(f"{recipe.id} is already registered")
    if encoder is not None and not recipe.text_aligned:
        raise ValueError("Only a text-aligned recipe takes an encoder")
    RECIPES[recipe.id] = recipe
    if encoder is not None:
        _ENCODERS[recipe.id] = encoder
    try:
        yield recipe
    finally:
        RECIPES.pop(recipe.id, None)
        _ENCODERS.pop(recipe.id, None)
