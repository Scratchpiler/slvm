import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, verify } from '../src/index.js';

const errorsOf = (body, { decls = 'var @x\n  list @l', legal = false } = {}) =>
    verify(parse(`sprite "S" {\n  ${decls}\n  ${body}\n}`), { legal });

const script = (ops) => `script flag {\n${ops}\n}`;

test('a well-formed script verifies', () => {
    assert.deepEqual(errorsOf(script('%0 = var.get @x\n%1 = gt %0, 3\nif %1 {\nvar.set @x, 0\n}')), []);
});

test('values must be defined before use', () => {
    assert.match(errorsOf(script('var.set @x, %0\n%0 = add 1, 2')).join(), /used before definition/);
});

test('values do not escape the region that defines them', () => {
    assert.match(errorsOf(script('repeat 3 {\n%0 = add 1, 2\n}\nvar.set @x, %0')).join(), /out of scope/);
});

test('round reporters cannot go in boolean slots', () => {
    assert.match(errorsOf(script('%0 = var.get @x\nif %0 {\n}')).join(), /round reporter/);
});

test('undeclared variables and list/var mixups are caught', () => {
    const errs = errorsOf(script('var.set @y, 1\nlist.add @x, 1')).join('\n');
    assert.match(errs, /undeclared var @y/);
    assert.match(errs, /undeclared list @x/);
});

test('break must be inside a loop body, not a condition region', () => {
    assert.match(errorsOf(script('break')).join(), /outside a loop/);
    assert.deepEqual(errorsOf(script('forever {\nbreak\n}')), []);
});

test('nothing may follow a terminator', () => {
    assert.match(errorsOf(script('stop "this script"\nvar.set @x, 1')).join(), /unreachable op after `stop`/);
    assert.match(errorsOf(script('forever {\n}\nvar.set @x, 1')).join(), /unreachable op after `forever`/);
    assert.deepEqual(errorsOf(script('stop "other scripts in sprite"\nvar.set @x, 1')), []);
});

test('ret with a value needs a `returns` proc', () => {
    assert.match(errorsOf('proc @f() {\nret 1\n}').join(), /not declared `returns`/);
    assert.deepEqual(errorsOf('proc @f() returns {\nret 1\n}'), []);
});

test('calls are checked against the callee signature', () => {
    const errs = errorsOf(`proc @f(a) {\n}\n${script('%0 = call @f(1, 2)')}`).join('\n');
    assert.match(errs, /takes 1 argument/);
    assert.match(errs, /does not return a value/);
});

test('legal mode rejects constructs the Scratch backend cannot emit', () => {
    const src = `proc @f() returns {\nret 1\n}\n${script('%0 = call @f()\nuntil {\n%1 = call @f()\n%2 = eq %1, 1\ncond %2\n} do {\nbreak\n}\nif true {\n}')}`;
    const errs = errorsOf(src, { legal: true }).join('\n');
    assert.match(errs, /lower-ret/);
    assert.match(errs, /lower-break/);
    assert.match(errs, /rotate the loop/);
    assert.match(errs, /materialize/);
});
