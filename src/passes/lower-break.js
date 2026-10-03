import { roots, idGenerator, freshInternal, mkOp, ref, lit, sym, carried } from '../ir.js';
import { isTerminator } from '../ops.js';
import { toNumber } from '../cast.js';

const LOOPS = new Set(['repeat', 'forever', 'until']);

function scan(region, found) {
    for (const op of region) {
        if (op.op === 'break') found.brk = true;
        else if (op.op === 'continue') found.cont = true;
        else if (!LOOPS.has(op.op)) for (const r of op.regions) scan(r, found);
    }
}

function setsFlag(op, flags) {
    let hit = false;
    const visit = (o) => {
        if (o.op === 'var.set' && flags.includes(o.args[0].sym)) hit = true;
        else if (!LOOPS.has(o.op)) for (const r of o.regions) r.forEach(visit);
    };
    visit(op);
    return hit;
}

function lowerLoop(loop, ctx) {
    const bodyIndex = loop.op === 'until' ? 1 : 0;
    const step = loop.op === 'until' && loop.regions.length > 2 ? loop.regions.pop() : null;
    const found = { brk: false, cont: false };
    scan(loop.regions[bodyIndex], found);

    const { mod, target, gen } = ctx;
    const flagEquals = (name, v, into) => {
        const got = gen();
        const eq = gen();
        into.push(mkOp('var.get', [sym(name)], { result: got }), mkOp('eq', [ref(got), lit(v)], { result: eq }));
        return eq;
    };
    const withStep = (region, brkFlag) => {
        if (!step || (region.length && isTerminator(region.at(-1)))) return region;
        if (!brkFlag) return [...region, ...step];
        const ops = [];
        const notBroken = flagEquals(brkFlag, 0, ops);
        return [...region, ...ops, mkOp('if', [ref(notBroken)], { regions: [step] })];
    };

    if (!found.brk && !found.cont) {
        loop.regions[bodyIndex] = withStep(loop.regions[bodyIndex], null);
        return [loop];
    }

    const brk = found.brk ? freshInternal(mod, target, 'var', 'brk') : null;
    const cont = found.cont ? freshInternal(mod, target, 'var', 'cont') : null;
    const flags = [brk, cont].filter(Boolean);
    const setFlag = (name, v) => mkOp('var.set', [sym(name), lit(v)]);

    const guard = (rest) => {
        const ops = [];
        const tests = flags.map((f) => flagEquals(f, 0, ops));
        const c = tests.reduce((a, b) => {
            const both = gen();
            ops.push(mkOp('and', [ref(a), ref(b)], { result: both }));
            return both;
        });
        ops.push(mkOp('if', [ref(c)], { regions: [rest] }));
        return ops;
    };

    const transform = (region) => {
        const out = [];
        for (let i = 0; i < region.length; i++) {
            const op = region[i];
            if (op.op === 'break') { out.push(setFlag(brk, 1)); break; }
            if (op.op === 'continue') { out.push(setFlag(cont, 1)); break; }
            if (!LOOPS.has(op.op)) op.regions = op.regions.map(transform);
            out.push(op);
            if (i < region.length - 1 && setsFlag(op, flags)) {
                out.push(...guard(transform(region.slice(i + 1))));
                break;
            }
        }
        return out;
    };

    let body = withStep(transform(loop.regions[bodyIndex]), brk);
    if (cont) body = [setFlag(cont, 0), ...body];
    if (!brk) {
        loop.regions[bodyIndex] = body;
        return [loop];
    }

    const exitOr = (condOps, c) => {
        const broke = flagEquals(brk, 1, condOps);
        if (c === null) return broke;
        const either = gen();
        condOps.push(mkOp('or', [c, ref(broke)], { result: either }));
        return either;
    };
    const until = (condOps, c, b) =>
        mkOp('until', [], { regions: [[...condOps, mkOp('cond', [ref(c)])], b], ...carried(loop) });

    switch (loop.op) {
        case 'forever': {
            const condOps = [];
            return [setFlag(brk, 0), until(condOps, exitOr(condOps, null), body)];
        }
        case 'until': {
            const condOps = loop.regions[0].slice(0, -1);
            const c = loop.regions[0].at(-1).args[0];
            return [setFlag(brk, 0), until(condOps, exitOr(condOps, c), body)];
        }
        case 'repeat': {
            const counter = freshInternal(mod, target, 'var', 'rep');
            const [count] = loop.args;
            const condOps = [];
            const k = gen();
            condOps.push(mkOp('var.get', [sym(counter)], { result: k }));
            let bound = lit(Math.round(toNumber(count.lit)));
            if (count.lit === undefined) {
                bound = ref(gen());
                condOps.push(mkOp('round', [count], { result: bound.ref }));
            }
            const below = gen();
            const done = gen();
            condOps.push(
                mkOp('lt', [ref(k), bound], { result: below }),
                mkOp('not', [ref(below)], { result: done }),
            );
            if (!(body.length && isTerminator(body.at(-1)))) body.push(mkOp('var.change', [sym(counter), lit(1)]));
            return [setFlag(counter, 0), setFlag(brk, 0), until(condOps, exitOr(condOps, ref(done)), body)];
        }
    }
    return [loop];
}

function lowerRegion(region, ctx) {
    return region.flatMap((op) => {
        op.regions = op.regions.map((r) => lowerRegion(r, ctx));
        return LOOPS.has(op.op) ? lowerLoop(op, ctx) : [op];
    });
}

export function lowerBreak(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = lowerRegion(holder.body, { mod, target: root.target, gen: idGenerator(holder.body) });
    }
    return mod;
}

