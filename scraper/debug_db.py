"""debug script to check what's actually in the database."""
import logging
import os

import psycopg2
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=env_path)

logger = logging.getLogger(__name__)


def main() -> None:
    conn = psycopg2.connect(os.getenv("DATABASE_URL"))
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM players")
    logger.info("total players: %d", cur.fetchone()[0])

    cur.execute("SELECT COUNT(*) FROM players WHERE nba_id IS NOT NULL")
    logger.info("with nba_id (scraped): %d", cur.fetchone()[0])

    cur.execute("SELECT COUNT(*) FROM players WHERE nba_id IS NULL")
    logger.info("without nba_id (seed): %d", cur.fetchone()[0])

    cur.execute(
        """
        SELECT name, COUNT(*) as cnt
        FROM players GROUP BY name HAVING COUNT(*) > 1
        ORDER BY cnt DESC LIMIT 15
        """
    )
    dupes = cur.fetchall()
    if dupes:
        logger.info("duplicate players:")
        for name, cnt in dupes:
            logger.info("  %s: %d rows", name, cnt)
            cur.execute(
                "SELECT id, nba_id, points_per_game, team FROM players "
                "WHERE name = %s ORDER BY points_per_game DESC",
                (name,),
            )
            for row in cur.fetchall():
                logger.info(
                    "    id=%s, nba_id=%s, pts=%s, team=%s",
                    row[0], row[1], row[2], row[3],
                )
    else:
        logger.info("no duplicates found")

    cur.execute(
        "SELECT name, team, points_per_game, nba_id FROM players ORDER BY points_per_game DESC LIMIT 10"
    )
    for row in cur.fetchall():
        logger.info("  %s (%s) - pts: %s - nba_id: %s", row[0], row[1], row[2], row[3])

    cur.execute("SELECT COUNT(*) FROM teams WHERE nba_id IS NOT NULL")
    logger.info("scraped teams: %d", cur.fetchone()[0])
    cur.execute("SELECT COUNT(*) FROM teams WHERE nba_id IS NULL")
    logger.info("seed teams: %d", cur.fetchone()[0])

    cur.execute("SELECT COUNT(*) FROM games WHERE nba_game_id IS NOT NULL")
    logger.info("scraped games: %d", cur.fetchone()[0])
    cur.execute("SELECT COUNT(*) FROM games WHERE nba_game_id IS NULL")
    logger.info("seed games: %d", cur.fetchone()[0])

    cur.close()
    conn.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()
