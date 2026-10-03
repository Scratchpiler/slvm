import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, print, run, runPipeline, verify, slc, StepLimitExceeded } from '../src/index.js';
import { hasScratchVM, runInScratchVM } from '../src/testing/scratch-vm.js';

const examples = new URL('../examples/', import.meta.url);
const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const program = (procs, flag, vars = ['a', 'b', 'x']) => `stage {
${vars.map((name) => `  var @${name}`).join('\n')}
  list @log
}

sprite "S" {
${procs}
  script flag {
${flag}
  }
}
`;

function inlined(source) {
    const mod = parse(source);
    runPipeline(mod, ['inline']);
    return mod;
}

const callsIn = (mod, where) => {
    const text = print(mod);
    const script = text.slice(text.indexOf(where));
    return (script.match(/\bcall @/g) ?? []).length;
};

function sameBehaviour(source, options = {}) {
    const reference = run(parse(source), options);
    const afterInline = run(inlined(source), options);
    assert.deepEqual(visible(afterInline.vars), visible(reference.vars), 'after inline (eager)');
    assert.deepEqual(visible(afterInline.lists), visible(reference.lists), 'lists after inline (eager)');
    const legalReference = parse(source);
    runPipeline(legalReference, ['legalize']);
    const legalInlined = parse(source);
    runPipeline(legalInlined, ['O1']);
    assert.deepEqual(verify(legalInlined, { legal: true }), []);
    const tree = run(legalInlined, { ...options, tree: true });
    assert.deepEqual(visible(tree.vars), visible(run(legalReference, { ...options, tree: true }).vars), 'after O1 (tree)');
    assert.deepEqual(visible(tree.lists), visible(reference.lists), 'lists after O1 (tree)');
}

const RECT = `  proc @rect(w, h) warp returns {
    %0 = arg w
    %1 = arg h
    %2 = mul %0, %1
    ret %2
  }
`;

test('a returning proc disappears into its caller', () => {
    const source = program(RECT, '    %0 = call @rect(6, 7)\n    var.set @a, %0');
    const mod = inlined(source);
    assert.equal(callsIn(mod, 'script flag'), 0);
    assert.match(print(mod), /%0 = mul 6, 7\n\s+var.set @a, %0/);
    sameBehaviour(source);
});

