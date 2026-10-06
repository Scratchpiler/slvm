import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, runPipeline, verify } from '../src/index.js';
import { summarize } from '../src/passes/effects.js';

const visible = (store) => Object.fromEntries(Object.entries(store).filter(([name]) => !name.startsWith('_')));

const program = ({ procs, script, confined = true }) => `stage {
  var @total${confined ? ' confined' : ''}
  var @shared
}

sprite "S" {
  list @log${confined ? ' confined' : ''}
${procs}
  script flag uninterrupted {
${script}
  }
}
`;

const scriptOf = (source, passes) => print(runPipeline(parse(source), passes)).split('script flag')[1];
const callsIn = (source, passes) => (scriptOf(source, passes).match(/\bcall @\w+/g) ?? []).length;

const unusedCall = (proc) => program({
    procs: proc,
    script: '    %r = call @f(2)\n    var.set @shared, 1',
});

test('summaries record reads, effects on the world, and divergence', () => {
    const mod = parse(program({
        procs: `
  proc @pure(x) warp returns {
    %0 = arg x
    ret %0
  }
  proc @reads() warp returns {
    %0 = var.get @shared
    ret %0
  }
  proc @spin() warp {
    forever {
      var.change @shared, 1
    }
  }
  proc @loud() warp {
    sb motion_movesteps(STEPS: 10)
  }
  proc @again(n) warp {
    call @again(1)
  }
  proc @wrapper() warp {
    call @spin()
  }`,
        script: '    call @pure(1)',
    }));
    const s = summarize(mod.targets[1]);
    const flags = (name) => ({ writes: s.get(name).writes.size, reads: s.get(name).reads.size, world: s.get(name).world, diverges: s.get(name).diverges });
    assert.deepEqual(flags('pure'), { writes: 0, reads: 0, world: false, diverges: false });
    assert.deepEqual(flags('reads'), { writes: 0, reads: 1, world: false, diverges: false });
    assert.equal(flags('spin').diverges, true);
    assert.equal(flags('loud').world, true);
    assert.equal(flags('again').diverges, true, 'a recursive proc may never return');
    assert.equal(flags('wrapper').diverges, true, 'divergence is inherited from callees');
    assert.equal(flags('wrapper').writes, 1);
});

test('dce deletes an unused call to a proc that only computes', () => {
    const source = unusedCall(`
  proc @f(x) warp returns {
    %0 = arg x
    %1 = mul %0, %0
    ret %1
  }`);
    assert.equal(callsIn(source, ['dce']), 0);
});

test('dce deletes an unused call to a proc that reads state and loops finitely', () => {
    const source = unusedCall(`
  proc @f(x) warp returns {
    %0 = list.len @log
    repeat 3 {
      %1 = var.get @shared
    }
    ret %0
  }`);
    assert.equal(callsIn(source, ['dce']), 0);
});

test('dce keeps calls that write, draw, stop, wait, spin, recurse or cannot be seen', () => {
    const cases = {
        'writes a variable': 'var.change @shared, 1\n    ret 0',
        'writes a list': 'list.add @log, 1\n    ret 0',
        'draws': 'sb motion_movesteps(STEPS: 1)\n    ret 0',
        'broadcasts': 'broadcast "go"\n    ret 0',
        'waits': 'wait 1\n    ret 0',
        'may never end': 'forever {\n      %0 = var.get @shared\n    }',
        'recurses': '%0 = call @f(1)\n    ret %0',
    };
    for (const [why, body] of Object.entries(cases)) {
        const source = unusedCall(`  proc @f(x) warp returns {\n    ${body}\n  }`);
        assert.equal(callsIn(source, ['dce']), 1, why);
    }
    const extern = unusedCall('  proc @f(x) extern returns {\n  }').replace('%r = call @f(2)', 'call @f(2)');
    assert.equal(callsIn(extern, ['dce']), 1, 'extern');
});

test('dce keeps a call whose callee yields from a non-warp caller, and when the callee is non-warp', () => {
    const loopy = '(x)  {\n    repeat 3 {\n      %0 = var.get @shared\n    }\n  }';
    const source = (callerWarp) => `stage {
  var @shared
}

sprite "S" {
  proc @f${loopy}
  proc @g()${callerWarp ? ' warp' : ''} {
    call @f(1)
  }
  script flag {
    call @g()
  }
}
`;
    const kept = print(runPipeline(parse(source(false)), ['dce']));
    assert.match(kept, /proc @g\(\) \{\n\s+call @f\(1\)/);
    assert.doesNotMatch(print(runPipeline(parse(source(true)), ['dce'])), /proc @g\(\) warp \{\n\s+call @f/, 'a warp caller never yields at the call');
});

test('a call to an isolated warp proc no longer blocks unrolling an uninterrupted loop', () => {
    const proc = `
  proc @bump() warp {
    var.change @total, 2
  }`;
    const loop = '    repeat 3 {\n      call @bump()\n    }';
    const source = program({ procs: proc, script: loop });
    const after = print(runPipeline(parse(source), ['unroll']));
    assert.equal((after.match(/call @bump/g) ?? []).length, 3);
    assert.doesNotMatch(after, /repeat/);

    const reference = run(parse(source));
    const optimized = runPipeline(parse(source), ['O1']);
    assert.deepEqual(verify(optimized, { legal: true }), []);
    assert.deepEqual(visible(run(optimized, { tree: true }).vars), visible(reference.vars));
});

test('unrolling still refuses calls that other threads could see or interrupt', () => {
    const loop = '    repeat 3 {\n      call @bump()\n    }';
    const body = '    var.change @total, 2';
    const refuse = {
        'unconfined state': program({ procs: `  proc @bump() warp {\n    var.change @shared, 2\n  }`, script: loop }),
        'a callee that is not warp': program({ procs: `  proc @bump() {\n${body}\n  }`, script: loop }),
        'a callee that waits': program({ procs: `  proc @bump() warp {\n${body}\n    wait 1\n  }`, script: loop }),
        'a callee that draws': program({ procs: `  proc @bump() warp {\n${body}\n    sb motion_movesteps(STEPS: 1)\n  }`, script: loop }),
        'an extern callee': program({ procs: '  proc @bump() extern {\n  }', script: loop }),
        'a callee reaching unconfined state': program({ procs: `  proc @inner() warp {\n    var.change @shared, 1\n  }\n  proc @bump() warp {\n    call @inner()\n  }`, script: loop }),
    };
    for (const [why, source] of Object.entries(refuse)) {
        assert.match(print(runPipeline(parse(source), ['unroll'])), /repeat 3/, why);
    }
});
