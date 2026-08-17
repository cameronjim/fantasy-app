"""reference implementation of the waiver-wire watchlist rules.

=========================== KEEP IN SYNC ===========================
this module and backend/src/services/watchlist.ts implement THE SAME RULES and
must agree exactly. the TypeScript version is what ships to /api/watchlist;
this one is what notebooks, backtests and threshold-tuning work run against.

changing a threshold in one file without changing it in the other means the
analysis that justified a rule and the page that applies it are describing
different rules. every constant below has a named counterpart in the .ts file.
====================================================================

the rules are deliberately DETERMINISTIC - rolling means, calendar gaps and
injury statuses, nothing learned. a manager can check any code on the page
against a box score, and the same code computed here against the same inputs
gives the same answer. the model's only role is scaling: `score` multiplies
the rule weight by the probability the player is actually available.

pure functions over plain data. no io, no model, no pandas requirement.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date

# ---- reason codes (mirrors REASON_CODES in watchlist.ts) ----
ROLE_INCREASE = "ROLE_INCREASE"
SHOT_VOLUME_SURGE = "SHOT_VOLUME_SURGE"
RETURNING_FROM_ABSENCE = "RETURNING_FROM_ABSENCE"
HOT_STREAK = "HOT_STREAK"
TEAMMATE_ABSENCE = "TEAMMATE_ABSENCE"

REASON_CODES: tuple[str, ...] = (
    ROLE_INCREASE,
    SHOT_VOLUME_SURGE,
    RETURNING_FROM_ABSENCE,
    HOT_STREAK,
    TEAMMATE_ABSENCE,
)

# ---- thresholds (mirrors the exported constants in watchlist.ts) ----

#: minutes the last-5 average must exceed the last-15 average by.
ROLE_INCREASE_MIN_DELTA = 4.0

#: field-goal attempts the last-5 average must exceed the last-15 average by.
SHOT_VOLUME_SURGE_FGA_DELTA = 2.5

#: days between the two most recent appearances that count as an absence.
RETURN_GAP_DAYS = 7

#: multiples of the player's OWN game-to-game stddev that count as a hot streak.
HOT_STREAK_STDDEV_MULTIPLE = 1.5

#: minutes per game a sidelined teammate must average to open real usage.
TEAMMATE_ABSENCE_MIN_MINUTES = 28.0

#: the only injury status that reliably means "will not play".
TEAMMATE_ABSENCE_STATUS = "Out"

#: season scoring average at or above which a player is not a discovery.
STAR_EXCLUSION_PPG = 20.0

#: how many candidates the list returns.
WATCHLIST_LIMIT = 20

#: relative weight of each reason, ordered by how directly the signal implies
#: future production. minutes already granted outrank points that may not repeat.
REASON_WEIGHTS: dict[str, float] = {
    ROLE_INCREASE: 3.0,
    TEAMMATE_ABSENCE: 2.5,
    SHOT_VOLUME_SURGE: 2.0,
    RETURNING_FROM_ABSENCE: 1.5,
    HOT_STREAK: 1.0,
}


@dataclass(frozen=True)
class Teammate:
    """a rostered teammate, for the absence rule."""

    name: str
    minutes_per_game: float | None
    injury_status: str | None


@dataclass(frozen=True)
class Candidate:
    """everything the rules need about one player. plain data, no db types."""

    nba_player_id: str
    name: str
    team_abbr: str | None = None
    #: season points per game, used ONLY for the star exclusion.
    season_ppg: float | None = None
    min_r5: float | None = None
    min_r15: float | None = None
    fga_r5: float | None = None
    fga_r15: float | None = None
    pts_r5: float | None = None
    pts_season: float | None = None
    pts_stddev: float | None = None
    #: days between the two most recent appearances; None with fewer than two.
    gap_days: int | None = None
    #: whether the most recent appearance was an actual appearance.
    played_last_game: bool = False
    last_game_date: date | None = None
    #: teammates OTHER than this player. the caller filters self out.
    teammates: tuple[Teammate, ...] = ()
    prob_active: float | None = None


@dataclass(frozen=True)
class ScoredCandidate:
    """a candidate that fired at least one rule."""

    nba_player_id: str
    name: str
    team_abbr: str | None
    score: float
    prob_active: float | None
    reasons: tuple[str, ...]
    evidence: dict[str, object] = field(default_factory=dict)


def has_role_increase(min_r5: float | None, min_r15: float | None) -> bool:
    """both windows are needed - no 15-game baseline means no trend."""
    if min_r5 is None or min_r15 is None:
        return False
    return min_r5 - min_r15 >= ROLE_INCREASE_MIN_DELTA


def has_shot_volume_surge(fga_r5: float | None, fga_r15: float | None) -> bool:
    """shots, not minutes: a player can be on the floor without the ball."""
    if fga_r5 is None or fga_r15 is None:
        return False
    return fga_r5 - fga_r15 >= SHOT_VOLUME_SURGE_FGA_DELTA


def is_returning_from_absence(gap_days: int | None, played_last_game: bool) -> bool:
    """a long gap FOLLOWED BY an appearance.

    both halves matter: the gap on its own describes someone still hurt, which
    is the opposite of a pickup.
    """
    if gap_days is None:
        return False
    return gap_days >= RETURN_GAP_DAYS and played_last_game


def is_hot_streak(
    pts_r5: float | None, season_avg: float | None, stddev: float | None
) -> bool:
    """scored against the player's OWN volatility, not a fixed point total.

    +4 points from a metronome is a real change; +4 from someone who swings 12
    a night is Tuesday. a zero or missing stddev has nothing to scale by, so it
    never fires - otherwise every positive delta would read as "hot".
    """
    if pts_r5 is None or season_avg is None or stddev is None or stddev <= 0:
        return False
    return pts_r5 - season_avg >= HOT_STREAK_STDDEV_MULTIPLE * stddev


def find_absent_teammate(teammates: Iterable[Teammate]) -> Teammate | None:
    """the highest-minutes teammate who is ruled Out and plays a real role.

    highest minutes wins because that is the usage actually up for grabs.
    """
    best: Teammate | None = None
    for mate in teammates:
        if mate.injury_status != TEAMMATE_ABSENCE_STATUS:
            continue
        if mate.minutes_per_game is None:
            continue
        if mate.minutes_per_game < TEAMMATE_ABSENCE_MIN_MINUTES:
            continue
        if best is None or mate.minutes_per_game > (best.minutes_per_game or 0.0):
            best = mate
    return best


def is_discovery_candidate(season_ppg: float | None) -> bool:
    """established scorers are excluded - they are rostered everywhere already.

    an unknown average stays in: "no season line yet" describes exactly the
    rookie or call-up this list exists to surface.
    """
    if season_ppg is None:
        return True
    return season_ppg < STAR_EXCLUSION_PPG


def reasons_for(candidate: Candidate) -> tuple[str, ...]:
    """every reason that fires, in REASON_CODES order."""
    reasons: list[str] = []
    if has_role_increase(candidate.min_r5, candidate.min_r15):
        reasons.append(ROLE_INCREASE)
    if has_shot_volume_surge(candidate.fga_r5, candidate.fga_r15):
        reasons.append(SHOT_VOLUME_SURGE)
    if is_returning_from_absence(candidate.gap_days, candidate.played_last_game):
        reasons.append(RETURNING_FROM_ABSENCE)
    if is_hot_streak(candidate.pts_r5, candidate.pts_season, candidate.pts_stddev):
        reasons.append(HOT_STREAK)
    if find_absent_teammate(candidate.teammates) is not None:
        reasons.append(TEAMMATE_ABSENCE)
    return tuple(reasons)


def evidence_for(candidate: Candidate, reasons: Sequence[str]) -> dict[str, object]:
    """the supporting numbers for the reasons that fired, and no others."""
    evidence: dict[str, object] = {}
    fired = set(reasons)

    if ROLE_INCREASE in fired and candidate.min_r5 is not None and candidate.min_r15 is not None:
        evidence["min_r5"] = round(candidate.min_r5, 1)
        evidence["min_r15"] = round(candidate.min_r15, 1)
        evidence["min_delta"] = round(candidate.min_r5 - candidate.min_r15, 1)

    if (
        SHOT_VOLUME_SURGE in fired
        and candidate.fga_r5 is not None
        and candidate.fga_r15 is not None
    ):
        evidence["fga_r5"] = round(candidate.fga_r5, 1)
        evidence["fga_r15"] = round(candidate.fga_r15, 1)
        evidence["fga_delta"] = round(candidate.fga_r5 - candidate.fga_r15, 1)

    if RETURNING_FROM_ABSENCE in fired and candidate.gap_days is not None:
        evidence["gap_days"] = candidate.gap_days
        if candidate.last_game_date is not None:
            evidence["last_game_date"] = candidate.last_game_date.isoformat()

    if (
        HOT_STREAK in fired
        and candidate.pts_r5 is not None
        and candidate.pts_season is not None
        and candidate.pts_stddev is not None
    ):
        evidence["pts_r5"] = round(candidate.pts_r5, 1)
        evidence["pts_season"] = round(candidate.pts_season, 1)
        evidence["pts_stddev"] = round(candidate.pts_stddev, 1)
        evidence["pts_delta"] = round(candidate.pts_r5 - candidate.pts_season, 1)

    if TEAMMATE_ABSENCE in fired:
        mate = find_absent_teammate(candidate.teammates)
        if mate is not None:
            evidence["teammate_out"] = mate.name
            evidence["teammate_out_minutes"] = round(mate.minutes_per_game or 0.0, 1)

    return evidence


def score_for(reasons: Sequence[str], prob_active: float | None) -> float:
    """weighted reason count, scaled by the chance the player suits up.

    with no prediction run the score degrades to the reason weights alone
    rather than to zero: the rules are still true, we just cannot discount
    them. prob_active is clamped to [0, 1] so a malformed prediction can never
    inflate a player above the rules that justify them.
    """
    weight = sum(REASON_WEIGHTS[reason] for reason in reasons)
    scale = 1.0 if prob_active is None else min(1.0, max(0.0, prob_active))
    return round(weight * scale, 3)


def rank_candidates(
    candidates: Iterable[Candidate], limit: int = WATCHLIST_LIMIT
) -> list[ScoredCandidate]:
    """candidates with at least one reason, best score first, capped at limit.

    ties break on reason count then name, so the order is stable across runs
    rather than dependent on input order.
    """
    ranked: list[ScoredCandidate] = []
    for candidate in candidates:
        if not is_discovery_candidate(candidate.season_ppg):
            continue
        reasons = reasons_for(candidate)
        if not reasons:
            continue
        ranked.append(
            ScoredCandidate(
                nba_player_id=candidate.nba_player_id,
                name=candidate.name,
                team_abbr=candidate.team_abbr,
                score=score_for(reasons, candidate.prob_active),
                prob_active=candidate.prob_active,
                reasons=reasons,
                evidence=evidence_for(candidate, reasons),
            )
        )

    ranked.sort(key=lambda c: (-c.score, -len(c.reasons), c.name))
    return ranked[:limit]


def day_gap(later: date | None, earlier: date | None) -> int | None:
    """whole days between two calendar days, or None when either is missing."""
    if later is None or earlier is None:
        return None
    return (later - earlier).days
