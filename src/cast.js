export function toNumber(v) {
    if (typeof v === 'number') return Number.isNaN(v) ? 0 : v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
}

export function toBoolean(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return !(v === '' || v === '0' || v.toLowerCase() === 'false');
    return Boolean(v);
}

export function toString(v) {
    return String(v);
}

function isWhiteSpace(v) {
    return v === null || (typeof v === 'string' && v.trim().length === 0);
}

export function compare(a, b) {
    let n1 = Number(a);
    let n2 = Number(b);
    if (n1 === 0 && isWhiteSpace(a)) n1 = NaN;
    if (n2 === 0 && isWhiteSpace(b)) n2 = NaN;
    if (Number.isNaN(n1) || Number.isNaN(n2)) {
        const s1 = String(a).toLowerCase();
        const s2 = String(b).toLowerCase();
        return s1 < s2 ? -1 : s1 > s2 ? 1 : 0;
    }
    if ((n1 === Infinity && n2 === Infinity) || (n1 === -Infinity && n2 === -Infinity)) return 0;
    return n1 - n2;
}

const trig = (fn) => (n) => parseFloat(fn((Math.PI * n) / 180).toFixed(10));

function tan(n) {
    n %= 360;
    if (n === -270 || n === 90) return Infinity;
    if (n === -90 || n === 270) return -Infinity;
    return trig(Math.tan)(n);
}

const MATH = {
    abs: Math.abs,
    floor: Math.floor,
    ceiling: Math.ceil,
    sqrt: Math.sqrt,
    sin: trig(Math.sin),
    cos: trig(Math.cos),
    tan,
    asin: (n) => (Math.asin(n) * 180) / Math.PI,
    acos: (n) => (Math.acos(n) * 180) / Math.PI,
    atan: (n) => (Math.atan(n) * 180) / Math.PI,
    ln: Math.log,
    log: (n) => Math.log(n) / Math.LN10,
    exp: Math.exp,
    pow10: (n) => Math.pow(10, n),
};

export const MATH_FUNCTIONS = Object.keys(MATH);

export const EVAL = {
    add: (a, b) => toNumber(a) + toNumber(b),
    sub: (a, b) => toNumber(a) - toNumber(b),
    mul: (a, b) => toNumber(a) * toNumber(b),
    div: (a, b) => toNumber(a) / toNumber(b),
    mod: (a, b) => {
        const m = toNumber(b);
        let r = toNumber(a) % m;
        if (r / m < 0) r += m;
        return r;
    },
    round: (a) => Math.round(toNumber(a)),
    lt: (a, b) => compare(a, b) < 0,
    gt: (a, b) => compare(a, b) > 0,
    eq: (a, b) => compare(a, b) === 0,
    and: (a, b) => toBoolean(a) && toBoolean(b),
    or: (a, b) => toBoolean(a) || toBoolean(b),
    not: (a) => !toBoolean(a),
    join: (a, b) => toString(a) + toString(b),
    letter: (i, s) => {
        const index = toNumber(i) - 1;
        const str = toString(s);
        return index < 0 || index >= str.length ? '' : str.charAt(index);
    },
    length: (s) => toString(s).length,
    contains: (s, sub) => toString(s).toLowerCase().includes(toString(sub).toLowerCase()),
    ...Object.fromEntries(Object.entries(MATH).map(([k, fn]) => [`math.${k}`, (a) => fn(toNumber(a))])),
};
