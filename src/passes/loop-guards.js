import { walk } from '../ir.js';
import { EFFECT_RANK, effectOf } from '../ops.js';
import { isStopThisScript } from './tails.js';

const NONDETERMINISTIC = new Set(['random', 'sb']);

export const isValueOp = (op) => op.result !== null && op.regions.length === 0 && EFFECT_RANK[effectOf(op)] <= EFFECT_RANK.read;

export const loopBodyIndex = (loop) => (loop.op === 'until' ? 1 : 0);

export const exitsLoop = (op, { rootTail }) => op.op === 'break' || (rootTail && isStopThisScript(op));

export function splitAtExitGuard(body, loopContext) {
    const guardIndex = body.findIndex((op) =>
        op.op === 'if' && op.regions[0].length === 1 && exitsLoop(op.regions[0][0], loopContext) && !op.regions[1]?.length);
    if (guardIndex < 0) return null;
    let valuesStart = guardIndex;
    while (valuesStart > 0 && isValueOp(body[valuesStart - 1])) valuesStart--;
    return {
        before: body.slice(0, valuesStart),
        values: body.slice(valuesStart, guardIndex),
        guard: body[guardIndex],
        after: body.slice(guardIndex + 1),
    };
}

export function dependencySlice(operands, values) {
    const byResult = new Map(values.map((op) => [op.result, op]));
    const needed = new Set();
    const visit = (operand) => {
        const definition = operand.ref === undefined ? undefined : byResult.get(operand.ref);
        if (!definition || needed.has(definition)) return;
        needed.add(definition);
        definition.args.forEach(visit);
    };
    operands.forEach(visit);
    return values.filter((op) => needed.has(op));
}

export function definedIn(region) {
    const results = new Set();
    walk(region, (op) => { if (op.result !== null) results.add(op.result); });
    return results;
}

export function usesAnyOf(region, results) {
    let used = false;
    walk(region, (op) => { if (op.args.some((a) => a.ref !== undefined && results.has(a.ref))) used = true; });
    return used;
}

export function repeatsSafely(slice, laterRegions) {
    const unrepeatable = new Set(slice.filter((op) => NONDETERMINISTIC.has(op.op)).map((op) => op.result));
    return !laterRegions.some((region) => usesAnyOf(region, unrepeatable));
}

export function remapOperands(region, renames) {
    walk(region, (op) => { op.args = op.args.map((a) => (a.ref !== undefined && renames.has(a.ref) ? { ref: renames.get(a.ref) } : a)); });
}
