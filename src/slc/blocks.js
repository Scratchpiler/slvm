const num = (name) => [name, 'num'];
const text = (name) => [name, 'text'];
const bool = (name) => [name, 'bool'];

const MATHOP_NAMES = {
    abs: 'abs', floor: 'floor', ceiling: 'ceiling', sqrt: 'sqrt',
    sin: 'sin', cos: 'cos', tan: 'tan', asin: 'asin', acos: 'acos', atan: 'atan',
    ln: 'ln', log: 'log', exp: 'e ^', pow10: '10 ^',
};

export const BLOCKS = {
    add: { opcode: 'operator_add', inputs: [num('NUM1'), num('NUM2')] },
    sub: { opcode: 'operator_subtract', inputs: [num('NUM1'), num('NUM2')] },
    mul: { opcode: 'operator_multiply', inputs: [num('NUM1'), num('NUM2')] },
    div: { opcode: 'operator_divide', inputs: [num('NUM1'), num('NUM2')] },
    mod: { opcode: 'operator_mod', inputs: [num('NUM1'), num('NUM2')] },
    round: { opcode: 'operator_round', inputs: [num('NUM')] },
    ...Object.fromEntries(Object.entries(MATHOP_NAMES).map(([fn, label]) => [
        `math.${fn}`, { opcode: 'operator_mathop', fields: { OPERATOR: label }, inputs: [num('NUM')] },
    ])),
    lt: { opcode: 'operator_lt', inputs: [text('OPERAND1'), text('OPERAND2')] },
    gt: { opcode: 'operator_gt', inputs: [text('OPERAND1'), text('OPERAND2')] },
    eq: { opcode: 'operator_equals', inputs: [text('OPERAND1'), text('OPERAND2')] },
    and: { opcode: 'operator_and', inputs: [bool('OPERAND1'), bool('OPERAND2')] },
    or: { opcode: 'operator_or', inputs: [bool('OPERAND1'), bool('OPERAND2')] },
    not: { opcode: 'operator_not', inputs: [bool('OPERAND')] },
    join: { opcode: 'operator_join', inputs: [text('STRING1'), text('STRING2')] },
    letter: { opcode: 'operator_letter_of', inputs: [num('LETTER'), text('STRING')] },
    length: { opcode: 'operator_length', inputs: [text('STRING')] },
    contains: { opcode: 'operator_contains', inputs: [text('STRING1'), text('STRING2')] },
    random: { opcode: 'operator_random', inputs: [num('FROM'), num('TO')] },

    'var.get': { opcode: 'data_variable', symbol: ['VARIABLE', 'var'], inputs: [] },
    'var.set': { opcode: 'data_setvariableto', symbol: ['VARIABLE', 'var'], inputs: [text('VALUE')] },
    'var.change': { opcode: 'data_changevariableby', symbol: ['VARIABLE', 'var'], inputs: [num('VALUE')] },
    'list.get': { opcode: 'data_itemoflist', symbol: ['LIST', 'list'], inputs: [num('INDEX')] },
    'list.len': { opcode: 'data_lengthoflist', symbol: ['LIST', 'list'], inputs: [] },
    'list.has': { opcode: 'data_listcontainsitem', symbol: ['LIST', 'list'], inputs: [text('ITEM')] },
    'list.index': { opcode: 'data_itemnumoflist', symbol: ['LIST', 'list'], inputs: [text('ITEM')] },
    'list.add': { opcode: 'data_addtolist', symbol: ['LIST', 'list'], inputs: [text('ITEM')] },
    'list.del': { opcode: 'data_deleteoflist', symbol: ['LIST', 'list'], inputs: [num('INDEX')] },
    'list.ins': { opcode: 'data_insertatlist', symbol: ['LIST', 'list'], inputs: [num('INDEX'), text('ITEM')] },
    'list.set': { opcode: 'data_replaceitemoflist', symbol: ['LIST', 'list'], inputs: [num('INDEX'), text('ITEM')] },
    'list.clear': { opcode: 'data_deletealloflist', symbol: ['LIST', 'list'], inputs: [] },

    broadcast: { opcode: 'event_broadcast', inputs: [['BROADCAST_INPUT', 'broadcast']] },
    'broadcast.wait': { opcode: 'event_broadcastandwait', inputs: [['BROADCAST_INPUT', 'broadcast']] },
    wait: { opcode: 'control_wait', inputs: [num('DURATION')] },
    repeat: { opcode: 'control_repeat', inputs: [num('TIMES')], substacks: ['SUBSTACK'] },
    forever: { opcode: 'control_forever', inputs: [], substacks: ['SUBSTACK'] },
};

export const HATS = {
    flag: () => ({ opcode: 'event_whenflagclicked' }),
    clicked: (arg, isStage) => ({ opcode: isStage ? 'event_whenstageclicked' : 'event_whenthisspriteclicked' }),
    clone: () => ({ opcode: 'control_start_as_clone' }),
    key: (arg) => ({ opcode: 'event_whenkeypressed', fields: { KEY_OPTION: arg ?? 'space' } }),
    backdrop: (arg) => ({ opcode: 'event_whenbackdropswitchesto', fields: { BACKDROP: arg ?? '' } }),
    receive: (arg) => ({ opcode: 'event_whenbroadcastreceived', broadcastField: arg ?? '' }),
};

export const DEFAULT_SB_SCHEMA = {
    looks_say: { params: [{ name: 'MESSAGE', kind: 'input', valueType: 'string' }] },
    looks_think: { params: [{ name: 'MESSAGE', kind: 'input', valueType: 'string' }] },
    looks_sayforsecs: { params: [
        { name: 'MESSAGE', kind: 'input', valueType: 'string' },
        { name: 'SECS', kind: 'input', valueType: 'number' },
    ] },
    motion_movesteps: { params: [{ name: 'STEPS', kind: 'input', valueType: 'number' }] },
    motion_turnright: { params: [{ name: 'DEGREES', kind: 'input', valueType: 'number' }] },
    motion_gotoxy: { params: [
        { name: 'X', kind: 'input', valueType: 'number' },
        { name: 'Y', kind: 'input', valueType: 'number' },
    ] },
    motion_xposition: { params: [] },
    motion_yposition: { params: [] },
    sensing_timer: { params: [] },
};
