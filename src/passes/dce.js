import { roots, countUses } from '../ir.js';
import { isRemovableIfUnused } from '../ops.js';

function sweep(region, uses) {
    let changed = false;
    const kept = [];
    for (const op of region) {
        if (isRemovableIfUnused(op) && !uses.get(op.result)) {
            changed = true;
            continue;
        }
        op.regions = op.regions.map((r) => {
            const res = sweep(r, uses);
            changed ||= res.changed;
            return res.region;
        });
        kept.push(op);
    }
    return { region: kept, changed };
}

export function dce(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        let changed = true;
        while (changed) {
            ({ region: holder.body, changed } = sweep(holder.body, countUses(holder.body)));
        }
    }
    return mod;
}
