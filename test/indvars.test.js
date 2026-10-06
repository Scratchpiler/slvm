import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, runPipeline, verify } from '../src/index.js';

const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const ITER = '_scratchpiler_internal_i';

const program = (body, { warp = true, confined = false } = {}) => `stage {
  var @total
  var @limit
  var @pad
}

sprite "S" {
  var @${ITER} internal
  list @items${confined ? ' confined' : ''}
  list @log

  proc @work()${warp ? ' warp' : ''} {
${body}
  }

  script flag {
    list.add @items, 4
    list.add @items, 5
    list.add @items, 6
    call @work()
  }
}
`;

const countedFor = ({ from = 1, to = 10, body = '      var.change @total, 1', bound = '' }) => `    var.set @${ITER}, ${from}
    until {
      %c0 = var.get @${ITER}
${bound}      %c1 = gt %c0, ${to}
      cond %c1
    } do {
${body}
    } step {
      var.change @${ITER}, 1
    }`;

const lengthBound = (to = '%n') => ({ bound: '      %n = list.len @items\n', to });
const lengthMinusOne = { bound: '      %n = list.len @items\n      %m = sub %n, 1\n', to: '%m' };

const indvars = (source) => runPipeline(parse(source), ['indvars']);
const loops = (mod) => ({ until: (print(mod).match(/\buntil\b/g) ?? []).length, repeat: (print(mod).match(/\brepeat\b/g) ?? []).length });

function sameBehaviour(source) {
    const reference = run(parse(source));
    const after = run(indvars(source));
    assert.deepEqual(visible(after.vars), visible(reference.vars), 'vars');
    assert.deepEqual(visible(after.lists), visible(reference.lists), 'lists');
    const optimized = runPipeline(parse(source), ['O1']);
    assert.deepEqual(verify(optimized, { legal: true }), []);
    const tree = run(optimized, { tree: true });
    assert.deepEqual(visible(tree.vars), visible(reference.vars), 'vars after O1');
    assert.deepEqual(visible(tree.lists), visible(reference.lists), 'lists after O1');
    return { before: reference.blocks, after: after.blocks };
}

test('a counted for loop that never reads its iterator becomes a repeat', () => {
    for (const [from, to, trips] of [[1, 10, 10], [0, 99, 100], [5, 4, 0], [3, -2, 0], [-2, 2, 5], [7, 7, 1]]) {
        const source = program(countedFor({ from, to }));
        const mod = indvars(source);
        assert.deepEqual(loops(mod), { until: 0, repeat: 1 }, `${from}..${to}`);
        assert.equal(run(mod).vars.total, trips, `${from}..${to}`);
        sameBehaviour(source);
    }
});

test('the repeat is cheaper: no condition and no step per iteration', () => {
    const { before, after } = sameBehaviour(program(countedFor({ from: 1, to: 50 })));
    assert.ok(after < before / 1.5, `${before} -> ${after} blocks`);
});

test('a list length bound is evaluated once, and its offset is folded into the count', () => {
    const cases = [[1, lengthBound(), 'repeat %'], [0, lengthMinusOne, 'repeat %'], [2, lengthBound(), 'sub']];
    for (const [from, shape, expected] of cases) {
        const source = program(countedFor({ from, ...shape }));
        const mod = indvars(source);
        assert.deepEqual(loops(mod), { until: 0, repeat: 1 }, `from ${from}`);
        assert.ok(print(mod).includes(expected), print(mod));
        sameBehaviour(source);
    }
    const folded = runPipeline(parse(program(countedFor({ from: 0, ...lengthMinusOne }))), ['indvars', 'dce']);
    assert.doesNotMatch(print(folded), /= (add|sub) /, 'len-1+1 needs no arithmetic');
});

test('a non-literal start is allowed when it is provably an integer', () => {
    const source = program(`    %k = list.len @log
    var.set @${ITER}, %k
    until {
      %c0 = var.get @${ITER}
      %n = list.len @items
      %c1 = gt %c0, %n
      cond %c1
    } do {
      var.change @total, 1
    } step {
      var.change @${ITER}, 1
    }`);
    assert.deepEqual(loops(indvars(source)), { until: 0, repeat: 1 });
    sameBehaviour(source);
});

test('bounds of unknown kind are left alone, since text compares differently from numbers', () => {
    const variable = program(countedFor({ bound: '      %b = var.get @limit\n', to: '%b' }));
    assert.deepEqual(loops(indvars(variable)), { until: 1, repeat: 0 });
    const product = program(countedFor({ bound: '      %n = list.len @items\n      %p = mul %n, 2\n', to: '%p' }));
    assert.deepEqual(loops(indvars(product)), { until: 1, repeat: 0 });
    const fractionalStart = program(countedFor({ from: 1.5 }));
    assert.deepEqual(loops(indvars(fractionalStart)), { until: 1, repeat: 0 });
    const fractionalEnd = program(countedFor({ to: 2.5 }));
    assert.deepEqual(loops(indvars(fractionalEnd)), { until: 1, repeat: 0 });
});

