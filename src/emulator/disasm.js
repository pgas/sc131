/**
 * Z80 / Z180 Disassembler for SC131 Debugger & Monitor
 * Supports all standard Z80 instructions plus Z180 extended instructions:
 * IN0, OUT0, MLT, TST, TSTIO, OTIM, OTIMR, OTDM, OTDMR, SLP
 */

const REG8 = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
const PAIR_SP = ['BC', 'DE', 'HL', 'SP'];
const PAIR_AF = ['BC', 'DE', 'HL', 'AF'];
const COND = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
const ALU = ['ADD A,', 'ADC A,', 'SUB ', 'SBC A,', 'AND ', 'XOR ', 'OR ', 'CP '];
const CB_ROT = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];

const hex8 = (v) => '$' + (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex16 = (v) => '$' + (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const dispStr = (d) => {
  const s = d < 128 ? d : d - 256;
  return s >= 0 ? `+${s}` : `${s}`;
};

/**
 * Disassemble a single instruction at `addr`
 * @param {(addr: number) => number} readByte
 * @param {number} addr
 * @returns {{ addr: number, bytes: number[], length: number, mnemonic: string }}
 */
export function disassembleOne(readByte, addr) {
  const bytes = [];
  const rb = (offset) => {
    const b = readByte((addr + offset) & 0xFFFF) & 0xFF;
    bytes.push(b);
    return b;
  };

  const op = rb(0);
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  let mnemonic = 'NOP';

  if (x === 0) {
    switch (z) {
      case 0:
        if (y === 0) mnemonic = 'NOP';
        else if (y === 1) mnemonic = "EX AF,AF'";
        else if (y === 2) {
          const d = rb(1);
          const rel = (addr + 2 + (d < 128 ? d : d - 256)) & 0xFFFF;
          mnemonic = `DJNZ ${hex16(rel)}`;
        } else if (y === 3) {
          const d = rb(1);
          const rel = (addr + 2 + (d < 128 ? d : d - 256)) & 0xFFFF;
          mnemonic = `JR ${hex16(rel)}`;
        } else {
          const d = rb(1);
          const rel = (addr + 2 + (d < 128 ? d : d - 256)) & 0xFFFF;
          mnemonic = `JR ${COND[y - 4]},${hex16(rel)}`;
        }
        break;
      case 1:
        if ((y & 1) === 0) {
          const nn = rb(1) | (rb(2) << 8);
          mnemonic = `LD ${PAIR_SP[y >> 1]},${hex16(nn)}`;
        } else {
          mnemonic = `ADD HL,${PAIR_SP[y >> 1]}`;
        }
        break;
      case 2:
        switch (y) {
          case 0: mnemonic = 'LD (BC),A'; break;
          case 1: mnemonic = 'LD A,(BC)'; break;
          case 2: mnemonic = 'LD (DE),A'; break;
          case 3: mnemonic = 'LD A,(DE)'; break;
          case 4: { const nn = rb(1) | (rb(2) << 8); mnemonic = `LD (${hex16(nn)}),HL`; break; }
          case 5: { const nn = rb(1) | (rb(2) << 8); mnemonic = `LD HL,(${hex16(nn)})`; break; }
          case 6: { const nn = rb(1) | (rb(2) << 8); mnemonic = `LD (${hex16(nn)}),A`; break; }
          case 7: { const nn = rb(1) | (rb(2) << 8); mnemonic = `LD A,(${hex16(nn)})`; break; }
        }
        break;
      case 3:
        mnemonic = `${(y & 1) ? 'DEC' : 'INC'} ${PAIR_SP[y >> 1]}`;
        break;
      case 4:
        mnemonic = `INC ${REG8[y]}`;
        break;
      case 5:
        mnemonic = `DEC ${REG8[y]}`;
        break;
      case 6: {
        const n = rb(1);
        mnemonic = `LD ${REG8[y]},${hex8(n)}`;
        break;
      }
      case 7:
        mnemonic = ['RLCA', 'RRCA', 'RLA', 'RRA', 'DAA', 'CPL', 'SCF', 'CCF'][y];
        break;
    }
  } else if (x === 1) {
    if (op === 0x76) mnemonic = 'HALT';
    else mnemonic = `LD ${REG8[y]},${REG8[z]}`;
  } else if (x === 2) {
    mnemonic = `${ALU[y]}${REG8[z]}`;
  } else {
    switch (z) {
      case 0:
        mnemonic = `RET ${COND[y]}`;
        break;
      case 1:
        if ((y & 1) === 0) mnemonic = `POP ${PAIR_AF[y >> 1]}`;
        else mnemonic = ['RET', 'EXX', 'JP (HL)', 'LD SP,HL'][y >> 1];
        break;
      case 2: {
        const nn = rb(1) | (rb(2) << 8);
        mnemonic = `JP ${COND[y]},${hex16(nn)}`;
        break;
      }
      case 3:
        switch (y) {
          case 0: { const nn = rb(1) | (rb(2) << 8); mnemonic = `JP ${hex16(nn)}`; break; }
          case 1: {
            const cb = rb(1);
            const cx = (cb >> 6) & 3;
            const cy = (cb >> 3) & 7;
            const cz = cb & 7;
            if (cx === 0) mnemonic = `${CB_ROT[cy]} ${REG8[cz]}`;
            else if (cx === 1) mnemonic = `BIT ${cy},${REG8[cz]}`;
            else if (cx === 2) mnemonic = `RES ${cy},${REG8[cz]}`;
            else mnemonic = `SET ${cy},${REG8[cz]}`;
            break;
          }
          case 2: mnemonic = `OUT (${hex8(rb(1))}),A`; break;
          case 3: mnemonic = `IN A,(${hex8(rb(1))})`; break;
          case 4: mnemonic = 'EX (SP),HL'; break;
          case 5: mnemonic = 'EX DE,HL'; break;
          case 6: mnemonic = 'DI'; break;
          case 7: mnemonic = 'EI'; break;
        }
        break;
      case 4: {
        const nn = rb(1) | (rb(2) << 8);
        mnemonic = `CALL ${COND[y]},${hex16(nn)}`;
        break;
      }
      case 5:
        if ((y & 1) === 0) {
          mnemonic = `PUSH ${PAIR_AF[y >> 1]}`;
        } else {
          switch (y >> 1) {
            case 0: { const nn = rb(1) | (rb(2) << 8); mnemonic = `CALL ${hex16(nn)}`; break; }
            case 1: mnemonic = disasmIndex(rb, 'IX'); break;
            case 2: mnemonic = disasmED(rb); break;
            case 3: mnemonic = disasmIndex(rb, 'IY'); break;
          }
        }
        break;
      case 6:
        mnemonic = `${ALU[y]}${hex8(rb(1))}`;
        break;
      case 7:
        mnemonic = `RST ${hex8(y << 3)}`;
        break;
    }
  }

  return {
    addr: addr & 0xFFFF,
    bytes,
    length: bytes.length,
    mnemonic,
  };
}

function disasmED(rb) {
  const op = rb(1);
  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  if (x === 0) {
    if (z === 0) {
      const n = rb(2);
      return `IN0 ${y === 6 ? 'F' : REG8[y]},(${hex8(n)})`;
    }
    if (z === 1) {
      const n = rb(2);
      return `OUT0 (${hex8(n)}),${y === 6 ? '0' : REG8[y]}`;
    }
    if (z === 4) {
      return `TST ${REG8[y]}`;
    }
    return `DB $ED,${hex8(op)}`;
  }

  if (x === 1) {
    switch (z) {
      case 0: return `IN ${y === 6 ? 'F' : REG8[y]},(C)`;
      case 1: return `OUT (C),${y === 6 ? '0' : REG8[y]}`;
      case 2: return `${(y & 1) ? 'ADC' : 'SBC'} HL,${PAIR_SP[y >> 1]}`;
      case 3: {
        const nn = rb(2) | (rb(3) << 8);
        return (y & 1)
          ? `LD ${PAIR_SP[y >> 1]},(${hex16(nn)})`
          : `LD (${hex16(nn)}),${PAIR_SP[y >> 1]}`;
      }
      case 4:
        if (op === 0x64) return `TST ${hex8(rb(2))}`;
        if (op === 0x74) return `TSTIO ${hex8(rb(2))}`;
        if (y & 1) return `MLT ${PAIR_SP[y >> 1]}`;
        return 'NEG';
      case 5: return op === 0x4D ? 'RETI' : 'RETN';
      case 6:
        if (op === 0x76) return 'SLP';
        return `IM ${(y & 3) === 2 ? 1 : (y & 3) === 3 ? 2 : 0}`;
      case 7:
        return ['LD I,A', 'LD R,A', 'LD A,I', 'LD A,R', 'RRD', 'RLD', 'NOP', 'NOP'][y];
    }
  }

  if (x === 2) {
    const edOps = {
      0x83: 'OTIM',  0x8B: 'OTDM',  0x93: 'OTIMR', 0x9B: 'OTDMR',
      0xA0: 'LDI',   0xA1: 'CPI',   0xA2: 'INI',   0xA3: 'OUTI',
      0xA8: 'LDD',   0xA9: 'CPD',   0xAA: 'IND',   0xAB: 'OUTD',
      0xB0: 'LDIR',  0xB1: 'CPIR',  0xB2: 'INIR',  0xB3: 'OTIR',
      0xB8: 'LDDR',  0xB9: 'CPDR',  0xBA: 'INDR',  0xBB: 'OTDR',
    };
    if (edOps[op]) return edOps[op];
  }

  return `DB $ED,${hex8(op)}`;
}

function disasmIndex(rb, regName) {
  const op = rb(1);
  if (op === 0xCB) {
    const d = rb(2);
    const sub = rb(3);
    const cx = (sub >> 6) & 3;
    const cy = (sub >> 3) & 7;
    const mem = `(${regName}${dispStr(d)})`;
    if (cx === 0) return `${CB_ROT[cy]} ${mem}`;
    if (cx === 1) return `BIT ${cy},${mem}`;
    if (cx === 2) return `RES ${cy},${mem}`;
    return `SET ${cy},${mem}`;
  }

  switch (op) {
    case 0x09: return `ADD ${regName},BC`;
    case 0x19: return `ADD ${regName},DE`;
    case 0x29: return `ADD ${regName},${regName}`;
    case 0x39: return `ADD ${regName},SP`;
    case 0x21: { const nn = rb(2) | (rb(3) << 8); return `LD ${regName},${hex16(nn)}`; }
    case 0x22: { const nn = rb(2) | (rb(3) << 8); return `LD (${hex16(nn)}),${regName}`; }
    case 0x23: return `INC ${regName}`;
    case 0x2A: { const nn = rb(2) | (rb(3) << 8); return `LD ${regName},(${hex16(nn)})`; }
    case 0x2B: return `DEC ${regName}`;
    case 0x34: return `INC (${regName}${dispStr(rb(2))})`;
    case 0x35: return `DEC (${regName}${dispStr(rb(2))})`;
    case 0x36: { const d = rb(2); const n = rb(3); return `LD (${regName}${dispStr(d)}),${hex8(n)}`; }
    case 0xE1: return `POP ${regName}`;
    case 0xE3: return `EX (SP),${regName}`;
    case 0xE5: return `PUSH ${regName}`;
    case 0xE9: return `JP (${regName})`;
    case 0xF9: return `LD SP,${regName}`;
  }

  const x = (op >> 6) & 3;
  const y = (op >> 3) & 7;
  const z = op & 7;

  if (x === 1 && op !== 0x76) {
    if (y === 6) return `LD (${regName}${dispStr(rb(2))}),${REG8[z]}`;
    if (z === 6) return `LD ${REG8[y]},(${regName}${dispStr(rb(2))})`;
  }
  if (x === 2 && z === 6) {
    return `${ALU[y]}(${regName}${dispStr(rb(2))})`;
  }

  return `DB ${regName === 'IX' ? '$DD' : '$FD'},${hex8(op)}`;
}

/**
 * Disassemble `count` instructions starting at `startAddr`
 */
export function disassembleRange(readByte, startAddr, count = 12) {
  const list = [];
  let cur = startAddr & 0xFFFF;
  for (let i = 0; i < count; i++) {
    const item = disassembleOne(readByte, cur);
    list.push(item);
    cur = (cur + item.length) & 0xFFFF;
  }
  return list;
}
