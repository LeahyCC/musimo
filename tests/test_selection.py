import math
import random
import unittest
from itertools import combinations
from statistics import mean

from backend.library.selection import (
    SEED_LIMIT,
    broad_order,
    gumbel,
    need_for,
    refine_order,
    sample_key,
)

# Every statistical check runs over a fixed range of seeds, so each run is the same computation
# and cannot flake. Bounds sit well clear of the analytic expectation: two uniform draws of L songs
# from a pool of N share L*L/N songs on average.


def ids(count: int) -> list[str]:
    return [f"tr-{index:016x}" for index in range(count)]


def first(count: int, pool: list[str], seed: int, need: int | None = None) -> set[str]:
    return set(broad_order(pool, seed, need or count, None, frozenset()).ids[:count])


class SelectionTests(unittest.TestCase):
    def test_the_draw_is_fixed_for_a_seed_and_a_song(self) -> None:
        # Logged seeds must keep meaning the same selection, so the hash is pinned.
        self.assertEqual(sample_key(0, "tr-0000000000000000"), sample_key(0, "tr-0000000000000000"))
        self.assertEqual(sample_key(0, "tr-0000000000000000"), PINNED_KEY)
        self.assertNotEqual(
            sample_key(0, "tr-0000000000000000"), sample_key(1, "tr-0000000000000000")
        )
        # The extremes stay finite; 53 or more bits would round the uniform to 1.0.
        self.assertTrue(math.isfinite(gumbel(0)))
        self.assertTrue(math.isfinite(gumbel(2**64 - 1)))
        self.assertLess(gumbel(0), gumbel(2**64 - 1))
        for seed in (0, SEED_LIMIT - 1):
            self.assertEqual(len(broad_order(ids(5), seed, 2, None, frozenset()).ids), 5)

    def test_the_order_ignores_input_order_and_other_songs(self) -> None:
        pool = ids(60)
        relevance = {sid: round(0.9 - index * 0.01, 6) for index, sid in enumerate(pool)}
        shown = frozenset(pool[::7])
        shuffler = random.Random(3)
        for seed in range(10):
            for fit in (None, relevance):
                expected = broad_order(pool, seed, 10, fit, shown)
                for _ in range(5):
                    mixed = pool[:]
                    shuffler.shuffle(mixed)
                    self.assertEqual(broad_order(mixed, seed, 10, fit, shown), expected)
            # Removing one song from an equally fitting pool leaves the others' order alone.
            whole = broad_order(pool, seed, 10, None, frozenset()).ids
            gone = pool[seed]
            self.assertEqual(
                broad_order([sid for sid in pool if sid != gone], seed, 10, None, frozenset()).ids,
                [sid for sid in whole if sid != gone],
            )
            # The output is always every song once.
            self.assertEqual(sorted(whole), sorted(pool))

    def test_equally_fitting_songs_give_different_sets(self) -> None:
        pool = ids(400)
        sets = [first(20, pool, seed) for seed in range(50)]
        overlaps = [len(a & b) for a, b in zip(sets, sets[1:], strict=False)]
        self.assertTrue(all(a != b for a, b in zip(sets, sets[1:], strict=False)))
        self.assertLessEqual(mean(overlaps), 2.5)  # expected 1.0
        self.assertLessEqual(max(len(a & b) for a, b in combinations(sets, 2)), 8)
        pool = ids(1000)
        sets = [first(20, pool, seed) for seed in range(1, 41)]
        self.assertEqual(len({frozenset(s) for s in sets}), 40)
        pairwise = [len(a & b) for a, b in combinations(sets, 2)]
        self.assertTrue(0.2 <= mean(pairwise) <= 0.8)  # expected 0.4
        self.assertLessEqual(max(pairwise), 6)
        # Every song of a 60-song pool is reached, none far more often than the rest.
        pool = ids(60)
        counts = dict.fromkeys(pool, 0)
        for seed in range(200):
            for sid in first(10, pool, seed):
                counts[sid] += 1
        self.assertTrue(all(12 <= count <= 60 for count in counts.values()))  # expected 33.3

    def test_a_small_pool_overlaps_as_it_must(self) -> None:
        pool = ids(25)
        sets = [first(20, pool, seed) for seed in range(20)]
        # Two picks of 20 from 25 share at least 15 songs.
        self.assertGreaterEqual(min(len(a & b) for a, b in combinations(sets, 2)), 15)
        self.assertGreaterEqual(len({frozenset(s) for s in sets}), 10)

    def test_shown_songs_go_last_and_stay(self) -> None:
        pool = ids(60)
        for seed in range(1, 200):
            shown = frozenset(first(10, pool, seed - 1))
            drawn = broad_order(pool, seed, 10, None, shown).ids
            self.assertFalse(set(drawn[:10]) & shown)
            self.assertEqual(sorted(drawn), sorted(pool))
        pool = ids(12)
        shown = frozenset(pool[:10])
        drawn = broad_order(pool, 4, 10, None, shown).ids
        self.assertEqual(set(drawn[:2]), set(pool[10:]))
        self.assertEqual(len(drawn), 12)

    def test_relevance_draws_only_near_the_top(self) -> None:
        pool = ids(200)
        relevance = {sid: round(0.95 - 0.004 * index, 6) for index, sid in enumerate(pool)}
        rank = {sid: index for index, sid in enumerate(pool)}
        sets = []
        top = 0
        for seed in range(400):
            drawn = broad_order(pool, seed, 10, relevance, frozenset())
            self.assertTrue(drawn.sampled)
            self.assertLessEqual(drawn.window, 20)
            picks = drawn.ids[:10]
            self.assertTrue(all(rank[sid] < 20 for sid in picks))
            top += pool[0] in picks
            sets.append(set(picks))
        self.assertGreaterEqual(top / 400, 0.7)
        overlaps = [len(a & b) for a, b in zip(sets, sets[1:], strict=False)]
        self.assertTrue(4 <= mean(overlaps) <= 8)
        self.assertLessEqual(sum(a == b for a, b in zip(sets, sets[1:], strict=False)), 8)
        # Shown songs do not widen the window: fresh ones further down are not reached for.
        shown = frozenset(pool[:30])
        for seed in range(50):
            picks = broad_order(pool, seed, 10, relevance, shown).ids[:10]
            self.assertTrue(all(rank[sid] < 20 for sid in picks))

    def test_a_gap_in_relevance_keeps_the_set(self) -> None:
        pool = ids(200)
        relevance = {
            sid: 0.99 if index < 10 else round(0.5 - index * 0.001, 6)
            for index, sid in enumerate(pool)
        }
        sets = {
            frozenset(broad_order(pool, seed, 10, relevance, frozenset()).ids[:10])
            for seed in range(50)
        }
        self.assertEqual(sets, {frozenset(pool[:10])})
        orders = {
            tuple(broad_order(pool, seed, 10, relevance, frozenset()).ids[:10])
            for seed in range(50)
        }
        self.assertGreaterEqual(len(orders), 10)

    def test_a_tie_below_the_top_stays_bounded(self) -> None:
        # Five songs played 10 down to 6 times and a thousand played once, as familiar music.
        pool = ids(1005)
        plays = {sid: (10 - index if index < 5 else 1) for index, sid in enumerate(pool)}
        relevance = {sid: round(math.log1p(count), 6) for sid, count in plays.items()}
        # The window holds the five and fifteen one-play songs, never the whole tie. The five are
        # weighted up to four times as likely, so they usually lead (simulated: 4.05 of them in
        # the first 10, the most played in 86% of draws) while the one-play songs vary widely.
        reached: set[str] = set()
        tops: list[int] = []
        best = 0
        for seed in range(200):
            drawn = broad_order(pool, seed, 10, relevance, frozenset())
            self.assertEqual(drawn.window, 20)
            head = drawn.ids[:10]
            self.assertTrue(set(head) <= set(drawn.ids[:20]))
            tops.append(sum(sid in pool[:5] for sid in head))
            best += pool[0] in head
            reached.update(sid for sid in head if plays[sid] == 1)
        self.assertGreaterEqual(mean(tops), 3.5)
        self.assertGreaterEqual(best / 200, 0.75)
        self.assertGreaterEqual(len(reached), 100)

    def test_a_relevance_pool_that_fits_is_ranked(self) -> None:
        pool = ids(7)
        relevance = {sid: round(0.9 - index * 0.05, 6) for index, sid in enumerate(pool)}
        for seed in range(50):
            drawn = broad_order(pool, seed, 10, relevance, frozenset())
            self.assertEqual(drawn.ids, pool)
            self.assertFalse(drawn.sampled)
        # Exact ties put songs not shown yet first.
        tied = dict.fromkeys(pool, 0.5)
        order = broad_order(pool, 0, 10, tied, frozenset(pool[:3])).ids
        self.assertEqual(set(order[:4]), set(pool[3:]))

    def test_the_order_does_not_lean_to_short_or_long_songs(self) -> None:
        pool = ids(40)
        length = {sid: 120 if index % 2 else 600 for index, sid in enumerate(pool)}
        kept = dict.fromkeys(pool, 0)
        for seed in range(400):
            total = 0
            for sid in broad_order(pool, seed, 10, None, frozenset()).ids:
                kept[sid] += 1
                total += length[sid]
                if total >= 3600:
                    break
        long_share = mean(kept[sid] for sid in pool if length[sid] == 600) / 400
        short_share = mean(kept[sid] for sid in pool if length[sid] == 120) / 400
        self.assertLessEqual(abs(long_share - short_share), 0.05)
        pool = ids(200)
        shares = []
        for seed in range(100):
            head = broad_order(pool, seed, 20, None, frozenset()).ids[:20]
            shares.append(sum(int(sid[3:], 16) % 2 == 0 for sid in head) / 20)
        self.assertTrue(0.4 <= mean(shares) <= 0.6)

    def test_need_for(self) -> None:
        self.assertEqual(need_for(25, 0, 0, [240.0] * 5), 25)
        self.assertEqual(need_for(25, 3, 3600, [240.0] * 5), 3)
        self.assertEqual(need_for(500, 0, 3600, [240.0] * 9), 16)
        self.assertEqual(need_for(10, 0, 3600, [240.0] * 9), 10)
        # One three-hour mix among four-minute songs does not change the estimate.
        self.assertEqual(need_for(500, 0, 3600, [240.0] * 9 + [10800.0]), 16)
        self.assertEqual(need_for(500, 0, 3600, []), 500)

    def test_refining_keeps_the_given_order(self) -> None:
        given = ids(6)[::-1]
        self.assertEqual(refine_order(given + given[:2]), given)

    def test_a_tie_cut_at_the_window_edge_is_still_drawn(self) -> None:
        # 3 songs played 4 times, 9 played twice, 500 once: the window of 20 takes 8 of the
        # one-play songs. Their noise is drawn apart from the tie-break, so they come up at about
        # the designed rate (2.7 of the first 10) rather than never.
        pool = ids(512)
        plays = {sid: 4 if index < 3 else 2 if index < 12 else 1 for index, sid in enumerate(pool)}
        relevance = {sid: round(math.log1p(count), 6) for sid, count in plays.items()}
        once = []
        for seed in range(400):
            drawn = broad_order(pool, seed, 10, relevance, frozenset())
            self.assertEqual(drawn.window, 20)
            once.append(sum(plays[sid] == 1 for sid in drawn.ids[:10]))
        self.assertTrue(1.5 <= mean(once) <= 4.0)

    def test_shown_songs_go_last_inside_a_ranked_window(self) -> None:
        pool = ids(200)
        relevance = {sid: round(0.95 - 0.004 * index, 6) for index, sid in enumerate(pool)}
        shown = frozenset(pool[:5])
        for seed in range(100):
            window = broad_order(pool, seed, 10, relevance, frozenset()).window
            drawn = broad_order(pool, seed, 10, relevance, shown)
            self.assertEqual(drawn.window, window)
            head = drawn.ids[: drawn.window]
            # Every unshown window song comes before every shown one.
            first_shown = min(index for index, sid in enumerate(head) if sid in shown)
            self.assertTrue(all(sid not in shown for sid in head[:first_shown]))
            self.assertEqual(sum(sid in shown for sid in head[first_shown:]), 5)


PINNED_KEY = 10183502919814836492
