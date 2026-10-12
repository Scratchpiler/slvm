import { walk, idGenerator, cloneRegion, mkOp, ref, carried } from '../ir.js';
import { OPS, isTerminator } from '../ops.js';
import { definedIn, dependencySlice, remapOperands, repeatsSafely, splitAtExitGuard, usesAnyOf } from './loop-guards.js';
import { summarize } from './effects.js';
import { touchesOnlyConfinedState } from './unroll.js';

export const ROTATE_BUDGET = 6;

const sizeOf = (region) => {
    let size = 0;
    walk(region, () => size++);
    return size;
};

const leavesThisLoop = (region) => region.some((op) =>
    op.op === 'continue' || op.op === 'break' || (!OPS[op.op].loop && op.regions.some(leavesThisLoop)));

const hasContinue = (region) => region.some((op) =>
    op.op === 'continue' || (!OPS[op.op].loop && op.regions.some(hasContinue)));

function isolated(loop, ctx) {
    return ctx.warp || touchesOnlyConfinedState(loop.regions[0], ctx);
}

function rotate(loop, ctx) {
    if (loop.op !== 'forever') return null;
    const split = splitAtExitGuard(loop.regions[0], { rootTail: false });
    if (!split || !split.before.length) return null;
    const { before, values, guard, after } = split;
    if (sizeOf(before) > ROTATE_BUDGET || leavesThisLoop(before) || hasContinue(after) || (after.length && isTerminator(after.at(-1)))) return null;
    if (!isolated(loop, ctx)) return null;

    const [exitCondition] = guard.args;
    const slice = dependencySlice([exitCondition], values);
    const fromBefore = definedIn(before);
    if (fromBefore.has(exitCondition.ref) || usesAnyOf(values, fromBefore) || usesAnyOf(after, fromBefore)) return null;
    if (!repeatsSafely(values, [after])) return null;

    const { gen } = ctx;
    const peeled = cloneRegion(before, gen);
    const renames = new Map();
    const exitCopies = cloneRegion(slice, gen, renames);
    const exitNow = exitCondition.ref === undefined ? exitCondition : ref(renames.get(exitCondition.ref));

    const valueRenames = new Map();
    const valueCopies = cloneRegion(values, gen, valueRenames);
    remapOperands(after, valueRenames);

    const body = [...valueCopies, ...after, ...before];
    return [...peeled, mkOp('until', [], { regions: [[...exitCopies, mkOp('cond', [exitNow])], body], ...carried(loop) })];
}

function rotateRegion(region, ctx) {
    return region.flatMap((op) => {
        op.regions = op.regions.map((nested) => rotateRegion(nested, ctx));
        return rotate(op, ctx) ?? [op];
    });
}

export function rotateLoops(mod) {
    for (const target of mod.targets) {
        const summaries = summarize(target);
        for (const proc of target.procs) {
            if (proc.extern || (!proc.warp && !proc.uninterrupted)) continue;
            proc.body = rotateRegion(proc.body, { mod, target, summaries, warp: !!proc.warp, gen: idGenerator(proc.body) });
        }
        for (const script of target.scripts) {
            if (!script.uninterrupted) continue;
            script.body = rotateRegion(script.body, { mod, target, summaries, warp: false, gen: idGenerator(script.body) });
        }
    }
    return mod;
}
