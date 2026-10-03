import { OPS, REGION_KEYWORDS } from './ops.js';

const PROC_FLAGS = ['warp', 'returns', 'extern', 'noinline'];
const IDENT = /^[A-Za-z_][\w.]*/;
const NUMBER = /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

export class ParseError extends Error {
    constructor(message, line) {
        super(`line ${line}: ${message}`);
        this.line = line;
    }
}

function tokenize(src) {
    const tokens = [];
    let line = 1;
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const rest = src.slice(i);
        if (c === '\n') {
            tokens.push({ t: 'nl', line });
            line++;
            i++;
        } else if (c === ' ' || c === '\t' || c === '\r') {
            i++;
        } else if (c === ';') {
            while (i < src.length && src[i] !== '\n') i++;
        } else if (c === '"') {
            const m = /^"(?:[^"\\]|\\.)*"/.exec(rest);
            if (!m) throw new ParseError('unterminated string', line);
            tokens.push({ t: 'str', v: JSON.parse(m[0]), line });
            i += m[0].length;
        } else if (c === '%' || c === '@') {
            const t = c === '%' ? 'local' : 'global';
            if (src[i + 1] === '"') {
                const m = /^"(?:[^"\\]|\\.)*"/.exec(src.slice(i + 1));
                if (!m) throw new ParseError('unterminated quoted name', line);
                tokens.push({ t, v: JSON.parse(m[0]), line });
                i += 1 + m[0].length;
            } else {
                const m = /^[\w.]+/.exec(src.slice(i + 1));
                if (!m) throw new ParseError(`expected a name after ${c}`, line);
                tokens.push({ t, v: m[0], line });
                i += 1 + m[0].length;
            }
        } else if (NUMBER.test(rest) && !(c === '-' && !/[\d.]/.test(src[i + 1]))) {
            const m = NUMBER.exec(rest);
            tokens.push({ t: 'num', v: Number(m[0]), line });
            i += m[0].length;
        } else if (IDENT.test(rest)) {
            const m = IDENT.exec(rest);
            tokens.push({ t: 'ident', v: m[0], line });
            i += m[0].length;
        } else if ('{}(),=:'.includes(c)) {
            tokens.push({ t: c, line });
            i++;
        } else {
            throw new ParseError(`unexpected character ${JSON.stringify(c)}`, line);
        }
    }
    tokens.push({ t: 'eof', line });
    return tokens;
}

export function parse(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = (k = 0) => tokens[pos + k];
    const next = () => tokens[pos++];
    const at = (t, v) => peek().t === t && (v === undefined || peek().v === v);
    const expect = (t, v) => {
        if (!at(t, v)) throw new ParseError(`expected ${v ?? t}, got ${peek().v ?? peek().t}`, peek().line);
        return next();
    };
    const skipNewlines = () => { while (at('nl')) next(); };
    const endOfLine = () => {
        if (at('}') || at('eof')) return;
        expect('nl');
    };

    function parseOperand() {
        const tok = next();
        switch (tok.t) {
            case 'local': return { ref: tok.v };
            case 'global': return { sym: tok.v };
            case 'num': return { lit: tok.v };
            case 'str': return { lit: tok.v };
            case 'ident':
                if (tok.v === 'true' || tok.v === 'false') return { lit: tok.v === 'true' };
                return { name: tok.v };
        }
        throw new ParseError(`expected an operand, got ${tok.v ?? tok.t}`, tok.line);
    }

    function parseRegion() {
        expect('{');
        const ops = [];
        skipNewlines();
        while (!at('}')) {
            ops.push(parseOp());
            skipNewlines();
        }
        expect('}');
        return ops;
    }

    function parseOp() {
        const line = peek().line;
        let result = null;
        if (at('local') && peek(1).t === '=') {
            result = next().v;
            next();
        }
        const name = expect('ident').v;
        if (!OPS[name]) throw new ParseError(`unknown op \`${name}\``, line);
        const op = { op: name, result, args: [], regions: [], line };

        if (name === 'call') {
            op.callee = expect('global').v;
            expect('(');
            while (!at(')')) {
                op.args.push(parseOperand());
                if (!at(')')) expect(',');
            }
            expect(')');
        } else if (name === 'sb') {
            op.opcode = expect('ident').v;
            op.keys = [];
            expect('(');
            while (!at(')')) {
                op.keys.push(expect('ident').v);
                expect(':');
                op.args.push(parseOperand());
                if (!at(')')) expect(',');
            }
            expect(')');
        } else {
            while (!at('nl') && !at('{') && !at('}') && !at('eof') && !at('ident', 'nounroll')) {
                op.args.push(parseOperand());
                if (at(',')) next();
                else break;
            }
        }
        if (at('ident', 'nounroll')) {
            if (!OPS[name].unrollable) throw new ParseError(`\`${name}\` cannot take \`nounroll\``, line);
            next();
            op.nounroll = true;
        }

        const keywords = REGION_KEYWORDS[name] || [];
        if (at('{')) {
            op.regions.push(parseRegion());
            for (let k = 1; k < keywords.length; k++) {
                if (!at('ident', keywords[k])) break;
                next();
                op.regions.push(parseRegion());
            }
        }
        endOfLine();
        return op;
    }

    function parseTarget() {
        const target = { kind: next().v, name: null, vars: [], procs: [], scripts: [] };
        if (target.kind === 'sprite') target.name = expect('str').v;
        expect('{');
        skipNewlines();
        while (!at('}')) {
            const kw = expect('ident');
            if (kw.v === 'var' || kw.v === 'list') {
                const decl = { kind: kw.v, name: expect('global').v, internal: false };
                if (at('ident', 'internal')) { next(); decl.internal = true; }
                target.vars.push(decl);
            } else if (kw.v === 'proc') {
                const proc = { name: expect('global').v, params: [], warp: false, returns: false };
                expect('(');
                while (!at(')')) {
                    proc.params.push(expect('ident').v);
                    if (!at(')')) expect(',');
                }
                expect(')');
                while (at('ident')) {
                    const flag = next().v;
                    if (!PROC_FLAGS.includes(flag)) throw new ParseError(`unknown proc flag \`${flag}\``, kw.line);
                    proc[flag] = true;
                }
                proc.body = parseRegion();
                target.procs.push(proc);
            } else if (kw.v === 'script') {
                const hat = { event: expect('ident').v, arg: null };
                if (at('str')) hat.arg = next().v;
                if (at('num')) hat.value = next().v;
                if (at('ident', 'with')) {
                    next();
                    hat.with = parseRegion();
                }
                target.scripts.push({ hat, body: parseRegion() });
            } else {
                throw new ParseError(`unexpected \`${kw.v}\` in ${target.kind}`, kw.line);
            }
            endOfLine();
            skipNewlines();
        }
        expect('}');
        return target;
    }

    const mod = { targets: [] };
    skipNewlines();
    while (!at('eof')) {
        if (!at('ident', 'stage') && !at('ident', 'sprite')) {
            throw new ParseError('expected `stage` or `sprite`', peek().line);
        }
        mod.targets.push(parseTarget());
        skipNewlines();
    }
    return mod;
}

