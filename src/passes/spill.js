import { roots, idGenerator, freshInternal, declareVar, mkOp, ref, sym, lookupVar, cloneRegion } from '../ir.js';
import { OPS, effectOf } from '../ops.js';
import { ANYTHING, WORLD, LOOP_OPS, directReads, writesOf, yieldsAt, summarize } from './effects.js';

export class LegalizeError extends Error {}

export const SPILL_STACK = '_scratchpiler_internal_slvm_stack';

function locate(body) {
    const where = new Map();
    const uses = new Map();
    const defs = new Map();
    const order = [];
    const visit = (region, owner, regionIndex) => {
        region.forEach((op, index) => {
            where.set(op, { region, index, owner, regionIndex });
            order.push(op);
            if (op.result !== null) defs.set(op.result, op);
            op.args.forEach((a, argIndex) => {
                if (a.ref === undefined) return;
                if (!uses.has(a.ref)) uses.set(a.ref, []);
                uses.get(a.ref).push({ op, argIndex });
            });
            op.regions.forEach((r, ri) => visit(r, op, ri));
        });
    };
    visit(body, null, null);
    return { where, uses, defs, order };
}

function intervalOps(def, point, where) {
    const chain = [];
    for (let op = point; op; op = where.get(op).owner) chain.push(op);
    const home = where.get(def).region;
    const top = chain.findIndex((op) => where.get(op).region === home);
    const ops = home.slice(where.get(def).index + 1, where.get(chain[top]).index);
    let backEdge = null;
    for (let i = top; i > 0; i--) {
        const outer = chain[i];
        const inner = chain[i - 1];
        if (LOOP_OPS.has(outer.op)) {
            ops.push(...outer.regions.flat());
            backEdge = outer;
            break;
        }
        const w = where.get(inner);
        ops.push(...w.region.slice(0, w.index));
    }
    return { ops, backEdge };
}

function deep(ops, fn) {
    for (const op of ops) {
        fn(op);
        for (const r of op.regions) deep(r, fn);
    }
}

function isVolatile(key, ctx) {
    if (key === ANYTHING || key === WORLD) return true;
    const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    return !lookupVar(ctx.mod, ctx.target, name, kind)?.internal;
}

function clobbered(def, point, where, ctx) {
    const reads = directReads(def);
    if (!reads.length) return false;
    const volatile = reads.some((k) => isVolatile(k, ctx));
    const { ops, backEdge } = intervalOps(def, point, where);
    if (backEdge && volatile && yieldsAt(backEdge, ctx)) return true;
    let hit = false;
    deep(ops, (op) => {
        if (hit) return;
        const writes = writesOf(op, ctx.summaries);
        if (writes.length && (reads.includes(ANYTHING) || writes.includes(ANYTHING) || writes.some((w) => reads.includes(w)))) hit = true;
        else if (volatile && yieldsAt(op, ctx)) hit = true;
    });
    return hit;
}

function reachesSelf(def, point, where, ctx) {
    if (!ctx.proc) return false;
    const { ops } = intervalOps(def, point, where);
    let hit = false;
    deep(ops, (op) => {
        if (op.op !== 'call') return;
        const writes = writesOf(op, ctx.summaries);
        if (writes.includes(`proc:${ctx.proc.name}`) || writes.includes(ANYTHING)) hit = true;
    });
    return hit;
}

const REMAT_LIMIT = 8;

function pureTree(op, defs) {
    const tree = [];
    const visit = (o) => {
        if (effectOf(o) !== 'pure' || tree.length >= REMAT_LIMIT) return false;
        for (const a of o.args) if (a.ref !== undefined && !visit(defs.get(a.ref))) return false;
        tree.push(o);
        return true;
    };
    return visit(op) ? tree : null;
}

function rereadable(op, opUses, uses, where, ctx) {
    if (!directReads(op).length || op.args.some((a) => a.ref !== undefined)) return false;
    return opUses.every(({ op: user }) => {
        const point = evalPoint(user, uses) ?? user;
        return !clobbered(op, point, where, ctx);
    });
}

function evalPoint(op, uses) {
    let current = op;
    while (current.result !== null) {
        const u = uses.get(current.result) ?? [];
        if (u.length !== 1) return u.length === 0 ? null : current;
        current = u[0].op;
    }
    return current;
}

