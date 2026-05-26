import { Github, ExternalLink, ShieldCheck, GitBranch, Database, Cloud, Code2, TestTube2 } from 'lucide-react';

// public landing page describing what this project is and how it's built.
// targeted at hiring managers / reviewers — keeps the high-level story and
// links to the code rather than restating implementation detail.
//
// content rule: any tech mentioned here must actually be in use in the
// repo. nothing aspirational. if a section becomes inaccurate, fix the
// section instead of leaving it stale.

export const AboutPage = () => {
  return (
    <div className="max-w-[1100px] mx-auto px-4 py-8 space-y-10">
      <Hero />
      <TechStack />
      <Architecture />
      <Engineering />
      <Pipeline />
      <Footer />
    </div>
  );
};

const Hero = () => (
  <section>
    <p className="text-xs uppercase tracking-widest opacity-50 mb-2">About this project</p>
    <h1 className="text-3xl md:text-4xl font-bold mb-3">
      Fantasy NBA — full-stack with AI assist
    </h1>
    <p className="text-base opacity-70 leading-relaxed max-w-2xl">
      A personal full-stack basketball app combining real NBA stats, a personal
      fantasy roster, and Claude-powered analysis. Built end-to-end by{' '}
      <a
        href="https://github.com/cameronjim"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline-offset-2 hover:underline"
      >
        Cameron Jim
      </a>{' '}
      as a portfolio piece — production-deployed with real CI/CD, automated
      tests, and live data scraping.
    </p>
    <div className="flex flex-wrap gap-2 mt-5">
      <a
        href="https://github.com/cameronjim/fantasy-app"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-sm btn-primary gap-2"
      >
        <Github size={14} />
        View source on GitHub
        <ExternalLink size={12} />
      </a>
    </div>
  </section>
);

const TechStack = () => (
  <section>
    <SectionHeader icon={Code2} title="Tech stack" />
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <StackCard
        title="Frontend"
        items={[
          'React 18 + TypeScript (strict)',
          'Vite 6 build tooling',
          'Tailwind 4 + DaisyUI 5 components',
          'React Router 7 for client-side routing',
          'Axios for the typed API client',
          '@react-oauth/google for Google Sign-In',
        ]}
      />
      <StackCard
        title="Backend"
        items={[
          'Node.js 22 + Express 4',
          'TypeScript ESM (NodeNext resolution)',
          'PostgreSQL via the pg driver',
          'JWT auth with bcryptjs password hashing',
          '@anthropic-ai/sdk (Claude) for AI features',
          'AWS SDK v3 for SES (password-reset email)',
        ]}
      />
      <StackCard
        title="Infrastructure"
        items={[
          'AWS Lambda + HTTP API Gateway (backend)',
          'S3 + CloudFront (frontend static hosting)',
          'Neon serverless Postgres with dev branching',
          'AWS SES for transactional email',
          'CloudFormation via Serverless Framework v3',
          'OIDC trust between GitHub Actions and AWS — no long-lived keys',
        ]}
      />
      <StackCard
        title="Data pipeline"
        items={[
          'Python + Scrapy + nba_api',
          'Beautiful Soup for CBS Sports injury parsing',
          'Scheduled scrape every 6 hours via GitHub Actions cron',
          'Upserts directly into Postgres via psycopg2',
        ]}
      />
    </div>
  </section>
);

const Architecture = () => (
  <section>
    <SectionHeader icon={Database} title="Architecture" />
    <div className="card bg-base-200">
      <div className="card-body prose prose-sm max-w-none">
        <p className="opacity-80">
          The app is a thin layer over a stats database. The frontend is a
          single-page React app that talks to a Lambda-hosted Express API. The
          Lambda reads from Postgres for player/team/game data and from the
          Anthropic Claude API for analysis surfaces. The Python scraper runs
          on a cron and writes fresh stats into Postgres independently of the
          web app.
        </p>
        <h3 className="text-base font-semibold mt-4 mb-2">Separation of concerns</h3>
        <ul className="space-y-1 text-sm opacity-80">
          <li>
            <strong>Components</strong> render UI. Loading, empty, error, and
            success states are mandatory for every flow.
          </li>
          <li>
            <strong>Hooks</strong> coordinate state and side effects (e.g. theme,
            client-side AI response caching).
          </li>
          <li>
            <strong>API client</strong> is the only place that talks HTTP. No
            component fetches directly.
          </li>
          <li>
            <strong>Route handlers</strong> validate input and return JSON; the
            <code className="text-xs"> requireAuth</code> middleware binds the JWT's user id
            so query parameters are never client-supplied.
          </li>
          <li>
            <strong>Services</strong> own business logic (fantasy scoring,
            Anthropic calls, SES). Database access funnels through a single
            parameterized <code className="text-xs">query()</code> helper.
          </li>
        </ul>
        <h3 className="text-base font-semibold mt-4 mb-2">Fantasy scoring engine</h3>
        <p className="opacity-80">
          The scoring service supports every major industry format —
          NBA.com's <code className="text-xs">NBA_FANTASY_PTS</code>, FanDuel,
          DraftKings (with DD/TD bonuses), ESPN H2H Points, Yahoo High Score —
          plus a z-score variant for 9-category leagues. Formats are selectable
          per-user via the existing preferences system. Default is NBA standard.
        </p>
      </div>
    </div>
  </section>
);

