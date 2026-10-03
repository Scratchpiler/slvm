import { roots, idGenerator, freshInternal, cloneRegion, mkOp, ref, sym, lit } from '../ir.js';
import { EFFECT_RANK, effectOf, isTerminator } from '../ops.js';

const needsRotation = (condRegion) =>
    condRegion.some((op) => op.op !== 'cond' && EFFECT_RANK[effectOf(op)] > EFFECT_RANK.read);

function rotate(loop, ctx) {
    const { mod, target, gen } = ctx;
    const condRegion = loop.regions[0];
    const flag = freshInternal(mod, target, 'var', 'rot');
    const store = (ops) => {
        const c = ops.at(-1).args[0];
        return [...ops.slice(0, -1), mkOp('var.set', [sym(flag), c])];
    };

    const got = gen();
    const truthy = gen();
    const test = [
        mkOp('var.get', [sym(flag)], { result: got }),
        mkOp('eq', [ref(got), lit('true')], { result: truthy }),
        mkOp('cond', [ref(truthy)]),
    ];

    const body = loop.op === 'until' ? loop.regions[1] : [];
    const step = loop.regions[2];
    const recompute = store(cloneRegion(condRegion, gen));
    if (step) step.push(...recompute);
    else if (!(body.length && isTerminator(body.at(-1)))) body.push(...recompute);
    return [...store(condRegion), mkOp('until', [], { regions: [test, body, ...(step ? [step] : [])] })];
}

function rotateRegion(region, ctx) {
    return region.flatMap((op) => {
        op.regions = op.regions.map((r) => rotateRegion(r, ctx));
        const rotatable = op.op === 'until' || op.op === 'wait.until';
        return rotatable && needsRotation(op.regions[0]) ? rotate(op, ctx) : [op];
    });
}

export function rotateCond(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = rotateRegion(holder.body, { mod, target: root.target, gen: idGenerator(holder.body) });
    }
    return mod;
}
