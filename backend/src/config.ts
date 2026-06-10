// startup configuration guards. these run at import time so a misconfigured
// deploy fails closed (crashes on boot) instead of running insecure.

// secrets that ship in .env.example / docs. accepting one of these in
// production would mean every token is forgeable with a publicly known key.
const PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-long-random-secret',
  'your-secret-here',
  'changeme',
]);

const MIN_SECRET_LENGTH = 32;

/**
 * Throws unless AUTH_SECRET is a strong, non-placeholder signing key. Called
 * once when the app module loads. A weak or missing secret undermines every
 * JWT in the system, so we refuse to start rather than sign tokens with it.
 */
export function validateAuthSecret(secret: string | undefined): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `AUTH_SECRET must be set to a random string of at least ${MIN_SECRET_LENGTH} characters`
    );
  }
  if (PLACEHOLDER_SECRETS.has(secret)) {
    throw new Error('AUTH_SECRET is set to a known placeholder value; generate a real secret');
  }
}
