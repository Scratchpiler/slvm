import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, runPipeline } from '../src/index.js';

const program = (body, procs = '') => `stage {
  var @user
}

sprite "S" {
  var @_scratchpiler_internal_t internal
  var @local confined
  list @log
${procs}
  script flag {
${body}
  }
}
`;

const deadVars = (source) => runPipeline(parse(source), ['dead-vars']);
const scriptOf = (mod) => print(mod).split(/script \w+/)[1];
const count = (text, pattern) => (text.match(pattern) ?? []).length;

test('writes to compiler variables nobody reads are deleted, reads anywhere keep them', () => {
    const dead = program('    var.set @_scratchpiler_internal_t, 1\n    var.change @_scratchpiler_internal_t, 1\n    list.add @log, 1');
    assert.doesNotMatch(scriptOf(deadVars(dead)), /_scratchpiler_internal_t/);

    const read = program('    var.set @_scratchpiler_internal_t, 1\n    list.add @log, 1', '  proc @peek() warp {\n    %v = var.get @_scratchpiler_internal_t\n    list.add @log, %v\n  }');
    assert.match(scriptOf(deadVars(read)), /_scratchpiler_internal_t/);

    const user = program('    var.set @user, 1\n    var.set @local, 1');
    assert.equal(count(scriptOf(deadVars(user)), /var\.set/g), 2, 'user-visible variables are never dead for lack of readers');
});

test('a hat region that reads a compiler variable keeps its writes', () => {
    const source = `sprite "S" {
  var @_scratchpiler_internal_t internal
  script greater "TIMER" with {
    %v = var.get @_scratchpiler_internal_t
    value %v
  } {
    var.set @_scratchpiler_internal_t, 1
  }
}
`;
    assert.match(print(deadVars(source)), /var\.set @_scratchpiler_internal_t, 1/);
});


test('lists written but never read are deleted too, and the spill stack is not mistaken for one', () => {
    const source = `sprite "S" {
  list @_scratchpiler_internal_scratch internal
  list @_scratchpiler_internal_kept internal
  script flag {
    list.add @_scratchpiler_internal_scratch, 1
    list.add @_scratchpiler_internal_kept, 2
    %n = list.len @_scratchpiler_internal_kept
    var.set @sink, %n
  }
  var @sink
}
`;
    const text = print(deadVars(source));
    assert.doesNotMatch(text, /list\.add @_scratchpiler_internal_scratch/);
    assert.match(text, /list\.add @_scratchpiler_internal_kept/);
});
