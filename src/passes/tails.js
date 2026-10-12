import { roots } from '../ir.js';
import { OPS } from '../ops.js';

export const isReturn = (op) => op.op === 'ret';
export const isContinue = (op) => op.op === 'continue';
export const isStopThisScript = (op) => op.op === 'stop' && op.args[0].lit === 'this script';
export const isRootExit = (op) => isReturn(op) || isStopThisScript(op);
const isValuelessRootExit = (op) => isStopThisScript(op) || (isReturn(op) && op.args.length === 0);

export const endsInExit = (region, isExit) => {
    const last = region.at(-1);
    return last !== undefined && (isExit(last) || (last.op === 'if' && last.regions.length === 2 && last.regions.every((arm) => endsInExit(arm, isExit))));
};

export function foldExitsIntoTails(region, isExit) {
    for (const op of region) if (op.op === 'if') op.regions = op.regions.map((arm) => foldExitsIntoTails(arm, isExit));
    for (let i = 0; i < region.length - 1; i++) {
        const op = region[i];
        if (op.op !== 'if') continue;
        const arms = op.regions.length === 2 ? op.regions : [op.regions[0], []];
        const exiting = arms.map((arm) => endsInExit(arm, isExit));
        if (!exiting.some(Boolean)) continue;
        if (!exiting.every(Boolean)) {
            const falling = exiting[0] ? 1 : 0;
            arms[falling] = foldExitsIntoTails([...arms[falling], ...region.slice(i + 1)], isExit);
        }
        op.regions = arms;
        return region.slice(0, i + 1);
    }
    return region;
}

export function dropTailExits(region, isRedundant) {
    const last = region.at(-1);
    if (last === undefined) return region;
    if (isRedundant(last)) return region.slice(0, -1);
    if (last.op === 'if') last.regions = last.regions.map((arm) => dropTailExits(arm, isRedundant));
    return region;
}

const withoutTailExits = (region, isExit, isRedundant) => dropTailExits(foldExitsIntoTails(region, isExit), isRedundant);

function foldLoopBodies(region) {
    for (const op of region) {
        op.regions = op.regions.map(foldLoopBodies);
        if (!OPS[op.op].loop) continue;
        const bodyIndex = op.op === 'until' ? 1 : 0;
        op.regions[bodyIndex] = withoutTailExits(op.regions[bodyIndex], isContinue, isContinue);
    }
    return region;
}

export function foldTails(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = withoutTailExits(foldLoopBodies(holder.body), isRootExit, isValuelessRootExit);
    }
    return mod;
}
