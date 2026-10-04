# node-project fixture

Dependency-free ESM package: `src/index.js` exports `sum` and `divide`.

`scripts/build.js` writes `dist/bundle.txt`. Tests use the built-in
`node:test` runner, so no install step is ever required.

Start: `npm start` (or `node src/index.js`). Test: `npm test`,
which runs `node --test "test/**/*.test.js"` — a glob, because this Node 22
build treats a bare `node --test test/` directory argument as a module path.
