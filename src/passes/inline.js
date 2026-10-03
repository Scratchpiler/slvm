import { walk, idGenerator, cloneRegion, freshInternal, mkOp, ref, lit, sym } from '../ir.js';
import { OPS, typeOf } from '../ops.js';
import { summarize, yieldsAt } from './effects.js';

export const INLINE_LIMIT = 24;

const STOPS_THAT_LEAVE_THE_CALLER_ALONE = new Set(['other scripts in sprite']);

const sizeOf = (body) => {
    let size = 0;
    walk(body, () => size++);
    return size;
};

const endsReturning = (region) => {
    const last = region.at(-1);
    return last?.op === 'ret' || (last?.op === 'if' && last.regions.length === 2 && last.regions.every(endsReturning));
};

function foldReturnsIntoTails(region) {
    for (const op of region) if (op.op === 'if') op.regions = op.regions.map(foldReturnsIntoTails);
    for (let i = 0; i < region.length - 1; i++) {
        const op = region[i];
        if (op.op !== 'if') continue;
        const arms = op.regions.length === 2 ? op.regions : [op.regions[0], []];
        const returning = arms.map(endsReturning);
        if (!returning.some(Boolean)) continue;
        if (!returning.every(Boolean)) {
            const falling = returning[0] ? 1 : 0;
            arms[falling] = foldReturnsIntoTails([...arms[falling], ...region.slice(i + 1)]);
        }
        op.regions = arms;
        return region.slice(0, i + 1);
    }
    return region;
}

const returnsAreInTailPosition = (region, tail) => region.every((op, i) => {
    const isTail = tail && i === region.length - 1;
    if (op.op === 'ret') return isTail;
    if (op.op === 'if') return op.regions.every((arm) => returnsAreInTailPosition(arm, isTail));
    return op.regions.every((arm) => returnsAreInTailPosition(arm, false));
});

const everyReturnHasValue = (region) => {
    let all = true;
    walk(region, (op) => { if (op.op === 'ret' && op.args.length === 0) all = false; });
    return all;
};

const hasReturn = (region) => {
    let found = false;
    walk(region, (op) => { if (op.op === 'ret') found = true; });
    return found;
};

function replaceReturns(region, assign) {
    return region.flatMap((op) => {
        if (op.op === 'ret') return assign(op.args[0]);
        if (op.op === 'if') op.regions = op.regions.map((arm) => replaceReturns(arm, assign));
        return [op];
    });
}

function postorder(procs, summaries) {
    const order = [];
    const visited = new Set();
    const visit = (proc) => {
        if (visited.has(proc.name)) return;
        visited.add(proc.name);
        for (const name of summaries.get(proc.name).callees) {
            const callee = procs.find((p) => p.name === name);
            if (callee) visit(callee);
        }
        order.push(proc);
    };
    procs.forEach(visit);
    return order;
}

function canInlineAnywhere(callee, ctx) {
    if (callee.extern || callee.noinline) return false;
    if (ctx.summaries.get(callee.name).reaches.has(callee.name)) return false;
    if (sizeOf(callee.body) > INLINE_LIMIT) return false;
    let returnsToCaller = true;
    walk(callee.body, (op) => {
        if (op.op === 'forever') returnsToCaller = false;
        if (op.op === 'stop' && !STOPS_THAT_LEAVE_THE_CALLER_ALONE.has(op.args[0].lit)) returnsToCaller = false;
    });
    return returnsToCaller;
}

function keepsAtomicity(callee, ctx) {
    if (!callee.warp || ctx.warp) return true;
    let atomic = true;
    walk(callee.body, (op) => {
        if (yieldsAt(op, { warp: false, summaries: ctx.summaries })) atomic = false;
    });
    return atomic;
}

function expand(call, callee, ctx) {
    const { mod, target, gen, defs } = ctx;
    const wantsResult = call.result !== null;
    let body = foldReturnsIntoTails(cloneRegion(callee.body, gen));
    if (!returnsAreInTailPosition(body, true)) return null;
    if (wantsResult && !(endsReturning(body) && everyReturnHasValue(body))) return null;

    const operands = new Map(callee.params.map((name, i) => [name, call.args[i]]));
    const isBool = (operand) => operand.ref !== undefined && defs.has(operand.ref) && typeOf(defs.get(operand.ref)) === 'bool';
    const asText = (operand) => (typeof operand.lit === 'boolean' ? lit(String(operand.lit)) : operand);
    const bind = (region) => region.flatMap((op) => {
        op.regions = op.regions.map(bind);
        if (op.op !== 'arg' && op.op !== 'arg.b') return [op];
        const operand = operands.get(op.args[0].name);
        if (op.op === 'arg') ctx.env.set(op.result, asText(operand));
        else if (isBool(operand)) ctx.env.set(op.result, operand);
        else return [{ ...op, op: 'truthy', args: [operand] }];
        return [];
    });
    body = bind(body);

    let result = null;
    const last = body.at(-1);
    if (last?.op === 'ret') {
        body = body.slice(0, -1);
        result = last.args[0] ?? null;
    } else if (hasReturn(body)) {
        const temp = freshInternal(mod, target, 'var', 'inl');
        body = replaceReturns(body, (value) => (wantsResult ? [mkOp('var.set', [sym(temp), value])] : []));
        if (wantsResult) {
            const id = gen();
            body.push(mkOp('var.get', [sym(temp)], { result: id }));
            result = ref(id);
        }
    }
    if (wantsResult) ctx.env.set(call.result, result);
    walk(body, (op) => { if (op.result !== null) defs.set(op.result, op); });
    return body;
}

function tryInline(call, ctx) {
    const callee = ctx.target.procs.find((proc) => proc.name === call.callee);
    if (!callee) return null;
    if (!ctx.eligible.has(callee)) ctx.eligible.set(callee, canInlineAnywhere(callee, ctx));
    if (!ctx.eligible.get(callee)) return null;
    if (ctx.summaries.get(callee.name).reaches.has(ctx.caller?.name)) return null;
    if (!keepsAtomicity(callee, ctx)) return null;
    return expand(call, callee, ctx);
}

function inlineRegion(region, ctx, inCondition) {
    return region.flatMap((op) => {
        const spec = OPS[op.op];
        op.regions = op.regions.map((r, i) => inlineRegion(r, ctx, inCondition || spec.condRegion === i));
        return (op.op === 'call' && !inCondition && tryInline(op, ctx)) || [op];
    });
}

function substitute(region, env) {
    const resolve = (operand) => {
        let current = operand;
        while (current.ref !== undefined && env.has(current.ref)) current = env.get(current.ref);
        return current;
    };
    walk(region, (op) => { op.args = op.args.map(resolve); });
}

function rewriteRoot(holder, caller, ctx) {
    const defs = new Map();
    walk(holder.body, (op) => { if (op.result !== null) defs.set(op.result, op); });
    const env = new Map();
    const local = { ...ctx, caller, warp: !!caller?.warp, gen: idGenerator(holder.body), defs, env };
    holder.body = inlineRegion(holder.body, local, false);
    if (env.size) substitute(holder.body, env);
}

export function inline(mod) {
    for (const target of mod.targets) {
        const ctx = { mod, target, summaries: summarize(target), eligible: new Map() };
        for (const proc of postorder(target.procs, ctx.summaries)) {
            if (!proc.extern) rewriteRoot(proc, proc, ctx);
        }
        for (const script of target.scripts) rewriteRoot(script, null, ctx);
    }
    return mod;
}
