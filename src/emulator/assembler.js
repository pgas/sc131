/**
 * Small Computer Workshop (SCWorkshop) Z80 / Z180 Two-Pass Assembler
 * Compatible with Stephen C. Cousins' SCWorkshop assembler syntax and standard Zilog Z80/Z180 assembly.
 *
 * Features:
 *  - Directives: #TARGET, .COMP, .PROC, .ORG/ORG, .EQU/EQU/=, .DB/DB/DEFB, .DW/DW/DEFW, .DS/DS/DEFS, .HEX, .END
 *  - Preprocessor: #DEFINE, #IF, #IFDEF, #IFNDEF, #ELSE, #ENDIF
 *  - Scoped local labels prefixed with '@' (e.g., @Loop:, @Upper:, @LoEnd:)
 *  - Full Z80 instruction set + undocumented IXH/IXL/IYH/IYL + SLL
 *  - Full Z180 extended instruction set: IN0, OUT0, MLT/MULT, TST, TSTIO, OTIM, OTIMR, OTDM, OTDMR, SLP
 *  - Generates SCWorkshop outputs: Listing.txt, IntelHex.hex, Memory.txt, Symbols.txt, and PC<->Line maps
 */

const REG8_MAP = {
  B: 0,
  C: 1,
  D: 2,
  E: 3,
  H: 4,
  L: 5,
  '(HL)': 6,
  A: 7,
};

const COND_MAP = {
  NZ: 0,
  Z: 1,
  NC: 2,
  C: 3,
  PO: 4,
  PE: 5,
  P: 6,
  M: 7,
};

const PAIR_SP_MAP = {
  BC: 0,
  DE: 1,
  HL: 2,
  SP: 3,
};

const PAIR_AF_MAP = {
  BC: 0,
  DE: 1,
  HL: 2,
  AF: 3,
};

const ALU_OP_MAP = {
  ADD: 0,
  ADC: 1,
  SUB: 2,
  SBC: 3,
  AND: 4,
  XOR: 5,
  OR: 6,
  CP: 7,
};

const CB_ROT_MAP = {
  RLC: 0,
  RRC: 1,
  RL: 2,
  RR: 3,
  SLA: 4,
  SRA: 5,
  SLL: 6,
  SL1: 6,
  SRL: 7,
};

const SIMPLE_NO_OPERAND = {
  NOP: [0x00],
  RLCA: [0x07],
  RRCA: [0x0F],
  RLA: [0x17],
  RRA: [0x1F],
  DAA: [0x27],
  CPL: [0x2F],
  SCF: [0x37],
  CCF: [0x3F],
  HALT: [0x76],
  EXX: [0xD9],
  DI: [0xF3],
  EI: [0xFB],
  NEG: [0xED, 0x44],
  RETN: [0xED, 0x45],
  RETI: [0xED, 0x4D],
  RRD: [0xED, 0x67],
  RLD: [0xED, 0x6F],
  SLP: [0xED, 0x76],
  OTIM: [0xED, 0x83],
  OTDM: [0xED, 0x8B],
  OTIMR: [0xED, 0x93],
  OTDMR: [0xED, 0x9B],
  LDI: [0xED, 0xA0],
  CPI: [0xED, 0xA1],
  INI: [0xED, 0xA2],
  OUTI: [0xED, 0xA3],
  LDD: [0xED, 0xA8],
  CPD: [0xED, 0xA9],
  IND: [0xED, 0xAA],
  OUTD: [0xED, 0xAB],
  LDIR: [0xED, 0xB0],
  CPIR: [0xED, 0xB1],
  INIR: [0xED, 0xB2],
  OTIR: [0xED, 0xB3],
  LDDR: [0xED, 0xB8],
  CPDR: [0xED, 0xB9],
  INDR: [0xED, 0xBA],
  OTDR: [0xED, 0xBB],
};

const MNEMONICS_AND_DIRECTIVES = new Set([
  ...Object.keys(SIMPLE_NO_OPERAND),
  ...Object.keys(ALU_OP_MAP),
  ...Object.keys(CB_ROT_MAP),
  'LD', 'INC', 'DEC', 'EX', 'DJNZ', 'JR', 'JP', 'CALL', 'RET', 'RST',
  'PUSH', 'POP', 'IN', 'OUT', 'IN0', 'OUT0', 'BIT', 'RES', 'SET',
  'IM', 'MLT', 'MULT', 'TST', 'TSTIO',
  'ORG', '.ORG', 'EQU', '.EQU', 'DB', '.DB', 'DEFB', '.BYTE', '.ASCII', '.TEXT',
  'DW', '.DW', 'DEFW', '.WORD', 'DS', '.DS', 'DEFS', '.BLOCK', '.HEX',
  'END', '.END', '.PROC', '.COMP', '#TARGET', '#DEFINE', '#IF', '#IFDEF', '#IFNDEF', '#ELSE', '#ENDIF',
]);

const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

/**
 * Strip comment (`; ...`) outside of single or double quotes
 */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      // Special case: Z80 AF' register prime is not a string literal
      const prev2 = line.slice(Math.max(0, i - 2), i).toUpperCase();
      if (prev2 === 'AF') continue;
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === ';' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Split comma-separated operands while respecting parentheses and quotes
 */
function splitOperands(str) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '\\' && (inSingle || inDouble)) {
      cur += ch + (str[i + 1] || '');
      i++;
      continue;
    }
    if (ch === "'" && !inDouble) {
      const prev2 = str.slice(Math.max(0, i - 2), i).toUpperCase();
      if (prev2 !== 'AF') inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        parts.push(cur.trim());
        cur = '';
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim().length > 0) {
    parts.push(cur.trim());
  }
  return parts;
}

/**
 * Evaluate an assembly arithmetic expression
 * Supports hex (0x1234, $1234, 0FFh), binary (0b1010, %1010, 1010b), decimal,
 * character constants ('A'), current PC ($), local labels (@foo), symbols, and operators.
 */
