import { BLOCKS, HATS, DEFAULT_SB_SCHEMA } from './blocks.js';
import { verify } from '../verify.js';
import { walk, lookupVar } from '../ir.js';

export class SlcError extends Error {}

const SCRIPT_SPACING = 400;
const SLOT_SHADOWS = { num: ['math_number', 'NUM'], text: ['text', 'TEXT'] };
const VALUE_TYPE_KINDS = { number: 'num', string: 'text', boolean: 'bool' };
const VARIABLE_TYPES = { var: '', list: 'list' };

function counterUid(prefix) {
    let n = 0;
    return () => `${prefix}${n++}`;
}

function literalText(value, kind) {
    if (typeof value === 'boolean') return kind === 'num' ? (value ? '1' : '0') : String(value);
    return String(value);
}

function usesBoolArg(proc, param) {
    let found = false;
    walk(proc.body, (op) => { if (op.op === 'arg.b' && op.args[0].name === param) found = true; });
    return found;
}

export function slc(mod, { uid = counterUid('slc_'), opcodes = {}, resolveVariable = () => undefined, resolveBroadcast = () => undefined } = {}) {
    const problems = verify(mod, { legal: true });
    if (problems.length) throw new SlcError(`IR is not legal:\n  ${problems.join('\n  ')}`);
    const schema = { ...DEFAULT_SB_SCHEMA, ...opcodes };

    const variableIds = new Map();
    const output = mod.targets.map((target) => ({
        kind: target.kind,
        name: target.kind === 'stage' ? 'Stage' : target.name,
        variables: target.vars.map((decl) => {
            const id = resolveVariable(target, decl) ?? uid();
            variableIds.set(decl, id);
            return { id, name: decl.name, type: VARIABLE_TYPES[decl.kind], internal: decl.internal };
        }),
        blocks: {},
    }));
    const stageOut = output.find((t) => t.kind === 'stage');
    const broadcastIds = new Map();
    const broadcastId = (name) => {
        if (!broadcastIds.has(name)) broadcastIds.set(name, resolveBroadcast(name) ?? uid());
        return broadcastIds.get(name);
    };

    mod.targets.forEach((target, ti) => {
        const blocks = output[ti].blocks;
        const isStage = target.kind === 'stage';
        const signatures = new Map(target.procs.map((proc) => {
            const kinds = proc.params.map((p) => (usesBoolArg(proc, p) ? 'bool' : 'text'));
            return [proc.name, {
                proccode: [proc.name, ...kinds.map((k) => (k === 'bool' ? '%b' : '%s'))].join(' '),
                argumentids: proc.params.map(() => uid()),
                kinds,
                warp: proc.warp ? 'true' : 'false',
            }];
        }));

        const add = (opcode, parent, extra = {}) => {
            const id = uid();
            blocks[id] = { id, opcode, next: null, parent, inputs: {}, fields: {}, shadow: false, topLevel: false, ...extra };
            return blocks[id];
        };
        const symbolField = (fieldName, kind, symbolName) => {
            const decl = lookupVar(mod, target, symbolName, kind);
            return { name: fieldName, value: symbolName, id: variableIds.get(decl), variableType: VARIABLE_TYPES[kind] };
        };
        const broadcastField = (name) => ({ name: 'BROADCAST_OPTION', value: name, id: broadcastId(name), variableType: 'broadcast_msg' });

        function emitRoot(body, parent) {
            const defs = new Map();
            walk(body, (op) => { if (op.result !== null) defs.set(op.result, op); });
            const shadowFor = (kind, value, parent, menu) => {
                if (kind === 'broadcast') {
                    return add('event_broadcast_menu', parent, { shadow: true, fields: { BROADCAST_OPTION: broadcastField(String(value)) } }).id;
                }
                const [opcode, field] = menu ? [menu.opcode, menu.field] : SLOT_SHADOWS[kind];
                return add(opcode, parent, { shadow: true, fields: { [field]: { name: field, value: literalText(value, kind) } } }).id;
            };

            const setInput = (block, name, kind, operand, menu) => {
                if (kind === 'bool') {
                    if (operand.ref === undefined) throw new SlcError(`${block.opcode}.${name}: boolean slot needs a reporter`);
                    block.inputs[name] = { name, block: emitValue(operand.ref, block.id), shadow: null };
                    return;
                }
                if (operand.ref === undefined) {
                    const s = shadowFor(kind, operand.lit, block.id, menu);
                    block.inputs[name] = { name, block: s, shadow: s };
                    return;
                }
                const s = shadowFor(kind, kind === 'num' ? 0 : '', block.id, menu);
                block.inputs[name] = { name, block: emitValue(operand.ref, block.id), shadow: s };
            };

            const fill = (block, op, spec) => {
                let args = op.args;
                if (spec.symbol) {
                    const [field, kind] = spec.symbol;
                    block.fields[field] = symbolField(field, kind, args[0].sym);
                    args = args.slice(1);
                }
                for (const [field, value] of Object.entries(spec.fields ?? {})) block.fields[field] = { name: field, value };
                spec.inputs.forEach(([name, kind], i) => setInput(block, name, kind, args[i]));
            };

            const fillScratchOp = (block, op) => {
                const params = schema[op.opcode]?.params ?? [];
                op.keys.forEach((key, i) => {
                    const operand = op.args[i];
                    const param = params.find((p) => p.name === key);
                    if (param?.kind === 'field') {
                        if (operand.lit === undefined) throw new SlcError(`${op.opcode}.${key} is a field and needs a literal`);
                        block.fields[key] = { name: key, value: String(operand.lit) };
                        return;
                    }
                    const kind = param?.menuShadow ? 'text' : VALUE_TYPE_KINDS[param?.valueType] ?? 'text';
                    setInput(block, key, kind, operand, param?.menuShadow);
                });
            };

            function emitValue(id, parent) {
                const op = defs.get(id);
                if (op.op === 'arg' || op.op === 'arg.b') {
                    const opcode = op.op === 'arg' ? 'argument_reporter_string_number' : 'argument_reporter_boolean';
                    return add(opcode, parent, { fields: { VALUE: { name: 'VALUE', value: op.args[0].name } } }).id;
                }
                if (op.op === 'sb') {
                    const block = add(op.opcode, parent);
                    fillScratchOp(block, op);
                    return block.id;
                }
                const spec = BLOCKS[op.op];
                const block = add(spec.opcode, parent);
                fill(block, op, spec);
                return block.id;
            }

            function emitStatement(op, parent) {
                switch (op.op) {
                    case 'if': {
                        const block = add(op.regions.length > 1 ? 'control_if_else' : 'control_if', parent);
                        setInput(block, 'CONDITION', 'bool', op.args[0]);
                        substack(block, 'SUBSTACK', op.regions[0]);
                        if (op.regions[1]) substack(block, 'SUBSTACK2', op.regions[1]);
                        return block;
                    }
                    case 'until':
                    case 'wait.until': {
                        const block = add(op.op === 'until' ? 'control_repeat_until' : 'control_wait_until', parent);
                        setInput(block, 'CONDITION', 'bool', op.regions[0].at(-1).args[0]);
                        if (op.op === 'until') substack(block, 'SUBSTACK', op.regions[1]);
                        return block;
                    }
                    case 'stop': {
                        const option = String(op.args[0].lit);
                        return add('control_stop', parent, {
                            fields: { STOP_OPTION: { name: 'STOP_OPTION', value: option } },
                            mutation: { tagName: 'mutation', children: [], hasnext: String(option === 'other scripts in sprite') },
                        });
                    }
                    case 'call': {
                        const sig = signatures.get(op.callee);
                        const block = add('procedures_call', parent, {
                            mutation: { tagName: 'mutation', children: [], proccode: sig.proccode, argumentids: JSON.stringify(sig.argumentids), warp: sig.warp },
                        });
                        sig.argumentids.forEach((argId, i) => setInput(block, argId, sig.kinds[i], op.args[i]));
                        return block;
                    }
                    case 'sb': {
                        const block = add(op.opcode, parent);
                        fillScratchOp(block, op);
                        return block;
                    }
                }
                const spec = BLOCKS[op.op];
                if (!spec) throw new SlcError(`no block form for \`${op.op}\``);
                const block = add(spec.opcode, parent);
                fill(block, op, spec);
                (spec.substacks ?? []).forEach((name, i) => substack(block, name, op.regions[i]));
                return block;
            }

            function substack(block, name, region) {
                const first = emitStack(region, block.id);
                if (first) block.inputs[name] = { name, block: first, shadow: null };
            }

            function emitStack(region, parent) {
                let first = null;
                let prev = null;
                for (const op of region) {
                    if (op.result !== null || op.op === 'cond') continue;
                    const block = emitStatement(op, prev ?? parent);
                    if (prev) blocks[prev].next = block.id;
                    else first = block.id;
                    prev = block.id;
                }
                return first;
            }

            return emitStack(body, parent);
        }

        let x = 50;
        const place = (block) => {
            Object.assign(block, { topLevel: true, x, y: 50 });
            x += SCRIPT_SPACING;
        };

        for (const proc of target.procs) {
            const sig = signatures.get(proc.name);
            const def = add('procedures_definition', null);
            const proto = add('procedures_prototype', def.id, {
                shadow: true,
                mutation: {
                    tagName: 'mutation', children: [], proccode: sig.proccode,
                    argumentids: JSON.stringify(sig.argumentids),
                    argumentnames: JSON.stringify(proc.params),
                    argumentdefaults: JSON.stringify(sig.kinds.map((k) => (k === 'bool' ? 'false' : ''))),
                    warp: sig.warp,
                },
            });
            sig.argumentids.forEach((argId, i) => {
                const opcode = sig.kinds[i] === 'bool' ? 'argument_reporter_boolean' : 'argument_reporter_string_number';
                const reporter = add(opcode, proto.id, { shadow: true, fields: { VALUE: { name: 'VALUE', value: proc.params[i] } } });
                proto.inputs[argId] = { name: argId, block: reporter.id, shadow: reporter.id };
            });
            def.inputs.custom_block = { name: 'custom_block', block: proto.id, shadow: proto.id };
            place(def);
            def.next = emitRoot(proc.body, def.id);
        }

        for (const script of target.scripts) {
            const hatSpec = HATS[script.hat.event];
            if (!hatSpec) throw new SlcError(`unknown hat \`${script.hat.event}\``);
            const { opcode, fields = {}, broadcastField: message } = hatSpec(script.hat.arg, isStage);
            const hat = add(opcode, null, {
                fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, { name: k, value: v }])),
            });
            if (message !== undefined) hat.fields.BROADCAST_OPTION = broadcastField(message);
            place(hat);
            hat.next = emitRoot(script.body, hat.id);
        }
    });

    if (broadcastIds.size) {
        if (!stageOut) throw new SlcError('broadcasts need a `stage` target to own their messages');
        for (const [name, id] of broadcastIds) stageOut.variables.push({ id, name, type: 'broadcast_msg', internal: false });
    }
    return { targets: output };
}
