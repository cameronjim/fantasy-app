"""Debug script to check what's actually in the database."""
import os
import psycopg2
from dotenv import load_dotenv

env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=env_path)

conn = psycopg2.connect(os.getenv("DATABASE_URL"))
cur = conn.cursor()

print("=== PLAYER COUNTS ===")
cur.execute("SELECT COUNT(*) FROM players")
print(f"Total players: {cur.fetchone()[0]}")

cur.execute("SELECT COUNT(*) FROM players WHERE nba_id IS NOT NULL")
print(f"With nba_id (scraped): {cur.fetchone()[0]}")

cur.execute("SELECT COUNT(*) FROM players WHERE nba_id IS NULL")
print(f"Without nba_id (seed): {cur.fetchone()[0]}")

print("\n=== DUPLICATE CHECK ===")
cur.execute("""
    SELECT name, COUNT(*) as cnt
    FROM players GROUP BY name HAVING COUNT(*) > 1
    ORDER BY cnt DESC LIMIT 15
""")
dupes = cur.fetchall()
if dupes:
    print("Duplicate players:")
    for name, cnt in dupes:
        print(f"  {name}: {cnt} rows")
        cur.execute("SELECT id, nba_id, ppg, team FROM players WHERE name = %s ORDER BY ppg DESC", (name,))
        for row in cur.fetchall():
            print(f"    id={row[0]}, nba_id={row[1]}, ppg={row[2]}, team={row[3]}")
else:
    print("No duplicates found")

print("\n=== TOP 10 PLAYERS BY PPG ===")
cur.execute("SELECT name, team, ppg, nba_id FROM players ORDER BY ppg DESC LIMIT 10")
for row in cur.fetchall():
    print(f"  {row[0]} ({row[1]}) - PPG: {row[2]} - nba_id: {row[3]}")

print("\n=== TEAM COUNT ===")
cur.execute("SELECT COUNT(*) FROM teams WHERE nba_id IS NOT NULL")
print(f"Scraped teams: {cur.fetchone()[0]}")
cur.execute("SELECT COUNT(*) FROM teams WHERE nba_id IS NULL")
print(f"Seed teams: {cur.fetchone()[0]}")

print("\n=== GAME COUNT ===")
cur.execute("SELECT COUNT(*) FROM games WHERE nba_game_id IS NOT NULL")
print(f"Scraped games: {cur.fetchone()[0]}")
cur.execute("SELECT COUNT(*) FROM games WHERE nba_game_id IS NULL")
print(f"Seed games: {cur.fetchone()[0]}")

cur.close()
conn.close()
