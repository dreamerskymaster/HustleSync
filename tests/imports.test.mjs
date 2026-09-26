// Guards the split between src/jobMapping.js and src/App.jsx.
//
// A refactor moved seedForm and submitJob into jobMapping.js without exporting
// them or importing them back. The build succeeded, every other test passed,
// and the app crashed to a blank screen the moment anyone opened a job form,
// because a bundler does not resolve free variables and nothing called those
// functions in a test. This checks what the compiler will not.
//
//   node tests/imports.test.mjs

import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const mapping = readFileSync(new URL('../src/jobMapping.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; console.log(`    FAIL  ${name}${detail ? '  <- ' + detail : ''}`); }
};

const declaredIn = (src) =>
  new Set([...src.matchAll(/^(?:export\s+)?(?:const|let|var|function|async function|class)\s+(\w+)/gm)].map(m => m[1]));

const exportedFrom = (src) =>
  new Set([...src.matchAll(/^export\s+(?:const|function|async function|class)\s+(\w+)/gm)].map(m => m[1]));

const importMatch = app.match(/import\s*\{([^}]+)\}\s*from\s*'\.\/jobMapping\.js'/s);
const imported = new Set(
  importMatch ? importMatch[1].split(',').map(s => s.trim()).filter(Boolean) : []
);

const appDeclared = declaredIn(app);
const mappingDeclared = declaredIn(mapping);
const mappingExported = exportedFrom(mapping);

console.log('\nTEST 6  Module boundary');

ok('App.jsx imports from jobMapping.js', imported.size > 0, 'no import found at all');

// Everything App.jsx imports must actually be exported.
const notExported = [...imported].filter(name => !mappingExported.has(name));
ok('every imported name is exported', notExported.length === 0, notExported.join(', '));

// The regression: a helper that lives in jobMapping.js, is referenced in
// App.jsx, but is neither exported nor imported.
const unreachable = [...mappingDeclared].filter(name => {
  if (mappingExported.has(name)) return false;
  if (appDeclared.has(name)) return false;              // App has its own copy
  return new RegExp(`\\b${name}\\s*\\(`).test(app);      // App calls it anyway
});
ok('App.jsx never calls an unexported jobMapping helper', unreachable.length === 0, unreachable.join(', '));

// Anything App.jsx uses from the module must be imported, not assumed global.
const usedButNotImported = [...mappingExported].filter(name =>
  !imported.has(name) && !appDeclared.has(name) && new RegExp(`\\b${name}\\b`).test(app)
);
ok('every used export is imported', usedButNotImported.length === 0, usedButNotImported.join(', '));

// jobMapping.js must stay pure, or it cannot be unit tested without a browser.
for (const forbidden of ['supabase', 'Capacitor', 'document', 'window', 'localStorage', 'react']) {
  ok(`jobMapping.js does not touch ${forbidden}`, !new RegExp(`\\b${forbidden}\\b`).test(mapping));
}

// A render crash must never reach the user as a blank screen again.
const main = readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
ok('the app is wrapped in an error boundary', /<ErrorBoundary>/.test(main));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
