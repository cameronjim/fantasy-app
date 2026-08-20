
const PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-long-random-secret',
  'your-secret-here',
  'changeme',
]);

const MIN_SECRET_LENGTH = 32;

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
