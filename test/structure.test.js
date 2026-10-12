import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse, print, run, runPipeline, verify, slc, StepLimitExceeded } from '../src/index.js';
import { hasScratchVM, runInScratchVM } from '../src/testing/scratch-vm.js';

const examples = new URL('../examples/', import.meta.url);
const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));
const text = (store) => Object.fromEntries(Object.entries(visible(store)).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

const program = ({ procs = '', script, scriptModifier = '', declarations = '' }) => `stage {
  var @n
  var @total
  var @hits
  list @log
}

sprite "S" {
${declarations}${procs}
  script flag${scriptModifier} {
${script}
  }
}
`;

const optimized = (source, level) => {
    const mod = parse(source);
    runPipeline(mod, [level]);
    return mod;
};

const count = (mod, pattern) => (print(mod).match(pattern) ?? []).length;
const stops = (mod) => count(mod, /stop "this script"/g);
const flags = (mod) => count(mod, /slvm_(brk|cont)\d* internal/g);
const loops = (mod) => ({ forever: count(mod, /\bforever\b/g), until: count(mod, /\buntil\b/g), repeat: count(mod, /\brepeat\b/g) });

function sameBehaviour(source, level) {
    const reference = run(parse(source));
    const mod = optimized(source, level);
    assert.deepEqual(verify(mod, { legal: true }), []);
    const tree = run(mod, { tree: true });
    assert.deepEqual(text(tree.vars), text(reference.vars), `${level} vars`);
    assert.deepEqual(text(tree.lists), text(reference.lists), `${level} lists`);
    assert.deepEqual(tree.trace, reference.trace, `${level} trace`);
}

const both = (name, fn) => {
    for (const level of ['O2', 'O3']) test(`${name} (${level})`, () => fn(level));
};

const FACT = `  proc @fact(n) warp returns {
    %0 = arg n
    %1 = lt %0, 2
    if %1 {
      ret 1
    }
    %2 = arg n
    %3 = sub %2, 1
    %4 = call @fact(%3)
    %5 = mul %2, %4
    ret %5
  }
`;

both('an early return becomes an if/else and needs no stop', (level) => {
    const source = program({ procs: FACT, script: '    %0 = call @fact(5)\n    var.set @total, %0' });
    const mod = optimized(source, level);
    assert.equal(stops(mod), 0);
    sameBehaviour(source, level);
});

test('O1 still emits the stop for an early return', () => {
    assert.equal(stops(optimized(program({ procs: FACT, script: '    %0 = call @fact(5)\n    var.set @total, %0' }), 'O1')), 1);
});

both('a continue guarded by an if disappears with its flag', (level) => {
    const source = program({
        script: `    repeat 10 {
      var.change @n, 1
      %0 = var.get @n
      %1 = mod %0, 3
      %2 = eq %1, 0
      if %2 {
        continue
      }
      %3 = var.get @n
      var.change @total, %3
    }`,
    });
    assert.equal(flags(optimized(source, level)), 0);
    assert.equal(flags(optimized(source, 'O1')), 1);
    sameBehaviour(source, level);
});

both('a continue in the middle of the body keeps the semantics', (level) => {
    const source = program({
        script: `    var.set @n, 0
    until {
      %0 = var.get @n
      %1 = gt %0, 8
      cond %1
    } do {
      var.change @total, 1
      %2 = var.get @n
      %3 = mod %2, 2
      %4 = eq %3, 0
      if %4 {
        var.change @hits, 1
        continue
      }
      var.change @total, 10
    } step {
      var.change @n, 1
    }`,
    });
    assert.equal(flags(optimized(source, level)), 0);
    sameBehaviour(source, level);
});

both('a continue inside nested ifs that cannot be folded still works', (level) => {
    const source = program({
        script: `    repeat 6 {
      var.change @n, 1
      %0 = var.get @n
      %1 = gt %0, 2
      if %1 {
        %2 = mod %0, 2
        %3 = eq %2, 0
        if %3 {
          continue
        }
        var.change @hits, 1
      }
      var.change @total, 1
    }`,
    });
    sameBehaviour(source, level);
});

both('a trailing stop this script in a script is dropped', (level) => {
    const source = program({
        script: `    %0 = var.get @n
    %1 = gt %0, 5
    if %1 {
      var.set @total, 1
      stop "this script"
    }
    var.set @total, 2`,
    });
    assert.equal(stops(optimized(source, level)), 0);
    sameBehaviour(source, level);
});

both('a leading break moves into the loop condition', (level) => {
    const source = program({
        script: `    forever {
      %0 = var.get @n
      %1 = gt %0, 4
      if %1 {
        break
      }
      var.change @n, 1
      var.change @total, 2
    }
    var.change @hits, 1`,
    });
    const mod = optimized(source, level);
    assert.deepEqual(loops(mod), { forever: 0, until: 1, repeat: 0 });
    assert.equal(flags(mod), 0);
    sameBehaviour(source, level);
});

both('a leading break joins an existing until condition', (level) => {
    const source = program({
        script: `    until {
      %0 = var.get @total
      %1 = gt %0, 20
      cond %1
    } do {
      %2 = var.get @n
      %3 = gt %2, 4
      if %3 {
        break
      }
      var.change @n, 1
      var.change @total, 3
    }`,
    });
    const mod = optimized(source, level);
    assert.equal(flags(mod), 0);
    assert.equal(count(mod, /\bor\b/g), 1);
    sameBehaviour(source, level);
});

both('two leading breaks both fuse', (level) => {
    const source = program({
        script: `    forever {
      %0 = var.get @n
      %1 = gt %0, 4
      if %1 {
        break
      }
      %2 = var.get @total
      %3 = gt %2, 6
      if %3 {
        break
      }
      var.change @n, 1
      var.change @total, 2
    }`,
    });
    assert.equal(flags(optimized(source, level)), 0);
    sameBehaviour(source, level);
});

both('a leading stop this script ends the tail loop of a script', (level) => {
    const source = program({
        script: `    forever {
      %0 = var.get @n
      %1 = gt %0, 4
      if %1 {
        stop "this script"
      }
      var.change @n, 1
      var.change @total, 2
    }`,
    });
    const mod = optimized(source, level);
    assert.equal(stops(mod), 0);
    assert.deepEqual(loops(mod), { forever: 0, until: 1, repeat: 0 });
    sameBehaviour(source, level);
});

both('a stop this script that is not at the end of the script keeps its stop', (level) => {
    const source = program({
        script: `    until {
      %0 = var.get @total
      %1 = gt %0, 3
      cond %1
    } do {
      %2 = var.get @n
      %3 = gt %2, 4
      if %3 {
        stop "this script"
      }
      var.change @n, 1
      var.change @total, 1
    }
    var.set @hits, 9`,
    });
    assert.equal(stops(optimized(source, level)), 1);
    sameBehaviour(source, level);
});

both('a break guard that reads a random value used later is not fused', (level) => {
    const source = program({
        script: `    repeat 3 {
      var.change @n, 1
    }
    forever {
      %0 = random 1, 6
      %1 = gt %0, 5
      if %1 {
        break
      }
      list.add @log, %0
      %2 = list.len @log
      %3 = gt %2, 40
      if %3 {
        break
      }
    }`,
    });
    const mod = optimized(source, level);
    assert.equal(loops(mod).forever + flags(mod) > 0, true);
    for (const seed of [1, 2, 3]) {
        const reference = run(parse(source), { seed });
        assert.deepEqual(run(optimized(source, level), { tree: true, seed }).lists, reference.lists);
    }
});

test('rotation peels a warp loop with a break in the middle', () => {
    const procs = `  proc @work() warp {
    forever {
      var.change @n, 1
      var.change @total, 2
      %0 = var.get @n
      %1 = gt %0, 10
      if %1 {
        break
      }
      var.change @total, 5
    }
  }
`;
    const source = program({ procs, script: '    call @work()' });
    const rotated = optimized(source, 'O3');
    assert.equal(flags(rotated), 0);
    assert.equal(loops(rotated).forever, 0);
    assert.equal(flags(optimized(source, 'O2')), 1, 'O2 does not rotate');
    sameBehaviour(source, 'O3');
    sameBehaviour(source, 'O2');
});

test('rotation leaves a loop that yields between iterations alone', () => {
    const procs = `  proc @work() {
    forever {
      var.change @n, 1
      %0 = var.get @n
      %1 = gt %0, 10
      if %1 {
        break
      }
      var.change @total, 5
    }
  }
`;
    const source = program({ procs, script: '    call @work()' });
    assert.equal(flags(optimized(source, 'O3')), 1);
    sameBehaviour(source, 'O3');
});

test('rotation leaves a loop whose body ends by leaving the script', () => {
    const procs = `  proc @work() warp {
    forever {
      var.change @n, 1
      %0 = var.get @n
      %1 = gt %0, 10
      if %1 {
        break
      }
      var.change @total, 5
      stop "this script"
    }
  }
`;
    const source = program({ procs, script: '    call @work()' });
    sameBehaviour(source, 'O3');
});

test('rotation applies to a loop in an uninterrupted script over confined state', () => {
    const declarations = '  var @mine confined\n';
    const script = `    forever {
      var.change @mine, 1
      %0 = var.get @mine
      %1 = gt %0, 9
      if %1 {
        break
      }
      var.change @mine, 2
    }`;
    const source = program({ declarations, script, scriptModifier: ' uninterrupted' });
    assert.equal(flags(optimized(source, 'O3')), 0);
    assert.equal(flags(optimized(program({ declarations, script }), 'O3')), 1);
    sameBehaviour(source, 'O3');
});

test('rotation does not move code that the loop body uses after the guard', () => {
    const procs = `  proc @work() warp {
    forever {
      %0 = random 1, 3
      var.change @n, %0
      %1 = var.get @n
      %2 = gt %1, 10
      if %2 {
        break
      }
      var.change @total, %1
    }
  }
`;
    const source = program({ procs, script: '    call @work()' });
    for (const seed of [1, 2, 3, 4]) {
        const reference = run(parse(source), { seed });
        assert.deepEqual(visible(run(optimized(source, 'O3'), { tree: true, seed }).vars), visible(reference.vars));
    }
});

both('if not c with an else swaps its arms and drops the not', (level) => {
    const source = program({
        script: `    %0 = var.get @n
    %1 = gt %0, 2
    %2 = not %1
    if %2 {
      var.set @total, 1
    } else {
      var.set @total, 2
    }`,
    });
    const mod = optimized(source, level);
    assert.equal(count(mod, /\bnot\b/g), 0);
    sameBehaviour(source, level);
    assert.equal(count(optimized(source, 'O1'), /\bnot\b/g), 1);
});

test('a bare if not c becomes an empty then-arm only at O3', () => {
    const source = program({
        script: `    %0 = var.get @n
    %1 = eq %0, 2
    %2 = not %1
    if %2 {
      var.set @total, 1
    }`,
    });
    assert.equal(count(optimized(source, 'O2'), /\bnot\b/g), 1);
    const o3 = optimized(source, 'O3');
    assert.equal(count(o3, /\bnot\b/g), 0);
    assert.match(print(o3), /if %\d+ \{\n\s+\} else \{/);
    sameBehaviour(source, 'O3');
});

both('a negation used elsewhere is kept', (level) => {
    const source = program({
        script: `    %0 = var.get @n
    %1 = gt %0, 2
    %2 = not %1
    if %2 {
      var.set @total, 1
    } else {
      var.set @total, 2
    }
    var.set @hits, %2`,
    });
    assert.equal(count(optimized(source, level), /\bnot\b/g), 1);
    sameBehaviour(source, level);
});

for (const file of readdirSync(examples).filter((f) => f.endsWith('.sl'))) {
    for (const level of ['O2', 'O3']) {
        test(`${file}: ${level} matches the reference interpreter`, (t) => {
            const source = readFileSync(new URL(file, examples), 'utf8');
            try {
                run(parse(source), { maxSteps: 1e5 });
            } catch (e) {
                if (!(e instanceof StepLimitExceeded)) throw e;
                return t.skip('does not terminate');
            }
            sameBehaviour(source, level);
        });

        test(`${file}: the real Scratch VM agrees after ${level}`, { skip: !hasScratchVM && 'scratch-vm is not installed' }, async (t) => {
            const source = readFileSync(new URL(file, examples), 'utf8');
            let expected;
            try {
                expected = run(parse(source), { maxSteps: 1e5 });
            } catch (e) {
                if (!(e instanceof StepLimitExceeded)) throw e;
                return t.skip('does not terminate');
            }
            const actual = await runInScratchVM(slc(optimized(source, level)));
            assert.deepEqual(text(actual.vars), text(expected.vars));
            assert.deepEqual(text(actual.lists), text(expected.lists));
        });
    }
}
