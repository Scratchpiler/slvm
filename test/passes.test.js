import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, runPipeline } from '../src/index.js';

const opt = (body, passes = ['constfold', 'dce']) =>
    print(runPipeline(parse(`sprite "S" {\n  var @x\n  script flag {\n${body}\n  }\n}`), passes));

test('comparisons follow Scratch: case-insensitive, numeric when both sides parse', () => {
    assert.match(opt('%0 = eq "Apple", "APPLE"\nvar.set @x, %0'), /var.set @x, true/);
    assert.match(opt('%0 = eq "10", "10.0"\nvar.set @x, %0'), /var.set @x, true/);
    assert.match(opt('%0 = lt " ", 1\nvar.set @x, %0'), /var.set @x, true/);
});

test('arithmetic follows Scratch casts and mod sign', () => {
    assert.match(opt('%0 = add "abc", 1\nvar.set @x, %0'), /var.set @x, 1\n/);
    assert.match(opt('%0 = mod -1, 3\nvar.set @x, %0'), /var.set @x, 2\n/);
    assert.match(opt('%0 = join 1, 2\nvar.set @x, %0'), /var.set @x, "12"/);
    assert.match(opt('%0 = math.sin 30\nvar.set @x, %0'), /var.set @x, 0.5\n/);
});

test('x + 0 is a numeric cast in Scratch, not an identity', () => {
    assert.match(opt('%0 = var.get @x\n%1 = add %0, 0\nvar.set @x, %1'), /add %0, 0/);
});

test('division by zero is left for the runtime', () => {
    assert.match(opt('%0 = div 1, 0\nvar.set @x, %0'), /div 1, 0/);
});

test('if with a constant condition is replaced by the taken branch', () => {
    const out = opt('%0 = gt 2, 1\nif %0 {\nvar.set @x, "yes"\n} else {\nvar.set @x, "no"\n}');
    assert.doesNotMatch(out, /if|"no"/);
    assert.match(out, /var.set @x, "yes"/);
});

test('folding a branch that ends in a terminator drops what follows', () => {
    const out = opt('if true {\nstop "this script"\n}\nvar.set @x, 1');
    assert.doesNotMatch(out, /var.set/);
});

test('boolean identities and double negation', () => {
    const out = opt('%0 = var.get @x\n%1 = gt %0, 1\n%2 = and true, %1\n%3 = not %2\n%4 = not %3\nif %4 {\nvar.set @x, 0\n}');
    assert.match(out, /%1 = gt %0, 1\n\s+if %1 \{/);
});

test('repeat 0 and until-true vanish, forever never does', () => {
    const out = opt('repeat 0 {\nvar.change @x, 1\n}\nuntil {\ncond true\n} do {\nvar.change @x, 1\n}\nforever {\n}');
    assert.doesNotMatch(out, /repeat|until/);
    assert.match(out, /forever/);
});

test('dce removes unused pure and read ops but never writes', () => {
    const out = opt('%0 = var.get @x\n%1 = random 1, 10\n%2 = add %0, %1\nvar.set @x, 5', ['dce']);
    assert.doesNotMatch(out, /var.get|random|add/);
    assert.match(out, /var.set @x, 5/);
});
