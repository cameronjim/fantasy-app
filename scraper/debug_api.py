"""Check the actual column names from ScoreboardV2."""
from nba_api.stats.endpoints import scoreboardv2
from datetime import datetime
import warnings
warnings.filterwarnings("ignore")

today = datetime.now().strftime("%m/%d/%Y")
sb = scoreboardv2.ScoreboardV2(game_date=today, league_id="00", timeout=60)
frames = sb.get_data_frames()

print(f"Number of DataFrames: {len(frames)}")
for i, df in enumerate(frames):
    print(f"\n=== DataFrame {i} ===")
    print(f"Columns: {list(df.columns)}")
    if not df.empty:
        print(df.head(2).to_string())
    else:
        print("(empty)")
