import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, runPipeline, verify } from '../src/index.js';

const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const program = (body, { procs = '', script = 'script flag' } = {}) => `stage {
  var @user
  var @other
}

sprite "S" {
  var @_scratchpiler_internal_t internal
  var @_scratchpiler_internal_u internal
  var @local confined
  list @log
${procs}
  ${script} {
${body}
  }
}
`;

const dse = (source) => runPipeline(parse(source), ['dse']);
const scriptOf = (mod) => print(mod).split(/script \w+/)[1];
const count = (text, pattern) => (text.match(pattern) ?? []).length;

function sameBehaviour(source) {
    const reference = run(parse(source));
    const after = run(dse(source));
    assert.deepEqual(visible(after.vars), visible(reference.vars), 'vars');
    assert.deepEqual(visible(after.lists), visible(reference.lists), 'lists');
    assert.deepEqual(after.trace, reference.trace, 'trace');
    const optimized = runPipeline(parse(source), ['O1']);
    assert.deepEqual(verify(optimized, { legal: true }), []);
    const tree = run(optimized, { tree: true });
    assert.deepEqual(visible(tree.vars), visible(reference.vars), 'vars after O1');
    assert.deepEqual(visible(tree.lists), visible(reference.lists), 'lists after O1');
}

test('a store that is overwritten before anything can see it is removed', () => {
    const source = program('    var.set @user, 1\n    var.set @user, 2');
    assert.equal(count(scriptOf(dse(source)), /var\.set @user/g), 1);
    assert.match(scriptOf(dse(source)), /var\.set @user, 2/);
    sameBehaviour(source);
});

test('a set followed by changes folds into one set', () => {
    const source = program('    var.set @user, 1\n    var.change @user, 2\n    var.change @user, 3.5');
    const text = scriptOf(dse(source));
    assert.equal(count(text, /var\.\w+ @user/g), 1);
    assert.match(text, /var\.set @user, 6\.5/);
    sameBehaviour(source);
});

test('folding follows Scratch casting: text and booleans are numbers in a change', () => {
    for (const [stored, expected] of [['"abc"', 1], ['"12"', 13], ['true', 2], ['""', 1]]) {
        const source = program(`    var.set @user, ${stored}\n    var.change @user, 1`);
        assert.match(scriptOf(dse(source)), new RegExp(`var\\.set @user, ${expected}\\b`), stored);
        sameBehaviour(source);
    }
});

test('changes with an unknown amount are kept, but die with the store that overwrites them', () => {
    const kept = program('    %a = random 1, 6\n    var.set @user, 1\n    var.change @user, %a');
    assert.equal(count(scriptOf(dse(kept)), /var\.\w+ @user/g), 2);
    const overwritten = program('    %a = random 1, 6\n    var.set @user, 1\n    var.change @user, %a\n    var.set @user, 9');
    const text = scriptOf(dse(overwritten));
    assert.equal(count(text, /var\.\w+ @user/g), 1);
    assert.match(text, /var\.set @user, 9/);
    sameBehaviour(overwritten);
});

test('a read of a known value is replaced by the value, and the store stays for later readers', () => {
    const source = program('    var.set @user, 5\n    %a = var.get @user\n    var.set @other, %a\n    list.add @log, %a');
    const text = scriptOf(dse(source));
    assert.doesNotMatch(text, /var\.get/);
    assert.match(text, /var\.set @other, 5/);
    assert.match(text, /var\.set @user, 5/);
    sameBehaviour(source);
});

test('a read that cannot be resolved keeps the store before it alive', () => {
    const source = program('    var.set @user, 1\n    %a = random 1, 1\n    var.set @user, %a\n    %b = var.get @user\n    var.set @user, 7\n    list.add @log, %b');
    const text = scriptOf(dse(source));
    assert.equal(count(text, /var\.set @user/g), 2, 'the unresolved read separates the second and third store');
    sameBehaviour(source);
});

