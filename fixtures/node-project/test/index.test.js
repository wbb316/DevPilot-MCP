import assert from "node:assert/strict";
import test from "node:test";

import { divide, sum } from "../src/index.js";

test("sum adds two numbers", () => {
  assert.equal(sum(2, 3), 5);
});

test("divide returns a quotient", () => {
  assert.equal(divide(10, 4), 2.5);
});

test("divide throws on a zero divisor", () => {
  assert.throws(() => divide(1, 0), /division by zero/);
});
