import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse, print, verify, run, runPipeline, slc, SlcError, StepLimitExceeded } from '../src/index.js';
import { hasScratchVM, runInScratchVM, speechOf } from '../src/testing/scratch-vm.js';

const examples = new URL('../examples/', import.meta.url);
const exampleFiles = readdirSync(examples).filter((f) => f.endsWith('.sl'));
const load = (file) => parse(readFileSync(new URL(file, examples), 'utf8'));
const compile = (mod) => slc(runPipeline(mod, ['legalize']));
const compileSrc = (src) => compile(parse(src));
const allBlocks = (out) => Object.assign({}, ...out.targets.map((t) => t.blocks));
const byOpcode = (out, opcode) => Object.values(allBlocks(out)).filter((b) => b.opcode === opcode);

const userVisible = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
const asText = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : String(v)]));

for (const file of exampleFiles) {
    test(`${file}: every block reference points at an existing block`, () => {
        const out = compile(load(file));
        for (const t of out.targets) {
            const ids = new Set(Object.keys(t.blocks));
            const varIds = new Set([...out.targets.flatMap((x) => x.variables.map((v) => v.id))]);
            for (const b of Object.values(t.blocks)) {
                if (b.next !== null) assert.ok(ids.has(b.next), `${b.opcode}.next`);
                if (b.parent !== null) assert.ok(ids.has(b.parent), `${b.opcode}.parent`);
                else assert.ok(b.topLevel, `${b.opcode} has no parent but is not top-level`);
                for (const [name, input] of Object.entries(b.inputs)) {
                    assert.equal(input.name, name);
                    if (input.block !== null) assert.equal(t.blocks[input.block].parent, b.id, `${b.opcode}.${name} child parent`);
                    if (input.shadow !== null) assert.ok(t.blocks[input.shadow].shadow, `${b.opcode}.${name} shadow`);
                }
                for (const field of Object.values(b.fields)) if (field.id !== undefined) assert.ok(varIds.has(field.id), `${b.opcode} field id`);
            }
        }
    });

    test(`${file}: the real Scratch VM agrees with the IR interpreter`, { skip: !hasScratchVM && 'scratch-vm is not installed' }, async (t) => {
        let expected;
        try {
            expected = run(load(file), { maxSteps: 1e5 });
        } catch (e) {
            if (!(e instanceof StepLimitExceeded)) throw e;
            return t.skip('does not terminate');
        }
        const actual = await runInScratchVM(compile(load(file)));
        assert.deepEqual(asText(userVisible(actual.vars)), asText(userVisible(expected.vars)));
        assert.deepEqual(asText(userVisible(actual.lists)), asText(userVisible(expected.lists)));
        assert.deepEqual(actual.said, speechOf(expected.trace));
    });
}

test('boolean literals print as 1/0 in number slots and true/false in text slots', () => {
    const out = slc(parse(`sprite "S" {\n  var @x\n  script flag {\n    var.set @x, true\n    var.change @x, true\n  }\n}\n`));
    assert.equal(byOpcode(out, 'text')[0].fields.TEXT.value, 'true');
    assert.equal(byOpcode(out, 'math_number')[0].fields.NUM.value, '1');
});

test('a reporter in a round slot keeps a shadow underneath it', () => {
    const out = compileSrc(`sprite "S" {\n  var @x\n  script flag {\n    %0 = var.get @x\n    %1 = add %0, 1\n    var.set @x, %1\n  }\n}\n`);
    const [set] = byOpcode(out, 'data_setvariableto');
    const blocks = allBlocks(out);
    assert.equal(blocks[set.inputs.VALUE.block].opcode, 'operator_add');
    assert.equal(blocks[set.inputs.VALUE.shadow].opcode, 'text');
});

test('procedure definitions and calls agree on proccode and argument ids', () => {
    const out = compile(load('return-functions.sl'));
    const protos = byOpcode(out, 'procedures_prototype');
    for (const call of byOpcode(out, 'procedures_call')) {
        const proto = protos.find((p) => p.mutation.proccode === call.mutation.proccode);
        assert.ok(proto, call.mutation.proccode);
        assert.equal(call.mutation.argumentids, proto.mutation.argumentids);
        assert.deepEqual(Object.keys(call.inputs), JSON.parse(proto.mutation.argumentids));
    }
    assert.deepEqual(protos.map((p) => p.mutation.proccode).sort(), ['fact %s', 'greet %s', 'rectArea %s %s']);
});

