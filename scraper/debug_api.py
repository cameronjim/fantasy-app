"""check the actual column names from ScoreboardV2."""
import logging
import warnings
from datetime import datetime

from nba_api.stats.endpoints import scoreboardv2

logger = logging.getLogger(__name__)

warnings.filterwarnings("ignore")


def main() -> None:
    today = datetime.now().strftime("%m/%d/%Y")
    sb = scoreboardv2.ScoreboardV2(game_date=today, league_id="00", timeout=60)
    frames = sb.get_data_frames()

    logger.info("number of dataframes: %d", len(frames))
    for i, df in enumerate(frames):
        logger.info("dataframe %d columns: %s", i, list(df.columns))
        if not df.empty:
            logger.info("\n%s", df.head(2).to_string())
        else:
            logger.info("dataframe %d is empty", i)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()
