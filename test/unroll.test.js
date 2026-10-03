import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, runPipeline, verify } from '../src/index.js';

const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const ITER = '_scratchpiler_internal_i';

const program = (procBody, { warp = true, scriptBody = '    call @work()' } = {}) => `stage {
  var @total
  var @other
}

sprite "S" {
  var @${ITER} internal
  var @user
  list @log

  proc @work()${warp ? ' warp' : ''} {
${procBody}
  }

  script flag {
${scriptBody}
  }
}
`;

const countedFor = (from, end, body, iterator = ITER) => `    var.set @${iterator}, ${from}
    until {
      %c0 = var.get @${iterator}
      %c1 = gt %c0, ${end}
      cond %c1
    } do {
${body}
    } step {
      var.change @${iterator}, 1
    }`;

const USES_ITERATOR = new RegExp(`var\\.\\w+ @${ITER}`);

const unrolled = (source) => {
    const mod = parse(source);
    runPipeline(mod, ['unroll']);
    return mod;
};

const loopsIn = (mod) => (print(mod).match(/\b(repeat|until)\b/g) ?? []).length;

function sameBehaviour(source) {
    const reference = run(parse(source));
    const after = run(unrolled(source));
    assert.deepEqual(visible(after.vars), visible(reference.vars), 'eager after unroll');
    assert.deepEqual(visible(after.lists), visible(reference.lists), 'lists after unroll');
    const optimized = parse(source);
    runPipeline(optimized, ['O1']);
    assert.deepEqual(verify(optimized, { legal: true }), []);
    const legalReference = parse(source);
    runPipeline(legalReference, ['legalize']);
    const tree = run(optimized, { tree: true });
    assert.deepEqual(visible(tree.vars), visible(run(legalReference, { tree: true }).vars), 'tree after O1');
    assert.deepEqual(visible(tree.lists), visible(reference.lists), 'lists after O1 (tree)');
}

test('a constant repeat in a warp proc becomes copies of its body', () => {
    const source = program('    repeat 3 {\n      var.change @total, 2\n    }');
    const mod = unrolled(source);
    assert.equal(loopsIn(mod), 0);
    assert.equal((print(mod).match(/var.change @total, 2/g) ?? []).length, 3);
    sameBehaviour(source);
});

test('loops outside a warp proc are never unrolled, because removing their yields is observable', () => {
    const body = '    repeat 3 {\n      var.change @total, 2\n    }';
    assert.equal(loopsIn(unrolled(program(body, { warp: false }))), 1);
    assert.equal(loopsIn(unrolled(program(body, { warp: false, scriptBody: body }))), 2);
    assert.equal(loopsIn(unrolled(program('    call @work()', { scriptBody: body }))), 1);
});

test('nounroll keeps the loop', () => {
    const source = program('    repeat 3 nounroll {\n      var.change @total, 2\n    }');
    assert.equal(loopsIn(unrolled(source)), 1);
});

test('a counted for loop unrolls and its iterator reads become literals', () => {
    const body = '      %0 = var.get @' + ITER + '\n      %1 = mul %0, 10\n      list.add @log, %1';
    const source = program(countedFor(1, 4, body));
    const mod = unrolled(source);
    const text = print(mod);
    assert.equal(loopsIn(mod), 0);
    assert.doesNotMatch(text, USES_ITERATOR);
    assert.match(text, /mul 1, 10/);
    assert.match(text, /mul 4, 10/);
    sameBehaviour(source);
});

test('a for loop that never runs disappears together with its initialization', () => {
    const source = program(countedFor(5, 2, '      var.change @total, 1'));
    const mod = unrolled(source);
    assert.equal(loopsIn(mod), 0);
    assert.doesNotMatch(print(mod), USES_ITERATOR);
    sameBehaviour(source);
});

test('negative and offset bounds count correctly', () => {
    sameBehaviour(program(countedFor(-2, 1, '      %0 = var.get @' + ITER + '\n      list.add @log, %0')));
    sameBehaviour(program(countedFor(3, 3, '      var.change @total, 7')));
});