const Engineering = () => (
  <section>
    <SectionHeader icon={ShieldCheck} title="Engineering practices" />
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <StackCard
        title="Code quality"
        items={[
          'Strict TypeScript across frontend and backend',
          'Single AGENTS.md style guide with role-specific sections',
          'No `any`, no `@ts-ignore`, lowercase comments that explain why',
          'Parameterized SQL only — never string-interpolate user input',
          'Centralized brand color tokens (no hardcoded hex in components)',
        ]}
      />
      <StackCard
        icon={TestTube2}
        title="Testing"
        items={[
          'Unit tests (Vitest) for pure logic — scoring, validation',
          'API tests (Vitest + Supertest) for every route, with mocked db',
          'E2E tests (Playwright) using the Page Object Model',
          'Mocked AWS, mocked Anthropic — no live calls in CI',
          'AAA-structured tests with behavior-focused names',
        ]}
      />
      <StackCard
        icon={ShieldCheck}
        title="Security"
        items={[
          'bcrypt for password hashing (cost factor 10)',
          'JWTs verified server-side; user-scoped queries bind the JWT id',
          'Google Sign-In with token verification against Google',
          'Password-reset tokens stored as SHA-256 hashes, single-use',
          'Forgot-password returns the same response for known/unknown emails (no enumeration)',
          'CORS allow-list driven by env var per environment',
        ]}
      />
    </div>
  </section>
);

const Pipeline = () => (
  <section>
    <SectionHeader icon={Cloud} title="CI/CD pipeline" />
    <div className="card bg-base-200">
      <div className="card-body">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-base font-semibold mb-2 flex items-center gap-2">
              <GitBranch size={16} className="text-primary" />
              On every pull request
            </h3>
            <ol className="space-y-1.5 text-sm opacity-80 list-decimal list-inside">
              <li>Backend typecheck + unit + API tests</li>
              <li>Frontend typecheck + unit tests + production build</li>
              <li>Playwright E2E suite (Chromium, cached browser binaries)</li>
              <li>
                If green → deploys backend to <code className="text-xs">--stage dev</code>{' '}
                Lambda, syncs the frontend bundle to a dev S3 bucket, invalidates
                the dev CloudFront distribution
              </li>
              <li>Preview is live at a fixed dev URL within ~3 minutes</li>
            </ol>
          </div>
          <div>
            <h3 className="text-base font-semibold mb-2 flex items-center gap-2">
              <Cloud size={16} className="text-primary" />
              On merge to <code className="text-xs">main</code>
            </h3>
            <ol className="space-y-1.5 text-sm opacity-80 list-decimal list-inside">
              <li>CI re-runs on the merge commit</li>
              <li>Prod deploy fires: <code className="text-xs">serverless deploy --stage prod</code></li>
              <li>Frontend S3 sync with content-hashed asset caching + index.html invalidation</li>
              <li>Smoke test: <code className="text-xs">curl /api/health</code> + frontend root</li>
              <li>Branch protection requires all checks green before merge</li>
            </ol>
          </div>
        </div>
        <p className="text-xs opacity-50 mt-5">
          Database migrations stay manual on purpose — every schema change runs
          through Neon's SQL editor with eyes on. Lambda versioning provides
          sub-minute rollback for code regressions.
        </p>
      </div>
    </div>
  </section>
);

const Footer = () => (
  <section className="border-t border-base-300 pt-6">
    <p className="text-sm opacity-60">
      Want to talk about this project, the engineering decisions, or hiring? I'd love to.
    </p>
    <div className="flex flex-wrap gap-3 mt-3">
      <a
        href="https://github.com/cameronjim"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-sm btn-ghost gap-2"
      >
        <Github size={14} /> GitHub
      </a>
      <a
        href="mailto:cameroncjim@gmail.com"
        className="btn btn-sm btn-ghost gap-2"
      >
        Email
      </a>
    </div>
  </section>
);

interface SectionHeaderProps {
  icon: typeof Code2;
  title: string;
}

const SectionHeader = ({ icon: Icon, title }: SectionHeaderProps) => (
  <div className="flex items-center gap-2 mb-4">
    <Icon size={18} className="text-primary" />
    <h2 className="text-xl font-semibold">{title}</h2>
  </div>
);

interface StackCardProps {
  title: string;
  items: string[];
  icon?: typeof Code2;
}

const StackCard = ({ title, items, icon: Icon }: StackCardProps) => (
  <div className="card bg-base-200">
    <div className="card-body p-5">
      <h3 className="card-title text-base flex items-center gap-2">
        {Icon ? <Icon size={16} className="text-primary" /> : null}
        {title}
      </h3>
      <ul className="space-y-1.5 mt-2">
        {items.map((item) => (
          <li key={item} className="text-sm opacity-80 flex items-start gap-2">
            <span className="text-primary mt-1.5 leading-none">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  </div>
);
