// `prepare` runs on every install; the hook is for people committing, not for CI or Vercel's builds. An install
// without devDependencies has no husky: skip quietly.
/* global process, console */
if (!process.env.CI)
  await import('husky').then(
    ({ default: husky }) => console.log(husky()),
    () => {}
  )
