/**
 * Zilog Z8S180 (Z180 Rev. N) CPU & On-Chip Peripherals Emulator
 * Designed for the Small Computer Central SC131 Pocket Computer (18.432 MHz)
 *
 * Implements:
 *  - Full Z80 instruction set (including IXH/IXL/IYH/IYL and undocumented flags)
 *  - Full Z180 extended instruction set (IN0, OUT0, MLT, TST, TSTIO, OTIM, OTIMR, OTDM, OTDMR, SLP)
 *  - On-chip Memory Management Unit (MMU: CBR, BBR, CBAR -> 20-bit 1MB physical address space)
 *  - Dual Asynchronous Serial Communication Interfaces (ASCI0, ASCI1 w/ BRG)
 *  - Clocked Serial I/O Port (CSI/O: CNTR, TRDR with hardware LSB-first shift register)
 *  - Dual 16-bit Programmable Reload Timers (PRT0, PRT1: TMDR, RLDR, TCR, FRC)
 *  - Dual DMA Channels (DMA0, DMA1)
 *  - Z180 Vectored Interrupt Controller (IL, ITC, internal peripheral vectors)
 */

export const FLAG_C  = 0x01;
export const FLAG_N  = 0x02;
export const FLAG_PV = 0x04;
export const FLAG_X  = 0x08;
export const FLAG_H  = 0x10;
export const FLAG_Y  = 0x20;
export const FLAG_Z  = 0x40;
export const FLAG_S  = 0x80;

const sz53Table = new Uint8Array(256);
const sz53pTable = new Uint8Array(256);
const parityTable = new Uint8Array(256);

for (let i = 0; i < 256; i++) {
  let p = 0;
  for (let b = 0; b < 8; b++) {
    if (i & (1 << b)) p++;
  }
  const even = (p & 1) === 0 ? FLAG_PV : 0;
  parityTable[i] = even;
  const sz53 = (i & (FLAG_S | FLAG_Y | FLAG_X)) | (i === 0 ? FLAG_Z : 0);
  sz53Table[i] = sz53;
  sz53pTable[i] = sz53 | even;
}

// Bit-reversal table for Z180 CSI/O (which transmits/receives LSB-first)
const bitReverseTable = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  let r = 0;
  for (let b = 0; b < 8; b++) {
    if (i & (1 << b)) r |= 1 << (7 - b);
  }
  bitReverseTable[i] = r;
}

// Z180 Internal I/O Register Offsets (relative to ICR base)
export const Z180_REG = {
  CNTLA0: 0x00,
  CNTLA1: 0x01,
  CNTLB0: 0x02,
  CNTLB1: 0x03,
  STAT0:  0x04,
  STAT1:  0x05,
  TDR0:   0x06,
  TDR1:   0x07,
  RDR0:   0x08,
  RDR1:   0x09,
  CNTR:   0x0A,
  TRDR:   0x0B,
  TMDR0L: 0x0C,
  TMDR0H: 0x0D,
  RLDR0L: 0x0E,
  RLDR0H: 0x0F,
  TCR:    0x10,
  ASEXT0: 0x12,
  ASEXT1: 0x13,
  TMDR1L: 0x14,
  TMDR1H: 0x15,
  RLDR1L: 0x16,
  RLDR1H: 0x17,
  FRC:    0x18,
  ASTC0L: 0x1A,
  ASTC0H: 0x1B,
  ASTC1L: 0x1C,
  ASTC1H: 0x1D,
  CMR:    0x1E,
  CCR:    0x1F,
  SAR0L:  0x20,
  SAR0H:  0x21,
  SAR0B:  0x22,
  DAR0L:  0x23,
  DAR0H:  0x24,
  DAR0B:  0x25,
  BCR0L:  0x26,
  BCR0H:  0x27,
  MAR1L:  0x28,
  MAR1H:  0x29,
  MAR1B:  0x2A,
  IAR1L:  0x2B,
  IAR1H:  0x2C,
  IAR1B:  0x2D,
  BCR1L:  0x2E,
  BCR1H:  0x2F,
  DSTAT:  0x30,
  DMODE:  0x31,
  DCNTL:  0x32,
  IL:     0x33,
  ITC:    0x34,
  RCR:    0x36,
  CBR:    0x38,
  BBR:    0x39,
  CBAR:   0x3A,
  OMCR:   0x3E,
  ICR:    0x3F,
};

export class Z180 {
  /**
   * @param {object} bus
   * @param {(physAddr: number) => number} bus.readPhysMem
   * @param {(physAddr: number, val: number) => void} bus.writePhysMem
   * @param {(port: number) => number} bus.readExtIO
   * @param {(port: number, val: number) => void} bus.writeExtIO
   * @param {(ch: number, byte: number) => void} [bus.onSerialTx]
   * @param {(byte: number) => number} [bus.onCsioTx]
   * @param {() => number} [bus.onCsioRx]
   */
  constructor(bus) {
    this.bus = bus;
    this.xtalHz = 18432000;
    this.ioRegs = new Uint8Array(64);
    this.rxQueue = [[], []];
    this.reset();
  }

  reset() {
    // Main registers
    this.a = 0xFF;
    this.f = 0xFF;
    this.b = 0xFF;
    this.c = 0xFF;
    this.d = 0xFF;
    this.e = 0xFF;
    this.h = 0xFF;
    this.l = 0xFF;

    // Alternate registers
    this.a_ = 0xFF;
    this.f_ = 0xFF;
    this.b_ = 0xFF;
    this.c_ = 0xFF;
    this.d_ = 0xFF;
    this.e_ = 0xFF;
    this.h_ = 0xFF;
    this.l_ = 0xFF;

    // Index & control registers
    this.ix = 0xFFFF;
    this.iy = 0xFFFF;
    this.sp = 0xFFFF;
    this.pc = 0x0000;
    this.i = 0x00;
    this.r = 0x00;
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.halted = false;
    this.eiPending = false;
    this.int0Line = false;

    this.cycles = 0;
    this.prtCycleAccum = 0;
    this.tcrReadWithTif0 = false;
    this.tcrReadWithTif1 = false;

    this.rxQueue[0].length = 0;
    this.rxQueue[1].length = 0;
    this.rxNextReadyCycle = [0, 0];

    // Initialize Z180 internal I/O registers to hardware reset defaults
    this.ioRegs.fill(0x00);
    this.ioRegs[Z180_REG.CNTLA0] = 0x64;
    this.ioRegs[Z180_REG.CNTLA1] = 0x64;
    this.ioRegs[Z180_REG.CNTLB0] = 0x20;
    this.ioRegs[Z180_REG.CNTLB1] = 0x20;
    this.ioRegs[Z180_REG.STAT0]  = 0x02; // TDRE=1
    this.ioRegs[Z180_REG.STAT1]  = 0x02; // TDRE=1
    this.ioRegs[Z180_REG.CNTR]   = 0x07;
    this.ioRegs[Z180_REG.ASEXT0] = 0x60;
    this.ioRegs[Z180_REG.ASEXT1] = 0x60;
    this.ioRegs[Z180_REG.FRC]    = 0xFF;
    this.ioRegs[Z180_REG.DSTAT]  = 0x30;
    this.ioRegs[Z180_REG.DCNTL]  = 0xF0;
    this.ioRegs[Z180_REG.ITC]    = 0x01;
    this.ioRegs[Z180_REG.RCR]    = 0xFC;
    this.ioRegs[Z180_REG.CBR]    = 0x00;
    this.ioRegs[Z180_REG.BBR]    = 0x00;
    this.ioRegs[Z180_REG.CBAR]   = 0xF0;
    this.ioRegs[Z180_REG.OMCR]   = 0xE0;
    this.ioRegs[Z180_REG.ICR]    = 0x00;
  }