test('boolean parameters become %b with boolean reporters', () => {
    const out = slc(parse(`sprite "S" {\n  var @x\n  proc @p(flag) {\n    %0 = arg.b flag\n    if %0 {\n      var.set @x, 1\n    }\n  }\n}\n`));
    const [proto] = byOpcode(out, 'procedures_prototype');
    assert.equal(proto.mutation.proccode, 'p %b');
    assert.equal(proto.mutation.argumentdefaults, '["false"]');
    assert.equal(byOpcode(out, 'argument_reporter_boolean').length, 2);
});

test('broadcasts share one message id across senders and receivers, owned by the stage', () => {
    const out = slc(parse(`stage {\n}\nsprite "S" {\n  script flag {\n    broadcast "go"\n  }\n  script receive "go" {\n    wait 1\n  }\n}\n`));
    const [menu] = byOpcode(out, 'event_broadcast_menu');
    const [hat] = byOpcode(out, 'event_whenbroadcastreceived');
    assert.equal(menu.fields.BROADCAST_OPTION.id, hat.fields.BROADCAST_OPTION.id);
    assert.deepEqual(out.targets[0].variables, [{ id: hat.fields.BROADCAST_OPTION.id, name: 'go', type: 'broadcast_msg', internal: false }]);
});

test('resolvers map declarations onto ids that already exist in the project', () => {
    const out = slc(parse(`sprite "S" {\n  var @x\n  script flag {\n    var.set @x, 1\n  }\n}\n`), {
        resolveVariable: (target, decl) => (decl.name === 'x' ? 'existing-id' : undefined),
    });
    assert.equal(byOpcode(out, 'data_setvariableto')[0].fields.VARIABLE.id, 'existing-id');
});

test('slc refuses IR that is not legal', () => {
    assert.throws(() => slc(load('fib.sl')), SlcError);
});

const scratchpiler = new URL('../../scratchpiler/src/', import.meta.url);
const haveScratchpiler = existsSync(new URL('decompiler.js', scratchpiler));

test('Scratchpiler decompiles slc output into source it can compile again', { skip: !haveScratchpiler && 'no sibling scratchpiler checkout' }, async () => {
    const { decompile } = await import(new URL('decompiler.js', scratchpiler));
    const { compileSource } = await import(new URL('compiler.js', scratchpiler));
    const { ASM_OPCODES } = await import(new URL('asm-opcodes.js', scratchpiler));
    for (const file of exampleFiles) {
        const out = slc(runPipeline(load(file), ['legalize']), { opcodes: ASM_OPCODES });
        const targets = out.targets.map((t) => ({
            isStage: t.kind === 'stage',
            sprite: { name: t.name, costumes: [{ name: 'costume1' }], sounds: [] },
            variables: Object.fromEntries(t.variables.map((v) => [v.id, { ...v, value: v.type === 'list' ? [] : 0 }])),
            blocks: { _blocks: structuredClone(t.blocks) },
            comments: {},
            createVariable(id, name, type) { this.variables[id] = { id, name, type: type || '', value: type === 'list' ? [] : 0 }; },
        }));
        const vm = { runtime: { targets }, editingTarget: targets[1], on() {} };
        const source = decompile(vm, 'Sprite1');
        assert.doesNotMatch(source, /unsupported|\/\/ Error/, `${file}:\n${source}`);
        const { errors } = compileSource(source, vm, 'Sprite1');
        assert.deepEqual(errors, [], `${file} decompiled to:\n${source}`);
    }
});

test('truthy puts the round reporter straight into the boolean slot', () => {
    const out = compileSrc(`sprite "S" {\n  var @x\n  script flag {\n    %0 = var.get @x\n    %1 = truthy %0\n    if %1 {\n      var.set @x, 0\n    }\n  }\n}\n`);
    const [ifBlock] = byOpcode(out, 'control_if');
    assert.equal(allBlocks(out)[ifBlock.inputs.CONDITION.block].opcode, 'data_variable');
});

