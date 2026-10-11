import assert from 'node:assert/strict';
import test from 'node:test';
import { prerequisitePath } from '../lib/engine/schedule-routing.js';

const size = { width: 100, height: 60 };

function polyline(path) {
  assert.ok(!path.includes('Q'), 'Blocked paths must use a plain outside polyline.');
  return [...path.matchAll(/[ML] (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)]
    .map(([, x, y]) => ({ x: Number(x), y: Number(y) }));
}

function avoids(points, obstacle) {
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    assert.ok(a.x === b.x || a.y === b.y, 'Routes must remain orthogonal.');
    const insideX = Math.max(Math.min(a.x, b.x), obstacle.x) < Math.min(Math.max(a.x, b.x), obstacle.x + size.width);
    const insideY = Math.max(Math.min(a.y, b.y), obstacle.y) < Math.min(Math.max(a.y, b.y), obstacle.y + size.height);
    const hit = a.x === b.x
      ? a.x > obstacle.x && a.x < obstacle.x + size.width && insideY
      : a.y > obstacle.y && a.y < obstacle.y + size.height && insideX;
    assert.equal(hit, false, 'The route must not pass through another task.');
  }
}

test('prerequisite routing retains direct centers and rounded unobstructed orthogonal paths', () => {
  const source = { id: 'source', x: 0, y: 0 }, target = { id: 'target', x: 0, y: 120 };
  assert.equal(prerequisitePath(source, target, size, [source, target], ['source', 'target'], 400),
    'M 50 60 L 50 120');
  const diagonal = prerequisitePath(source, { x: 200, y: 120 }, size, [], [], 400);
  assert.match(diagonal, /^M 50 60 L 50 82 Q 50 90 58 90 L 242 90 Q 250 90 250 98 L 250 120$/);
  assert.ok(!diagonal.includes('400'), 'Clear routes must not visit the outer lane.');
});

test('prerequisite routing avoids horizontal card crossings without changing real endpoints', () => {
  const source = { id: 'source', x: 0, y: 0 }, target = { id: 'target', x: 200, y: 240 };
  const middle = { id: 'middle', x: 100, y: 120 };
  const path = prerequisitePath(source, target, size, [source, middle, target], ['source', 'target'], 400);
  const points = polyline(path);
  assert.deepEqual(points[0], { x: 50, y: 60 });
  assert.deepEqual(points.at(-1), { x: 250, y: 240 });
  assert.deepEqual(points.slice(1, -1), [
    { x: 50, y: 76 }, { x: 400, y: 76 }, { x: 400, y: 224 }, { x: 250, y: 224 },
  ]);
  avoids(points, middle);
});

test('prerequisite routing avoids vertical card crossings along a longer dependency', () => {
  const source = { id: 'source', x: 0, y: 0 }, target = { id: 'target', x: 0, y: 360 };
  const obstacles = [{ id: 'near-source', x: 0, y: 120 }, { id: 'near-target', x: 0, y: 240 }];
  const points = polyline(prerequisitePath(source, target, size,
    [source, ...obstacles, target], ['source', 'target'], 400));
  assert.deepEqual(points[0], { x: 50, y: 60 });
  assert.deepEqual(points.at(-1), { x: 50, y: 360 });
  obstacles.forEach(obstacle => avoids(points, obstacle));
});

test('prerequisite routing checks card clearance but does not invent dependency endpoints', () => {
  const source = { id: 'source', x: 0, y: 0 }, target = { id: 'target', x: 0, y: 240 };
  const beside = { id: 'beside', x: 53, y: 120 };
  const path = prerequisitePath(source, target, size, [source, beside, target], ['source', 'target'], 400);
  const points = polyline(path);
  assert.deepEqual(points[0], { x: 50, y: 60 });
  assert.deepEqual(points.at(-1), { x: 50, y: 240 });
  avoids(points, beside);
});
