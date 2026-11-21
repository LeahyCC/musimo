"""Unit tests for the normalize function in backend.core.text."""

import unittest

from backend.core.text import normalize


class TestNormalize(unittest.TestCase):
    """Tests for the normalize function."""

    def test_nfk_c_folding_full_width_chars(self) -> None:
        """Full-width ASCII characters should be folded to their single-width equivalents."""
        self.assertEqual(normalize("ＡＢＣ"), "abc")
        self.assertEqual(normalize("１２３"), "123")

    def test_nfk_c_folding_ligatures(self) -> None:
        """Ligatures should be expanded (e.g., ﬁ → fi)."""
        self.assertEqual(normalize("ﬁle"), "file")
        self.assertEqual(normalize("ﬆop"), "stop")

    def test_casefold_sharp_s(self) -> None:
        """German sharp-s (ß) should fold to ss."""
        self.assertEqual(normalize("Straße"), "strasse")
        self.assertEqual(normalize("straße"), "strasse")

    def test_punctuation_and_symbols_become_spaces(self) -> None:
        """Punctuation and symbols should be converted to spaces."""
        self.assertEqual(normalize("hello,world!"), "hello world")
        self.assertEqual(normalize("test@#$%test"), "test test")
        self.assertEqual(normalize("a+b=c"), "a b c")

    def test_whitespace_handling(self) -> None:
        """Runs of whitespace should be collapsed to a single space and trimmed."""
        self.assertEqual(normalize("  a   b  "), "a b")
        self.assertEqual(normalize("\t\na\n\t"), "a")
        self.assertEqual(normalize("   hello   world   "), "hello world")

    def test_digits_preserved(self) -> None:
        """Digits should be preserved unchanged."""
        self.assertEqual(normalize("a1 b2"), "a1 b2")
        self.assertEqual(normalize("2024"), "2024")

    def test_empty_string(self) -> None:
        """Empty string should remain empty."""
        self.assertEqual(normalize(""), "")


if __name__ == "__main__":
    unittest.main()