  /**
   * Effective CPU clock (PHI) in Hz based on X1 oscillator, CCR (divide), and CMR (multiply)
   */
  getPhiHz() {
    const ccr = this.ioRegs[Z180_REG.CCR];
    const cmr = this.ioRegs[Z180_REG.CMR];
    if (cmr & 0x80) return this.xtalHz * 2;
    if (ccr & 0x80) return this.xtalHz;
    return this.xtalHz >> 1;
  }

  /**
   * Translate 16-bit logical address (0x0000-0xFFFF) to 20-bit physical address (0x00000-0xFFFFF)
   * using Z180 MMU registers CBAR, CBR, and BBR.
   */
  translateAddress(logicalAddr) {
    const addr = logicalAddr & 0xFFFF;
    const cbar = this.ioRegs[Z180_REG.CBAR];
    const caBase = (cbar & 0xF0) << 8;
    const baBase = (cbar & 0x0F) << 12;

    if (addr >= caBase) {
      // Common Area 1
      return (addr + (this.ioRegs[Z180_REG.CBR] << 12)) & 0xFFFFF;
    } else if (addr >= baBase) {
      // Bank Area
      return (addr + (this.ioRegs[Z180_REG.BBR] << 12)) & 0xFFFFF;
    } else {
      // Common Area 0
      return addr;
    }
  }

  memRead(addr) {
    return this.bus.readPhysMem(this.translateAddress(addr)) & 0xFF;
  }

  memWrite(addr, val) {
    this.bus.writePhysMem(this.translateAddress(addr), val & 0xFF);
  }

  memRead16(addr) {
    const lo = this.memRead(addr);
    const hi = this.memRead((addr + 1) & 0xFFFF);
    return lo | (hi << 8);
  }

  memWrite16(addr, val) {
    this.memWrite(addr, val & 0xFF);
    this.memWrite((addr + 1) & 0xFFFF, (val >> 8) & 0xFF);
  }

  fetch8() {
    const val = this.memRead(this.pc);
    this.pc = (this.pc + 1) & 0xFFFF;
    return val;
  }

  fetch16() {
    const lo = this.fetch8();
    const hi = this.fetch8();
    return lo | (hi << 8);
  }

  fetchDisp() {
    const d = this.fetch8();
    return d < 128 ? d : d - 256;
  }

  push16(val) {
    this.sp = (this.sp - 1) & 0xFFFF;
    this.memWrite(this.sp, (val >> 8) & 0xFF);
    this.sp = (this.sp - 1) & 0xFFFF;
    this.memWrite(this.sp, val & 0xFF);
  }

  pop16() {
    const lo = this.memRead(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    const hi = this.memRead(this.sp);
    this.sp = (this.sp + 1) & 0xFFFF;
    return lo | (hi << 8);
  }

  incR() {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7F);
  }

  /**
   * Queue an incoming serial byte on ASCI0 (ch=0) or ASCI1 (ch=1)
   */
  receiveSerial(ch, byte) {
    const idx = ch & 1;
    this.rxQueue[idx].push(byte & 0xFF);
    const statReg = idx === 0 ? Z180_REG.STAT0 : Z180_REG.STAT1;
    this.ioRegs[statReg] |= 0x80; // RDRF = 1
  }

  /**
   * Check if port (with high byte) targets Z180 internal I/O space
   */
  isInternalIO(portLo, portHi) {
    const ioBase = this.ioRegs[Z180_REG.ICR] & 0xC0;
    const p = portLo & 0xFF;
    return (p & 0xC0) === ioBase && (portHi === 0x00 || (this.ioRegs[Z180_REG.ICR] & 0x20) === 0);
  }

  ioRead(portLo, portHi = 0x00) {
    const p = portLo & 0xFF;
    if (this.isInternalIO(p, portHi)) {
      const reg = p & 0x3F;
      return this.readInternalReg(reg);
    }
    return this.bus.readExtIO(p) & 0xFF;
  }

  ioWrite(portLo, val, portHi = 0x00) {
    const p = portLo & 0xFF;
    const v = val & 0xFF;
    if (this.isInternalIO(p, portHi)) {
      const reg = p & 0x3F;
      this.writeInternalReg(reg, v);
      return;
    }
    this.bus.writeExtIO(p, v);
  }

  readInternalReg(reg) {
    switch (reg) {
      case Z180_REG.CNTLB0:
      case Z180_REG.CNTLB1:
        // Bit 5 when read is /CTS (0 = CTS asserted)
        return this.ioRegs[reg] & ~0x20;

      case Z180_REG.STAT0: {
        if (this.rxQueue[0].length > 0 && this.cycles >= this.rxNextReadyCycle[0]) {
          this.ioRegs[Z180_REG.STAT0] |= 0x80;
        } else {
          this.ioRegs[Z180_REG.STAT0] &= ~0x80;
        }
        this.ioRegs[Z180_REG.STAT0] |= 0x02; // TDRE always ready
        this.ioRegs[Z180_REG.STAT0] &= ~0x04; // /DCD0 active low (0)
        return this.ioRegs[Z180_REG.STAT0];
      }

      case Z180_REG.STAT1: {
        if (this.rxQueue[1].length > 0 && this.cycles >= this.rxNextReadyCycle[1]) {
          this.ioRegs[Z180_REG.STAT1] |= 0x80;
        } else {
          this.ioRegs[Z180_REG.STAT1] &= ~0x80;
        }
        this.ioRegs[Z180_REG.STAT1] |= 0x02; // TDRE always ready
        return this.ioRegs[Z180_REG.STAT1];
      }

      case Z180_REG.RDR0: {
        const ch = this.rxQueue[0].length > 0 ? this.rxQueue[0].shift() : this.ioRegs[Z180_REG.RDR0];
        this.ioRegs[Z180_REG.RDR0] = ch;
        this.ioRegs[Z180_REG.STAT0] &= ~0x80;
        this.rxNextReadyCycle[0] = this.cycles + (ch === 0x0D ? 220000 : 4500);
        return ch;
      }

      case Z180_REG.RDR1: {
        const ch = this.rxQueue[1].length > 0 ? this.rxQueue[1].shift() : this.ioRegs[Z180_REG.RDR1];
        this.ioRegs[Z180_REG.RDR1] = ch;
        this.ioRegs[Z180_REG.STAT1] &= ~0x80;
        this.rxNextReadyCycle[1] = this.cycles + (ch === 0x0D ? 220000 : 4500);
        return ch;
      }

      case Z180_REG.TRDR: {
        this.ioRegs[Z180_REG.CNTR] &= ~0x80; // Clear EF
        return this.ioRegs[Z180_REG.TRDR];
      }

      case Z180_REG.TCR: {
        const tcr = this.ioRegs[Z180_REG.TCR];
        if (tcr & 0x40) this.tcrReadWithTif0 = true;
        if (tcr & 0x80) this.tcrReadWithTif1 = true;
        return tcr;
      }

      case Z180_REG.TMDR0L:
      case Z180_REG.TMDR0H: {
        if (this.tcrReadWithTif0) {
          this.ioRegs[Z180_REG.TCR] &= ~0x40; // Clear TIF0
          this.tcrReadWithTif0 = false;
        }
        return this.ioRegs[reg];
      }

      case Z180_REG.TMDR1L:
      case Z180_REG.TMDR1H: {
        if (this.tcrReadWithTif1) {
          this.ioRegs[Z180_REG.TCR] &= ~0x80; // Clear TIF1
          this.tcrReadWithTif1 = false;
        }
        return this.ioRegs[reg];
      }

      default:
        return this.ioRegs[reg];
    }
  }

