import { OPS, EFFECT_RANK, effectOf, typeOf, isTerminator } from './ops.js';
import { roots, lookupVar } from './ir.js';
import { findHazard, rootContext } from './passes/spill.js';

export function verify(mod, { legal = false } = {}) {
    const errors = [];

    const targetNames = new Set();
    for (const target of mod.targets) {
        const targetName = `${target.kind}:${target.name ?? ''}`;
        if (targetNames.has(targetName)) errors.push(`duplicate target ${targetName}`);
        targetNames.add(targetName);
        const variables = new Set();
        for (const variable of target.vars) {
            const key = `${variable.kind}:${variable.name}`;
            if (variables.has(key)) errors.push(`duplicate ${variable.kind} @${variable.name}`);
            variables.add(key);
        }
        const procedures = new Set();
        for (const proc of target.procs) {
            if (procedures.has(proc.name)) errors.push(`duplicate proc @${proc.name}`);
            procedures.add(proc.name);
            if (new Set(proc.params).size !== proc.params.length) errors.push(`proc @${proc.name}: duplicate parameter`);
        }
        for (const proc of target.procs) {
            if (proc.extern && proc.body.length) errors.push(`proc @${proc.name}: an extern proc has no body`);
        }
    }

    for (const { target, proc, script, body } of roots(mod)) {
        const where = proc ? `proc @${proc.name}` : `script ${script.hat.event}`;
        const fail = (op, msg) => errors.push(`${where}${op?.line ? ` (line ${op.line})` : ''}: ${msg}`);
        const types = new Map();

        const boolOperand = (op, a) => {
            if (a.lit !== undefined) {
                if (typeof a.lit !== 'boolean') fail(op, `\`${op.op}\` needs a boolean, got literal ${JSON.stringify(a.lit)}`);
                else if (legal) fail(op, `boolean literal in a boolean slot has no block form; materialize it first`);
            } else if (a.ref !== undefined && types.get(a.ref) !== 'bool') {
                fail(op, `\`${op.op}\` needs a boolean, but %${a.ref} is a round reporter`);
            }
        };

        const checkOp = (op, scope, ctx) => {
            const spec = OPS[op.op];
            if (spec.arity !== null && op.args.length !== spec.arity) {
                fail(op, `\`${op.op}\` takes ${spec.arity} operand(s), got ${op.args.length}`);
            }
            op.args.forEach((a, i) => {
                const want = spec.operands?.[i];
                if (a.ref !== undefined && !scope.has(a.ref)) fail(op, `%${a.ref} used before definition or out of scope`);
                if (want === 'var' || want === 'list') {
                    if (a.sym === undefined) fail(op, `\`${op.op}\` operand ${i} must be a @${want}`);
                    else if (!lookupVar(mod, target, a.sym, want)) fail(op, `undeclared ${want} @${a.sym}`);
                } else if (want === 'name') {
                    if (a.name === undefined) fail(op, `\`${op.op}\` needs a parameter name`);
                    else if (!proc || !proc.params.includes(a.name)) fail(op, `\`${a.name}\` is not a parameter of this proc`);
                } else if (a.sym !== undefined || a.name !== undefined) {
                    fail(op, `\`${op.op}\` operand ${i} must be a value`);
                }
            });
            for (const i of spec.boolArgs || []) if (op.args[i]) boolOperand(op, op.args[i]);

            const type = typeOf(op);
            if (op.op === 'call') {
                const callee = target.procs.find((p) => p.name === op.callee);
                if (!callee) fail(op, `call to undefined proc @${op.callee}`);
                else if (callee.extern && op.result !== null) fail(op, `@${op.callee} is extern; its return value is unknown`);
                else {
                    if (callee.params.length !== op.args.length) fail(op, `@${op.callee} takes ${callee.params.length} argument(s), got ${op.args.length}`);
                    if (op.result !== null && !callee.returns) fail(op, `@${op.callee} does not return a value`);
                }
                if (legal && op.result !== null) fail(op, 'call with a result must be lowered (lower-ret)');
            } else if (type === null && op.result !== null) {
                fail(op, `\`${op.op}\` produces no value`);
            } else if (type !== null && op.result === null) {
                fail(op, `\`${op.op}\` result must be named`);
            }

            if (op.op === 'ret') {
                if (!proc) fail(op, '`ret` outside a proc');
                else if (op.args.length > 1) fail(op, '`ret` takes at most one operand');
                else if (op.args.length === 1 && !proc.returns) fail(op, `\`ret\` with a value in @${proc.name}, which is not declared \`returns\``);
                if (legal && op.args.length) fail(op, '`ret` with a value must be lowered (lower-ret)');
            }
            if (op.op === 'break' || op.op === 'continue') {
                if (!ctx.inLoop) fail(op, `\`${op.op}\` outside a loop`);
                if (legal) fail(op, `\`${op.op}\` must be lowered (lower-break)`);
            }
            if (op.op === 'cond' && !ctx.inCond) fail(op, '`cond` outside a condition region');
            if (op.op === 'value' && !ctx.inHat) fail(op, '`value` outside a hat region');
            if (legal && op.op === 'truthy' && op.args[0]?.lit !== undefined) fail(op, '`truthy` of a literal has no block form; materialize it first');

            if (spec.regions) {
                const [min, max] = spec.regions;
                if (op.regions.length < min || op.regions.length > max) fail(op, `\`${op.op}\` needs ${min === max ? min : `${min}-${max}`} region(s)`);
            }
            if (op.result !== null) {
                if (types.has(op.result)) fail(op, `%${op.result} defined twice`);
                types.set(op.result, type);
            }
        };

        const checkRegion = (region, outer, ctx) => {
            const scope = new Set(outer);
            region.forEach((op, i) => {
                if (!OPS[op.op]) return fail(op, `unknown op \`${op.op}\``);
                checkOp(op, scope, ctx);
                if (op.op === 'cond' && i !== region.length - 1) fail(op, '`cond` must end its region');
                if (isTerminator(op) && i !== region.length - 1) fail(region[i + 1], `unreachable op after \`${op.op}\``);
                const spec = OPS[op.op];
                if (legal && spec.stepRegion !== undefined && op.regions[spec.stepRegion]) {
                    fail(op, `\`${op.op}\` step region must be lowered (lower-break)`);
                }
                op.regions.forEach((r, ri) => {
                    const isCond = spec.condRegion === ri;
                    const isStep = spec.stepRegion === ri;
                    if (isCond) {
                        if (r.at(-1)?.op !== 'cond') fail(op, `\`${op.op}\` condition region must end with \`cond\``);
                        if (legal) {
                            for (const c of r) {
                                if (c.op !== 'cond' && EFFECT_RANK[effectOf(c)] > EFFECT_RANK.read) {
                                    fail(c, `\`${c.op}\` in a condition region has no block form; rotate the loop first`);
                                }
                            }
                        }
                    }
                    checkRegion(r, scope, {
                        inLoop: !isCond && !isStep && (spec.loop || ctx.inLoop),
                        inCond: isCond,
                    });
                });
                if (op.result !== null) scope.add(op.result);
            });
        };

        checkRegion(body, new Set(), { inLoop: false, inCond: false });

        const hatRegion = script?.hat.with;
        if (hatRegion) {
            checkRegion(hatRegion, new Set(), { inLoop: false, inCond: false, inHat: true });
            if (hatRegion.at(-1)?.op !== 'value') fail(null, 'a hat region must end with `value`');
            const uses = new Map();
            for (const op of hatRegion) {
                for (const a of op.args) if (a.ref !== undefined) uses.set(a.ref, (uses.get(a.ref) ?? 0) + 1);
                if (op.op !== 'value' && (op.result === null || EFFECT_RANK[effectOf(op)] > EFFECT_RANK.read)) {
                    fail(op, `\`${op.op}\` cannot appear in a hat region, which may only compute a value`);
                }
            }
            if (legal) {
                for (const op of hatRegion) {
                    if (op.result !== null && uses.get(op.result) !== 1) fail(op, `%${op.result} in a hat region must be used exactly once`);
                }
            }
        }

        if (legal && !errors.length) {
            const hazard = findHazard(body, rootContext(mod, { target, proc, script }));
            if (hazard) {
                const why = hazard.kind === 'spill' && hazard.point
                    ? 'may change before its block runs'
                    : 'is used more than once';
                fail(hazard.op, `%${hazard.op.result} (\`${hazard.op.op}\`) ${why}; run spill`);
            }
        }
    }
    return errors;
}
