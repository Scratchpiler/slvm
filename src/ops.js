import { MATH_FUNCTIONS } from './cast.js';

export const EFFECT_RANK = { pure: 0, read: 1, write: 2, yield: 3 };

const pure = (type, arity) => ({ effect: 'pure', type, arity });
const read = (type, arity) => ({ effect: 'read', type, arity });
const write = (arity) => ({ effect: 'write', type: null, arity });

export const OPS = {
    add: pure('val', 2),
    sub: pure('val', 2),
    mul: pure('val', 2),
    div: pure('val', 2),
    mod: pure('val', 2),
    round: pure('val', 1),
    ...Object.fromEntries(MATH_FUNCTIONS.map((f) => [`math.${f}`, pure('val', 1)])),
    lt: pure('bool', 2),
    gt: pure('bool', 2),
    eq: pure('bool', 2),
    and: { ...pure('bool', 2), boolArgs: [0, 1] },
    or: { ...pure('bool', 2), boolArgs: [0, 1] },
    not: { ...pure('bool', 1), boolArgs: [0] },
    join: pure('val', 2),
    letter: pure('val', 2),
    length: pure('val', 1),
    contains: pure('bool', 2),
    random: read('val', 2),

    arg: { ...pure('val', 1), operands: ['name'] },
    'arg.b': { ...pure('bool', 1), operands: ['name'] },

    'var.get': { ...read('val', 1), operands: ['var'] },
    'var.set': { ...write(2), operands: ['var'] },
    'var.change': { ...write(2), operands: ['var'] },
    'list.get': { ...read('val', 2), operands: ['list'] },
    'list.len': { ...read('val', 1), operands: ['list'] },
    'list.has': { ...read('bool', 2), operands: ['list'] },
    'list.index': { ...read('val', 2), operands: ['list'] },
    'list.add': { ...write(2), operands: ['list'] },
    'list.del': { ...write(2), operands: ['list'] },
    'list.ins': { ...write(3), operands: ['list'] },
    'list.set': { ...write(3), operands: ['list'] },
    'list.clear': { ...write(1), operands: ['list'] },

    broadcast: write(1),
    'broadcast.wait': { effect: 'yield', type: null, arity: 1 },
    wait: { effect: 'yield', type: null, arity: 1 },
    stop: { effect: 'write', type: null, arity: 1 },
    call: { effect: 'yield', type: 'val', arity: null },
    sb: { effect: null, type: null, arity: null },

    if: { effect: 'control', type: null, arity: 1, regions: [1, 2], boolArgs: [0] },
    repeat: { effect: 'yield', type: null, arity: 1, regions: [1, 1], loop: true },
    forever: { effect: 'yield', type: null, arity: 0, regions: [1, 1], loop: true, terminator: true },
    until: { effect: 'yield', type: null, arity: 0, regions: [2, 2], loop: true, condRegion: 0 },
    'wait.until': { effect: 'yield', type: null, arity: 0, regions: [1, 1], condRegion: 0 },

    cond: { effect: 'control', type: null, arity: 1, boolArgs: [0] },
    break: { effect: 'control', type: null, arity: 0, terminator: true },
    continue: { effect: 'control', type: null, arity: 0, terminator: true },
    ret: { effect: 'control', type: null, arity: null, terminator: true },
};

export const REGION_KEYWORDS = { if: [null, 'else'], until: [null, 'do'] };

const SB_YIELDING = new Set([
    'looks_sayforsecs', 'looks_thinkforsecs', 'motion_glidesecstoxy', 'motion_glideto',
    'sensing_askandwait', 'sound_playuntildone', 'looks_switchbackdroptoandwait',
]);

const SB_BOOL_REPORTERS = new Set([
    'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor',
    'sensing_keypressed', 'sensing_mousedown',
]);

const STOP_CAPS = new Set(['all', 'this script']);

export function effectOf(op) {
    if (op.op === 'sb') {
        if (SB_YIELDING.has(op.opcode)) return 'yield';
        return op.result ? 'read' : 'write';
    }
    return OPS[op.op].effect;
}

export function typeOf(op) {
    if (op.op === 'sb') return op.result ? (SB_BOOL_REPORTERS.has(op.opcode) ? 'bool' : 'val') : null;
    return OPS[op.op].type;
}

const LOOP_NAMES = new Set(['repeat', 'forever', 'until']);

function breaksOut(region) {
    return region.some((op) => op.op === 'break' || (!LOOP_NAMES.has(op.op) && op.regions.some(breaksOut)));
}

export function isTerminator(op) {
    if (op.op === 'forever') return !breaksOut(op.regions[0]);
    if (op.op === 'stop') return op.args[0]?.lit !== undefined && STOP_CAPS.has(op.args[0].lit);
    return !!OPS[op.op]?.terminator;
}

export function isRemovableIfUnused(op) {
    return op.result !== null && EFFECT_RANK[effectOf(op)] <= EFFECT_RANK.read;
}
