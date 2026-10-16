"""Musimo's audio worker: leases one song at a time from the app and measures it.

It never opens the database. The app hands it a path, a size and a modification time; it
decodes three short sections with FFmpeg, measures them, and posts the result back under the
same lease. The recipe lives in `recipe.py`; the loop in `__main__.py`.
"""