test('a loop that reads its iterator, or whose body writes it, stays', () => {
    const reads = program(countedFor({ body: `      %v = var.get @${ITER}\n      list.add @log, %v` }));
    assert.deepEqual(loops(indvars(reads)), { until: 1, repeat: 0 });
    const writes = program(countedFor({ body: `      var.change @${ITER}, 1` }));
    assert.deepEqual(loops(indvars(writes)), { until: 1, repeat: 0 });
    const nested = program(countedFor({ body: `      %v = var.get @${ITER}\n      var.change @total, %v` }));
    sameBehaviour(nested);
});

test('a loop whose body changes the bound stays', () => {
    const grows = program(countedFor({ to: 6, body: '      list.add @items, 1' }));
    assert.deepEqual(loops(indvars(grows)), { until: 0, repeat: 1 }, 'a literal bound is unaffected');
    const growing = program(countedFor({ ...lengthBound(), body: '      list.add @items, 1' }));
    assert.deepEqual(loops(indvars(growing)), { until: 1, repeat: 0 }, 'list.len bound with list.add in the body');
    const viaCall = program(countedFor(lengthBound()).replace('var.change @total, 1', 'call @grow()') + '\n  }\n  proc @grow() warp {\n    list.add @items, 1');
    assert.deepEqual(loops(indvars(viaCall)), { until: 1, repeat: 0 }, 'list.len bound with a call that adds');
});

test('a shared bound is only hoisted when nothing can change it between iterations', () => {
    const shape = lengthBound();
    assert.deepEqual(loops(indvars(program(countedFor(shape), { warp: true }))), { until: 0, repeat: 1 });
    assert.deepEqual(loops(indvars(program(countedFor(shape), { warp: false }))), { until: 1, repeat: 0 }, 'a non-warp loop yields, so another script may change the list');
    assert.deepEqual(loops(indvars(program(countedFor(shape), { warp: false, confined: true }))), { until: 0, repeat: 1 }, 'confined lists cannot change');
    const waits = program(countedFor({ ...shape, body: '      wait 0' }), { warp: true });
    assert.deepEqual(loops(indvars(waits)), { until: 1, repeat: 0 }, 'a wait inside lets others run');
});

test('break and continue keep their meaning inside the repeat', () => {
    const body = `      var.change @total, 1
      %t = gt %total_read, 3
      if %t {
        break
      }`.replace('      %t = gt %total_read, 3', '      %r = var.get @total\n      %t = gt %r, 3');
    const source = program(countedFor({ to: 20, body }));
    const mod = indvars(source);
    assert.deepEqual(loops(mod), { until: 0, repeat: 1 });
    assert.equal(run(mod).vars.total, 4);
    sameBehaviour(source);

    const skipping = `      %r = var.get @total
      %t = gt %r, 1
      var.change @total, 1
      if %t {
        continue
      }
      list.add @log, %r`;
    sameBehaviour(program(countedFor({ to: 6, body: skipping })));
});

test('nested counted loops both become repeats', () => {
    const inner = countedFor({ to: 3 }).replace(new RegExp(ITER, 'g'), `${ITER}2`).replace(/%c(\d)/g, '%d$1');
    const source = program(countedFor({ to: 4, body: inner })).replace(`  var @${ITER} internal`, `  var @${ITER} internal\n  var @${ITER}2 internal`);
    const mod = indvars(source);
    assert.deepEqual(loops(mod), { until: 0, repeat: 2 });
    assert.equal(run(mod).vars.total, 12);
    sameBehaviour(source);
});

test('nounroll and tags follow the loop into the repeat', () => {
    const source = program(countedFor({})).replace('until {', 'until nounroll {');
    const mod = indvars(source);
    assert.match(print(mod), /repeat 10 nounroll/);
    assert.deepEqual(loops(runPipeline(parse(source), ['O1'])), { until: 0, repeat: 1 }, 'nounroll still stops unrolling');
});

test('O1 unrolls small converted loops and drops the iterator', () => {
    const source = program(countedFor({ to: 3 }));
    const optimized = runPipeline(parse(source), ['O1']);
    assert.deepEqual(loops(optimized), { until: 0, repeat: 0 });
    assert.doesNotMatch(print(optimized), new RegExp(`@${ITER},`));
    assert.equal(run(optimized, { tree: true }).vars.total, 3);
});
