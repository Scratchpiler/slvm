import { walk, idGenerator, cloneRegion, lookupVar, lit } from '../ir.js';
import { OPS, isTerminator } from '../ops.js';
import { toNumber } from '../cast.js';

export const UNROLL_MAX_TRIPS = 16;
export const UNROLL_BUDGET = 40;

const sizeOf = (region) => {
    let size = 0;
    walk(region, () => size++);
    return size;
};

const leavesLoop = (region) => region.some((op) =>
    op.op === 'break' || op.op === 'continue' || (!OPS[op.op].loop && op.regions.some(leavesLoop)));

const writesVariable = (region, name) => {
    let written = false;
    walk(region, (op) => {
        if ((op.op === 'var.set' || op.op === 'var.change') && op.args[0].sym === name) written = true;
    });
    return written;
};

const isInteger = (operand) => typeof operand.lit === 'number' && Number.isInteger(operand.lit);

const INTERFERING_OPS = new Set(['sb', 'call', 'broadcast', 'broadcast.wait', 'wait', 'wait.until', 'stop', 'var.show', 'var.hide', 'list.show', 'list.hide']);

function touchesOnlyConfinedState(region, ctx) {
    let isolated = true;
    walk(region, (op) => {
        if (!isolated) return;
        if (INTERFERING_OPS.has(op.op)) isolated = false;
        const kind = OPS[op.op].operands?.[0];
        if ((kind === 'var' || kind === 'list') && !lookupVar(ctx.mod, ctx.target, op.args[0].sym, kind)?.confined) isolated = false;
    });
    return isolated;
}

function repeatPlan(op) {
    const [count] = op.args;
    if (op.op !== 'repeat' || count.lit === undefined) return null;
    return { trips: Math.max(0, Math.round(toNumber(count.lit))), body: op.regions[0] };
}

function countedForPlan(op, previous, ctx) {
    if (op.op !== 'until' || op.regions.length !== 3) return null;
    const [condition, body, step] = op.regions;
    if (condition.length !== 3) return null;
    const [read, compare, test] = condition;
    if (read.op !== 'var.get' || compare.op !== 'gt' || test.op !== 'cond') return null;
    const iterator = read.args[0].sym;
    const [left, end] = compare.args;
    if (left.ref !== read.result || !isInteger(end) || test.args[0].ref !== compare.result) return null;
    if (step.length !== 1 || step[0].op !== 'var.change' || step[0].args[0].sym !== iterator || step[0].args[1].lit !== 1) return null;
    if (previous?.op !== 'var.set' || previous.args[0].sym !== iterator || !isInteger(previous.args[1])) return null;
    const iteratorDecl = lookupVar(ctx.mod, ctx.target, iterator, 'var');
    if (!iteratorDecl?.internal || (!ctx.warp && !iteratorDecl.confined) || writesVariable(body, iterator)) return null;
    const start = previous.args[1].lit;
    return { trips: Math.max(0, end.lit - start + 1), body, iterator, start, dropsInitialization: true };
}

function planFor(op, previous, ctx) {
    if (op.nounroll || !OPS[op.op].unrollable) return null;
    const plan = repeatPlan(op) ?? countedForPlan(op, previous, ctx);
    if (!plan || plan.trips > UNROLL_MAX_TRIPS) return null;
    if (plan.trips === 0 || plan.body.length === 0) return plan;
    if (leavesLoop(plan.body) || isTerminator(plan.body.at(-1))) return null;
    if (!ctx.warp && !touchesOnlyConfinedState(plan.body, ctx)) return null;
    return plan.trips * sizeOf(plan.body) <= UNROLL_BUDGET ? plan : null;
}

function withIteratorValue(region, iterator, value) {
    const values = new Map();
    const strip = (ops) => ops.flatMap((op) => {
        op.regions = op.regions.map(strip);
        if (op.op !== 'var.get' || op.args[0].sym !== iterator) return [op];
        values.set(op.result, lit(value));
        return [];
    });
    const stripped = strip(region);
    walk(stripped, (op) => { op.args = op.args.map((a) => (a.ref !== undefined && values.has(a.ref) ? values.get(a.ref) : a)); });
    return stripped;
}

function copiesOf(plan, gen) {
    if (plan.body.length === 0) return [];
    return Array.from({ length: plan.trips }, (_, trip) => {
        const copy = cloneRegion(plan.body, gen);
        return plan.iterator ? withIteratorValue(copy, plan.iterator, plan.start + trip) : copy;
    }).flat();
}

function unrollRegion(region, ctx) {
    const out = [];
    for (const op of region) {
        op.regions = op.regions.map((nested) => unrollRegion(nested, ctx));
        const plan = planFor(op, out.at(-1), ctx);
        if (!plan) { out.push(op); continue; }
        if (plan.dropsInitialization) out.pop();
        out.push(...copiesOf(plan, ctx.gen));
    }
    return out;
}

export function unroll(mod) {
    for (const target of mod.targets) {
        for (const proc of target.procs) {
            if (proc.extern || (!proc.warp && !proc.uninterrupted)) continue;
            proc.body = unrollRegion(proc.body, { mod, target, warp: !!proc.warp, gen: idGenerator(proc.body) });
        }
        for (const script of target.scripts) {
            if (!script.uninterrupted) continue;
            script.body = unrollRegion(script.body, { mod, target, warp: false, gen: idGenerator(script.body) });
        }
    }
    return mod;
}
