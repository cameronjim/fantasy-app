// playwright page-object barrel. naming convention:
//   - classes with the `Page` suffix represent a full route (`/`, `/fantasy`).
//   - classes with the `Component` suffix represent ui rendered inside one or
//     more pages (the navbar, the player table, the player modal).
// the suffix distinguishes the role; it's not interchangeable. tests import
// whatever they need from this file rather than reaching into individual
// page-object files.

export { StatsPage } from './StatsPage';
export { PlayerAnalyticsPage } from './PlayerAnalyticsPage';
export { FantasyPage } from './FantasyPage';
export { ImproveTeamPage } from './ImproveTeamPage';
export { BettingPage } from './BettingPage';
export { LoginPage } from './LoginPage';
export { NavbarComponent } from './NavbarComponent';
export { PlayerTableComponent } from './PlayerTableComponent';
export { PlayerModalComponent } from './PlayerModalComponent';
