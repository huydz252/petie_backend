import { test } from "node:test";
import assert from "node:assert/strict";
import { distanceKm, fuzz } from "./security.js";
test("fuzz displaces public location 200–500m", () => {
  for (let i = 0; i < 100; i++) {
    const p = fuzz(10.7769, 106.7009);
    const d = distanceKm(10.7769, 106.7009, p.latitude, p.longitude);
    assert.ok(d >= 0.1999 && d <= 0.5001);
  }
});
test("same point has zero distance", () =>
  assert.equal(distanceKm(0, 0, 0, 0), 0));

test("seeded fuzz is stable and remains in privacy radius", () => {
  const seed = Buffer.alloc(32, 42);
  const a = fuzz(10.7769, 106.7009, seed),
    b = fuzz(10.7769, 106.7009, seed);
  assert.deepEqual(a, b);
  const d = distanceKm(10.7769, 106.7009, a.latitude, a.longitude);
  assert.ok(d >= 0.1999 && d <= 0.5001);
});