  writeInternalReg(reg, val) {
    switch (reg) {
      case Z180_REG.CNTLA0:
        this.ioRegs[reg] = val;
        if ((val & 0x08) === 0) {
          // EFR = 0 clears error flags in STAT0
          this.ioRegs[Z180_REG.STAT0] &= ~0x70;
        }
        break;

      case Z180_REG.CNTLA1:
        this.ioRegs[reg] = val;
        if ((val & 0x08) === 0) {
          this.ioRegs[Z180_REG.STAT1] &= ~0x70;
        }
        break;

      case Z180_REG.STAT0:
      case Z180_REG.STAT1:
        // Only bits 3 (RIE), 2 (CTS1E on STAT1), and 0 (TIE) are writable
        this.ioRegs[reg] = (this.ioRegs[reg] & 0xF2) | (val & 0x0D);
        break;

      case Z180_REG.TDR0:
        this.ioRegs[reg] = val;
        if (this.bus.onSerialTx) this.bus.onSerialTx(0, val);
        break;

      case Z180_REG.TDR1:
        this.ioRegs[reg] = val;
        if (this.bus.onSerialTx) this.bus.onSerialTx(1, val);
        break;

      case Z180_REG.TRDR:
        this.ioRegs[reg] = val;
        this.ioRegs[Z180_REG.CNTR] &= ~0x80; // Clear EF
        break;

      case Z180_REG.CNTR: {
        // CSI/O Control Register
        this.ioRegs[reg] = val;
        if (val & 0x10) {
          // TE (Transmit Enable): Z180 shifts TRDR LSB-first out to SPI
          // Since RomWBW mirrors bits in software before writing TRDR,
          // we reverse the bits back to MSB-first for the SPI peripheral.
          const spiOut = bitReverseTable[this.ioRegs[Z180_REG.TRDR]];
          if (this.bus.onCsioTx) {
            this.bus.onCsioTx(spiOut);
          }
          // Transfer complete: clear TE (bit 4), set EF (bit 7)
          this.ioRegs[Z180_REG.CNTR] = (this.ioRegs[Z180_REG.CNTR] & ~0x10) | 0x80;
        }
        if (val & 0x20) {
          // RE (Receive Enable): Z180 shifts byte in from SPI LSB-first
          const spiIn = this.bus.onCsioRx ? (this.bus.onCsioRx() & 0xFF) : 0xFF;
          this.ioRegs[Z180_REG.TRDR] = bitReverseTable[spiIn];
          // Transfer complete: clear RE (bit 5), set EF (bit 7)
          this.ioRegs[Z180_REG.CNTR] = (this.ioRegs[Z180_REG.CNTR] & ~0x20) | 0x80;
        }
        break;
      }

      case Z180_REG.TCR:
        // Bits 7 and 6 (TIF1, TIF0) are read-only status bits
        this.ioRegs[Z180_REG.TCR] = (this.ioRegs[Z180_REG.TCR] & 0xC0) | (val & 0x3F);
        break;

      case Z180_REG.DSTAT: {
        // Handle DMA0 enable if requested
        this.ioRegs[reg] = val;
        if ((val & 0x50) === 0x40) {
          // DE0 = 1 and /DWE0 = 0
          this.runDma0();
        }
        break;
      }

      case Z180_REG.IL:
        this.ioRegs[reg] = val & 0xE0;
        break;

      default:
        this.ioRegs[reg] = val;
        break;
    }
  }

  runDma0() {
    let sar = this.ioRegs[Z180_REG.SAR0L] | (this.ioRegs[Z180_REG.SAR0H] << 8) | ((this.ioRegs[Z180_REG.SAR0B] & 0x0F) << 16);
    let dar = this.ioRegs[Z180_REG.DAR0L] | (this.ioRegs[Z180_REG.DAR0H] << 8) | ((this.ioRegs[Z180_REG.DAR0B] & 0x0F) << 16);
    let bcr = this.ioRegs[Z180_REG.BCR0L] | (this.ioRegs[Z180_REG.BCR0H] << 8);
    if (bcr === 0) bcr = 0x10000;
    const dmode = this.ioRegs[Z180_REG.DMODE];
    const sm = (dmode >> 2) & 0x03;
    const dm = (dmode >> 4) & 0x03;

    while (bcr > 0) {
      const byte = sm === 3 ? this.ioRead(sar & 0xFF, (sar >> 8) & 0xFF) : this.bus.readPhysMem(sar & 0xFFFFF);
      if (dm === 3) {
        this.ioWrite(dar & 0xFF, byte, (dar >> 8) & 0xFF);
      } else {
        this.bus.writePhysMem(dar & 0xFFFFF, byte);
      }
      if (sm === 0) sar = (sar + 1) & 0xFFFFF;
      else if (sm === 1) sar = (sar - 1) & 0xFFFFF;
      if (dm === 0) dar = (dar + 1) & 0xFFFFF;
      else if (dm === 1) dar = (dar - 1) & 0xFFFFF;
      bcr--;
    }

    this.ioRegs[Z180_REG.SAR0L] = sar & 0xFF;
    this.ioRegs[Z180_REG.SAR0H] = (sar >> 8) & 0xFF;
    this.ioRegs[Z180_REG.SAR0B] = (sar >> 16) & 0x0F;
    this.ioRegs[Z180_REG.DAR0L] = dar & 0xFF;
    this.ioRegs[Z180_REG.DAR0H] = (dar >> 8) & 0xFF;
    this.ioRegs[Z180_REG.DAR0B] = (dar >> 16) & 0x0F;
    this.ioRegs[Z180_REG.BCR0L] = 0;
    this.ioRegs[Z180_REG.BCR0H] = 0;
    this.ioRegs[Z180_REG.DSTAT] &= ~0x40; // Clear DE0
  }

