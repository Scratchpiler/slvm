import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, runPipeline, verify } from '../src/index.js';

const ITER = '_scratchpiler_internal_i';
const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const program = ({ script = 'script flag uninterrupted', confined = ['@total', `@${ITER}`, '@log'], body, proc = '' }) => `stage {
  var @total${confined.includes('@total') ? ' confined' : ''}
  var @shared
}

sprite "S" {
  var @${ITER} internal${confined.includes(`@${ITER}`) ? ' confined' : ''}
  list @log${confined.includes('@log') ? ' confined' : ''}
${proc}
  ${script} {
${body}
  }
}
`;

const repeatChanging = (variable = '@total', extra = '') => `    repeat 3 {
      var.change ${variable}, 2${extra}
    }`;

const countedFor = `    var.set @${ITER}, 1
    until {
      %c0 = var.get @${ITER}
      %c1 = gt %c0, 4
      cond %c1
    } do {
      %v = var.get @${ITER}
      list.add @log, %v
    } step {
      var.change @${ITER}, 1
    }`;

const loopsIn = (mod) => (print(mod).match(/\b(repeat|until)\b/g) ?? []).length;
const unrolled = (source) => runPipeline(parse(source), ['unroll']);

function sameBehaviour(source) {
    const reference = run(parse(source));
    const optimized = runPipeline(parse(source), ['O1']);
    assert.deepEqual(verify(optimized, { legal: true }), []);
    const after = run(optimized, { tree: true });
    assert.deepEqual(visible(after.vars), visible(reference.vars));
    assert.deepEqual(visible(after.lists), visible(reference.lists));
}

test('confined and uninterrupted survive print and parse', () => {
    const source = program({
        body: repeatChanging(),
        proc: '  proc @tick() uninterrupted {\n    var.change @total, 1\n  }\n',
    });
    const mod = parse(source);
    assert.equal(mod.targets[0].vars[0].confined, true);
    assert.equal(mod.targets[1].vars[0].internal, true);
    assert.equal(mod.targets[1].vars[0].confined, true);
    assert.equal(mod.targets[1].procs[0].uninterrupted, true);
    assert.equal(mod.targets[1].scripts[0].uninterrupted, true);
    assert.equal(print(parse(print(mod))), print(mod));
    assert.match(print(mod), /script flag uninterrupted \{/);
});

test('an uninterrupted script unrolls a loop that only touches confined variables', () => {
    const source = program({ body: repeatChanging() });
    assert.equal(loopsIn(unrolled(source)), 0);
    sameBehaviour(source);
});

test('a counted for loop with a confined iterator unrolls outside warp', () => {
    const source = program({ body: countedFor });
    assert.equal(loopsIn(unrolled(source)), 0);
    sameBehaviour(source);
});

test('without uninterrupted, a script loop keeps its yields', () => {
    assert.equal(loopsIn(unrolled(program({ script: 'script flag', body: repeatChanging() }))), 1);
});

test('a loop that touches a variable another thread may see keeps its yields', () => {
    assert.equal(loopsIn(unrolled(program({ body: repeatChanging('@shared') }))), 1);
    assert.equal(loopsIn(unrolled(program({ confined: ['@log'], body: repeatChanging() }))), 1);
    assert.equal(loopsIn(unrolled(program({ confined: ['@total', '@log'], body: countedFor }))), 1);
});

test('a loop that draws, waits, broadcasts or calls keeps its yields', () => {
    for (const extra of ['\n      sb motion_movesteps(STEPS: 1)', '\n      wait 0', '\n      broadcast "go"']) {
        assert.equal(loopsIn(unrolled(program({ body: repeatChanging('@total', extra) }))), 1, extra);
    }
    const withCall = program({ body: repeatChanging('@total', '\n      call @noop()'), proc: '  proc @noop() noinline {\n  }\n' });
    assert.equal(loopsIn(unrolled(withCall)), 1);
});

test('an uninterrupted non-warp proc unrolls the same way', () => {
    const source = program({
        script: 'script flag',
        body: '    call @fill()',
        proc: `  proc @fill() uninterrupted noinline {\n${repeatChanging()}\n  }\n`,
    });
    const mod = unrolled(source);
    assert.equal(loopsIn(mod), 0);
    sameBehaviour(source);
});

test('a confined variable read before a yield is not spilled, since no other thread can change it', () => {
    const src = (flag) => `sprite "S" {\n  var @x${flag}\n  var @y\n  script flag {\n    %0 = var.get @x\n    wait 1\n    var.set @y, %0\n  }\n}\n`;
    assert.match(print(runPipeline(parse(src('')), ['legalize'])), /slvm_spill/);
    assert.doesNotMatch(print(runPipeline(parse(src(' confined')), ['legalize'])), /slvm_spill/);
});
