import scrapy


class PlayerItem(scrapy.Item):
    """matches the players table schema."""

    nba_id = scrapy.Field()
    name = scrapy.Field()
    team = scrapy.Field()
    position = scrapy.Field()
    points_per_game = scrapy.Field()
    rebounds_per_game = scrapy.Field()
    assists_per_game = scrapy.Field()
    steals_per_game = scrapy.Field()
    blocks_per_game = scrapy.Field()
    field_goal_percentage = scrapy.Field()
    three_point_percentage = scrapy.Field()
    free_throw_percentage = scrapy.Field()
    turnovers_per_game = scrapy.Field()
    minutes_per_game = scrapy.Field()
    games_played = scrapy.Field()
    headshot_url = scrapy.Field()


class TeamItem(scrapy.Item):
    """matches the teams table schema."""

    nba_id = scrapy.Field()
    name = scrapy.Field()
    abbreviation = scrapy.Field()
    conference = scrapy.Field()
    division = scrapy.Field()
    wins = scrapy.Field()
    losses = scrapy.Field()
    points_per_game = scrapy.Field()
    rebounds_per_game = scrapy.Field()
    assists_per_game = scrapy.Field()
    steals_per_game = scrapy.Field()
    blocks_per_game = scrapy.Field()
    field_goal_percentage = scrapy.Field()
    three_point_percentage = scrapy.Field()
    free_throw_percentage = scrapy.Field()
    turnovers_per_game = scrapy.Field()
    logo_url = scrapy.Field()


class GameItem(scrapy.Item):
    """matches the games table schema."""

    nba_game_id = scrapy.Field()
    home_team = scrapy.Field()
    away_team = scrapy.Field()
    game_date = scrapy.Field()
    home_score = scrapy.Field()
    away_score = scrapy.Field()
    status = scrapy.Field()
    arena = scrapy.Field()


class InjuryItem(scrapy.Item):
    """used to update injury_status and injury_detail on the players table."""

    name = scrapy.Field()
    team = scrapy.Field()
    injury_status = scrapy.Field()
    injury_detail = scrapy.Field()