export function evaluateExpression(exprStr, symbols, currentPc, currentScope, pass = 2) {
  const s = exprStr.trim();
  if (!s) throw new Error('Empty expression');

  const tokens = [];
  let i = 0;

  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Two-character operators
    const two = s.slice(i, i + 2);
    if (['<<', '>>', '<=', '>=', '==', '!=', '<>', '&&', '||'].includes(two)) {
      tokens.push({ type: 'op', val: two === '<>' ? '!=' : two });
      i += 2;
      continue;
    }

    // Single-character operators & parens
    if ('+-*/%&|^~<>!()'.includes(ch)) {
      // Distinguish '$' / '%' prefix vs modulo
      if (ch === '%') {
        // Binary literal %10101010 if at start or after operator/lparen and followed by 0/1
        const prev = tokens[tokens.length - 1];
        const isPrefixPos = !prev || prev.type === 'op' || prev.val === '(';
        if (isPrefixPos && /[01]/.test(s[i + 1] || '')) {
          let bin = '';
          i++;
          while (i < s.length && /[01_]/.test(s[i])) {
            if (s[i] !== '_') bin += s[i];
            i++;
          }
          tokens.push({ type: 'num', val: parseInt(bin, 2) });
          continue;
        }
      }
      tokens.push({ type: ch === '(' || ch === ')' ? 'paren' : 'op', val: ch });
      i++;
      continue;
    }

    // Character literal 'A' or '\r'
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      let val = 0;
      if (s[i] === '\\') {
        i++;
        const esc = s[i++];
        const escMap = { r: 13, n: 10, t: 9, '0': 0, '\\': 92, "'": 39, '"': 34, e: 27 };
        val = escMap[esc] !== undefined ? escMap[esc] : esc.charCodeAt(0);
      } else if (i < s.length) {
        val = s.charCodeAt(i++);
      }
      if (s[i] === quote) i++;
      tokens.push({ type: 'num', val });
      continue;
    }

    // $ current PC or $HEX literal
    if (ch === '$') {
      if (/[0-9a-fA-F]/.test(s[i + 1] || '')) {
        i++;
        let hex = '';
        while (i < s.length && /[0-9a-fA-F_]/.test(s[i])) {
          if (s[i] !== '_') hex += s[i];
          i++;
        }
        tokens.push({ type: 'num', val: parseInt(hex, 16) });
      } else {
        i++;
        tokens.push({ type: 'num', val: currentPc & 0xFFFF });
      }
      continue;
    }

    // Number or Identifier (including @local)
    if (/[0-9a-zA-Z_@.]/.test(ch)) {
      let word = '';
      while (i < s.length && /[0-9a-zA-Z_@.]/.test(s[i])) {
        word += s[i++];
      }
      const upper = word.toUpperCase();

      if (/^[0-9]/.test(upper)) {
        // Numeric literal
        const clean = upper.replace(/_/g, '');
        let num = NaN;
        if (clean.startsWith('0X')) {
          num = parseInt(clean.slice(2), 16);
        } else if (clean.startsWith('0B')) {
          num = parseInt(clean.slice(2), 2);
        } else if (clean.startsWith('0O') || clean.startsWith('0Q')) {
          num = parseInt(clean.slice(2), 8);
        } else if (clean.endsWith('H')) {
          num = parseInt(clean.slice(0, -1), 16);
        } else if (clean.endsWith('B') && /^[01]+B$/.test(clean)) {
          num = parseInt(clean.slice(0, -1), 2);
        } else if ((clean.endsWith('O') || clean.endsWith('Q')) && /^[0-7]+[OQ]$/.test(clean)) {
          num = parseInt(clean.slice(0, -1), 8);
        } else if (clean.endsWith('D') && /^[0-9]+D$/.test(clean)) {
          num = parseInt(clean.slice(0, -1), 10);
        } else if (/^[0-9]+$/.test(clean)) {
          num = parseInt(clean, 10);
        }
        if (Number.isNaN(num)) {
          throw new Error(`Invalid number literal: ${word}`);
        }
        tokens.push({ type: 'num', val: num });
        continue;
      }

      if (upper === 'HIGH' || upper === 'LOW' || upper === 'NOT' || upper === 'MOD' || upper === 'AND' || upper === 'OR' || upper === 'XOR' || upper === 'SHL' || upper === 'SHR') {
        const opAlias = {
          HIGH: 'HIGH',
          LOW: 'LOW',
          NOT: '~',
          MOD: '%',
          AND: '&',
          OR: '|',
          XOR: '^',
          SHL: '<<',
          SHR: '>>',
        };
        tokens.push({ type: 'op', val: opAlias[upper] });
        continue;
      }

      // Identifier or @local label
      const symKey = upper.startsWith('@') ? `${currentScope}${upper}` : upper;
      if (symbols.has(symKey)) {
        tokens.push({ type: 'num', val: symbols.get(symKey) });
      } else if (symbols.has(upper)) {
        tokens.push({ type: 'num', val: symbols.get(upper) });
      } else if (pass === 1) {
        tokens.push({ type: 'num', val: 0 });
      } else {
        throw new Error(`Undefined symbol: ${word}`);
      }
      continue;
    }

    throw new Error(`Unexpected character '${ch}' in expression '${exprStr}'`);
  }

  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];

  function parseOr() {
    let left = parseXor();
    while (peek()?.type === 'op' && (peek().val === '|' || peek().val === '||')) {
      const op = consume().val;
      const right = parseXor();
      left = op === '||' ? ((left || right) ? 1 : 0) : (left | right);
    }
    return left;
  }

  function parseXor() {
    let left = parseAnd();
    while (peek()?.type === 'op' && peek().val === '^') {
      consume();
      left = left ^ parseAnd();
    }
    return left;
  }

  function parseAnd() {
    let left = parseComp();
    while (peek()?.type === 'op' && (peek().val === '&' || peek().val === '&&')) {
      const op = consume().val;
      const right = parseComp();
      left = op === '&&' ? ((left && right) ? 1 : 0) : (left & right);
    }
    return left;
  }

  function parseComp() {
    let left = parseShift();
    while (peek()?.type === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(peek().val)) {
      const op = consume().val;
      const right = parseShift();
      if (op === '==') left = left === right ? 1 : 0;
      else if (op === '!=') left = left !== right ? 1 : 0;
      else if (op === '<') left = left < right ? 1 : 0;
      else if (op === '>') left = left > right ? 1 : 0;
      else if (op === '<=') left = left <= right ? 1 : 0;
      else if (op === '>=') left = left >= right ? 1 : 0;
    }
    return left;
  }

  function parseShift() {
    let left = parseAdd();
    while (peek()?.type === 'op' && (peek().val === '<<' || peek().val === '>>')) {
      const op = consume().val;
      const right = parseAdd();
      left = op === '<<' ? (left << right) : (left >> right);
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    while (peek()?.type === 'op' && (peek().val === '+' || peek().val === '-')) {
      const op = consume().val;
      const right = parseMul();
      left = op === '+' ? (left + right) : (left - right);
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek()?.type === 'op' && (peek().val === '*' || peek().val === '/' || peek().val === '%')) {
      const op = consume().val;
      const right = parseUnary();
      if (op === '*') left = Math.imul(left, right);
      else if (op === '/') left = right === 0 ? 0 : Math.trunc(left / right);
      else left = right === 0 ? 0 : (left % right);
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (t?.type === 'op' && ['+', '-', '~', '!', 'HIGH', 'LOW'].includes(t.val)) {
      consume();
      const v = parseUnary();
      if (t.val === '+') return v;
      if (t.val === '-') return -v;
      if (t.val === '~') return ~v;
      if (t.val === '!') return v ? 0 : 1;
      if (t.val === 'HIGH') return (v >> 8) & 0xFF;
      if (t.val === 'LOW') return v & 0xFF;
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error(`Unexpected end of expression: ${exprStr}`);
    if (t.type === 'paren' && t.val === '(') {
      consume();
      const val = parseOr();
      if (peek()?.type === 'paren' && peek().val === ')') {
        consume();
      } else {
        throw new Error(`Missing closing parenthesis in: ${exprStr}`);
      }
      return val;
    }
    if (t.type === 'num') {
      consume();
      return t.val;
    }
    throw new Error(`Unexpected token '${t.val}' in expression: ${exprStr}`);
  }

  const result = parseOr();
  if (pos < tokens.length) {
    throw new Error(`Unexpected trailing token '${tokens[pos].val}' in expression: ${exprStr}`);
  }
  return result;
}

/**
 * Check if an operand is enclosed in outer parentheses `(...)` (and not `(a) + (b)`)
 */
function isIndirect(op) {
  const s = op.trim();
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Parse indexed operand `(IX+d)`, `(IY-d)`, `(IX)`, `(IY)`
 * Returns `{ reg: 'IX'|'IY', prefix: 0xDD|0xFD, dispExpr: string }` or null
 */
function parseIndexed(op) {
  if (!isIndirect(op)) return null;
  const inner = op.trim().slice(1, -1).trim();
  const m = /^(IX|IY)(?:\s*([+-][\s\S]*))?$/i.exec(inner);
  if (!m) return null;
  const reg = m[1].toUpperCase();
  const dispExpr = m[2] ? m[2].trim() : '0';
  return {
    reg,
    prefix: reg === 'IX' ? 0xDD : 0xFD,
    dispExpr,
  };
}

/**
 * Parse undocumented half-index register (`IXH`, `IXL`, `IYH`, `IYL`)
 */
function parseIndexHalf(op) {
  const u = op.trim().toUpperCase();
  if (u === 'IXH' || u === 'HX') return { prefix: 0xDD, code: 4 };
  if (u === 'IXL' || u === 'LX') return { prefix: 0xDD, code: 5 };
  if (u === 'IYH' || u === 'HY') return { prefix: 0xFD, code: 4 };
  if (u === 'IYL' || u === 'LY') return { prefix: 0xFD, code: 5 };
  return null;
}

/**
 * Assemble a single Z80/Z180 instruction into an array of bytes
 */
function assembleInstruction(mnemonic, ops, evalFn, currentPc, pass) {
  const m = mnemonic.toUpperCase();

  // 0-operand instructions (or RET without condition)
  if (ops.length === 0) {
    if (m === 'RET') return [0xC9];
    if (SIMPLE_NO_OPERAND[m]) return [...SIMPLE_NO_OPERAND[m]];
    throw new Error(`Instruction '${m}' requires operands`);
  }

  const op0 = ops[0].trim();
  const op0U = op0.toUpperCase();
  const op1 = ops[1] ? ops[1].trim() : '';
  const op1U = op1.toUpperCase();

  const eval8 = (expr) => evalFn(expr) & 0xFF;
  const eval16 = (expr) => evalFn(expr) & 0xFFFF;
  const evalDisp = (expr) => {
    const d = evalFn(expr);
    if (pass === 2 && (d < -128 || d > 127)) {
      throw new Error(`Index displacement out of range (-128..127): ${d}`);
    }
    return d & 0xFF;
  };
  const evalRel = (expr) => {
    const target = evalFn(expr) & 0xFFFF;
    let diff = target - ((currentPc + 2) & 0xFFFF);
    if (diff > 32767) diff -= 65536;
    if (diff < -32768) diff += 65536;
    if (pass === 2 && (diff < -128 || diff > 127)) {
      throw new Error(`Relative jump out of range (${diff} bytes)`);
    }
    return diff & 0xFF;
  };

  switch (m) {
    case 'LD': {
      if (ops.length !== 2) throw new Error('LD requires 2 operands');

      // 1. Special A <-> I / R
      if (op0U === 'I' && op1U === 'A') return [0xED, 0x47];
      if (op0U === 'R' && op1U === 'A') return [0xED, 0x4F];
      if (op0U === 'A' && op1U === 'I') return [0xED, 0x57];
      if (op0U === 'A' && op1U === 'R') return [0xED, 0x5F];

      // 2. LD SP, HL / IX / IY
      if (op0U === 'SP') {
        if (op1U === 'HL') return [0xF9];
        if (op1U === 'IX') return [0xDD, 0xF9];
        if (op1U === 'IY') return [0xFD, 0xF9];
      }

      // 3. LD (BC), A / LD (DE), A / LD A, (BC) / LD A, (DE)
      if (op0U === '(BC)' && op1U === 'A') return [0x02];
      if (op0U === '(DE)' && op1U === 'A') return [0x12];
      if (op0U === 'A' && op1U === '(BC)') return [0x0A];
      if (op0U === 'A' && op1U === '(DE)') return [0x1A];

      // 4. Indexed destination: LD (IX+d), r / LD (IX+d), n
      const idxDst = parseIndexed(op0);
      if (idxDst) {
        const d = evalDisp(idxDst.dispExpr);
        if (REG8_MAP[op1U] !== undefined && op1U !== '(HL)') {
          return [idxDst.prefix, 0x70 | REG8_MAP[op1U], d];
        }
        const n = eval8(op1);
        return [idxDst.prefix, 0x36, d, n];
      }

      // 5. Indexed source: LD r, (IX+d)
      const idxSrc = parseIndexed(op1);
      if (idxSrc && REG8_MAP[op0U] !== undefined && op0U !== '(HL)') {
        const d = evalDisp(idxSrc.dispExpr);
        return [idxSrc.prefix, 0x46 | (REG8_MAP[op0U] << 3), d];
      }

      // 6. 8-bit register-to-register: LD r, r' (including (HL))
      if (REG8_MAP[op0U] !== undefined && REG8_MAP[op1U] !== undefined) {
        if (op0U === '(HL)' && op1U === '(HL)') {
          throw new Error('Invalid instruction LD (HL),(HL)');
        }
        return [0x40 | (REG8_MAP[op0U] << 3) | REG8_MAP[op1U]];
      }

      // 7. Undocumented IXH/IXL/IYH/IYL loads
      const half0 = parseIndexHalf(op0);
      const half1 = parseIndexHalf(op1);
      if (half0 || half1) {
        const prefix = (half0 || half1).prefix;
        if (half0 && half1 && half0.prefix !== half1.prefix) {
          throw new Error('Cannot mix IX and IY half registers');
        }
        const dstCode = half0 ? half0.code : REG8_MAP[op0U];
        if (dstCode !== undefined && dstCode !== 6) {
          if (half1 || (REG8_MAP[op1U] !== undefined && op1U !== 'H' && op1U !== 'L' && op1U !== '(HL)')) {
            const srcCode = half1 ? half1.code : REG8_MAP[op1U];
            return [prefix, 0x40 | (dstCode << 3) | srcCode];
          }
          if (!isIndirect(op1)) {
            const n = eval8(op1);
            return [prefix, 0x06 | (dstCode << 3), n];
          }
        }
      }

      // 8. 16-bit register destination: BC, DE, HL, SP, IX, IY
      if (PAIR_SP_MAP[op0U] !== undefined || op0U === 'IX' || op0U === 'IY') {
        const isIx = op0U === 'IX';
        const isIy = op0U === 'IY';
        const pref = isIx ? [0xDD] : isIy ? [0xFD] : [];

        if (isIndirect(op1)) {
          const inner = op1.slice(1, -1);
          const nn = eval16(inner);
          const lo = nn & 0xFF;
          const hi = (nn >> 8) & 0xFF;
          if (op0U === 'HL' || isIx || isIy) {
            return [...pref, 0x2A, lo, hi];
          }
          return [0xED, 0x4B | (PAIR_SP_MAP[op0U] << 4), lo, hi];
        } else {
          const nn = eval16(op1);
          const lo = nn & 0xFF;
          const hi = (nn >> 8) & 0xFF;
          const pCode = (isIx || isIy) ? 2 : PAIR_SP_MAP[op0U];
          return [...pref, 0x01 | (pCode << 4), lo, hi];
        }
      }

      // 9. Indirect memory destination: LD (nn), A / HL / BC / DE / SP / IX / IY
      if (isIndirect(op0) && op0U !== '(HL)') {
        const inner = op0.slice(1, -1);
        const nn = eval16(inner);
        const lo = nn & 0xFF;
        const hi = (nn >> 8) & 0xFF;
        if (op1U === 'A') return [0x32, lo, hi];
        if (op1U === 'HL') return [0x22, lo, hi];
        if (op1U === 'IX') return [0xDD, 0x22, lo, hi];
        if (op1U === 'IY') return [0xFD, 0x22, lo, hi];
        if (PAIR_SP_MAP[op1U] !== undefined) {
          return [0xED, 0x43 | (PAIR_SP_MAP[op1U] << 4), lo, hi];
        }
      }

      // 10. LD A, (nn)
      if (op0U === 'A' && isIndirect(op1) && op1U !== '(HL)') {
        const nn = eval16(op1.slice(1, -1));
        return [0x3A, nn & 0xFF, (nn >> 8) & 0xFF];
      }

      // 11. 8-bit immediate: LD r, n (including LD (HL), n)
      if (REG8_MAP[op0U] !== undefined) {
        const n = eval8(op1);
        return [0x06 | (REG8_MAP[op0U] << 3), n];
      }

      throw new Error(`Invalid operands for LD: ${op0}, ${op1}`);
    }

    case 'PUSH':
    case 'POP': {
      const base = m === 'PUSH' ? 0xC5 : 0xC1;
      if (op0U === 'IX') return [0xDD, 0xE1 | (m === 'PUSH' ? 4 : 0)];
      if (op0U === 'IY') return [0xFD, 0xE1 | (m === 'PUSH' ? 4 : 0)];
      if (PAIR_AF_MAP[op0U] !== undefined) {
        return [base | (PAIR_AF_MAP[op0U] << 4)];
      }
      throw new Error(`Invalid register pair for ${m}: ${op0}`);
    }

    case 'EX': {
      if (op0U === 'DE' && op1U === 'HL') return [0xEB];
      if (op0U === 'AF' && (op1U === "AF'" || op1U === 'AF')) return [0x08];
      if (op0U === '(SP)') {
        if (op1U === 'HL') return [0xE3];
        if (op1U === 'IX') return [0xDD, 0xE3];
        if (op1U === 'IY') return [0xFD, 0xE3];
      }
      throw new Error(`Invalid operands for EX: ${op0}, ${op1}`);
    }

    case 'INC':
    case 'DEC': {
      const isDec = m === 'DEC' ? 1 : 0;
      if (PAIR_SP_MAP[op0U] !== undefined) {
        return [0x03 | (PAIR_SP_MAP[op0U] << 4) | (isDec << 3)];
      }
      if (op0U === 'IX') return [0xDD, 0x23 | (isDec << 3)];
      if (op0U === 'IY') return [0xFD, 0x23 | (isDec << 3)];
      const idx = parseIndexed(op0);
      if (idx) {
        return [idx.prefix, 0x34 | isDec, evalDisp(idx.dispExpr)];
      }
      const half = parseIndexHalf(op0);
      if (half) {
        return [half.prefix, 0x04 | (half.code << 3) | isDec];
      }
      if (REG8_MAP[op0U] !== undefined) {
        return [0x04 | (REG8_MAP[op0U] << 3) | isDec];
      }
      throw new Error(`Invalid operand for ${m}: ${op0}`);
    }

    case 'ADD':
    case 'ADC':
    case 'SUB':
    case 'SBC':
    case 'AND':
    case 'XOR':
    case 'OR':
    case 'CP': {
      // 16-bit ADD/ADC/SBC HL/IX/IY, rr
      if (ops.length === 2 && (op0U === 'HL' || op0U === 'IX' || op0U === 'IY')) {
        if (m === 'ADD') {
          const pref = op0U === 'IX' ? [0xDD] : op0U === 'IY' ? [0xFD] : [];
          const pMap = { BC: 0, DE: 1, [op0U]: 2, SP: 3 };
          if (pMap[op1U] !== undefined) {
            return [...pref, 0x09 | (pMap[op1U] << 4)];
          }
        } else if ((m === 'ADC' || m === 'SBC') && op0U === 'HL' && PAIR_SP_MAP[op1U] !== undefined) {
          const base = m === 'ADC' ? 0x4A : 0x42;
          return [0xED, base | (PAIR_SP_MAP[op1U] << 4)];
        }
        throw new Error(`Invalid 16-bit ${m}: ${op0}, ${op1}`);
      }

      // 8-bit ALU: allow both `ADD A, X` and `ADD X`
      const src = (ops.length === 2 && op0U === 'A') ? op1 : (ops.length === 1 ? op0 : null);
      if (!src) throw new Error(`Invalid operands for ${m}: ${ops.join(', ')}`);
      const srcU = src.toUpperCase();
      const aluCode = ALU_OP_MAP[m];

      const idx = parseIndexed(src);
      if (idx) {
        return [idx.prefix, 0x86 | (aluCode << 3), evalDisp(idx.dispExpr)];
      }
      const half = parseIndexHalf(src);
      if (half) {
        return [half.prefix, 0x80 | (aluCode << 3) | half.code];
      }
      if (REG8_MAP[srcU] !== undefined) {
        return [0x80 | (aluCode << 3) | REG8_MAP[srcU]];
      }
      const n = eval8(src);
      return [0xC6 | (aluCode << 3), n];
    }

    case 'RLC':
    case 'RRC':
    case 'RL':
    case 'RR':
    case 'SLA':
    case 'SRA':
    case 'SLL':
    case 'SL1':
    case 'SRL': {
      const rotCode = CB_ROT_MAP[m];
      const idx = parseIndexed(op0);
      if (idx) {
        return [idx.prefix, 0xCB, evalDisp(idx.dispExpr), (rotCode << 3) | 6];
      }
      if (REG8_MAP[op0U] !== undefined) {
        return [0xCB, (rotCode << 3) | REG8_MAP[op0U]];
      }
      throw new Error(`Invalid operand for ${m}: ${op0}`);
    }

    case 'BIT':
    case 'RES':
    case 'SET': {
      if (ops.length !== 2) throw new Error(`${m} requires 2 operands`);
      const bit = evalFn(op0) & 7;
      const base = m === 'BIT' ? 0x40 : m === 'RES' ? 0x80 : 0xC0;
      const idx = parseIndexed(op1);
      if (idx) {
        return [idx.prefix, 0xCB, evalDisp(idx.dispExpr), base | (bit << 3) | 6];
      }
      if (REG8_MAP[op1U] !== undefined) {
        return [0xCB, base | (bit << 3) | REG8_MAP[op1U]];
      }
      throw new Error(`Invalid operand for ${m}: ${op1}`);
    }

    case 'JP': {
      if (ops.length === 1) {
        if (op0U === '(HL)' || op0U === 'HL') return [0xE9];
        if (op0U === '(IX)' || op0U === 'IX') return [0xDD, 0xE9];
        if (op0U === '(IY)' || op0U === 'IY') return [0xFD, 0xE9];
        const nn = eval16(op0);
        return [0xC3, nn & 0xFF, (nn >> 8) & 0xFF];
      }
      if (ops.length === 2 && COND_MAP[op0U] !== undefined) {
        const nn = eval16(op1);
        return [0xC2 | (COND_MAP[op0U] << 3), nn & 0xFF, (nn >> 8) & 0xFF];
      }
      throw new Error(`Invalid operands for JP: ${ops.join(', ')}`);
    }

    case 'JR': {
      if (ops.length === 1) {
        return [0x18, evalRel(op0)];
      }
      const jrCond = { NZ: 0, Z: 1, NC: 2, C: 3 };
      if (ops.length === 2 && jrCond[op0U] !== undefined) {
        return [0x20 | (jrCond[op0U] << 3), evalRel(op1)];
      }
      throw new Error(`Invalid operands for JR: ${ops.join(', ')}`);
    }

    case 'DJNZ': {
      return [0x10, evalRel(op0)];
    }

    case 'CALL': {
      if (ops.length === 1) {
        const nn = eval16(op0);
        return [0xCD, nn & 0xFF, (nn >> 8) & 0xFF];
      }
      if (ops.length === 2 && COND_MAP[op0U] !== undefined) {
        const nn = eval16(op1);
        return [0xC4 | (COND_MAP[op0U] << 3), nn & 0xFF, (nn >> 8) & 0xFF];
      }
      throw new Error(`Invalid operands for CALL: ${ops.join(', ')}`);
    }

    case 'RET': {
      if (COND_MAP[op0U] !== undefined) {
        return [0xC0 | (COND_MAP[op0U] << 3)];
      }
      throw new Error(`Invalid condition for RET: ${op0}`);
    }

    case 'RST': {
      let v = evalFn(op0);
      // Support both `RST 0x30` and `RST 6`
      if (v >= 0 && v <= 7 && (v & 7) === v && v !== 0 && !op0.includes('0')) {
        v = v << 3;
      }
      if ((v & ~0x38) !== 0) {
        throw new Error(`Invalid RST vector: ${op0}`);
      }
      return [0xC7 | (v & 0x38)];
    }

    case 'IN': {
      if (ops.length === 2) {
        if (op1U === '(C)') {
          if (op0U === 'F') return [0xED, 0x70];
          if (REG8_MAP[op0U] !== undefined && op0U !== '(HL)') {
            return [0xED, 0x40 | (REG8_MAP[op0U] << 3)];
          }
        }
        if (op0U === 'A' && isIndirect(op1)) {
          const n = eval8(op1.slice(1, -1));
          return [0xDB, n];
        }
      }
      throw new Error(`Invalid operands for IN: ${ops.join(', ')}`);
    }

    case 'OUT': {
      if (ops.length === 2) {
        if (op0U === '(C)') {
          if (op1U === '0') return [0xED, 0x71];
          if (REG8_MAP[op1U] !== undefined && op1U !== '(HL)') {
            return [0xED, 0x41 | (REG8_MAP[op1U] << 3)];
          }
        }
        if (isIndirect(op0) && op1U === 'A') {
          const n = eval8(op0.slice(1, -1));
          return [0xD3, n];
        }
      }
      throw new Error(`Invalid operands for OUT: ${ops.join(', ')}`);
    }

    // Z180 Extended Instructions
    case 'IN0': {
      if (ops.length === 2 && isIndirect(op1)) {
        const n = eval8(op1.slice(1, -1));
        if (op0U === 'F') return [0xED, 0x30, n];
        if (REG8_MAP[op0U] !== undefined && op0U !== '(HL)') {
          return [0xED, 0x00 | (REG8_MAP[op0U] << 3), n];
        }
      }
      throw new Error(`Invalid operands for IN0: ${ops.join(', ')}`);
    }

    case 'OUT0': {
      if (ops.length === 2 && isIndirect(op0)) {
        const n = eval8(op0.slice(1, -1));
        if (REG8_MAP[op1U] !== undefined && op1U !== '(HL)') {
          return [0xED, 0x01 | (REG8_MAP[op1U] << 3), n];
        }
      }
      throw new Error(`Invalid operands for OUT0: ${ops.join(', ')}`);
    }

    case 'MLT':
    case 'MULT': {
      if (PAIR_SP_MAP[op0U] !== undefined) {
        return [0xED, 0x4C | (PAIR_SP_MAP[op0U] << 4)];
      }
      throw new Error(`Invalid operand for ${m}: ${op0}`);
    }

    case 'TST': {
      const target = (ops.length === 2 && op0U === 'A') ? op1 : op0;
      const targetU = target.toUpperCase();
      if (REG8_MAP[targetU] !== undefined) {
        return [0xED, 0x04 | (REG8_MAP[targetU] << 3)];
      }
      return [0xED, 0x64, eval8(target)];
    }

    case 'TSTIO': {
      const inner = isIndirect(op0) ? op0.slice(1, -1) : op0;
      return [0xED, 0x74, eval8(inner)];
    }

    case 'IM': {
      const mode = evalFn(op0);
      if (mode === 0) return [0xED, 0x46];
      if (mode === 1) return [0xED, 0x56];
      if (mode === 2) return [0xED, 0x5E];
      throw new Error(`Invalid interrupt mode: ${op0}`);
    }

    default:
      throw new Error(`Unknown mnemonic: ${mnemonic}`);
  }
}

/**
 * Parse a single source line into `{ label, mnemonic, operandsStr, raw }`
 */
function parseSourceLine(rawLine) {
  const noComment = stripComment(rawLine).trim();
  if (!noComment) {
    return { label: null, mnemonic: null, operandsStr: '' };
  }

  let rest = noComment;
  let label = null;

  // Check for colon-delimited label: `Label:` or `@Local:`
  const colonMatch = /^([a-zA-Z_@.][a-zA-Z0-9_@.]*)\s*:\s*(.*)$/.exec(rest);
  if (colonMatch) {
    label = colonMatch[1];
    rest = colonMatch[2].trim();
  } else {
    // Check if first token is an uncoloned label followed by EQU / .EQU / =
    const equMatch = /^([a-zA-Z_@.][a-zA-Z0-9_@.]*)\s+(\.?EQU|=)\s+(.*)$/i.exec(rest);
    if (equMatch) {
      return {
        label: equMatch[1],
        mnemonic: '.EQU',
        operandsStr: equMatch[3].trim(),
      };
    }

    // Check if line starts at column 0 with a non-mnemonic identifier
    if (!/^\s/.test(rawLine)) {
      const firstTokMatch = /^([a-zA-Z_@][a-zA-Z0-9_@]*)(?:\s+(.*))?$/.exec(rest);
      if (firstTokMatch && !MNEMONICS_AND_DIRECTIVES.has(firstTokMatch[1].toUpperCase())) {
        label = firstTokMatch[1];
        rest = (firstTokMatch[2] || '').trim();
      }
    }
  }

  if (!rest) {
    return { label, mnemonic: null, operandsStr: '' };
  }

  const tokMatch = /^([#.]?[a-zA-Z0-9_]+)\s*(.*)$/.exec(rest);
  if (!tokMatch) {
    return { label, mnemonic: rest, operandsStr: '' };
  }

  return {
    label,
    mnemonic: tokMatch[1],
    operandsStr: tokMatch[2].trim(),
  };
}

/**
 * Assemble Z80/Z180 source code
 * @param {string} sourceText
 * @returns {{
 *   ok: boolean,
 *   target: string,
 *   processor: string,
 *   origin: number,
 *   minAddr: number,
 *   maxAddr: number,
 *   byteCount: number,
 *   memory: Uint8Array,
 *   segments: Array<{ addr: number, bytes: number[], lineNumber: number }>,
 *   errors: Array<{ line: number, message: string, source: string }>,
 *   symbols: Array<{ name: string, value: number, type: string }>,
 *   addrToLine: Map<number, number>,
 *   lineToAddr: Map<number, number>,
 *   listingText: string,
 *   intelHex: string,
 *   memoryText: string,
 *   symbolsText: string
 * }}
 */
export function assemble(sourceText) {
  const rawLines = sourceText.replace(/\r\n/g, '\n').split('\n');
  const symbols = new Map();
  const symbolMeta = new Map();
  const errors = [];

  let target = 'Simulated_Z80';
  let processor = 'Z180';
  let firstOrigin = null;

  const runPass = (pass) => {
    let pc = 0x0000;
    let currentScope = 'GLOBAL';
    const condStack = []; // Array of { active: boolean, seenTrue: boolean }
    const lineRecords = [];

    const isCondActive = () => condStack.every((c) => c.active);

    for (let idx = 0; idx < rawLines.length; idx++) {
      const lineNum = idx + 1;
      const rawLine = rawLines[idx];
      const lineAddr = pc & 0xFFFF;

      try {
        const parsed = parseSourceLine(rawLine);
        const mnemU = parsed.mnemonic ? parsed.mnemonic.toUpperCase() : null;

        // Handle conditional assembly directives even when inactive
        if (mnemU === '#IF' || mnemU === '#IFDEF' || mnemU === '#IFNDEF') {
          const parentActive = isCondActive();
          let condVal = false;
          if (parentActive) {
            if (mnemU === '#IFDEF') {
              condVal = symbols.has(parsed.operandsStr.trim().toUpperCase());
            } else if (mnemU === '#IFNDEF') {
              condVal = !symbols.has(parsed.operandsStr.trim().toUpperCase());
            } else {
              condVal = evaluateExpression(parsed.operandsStr, symbols, pc, currentScope, pass) !== 0;
            }
          }
          condStack.push({ active: parentActive && condVal, seenTrue: condVal });
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '#ELSE') {
          if (condStack.length === 0) throw new Error('#ELSE without matching #IF');
          const top = condStack[condStack.length - 1];
          const parentActive = condStack.slice(0, -1).every((c) => c.active);
          top.active = parentActive && !top.seenTrue;
          top.seenTrue = true;
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '#ENDIF') {
          if (condStack.length === 0) throw new Error('#ENDIF without matching #IF');
          condStack.pop();
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }

        if (!isCondActive()) {
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }

        // Record label if present (and not an .EQU which assigns its own value)
        if (parsed.label && mnemU !== '.EQU' && mnemU !== 'EQU' && mnemU !== '=') {
          const lblU = parsed.label.toUpperCase();
          if (lblU.startsWith('@')) {
            const scoped = `${currentScope}${lblU}`;
            symbols.set(scoped, pc & 0xFFFF);
            symbolMeta.set(scoped, { name: `${currentScope}${parsed.label}`, value: pc & 0xFFFF, type: 'LOCAL' });
          } else {
            currentScope = lblU;
            symbols.set(lblU, pc & 0xFFFF);
            symbolMeta.set(lblU, { name: parsed.label, value: pc & 0xFFFF, type: 'ADDR' });
          }
        }

        if (!mnemU) {
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }

        const evalFn = (expr) => evaluateExpression(expr, symbols, pc, currentScope, pass);

        // Directives
        if (mnemU === '#TARGET' || mnemU === '.COMP') {
          target = parsed.operandsStr.trim() || target;
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '.PROC') {
          processor = parsed.operandsStr.trim().toUpperCase() || processor;
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '#DEFINE') {
          const m = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+(.*))?$/.exec(parsed.operandsStr.trim());
          if (m) {
            const key = m[1].toUpperCase();
            const val = m[2] ? evalFn(m[2]) : 1;
            symbols.set(key, val);
            symbolMeta.set(key, { name: m[1], value: val, type: 'DEF' });
          }
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '.ORG' || mnemU === 'ORG') {
          pc = evalFn(parsed.operandsStr) & 0xFFFF;
          if (firstOrigin === null) firstOrigin = pc;
          // If a label was on the same line as .ORG, update it to the new PC
          if (parsed.label) {
            const lblU = parsed.label.toUpperCase();
            symbols.set(lblU, pc);
            symbolMeta.set(lblU, { name: parsed.label, value: pc, type: 'ADDR' });
          }
          lineRecords.push({ lineNum, addr: pc, bytes: [], rawLine, isCode: false });
          continue;
        }
        if (mnemU === '.EQU' || mnemU === 'EQU' || mnemU === '=') {
          if (!parsed.label) throw new Error('.EQU requires a label name');
          const val = evalFn(parsed.operandsStr) & 0xFFFF;
          const lblU = parsed.label.toUpperCase();
          const key = lblU.startsWith('@') ? `${currentScope}${lblU}` : lblU;
          symbols.set(key, val);
          symbolMeta.set(key, { name: parsed.label, value: val, type: 'EQU', eqLine: lineNum });
          lineRecords.push({ lineNum, addr: val, bytes: [], rawLine, isCode: false, isEqu: true });
          continue;
        }
        if (mnemU === '.END' || mnemU === 'END') {
          lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false });
          break;
        }
        if (['.DB', 'DB', 'DEFB', '.BYTE', '.ASCII', '.TEXT'].includes(mnemU)) {
          const items = splitOperands(parsed.operandsStr);
          const bytes = [];
          for (const item of items) {
            if ((item.startsWith('"') && item.endsWith('"')) || (item.startsWith("'") && item.endsWith("'") && item.length > 3)) {
              const inner = item.slice(1, -1);
              for (let c = 0; c < inner.length; c++) {
                if (inner[c] === '\\' && c + 1 < inner.length) {
                  c++;
                  const esc = inner[c];
                  const escMap = { r: 13, n: 10, t: 9, '0': 0, e: 27, '\\': 92, '"': 34, "'": 39 };
                  bytes.push(escMap[esc] !== undefined ? escMap[esc] : esc.charCodeAt(0));
                } else {
                  bytes.push(inner.charCodeAt(c) & 0xFF);
                }
              }
            } else {
              bytes.push(evalFn(item) & 0xFF);
            }
          }
          if (firstOrigin === null) firstOrigin = pc;
          lineRecords.push({ lineNum, addr: pc, bytes, rawLine, isCode: false });
          pc = (pc + bytes.length) & 0xFFFF;
          continue;
        }
        if (['.DW', 'DW', 'DEFW', '.WORD'].includes(mnemU)) {
          const items = splitOperands(parsed.operandsStr);
          const bytes = [];
          for (const item of items) {
            const v = evalFn(item) & 0xFFFF;
            bytes.push(v & 0xFF, (v >> 8) & 0xFF);
          }
          if (firstOrigin === null) firstOrigin = pc;
          lineRecords.push({ lineNum, addr: pc, bytes, rawLine, isCode: false });
          pc = (pc + bytes.length) & 0xFFFF;
          continue;
        }
        if (['.DS', 'DS', 'DEFS', '.BLOCK'].includes(mnemU)) {
          const items = splitOperands(parsed.operandsStr);
          const count = Math.max(0, evalFn(items[0] || '0'));
          const fillVal = items[1] ? (evalFn(items[1]) & 0xFF) : null;
          const bytes = fillVal !== null ? new Array(count).fill(fillVal) : [];
          if (firstOrigin === null) firstOrigin = pc;
          lineRecords.push({ lineNum, addr: pc, bytes, reserveCount: count, rawLine, isCode: false });
          pc = (pc + count) & 0xFFFF;
          continue;
        }
        if (mnemU === '.HEX') {
          const hexClean = parsed.operandsStr.replace(/[^0-9a-fA-F]/g, '');
          const bytes = [];
          for (let h = 0; h + 1 < hexClean.length; h += 2) {
            bytes.push(parseInt(hexClean.slice(h, h + 2), 16));
          }
          if (firstOrigin === null) firstOrigin = pc;
          lineRecords.push({ lineNum, addr: pc, bytes, rawLine, isCode: false });
          pc = (pc + bytes.length) & 0xFFFF;
          continue;
        }

        // Standard Z80 / Z180 instruction
        const ops = splitOperands(parsed.operandsStr);
        const bytes = assembleInstruction(mnemU, ops, evalFn, pc, pass);
        if (firstOrigin === null) firstOrigin = pc;
        lineRecords.push({ lineNum, addr: pc, bytes, rawLine, isCode: true });
        pc = (pc + bytes.length) & 0xFFFF;
      } catch (err) {
        if (pass === 2) {
          errors.push({
            line: lineNum,
            message: err.message || String(err),
            source: rawLine,
          });
        }
        lineRecords.push({ lineNum, addr: lineAddr, bytes: [], rawLine, isCode: false, error: err.message });
      }
    }

    return lineRecords;
  };

  runPass(1);
  const records = runPass(2);

  // Build memory image, segments, and PC <-> Line maps
  const memory = new Uint8Array(65536);
  const writtenMask = new Uint8Array(65536);
  const segments = [];
  const addrToLine = new Map();
  const lineToAddr = new Map();

  let minAddr = 0xFFFF;
  let maxAddr = 0x0000;
  let byteCount = 0;

  for (const rec of records) {
    if (rec.bytes && rec.bytes.length > 0) {
      segments.push({ addr: rec.addr, bytes: rec.bytes, lineNumber: rec.lineNum });
      lineToAddr.set(rec.lineNum, rec.addr);
      if (rec.isCode && !addrToLine.has(rec.addr)) {
        addrToLine.set(rec.addr, rec.lineNum);
      }
      for (let i = 0; i < rec.bytes.length; i++) {
        const a = (rec.addr + i) & 0xFFFF;
        memory[a] = rec.bytes[i] & 0xFF;
        writtenMask[a] = 1;
        if (a < minAddr) minAddr = a;
        if (a > maxAddr) maxAddr = a;
        byteCount++;
      }
    }
  }

  const origin = firstOrigin !== null ? firstOrigin : 0x0000;
  if (byteCount === 0) {
    minAddr = origin;
    maxAddr = origin;
  }

  // Format Listing.txt (SCWorkshop style)
  const listingLines = [
    `; Small Computer Workshop — Assembler Listing`,
    `; Target: ${target} | Processor: ${processor} | Origin: $${hex4(origin)} | Bytes: ${byteCount}`,
    `; ---------------------------------------------------------------------------`,
  ];
  for (const rec of records) {
    const lineStr = String(rec.lineNum).padStart(4, ' ');
    if (rec.isEqu) {
      const addrCol = `=${hex4(rec.addr)}           `;
      listingLines.push(`${addrCol} ${lineStr}  ${rec.rawLine}`);
    } else if (rec.bytes && rec.bytes.length > 0) {
      const first4 = rec.bytes.slice(0, 4).map(hex2).join(' ').padEnd(11, ' ');
      listingLines.push(`${hex4(rec.addr)}: ${first4} ${lineStr}  ${rec.rawLine}`);
      for (let offset = 4; offset < rec.bytes.length; offset += 4) {
        const chunk = rec.bytes.slice(offset, offset + 4).map(hex2).join(' ').padEnd(11, ' ');
        listingLines.push(`${hex4((rec.addr + offset) & 0xFFFF)}: ${chunk}`);
      }
    } else {
      listingLines.push(`                  ${lineStr}  ${rec.rawLine}`);
    }
    if (rec.error) {
      listingLines.push(`  >>> ERROR (Line ${rec.lineNum}): ${rec.error}`);
    }
  }
  const listingText = listingLines.join('\n');

  // Format IntelHex.hex
  const hexLines = [];
  if (byteCount > 0) {
    let addr = minAddr;
    while (addr <= maxAddr) {
      // Find next written byte
      if (!writtenMask[addr]) {
        addr++;
        continue;
      }
      const chunkStart = addr;
      const chunkBytes = [];
      while (addr <= maxAddr && writtenMask[addr] && chunkBytes.length < 16) {
        chunkBytes.push(memory[addr]);
        addr++;
      }
      const len = chunkBytes.length;
      let sum = len + ((chunkStart >> 8) & 0xFF) + (chunkStart & 0xFF);
      const dataHex = chunkBytes.map((b) => {
        sum += b;
        return hex2(b);
      }).join('');
      const checksum = (-sum) & 0xFF;
      hexLines.push(`:${hex2(len)}${hex4(chunkStart)}00${dataHex}${hex2(checksum)}`);
    }
  }
  hexLines.push(':00000001FF');
  const intelHex = hexLines.join('\n');

  // Format Memory.txt
  const memLines = [
    `; Assembled Memory Dump ($${hex4(minAddr)} - $${hex4(maxAddr)})`,
    `ADDR:  +0 +1 +2 +3 +4 +5 +6 +7  +8 +9 +A +B +C +D +E +F  ASCII`,
  ];
  const dumpStart = minAddr & ~0x0F;
  const dumpEnd = Math.min(0xFFFF, (maxAddr | 0x0F));
  for (let row = dumpStart; row <= dumpEnd; row += 16) {
    let hasAny = false;
    for (let c = 0; c < 16; c++) {
      if (writtenMask[row + c]) hasAny = true;
    }
    if (!hasAny && byteCount > 0) continue;
    const cols = [];
    let ascii = '';
    for (let c = 0; c < 16; c++) {
      const a = row + c;
      if (writtenMask[a]) {
        const b = memory[a];
        cols.push(hex2(b));
        ascii += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
      } else {
        cols.push('--');
        ascii += ' ';
      }
    }
    memLines.push(`${hex4(row)}:  ${cols.slice(0, 8).join(' ')}  ${cols.slice(8).join(' ')}  |${ascii}|`);
  }
  const memoryText = memLines.join('\n');

  // Format Symbols.txt
  const symbolList = Array.from(symbolMeta.values()).sort((a, b) => a.name.localeCompare(b.name));
  const symLines = [
    `; Symbol Table (${symbolList.length} symbols)`,
    `SYMBOL                  TYPE    HEX     DEC`,
    `---------------------------------------------`,
    ...symbolList.map((s) => `${s.name.padEnd(22, ' ')}  ${s.type.padEnd(6, ' ')}  $${hex4(s.value)}   ${String(s.value).padStart(5, ' ')}`),
  ];
  const symbolsText = symLines.join('\n');

  return {
    ok: errors.length === 0,
    target,
    processor,
    origin,
    minAddr,
    maxAddr,
    byteCount,
    memory,
    segments,
    errors,
    symbols: symbolList,
    addrToLine,
    lineToAddr,
    listingText,
    intelHex,
    memoryText,
    symbolsText,
  };
}
