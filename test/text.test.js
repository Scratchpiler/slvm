import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, print, ParseError } from '../src/index.js';

const examples = new URL('../examples/', import.meta.url);

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sl'))) {
    test(`print is a fixed point of parse for ${file}`, () => {
        const once = print(parse(readFileSync(new URL(file, examples), 'utf8')));
        assert.equal(print(parse(once)), once);
    });
}

test('quoted names survive a round trip', () => {
    const src = 'sprite "Cat 2" {\n  var @"my var"\n\n  script receive "go!" {\n    var.set @"my var", "a \\"b\\""\n  }\n}\n';
    assert.equal(print(parse(src)), src);
});

test('values are renumbered in definition order', () => {
    const out = print(parse('stage {\n  var @x\n  script flag {\n    %b = var.get @x\n    %a = add %b, 1\n    var.set @x, %a\n  }\n}'));
    assert.match(out, /%0 = var.get @x\n\s+%1 = add %0, 1\n\s+var.set @x, %1/);
});

test('unknown ops are parse errors with a line number', () => {
    assert.throws(() => parse('stage {\n  script flag {\n    frobnicate 1\n  }\n}'), (e) => e instanceof ParseError && e.line === 3);
});
