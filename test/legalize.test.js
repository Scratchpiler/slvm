import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, print, verify, run, runPipeline, LegalizeError, StepLimitExceeded } from '../src/index.js';

const examples = new URL('../examples/', import.meta.url);
const load = (file) => parse(readFileSync(new URL(file, examples), 'utf8'));
const legalize = (mod, passes = ['legalize']) => runPipeline(mod, passes);
const observable = ({ vars, lists, trace }) => ({
    vars: Object.fromEntries(Object.entries(vars).filter(([k]) => !k.startsWith('_'))),
    lists: Object.fromEntries(Object.entries(lists).filter(([k]) => !k.startsWith('_'))),
    trace,
});

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sl'))) {
    test(`${file}: legalized IR verifies as legal`, () => {
        assert.deepEqual(verify(legalize(load(file)), { legal: true }), []);
    });

    test(`${file}: legalized IR run as Scratch would agrees with the original`, (t) => {
        let before;
        try {
            before = observable(run(load(file), { maxSteps: 1e5 }));
        } catch (e) {
            if (!(e instanceof StepLimitExceeded)) throw e;
            return t.skip('does not terminate');
        }
        const after = observable(run(legalize(load(file)), { tree: true, maxSteps: 1e5 }));
        assert.deepEqual(after, before);
    });
}

test('the interpreter computes the examples as expected', () => {
    assert.equal(run(load('fib.sl')).vars.result, 55);
    const loops = run(load('loops.sl'));
    assert.deepEqual(
        { evens: loops.vars.evens, steps: loops.vars.steps, found: loops.vars.found, polls: loops.vars.polls },
        { evens: 4, steps: 8, found: 3, polls: 5 },
    );
    assert.deepEqual(loops.lists.log, [2, 4, 6, 'poll', 'poll', 'poll', 'poll']);
});

test('without spill, nesting a call result past the next call gives the wrong answer', () => {
    const passes = ['lower-ret', 'lower-break', 'rotate-cond', 'materialize-bool'];
    assert.equal(run(legalize(load('return-functions.sl'), passes), { tree: true }).trace.length, 0);
    assert.notEqual(run(legalize(load('fib.sl'), passes), { tree: true }).vars.result, 55);
});

test('return-functions needs exactly one spill temp', () => {
    const out = print(legalize(load('return-functions.sl')));
    assert.equal(out.match(/var @_scratchpiler_internal_slvm_spill\d+/g).length, 1);
});

test('a recursive spill goes through the stack and pops before an early return', () => {
    const mod = legalize(parse(`stage {\n  var @r\n}\nsprite "S" {\n  proc @f(n) warp returns {\n    %0 = arg n\n    %1 = lt %0, 1\n    if %1 {\n      ret 0\n    }\n    %2 = sub %0, 1\n    %3 = call @f(%2)\n    %9 = gt %0, 100\n    if %9 {\n      ret 1\n    }\n    %4 = call @f(%2)\n    %5 = add %3, %4\n    %6 = add %5, 1\n    ret %6\n  }\n  script flag {\n    %0 = call @f(5)\n    var.set @r, %0\n  }\n}\n`));
    const out = print(mod);
    assert.match(out, /list.add @_scratchpiler_internal_slvm_stack/);
    assert.match(out, /var.set @__ret_f, 1\n\s+%\d+ = list.len @_scratchpiler_internal_slvm_stack\n\s+list.del @_scratchpiler_internal_slvm_stack, %\d+\n\s+stop "this script"/);
    const { vars, lists } = run(mod, { tree: true });
    assert.equal(vars.r, 31);
    assert.deepEqual(lists._scratchpiler_internal_slvm_stack, []);
});

test('a value used twice across a recursive call is reported, not miscompiled', () => {
    const mod = parse(`sprite "S" {\n  var @r\n  proc @f(n) warp returns {\n    var.change @r, 1\n    %0 = arg n\n    %1 = lt %0, 1\n    if %1 {\n      ret 0\n    }\n    %2 = var.get @r\n    %3 = sub %0, 1\n    %4 = call @f(%3)\n    %5 = add %2, %4\n    %6 = add %5, %2\n    ret %6\n  }\n}\n`);
    assert.throws(() => legalize(mod), LegalizeError);
});

test('a read used twice is re-read rather than spilled when nothing can change it', () => {
    const src = (between) => `sprite "S" {\n  var @x\n  var @y\n  script flag {\n    %0 = var.get @x\n    var.set @y, %0\n    ${between}\n    var.change @y, %0\n  }\n}\n`;
    const quiet = print(legalize(parse(src('var.set @y, 0'))));
    assert.doesNotMatch(quiet, /slvm_spill/);
    assert.equal(quiet.match(/var.get @x/g).length, 2);
    assert.match(print(legalize(parse(src('var.set @x, 0')))), /slvm_spill/);
});

test('random is never re-read, since that would draw a second number', () => {
    const out = print(legalize(parse(`sprite "S" {\n  var @y\n  script flag {\n    %0 = random 1, 10\n    var.set @y, %0\n    var.change @y, %0\n  }\n}\n`)));
    assert.equal(out.match(/random/g).length, 1);
    assert.match(out, /slvm_spill/);
});

test('reads of user variables are spilled across a yield, internal ones are not', () => {
    const src = (internal) => `sprite "S" {\n  var @x${internal ? ' internal' : ''}\n  var @y\n  script flag {\n    %0 = var.get @x\n    wait 1\n    var.set @y, %0\n  }\n}\n`;
    assert.match(print(legalize(parse(src(false)))), /slvm_spill/);
    assert.doesNotMatch(print(legalize(parse(src(true)))), /slvm_spill/);
});

test('a read outside a non-warp loop is spilled when the loop yields', () => {
    const src = (warp) => `sprite "S" {\n  var @x\n  var @y\n  proc @p()${warp ? ' warp' : ''} {\n    %0 = var.get @x\n    repeat 3 {\n      var.change @y, %0\n    }\n  }\n}\n`;
    assert.match(print(legalize(parse(src(false)))), /slvm_spill/);
    assert.doesNotMatch(print(legalize(parse(src(true)))), /slvm_spill/);
});

test('lower-break turns forever+break into until on a flag', () => {
    const out = print(legalize(parse(`sprite "S" {\n  var @x\n  script flag {\n    forever {\n      var.change @x, 1\n      break\n    }\n  }\n}\n`), ['lower-break']));
    assert.doesNotMatch(out, /forever|break/);
    assert.match(out, /var.set @_scratchpiler_internal_slvm_brk0, 0\n\s+until \{/);
});

test('materialize-bool uses the same 1 = 1 form as compile()', () => {
    const out = print(legalize(parse(`sprite "S" {\n  script flag {\n    if true {\n      wait 1\n    }\n  }\n}\n`), ['materialize-bool']));
    assert.match(out, /%0 = eq "1", "1"\n\s+if %0/);
});

test('lower-ret drops a trailing stop and keeps early ones', () => {
    const out = print(legalize(load('fib.sl'), ['lower-ret']));
    assert.equal(out.match(/stop "this script"/g).length, 1);
    assert.doesNotMatch(out, /\bret\b/);
});
