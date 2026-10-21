#!/usr/bin/env node
/**
 * Compiles the Vercel functions and actually IMPORTS them under Node ESM.
 *
 * WHY THIS EXISTS. The first version of api/cron/daily-notifications shipped
 * with `import ... from '../../src/lib/metrics'` - no file extension. That
 * typechecked clean, built clean, and died in production with
 * ERR_MODULE_NOT_FOUND, because package.json declares "type": "module" and
 * Node ESM will not resolve an extensionless relative specifier.
 *
 * `tsc --noEmit` cannot catch that on its own: under moduleResolution
 * "bundler" the extensionless form is legal, and even under "nodenext" tsc is
 * only reasoning about specifiers, never loading a module. The only check that
 * reproduces the production failure is asking Node to import the compiled
 * output, which is what this does.
 *
 * It is deliberately not a unit test. It answers one question - can Node load
 * this function at all - and that is the question that was answered wrongly.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const out = mkdtempSync(join(tmpdir(), 'api-verify-'))

/** Entry points to load. Add a line here when a new function is added. */
const ENTRIES = [
  'api/cron/office-alerts.js',
  'api/office/knock-ping.js',
  'api/office/task-notify.js',
  'api/team/invite.js',
  'api/auth/recover.js',
]

const cfg = join(out, 'tsconfig.json')
writeFileSync(
  cfg,
  JSON.stringify({
    compilerOptions: {
      target: 'es2023',
      lib: ['ES2023', 'DOM'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      types: ['node'],
      skipLibCheck: true,
      // Types are already enforced by `npm run typecheck:api`. This pass only
      // needs runnable JavaScript, so a type error must not stop it emitting.
      strict: false,
      noEmitOnError: false,
      outDir: out,
      rootDir: root,
      noEmit: false,
      verbatimModuleSyntax: true,
      moduleDetection: 'force',
    },
    include: [join(root, 'api/**/*.ts'), join(root, 'src/lib/**/*.ts'), join(root, 'src/types/**/*.ts')],
  }),
)

let failed = false
try {
  try {
    execFileSync('npx', ['tsc', '-p', cfg], { cwd: root, stdio: 'pipe' })
  } catch {
    // Type errors are expected to be caught elsewhere; emit still happened.
  }

  // Node resolves bare specifiers through node_modules and reads "type" from
  // the nearest package.json, so both have to look the way they will in the
  // deployed function.
  writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }))
  const link = join(out, 'node_modules')
  if (!existsSync(link)) symlinkSync(join(root, 'node_modules'), link, 'dir')

  for (const entry of ENTRIES) {
    const file = join(out, entry)
    if (!existsSync(file)) {
      console.error(`  FAIL  ${entry} was not emitted`)
      failed = true
      continue
    }
    try {
      await import(pathToFileURL(file).href)
      console.log(`  ok    ${entry} loads under Node ESM`)
    } catch (err) {
      failed = true
      console.error(`  FAIL  ${entry}`)
      console.error(`        ${err.code ?? 'Error'}: ${String(err.message).split('\n')[0]}`)
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        console.error(
          '        Relative imports need an explicit .js extension under "type": "module".',
        )
      }
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
