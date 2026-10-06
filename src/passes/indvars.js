import { roots, walk, idGenerator, mkOp, lit, lookupVar, carried } from '../ir.js';
import { effectOf } from '../ops.js';
import { summarize, writesOf, yieldsAt, directReads, ANYTHING, WORLD } from './effects.js';

const INTEGER_REPORTERS = new Set(['list.len', 'length', 'list.index']);

const isIntegerLiteral = (a) => typeof a.lit === 'number' && Number.isInteger(a.lit);

function isFiniteInteger(a, defs) {
    if (a.lit !== undefined) return isIntegerLiteral(a);
    const def = defs.get(a.ref);
    if (!def) return false;
    if (INTEGER_REPORTERS.has(def.op)) return true;
    return (def.op === 'add' || def.op === 'sub') && def.args.every((x) => isFiniteInteger(x, defs));
}

function readCounts(mod) {
    const counts = new Map();
    const note = (op) => { if (op.op === 'var.get') counts.set(op.args[0].sym, (counts.get(op.args[0].sym) ?? 0) + 1); };
    for (const root of roots(mod)) walk(root.body, note);
    for (const target of mod.targets) {
        for (const script of target.scripts) if (script.hat.with) walk(script.hat.with, note);
    }
    return counts;
}

function deepOps(regions) {
    const ops = [];
    for (const r of regions) walk(r, (op) => ops.push(op));
    return ops;
}

function boundIsInvariant(boundOps, loop, ctx) {
    if (!boundOps.every((op) => !op.regions.length && op.op !== 'call' && op.op !== 'sb' && (effectOf(op) === 'pure' || (effectOf(op) === 'read' && op.op !== 'random')))) return false;
    const reads = new Set(boundOps.flatMap(directReads));
    if (reads.has(ANYTHING) || reads.has(WORLD)) return false;
    const inside = deepOps(loop.regions.slice(1));
    const clobbers = inside.some((op) => writesOf(op, ctx.summaries).some((w) => w === ANYTHING || reads.has(w)));
    if (clobbers) return false;
    const shared = [...reads].some((key) => {
        const colon = key.indexOf(':');
        const decl = lookupVar(ctx.mod, ctx.target, key.slice(colon + 1), key.slice(0, colon));
        return !decl?.internal && !decl?.confined;
    });
    return !shared || (!yieldsAt(loop, ctx) && !inside.some((op) => yieldsAt(op, ctx)));
}

function offsetFrom(operand, defs) {
    let base = operand;
    let offset = 0;
    for (let def = defs.get(base.ref); def && (def.op === 'add' || def.op === 'sub') && isIntegerLiteral(def.args[1]); def = defs.get(base.ref)) {
        offset += def.op === 'add' ? def.args[1].lit : -def.args[1].lit;
        base = def.args[0];
    }
    return { base, offset };
}

function tripCount(from, bound, { gen, defs }) {
    if (from.lit !== undefined && bound.lit !== undefined) return { ops: [], count: lit(Math.max(0, bound.lit - from.lit + 1)) };
    if (from.lit !== undefined) {
        const { base, offset: shift } = offsetFrom(bound, defs);
        const offset = shift + 1 - from.lit;
        if (offset === 0) return { ops: [], count: base };
        const count = mkOp(offset > 0 ? 'add' : 'sub', [base, lit(Math.abs(offset))], { result: gen() });
        return { ops: [count], count: { ref: count.result } };
    }
    if (bound.lit !== undefined) {
        const count = mkOp('sub', [lit(bound.lit + 1), from], { result: gen() });
        return { ops: [count], count: { ref: count.result } };
    }
    const next = mkOp('add', [bound, lit(1)], { result: gen() });
    const count = mkOp('sub', [{ ref: next.result }, from], { result: gen() });
    return { ops: [next, count], count: { ref: count.result } };
}

function planFor(loop, previous, ctx) {
    if (loop.op !== 'until' || loop.regions.length !== 3) return null;
    const [condition, body, step] = loop.regions;
    if (condition.length < 3 || step.length !== 1) return null;
    const [read, ...rest] = condition;
    const test = rest.pop();
    const compare = rest.pop();
    if (read.op !== 'var.get' || compare.op !== 'gt' || test.op !== 'cond') return null;
    const iterator = read.args[0].sym;
    const [left, bound] = compare.args;
    if (left.ref !== read.result || test.args[0].ref !== compare.result) return null;
    if (step[0].op !== 'var.change' || step[0].args[0].sym !== iterator || step[0].args[1].lit !== 1) return null;
    if (previous?.op !== 'var.set' || previous.args[0].sym !== iterator) return null;
    const from = previous.args[1];
    if (!lookupVar(ctx.mod, ctx.target, iterator, 'var')?.internal || ctx.reads.get(iterator) !== 1) return null;
    if (deepOps([body]).some((op) => (op.op === 'var.set' || op.op === 'var.change') && op.args[0].sym === iterator)) return null;
    if (!isFiniteInteger(from, ctx.defs) || !isFiniteInteger(bound, ctx.defs)) return null;
    if (!boundIsInvariant(rest, loop, ctx)) return null;
    return { from, bound, boundOps: rest, body };
}

function rewriteRegion(region, ctx) {
    const out = [];
    for (const op of region) {
        op.regions = op.regions.map((r) => rewriteRegion(r, ctx));
        const plan = planFor(op, out.at(-1), ctx);
        if (!plan) { out.push(op); continue; }
        out.pop();
        const { ops, count } = tripCount(plan.from, plan.bound, ctx);
        out.push(...plan.boundOps, ...ops, mkOp('repeat', [count], { regions: [plan.body], ...carried(op) }));
    }
    return out;
}

export function indvars(mod) {
    const reads = readCounts(mod);
    for (const target of mod.targets) {
        const summaries = summarize(target);
        for (const root of roots({ targets: [target] })) {
            const holder = root.proc ?? root.script;
            if (root.proc?.extern) continue;
            const defs = new Map();
            walk(holder.body, (op) => { if (op.result !== null) defs.set(op.result, op); });
            const ctx = { mod, target, summaries, reads, defs, warp: !!root.proc?.warp, gen: idGenerator(holder.body) };
            holder.body = rewriteRegion(holder.body, ctx);
        }
    }
    return mod;
}
