// `prepare` runs on every install; the hook is for people committing, not for CI or Vercel's builds.
/* global process, console */
if (!process.env.CI) console.log((await import('husky')).default())
