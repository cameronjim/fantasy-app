import { Github, ShieldCheck, GitBranch, Database, Cloud, Code2, TestTube2 } from 'lucide-react';

// every tech mentioned here must actually be in use in the repo, nothing aspirational.

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
      Fantasy NBA, a full-stack app with AI assist
    </h1>
    <p className="text-base opacity-70 leading-relaxed max-w-2xl">
      This is a personal full-stack basketball app that combines real NBA
      stats, a personal fantasy roster, and Claude-powered analysis. I built
      it end to end as a portfolio piece. It runs in production with real
      CI/CD, automated tests across every layer, and a live data scraper
      that updates the stats on a six-hour schedule.
    </p>
  </section>
);

const TechStack = () => (
  <section>
    <SectionHeader icon={Code2} title="Tech stack" />
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <StackCard
        title="Frontend"
        items={[
          'React 18 with TypeScript in strict mode',
          'Vite 6 build tooling',
          'Tailwind 4 and DaisyUI 5 components',
          'React Router 7 for client-side routing',
          'Axios for the typed API client',
          '@react-oauth/google for Google Sign-In',
        ]}
      />
      <StackCard
        title="Backend"
        items={[
          'Node.js 20 with Express 4',
          'TypeScript ESM using NodeNext resolution',
          'PostgreSQL via the pg driver',
          'JWT auth with bcryptjs password hashing',
          '@anthropic-ai/sdk (Claude) for the AI features',
          'AWS SDK v3 for SES password-reset email',
        ]}
      />
      <StackCard
        title="Infrastructure"
        items={[
          'AWS Lambda and HTTP API Gateway for the backend',
          'S3 and CloudFront for the frontend static hosting',
          'Neon serverless Postgres with dev branching',
          'AWS SES for transactional email',
          'CloudFormation via Serverless Framework v3',
          'OIDC trust between GitHub Actions and AWS, so no long-lived access keys live in the repo',
        ]}
      />
      <StackCard
        title="Data pipeline"
        items={[
          'Python with the nba_api library and requests',
          'Beautiful Soup for CBS Sports injury parsing',
          'A scheduled scrape every six hours via GitHub Actions cron',
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
          The app sits on top of a Postgres stats database. The frontend is a
          single-page React app that calls a Lambda-hosted Express API, which
          reads from Postgres for player, team, and game data, and from the
          Anthropic Claude API for the analysis surfaces. A separate Python
          scraper runs on its own cron, writing fresh stats into Postgres
          independently of the web app, so the API never has to wait on data
          collection.
        </p>
        <h3 className="text-base font-semibold mt-4 mb-2">Separation of concerns</h3>
        <ul className="space-y-1 text-sm opacity-80">
          <li>
            <strong>Components</strong> render UI. Every flow has explicit
            loading, empty, error, and success states.
          </li>
          <li>
            <strong>Hooks</strong> coordinate state and side effects, such as
            theme toggling and client-side AI response caching.
          </li>
          <li>
            <strong>The API client</strong> is the only place that talks HTTP.
            No component fetches directly.
          </li>
          <li>
            <strong>Route handlers</strong> validate input and return JSON,
            and the <code className="text-xs">requireAuth</code> middleware
            binds the JWT's user id so query parameters are never
            client-supplied.
          </li>
          <li>
            <strong>Services</strong> own business logic such as fantasy
            scoring, Anthropic calls, and SES sends. All database access
            funnels through a single parameterized{' '}
            <code className="text-xs">query()</code> helper.
          </li>
        </ul>
        <h3 className="text-base font-semibold mt-4 mb-2">Fantasy scoring engine</h3>
        <p className="opacity-80">
          The scoring service implements every major industry format,
          including NBA.com's <code className="text-xs">NBA_FANTASY_PTS</code>,
          FanDuel, DraftKings (with double-double and triple-double bonuses),
          ESPN H2H Points, and Yahoo High Score, plus a z-score variant for
          nine-category leagues. Scores currently render using the NBA standard
          formula; wiring per-user format selection through to the preferences
          system is still on the list.
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
          'Strict TypeScript across both frontend and backend',
          'A single AGENTS.md style guide with role-specific sections',
          'No `any`, no `@ts-ignore`, and lowercase comments that explain why rather than what',
          'Parameterized SQL only; user input never gets string-interpolated into a query',
          'Centralized brand color tokens so no component hardcodes a hex value',
        ]}
      />
      <StackCard
        icon={TestTube2}
        title="Testing"
        items={[
          'Vitest unit tests for pure logic like scoring and validation',
          'Vitest with Supertest API tests for every route, against a mocked database',
          'Playwright E2E tests using the Page Object Model',
          'AWS and Anthropic are mocked in CI so no live calls are ever made',
          'Tests follow AAA structure with behavior-focused names',
        ]}
      />
      <StackCard
        icon={ShieldCheck}
        title="Security"
        items={[
          'bcrypt for password hashing at a cost factor of 10',
          'JWTs verified server-side, with every user-scoped query bound to the JWT id',
          'Google Sign-In with full token verification against Google',
          'Password-reset tokens stored as SHA-256 hashes and consumed exactly once',
          'Forgot-password always returns the same response for known and unknown emails to prevent enumeration',
          'CORS allow-list is driven by an environment variable, per environment',
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
              <li>Backend typecheck and unit and API tests run</li>
              <li>Frontend typecheck, unit tests, and a production build run</li>
              <li>The full Playwright E2E suite runs on Chromium with cached browser binaries</li>
              <li>
                If everything is green, the backend deploys to{' '}
                <code className="text-xs">--stage dev</code> on Lambda, the
                frontend bundle syncs to a dev S3 bucket, and the dev
                CloudFront distribution is invalidated.
              </li>
              <li>The preview is live at a fixed dev URL within about three minutes.</li>
            </ol>
          </div>
          <div>
            <h3 className="text-base font-semibold mb-2 flex items-center gap-2">
              <Cloud size={16} className="text-primary" />
              On merge to <code className="text-xs">main</code>
            </h3>
            <ol className="space-y-1.5 text-sm opacity-80 list-decimal list-inside">
              <li>CI re-runs on the merge commit</li>
              <li>
                Production deploy fires:{' '}
                <code className="text-xs">serverless deploy --stage prod</code>
              </li>
              <li>
                Frontend syncs to the prod S3 bucket with content-hashed asset
                caching and index.html invalidation
              </li>
              <li>
                A smoke test runs against{' '}
                <code className="text-xs">/api/health</code> and the frontend
                root URL
              </li>
              <li>Branch protection blocks the merge button until all checks are green</li>
            </ol>
          </div>
        </div>
        <p className="text-xs opacity-50 mt-5">
          Database migrations are kept manual on purpose. Every schema change
          runs through Neon's SQL editor with human review, while Lambda's
          built-in versioning provides sub-minute rollback for any code
          regression.
        </p>
      </div>
    </div>
  </section>
);

const Footer = () => (
  <section className="border-t border-base-300 pt-6">
    <div className="flex flex-wrap gap-3">
      <a
        href="https://github.com/cameronjim"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-sm btn-ghost gap-2"
      >
        <Github size={14} /> GitHub
      </a>
      <a
        href="mailto:cjim02@student.ubc.ca"
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
