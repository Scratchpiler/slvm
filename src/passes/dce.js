import { roots, countUses } from '../ir.js';
import { isRemovableIfUnused } from '../ops.js';
import { summarize, isDiscardable } from './effects.js';

function sweep(region, uses, ctx) {
    let changed = false;
    const kept = [];
    for (const op of region) {
        const unused = op.result === null || !uses.get(op.result);
        if (unused && (isRemovableIfUnused(op) || (op.op === 'call' && isDiscardable(op, ctx)))) {
            changed = true;
            continue;
        }
        op.regions = op.regions.map((r) => {
            const res = sweep(r, uses, ctx);
            changed ||= res.changed;
            return res.region;
        });
        kept.push(op);
    }
    return { region: kept, changed };
}

export function dce(mod) {
    const summaries = new Map(mod.targets.map((target) => [target, summarize(target)]));
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        const ctx = { warp: !!root.proc?.warp, summaries: summaries.get(root.target) };
        let changed = true;
        while (changed) {
            ({ region: holder.body, changed } = sweep(holder.body, countUses(holder.body), ctx));
        }
    }
    return mod;
}