  /**
   * Advance PRT0, PRT1, and FRC timers by `tStates` CPU cycles
   */
  stepTimers(tStates) {
    this.prtCycleAccum += tStates;
    if (this.prtCycleAccum < 20) return;

    const ticks = (this.prtCycleAccum / 20) | 0;
    this.prtCycleAccum -= ticks * 20;

    // Free running counter
    this.ioRegs[Z180_REG.FRC] = (this.ioRegs[Z180_REG.FRC] - ticks) & 0xFF;

    const tcr = this.ioRegs[Z180_REG.TCR];

    // PRT0
    if (tcr & 0x01) {
      let tmdr0 = this.ioRegs[Z180_REG.TMDR0L] | (this.ioRegs[Z180_REG.TMDR0H] << 8);
      tmdr0 -= ticks;
      if (tmdr0 < 0) {
        const rldr0 = this.ioRegs[Z180_REG.RLDR0L] | (this.ioRegs[Z180_REG.RLDR0H] << 8);
        const period = rldr0 + 1;
        tmdr0 = ((tmdr0 % period) + period) % period;
        this.ioRegs[Z180_REG.TCR] |= 0x40; // Set TIF0
      }
      this.ioRegs[Z180_REG.TMDR0L] = tmdr0 & 0xFF;
      this.ioRegs[Z180_REG.TMDR0H] = (tmdr0 >> 8) & 0xFF;
    }

    // PRT1
    if (tcr & 0x02) {
      let tmdr1 = this.ioRegs[Z180_REG.TMDR1L] | (this.ioRegs[Z180_REG.TMDR1H] << 8);
      tmdr1 -= ticks;
      if (tmdr1 < 0) {
        const rldr1 = this.ioRegs[Z180_REG.RLDR1L] | (this.ioRegs[Z180_REG.RLDR1H] << 8);
        const period = rldr1 + 1;
        tmdr1 = ((tmdr1 % period) + period) % period;
        this.ioRegs[Z180_REG.TCR] |= 0x80; // Set TIF1
      }
      this.ioRegs[Z180_REG.TMDR1L] = tmdr1 & 0xFF;
      this.ioRegs[Z180_REG.TMDR1H] = (tmdr1 >> 8) & 0xFF;
    }
  }

  /**
   * Check and service pending Z180 internal or external interrupts
   */
  checkInterrupts() {
    if (!this.iff1 || this.eiPending) return 0;

    // 1. External INT0 (if enabled in ITC bit 0)
    if (this.int0Line && (this.ioRegs[Z180_REG.ITC] & 0x01)) {
      this.halted = false;
      this.iff1 = false;
      this.iff2 = false;
      this.incR();
      if (this.im === 2) {
        const vecAddr = (this.i << 8) | 0xFF;
        const target = this.memRead16(vecAddr);
        this.push16(this.pc);
        this.pc = target;
        return 19;
      } else {
        this.push16(this.pc);
        this.pc = 0x0038;
        return 13;
      }
    }

    // 2. Z180 Internal Vectored Interrupts
    // Vector table address = (I << 8) | (IL & 0xE0) | offset
    const tcr = this.ioRegs[Z180_REG.TCR];
    let vecOffset = -1;

    // Priority order: PRT0 (0x04), PRT1 (0x06), DMA0 (0x08), DMA1 (0x0A), CSIO (0x0C), ASCI0 (0x0E), ASCI1 (0x10)
    if ((tcr & 0x50) === 0x50) {
      // TIF0 (bit 6) & TIE0 (bit 4)
      vecOffset = 0x04;
    } else if ((tcr & 0xA0) === 0xA0) {
      // TIF1 (bit 7) & TIE1 (bit 5)
      vecOffset = 0x06;
    } else if ((this.ioRegs[Z180_REG.CNTR] & 0xC0) === 0xC0) {
      // CSIO EF (bit 7) & EIE (bit 6)
      vecOffset = 0x0C;
    } else {
      // Check ASCI0
      const stat0 = this.readInternalReg(Z180_REG.STAT0);
      if (((stat0 & 0x80) && (stat0 & 0x08)) || ((stat0 & 0x02) && (stat0 & 0x01))) {
        vecOffset = 0x0E;
      } else {
        // Check ASCI1
        const stat1 = this.readInternalReg(Z180_REG.STAT1);
        if (((stat1 & 0x80) && (stat1 & 0x08)) || ((stat1 & 0x02) && (stat1 & 0x01))) {
          vecOffset = 0x10;
        }
      }
    }

    if (vecOffset >= 0) {
      this.halted = false;
      this.iff1 = false;
      this.iff2 = false;
      this.incR();
      const il = this.ioRegs[Z180_REG.IL] & 0xE0;
      const vecAddr = (this.i << 8) | il | vecOffset;
      const target = this.memRead16(vecAddr);
      this.push16(this.pc);
      this.pc = target;
      return 19;
    }

    return 0;
  }

  // Register pair helpers
  getAF() { return (this.a << 8) | this.f; }
  setAF(v) { this.a = (v >> 8) & 0xFF; this.f = v & 0xFF; }
  getBC() { return (this.b << 8) | this.c; }
  setBC(v) { this.b = (v >> 8) & 0xFF; this.c = v & 0xFF; }
  getDE() { return (this.d << 8) | this.e; }
  setDE(v) { this.d = (v >> 8) & 0xFF; this.e = v & 0xFF; }
  getHL() { return (this.h << 8) | this.l; }
  setHL(v) { this.h = (v >> 8) & 0xFF; this.l = v & 0xFF; }

  getReg8(idx) {
    switch (idx & 7) {
      case 0: return this.b;
      case 1: return this.c;
      case 2: return this.d;
      case 3: return this.e;
      case 4: return this.h;
      case 5: return this.l;
      case 6: return this.memRead(this.getHL());
      case 7: return this.a;
    }
  }

  setReg8(idx, val) {
    const v = val & 0xFF;
    switch (idx & 7) {
      case 0: this.b = v; break;
      case 1: this.c = v; break;
      case 2: this.d = v; break;
      case 3: this.e = v; break;
      case 4: this.h = v; break;
      case 5: this.l = v; break;
      case 6: this.memWrite(this.getHL(), v); break;
      case 7: this.a = v; break;
    }
  }

  getPairSP(idx) {
    switch (idx & 3) {
      case 0: return this.getBC();
      case 1: return this.getDE();
      case 2: return this.getHL();
      case 3: return this.sp;
    }
  }

  setPairSP(idx, val) {
    const v = val & 0xFFFF;
    switch (idx & 3) {
      case 0: this.setBC(v); break;
      case 1: this.setDE(v); break;
      case 2: this.setHL(v); break;
      case 3: this.sp = v; break;
    }
  }

  getPairAF(idx) {
    switch (idx & 3) {
      case 0: return this.getBC();
      case 1: return this.getDE();
      case 2: return this.getHL();
      case 3: return this.getAF();
    }
  }

  setPairAF(idx, val) {
    const v = val & 0xFFFF;
    switch (idx & 3) {
      case 0: this.setBC(v); break;
      case 1: this.setDE(v); break;
      case 2: this.setHL(v); break;
      case 3: this.setAF(v); break;
    }
  }

  checkCond(cc) {
    switch (cc & 7) {
      case 0: return (this.f & FLAG_Z) === 0;  // NZ
      case 1: return (this.f & FLAG_Z) !== 0;  // Z
      case 2: return (this.f & FLAG_C) === 0;  // NC
      case 3: return (this.f & FLAG_C) !== 0;  // C
      case 4: return (this.f & FLAG_PV) === 0; // PO
      case 5: return (this.f & FLAG_PV) !== 0; // PE
      case 6: return (this.f & FLAG_S) === 0;  // P
      case 7: return (this.f & FLAG_S) !== 0;  // M
    }
  }

  // ALU 8-bit operations
  aluAdd8(val, carry = 0) {
    const c = carry ? 1 : 0;
    const res = this.a + val + c;
    const r8 = res & 0xFF;
    const h = ((this.a & 0x0F) + (val & 0x0F) + c) & 0x10;
    const v = (~(this.a ^ val) & (this.a ^ r8) & 0x80) ? FLAG_PV : 0;
    this.a = r8;
    this.f = sz53Table[r8] | h | v | (res > 0xFF ? FLAG_C : 0);
  }

