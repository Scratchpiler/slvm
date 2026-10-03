import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, print, run, verify, runPipeline, slc, cast, VerificationError } from '../src/index.js';
import { runInScratchVM, hasScratchVM } from '../src/testing/scratch-vm.js';

const VALUES = ['', ' ', '0', '-0', '1.50', 'false', 'NaN', 'Infinity', '-Infinity', 'abc', 'ABC', '0x10', '\t', '\n', '雪🐈'];
const OPERATIONS = ['add', 'sub', 'mul', 'div', 'mod', 'eq', 'lt', 'gt', 'join', 'contains'];
const asModule = body => parse(`stage { list @out } sprite "S" { script flag { ${body} } }`);
const output = mod => run(mod, { tree: true }).lists.out.map(String);

for (const operation of OPERATIONS) {
    test(`${operation}: optimization and legalization preserve every unusual literal pair`, async () => {
        const body = [];
        const expected = [];
        let id = 0;
        for (const left of VALUES) {
            for (const right of VALUES) {
                body.push(`%v${id} = ${operation} ${JSON.stringify(left)}, ${JSON.stringify(right)}\nlist.add @out, %v${id++}`);
                expected.push(String(cast.EVAL[operation](left, right)));
            }
        }
        const canonical = asModule(body.join('\n'));
        assert.deepEqual(verify(canonical), []);
        assert.deepEqual(run(canonical).lists.out.map(String), expected);
        for (const passes of [['legalize'], ['constfold', 'dce', 'legalize']]) {
            const mod = runPipeline(structuredClone(canonical), passes);
            assert.deepEqual(verify(mod, { legal: true }), []);
            assert.deepEqual(output(mod), expected);
            assert.equal(print(parse(print(mod))), print(mod));
            if (hasScratchVM) {
                const runtime = await runInScratchVM(slc(mod));
                assert.deepEqual(runtime.lists.out.map(String), expected);
            }
        }
    });
}

test('boolean literals in schema slots are emitted as comparison reporters', () => {
    const schema = { custom_predicate: { params: [{ name: 'CONDITION', kind: 'input', valueType: 'boolean' }] } };
    for (const literal of ['false', 'true', '"false"', '"hello"', '0', '1']) {
        const mod = parse(`sprite "S" { script flag { sb custom_predicate(CONDITION: ${literal}) } }`);
        const blocks = slc(mod, { opcodes: schema }).targets[0].blocks;
        const call = Object.values(blocks).find(b => b.opcode === 'custom_predicate');
        const reporter = blocks[call.inputs.CONDITION.block];
        assert.equal(reporter.opcode, 'operator_equals');
        const value = JSON.parse(literal);
        assert.equal(blocks[reporter.inputs.OPERAND2.block].fields.TEXT.value, cast.toBoolean(value) ? '1' : '0');
    }
});

test('extern boolean procedure arguments accept literals with Scratch truthiness', () => {
    const mod = parse('sprite "S" { proc @p(flag) extern {}\n script flag { call @p("false") } }');
    const result = slc(mod, { resolveProc: () => ({ proccode: 'p %b', argumentids: ['flag'], warp: 'false' }) });
    const blocks = result.targets[0].blocks;
    const call = Object.values(blocks).find(b => b.opcode === 'procedures_call');
    assert.equal(blocks[call.inputs.flag.block].opcode, 'operator_equals');
});

for (const [declaration, pattern] of [
    ['var @x var @x', /duplicate var/], ['list @x list @x', /duplicate list/],
    ['proc @p() {} proc @p() {}', /duplicate proc/], ['proc @p(x, x) {}', /duplicate parameter/],
]) {
    test(`verifier rejects ambiguous declarations: ${declaration}`, () => {
        const errors = verify(parse(`sprite "S" { ${declaration.replace(/ (var|list|proc) /g, '\n$1 ')} }`));
        assert.ok(errors.some(message => pattern.test(message)));
    });
}

test('a scalar and list may share a name', () => {
    assert.deepEqual(verify(parse('sprite "S" { var @x\n list @x }')), []);
});

test('invalid pass output produces a typed verification error', () => {
    const mod = parse('sprite "S" { script flag { wait 1 } }');
    mod.targets[0].scripts[0].body[0].args = [];
    assert.throws(() => runPipeline(mod, ['lower-ret']), VerificationError);
});

test('delete-clone may continue on an original sprite and glide-to yields', async () => {
    const original = parse('sprite "S" { script flag { sb control_delete_this_clone()\n wait 1 } }');
    assert.deepEqual(verify(original), []);
    const mod = parse(`sprite "S" { var @x
 var @y
 script flag {
        %v = var.get @x
        sb motion_glideto(SECS: 1, TO: "_mouse_")
        var.set @y, %v
    } }`);
    assert.match(print(runPipeline(mod, ['legalize'])), /slvm_spill/);
});
