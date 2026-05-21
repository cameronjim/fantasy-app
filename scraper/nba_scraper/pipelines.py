import logging
import os
from typing import Any

import psycopg2
import psycopg2.extras
import scrapy
from dotenv import load_dotenv

from nba_scraper.items import GameItem, InjuryItem, PlayerItem, TeamItem

logger = logging.getLogger(__name__)


class PostgresPipeline:
    """upserts scraped items into the PostgreSQL database."""

    def __init__(self) -> None:
        self.conn: psycopg2.extensions.connection | None = None
        self.cur: psycopg2.extensions.cursor | None = None

    def open_spider(self, spider: scrapy.Spider) -> None:
        # load .env from the project root (two levels up from scraper/)
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

    def close_spider(self, spider: scrapy.Spider) -> None:
        if self.cur:
            self.cur.close()
        if self.conn:
            self.conn.close()
        logger.info("PostgresPipeline: database connection closed")

    def process_item(self, item: Any, spider: scrapy.Spider) -> Any:
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
                logger.warning("unknown item type: %s", type(item).__name__)
                return item

            self.conn.commit()
        except Exception as e:
            self.conn.rollback()
            logger.error("error processing %s: %s", type(item).__name__, e)

        return item

    def _upsert_player(self, item: PlayerItem) -> None:
        self.cur.execute(
            """
            INSERT INTO players (
                nba_id, name, team, position,
                points_per_game, rebounds_per_game, assists_per_game,
                steals_per_game, blocks_per_game,
                field_goal_percentage, three_point_percentage, free_throw_percentage,
                turnovers_per_game, minutes_per_game, games_played, headshot_url,
                updated_at
            ) VALUES (
                %(nba_id)s, %(name)s, %(team)s, %(position)s,
                %(points_per_game)s, %(rebounds_per_game)s, %(assists_per_game)s,
                %(steals_per_game)s, %(blocks_per_game)s,
                %(field_goal_percentage)s, %(three_point_percentage)s, %(free_throw_percentage)s,
                %(turnovers_per_game)s, %(minutes_per_game)s, %(games_played)s, %(headshot_url)s,
                NOW()
            )
            ON CONFLICT (nba_id) DO UPDATE SET
                name                  = EXCLUDED.name,
                team                  = EXCLUDED.team,
                position              = EXCLUDED.position,
                points_per_game       = EXCLUDED.points_per_game,
                rebounds_per_game     = EXCLUDED.rebounds_per_game,
                assists_per_game      = EXCLUDED.assists_per_game,
                steals_per_game       = EXCLUDED.steals_per_game,
                blocks_per_game       = EXCLUDED.blocks_per_game,
                field_goal_percentage = EXCLUDED.field_goal_percentage,
                three_point_percentage = EXCLUDED.three_point_percentage,
                free_throw_percentage = EXCLUDED.free_throw_percentage,
                turnovers_per_game    = EXCLUDED.turnovers_per_game,
                minutes_per_game      = EXCLUDED.minutes_per_game,
                games_played          = EXCLUDED.games_played,
                headshot_url          = EXCLUDED.headshot_url,
                updated_at            = NOW()
            """,
            dict(item),
        )

    def _upsert_team(self, item: TeamItem) -> None:
        self.cur.execute(
            """
            INSERT INTO teams (
                nba_id, name, abbreviation, conference, division,
                wins, losses,
                points_per_game, rebounds_per_game, assists_per_game,
                steals_per_game, blocks_per_game,
                field_goal_percentage, three_point_percentage, free_throw_percentage,
                turnovers_per_game, logo_url, updated_at
            ) VALUES (
                %(nba_id)s, %(name)s, %(abbreviation)s,
                %(conference)s, %(division)s,
                %(wins)s, %(losses)s,
                %(points_per_game)s, %(rebounds_per_game)s, %(assists_per_game)s,
                %(steals_per_game)s, %(blocks_per_game)s,
                %(field_goal_percentage)s, %(three_point_percentage)s, %(free_throw_percentage)s,
                %(turnovers_per_game)s, %(logo_url)s, NOW()
            )
            ON CONFLICT (nba_id) DO UPDATE SET
                name                   = EXCLUDED.name,
                abbreviation           = EXCLUDED.abbreviation,
                conference             = EXCLUDED.conference,
                division               = EXCLUDED.division,
                wins                   = EXCLUDED.wins,
                losses                 = EXCLUDED.losses,
                points_per_game        = EXCLUDED.points_per_game,
                rebounds_per_game      = EXCLUDED.rebounds_per_game,
                assists_per_game       = EXCLUDED.assists_per_game,
                steals_per_game        = EXCLUDED.steals_per_game,
                blocks_per_game        = EXCLUDED.blocks_per_game,
                field_goal_percentage  = EXCLUDED.field_goal_percentage,
                three_point_percentage = EXCLUDED.three_point_percentage,
                free_throw_percentage  = EXCLUDED.free_throw_percentage,
                turnovers_per_game     = EXCLUDED.turnovers_per_game,
                logo_url               = EXCLUDED.logo_url,
                updated_at             = NOW()
            """,
            dict(item),
        )

    def _upsert_game(self, item: GameItem) -> None:
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

    def _update_injury(self, item: InjuryItem) -> None:
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
