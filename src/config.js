import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    console.error(
      `\n[config] Missing required environment variable ${name}.\n` +
        `Copy .env.example to .env and fill it in. See README.md.\n`,
    );
    process.exit(1);
  }
  return value.trim();
}

export const config = {
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: (process.env.ANTHROPIC_MODEL || 'claude-opus-4-8').trim(),

  housecallApiKey: required('HOUSECALL_API_KEY'),
  housecallApiBase: (process.env.HOUSECALL_API_BASE || 'https://api.housecallpro.com')
    .trim()
    .replace(/\/+$/, ''),

  // Optional shared-password gate. Empty string => no auth.
  appPassword: (process.env.APP_PASSWORD || '').trim(),

  port: Number(process.env.PORT || 3000),
};
