import pg from "pg";
import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

interface TeamSeed {
  name: string;
  abbreviation: string;
  conference: string;
  division: string;
  wins: number;
  losses: number;
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  field_goal_percentage: number;
  three_point_percentage: number;
  free_throw_percentage: number;
  turnovers_per_game: number;
}

interface PlayerSeed {
  name: string;
  team: string;
  position: string;
  points_per_game: number;
  rebounds_per_game: number;
  assists_per_game: number;
  steals_per_game: number;
  blocks_per_game: number;
  field_goal_percentage: number;
  three_point_percentage: number;
  free_throw_percentage: number;
  turnovers_per_game: number;
  minutes_per_game: number;
  games_played: number;
  injury_status?: string;
  injury_detail?: string;
}

interface GameSeed {
  home: string;
  away: string;
  date: string;
  homeScore: number | null;
  awayScore: number | null;
  status: string;
}

async function seed(): Promise<void> {
  const client = await pool.connect();
  try {
    const schema = readFileSync(join(__dirname, "schema.sql"), "utf-8");
    await client.query(schema);

    const teams: TeamSeed[] = [
      { name: "Atlanta Hawks", abbreviation: "ATL", conference: "East", division: "Southeast", wins: 36, losses: 46, points_per_game: 118.2, rebounds_per_game: 44.1, assists_per_game: 26.3, steals_per_game: 7.8, blocks_per_game: 4.9, field_goal_percentage: 47.5, three_point_percentage: 36.2, free_throw_percentage: 79.1, turnovers_per_game: 14.2 },
      { name: "Boston Celtics", abbreviation: "BOS", conference: "East", division: "Atlantic", wins: 64, losses: 18, points_per_game: 120.6, rebounds_per_game: 46.8, assists_per_game: 27.1, steals_per_game: 8.2, blocks_per_game: 5.8, field_goal_percentage: 49.2, three_point_percentage: 38.8, free_throw_percentage: 81.3, turnovers_per_game: 12.8 },
      { name: "Brooklyn Nets", abbreviation: "BKN", conference: "East", division: "Atlantic", wins: 32, losses: 50, points_per_game: 110.4, rebounds_per_game: 43.2, assists_per_game: 24.8, steals_per_game: 7.1, blocks_per_game: 4.3, field_goal_percentage: 45.8, three_point_percentage: 35.1, free_throw_percentage: 77.6, turnovers_per_game: 14.8 },
      { name: "Charlotte Hornets", abbreviation: "CHA", conference: "East", division: "Southeast", wins: 21, losses: 61, points_per_game: 106.8, rebounds_per_game: 42.5, assists_per_game: 24.1, steals_per_game: 6.9, blocks_per_game: 4.1, field_goal_percentage: 44.9, three_point_percentage: 34.5, free_throw_percentage: 78.2, turnovers_per_game: 15.1 },
      { name: "Chicago Bulls", abbreviation: "CHI", conference: "East", division: "Central", wins: 39, losses: 43, points_per_game: 112.3, rebounds_per_game: 43.8, assists_per_game: 25.6, steals_per_game: 7.5, blocks_per_game: 4.6, field_goal_percentage: 46.7, three_point_percentage: 35.8, free_throw_percentage: 79.8, turnovers_per_game: 13.5 },
      { name: "Cleveland Cavaliers", abbreviation: "CLE", conference: "East", division: "Central", wins: 48, losses: 34, points_per_game: 110.8, rebounds_per_game: 44.2, assists_per_game: 26.8, steals_per_game: 7.3, blocks_per_game: 5.2, field_goal_percentage: 47.1, three_point_percentage: 36.9, free_throw_percentage: 78.5, turnovers_per_game: 13.1 },
      { name: "Dallas Mavericks", abbreviation: "DAL", conference: "West", division: "Southwest", wins: 50, losses: 32, points_per_game: 117.9, rebounds_per_game: 43.5, assists_per_game: 26.5, steals_per_game: 7.6, blocks_per_game: 4.8, field_goal_percentage: 48.1, three_point_percentage: 37.5, free_throw_percentage: 80.2, turnovers_per_game: 13.3 },
      { name: "Denver Nuggets", abbreviation: "DEN", conference: "West", division: "Northwest", wins: 57, losses: 25, points_per_game: 116.7, rebounds_per_game: 45.1, assists_per_game: 28.3, steals_per_game: 7.4, blocks_per_game: 5.1, field_goal_percentage: 48.5, three_point_percentage: 37.1, free_throw_percentage: 80.8, turnovers_per_game: 13.6 },
      { name: "Detroit Pistons", abbreviation: "DET", conference: "East", division: "Central", wins: 14, losses: 68, points_per_game: 104.5, rebounds_per_game: 41.8, assists_per_game: 23.5, steals_per_game: 6.8, blocks_per_game: 3.9, field_goal_percentage: 44.2, three_point_percentage: 33.8, free_throw_percentage: 76.9, turnovers_per_game: 15.5 },
      { name: "Golden State Warriors", abbreviation: "GSW", conference: "West", division: "Pacific", wins: 46, losses: 36, points_per_game: 117.1, rebounds_per_game: 44.8, assists_per_game: 29.1, steals_per_game: 8.1, blocks_per_game: 5.3, field_goal_percentage: 47.8, three_point_percentage: 38.2, free_throw_percentage: 79.5, turnovers_per_game: 14.1 },
      { name: "Houston Rockets", abbreviation: "HOU", conference: "West", division: "Southwest", wins: 41, losses: 41, points_per_game: 111.2, rebounds_per_game: 44.5, assists_per_game: 24.2, steals_per_game: 8.5, blocks_per_game: 5.6, field_goal_percentage: 45.5, three_point_percentage: 34.8, free_throw_percentage: 77.1, turnovers_per_game: 14.5 },
      { name: "Indiana Pacers", abbreviation: "IND", conference: "East", division: "Central", wins: 47, losses: 35, points_per_game: 123.4, rebounds_per_game: 43.1, assists_per_game: 28.5, steals_per_game: 7.9, blocks_per_game: 5.1, field_goal_percentage: 49.8, three_point_percentage: 37.8, free_throw_percentage: 80.5, turnovers_per_game: 13.2 },
      { name: "LA Clippers", abbreviation: "LAC", conference: "West", division: "Pacific", wins: 51, losses: 31, points_per_game: 115.8, rebounds_per_game: 44.6, assists_per_game: 25.9, steals_per_game: 8.0, blocks_per_game: 4.7, field_goal_percentage: 48.3, three_point_percentage: 37.3, free_throw_percentage: 81.1, turnovers_per_game: 13.0 },
      { name: "Los Angeles Lakers", abbreviation: "LAL", conference: "West", division: "Pacific", wins: 47, losses: 35, points_per_game: 117.2, rebounds_per_game: 45.3, assists_per_game: 26.7, steals_per_game: 7.7, blocks_per_game: 5.4, field_goal_percentage: 47.9, three_point_percentage: 36.5, free_throw_percentage: 78.8, turnovers_per_game: 14.3 },
      { name: "Memphis Grizzlies", abbreviation: "MEM", conference: "West", division: "Southwest", wins: 27, losses: 55, points_per_game: 108.6, rebounds_per_game: 43.4, assists_per_game: 25.3, steals_per_game: 7.2, blocks_per_game: 5.0, field_goal_percentage: 45.6, three_point_percentage: 34.2, free_throw_percentage: 77.4, turnovers_per_game: 15.2 },
      { name: "Miami Heat", abbreviation: "MIA", conference: "East", division: "Southeast", wins: 46, losses: 36, points_per_game: 110.5, rebounds_per_game: 43.9, assists_per_game: 25.8, steals_per_game: 7.6, blocks_per_game: 4.5, field_goal_percentage: 46.5, three_point_percentage: 36.1, free_throw_percentage: 80.3, turnovers_per_game: 13.4 },
      { name: "Milwaukee Bucks", abbreviation: "MIL", conference: "East", division: "Central", wins: 49, losses: 33, points_per_game: 119.3, rebounds_per_game: 47.2, assists_per_game: 26.4, steals_per_game: 7.3, blocks_per_game: 5.9, field_goal_percentage: 48.7, three_point_percentage: 37.6, free_throw_percentage: 78.9, turnovers_per_game: 13.7 },
      { name: "Minnesota Timberwolves", abbreviation: "MIN", conference: "West", division: "Northwest", wins: 56, losses: 26, points_per_game: 112.1, rebounds_per_game: 46.5, assists_per_game: 25.1, steals_per_game: 8.3, blocks_per_game: 6.2, field_goal_percentage: 46.8, three_point_percentage: 36.4, free_throw_percentage: 79.2, turnovers_per_game: 12.9 },
      { name: "New Orleans Pelicans", abbreviation: "NOP", conference: "West", division: "Southwest", wins: 49, losses: 33, points_per_game: 115.3, rebounds_per_game: 45.8, assists_per_game: 26.2, steals_per_game: 7.8, blocks_per_game: 5.5, field_goal_percentage: 47.4, three_point_percentage: 36.7, free_throw_percentage: 78.1, turnovers_per_game: 14.0 },
      { name: "New York Knicks", abbreviation: "NYK", conference: "East", division: "Atlantic", wins: 50, losses: 32, points_per_game: 112.9, rebounds_per_game: 46.1, assists_per_game: 25.5, steals_per_game: 7.5, blocks_per_game: 4.8, field_goal_percentage: 47.2, three_point_percentage: 36.3, free_throw_percentage: 80.6, turnovers_per_game: 13.3 },
      { name: "Oklahoma City Thunder", abbreviation: "OKC", conference: "West", division: "Northwest", wins: 57, losses: 25, points_per_game: 120.1, rebounds_per_game: 44.3, assists_per_game: 27.5, steals_per_game: 9.1, blocks_per_game: 5.7, field_goal_percentage: 48.9, three_point_percentage: 38.1, free_throw_percentage: 80.1, turnovers_per_game: 12.5 },
      { name: "Orlando Magic", abbreviation: "ORL", conference: "East", division: "Southeast", wins: 47, losses: 35, points_per_game: 110.2, rebounds_per_game: 44.7, assists_per_game: 24.9, steals_per_game: 7.4, blocks_per_game: 5.8, field_goal_percentage: 46.3, three_point_percentage: 35.5, free_throw_percentage: 77.8, turnovers_per_game: 13.8 },
      { name: "Philadelphia 76ers", abbreviation: "PHI", conference: "East", division: "Atlantic", wins: 47, losses: 35, points_per_game: 114.6, rebounds_per_game: 44.4, assists_per_game: 25.7, steals_per_game: 7.7, blocks_per_game: 5.3, field_goal_percentage: 47.6, three_point_percentage: 37.0, free_throw_percentage: 81.5, turnovers_per_game: 13.6 },
      { name: "Phoenix Suns", abbreviation: "PHX", conference: "West", division: "Pacific", wins: 49, losses: 33, points_per_game: 116.5, rebounds_per_game: 43.7, assists_per_game: 27.8, steals_per_game: 7.5, blocks_per_game: 4.6, field_goal_percentage: 48.0, three_point_percentage: 37.4, free_throw_percentage: 80.9, turnovers_per_game: 13.9 },
      { name: "Portland Trail Blazers", abbreviation: "POR", conference: "West", division: "Northwest", wins: 21, losses: 61, points_per_game: 107.3, rebounds_per_game: 42.9, assists_per_game: 23.8, steals_per_game: 6.7, blocks_per_game: 4.2, field_goal_percentage: 44.7, three_point_percentage: 33.5, free_throw_percentage: 77.3, turnovers_per_game: 15.3 },
      { name: "Sacramento Kings", abbreviation: "SAC", conference: "West", division: "Pacific", wins: 46, losses: 36, points_per_game: 118.8, rebounds_per_game: 42.8, assists_per_game: 27.2, steals_per_game: 7.8, blocks_per_game: 4.4, field_goal_percentage: 48.4, three_point_percentage: 37.2, free_throw_percentage: 79.7, turnovers_per_game: 14.4 },
      { name: "San Antonio Spurs", abbreviation: "SAS", conference: "West", division: "Southwest", wins: 22, losses: 60, points_per_game: 109.1, rebounds_per_game: 44.0, assists_per_game: 25.0, steals_per_game: 7.0, blocks_per_game: 5.0, field_goal_percentage: 45.3, three_point_percentage: 34.0, free_throw_percentage: 78.0, turnovers_per_game: 14.7 },
      { name: "Toronto Raptors", abbreviation: "TOR", conference: "East", division: "Atlantic", wins: 25, losses: 57, points_per_game: 108.9, rebounds_per_game: 43.3, assists_per_game: 24.5, steals_per_game: 7.1, blocks_per_game: 4.5, field_goal_percentage: 45.1, three_point_percentage: 34.3, free_throw_percentage: 77.5, turnovers_per_game: 14.9 },
      { name: "Utah Jazz", abbreviation: "UTA", conference: "West", division: "Northwest", wins: 31, losses: 51, points_per_game: 111.5, rebounds_per_game: 44.9, assists_per_game: 25.4, steals_per_game: 7.2, blocks_per_game: 5.1, field_goal_percentage: 46.1, three_point_percentage: 35.9, free_throw_percentage: 78.3, turnovers_per_game: 14.1 },
      { name: "Washington Wizards", abbreviation: "WAS", conference: "East", division: "Southeast", wins: 15, losses: 67, points_per_game: 105.2, rebounds_per_game: 42.1, assists_per_game: 23.2, steals_per_game: 6.5, blocks_per_game: 3.8, field_goal_percentage: 43.8, three_point_percentage: 33.1, free_throw_percentage: 76.5, turnovers_per_game: 15.8 },
    ];

    for (const t of teams) {
      await client.query(
        `INSERT INTO teams (name, abbreviation, conference, division, wins, losses,
           points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
           field_goal_percentage, three_point_percentage, free_throw_percentage, turnovers_per_game)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT DO NOTHING`,
        [t.name, t.abbreviation, t.conference, t.division, t.wins, t.losses,
         t.points_per_game, t.rebounds_per_game, t.assists_per_game, t.steals_per_game, t.blocks_per_game,
         t.field_goal_percentage, t.three_point_percentage, t.free_throw_percentage, t.turnovers_per_game]
      );
    }

    const players: PlayerSeed[] = [
      { name: "Luka Doncic", team: "DAL", position: "PG", points_per_game: 33.9, rebounds_per_game: 9.2, assists_per_game: 9.8, steals_per_game: 1.4, blocks_per_game: 0.5, field_goal_percentage: 48.7, three_point_percentage: 35.4, free_throw_percentage: 78.6, turnovers_per_game: 4.0, minutes_per_game: 37.5, games_played: 70 },
      { name: "Shai Gilgeous-Alexander", team: "OKC", position: "SG", points_per_game: 30.1, rebounds_per_game: 5.5, assists_per_game: 6.2, steals_per_game: 2.0, blocks_per_game: 0.9, field_goal_percentage: 53.5, three_point_percentage: 35.3, free_throw_percentage: 87.4, turnovers_per_game: 2.1, minutes_per_game: 34.8, games_played: 75 },
      { name: "Giannis Antetokounmpo", team: "MIL", position: "PF", points_per_game: 30.4, rebounds_per_game: 11.5, assists_per_game: 6.5, steals_per_game: 1.2, blocks_per_game: 1.1, field_goal_percentage: 61.1, three_point_percentage: 27.4, free_throw_percentage: 65.7, turnovers_per_game: 3.4, minutes_per_game: 35.2, games_played: 73 },
      { name: "Jayson Tatum", team: "BOS", position: "SF", points_per_game: 26.9, rebounds_per_game: 8.1, assists_per_game: 4.9, steals_per_game: 1.0, blocks_per_game: 0.6, field_goal_percentage: 47.1, three_point_percentage: 37.6, free_throw_percentage: 83.8, turnovers_per_game: 2.5, minutes_per_game: 36.4, games_played: 74 },
      { name: "Nikola Jokic", team: "DEN", position: "C", points_per_game: 26.4, rebounds_per_game: 12.4, assists_per_game: 9.0, steals_per_game: 1.4, blocks_per_game: 0.9, field_goal_percentage: 58.3, three_point_percentage: 35.9, free_throw_percentage: 81.7, turnovers_per_game: 3.0, minutes_per_game: 34.6, games_played: 79 },
      { name: "Anthony Edwards", team: "MIN", position: "SG", points_per_game: 25.9, rebounds_per_game: 5.4, assists_per_game: 5.1, steals_per_game: 1.3, blocks_per_game: 0.5, field_goal_percentage: 46.1, three_point_percentage: 35.7, free_throw_percentage: 83.6, turnovers_per_game: 3.2, minutes_per_game: 35.8, games_played: 79 },
      { name: "Kevin Durant", team: "PHX", position: "SF", points_per_game: 27.1, rebounds_per_game: 6.6, assists_per_game: 5.0, steals_per_game: 0.9, blocks_per_game: 1.2, field_goal_percentage: 52.3, three_point_percentage: 41.3, free_throw_percentage: 85.6, turnovers_per_game: 3.3, minutes_per_game: 37.2, games_played: 75 },
      { name: "Stephen Curry", team: "GSW", position: "PG", points_per_game: 26.4, rebounds_per_game: 4.5, assists_per_game: 5.1, steals_per_game: 0.7, blocks_per_game: 0.4, field_goal_percentage: 45.0, three_point_percentage: 40.8, free_throw_percentage: 92.3, turnovers_per_game: 2.8, minutes_per_game: 32.7, games_played: 74 },
      { name: "LeBron James", team: "LAL", position: "SF", points_per_game: 25.7, rebounds_per_game: 7.3, assists_per_game: 8.3, steals_per_game: 1.3, blocks_per_game: 0.5, field_goal_percentage: 54.0, three_point_percentage: 41.0, free_throw_percentage: 75.0, turnovers_per_game: 3.5, minutes_per_game: 35.3, games_played: 71 },
      { name: "Joel Embiid", team: "PHI", position: "C", points_per_game: 34.7, rebounds_per_game: 11.0, assists_per_game: 5.6, steals_per_game: 1.0, blocks_per_game: 1.7, field_goal_percentage: 52.9, three_point_percentage: 38.8, free_throw_percentage: 88.3, turnovers_per_game: 3.8, minutes_per_game: 33.6, games_played: 39, injury_status: "Out", injury_detail: "Knee soreness" },
      { name: "Tyrese Haliburton", team: "IND", position: "PG", points_per_game: 20.1, rebounds_per_game: 3.9, assists_per_game: 10.9, steals_per_game: 1.2, blocks_per_game: 0.3, field_goal_percentage: 47.7, three_point_percentage: 36.4, free_throw_percentage: 85.5, turnovers_per_game: 2.5, minutes_per_game: 33.5, games_played: 69 },
      { name: "Jaylen Brown", team: "BOS", position: "SG", points_per_game: 23.0, rebounds_per_game: 5.5, assists_per_game: 3.6, steals_per_game: 1.2, blocks_per_game: 0.5, field_goal_percentage: 49.9, three_point_percentage: 35.4, free_throw_percentage: 70.3, turnovers_per_game: 2.5, minutes_per_game: 33.9, games_played: 70 },
      { name: "Devin Booker", team: "PHX", position: "SG", points_per_game: 27.1, rebounds_per_game: 4.5, assists_per_game: 6.9, steals_per_game: 1.0, blocks_per_game: 0.3, field_goal_percentage: 49.2, three_point_percentage: 36.4, free_throw_percentage: 87.3, turnovers_per_game: 2.9, minutes_per_game: 36.2, games_played: 68 },
      { name: "Anthony Davis", team: "LAL", position: "C", points_per_game: 24.7, rebounds_per_game: 12.6, assists_per_game: 3.5, steals_per_game: 1.2, blocks_per_game: 2.3, field_goal_percentage: 55.6, three_point_percentage: 27.1, free_throw_percentage: 81.6, turnovers_per_game: 2.1, minutes_per_game: 35.5, games_played: 76 },
      { name: "Damian Lillard", team: "MIL", position: "PG", points_per_game: 24.3, rebounds_per_game: 4.4, assists_per_game: 7.0, steals_per_game: 1.0, blocks_per_game: 0.3, field_goal_percentage: 42.4, three_point_percentage: 35.4, free_throw_percentage: 92.0, turnovers_per_game: 2.8, minutes_per_game: 35.4, games_played: 73 },
      { name: "Trae Young", team: "ATL", position: "PG", points_per_game: 25.7, rebounds_per_game: 2.8, assists_per_game: 10.8, steals_per_game: 1.1, blocks_per_game: 0.2, field_goal_percentage: 43.0, three_point_percentage: 37.3, free_throw_percentage: 86.3, turnovers_per_game: 4.4, minutes_per_game: 34.8, games_played: 73 },
      { name: "De'Aaron Fox", team: "SAC", position: "PG", points_per_game: 26.6, rebounds_per_game: 4.6, assists_per_game: 5.6, steals_per_game: 2.0, blocks_per_game: 0.5, field_goal_percentage: 46.5, three_point_percentage: 32.9, free_throw_percentage: 73.8, turnovers_per_game: 2.6, minutes_per_game: 35.8, games_played: 74 },
      { name: "Jalen Brunson", team: "NYK", position: "PG", points_per_game: 28.7, rebounds_per_game: 3.5, assists_per_game: 6.7, steals_per_game: 0.9, blocks_per_game: 0.2, field_goal_percentage: 47.9, three_point_percentage: 40.1, free_throw_percentage: 84.7, turnovers_per_game: 2.4, minutes_per_game: 35.8, games_played: 77 },
      { name: "Donovan Mitchell", team: "CLE", position: "SG", points_per_game: 26.6, rebounds_per_game: 5.1, assists_per_game: 5.1, steals_per_game: 1.8, blocks_per_game: 0.4, field_goal_percentage: 46.2, three_point_percentage: 36.9, free_throw_percentage: 86.7, turnovers_per_game: 2.6, minutes_per_game: 34.3, games_played: 55 },
      { name: "Kawhi Leonard", team: "LAC", position: "SF", points_per_game: 23.7, rebounds_per_game: 6.1, assists_per_game: 3.6, steals_per_game: 1.6, blocks_per_game: 0.9, field_goal_percentage: 52.5, three_point_percentage: 41.7, free_throw_percentage: 88.5, turnovers_per_game: 1.8, minutes_per_game: 34.3, games_played: 68, injury_status: "GTD", injury_detail: "Knee management" },
      { name: "Zion Williamson", team: "NOP", position: "PF", points_per_game: 22.9, rebounds_per_game: 5.8, assists_per_game: 5.0, steals_per_game: 1.1, blocks_per_game: 0.7, field_goal_percentage: 57.0, three_point_percentage: 33.3, free_throw_percentage: 71.5, turnovers_per_game: 2.9, minutes_per_game: 30.2, games_played: 29, injury_status: "Out", injury_detail: "Hamstring injury" },
      { name: "Chet Holmgren", team: "OKC", position: "C", points_per_game: 16.5, rebounds_per_game: 7.9, assists_per_game: 2.4, steals_per_game: 0.8, blocks_per_game: 2.3, field_goal_percentage: 53.0, three_point_percentage: 37.2, free_throw_percentage: 79.5, turnovers_per_game: 1.8, minutes_per_game: 29.4, games_played: 82 },
      { name: "Victor Wembanyama", team: "SAS", position: "C", points_per_game: 21.4, rebounds_per_game: 10.6, assists_per_game: 3.9, steals_per_game: 1.2, blocks_per_game: 3.6, field_goal_percentage: 46.5, three_point_percentage: 32.5, free_throw_percentage: 79.2, turnovers_per_game: 3.7, minutes_per_game: 29.7, games_played: 71 },
      { name: "Paolo Banchero", team: "ORL", position: "PF", points_per_game: 22.6, rebounds_per_game: 6.9, assists_per_game: 5.4, steals_per_game: 0.9, blocks_per_game: 0.6, field_goal_percentage: 45.8, three_point_percentage: 33.9, free_throw_percentage: 73.0, turnovers_per_game: 3.1, minutes_per_game: 34.1, games_played: 80 },
      { name: "Scottie Barnes", team: "TOR", position: "PF", points_per_game: 19.9, rebounds_per_game: 8.2, assists_per_game: 6.1, steals_per_game: 1.3, blocks_per_game: 0.9, field_goal_percentage: 47.2, three_point_percentage: 34.1, free_throw_percentage: 77.8, turnovers_per_game: 2.8, minutes_per_game: 34.8, games_played: 60 },
      { name: "Bam Adebayo", team: "MIA", position: "C", points_per_game: 19.3, rebounds_per_game: 10.4, assists_per_game: 3.9, steals_per_game: 1.1, blocks_per_game: 0.8, field_goal_percentage: 52.0, three_point_percentage: 18.0, free_throw_percentage: 80.1, turnovers_per_game: 2.6, minutes_per_game: 33.8, games_played: 71 },
      { name: "Ja Morant", team: "MEM", position: "PG", points_per_game: 25.1, rebounds_per_game: 5.6, assists_per_game: 8.1, steals_per_game: 0.8, blocks_per_game: 0.3, field_goal_percentage: 47.2, three_point_percentage: 30.5, free_throw_percentage: 74.1, turnovers_per_game: 3.4, minutes_per_game: 32.5, games_played: 9, injury_status: "Out", injury_detail: "Shoulder surgery" },
      { name: "Domantas Sabonis", team: "SAC", position: "C", points_per_game: 19.4, rebounds_per_game: 13.7, assists_per_game: 8.2, steals_per_game: 0.9, blocks_per_game: 0.5, field_goal_percentage: 56.0, three_point_percentage: 37.5, free_throw_percentage: 73.0, turnovers_per_game: 3.2, minutes_per_game: 35.2, games_played: 82 },
      { name: "Jimmy Butler", team: "MIA", position: "SF", points_per_game: 20.8, rebounds_per_game: 5.3, assists_per_game: 5.0, steals_per_game: 1.3, blocks_per_game: 0.3, field_goal_percentage: 49.9, three_point_percentage: 35.5, free_throw_percentage: 85.0, turnovers_per_game: 2.2, minutes_per_game: 33.5, games_played: 60 },
      { name: "Paul George", team: "LAC", position: "SF", points_per_game: 22.6, rebounds_per_game: 5.2, assists_per_game: 3.5, steals_per_game: 1.5, blocks_per_game: 0.4, field_goal_percentage: 44.7, three_point_percentage: 37.1, free_throw_percentage: 90.3, turnovers_per_game: 2.1, minutes_per_game: 34.5, games_played: 74 },
      { name: "Cade Cunningham", team: "DET", position: "PG", points_per_game: 22.7, rebounds_per_game: 4.5, assists_per_game: 7.5, steals_per_game: 1.0, blocks_per_game: 0.4, field_goal_percentage: 44.9, three_point_percentage: 35.5, free_throw_percentage: 86.8, turnovers_per_game: 3.5, minutes_per_game: 34.6, games_played: 62 },
      { name: "Lauri Markkanen", team: "UTA", position: "PF", points_per_game: 23.2, rebounds_per_game: 8.2, assists_per_game: 2.0, steals_per_game: 0.6, blocks_per_game: 0.5, field_goal_percentage: 48.0, three_point_percentage: 39.1, free_throw_percentage: 87.8, turnovers_per_game: 1.7, minutes_per_game: 33.4, games_played: 55 },
      { name: "Jaren Jackson Jr.", team: "MEM", position: "PF", points_per_game: 22.5, rebounds_per_game: 5.5, assists_per_game: 2.1, steals_per_game: 1.0, blocks_per_game: 1.6, field_goal_percentage: 48.0, three_point_percentage: 32.5, free_throw_percentage: 80.0, turnovers_per_game: 2.5, minutes_per_game: 32.2, games_played: 66 },
      { name: "Tyrese Maxey", team: "PHI", position: "SG", points_per_game: 25.9, rebounds_per_game: 3.7, assists_per_game: 6.2, steals_per_game: 1.0, blocks_per_game: 0.5, field_goal_percentage: 45.0, three_point_percentage: 37.3, free_throw_percentage: 87.5, turnovers_per_game: 1.6, minutes_per_game: 37.5, games_played: 70 },
      { name: "Evan Mobley", team: "CLE", position: "PF", points_per_game: 15.7, rebounds_per_game: 9.4, assists_per_game: 3.2, steals_per_game: 0.8, blocks_per_game: 1.4, field_goal_percentage: 57.8, three_point_percentage: 37.2, free_throw_percentage: 72.0, turnovers_per_game: 1.5, minutes_per_game: 33.0, games_played: 82 },
      { name: "Franz Wagner", team: "ORL", position: "SF", points_per_game: 19.7, rebounds_per_game: 5.3, assists_per_game: 3.7, steals_per_game: 1.1, blocks_per_game: 0.4, field_goal_percentage: 46.5, three_point_percentage: 34.7, free_throw_percentage: 85.0, turnovers_per_game: 2.2, minutes_per_game: 33.8, games_played: 72 },
      { name: "Mikal Bridges", team: "BKN", position: "SF", points_per_game: 19.6, rebounds_per_game: 4.5, assists_per_game: 3.6, steals_per_game: 1.0, blocks_per_game: 0.5, field_goal_percentage: 44.5, three_point_percentage: 37.3, free_throw_percentage: 83.5, turnovers_per_game: 1.7, minutes_per_game: 35.2, games_played: 82 },
      { name: "LaMelo Ball", team: "CHA", position: "PG", points_per_game: 23.9, rebounds_per_game: 5.1, assists_per_game: 8.0, steals_per_game: 1.8, blocks_per_game: 0.3, field_goal_percentage: 43.5, three_point_percentage: 35.5, free_throw_percentage: 87.0, turnovers_per_game: 3.1, minutes_per_game: 32.2, games_played: 22, injury_status: "Out", injury_detail: "Ankle injury" },
      { name: "DeMar DeRozan", team: "CHI", position: "SF", points_per_game: 24.0, rebounds_per_game: 4.3, assists_per_game: 5.3, steals_per_game: 1.1, blocks_per_game: 0.5, field_goal_percentage: 48.0, three_point_percentage: 33.5, free_throw_percentage: 85.0, turnovers_per_game: 2.1, minutes_per_game: 36.0, games_played: 79 },
      { name: "Jalen Williams", team: "OKC", position: "SG", points_per_game: 19.1, rebounds_per_game: 4.5, assists_per_game: 4.5, steals_per_game: 1.4, blocks_per_game: 0.7, field_goal_percentage: 53.0, three_point_percentage: 34.2, free_throw_percentage: 76.0, turnovers_per_game: 1.8, minutes_per_game: 31.5, games_played: 71 },
    ];

    for (const p of players) {
      await client.query(
        `INSERT INTO players (name, team, position,
           points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
           field_goal_percentage, three_point_percentage, free_throw_percentage,
           turnovers_per_game, minutes_per_game, games_played,
           injury_status, injury_detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING`,
        [p.name, p.team, p.position,
         p.points_per_game, p.rebounds_per_game, p.assists_per_game, p.steals_per_game, p.blocks_per_game,
         p.field_goal_percentage, p.three_point_percentage, p.free_throw_percentage,
         p.turnovers_per_game, p.minutes_per_game, p.games_played,
         p.injury_status ?? null, p.injury_detail ?? null]
      );
    }

    const games: GameSeed[] = [
      { home: "Boston Celtics", away: "New York Knicks", date: "2026-03-18", homeScore: 112, awayScore: 108, status: "Final" },
      { home: "Los Angeles Lakers", away: "Golden State Warriors", date: "2026-03-18", homeScore: 118, awayScore: 121, status: "Final" },
      { home: "Denver Nuggets", away: "Phoenix Suns", date: "2026-03-18", homeScore: null, awayScore: null, status: "7:00 PM ET" },
      { home: "Milwaukee Bucks", away: "Cleveland Cavaliers", date: "2026-03-18", homeScore: null, awayScore: null, status: "8:00 PM ET" },
      { home: "Dallas Mavericks", away: "Minnesota Timberwolves", date: "2026-03-18", homeScore: null, awayScore: null, status: "8:30 PM ET" },
      { home: "Miami Heat", away: "Philadelphia 76ers", date: "2026-03-17", homeScore: 105, awayScore: 99, status: "Final" },
      { home: "Oklahoma City Thunder", away: "Sacramento Kings", date: "2026-03-17", homeScore: 128, awayScore: 115, status: "Final" },
      { home: "Indiana Pacers", away: "Chicago Bulls", date: "2026-03-17", homeScore: 131, awayScore: 124, status: "Final" },
    ];

    for (const g of games) {
      await client.query(
        `INSERT INTO games (home_team, away_team, game_date, home_score, away_score, status)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [g.home, g.away, g.date, g.homeScore, g.awayScore, g.status]
      );
    }

    const leagueRes = await client.query(
      `INSERT INTO fantasy_leagues (name) VALUES ('Demo League') RETURNING id`
    );
    const leagueId = leagueRes.rows[0].id;

    const teamRes = await client.query(
      `INSERT INTO fantasy_teams (league_id, team_name) VALUES ($1, 'My First Team') RETURNING id`,
      [leagueId]
    );
    const teamId = teamRes.rows[0].id;

    const rosterPlayers = ["Luka Doncic", "Jayson Tatum", "Nikola Jokic", "Anthony Edwards", "Jaylen Brown"];
    for (const pName of rosterPlayers) {
      const pRes = await client.query(`SELECT id FROM players WHERE name = $1`, [pName]);
      if (pRes.rows.length > 0) {
        await client.query(
          `INSERT INTO fantasy_roster (fantasy_team_id, player_id, slot) VALUES ($1, $2, 'STARTER')
           ON CONFLICT DO NOTHING`,
          [teamId, pRes.rows[0].id]
        );
      }
    }
  } catch (err) {
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