const BARE_NAME = /^[A-Za-z_][\w.]*$/;
const sym = (prefix, name) => prefix + (BARE_NAME.test(name) ? name : JSON.stringify(name));

function formatLiteral(v) {
    if (typeof v === 'string') return JSON.stringify(v);
    return String(v);
}

export function print(mod) {
    const lines = [];
    const emit = (depth, text) => lines.push('  '.repeat(depth) + text);

    function printRoot(header, body, depth, hatRegion = null) {
        const names = new Map();
        const local = (id) => {
            if (!names.has(id)) names.set(id, `%${names.size}`);
            return names.get(id);
        };
        const operand = (a) => {
            if (a.ref !== undefined) return local(a.ref);
            if (a.sym !== undefined) return sym('@', a.sym);
            if (a.name !== undefined) return a.name;
            return formatLiteral(a.lit);
        };
        const printRegion = (region, d) => {
            for (const op of region) {
                let text = op.result !== null ? `${local(op.result)} = ${op.op}` : op.op;
                if (op.op === 'call') {
                    text += ` ${sym('@', op.callee)}(${op.args.map(operand).join(', ')})`;
                } else if (op.op === 'sb') {
                    text += ` ${op.opcode}(${op.args.map((a, i) => `${op.keys[i]}: ${operand(a)}`).join(', ')})`;
                } else if (op.args.length) {
                    text += ' ' + op.args.map(operand).join(', ');
                }
                if (op.nounroll) text += ' nounroll';
                if (!op.regions.length) {
                    emit(d, text);
                    continue;
                }
                const keywords = REGION_KEYWORDS[op.op] || [];
                op.regions.forEach((r, i) => {
                    if (i === 0) emit(d, `${text} {`);
                    else lines[lines.length - 1] += ` ${keywords[i]} {`;
                    printRegion(r, d + 1);
                    emit(d, '}');
                });
            }
        };
        if (hatRegion) {
            emit(depth, `${header} with {`);
            printRegion(hatRegion, depth + 1);
            emit(depth, '} {');
        } else {
            emit(depth, `${header} {`);
        }
        printRegion(body, depth + 1);
        emit(depth, '}');
    }

    mod.targets.forEach((target, ti) => {
        if (ti > 0) lines.push('');
        emit(0, target.kind === 'stage' ? 'stage {' : `sprite ${JSON.stringify(target.name)} {`);
        for (const v of target.vars) emit(1, `${v.kind} ${sym('@', v.name)}${v.internal ? ' internal' : ''}`);
        for (const proc of target.procs) {
            lines.push('');
            const flags = PROC_FLAGS.filter((flag) => proc[flag]);
            printRoot(`proc ${sym('@', proc.name)}(${proc.params.join(', ')})${flags.map((f) => ' ' + f).join('')}`, proc.body, 1);
        }
        for (const script of target.scripts) {
            lines.push('');
            const { event, arg, value } = script.hat;
            const hatArgs = [arg !== null && JSON.stringify(arg), value !== undefined && String(value)].filter(Boolean);
            printRoot(['script', event, ...hatArgs].join(' '), script.body, 1, script.hat.with ?? null);
        }
        emit(0, '}');
    });
    return lines.join('\n') + '\n';
}
