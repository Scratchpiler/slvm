import { roots, idGenerator, cloneRegion, mkOp, ref, carried } from '../ir.js';
import { dependencySlice, loopBodyIndex, repeatsSafely, splitAtExitGuard } from './loop-guards.js';

const FUSIBLE_LOOPS = new Set(['forever', 'until']);

function fuseOnce(loop, rootTail, gen) {
    const bodyIndex = loopBodyIndex(loop);
    const split = splitAtExitGuard(loop.regions[bodyIndex], { rootTail });
    if (!split || split.before.length) return null;
    const { values, guard, after } = split;
    const [exitCondition] = guard.args;
    const slice = dependencySlice([exitCondition], values);
    if (!repeatsSafely(slice, [after])) return null;

    const renames = new Map();
    const copies = cloneRegion(slice, gen, renames);
    const exitNow = exitCondition.ref === undefined ? exitCondition : ref(renames.get(exitCondition.ref));
    const conditionOps = loop.op === 'until' ? loop.regions[0].slice(0, -1) : [];
    const keepLooping = loop.op === 'until' ? loop.regions[0].at(-1).args[0] : null;

    let finalOperand = exitNow;
    if (keepLooping !== null) {
        const either = gen();
        copies.push(mkOp('or', [keepLooping, exitNow], { result: either }));
        finalOperand = ref(either);
    }
    const condition = [...conditionOps, ...copies, mkOp('cond', [finalOperand])];
    const body = [...values, ...after];
    if (loop.op === 'until') {
        loop.regions[0] = condition;
        loop.regions[1] = body;
        return loop;
    }
    return mkOp('until', [], { regions: [condition, body], ...carried(loop) });
}

function fuseRegion(region, rootTail, gen) {
    return region.map((op, index) => {
        op.regions = op.regions.map((nested) => fuseRegion(nested, false, gen));
        if (!FUSIBLE_LOOPS.has(op.op)) return op;
        let current = op;
        const tailOfRoot = rootTail && index === region.length - 1;
        for (let fused = fuseOnce(current, tailOfRoot, gen); fused; fused = fuseOnce(current, tailOfRoot, gen)) current = fused;
        return current;
    });
}

export function fuseBreaks(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = fuseRegion(holder.body, true, idGenerator(holder.body));
    }
    return mod;
}
