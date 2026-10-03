export function roots(mod) {
    const out = [];
    for (const target of mod.targets) {
        for (const proc of target.procs) out.push({ target, proc, body: proc.body });
        for (const script of target.scripts) out.push({ target, script, body: script.body });
    }
    return out;
}

export function walk(region, fn, depth = 0) {
    for (const op of region) {
        fn(op, depth);
        for (const r of op.regions) walk(r, fn, depth + 1);
    }
}

export function countUses(region) {
    const uses = new Map();
    walk(region, (op) => {
        for (const a of op.args) if (a.ref !== undefined) uses.set(a.ref, (uses.get(a.ref) || 0) + 1);
    });
    return uses;
}

export function lookupVar(mod, target, name, kind) {
    const own = target.vars.find((v) => v.name === name && v.kind === kind);
    if (own) return own;
    const stage = mod.targets.find((t) => t.kind === 'stage');
    return stage?.vars.find((v) => v.name === name && v.kind === kind) ?? null;
}

export const ref = (id) => ({ ref: id });
export const lit = (v) => ({ lit: v });
export const sym = (name) => ({ sym: name });

export function mkOp(op, args, { result = null, regions = [], ...rest } = {}) {
    return { op, result, args, regions, ...rest };
}

export const carried = (op) => ({
    ...(op.nounroll && { nounroll: true }),
    ...(op.tag !== undefined && { tag: op.tag }),
});

export function idGenerator(body) {
    const used = new Set();
    walk(body, (op) => { if (op.result !== null) used.add(op.result); });
    let n = 0;
    return () => {
        let id;
        do id = `s${n++}`; while (used.has(id));
        used.add(id);
        return id;
    };
}

export function declareVar(target, kind, name) {
    if (!target.vars.some((v) => v.name === name && v.kind === kind)) target.vars.push({ kind, name, internal: true });
    return name;
}

export function freshInternal(mod, target, kind, tag) {
    const taken = new Set(mod.targets.flatMap((t) => t.vars.map((v) => v.name)));
    let n = 0;
    let name;
    do name = `_scratchpiler_internal_slvm_${tag}${n++}`; while (taken.has(name));
    return declareVar(target, kind, name);
}

export function cloneRegion(region, gen, renames = new Map()) {
    return region.map((op) => {
        const copy = {
            ...op,
            args: op.args.map((a) => (a.ref !== undefined && renames.has(a.ref) ? ref(renames.get(a.ref)) : { ...a })),
            regions: [],
        };
        if (op.keys) copy.keys = [...op.keys];
        copy.regions = op.regions.map((r) => cloneRegion(r, gen, renames));
        if (op.result !== null) {
            copy.result = gen();
            renames.set(op.result, copy.result);
        }
        return copy;
    });
}

export function endsInTerminator(region, isTerminator) {
    return region.length > 0 && isTerminator(region.at(-1));
}