test('a for loop is left alone when the bounds are not integer literals', () => {
    assert.equal(loopsIn(unrolled(program(countedFor(1, 2.5, '      var.change @total, 1')))), 1);
    assert.equal(loopsIn(unrolled(program(countedFor('"1"', 3, '      var.change @total, 1')))), 1);
    const dynamic = program(`    %0 = var.get @other
    var.set @${ITER}, 1
    until {
      %c0 = var.get @${ITER}
      %c1 = gt %c0, %0
      cond %c1
    } do {
      var.change @total, 1
    } step {
      var.change @${ITER}, 1
    }`);
    assert.equal(loopsIn(unrolled(dynamic)), 1);
});

test('a for loop is left alone when its body writes the iterator, or the iterator is a user variable', () => {
    assert.equal(loopsIn(unrolled(program(countedFor(1, 3, `      var.set @${ITER}, 9`)))), 1);
    assert.equal(loopsIn(unrolled(program(countedFor(1, 3, '      var.change @total, 1', 'user')))), 1);
});

test('loops with break or continue for themselves are left alone, nested loops may use their own', () => {
    assert.equal(loopsIn(unrolled(program('    repeat 3 {\n      var.change @total, 1\n      %0 = var.get @total\n      %1 = gt %0, 1\n      if %1 {\n        break\n      }\n    }'))), 1);
    assert.equal(loopsIn(unrolled(program('    repeat 3 {\n      var.change @total, 1\n      continue\n    }'))), 1);
    const nested = program('    repeat 2 {\n      repeat 5 {\n        var.change @total, 1\n        break\n      }\n    }');
    assert.equal(loopsIn(unrolled(nested)), 2);
    sameBehaviour(nested);
});

test('a body that always ends the proc is left alone', () => {
    assert.equal(loopsIn(unrolled(program('    repeat 3 {\n      var.change @total, 1\n      ret\n    }'))), 1);
});

test('a return inside a conditional in the body is kept in every copy', () => {
    const source = program('    repeat 3 {\n      var.change @total, 1\n      %0 = var.get @total\n      %1 = gt %0, 1\n      if %1 {\n        ret\n      }\n    }');
    assert.equal(loopsIn(unrolled(source)), 0);
    sameBehaviour(source);
});

test('trip count and size budgets keep big unrolls from happening', () => {
    assert.equal(loopsIn(unrolled(program('    repeat 17 {\n      var.change @total, 1\n    }'))), 1);
    assert.equal(loopsIn(unrolled(program('    repeat 16 {\n      var.change @total, 1\n    }'))), 0);
    const wide = Array.from({ length: 10 }, () => '      var.change @total, 1').join('\n');
    assert.equal(loopsIn(unrolled(program(`    repeat 5 {\n${wide}\n    }`))), 1);
});

test('nested constant loops unroll inside out', () => {
    const source = program('    repeat 2 {\n      repeat 3 {\n        var.change @total, 1\n      }\n    }');
    const mod = unrolled(source);
    assert.equal(loopsIn(mod), 0);
    assert.equal((print(mod).match(/var.change @total, 1/g) ?? []).length, 6);
    sameBehaviour(source);
});

test('a for loop inside a repeat unrolls with fresh values in every copy', () => {
    const inner = countedFor(1, 2, '      %0 = var.get @' + ITER + '\n      list.add @log, %0');
    const source = program(`    repeat 2 {\n${inner}\n    }`);
    assert.equal(loopsIn(unrolled(source)), 0);
    sameBehaviour(source);
});

test('unrolled copies keep distinct value names', () => {
    const source = program('    repeat 4 {\n      %0 = var.get @total\n      %1 = add %0, 1\n      var.set @total, %1\n    }');
    assert.deepEqual(verify(unrolled(source)), []);
    sameBehaviour(source);
});

test('waits inside the body stay in every copy', () => {
    const source = program('    repeat 2 {\n      wait 0.1\n      var.change @total, 1\n    }');
    assert.equal((print(unrolled(source)).match(/wait 0.1/g) ?? []).length, 2);
});

test('a repeat with a zero or negative count is removed', () => {
    assert.equal(loopsIn(unrolled(program('    repeat 0 {\n      var.change @total, 1\n    }'))), 0);
    assert.equal(loopsIn(unrolled(program('    repeat -3 {\n      var.change @total, 1\n    }'))), 0);
});

test('a non-constant repeat count is left alone', () => {
    assert.equal(loopsIn(unrolled(program('    %0 = var.get @other\n    repeat %0 {\n      var.change @total, 1\n    }'))), 1);
});