  aluSub8(val, carry = 0) {
    const c = carry ? 1 : 0;
    const res = this.a - val - c;
    const r8 = res & 0xFF;
    const h = ((this.a & 0x0F) - (val & 0x0F) - c) & 0x10;
    const v = ((this.a ^ val) & (this.a ^ r8) & 0x80) ? FLAG_PV : 0;
    this.a = r8;
    this.f = sz53Table[r8] | FLAG_N | h | v | (res < 0 ? FLAG_C : 0);
  }

  aluCp8(val) {
    const res = this.a - val;
    const r8 = res & 0xFF;
    const h = ((this.a & 0x0F) - (val & 0x0F)) & 0x10;
    const v = ((this.a ^ val) & (this.a ^ r8) & 0x80) ? FLAG_PV : 0;
    this.f = (sz53Table[r8] & (FLAG_S | FLAG_Z)) | (val & (FLAG_Y | FLAG_X)) | FLAG_N | h | v | (res < 0 ? FLAG_C : 0);
  }

  aluAnd8(val) {
    this.a = (this.a & val) & 0xFF;
    this.f = sz53pTable[this.a] | FLAG_H;
  }

  aluXor8(val) {
    this.a = (this.a ^ val) & 0xFF;
    this.f = sz53pTable[this.a];
  }

  aluOr8(val) {
    this.a = (this.a | val) & 0xFF;
    this.f = sz53pTable[this.a];
  }

  aluInc8(val) {
    const res = (val + 1) & 0xFF;
    this.f = (this.f & FLAG_C) | sz53Table[res] | ((val & 0x0F) === 0x0F ? FLAG_H : 0) | (val === 0x7F ? FLAG_PV : 0);
    return res;
  }

  aluDec8(val) {
    const res = (val - 1) & 0xFF;
    this.f = (this.f & FLAG_C) | sz53Table[res] | FLAG_N | ((val & 0x0F) === 0x00 ? FLAG_H : 0) | (val === 0x80 ? FLAG_PV : 0);
    return res;
  }

  aluAdd16(a, b) {
    const res = a + b;
    const r16 = res & 0xFFFF;
    const h = ((a & 0x0FFF) + (b & 0x0FFF)) > 0x0FFF ? FLAG_H : 0;
    this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (((r16 >> 8) & (FLAG_Y | FLAG_X))) | h | (res > 0xFFFF ? FLAG_C : 0);
    return r16;
  }

  aluAdc16(a, b) {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const res = a + b + c;
    const r16 = res & 0xFFFF;
    const h = ((a & 0x0FFF) + (b & 0x0FFF) + c) > 0x0FFF ? FLAG_H : 0;
    const v = (~(a ^ b) & (a ^ r16) & 0x8000) ? FLAG_PV : 0;
    this.f = ((r16 >> 8) & (FLAG_S | FLAG_Y | FLAG_X)) | (r16 === 0 ? FLAG_Z : 0) | h | v | (res > 0xFFFF ? FLAG_C : 0);
    return r16;
  }

  aluSbc16(a, b) {
    const c = (this.f & FLAG_C) ? 1 : 0;
    const res = a - b - c;
    const r16 = res & 0xFFFF;
    const h = ((a & 0x0FFF) - (b & 0x0FFF) - c) < 0 ? FLAG_H : 0;
    const v = ((a ^ b) & (a ^ r16) & 0x8000) ? FLAG_PV : 0;
    this.f = ((r16 >> 8) & (FLAG_S | FLAG_Y | FLAG_X)) | (r16 === 0 ? FLAG_Z : 0) | FLAG_N | h | v | (res < 0 ? FLAG_C : 0);
    return r16;
  }

  execAlu(opType, val) {
    switch (opType & 7) {
      case 0: this.aluAdd8(val, 0); break;
      case 1: this.aluAdd8(val, this.f & FLAG_C); break;
      case 2: this.aluSub8(val, 0); break;
      case 3: this.aluSub8(val, this.f & FLAG_C); break;
      case 4: this.aluAnd8(val); break;
      case 5: this.aluXor8(val); break;
      case 6: this.aluOr8(val); break;
      case 7: this.aluCp8(val); break;
    }
  }

  execCbOp(op, val) {
    const group = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    if (group === 0) {
      let res = 0;
      let c = 0;
      switch (y) {
        case 0: // RLC
          c = (val >> 7) & 1;
          res = ((val << 1) | c) & 0xFF;
          break;
        case 1: // RRC
          c = val & 1;
          res = ((val >> 1) | (c << 7)) & 0xFF;
          break;
        case 2: // RL
          c = (val >> 7) & 1;
          res = ((val << 1) | (this.f & FLAG_C)) & 0xFF;
          break;
        case 3: // RR
          c = val & 1;
          res = ((val >> 1) | ((this.f & FLAG_C) << 7)) & 0xFF;
          break;
        case 4: // SLA
          c = (val >> 7) & 1;
          res = (val << 1) & 0xFF;
          break;
        case 5: // SRA
          c = val & 1;
          res = ((val >> 1) | (val & 0x80)) & 0xFF;
          break;
        case 6: // SLL / SL1
          c = (val >> 7) & 1;
          res = ((val << 1) | 1) & 0xFF;
          break;
        case 7: // SRL
          c = val & 1;
          res = (val >> 1) & 0xFF;
          break;
      }
      this.f = sz53pTable[res] | c;
      return res;
    } else if (group === 1) {
      // BIT y, val
      const bit = val & (1 << y);
      this.f = (this.f & FLAG_C) | FLAG_H | (bit === 0 ? (FLAG_Z | FLAG_PV) : (y === 7 ? FLAG_S : 0)) | (val & (FLAG_Y | FLAG_X));
      return val;
    } else if (group === 2) {
      // RES y, val
      return val & ~(1 << y);
    } else {
      // SET y, val
      return val | (1 << y);
    }
  }

  /**
   * Execute a single instruction and return elapsed T-states
   */
  step() {
    const intCycles = this.checkInterrupts();
    if (intCycles > 0) {
      this.cycles += intCycles;
      this.stepTimers(intCycles);
      return intCycles;
    }

    this.eiPending = false;

    if (this.halted) {
      this.incR();
      this.cycles += 4;
      this.stepTimers(4);
      return 4;
    }

    this.incR();
    const op = this.fetch8();
    const t = this.execMain(op);
    this.cycles += t;
    this.stepTimers(t);
    return t;
  }

  execMain(op) {
    // Decode quadrant x = op >> 6, y = (op >> 3) & 7, z = op & 7
    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 1) {
      // 0x40 - 0x7F: LD r, r' and HALT
      if (op === 0x76) {
        this.halted = true;
        return 4;
      }
      const val = this.getReg8(z);
      this.setReg8(y, val);
      return (y === 6 || z === 6) ? 7 : 4;
    }

    if (x === 2) {
      // 0x80 - 0xBF: ALU A, r
      const val = this.getReg8(z);
      this.execAlu(y, val);
      return z === 6 ? 7 : 4;
    }

