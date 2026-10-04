/** Tiny dependency-free module used by the fixture tests. */

import { pathToFileURL } from "node:url";

export function sum(a, b) {
  return a + b;
}

export function divide(a, b) {
  if (b === 0) {
    throw new Error("division by zero");
  }
  return a / b;
}

export function main() {
  const line = `sum(2, 3) = ${sum(2, 3)}, divide(10, 4) = ${divide(10, 4)}`;
  console.log(line);
  return line;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
