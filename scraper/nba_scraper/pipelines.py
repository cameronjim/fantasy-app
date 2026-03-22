import os
import logging
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from nba_scraper.items import PlayerItem, TeamItem, GameItem, InjuryItem

logger = logging.getLogger(__name__)


class PostgresPipeline:
    """Upserts scraped items into the PostgreSQL database."""

    def __init__(self):
        self.conn = None
        self.cur = None

    def open_spider(self, spider):
        # Load .env from the project root (two levels up from scraper/)
        env_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
            ".env",
        )
        load_dotenv(dotenv_path=env_path)

        database_url = os.getenv("DATABASE_URL")
        if not database_url:
            raise RuntimeError(
                "DATABASE_URL not set. Create a .env file at the project root."
            )

        self.conn = psycopg2.connect(database_url)
        self.conn.autocommit = False
        self.cur = self.conn.cursor()
        logger.info("PostgresPipeline: connected to database")

    def close_spider(self, spider):
        if self.cur:
            self.cur.close()
        if self.conn:
            self.conn.close()
        logger.info("PostgresPipeline: database connection closed")

    def process_item(self, item, spider):
        try:
            if isinstance(item, PlayerItem):
                self._upsert_player(item)
            elif isinstance(item, TeamItem):
                self._upsert_team(item)
            elif isinstance(item, GameItem):
                self._upsert_game(item)
            elif isinstance(item, InjuryItem):
                self._update_injury(item)
            else:
                logger.warning("Unknown item type: %s", type(item).__name__)
                return item

            self.conn.commit()
        except Exception as e:
            self.conn.rollback()
            logger.error("Error processing %s: %s", type(item).__name__, e)

        return item

    # ------------------------------------------------------------------
    # Player UPSERT
    # ------------------------------------------------------------------
    def _upsert_player(self, item):
        self.cur.execute(
            """
            INSERT INTO players (
                nba_id, name, team, position,
                ppg, rpg, apg, spg, bpg,
                fg_pct, three_pct, ft_pct,
                tov, mpg, gp, headshot_url,
                updated_at
            ) VALUES (
                %(nba_id)s, %(name)s, %(team)s, %(position)s,
                %(ppg)s, %(rpg)s, %(apg)s, %(spg)s, %(bpg)s,
                %(fg_pct)s, %(three_pct)s, %(ft_pct)s,
                %(tov)s, %(mpg)s, %(gp)s, %(headshot_url)s,
                NOW()
            )
            ON CONFLICT (nba_id) DO UPDATE SET
                name         = EXCLUDED.name,
                team         = EXCLUDED.team,
                position     = EXCLUDED.position,
                ppg          = EXCLUDED.ppg,
                rpg          = EXCLUDED.rpg,
                apg          = EXCLUDED.apg,
                spg          = EXCLUDED.spg,
                bpg          = EXCLUDED.bpg,
                fg_pct       = EXCLUDED.fg_pct,
                three_pct    = EXCLUDED.three_pct,
                ft_pct       = EXCLUDED.ft_pct,
                tov          = EXCLUDED.tov,
                mpg          = EXCLUDED.mpg,
                gp           = EXCLUDED.gp,
                headshot_url = EXCLUDED.headshot_url,
                updated_at   = NOW()
            """,
            dict(item),
        )

    # ------------------------------------------------------------------
    # Team UPSERT
    # ------------------------------------------------------------------
    def _upsert_team(self, item):
        self.cur.execute(
            """
            INSERT INTO teams (
                nba_id, name, abbreviation, conference, division,
                wins, losses,
                ppg, rpg, apg, spg, bpg,
                fg_pct, three_pct, ft_pct,
                tov, logo_url, updated_at
            ) VALUES (
                %(nba_id)s, %(name)s, %(abbreviation)s,
                %(conference)s, %(division)s,
                %(wins)s, %(losses)s,
                %(ppg)s, %(rpg)s, %(apg)s, %(spg)s, %(bpg)s,
                %(fg_pct)s, %(three_pct)s, %(ft_pct)s,
                %(tov)s, %(logo_url)s, NOW()
            )
            ON CONFLICT (nba_id) DO UPDATE SET
                name          = EXCLUDED.name,
                abbreviation  = EXCLUDED.abbreviation,
                conference    = EXCLUDED.conference,
                division      = EXCLUDED.division,
                wins          = EXCLUDED.wins,
                losses        = EXCLUDED.losses,
                ppg           = EXCLUDED.ppg,
                rpg           = EXCLUDED.rpg,
                apg           = EXCLUDED.apg,
                spg           = EXCLUDED.spg,
                bpg           = EXCLUDED.bpg,
                fg_pct        = EXCLUDED.fg_pct,
                three_pct     = EXCLUDED.three_pct,
                ft_pct        = EXCLUDED.ft_pct,
                tov           = EXCLUDED.tov,
                logo_url      = EXCLUDED.logo_url,
                updated_at    = NOW()
            """,
            dict(item),
        )

    # ------------------------------------------------------------------
    # Game UPSERT
    # ------------------------------------------------------------------
    def _upsert_game(self, item):
        self.cur.execute(
            """
            INSERT INTO games (
                nba_game_id, home_team, away_team,
                game_date, home_score, away_score,
                status, arena, updated_at
            ) VALUES (
                %(nba_game_id)s, %(home_team)s, %(away_team)s,
                %(game_date)s, %(home_score)s, %(away_score)s,
                %(status)s, %(arena)s, NOW()
            )
            ON CONFLICT (nba_game_id) DO UPDATE SET
                home_team   = EXCLUDED.home_team,
                away_team   = EXCLUDED.away_team,
                game_date   = EXCLUDED.game_date,
                home_score  = EXCLUDED.home_score,
                away_score  = EXCLUDED.away_score,
                status      = EXCLUDED.status,
                arena       = EXCLUDED.arena,
                updated_at  = NOW()
            """,
            dict(item),
        )

    # ------------------------------------------------------------------
    # Injury UPDATE
    # ------------------------------------------------------------------
    def _update_injury(self, item):
        self.cur.execute(
            """
            UPDATE players
            SET injury_status = %(injury_status)s,
                injury_detail = %(injury_detail)s,
                updated_at    = NOW()
            WHERE LOWER(name) = LOWER(%(name)s)
              AND LOWER(team) = LOWER(%(team)s)
            """,
            dict(item),
        )
