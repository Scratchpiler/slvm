import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, verify, runPipeline, slc, ParseError } from '../src/index.js';

const compile = (mod) => slc(runPipeline(mod, ['legalize']));
const find = (out, opcode) => Object.values(out.targets[0].blocks).find((b) => b.opcode === opcode);
const tagOf = (out, block) => out.targets[0].tags.find((t) => t.blockId === block.id)?.tag;

const SOURCE = `stage {
  var @n

  proc @f(x) warp noinline {
    var.set @n, 1
  }

  script flag {
    repeat 4 nounroll {
      var.change @n, 1
    }
    until nounroll {
      %0 = var.get @n
      %1 = gt %0, 9
      cond %1
    } do {
      var.change @n, 1
    }
  }
}
`;

test('noinline and nounroll survive print and parse', () => {
    assert.equal(print(parse(SOURCE)), SOURCE);
});

test('nounroll is only accepted on loops that can be unrolled', () => {
    assert.throws(() => parse('stage {\n  script flag {\n    forever nounroll {\n      wait 1\n    }\n  }\n}'), ParseError);
    const mod = parse('stage {\n  script flag {\n    forever {\n      wait 1\n    }\n  }\n}');
    mod.targets[0].scripts[0].body[0].nounroll = true;
    assert.match(verify(mod).join('\n'), /`forever` cannot take `nounroll`/);
});

test('nounroll and tags move onto the loop that lowering produces', () => {
    const mod = parse(`stage {
  var @n
  script flag {
    repeat 4 nounroll {
      var.change @n, 1
      break
    }
  }
}`);
    mod.targets[0].scripts[0].body[0].tag = 'loop';
    const lowered = runPipeline(mod, ['legalize']).targets[0].scripts[0].body;
    const loop = lowered.find((op) => op.op === 'until');
    assert.equal(loop.nounroll, true);
    assert.equal(loop.tag, 'loop');
});

test('slc echoes tags for procs, scripts and statements, and ignores untagged blocks', () => {
    const mod = parse(SOURCE);
    const [proc] = mod.targets[0].procs;
    const [script] = mod.targets[0].scripts;
    proc.tag = { what: 'proc' };
    script.tag = { what: 'script' };
    script.body[0].tag = { what: 'repeat' };
    const out = compile(mod);
    assert.deepEqual(tagOf(out, find(out, 'procedures_definition')), { what: 'proc' });
    assert.deepEqual(tagOf(out, find(out, 'event_whenflagclicked')), { what: 'script' });
    assert.deepEqual(tagOf(out, find(out, 'control_repeat')), { what: 'repeat' });
    assert.equal(out.targets[0].tags.length, 3);
});

test('a tag on a value op is not echoed', () => {
    const mod = parse('stage {\n  var @n\n  script flag {\n    %0 = var.get @n\n    var.set @n, %0\n  }\n}');
    mod.targets[0].scripts[0].body[0].tag = 'value';
    assert.deepEqual(compile(mod).targets[0].tags, []);
});