test('truthy of a literal is materialized with Scratch truthiness', () => {
    const src = (v) => `sprite "S" {\n  var @x\n  script flag {\n    %0 = truthy ${v}\n    if %0 {\n      var.set @x, 1\n    }\n  }\n}\n`;
    for (const [v, expected] of [['"false"', '0'], ['"0"', '0'], ['""', '0'], ['"hello"', '1'], ['0', '0'], ['2', '1']]) {
        const out = compileSrc(src(v));
        const [eq] = byOpcode(out, 'operator_equals');
        assert.equal(allBlocks(out)[eq.inputs.OPERAND2.block].fields.TEXT.value, expected, v);
    }
});

test('greater hats keep their sensor and threshold', () => {
    const src = `sprite "S" {\n  var @x\n\n  script greater "LOUDNESS" 25 {\n    var.set @x, 1\n  }\n}\n`;
    assert.match(print(parse(src)), /script greater "LOUDNESS" 25 \{/);
    const out = slc(parse(src));
    const [hat] = byOpcode(out, 'event_whengreaterthan');
    assert.equal(hat.fields.WHENGREATERTHANMENU.value, 'LOUDNESS');
    assert.equal(allBlocks(out)[hat.inputs.VALUE.block].fields.NUM.value, '25');
});

test('show and hide ops become monitor blocks', () => {
    const out = slc(parse(`sprite "S" {\n  var @x\n  list @l\n  script flag {\n    var.show @x\n    list.hide @l\n  }\n}\n`));
    assert.equal(byOpcode(out, 'data_showvariable')[0].fields.VARIABLE.value, 'x');
    assert.equal(byOpcode(out, 'data_hidelist')[0].fields.LIST.value, 'l');
});

test('extern procs are called with the existing prototype and never defined', () => {
    const src = `sprite "S" {\n\n  proc @jump(h) warp extern {\n  }\n\n  script flag {\n    call @jump(5)\n  }\n}\n`;
    assert.equal(print(parse(src)), src);
    const out = slc(parse(src), { resolveProc: () => ({ proccode: 'jump %s', argumentids: ['real-arg'], warp: 'true' }) });
    const [call] = byOpcode(out, 'procedures_call');
    assert.equal(call.mutation.proccode, 'jump %s');
    assert.deepEqual(Object.keys(call.inputs), ['real-arg']);
    assert.equal(byOpcode(out, 'procedures_definition').length, 0);
    assert.throws(() => slc(parse(src)), SlcError);
});

test('a hat region computes the hat threshold as a reporter', () => {
    const src = `sprite "S" {\n  var @limit\n  var @x\n\n  script greater "TIMER" with {\n    %0 = var.get @limit\n    %1 = mul %0, 2\n    value %1\n  } {\n    var.set @x, 1\n  }\n}\n`;
    assert.equal(print(parse(src)), src);
    const out = slc(parse(src));
    const [hat] = byOpcode(out, 'event_whengreaterthan');
    const blocks = allBlocks(out);
    const reporter = blocks[hat.inputs.VALUE.block];
    assert.equal(reporter.opcode, 'operator_multiply');
    assert.equal(blocks[reporter.inputs.NUM1.block].opcode, 'data_variable');
    assert.equal(blocks[hat.inputs.VALUE.shadow].opcode, 'math_number');
});

test('hat regions may only compute a value', () => {
    const src = `sprite "S" {\n  var @x\n\n  script greater "TIMER" with {\n    var.set @x, 1\n    value 3\n  } {\n  }\n}\n`;
    assert.match(verify(parse(src)).join('\n'), /cannot appear in a hat region/);
});

test('list.contents follows Scratch: letters join without spaces, anything else with spaces', async (t) => {
    const src = (items) => `sprite "S" {\n  var @x\n  list @l\n  script flag {\n${items.map((i) => `    list.add @l, ${JSON.stringify(i)}\n`).join('')}    %0 = list.contents @l\n    var.set @x, %0\n  }\n}\n`;
    for (const [items, expected] of [[['a', 'b', 'c'], 'abc'], [['ab', 'c'], 'ab c'], [['1', '2'], '12']]) {
        assert.equal(run(parse(src(items))).vars.x, expected);
        if (hasScratchVM) assert.equal(String((await runInScratchVM(compile(parse(src(items))))).vars.x), expected);
    }
});
