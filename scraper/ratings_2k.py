import logging

import psycopg2
from psycopg2.extras import execute_values

from fetching import _fetch_2k_players
from parsing import _normalize_name, _opt_int, _text_or_none

logger = logging.getLogger(__name__)


def _dedupe_badges(badges: list[dict]) -> list[dict]:
    # at least one card carries the same badge at two tiers, which would violate
    # the (player_slug, badge_name) key. The API lists the strongest tier first,
    # so first-wins keeps the higher one.
    seen: set[str] = set()
    unique: list[dict] = []
    for badge in badges:
        name = _text_or_none(badge.get("name"))
        if not name or name in seen:
            continue
        seen.add(name)
        unique.append(badge)
    return unique


def _upsert_2k_player(cur: psycopg2.extensions.cursor, player: dict) -> None:
    # child rows are deleted and re-inserted rather than upserted, so an
    # attribute or badge 2K dropped this year does not linger. The caller wraps
    # this in a transaction, so a card is never left stripped of its attributes.
    slug = _text_or_none(player.get("slug"))
    name = _text_or_none(player.get("name"))
    if not slug or not name:
        raise ValueError(f"2k card is missing a slug or name: {player.get('slug')!r}")

    positions = ",".join(
        str(pos).strip() for pos in (player.get("positions") or []) if str(pos).strip()
    )

    cur.execute(
        """
        INSERT INTO nba_2k_players (slug, name, normalized_name, team, team_type,
                                    overall, positions, game_version, archetype,
                                    build, height, weight, wingspan, player_image,
                                    updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
            team = EXCLUDED.team, team_type = EXCLUDED.team_type,
            overall = EXCLUDED.overall, positions = EXCLUDED.positions,
            game_version = EXCLUDED.game_version, archetype = EXCLUDED.archetype,
            build = EXCLUDED.build, height = EXCLUDED.height,
            weight = EXCLUDED.weight, wingspan = EXCLUDED.wingspan,
            player_image = EXCLUDED.player_image, updated_at = NOW()
        """,
        (
            slug,
            name,
            # the only join key back to the players table, since 2K publishes no
            # NBA player id. Must match normalizeName in ratings2kParams.ts.
            _normalize_name(name),
            _text_or_none(player.get("team")),
            _text_or_none(player.get("teamType")),
            _opt_int(player.get("overall")),
            _text_or_none(positions),
            _text_or_none(player.get("gameVersion")),
            _text_or_none(player.get("archetype")),
            _text_or_none(player.get("build")),
            _text_or_none(player.get("height")),
            _text_or_none(player.get("weight")),
            _text_or_none(player.get("wingspan")),
            _text_or_none(player.get("playerImage")),
        ),
    )

    cur.execute("DELETE FROM nba_2k_attributes WHERE player_slug = %s", (slug,))
    cur.execute("DELETE FROM nba_2k_badges WHERE player_slug = %s", (slug,))
    cur.execute("DELETE FROM nba_2k_rating_history WHERE player_slug = %s", (slug,))

    attribute_rows = [
        (slug, str(attr_name), _opt_int(value))
        for attr_name, value in sorted((player.get("attributes") or {}).items())
    ]
    if attribute_rows:
        execute_values(
            cur,
            "INSERT INTO nba_2k_attributes (player_slug, attribute_name, value) VALUES %s",
            attribute_rows,
        )

    badge_rows = [
        (
            slug,
            _text_or_none(badge.get("name")),
            _text_or_none(badge.get("tier")),
            _text_or_none(badge.get("category")),
            _text_or_none(badge.get("description")),
            _text_or_none(badge.get("imageUrl")),
        )
        for badge in _dedupe_badges((player.get("badges") or {}).get("list") or [])
    ]
    if badge_rows:
        execute_values(
            cur,
            """
            INSERT INTO nba_2k_badges (player_slug, badge_name, tier, category,
                                       description, image_url)
            VALUES %s
            """,
            badge_rows,
        )

    # one entry per 2K game the card appeared in. The oldest entry has no delta,
    # and the API omits the key rather than sending 0.
    history_rows: list[tuple] = []
    seen_versions: set[str] = set()
    for entry in player.get("ratingHistory") or []:
        version = _text_or_none(entry.get("gameVersion"))
        if not version or version in seen_versions:
            continue
        seen_versions.add(version)
        history_rows.append(
            (slug, version, _opt_int(entry.get("overall")), _opt_int(entry.get("delta")))
        )
    if history_rows:
        execute_values(
            cur,
            """
            INSERT INTO nba_2k_rating_history (player_slug, game_version, overall, delta)
            VALUES %s
            """,
            history_rows,
        )


def _prune_2k_players(
    conn: psycopg2.extensions.connection, team_type: str, seen_slugs: set[str]
) -> int:
    # scoped to the roster type just synced, so syncing only `curr` never touches
    # the classic or all-time cards. Child rows go with it via ON DELETE CASCADE.
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM nba_2k_players WHERE team_type = %s AND NOT (slug = ANY(%s))",
            (team_type, list(seen_slugs)),
        )
        removed = cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
    return removed


def sync_2k_ratings(
    conn: psycopg2.extensions.connection, team_types: list[str]
) -> None:
    # each card commits on its own: its attributes and badges are deleted before
    # being re-inserted, so a failure mid-card must not leave it stripped.
    previous_autocommit = conn.autocommit
    conn.autocommit = False

    written = 0
    failed = 0
    pruned = 0
    unavailable: list[str] = []

    try:
        for team_type in team_types:
            logger.info("2k: syncing teamType=%s", team_type)
            try:
                players = _fetch_2k_players(team_type)
            except Exception as e:
                unavailable.append(team_type)
                logger.error("2k %s: fetch failed, skipping (%s)", team_type, e)
                continue

            seen_slugs: set[str] = set()
            for player in players:
                cur = conn.cursor()
                try:
                    _upsert_2k_player(cur, player)
                    conn.commit()
                    seen_slugs.add(str(player.get("slug") or ""))
                    written += 1
                except Exception as e:
                    conn.rollback()
                    failed += 1
                    logger.error(
                        "2k %s: failed to write %s (%s)",
                        team_type, player.get("slug"), e,
                    )
                finally:
                    cur.close()

            logger.info("2k %s: wrote %d cards", team_type, len(seen_slugs))

            # only prune against a roster we actually fetched in full
            if seen_slugs:
                removed = _prune_2k_players(conn, team_type, seen_slugs)
                pruned += removed
                if removed > 0:
                    logger.info(
                        "2k %s: pruned %d card(s) no longer listed", team_type, removed
                    )
    finally:
        conn.autocommit = previous_autocommit

    logger.info(
        "2k sync summary: %d cards written, %d failed, %d pruned, %d roster type(s) unavailable",
        written, failed, pruned, len(unavailable),
    )
    if unavailable:
        logger.info("2k unavailable (re-run to retry): %s", ", ".join(unavailable))
