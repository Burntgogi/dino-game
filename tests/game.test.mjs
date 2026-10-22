import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const entries = ['index.html', 'dino_Qwen36plus27b.html'];
const read = entry => fs.readFileSync(new URL(`../${entry}`, import.meta.url), 'utf8');

function boot(entry, { blockedRead = false, blockedWrite = false, saved = null } = {}) {
  const events = new Map();
  let nextFrame;
  let writes = [];
  const ctx = new Proxy({}, {get: (object, key) => object[key] ?? (() => {}), set: (object, key, value) => (object[key] = value, true)});
  const listen = (name, fn) => events.set(name, fn);
  const canvas = {width: 800, height: 250, getContext: () => ctx, addEventListener: listen,
    getBoundingClientRect: () => ({top: 10, left: 12, width: 400, height: 125})};
  const storage = {getItem: () => saved, setItem: (key, value) => {
    if (blockedWrite) throw new Error('Synthetic quota failure');
    writes.push([key, value]);
  }};
  const math = Object.create(Math);
  math.random = () => 0.99; // Stable terrain and no random obstacle spawns.
  const scope = vm.createContext({document: {getElementById: () => canvas, addEventListener: listen}, Math: math,
    requestAnimationFrame: fn => { nextFrame = fn; }});
  Object.defineProperty(scope, 'localStorage', {get() {
    if (blockedRead) throw new Error('Synthetic denied storage');
    return storage;
  }});
  const source = read(entry).match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(source, scope, {filename: entry});
  return {
    run: code => vm.runInContext(code, scope),
    frame: timestamp => { const fn = nextFrame; nextFrame = null; assert.equal(typeof fn, 'function'); fn(timestamp); },
    events, writes,
    hasFrame: () => typeof nextFrame === 'function',
  };
}

function simulate(entry, fps, milliseconds) {
  const game = boot(entry);
  game.run('jump(); jump(); obstacles = [{x: 1000, y: 193, width: 17, height: 35, type: "cactusSmall"}];');
  game.frame(0);
  for (let i = 1; i <= Math.round(fps * milliseconds / 1000); i++) game.frame(i * 1000 / fps);
  return JSON.parse(game.run('JSON.stringify({score, gameSpeed, frameCount, x: obstacles[0].x, y: dino.y, jumping: dino.isJumping})'));
}

test('hosted and downloadable game entrypoints stay equivalent', () => assert.equal(read(entries[0]), read(entries[1])));

for (const entry of entries) {
  test(`${entry}: denied storage still registers input and starts animation`, () => {
    const game = boot(entry, {blockedRead: true});
    assert.equal(game.run('highScore'), 0);
    assert.ok(game.events.has('keydown'));
    assert.ok(game.hasFrame());
    game.run('jump()'); game.frame(0); game.frame(1000 / 60);
    assert.ok(game.run('score') > 0);
  });

  test(`${entry}: invalid high scores fall back to zero`, () => {
    for (const saved of ['broken', '-1', 'Infinity', '2.5']) assert.equal(boot(entry, {saved}).run('highScore'), 0);
    assert.equal(boot(entry, {saved: '123'}).run('highScore'), 123);
  });

  test(`${entry}: failed record write preserves game over rendering and restart`, () => {
    const game = boot(entry, {blockedWrite: true});
    game.run('jump(); score = 10; obstacles = [{x: 65, y: 193, width: 17, height: 35, type: "cactusSmall"}];');
    game.frame(0); game.frame(1000 / 60);
    assert.equal(game.run('gameOver'), true);
    assert.equal(game.run('highScore'), 10);
    assert.ok(game.hasFrame());
    game.run('jump()'); game.frame(2000 / 60);
    assert.equal(game.run('gameOver'), false);
    assert.equal(game.run('highScore'), 10);
    assert.ok(game.run('score') > 0);
  });

  test(`${entry}: record writes retain the existing storage key`, () => {
    const game = boot(entry, {saved: '5'});
    game.run('jump(); score = 10; obstacles = [{x: 65, y: 193, width: 17, height: 35, type: "cactusSmall"}];');
    game.frame(0); game.frame(1000 / 60);
    assert.deepEqual(game.writes, [['dinoHighScore', '10']]);
  });

  test(`${entry}: one second has identical simulation at 30/60/120/144 Hz`, () => {
    const expected = simulate(entry, 60, 1000);
    assert.equal(expected.frameCount, 60);
    assert.ok(Math.abs(expected.score - 7.2) < 1e-8);
    for (const fps of [30, 120, 144]) assert.deepEqual(simulate(entry, fps, 1000), expected);
  });

  test(`${entry}: jump trajectory is independent of display frequency`, () => {
    const expected = simulate(entry, 60, 500);
    for (const fps of [30, 120, 144]) assert.deepEqual(simulate(entry, fps, 500), expected);
    assert.ok(expected.jumping);
    assert.ok(expected.y < 180);
  });

  test(`${entry}: resuming after a long frame gap does not fast-forward the run`, () => {
    const game = boot(entry);
    game.run('jump()'); game.frame(0); game.frame(10000);
    assert.ok(game.run('frameCount') <= 6);
    assert.ok(game.run('score') <= 0.73);
  });

  test(`${entry}: touch regions use the rendered canvas height`, () => {
    const game = boot(entry);
    game.run('jump()');
    const touch = game.events.get('touchstart');
    touch({preventDefault() {}, touches: [{clientY: 10 + 100}]}); // Lower 40% of 125px canvas.
    assert.equal(game.run('dino.isDucking'), true);
    assert.equal(game.run('dino.isJumping'), false);
    game.events.get('touchend')({preventDefault() {}});
    assert.equal(game.run('dino.isDucking'), false);
    touch({preventDefault() {}, touches: [{clientY: 10 + 25}]});
    assert.equal(game.run('dino.isJumping'), true);
  });
}
