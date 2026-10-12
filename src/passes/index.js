import { constfold } from './constfold.js';
import { dce } from './dce.js';
import { inline } from './inline.js';
import { unroll } from './unroll.js';
import { indvars } from './indvars.js';
import { dse } from './dse.js';
import { foldTails } from './tails.js';
import { fuseBreaks } from './fuse-breaks.js';
import { rotateLoops } from './rotate-loops.js';
import { swapArms, invertGuards } from './invert-ifs.js';
import { deadVars } from './dead-vars.js';
import { lowerRet } from './lower-ret.js';
import { lowerBreak } from './lower-break.js';
import { rotateCond } from './rotate-cond.js';
import { materializeBool } from './materialize-bool.js';
import { spill } from './spill.js';
import { verify } from '../verify.js';
import { print } from '../text.js';

export class VerificationError extends Error {}

export const PASSES = {
    inline,
    indvars,
    unroll,
    dse,
    'fold-tails': foldTails,
    'fuse-breaks': fuseBreaks,
    'rotate-loops': rotateLoops,
    'swap-arms': swapArms,
    'invert-guards': invertGuards,
    'dead-vars': deadVars,
    constfold,
    dce,
    'lower-ret': lowerRet,
    'lower-break': lowerBreak,
    'rotate-cond': rotateCond,
    'materialize-bool': materializeBool,
    spill,
};

export const ALIASES = {
    legalize: ['lower-ret', 'lower-break', 'rotate-cond', 'materialize-bool', 'spill'],
    O1: ['inline', 'constfold', 'indvars', 'unroll', 'constfold', 'dse', 'constfold', 'dce', 'legalize'],
    O2: ['fold-tails', 'constfold', 'inline', 'constfold', 'fold-tails', 'indvars', 'unroll', 'constfold', 'dse', 'constfold', 'dce', 'fuse-breaks', 'swap-arms', 'constfold', 'dce', 'legalize'],
    O3: ['fold-tails', 'constfold', 'inline', 'constfold', 'fold-tails', 'indvars', 'unroll', 'constfold', 'dse', 'constfold', 'dce', 'fuse-breaks', 'rotate-loops', 'swap-arms', 'invert-guards', 'constfold', 'dce', 'legalize'],
};

export const expandPipeline = (names) => names.flatMap((n) => (ALIASES[n] ? expandPipeline(ALIASES[n]) : [n]));

export function runPipeline(mod, names, { verifyEach = true, printAfterAll = null } = {}) {
    for (const name of expandPipeline(names)) {
        const pass = PASSES[name];
        if (!pass) throw new Error(`unknown pass \`${name}\` (known: ${[...Object.keys(PASSES), ...Object.keys(ALIASES)].join(', ')})`);
        pass(mod);
        if (printAfterAll) printAfterAll(`; *** IR after ${name} ***\n${print(mod)}`);
        if (verifyEach) {
            const errors = verify(mod);
            if (errors.length) throw new VerificationError(`IR invalid after ${name}:\n  ${errors.join('\n  ')}`);
        }
    }
    return mod;
}
