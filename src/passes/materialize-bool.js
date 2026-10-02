import { roots, idGenerator, mkOp, ref, lit } from '../ir.js';
import { OPS } from '../ops.js';

function materializeRegion(region, gen) {
    const out = [];
    for (const op of region) {
        op.regions = op.regions.map((r) => materializeRegion(r, gen));
        for (const i of OPS[op.op].boolArgs || []) {
            const a = op.args[i];
            if (typeof a?.lit !== 'boolean') continue;
            const id = gen();
            out.push(mkOp('eq', [lit('1'), lit(a.lit ? '1' : '0')], { result: id }));
            op.args[i] = ref(id);
        }
        out.push(op);
    }
    return out;
}

export function materializeBool(mod) {
    for (const root of roots(mod)) {
        const holder = root.proc ?? root.script;
        holder.body = materializeRegion(holder.body, idGenerator(holder.body));
    }
    return mod;
}