test('O1 folds the inlined body down to a constant', () => {
    const mod = parse(program(RECT, '    %0 = call @rect(6, 7)\n    var.set @a, %0'));
    runPipeline(mod, ['O1']);
    assert.match(print(mod), /script flag \{\n\s+var.set @a, 42\n/);
});

test('noinline keeps the call', () => {
    const source = program(RECT.replace('warp returns', 'warp returns noinline'), '    %0 = call @rect(6, 7)\n    var.set @a, %0');
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
});

test('recursion is never inlined', () => {
    const fact = `  proc @fact(n) warp returns {
    %0 = arg n
    %1 = lt %0, 2
    if %1 {
      ret 1
    }
    %2 = sub %0, 1
    %3 = call @fact(%2)
    %4 = mul %0, %3
    ret %4
  }
`;
    const source = program(fact, '    %0 = call @fact(5)\n    var.set @a, %0');
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
    sameBehaviour(source);
});

test('mutual recursion is never inlined', () => {
    const procs = `  proc @ping(n) warp returns {
    %0 = arg n
    %1 = gt %0, 0
    if %1 {
      %2 = sub %0, 1
      %3 = call @pong(%2)
      ret %3
    } else {
      ret 7
    }
  }

  proc @pong(n) warp returns {
    %0 = arg n
    %1 = call @ping(%0)
    ret %1
  }
`;
    const source = program(procs, '    %0 = call @ping(3)\n    var.set @a, %0');
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
    sameBehaviour(source);
});

const SIGN = `  proc @sign(n) warp returns {
    %0 = arg n
    %1 = lt %0, 0
    if %1 {
      ret -1
    }
    %2 = gt %0, 0
    if %2 {
      ret 1
    }
    ret 0
  }
`;

test('early returns become an if/else chain', () => {
    const calls = [-5, 0, 9].map((n, i) => `    %${i} = call @sign(${n})\n    list.add @log, %${i}`).join('\n');
    const source = program(SIGN, calls);
    const mod = inlined(source);
    assert.equal(callsIn(mod, 'script flag'), 0);
    assert.match(print(mod), /else \{/);
    sameBehaviour(source);
});

test('a result is not inlined when some path falls off the end without returning', () => {
    const lazy = `  proc @maybe(n) warp returns {
    %0 = arg n
    %1 = gt %0, 0
    if %1 {
      ret 5
    }
  }
`;
    const source = program(lazy, '    %0 = call @maybe(1)\n    var.set @a, %0');
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
});

test('a returning proc called as a statement is inlined without its return value', () => {
    const procs = `  proc @bump(n) warp returns {
    %0 = arg n
    var.change @x, %0
    ret %0
  }
`;
    const source = program(procs, '    call @bump(3)\n    call @bump(4)');
    assert.equal(callsIn(inlined(source), 'script flag'), 0);
    sameBehaviour(source);
});

test('a warp proc with a loop is not inlined into a script, but is into a warp proc', () => {
    const procs = `  proc @sum(n) warp returns {
    %0 = arg n
    var.set @b, 0
    repeat %0 {
      var.change @b, 1
    }
    %1 = var.get @b
    ret %1
  }

  proc @twice(n) warp returns {
    %0 = arg n
    %1 = call @sum(%0)
    %2 = call @sum(%0)
    %3 = add %1, %2
    ret %3
  }
`;
    const source = program(procs, '    %0 = call @sum(4)\n    var.set @a, %0\n    %1 = call @twice(3)\n    var.set @x, %1');
    const mod = inlined(source);
    const text = print(mod);
    assert.match(text.slice(text.indexOf('script flag')), /call @sum\(4\)/);
    assert.doesNotMatch(text.slice(text.indexOf('proc @twice'), text.indexOf('script flag')), /call @sum/);
    sameBehaviour(source);
});

test('a loop-free warp proc may be inlined into a script', () => {
    assert.equal(callsIn(inlined(program(RECT, '    %0 = call @rect(2, 3)\n    var.set @a, %0')), 'script flag'), 0);
});

test('a plain proc with a loop is inlined into a script, because it yields there either way', () => {
    const procs = `  proc @count(n) {
    %0 = arg n
    repeat %0 {
      var.change @x, 1
    }
  }
`;
    const source = program(procs, '    call @count(3)');
    assert.equal(callsIn(inlined(source), 'script flag'), 0);
    sameBehaviour(source);
});

test('stop this script inside a proc returns from the proc, so such procs stay calls', () => {
    const procs = `  proc @quit(n) {
    %0 = arg n
    var.set @a, %0
    stop "this script"
  }
`;
    const source = program(procs, '    call @quit(1)\n    var.set @b, 2');
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
    sameBehaviour(source);
});

test('forever inside a proc keeps the call, so nothing is left unreachable', () => {
    const procs = `  proc @spin(n) {
    forever {
      var.change @x, 1
      stop "all"
    }
  }
`;
    assert.equal(callsIn(inlined(program(procs, '    call @spin(1)\n    var.set @b, 2')), 'script flag'), 1);
});

test('a call in a loop condition is left alone', () => {
    const source = program(RECT, `    until {
      %0 = call @rect(1, 2)
      %1 = gt %0, 1
      cond %1
    } do {
      var.change @x, 1
    }`);
    assert.equal(callsIn(inlined(source), 'script flag'), 1);
});

test('boolean parameters become truthy for round operands and pass booleans straight through', () => {
    const procs = `  proc @both(p, q) warp returns {
    %0 = arg.b p
    %1 = arg.b q
    %2 = and %0, %1
    ret %2
  }
`;
    const flag = `    %0 = var.get @x
    %1 = lt %0, 3
    %2 = call @both(%1, %0)
    %3 = call @both(%1, "false")
    %4 = call @both(true, 1)
    list.add @log, %2
    list.add @log, %3
    list.add @log, %4`;
    const source = program(procs, flag);
    assert.equal(callsIn(inlined(source), 'script flag'), 0);
    sameBehaviour(source);
    sameBehaviour(source.replace('script flag {\n', 'script flag {\n    var.set @x, 5\n'));
});

test('an argument read before the callee writes the same variable keeps its old value', () => {
    const procs = `  proc @swap(n) warp returns {
    %0 = arg n
    var.set @x, 100
    %1 = arg n
    %2 = add %0, %1
    ret %2
  }
`;
    const source = program(procs, '    var.set @x, 3\n    %0 = var.get @x\n    %1 = call @swap(%0)\n    var.set @a, %1\n    %2 = var.get @x\n    var.set @b, %2');
    assert.equal(callsIn(inlined(source), 'script flag'), 0);
    sameBehaviour(source);
});

test('two calls feeding one expression keep both results', () => {
    const source = program(RECT, '    %0 = call @rect(3, 4)\n    %1 = call @rect(2, 5)\n    %2 = add %0, %1\n    var.set @a, %2');
    sameBehaviour(source);
});

test('nested calls inline bottom-up', () => {
    const procs = `${RECT}
  proc @area2(w) warp returns {
    %0 = arg w
    %1 = call @rect(%0, %0)
    ret %1
  }
`;
    const source = program(procs, '    %0 = call @area2(6)\n    var.set @a, %0');
    const mod = inlined(source);
    assert.equal(callsIn(mod, 'script flag'), 0);
    sameBehaviour(source);
});

test('a callee in the middle of a loop body is inlined each iteration', () => {
    const source = program(RECT, `    repeat 4 {
      %0 = var.get @x
      %1 = call @rect(%0, 2)
      list.add @log, %1
      var.change @x, 1
    }`);
    assert.equal(callsIn(inlined(source), 'script flag'), 0);
    sameBehaviour(source);
});

test('boolean literals passed to a text parameter stay text, as the real VM sees them', { skip: !hasScratchVM && 'scratch-vm is not installed' }, async () => {
    const procs = `  proc @plus(n) warp returns {
    %0 = arg n
    %1 = add %0, 1
    ret %1
  }
`;
    const source = program(procs, '    %0 = call @plus(true)\n    var.set @a, %0');
    const reference = parse(source);
    runPipeline(reference, ['legalize']);
    const optimized = parse(source);
    runPipeline(optimized, ['O1']);
    const [before, after] = await Promise.all([reference, optimized].map((mod) => runInScratchVM(slc(mod))));
    assert.equal(String(after.vars.a), String(before.vars.a));
});

test('an oversized proc is left as a call', () => {
    const body = Array.from({ length: 30 }, () => '    var.change @x, 1').join('\n');
    const procs = `  proc @big(n) {\n${body}\n  }\n`;
    assert.equal(callsIn(inlined(program(procs, '    call @big(1)')), 'script flag'), 1);
});

test('inlining twice does not collide value names or temporaries', () => {
    const calls = [-1, 1, 0, 8].map((n, i) => `    %${i} = call @sign(${n})\n    list.add @log, %${i}`).join('\n');
    const source = program(SIGN, calls);
    const mod = inlined(source);
    assert.deepEqual(verify(mod), []);
    sameBehaviour(source);
});

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sl'))) {
    test(`${file}: inlining keeps the interpreter's results`, (t) => {
        const source = readFileSync(new URL(file, examples), 'utf8');
        try {
            sameBehaviour(source, { maxSteps: 1e5 });
        } catch (e) {
            if (!(e instanceof StepLimitExceeded)) throw e;
            t.skip('does not terminate');
        }
    });

    test(`${file}: the real Scratch VM agrees after O1`, { skip: !hasScratchVM && 'scratch-vm is not installed' }, async (t) => {
        const source = readFileSync(new URL(file, examples), 'utf8');
        let expected;
        try {
            expected = run(parse(source), { maxSteps: 1e5 });
        } catch (e) {
            if (!(e instanceof StepLimitExceeded)) throw e;
            return t.skip('does not terminate');
        }
        const mod = parse(source);
        runPipeline(mod, ['O1']);
        const actual = await runInScratchVM(slc(mod));
        const text = (store) => Object.fromEntries(Object.entries(visible(store)).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));
        assert.deepEqual(text(actual.vars), text(expected.vars));
        assert.deepEqual(text(actual.lists), text(expected.lists));
    });
}