export function findHazard(body, ctx) {
    const { where, uses, defs, order } = locate(body);
    for (const op of order) {
        if (op.result === null) continue;
        const u = uses.get(op.result) ?? [];
        if (u.length > 1) {
            const tree = pureTree(op, defs) ?? (rereadable(op, u, uses, where, ctx) ? [op] : null);
            return tree ? { kind: 'remat', op, tree, where, uses } : { kind: 'spill', op, where, uses };
        }
    }
    for (const op of order) {
        if (op.result === null || (uses.get(op.result) ?? []).length !== 1) continue;
        const point = evalPoint(op, uses);
        if (point === null || !clobbered(op, point, where, ctx)) continue;
        const consumer = uses.get(op.result)[0].op;
        if (consumer.result !== null && !clobbered(op, consumer, where, ctx)) return { kind: 'spill', op: consumer, where, uses, point };
        return { kind: 'spill', op, where, uses, point };
    }
    return null;
}

function remat(hazard, gen) {
    const { op, tree, where, uses } = hazard;
    for (const { op: user, argIndex } of uses.get(op.result).slice(1)) {
        const copy = cloneRegion(tree.map((o) => ({ ...o, regions: [] })), gen);
        const region = where.get(user).region;
        region.splice(region.indexOf(user), 0, ...copy);
        user.args[argIndex] = ref(copy.at(-1).result);
    }
}

function spillValue(hazard, ctx) {
    const { op, where, uses } = hazard;
    const { mod, target, gen } = ctx;
    const users = uses.get(op.result);
    const stack = users.some((u) => reachesSelf(op, u.op, where, ctx));
    const tmp = freshInternal(mod, target, 'var', 'spill');
    const home = where.get(op).region;
    const regionOf = (user) => where.get(user).region;

    if (!stack) {
        home.splice(home.indexOf(op) + 1, 0, mkOp('var.set', [sym(tmp), ref(op.result)]));
        for (const { op: user, argIndex } of users) {
            const r = gen();
            const region = regionOf(user);
            region.splice(region.indexOf(user), 0, mkOp('var.get', [sym(tmp)], { result: r }));
            user.args[argIndex] = ref(r);
        }
        return;
    }

    if (users.length > 1) {
        throw new LegalizeError(`proc @${ctx.proc.name}: %${op.result} is used ${users.length} times across a recursive call; bind it to a variable in the source`);
    }
    const [{ op: user, argIndex }] = users;
    const userWhere = where.get(user);
    if (userWhere.owner && OPS[userWhere.owner.op].condRegion === userWhere.regionIndex) {
        throw new LegalizeError(`proc @${ctx.proc.name}: %${op.result} is read in a loop condition after a recursive call; this needs a stack peek, which spill does not do yet`);
    }
    declareVar(target, 'list', SPILL_STACK);
    const stk = sym(SPILL_STACK);
    const pop = () => {
        const len = gen();
        return [mkOp('list.len', [stk], { result: len }), mkOp('list.del', [stk, ref(len)])];
    };

    const { ops } = intervalOps(op, user, where);
    const exits = [];
    deep(ops, (o) => { if (o.op === 'stop' && o.args[0].lit === 'this script') exits.push(o); });
    for (const exit of exits) {
        const region = where.get(exit).region;
        region.splice(region.indexOf(exit), 0, ...pop());
    }

    home.splice(home.indexOf(op) + 1, 0, mkOp('list.add', [stk, ref(op.result)]));
    const top = gen();
    const item = gen();
    const r = gen();
    const region = regionOf(user);
    region.splice(region.indexOf(user), 0,
        mkOp('list.len', [stk], { result: top }),
        mkOp('list.get', [stk, ref(top)], { result: item }),
        mkOp('var.set', [sym(tmp), ref(item)]),
        ...pop(),
        mkOp('var.get', [sym(tmp)], { result: r }));
    user.args[argIndex] = ref(r);
}

export function rootContext(mod, root, summaries) {
    const holder = root.proc ?? root.script;
    return {
        mod,
        target: root.target,
        proc: root.proc ?? null,
        warp: !!root.proc?.warp,
        summaries: summaries ?? summarize(root.target),
        gen: idGenerator(holder.body),
    };
}

const MAX_ROUNDS = 10000;

export function spill(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        for (let round = 0; ; round++) {
            if (round > MAX_ROUNDS) throw new LegalizeError('spill did not converge');
            const ctx = rootContext(mod, root);
            const hazard = findHazard(holder.body, ctx);
            if (!hazard) break;
            if (hazard.kind === 'remat') remat(hazard, ctx.gen);
            else spillValue(hazard, ctx);
        }
    }
    return mod;
}
