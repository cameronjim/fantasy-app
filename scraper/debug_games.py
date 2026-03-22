"""Check what fields the scoreboard API returns for games."""
import os
import psycopg2
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=env_path)

conn = psycopg2.connect(os.getenv("DATABASE_URL"))
cur = conn.cursor()

cur.execute("SELECT home_team, away_team, game_date, status, home_score, away_score FROM games ORDER BY game_date DESC LIMIT 15")
for row in cur.fetchall():
    print(f"  {row[1]} @ {row[0]} | {row[2]} | {row[3]} | {row[5]}-{row[4]}")

cur.close()
conn.close()
