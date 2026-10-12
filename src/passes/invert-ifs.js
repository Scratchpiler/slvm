import { roots, walk, countUses } from '../ir.js';

function invertRegion(region, defs, uses, shouldInvert) {
    for (const op of region) {
        op.regions = op.regions.map((nested) => invertRegion(nested, defs, uses, shouldInvert));
        if (op.op !== 'if') continue;
        const [condition] = op.args;
        const negation = condition.ref === undefined ? undefined : defs.get(condition.ref);
        if (negation?.op !== 'not' || uses.get(negation.result) !== 1 || !shouldInvert(op)) continue;
        op.args = [negation.args[0]];
        op.regions = op.regions.length === 2 ? [op.regions[1], op.regions[0]] : [[], op.regions[0]];
    }
    return region;
}

function invertIfs(mod, shouldInvert) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        const defs = new Map();
        walk(holder.body, (op) => { if (op.result !== null) defs.set(op.result, op); });
        invertRegion(holder.body, defs, countUses(holder.body), shouldInvert);
    }
    return mod;
}

export const swapArms = (mod) => invertIfs(mod, (op) => op.regions.length === 2);

export const invertGuards = (mod) => invertIfs(mod, (op) => op.regions.length === 1);