    if (x === 0) {
      switch (z) {
        case 0:
          switch (y) {
            case 0: return 4; // NOP
            case 1: { // EX AF, AF'
              const ta = this.a, tf = this.f;
              this.a = this.a_; this.f = this.f_;
              this.a_ = ta; this.f_ = tf;
              return 4;
            }
            case 2: { // DJNZ d
              const disp = this.fetchDisp();
              this.b = (this.b - 1) & 0xFF;
              if (this.b !== 0) {
                this.pc = (this.pc + disp) & 0xFFFF;
                return 13;
              }
              return 8;
            }
            case 3: { // JR d
              const disp = this.fetchDisp();
              this.pc = (this.pc + disp) & 0xFFFF;
              return 12;
            }
            case 4:
            case 5:
            case 6:
            case 7: { // JR cc, d
              const disp = this.fetchDisp();
              if (this.checkCond(y - 4)) {
                this.pc = (this.pc + disp) & 0xFFFF;
                return 12;
              }
              return 7;
            }
          }
          break;

        case 1:
          if ((y & 1) === 0) {
            // LD rr, nn
            this.setPairSP(y >> 1, this.fetch16());
            return 10;
          } else {
            // ADD HL, rr
            this.setHL(this.aluAdd16(this.getHL(), this.getPairSP(y >> 1)));
            return 11;
          }

        case 2:
          switch (y) {
            case 0: this.memWrite(this.getBC(), this.a); return 7;
            case 1: this.a = this.memRead(this.getBC()); return 7;
            case 2: this.memWrite(this.getDE(), this.a); return 7;
            case 3: this.a = this.memRead(this.getDE()); return 7;
            case 4: this.memWrite16(this.fetch16(), this.getHL()); return 16;
            case 5: this.setHL(this.memRead16(this.fetch16())); return 16;
            case 6: this.memWrite(this.fetch16(), this.a); return 13;
            case 7: this.a = this.memRead(this.fetch16()); return 13;
          }
          break;

        case 3:
          if ((y & 1) === 0) {
            // INC rr
            const p = y >> 1;
            this.setPairSP(p, (this.getPairSP(p) + 1) & 0xFFFF);
          } else {
            // DEC rr
            const p = y >> 1;
            this.setPairSP(p, (this.getPairSP(p) - 1) & 0xFFFF);
          }
          return 6;

        case 4:
          // INC r
          this.setReg8(y, this.aluInc8(this.getReg8(y)));
          return y === 6 ? 11 : 4;

        case 5:
          // DEC r
          this.setReg8(y, this.aluDec8(this.getReg8(y)));
          return y === 6 ? 11 : 4;

        case 6:
          // LD r, n
          this.setReg8(y, this.fetch8());
          return y === 6 ? 10 : 7;

        case 7:
          switch (y) {
            case 0: { // RLCA
              const c = (this.a >> 7) & 1;
              this.a = ((this.a << 1) | c) & 0xFF;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | c;
              return 4;
            }
            case 1: { // RRCA
              const c = this.a & 1;
              this.a = ((this.a >> 1) | (c << 7)) & 0xFF;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | c;
              return 4;
            }
            case 2: { // RLA
              const c = (this.a >> 7) & 1;
              this.a = ((this.a << 1) | (this.f & FLAG_C)) & 0xFF;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | c;
              return 4;
            }
            case 3: { // RRA
              const c = this.a & 1;
              this.a = ((this.a >> 1) | ((this.f & FLAG_C) << 7)) & 0xFF;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | c;
              return 4;
            }
            case 4: { // DAA
              let add = 0;
              let carry = this.f & FLAG_C;
              if ((this.f & FLAG_H) || (this.a & 0x0F) > 9) add |= 0x06;
              if (carry || this.a > 0x99) {
                add |= 0x60;
                carry = FLAG_C;
              }
              const oldA = this.a;
              if (this.f & FLAG_N) {
                this.a = (this.a - add) & 0xFF;
              } else {
                this.a = (this.a + add) & 0xFF;
              }
              const h = (oldA ^ this.a) & FLAG_H;
              this.f = sz53pTable[this.a] | (this.f & FLAG_N) | h | carry;
              return 4;
            }
            case 5: { // CPL
              this.a = (~this.a) & 0xFF;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV | FLAG_C)) | (this.a & (FLAG_Y | FLAG_X)) | FLAG_H | FLAG_N;
              return 4;
            }
            case 6: { // SCF
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | FLAG_C;
              return 4;
            }
            case 7: { // CCF
              const oldC = this.f & FLAG_C;
              this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_PV)) | (this.a & (FLAG_Y | FLAG_X)) | (oldC ? FLAG_H : FLAG_C);
              return 4;
            }
          }
          break;
      }
    }

    // x === 3 (0xC0 - 0xFF)
    switch (z) {
      case 0:
        // RET cc
        if (this.checkCond(y)) {
          this.pc = this.pop16();
          return 11;
        }
        return 5;

      case 1:
        if ((y & 1) === 0) {
          // POP qq
          this.setPairAF(y >> 1, this.pop16());
          return 10;
        } else {
          switch (y >> 1) {
            case 0: // RET
              this.pc = this.pop16();
              return 10;
            case 1: { // EXX
              let t;
              t = this.b; this.b = this.b_; this.b_ = t;
              t = this.c; this.c = this.c_; this.c_ = t;
              t = this.d; this.d = this.d_; this.d_ = t;
              t = this.e; this.e = this.e_; this.e_ = t;
              t = this.h; this.h = this.h_; this.h_ = t;
              t = this.l; this.l = this.l_; this.l_ = t;
              return 4;
            }
            case 2: // JP (HL)
              this.pc = this.getHL();
              return 4;
            case 3: // LD SP, HL
              this.sp = this.getHL();
              return 6;
          }
        }
        break;

      case 2: {
        // JP cc, nn
        const addr = this.fetch16();
        if (this.checkCond(y)) {
          this.pc = addr;
        }
        return 10;
      }

      case 3:
        switch (y) {
          case 0: // JP nn
            this.pc = this.fetch16();
            return 10;
          case 1: // CB prefix
            this.incR();
            return this.execCB();
          case 2: { // OUT (n), A
            const port = this.fetch8();
            this.ioWrite(port, this.a, this.a);
            return 11;
          }
          case 3: { // IN A, (n)
            const port = this.fetch8();
            this.a = this.ioRead(port, this.a);
            return 11;
          }
          case 4: { // EX (SP), HL
            const spVal = this.memRead16(this.sp);
            this.memWrite16(this.sp, this.getHL());
            this.setHL(spVal);
            return 19;
          }
          case 5: { // EX DE, HL
            const td = this.d, te = this.e;
            this.d = this.h; this.e = this.l;
            this.h = td; this.l = te;
            return 4;
          }
          case 6: // DI
            this.iff1 = false;
            this.iff2 = false;
            return 4;
          case 7: // EI
            this.iff1 = true;
            this.iff2 = true;
            this.eiPending = true;
            return 4;
        }
        break;

      case 4: {
        // CALL cc, nn
        const addr = this.fetch16();
        if (this.checkCond(y)) {
          this.push16(this.pc);
          this.pc = addr;
          return 17;
        }
        return 10;
      }

      case 5:
        if ((y & 1) === 0) {
          // PUSH qq
          this.push16(this.getPairAF(y >> 1));
          return 11;
        } else {
          switch (y >> 1) {
            case 0: { // CALL nn
              const addr = this.fetch16();
              this.push16(this.pc);
              this.pc = addr;
              return 17;
            }
            case 1: // DD prefix (IX)
              this.incR();
              return this.execIndex(true);
            case 2: // ED prefix
              this.incR();
              return this.execED();
            case 3: // FD prefix (IY)
              this.incR();
              return this.execIndex(false);
          }
        }
        break;

      case 6:
        // ALU A, n
        this.execAlu(y, this.fetch8());
        return 7;

      case 7:
        // RST p
        this.push16(this.pc);
        this.pc = y << 3;
        return 11;
    }

    return 4;
  }

  execCB() {
    const op = this.fetch8();
    const z = op & 7;
    const val = this.getReg8(z);
    const res = this.execCbOp(op, val);
    if (((op >> 6) & 3) !== 1) {
      this.setReg8(z, res);
    }
    return z === 6 ? 15 : 8;
  }

  execED() {
    const op = this.fetch8();
    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 0) {
      // Z180 Extended Instructions in 0x00 - 0x3F
      switch (z) {
        case 0: {
          // IN0 r, (n) / IN0 F, (n)
          const port = this.fetch8();
          const val = this.ioRead(port, 0x00);
          if (y !== 6) this.setReg8(y, val);
          this.f = (this.f & FLAG_C) | sz53pTable[val];
          return 12;
        }
        case 1: {
          // OUT0 (n), r
          const port = this.fetch8();
          const val = y === 6 ? 0 : this.getReg8(y);
          this.ioWrite(port, val, 0x00);
          return 13;
        }
        case 4: {
          // TST r / TST (HL)
          const val = this.getReg8(y);
          const res = (this.a & val) & 0xFF;
          this.f = sz53pTable[res] | FLAG_H;
          return y === 6 ? 10 : 7;
        }
      }
      return 8;
    }

    if (x === 1) {
      switch (z) {
        case 0: {
          // IN r, (C)
          const val = this.ioRead(this.c, this.b);
          if (y !== 6) this.setReg8(y, val);
          this.f = (this.f & FLAG_C) | sz53pTable[val];
          return 12;
        }
        case 1: {
          // OUT (C), r
          const val = y === 6 ? 0 : this.getReg8(y);
          this.ioWrite(this.c, val, this.b);
          return 12;
        }
        case 2:
          if ((y & 1) === 0) {
            // SBC HL, rr
            this.setHL(this.aluSbc16(this.getHL(), this.getPairSP(y >> 1)));
          } else {
            // ADC HL, rr
            this.setHL(this.aluAdc16(this.getHL(), this.getPairSP(y >> 1)));
          }
          return 15;
        case 3: {
          const addr = this.fetch16();
          if ((y & 1) === 0) {
            // LD (nn), rr
            this.memWrite16(addr, this.getPairSP(y >> 1));
          } else {
            // LD rr, (nn)
            this.setPairSP(y >> 1, this.memRead16(addr));
          }
          return 20;
        }
        case 4:
          if (op === 0x64) {
            // Z180: TST n
            const val = this.fetch8();
            const res = (this.a & val) & 0xFF;
            this.f = sz53pTable[res] | FLAG_H;
            return 9;
          } else if (op === 0x74) {
            // Z180: TSTIO n
            const imm = this.fetch8();
            const val = this.ioRead(this.c, 0x00);
            const res = (val & imm) & 0xFF;
            this.f = sz53pTable[res] | FLAG_H;
            return 12;
          } else if ((y & 1) === 1) {
            // Z180: MLT BC (0x4C), MLT DE (0x5C), MLT HL (0x6C), MLT SP (0x7C)
            const p = y >> 1;
            const rr = this.getPairSP(p);
            const prod = ((rr >> 8) & 0xFF) * (rr & 0xFF);
            this.setPairSP(p, prod & 0xFFFF);
            return 17;
          } else {
            // NEG (0x44, 0x54, etc.)
            const oldA = this.a;
            this.a = 0;
            this.aluSub8(oldA, 0);
            return 8;
          }
        case 5:
          // RETN / RETI
          this.iff1 = this.iff2;
          this.pc = this.pop16();
          return 14;
        case 6:
          if (op === 0x76) {
            // Z180: SLP
            this.halted = true;
            return 8;
          }
          // IM 0 / 1 / 2
          if ((y & 3) === 0 || (y & 3) === 1) this.im = 0;
          else if ((y & 3) === 2) this.im = 1;
          else this.im = 2;
          return 8;
        case 7:
          switch (y) {
            case 0: // LD I, A
              this.i = this.a;
              return 9;
            case 1: // LD R, A
              this.r = this.a;
              return 9;
            case 2: // LD A, I
              this.a = this.i;
              this.f = (this.f & FLAG_C) | sz53Table[this.a] | (this.iff2 ? FLAG_PV : 0);
              return 9;
            case 3: // LD A, R
              this.a = this.r;
              this.f = (this.f & FLAG_C) | sz53Table[this.a] | (this.iff2 ? FLAG_PV : 0);
              return 9;
            case 4: { // RRD
              const hl = this.getHL();
              const m = this.memRead(hl);
              const newM = ((this.a & 0x0F) << 4) | (m >> 4);
              this.a = (this.a & 0xF0) | (m & 0x0F);
              this.memWrite(hl, newM);
              this.f = (this.f & FLAG_C) | sz53pTable[this.a];
              return 18;
            }
            case 5: { // RLD
              const hl = this.getHL();
              const m = this.memRead(hl);
              const newM = ((m << 4) | (this.a & 0x0F)) & 0xFF;
              this.a = (this.a & 0xF0) | (m >> 4);
              this.memWrite(hl, newM);
              this.f = (this.f & FLAG_C) | sz53pTable[this.a];
              return 18;
            }
            default:
              return 8;
          }
      }
    }

    if (x === 2) {
      // Z180 OTIM (0x83), OTDM (0x8B), OTIMR (0x93), OTDMR (0x9B)
      if (op === 0x83 || op === 0x8B || op === 0x93 || op === 0x9B) {
        const dir = (op & 0x08) ? -1 : 1;
        const repeat = (op & 0x10) !== 0;
        const hl = this.getHL();
        const val = this.memRead(hl);
        this.ioWrite(this.c, val, 0x00);
        this.setHL((hl + dir) & 0xFFFF);
        this.c = (this.c + dir) & 0xFF;
        this.b = (this.b - 1) & 0xFF;
        this.f = (this.b === 0 ? FLAG_Z : 0) | (val & 0x80 ? FLAG_N : 0);
        if (repeat && this.b !== 0) {
          this.pc = (this.pc - 2) & 0xFFFF;
          return 16;
        }
        return 14;
      }

      // Block instructions (0xA0 - 0xBB)
      const dir = (y & 1) ? -1 : 1;
      const repeat = (y & 2) !== 0;
      switch (z) {
        case 0: {
          // LDI / LDD / LDIR / LDDR
          const hl = this.getHL();
          const de = this.getDE();
          const val = this.memRead(hl);
          this.memWrite(de, val);
          this.setHL((hl + dir) & 0xFFFF);
          this.setDE((de + dir) & 0xFFFF);
          const bc = (this.getBC() - 1) & 0xFFFF;
          this.setBC(bc);
          const n = (val + this.a) & 0xFF;
          this.f = (this.f & (FLAG_S | FLAG_Z | FLAG_C)) | (bc !== 0 ? FLAG_PV : 0) | (n & FLAG_X) | ((n & 0x02) ? FLAG_Y : 0);
          if (repeat && bc !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            return 21;
          }
          return 16;
        }
        case 1: {
          // CPI / CPD / CPIR / CPDR
          const hl = this.getHL();
          const val = this.memRead(hl);
          const res = (this.a - val) & 0xFF;
          const h = ((this.a & 0x0F) - (val & 0x0F)) < 0 ? FLAG_H : 0;
          this.setHL((hl + dir) & 0xFFFF);
          const bc = (this.getBC() - 1) & 0xFFFF;
          this.setBC(bc);
          const n = (res - (h ? 1 : 0)) & 0xFF;
          this.f = (this.f & FLAG_C) | FLAG_N | (res & FLAG_S) | (res === 0 ? FLAG_Z : 0) | h | (bc !== 0 ? FLAG_PV : 0) | (n & FLAG_X) | ((n & 0x02) ? FLAG_Y : 0);
          if (repeat && bc !== 0 && res !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            return 21;
          }
          return 16;
        }
        case 2: {
          // INI / IND / INIR / INDR
          const hl = this.getHL();
          const val = this.ioRead(this.c, this.b);
          this.memWrite(hl, val);
          this.setHL((hl + dir) & 0xFFFF);
          this.b = (this.b - 1) & 0xFF;
          this.f = sz53Table[this.b] | (val & 0x80 ? FLAG_N : 0);
          if (repeat && this.b !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            return 21;
          }
          return 16;
        }
        case 3: {
          // OUTI / OUTD / OTIR / OTDR
          const hl = this.getHL();
          const val = this.memRead(hl);
          this.b = (this.b - 1) & 0xFF;
          this.ioWrite(this.c, val, this.b);
          this.setHL((hl + dir) & 0xFFFF);
          this.f = sz53Table[this.b] | (val & 0x80 ? FLAG_N : 0);
          if (repeat && this.b !== 0) {
            this.pc = (this.pc - 2) & 0xFFFF;
            return 21;
          }
          return 16;
        }
      }
    }

    return 8;
  }

  execIndex(useIX) {
    const op = this.fetch8();
    const getIdx = () => (useIX ? this.ix : this.iy);
    const setIdx = (v) => {
      if (useIX) this.ix = v & 0xFFFF;
      else this.iy = v & 0xFFFF;
    };
    const getIdxHi = () => (getIdx() >> 8) & 0xFF;
    const getIdxLo = () => getIdx() & 0xFF;
    const setIdxHi = (v) => setIdx(((v & 0xFF) << 8) | getIdxLo());
    const setIdxLo = (v) => setIdx((getIdx() & 0xFF00) | (v & 0xFF));

    switch (op) {
      case 0x09: setIdx(this.aluAdd16(getIdx(), this.getBC())); return 15;
      case 0x19: setIdx(this.aluAdd16(getIdx(), this.getDE())); return 15;
      case 0x29: setIdx(this.aluAdd16(getIdx(), getIdx())); return 15;
      case 0x39: setIdx(this.aluAdd16(getIdx(), this.sp)); return 15;

      case 0x21: setIdx(this.fetch16()); return 14;
      case 0x22: this.memWrite16(this.fetch16(), getIdx()); return 20;
      case 0x23: setIdx(getIdx() + 1); return 10;
      case 0x2A: setIdx(this.memRead16(this.fetch16())); return 20;
      case 0x2B: setIdx(getIdx() - 1); return 10;

      case 0x24: setIdxHi(this.aluInc8(getIdxHi())); return 8;
      case 0x25: setIdxHi(this.aluDec8(getIdxHi())); return 8;
      case 0x26: setIdxHi(this.fetch8()); return 11;
      case 0x2C: setIdxLo(this.aluInc8(getIdxLo())); return 8;
      case 0x2D: setIdxLo(this.aluDec8(getIdxLo())); return 8;
      case 0x2E: setIdxLo(this.fetch8()); return 11;

      case 0x34: { // INC (IX/IY + d)
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        this.memWrite(addr, this.aluInc8(this.memRead(addr)));
        return 23;
      }
      case 0x35: { // DEC (IX/IY + d)
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        this.memWrite(addr, this.aluDec8(this.memRead(addr)));
        return 23;
      }
      case 0x36: { // LD (IX/IY + d), n
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        const val = this.fetch8();
        this.memWrite(addr, val);
        return 19;
      }

      case 0xE1: setIdx(this.pop16()); return 14;
      case 0xE3: { // EX (SP), IX/IY
        const spVal = this.memRead16(this.sp);
        this.memWrite16(this.sp, getIdx());
        setIdx(spVal);
        return 23;
      }
      case 0xE5: this.push16(getIdx()); return 15;
      case 0xE9: this.pc = getIdx(); return 8;
      case 0xF9: this.sp = getIdx(); return 10;

      case 0xCB: {
        // DDCB / FDCB d op
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        const subOp = this.fetch8();
        const val = this.memRead(addr);
        const res = this.execCbOp(subOp, val);
        if (((subOp >> 6) & 3) !== 1) {
          this.memWrite(addr, res);
          const z = subOp & 7;
          if (z !== 6) this.setReg8(z, res);
        }
        return 23;
      }
    }

    const x = (op >> 6) & 3;
    const y = (op >> 3) & 7;
    const z = op & 7;

    if (x === 1 && op !== 0x76) {
      if (y === 6) {
        // LD (IX/IY + d), r
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        this.memWrite(addr, this.getReg8(z));
        return 19;
      }
      if (z === 6) {
        // LD r, (IX/IY + d)
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        this.setReg8(y, this.memRead(addr));
        return 19;
      }
      // Undocumented IXH/IXL/IYH/IYL register loads
      const getIdxSub = (r) => (r === 4 ? getIdxHi() : r === 5 ? getIdxLo() : this.getReg8(r));
      const val = getIdxSub(z);
      if (y === 4) setIdxHi(val);
      else if (y === 5) setIdxLo(val);
      else this.setReg8(y, val);
      return 8;
    }

    if (x === 2) {
      if (z === 6) {
        // ALU A, (IX/IY + d)
        const addr = (getIdx() + this.fetchDisp()) & 0xFFFF;
        this.execAlu(y, this.memRead(addr));
        return 19;
      }
      if (z === 4 || z === 5) {
        this.execAlu(y, z === 4 ? getIdxHi() : getIdxLo());
        return 8;
      }
    }

    // Fallback to standard execution if prefix has no effect on opcode
    return this.execMain(op) + 4;
  }

  getState() {
    return {
      pc: this.pc,
      sp: this.sp,
      af: this.getAF(),
      bc: this.getBC(),
      de: this.getDE(),
      hl: this.getHL(),
      af_: (this.a_ << 8) | this.f_,
      bc_: (this.b_ << 8) | this.c_,
      de_: (this.d_ << 8) | this.e_,
      hl_: (this.h_ << 8) | this.l_,
      ix: this.ix,
      iy: this.iy,
      i: this.i,
      r: this.r,
      iff1: this.iff1,
      iff2: this.iff2,
      im: this.im,
      halted: this.halted,
      cycles: this.cycles,
      phiHz: this.getPhiHz(),
      icr: this.ioRegs[Z180_REG.ICR],
      cbr: this.ioRegs[Z180_REG.CBR],
      bbr: this.ioRegs[Z180_REG.BBR],
      cbar: this.ioRegs[Z180_REG.CBAR],
    };
  }
}