test('control flow, loops and exits end the span', () => {
    for (const middle of [
        'if %c {\n      var.change @other, 1\n    }',
        'repeat 2 {\n      var.change @other, 1\n    }',
        'if %c {\n      stop "this script"\n    }',
    ]) {
        const source = program(`    %r = random 0, 1\n    %c = gt %r, 0\n    var.set @user, 1\n    ${middle}\n    var.set @user, 2`);
        assert.equal(count(scriptOf(dse(source)), /var\.set @user/g), 2, middle);
        sameBehaviour(source);
    }
});

test('anything that may leave the script or observe the world keeps the earlier store of a shared variable', () => {
    for (const middle of [
        'sb control_delete_this_clone()',
        'sb sensing_of(OBJECT: "S", PROPERTY: "user")',
        'wait 1',
        'broadcast "go"',
        'stop "other scripts in sprite"',
    ]) {
        const source = program(`    var.set @user, 1\n    ${middle}\n    var.set @user, 2`);
        const text = scriptOf(dse(source));
        assert.equal(count(text, /var\.set @user/g), 2, middle);
    }
});

test('a reporter that cannot reach a variable does not end the span for an internal one', () => {
    const source = program('    var.set @_scratchpiler_internal_t, 1\n    %r = sb sensing_timer()\n    var.set @_scratchpiler_internal_t, 2\n    %v = var.get @_scratchpiler_internal_t\n    var.set @user, %v');
    assert.doesNotMatch(scriptOf(dse(source)), /, 1\b/);
});

const PROCS = `
  proc @reads() warp {
    %v = var.get @user
    list.add @log, %v
  }
  proc @writes() warp {
    var.set @user, 99
  }
  proc @bystander() warp {
    list.add @log, 0
  }
  proc @yielder() {
    var.change @other, 1
  }
  proc @observer() warp {
    %v = var.get @_scratchpiler_internal_t
    list.add @log, %v
  }`;

test('a call ends the span only when its callee can reach the variable', () => {
    const between = (callee, variable = '@user') => program(`    var.set ${variable}, 1\n    call @${callee}()\n    var.set ${variable}, 2`, { procs: PROCS });
    assert.equal(count(scriptOf(dse(between('reads'))), /var\.set @user/g), 2, 'callee reads it');
    assert.equal(count(scriptOf(dse(between('writes'))), /var\.set @user/g), 2, 'callee writes it');
    assert.equal(count(scriptOf(dse(between('bystander'))), /var\.set @user/g), 1, 'callee never touches it');
    sameBehaviour(between('reads'));
    sameBehaviour(between('bystander'));
});

test('a call that yields exposes shared variables but not confined or internal ones', () => {
    const through = (variable) => program(`    var.set ${variable}, 1\n    call @yielder()\n    var.set ${variable}, 2`, { procs: PROCS });
    assert.equal(count(scriptOf(dse(through('@user'))), /var\.set @user/g), 2);
    assert.equal(count(scriptOf(dse(through('@local'))), /var\.set @local/g), 1);
    assert.equal(count(scriptOf(dse(through('@_scratchpiler_internal_t'))), /var\.set @_scratchpiler_internal_t/g), 1);
});

test('a callee that wipes the script keeps the stores before the call', () => {
    const procs = '  proc @quit() warp {\n    stop "all"\n  }';
    const source = program('    var.set @user, 1\n    call @quit()\n    var.set @user, 2', { procs });
    assert.equal(count(scriptOf(dse(source)), /var\.set @user/g), 2);
});

test('stores inside a loop body are optimized within the body only', () => {
    const source = program('    repeat 3 {\n      var.set @user, 1\n      var.set @user, 2\n    }');
    const text = scriptOf(dse(source));
    assert.equal(count(text, /var\.set @user/g), 1);
    sameBehaviour(source);
});

test('unrolled counters collapse into a single store', () => {
    const source = program('    var.set @local, 0\n    repeat 4 {\n      var.change @local, 1\n    }', { script: 'script flag uninterrupted' });
    const optimized = runPipeline(parse(source), ['unroll', 'dse']);
    assert.equal(count(scriptOf(optimized), /var\.\w+ @local/g), 1);
    assert.match(scriptOf(optimized), /var\.set @local, 4/);
});
