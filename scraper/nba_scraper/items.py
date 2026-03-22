import scrapy


class PlayerItem(scrapy.Item):
    """Matches the players table schema."""
    nba_id = scrapy.Field()
    name = scrapy.Field()
    team = scrapy.Field()
    position = scrapy.Field()
    ppg = scrapy.Field()
    rpg = scrapy.Field()
    apg = scrapy.Field()
    spg = scrapy.Field()
    bpg = scrapy.Field()
    fg_pct = scrapy.Field()
    three_pct = scrapy.Field()
    ft_pct = scrapy.Field()
    tov = scrapy.Field()
    mpg = scrapy.Field()
    gp = scrapy.Field()
    headshot_url = scrapy.Field()


class TeamItem(scrapy.Item):
    """Matches the teams table schema."""
    nba_id = scrapy.Field()
    name = scrapy.Field()
    abbreviation = scrapy.Field()
    conference = scrapy.Field()
    division = scrapy.Field()
    wins = scrapy.Field()
    losses = scrapy.Field()
    ppg = scrapy.Field()
    rpg = scrapy.Field()
    apg = scrapy.Field()
    spg = scrapy.Field()
    bpg = scrapy.Field()
    fg_pct = scrapy.Field()
    three_pct = scrapy.Field()
    ft_pct = scrapy.Field()
    tov = scrapy.Field()
    logo_url = scrapy.Field()


class GameItem(scrapy.Item):
    """Matches the games table schema."""
    nba_game_id = scrapy.Field()
    home_team = scrapy.Field()
    away_team = scrapy.Field()
    game_date = scrapy.Field()
    home_score = scrapy.Field()
    away_score = scrapy.Field()
    status = scrapy.Field()
    arena = scrapy.Field()


class InjuryItem(scrapy.Item):
    """Used to update injury_status and injury_detail on the players table."""
    name = scrapy.Field()
    team = scrapy.Field()
    injury_status = scrapy.Field()
    injury_detail = scrapy.Field()
