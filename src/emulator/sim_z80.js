/**
 * Small Computer Workshop (SCWorkshop) Simulated Z80 Computer
 * Based on `Simulated_Z80.ini` by Stephen C. Cousins (Small Computer Central)
 *
 * Architecture & Peripherals:
 *  - Flat 64 KB RAM ($0000 - $FFFF), default program origin $0000
 *  - Port $00 Input (`PortIn`):   8-bit Toggle Switches (S7..S0)
 *  - Port $00 Output (`PortOut`): 8-bit Output LEDs (L7..L0)
 *  - Port $01 Output (`TermOut`): Simulated Terminal Output
 *  - Port $02 Input (`TermIn`):   Simulated Terminal Input (returns ASCII code or $00 if none)
 *  - Port $03 Output (`PrintOut`): Simulated Line Printer Output
 *  - Memory $4000 - $47FF (`ScrnStrt`..`ScrnStrt+ScrnLen`): 2 KB Memory-Mapped Screen (64 cols x 32 rows)
 *  - Interrupt Mode 1 (`IntMode1 = $0038`): Triggered by the Hardware Interrupt button
 */

import { Z180 } from './z180.js';
import { SDCard } from './sdcard.js';

export class SimulatedZ80 {
  /**
   * @param {object} [options]
   * @param {(ch: number, byte: number) => void} [options.onSerialTx]
   * @param {(leds: object) => void} [options.onLedChange]
   * @param {(byte: number, fullText: string) => void} [options.onPrinterOut]
   * @param {(addr: number, val: number) => void} [options.onScreenWrite]
   */
  constructor(options = {}) {
    this.boardType = 'sim_z80';
    this.oscillatorHz = 4_000_000; // Classic 4 MHz Z80 clock

    // 64 KB flat RAM (plus 512KB aliases for Memory Hex Inspector compatibility)
    this.ram = new Uint8Array(512 * 1024);
    this.rom = new Uint8Array(512 * 1024);

    // Simulated I/O Ports & Peripherals
    this.simSwitches = 0x00; // Port $00 In
    this.simLeds = 0x00;     // Port $00 Out
    this.termRxQueue = [];   // Port $02 In
    this.printerText = '';   // Port $03 Out
    this.screenDirty = true; // $4000-$47FF (64x32)

    this.supplyVoltage = 5.0;
    this.resetButtonPressed = false;
    this.resetPulseRemainingMs = 0;
    this.jp1WriteEnable = true;
    this.jp2PowerPortB = false;

    this.onSerialTx = options.onSerialTx || null;
    this.onLedChange = options.onLedChange || null;
    this.onPrinterOut = options.onPrinterOut || null;
    this.onScreenWrite = options.onScreenWrite || null;

    // Dummy SDCard instance for UI compatibility
    this.sdcard = new SDCard({ sizeMB: 64, productName: 'SIMZ80' });

    // Z80 CPU (using Z180 core with internal I/O disabled so all 256 ports are external)
    this.cpu = new Z180({
      disableInternalIO: true,
      readPhysMem: (physAddr) => this.readPhysMem(physAddr),
      writePhysMem: (physAddr, val) => this.writePhysMem(physAddr, val),
      readExtIO: (port) => this.readExtIO(port),
      writeExtIO: (port, val) => this.writeExtIO(port, val),
      onSerialTx: (ch, byte) => {
        if (this.onSerialTx) this.onSerialTx(ch, byte);
      },
    });
    this.cpu.xtalHz = 8_000_000; // PHI = 4.000 MHz

    this.breakpoints = new Set();
    this.reset();
  }

  reset() {
    this.cpu.reset();
    // Configure CBAR so all 64KB maps 1:1 to physical 0x00000..0x0FFFF
    this.simLeds = 0x00;
    this.termRxQueue.length = 0;
    this.screenDirty = true;
    this.notifyLeds();
  }

  clearRam() {
    this.ram.fill(0x00);
    this.screenDirty = true;
  }

  clearPrinter() {
    this.printerText = '';
    if (this.onPrinterOut) this.onPrinterOut(0, this.printerText);
  }

  clearScreen() {
    this.ram.fill(0x20, 0x4000, 0x4800);
    this.screenDirty = true;
    if (this.onScreenWrite) this.onScreenWrite(0x4000, 0x20);
  }

  loadRom(data, offset = 0) {
    const len = Math.min(data.length, 65536 - offset);
    this.ram.set(data.subarray(0, len), offset);
    this.rom.set(data.subarray(0, len), offset);
    this.screenDirty = true;
  }

  loadIntelHexRom(hexText) {
    const lines = hexText.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith(':')) continue;
      const count = parseInt(line.slice(1, 3), 16);
      const addr16 = parseInt(line.slice(3, 7), 16);
      const type = parseInt(line.slice(7, 9), 16);
      if (type === 0x00) {
        for (let i = 0; i < count; i++) {
          const b = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
          this.ram[(addr16 + i) & 0xFFFF] = b;
          this.rom[(addr16 + i) & 0xFFFF] = b;
        }
      } else if (type === 0x01) {
        break;
      }
    }
    this.screenDirty = true;
  }

  /**
   * Load assembled segments into 64KB RAM and set PC to origin
   */
  loadAssembledProgram(asmResult) {
    for (const seg of asmResult.segments) {
      for (let i = 0; i < seg.bytes.length; i++) {
        const a = (seg.addr + i) & 0xFFFF;
        this.ram[a] = seg.bytes[i] & 0xFF;
      }
    }
    this.cpu.reset();
    this.cpu.pc = asmResult.origin & 0xFFFF;
    this.screenDirty = true;
    this.notifyLeds();
  }

  isHeldInReset() {
    return this.supplyVoltage < 4.7 || this.resetButtonPressed || this.resetPulseRemainingMs > 0;
  }

  getLeds() {
    const inReset = this.isHeldInReset();
    const power = this.supplyVoltage >= 3.0;
    const diagByte = (power && !inReset) ? (this.simLeds & 0xFF) : 0x00;
    return {
      status: diagByte !== 0,
      power,
      reset: power && inReset,
      sdSelect: false,
      diagByte,
      simLeds: diagByte,
      simSwitches: this.simSwitches & 0xFF,
    };
  }

  notifyLeds() {
    if (this.onLedChange) {
      this.onLedChange(this.getLeds());
    }
  }

  readPhysMem(physAddr) {
    return this.ram[physAddr & 0xFFFF];
  }

  writePhysMem(physAddr, val) {
    const a = physAddr & 0xFFFF;
    const b = val & 0xFF;
    this.ram[a] = b;
    if (a >= 0x4000 && a < 0x4800) {
      this.screenDirty = true;
      if (this.onScreenWrite) this.onScreenWrite(a, b);
    }
  }

  readExtIO(port16) {
    const port = port16 & 0xFF;
    if (port === 0x00) {
      // PortIn = 0x00 (8-bit Toggle Switches)
      return this.simSwitches & 0xFF;
    }
    if (port === 0x02) {
      // TermIn = 0x02 (Simulated Terminal Input: returns ASCII byte or 0x00 if none)
      return this.termRxQueue.length > 0 ? this.termRxQueue.shift() : 0x00;
    }
    return 0xFF;
  }

  writeExtIO(port16, val) {
    const port = port16 & 0xFF;
    const b = val & 0xFF;
    if (port === 0x00 || port === 0x0D || port === 0x0E) {
      // PortOut = 0x00 (8-bit Output LEDs)
      if (this.simLeds !== b) {
        this.simLeds = b;
        this.notifyLeds();
      }
      return;
    }
    if (port === 0x01) {
      // TermOut = 0x01 (Simulated Terminal Output)
      if (this.onSerialTx) this.onSerialTx(0, b);
      return;
    }
    if (port === 0x03) {
      // PrintOut = 0x03 (Simulated Line Printer Output)
      if (b === 0x0D) return; // normalize CRLF
      const ch = (b === 0x0A || (b >= 32 && b <= 126)) ? String.fromCharCode(b) : '.';
      this.printerText += ch;
      if (this.printerText.length > 16384) {
        this.printerText = this.printerText.slice(-16384);
      }
      if (this.onPrinterOut) this.onPrinterOut(b, this.printerText);
    }
  }

  sendSerial(ch, data) {
    if (typeof data === 'number') {
      this.termRxQueue.push(data & 0xFF);
      this.cpu.receiveSerial(ch, data & 0xFF);
    } else if (typeof data === 'string') {
      for (let i = 0; i < data.length; i++) {
        const b = data.charCodeAt(i) & 0xFF;
        this.termRxQueue.push(b);
        this.cpu.receiveSerial(ch, b);
      }
    } else if (data instanceof Uint8Array || Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        const b = data[i] & 0xFF;
        this.termRxQueue.push(b);
        this.cpu.receiveSerial(ch, b);
      }
    }
  }

  runCycles(targetCycles) {
    if (this.isHeldInReset()) {
      return { cyclesExecuted: 0, breakpointHit: false };
    }
    let executed = 0;
    while (executed < targetCycles) {
      executed += this.cpu.step();
      if (this.breakpoints.size > 0 && this.breakpoints.has(this.cpu.pc)) {
        return { cyclesExecuted: executed, breakpointHit: true };
      }
    }
    return { cyclesExecuted: executed, breakpointHit: false };
  }

  getMmuSummary() {
    return {
      cbar: 0xF0,
      bbr: 0x00,
      cbr: 0x00,
      common0: {
        logicalStart: 0x0000,
        logicalEnd: 0x3FFF,
        active: true,
        physAddr: 0x00000,
        region: 'Flat RAM (64 KB)',
        bank32k: 0,
        romwbwBankId: 0,
      },
      bankArea: {
        logicalStart: 0x4000,
        logicalEnd: 0x47FF,
        active: true,
        physAddr: 0x04000,
        region: 'Video RAM (64x32)',
        bank32k: 0,
        romwbwBankId: 0,
      },
      common1: {
        logicalStart: 0x4800,
        logicalEnd: 0xFFFF,
        active: true,
        physAddr: 0x04800,
        region: 'Flat RAM (64 KB)',
        bank32k: 1,
        romwbwBankId: 1,
      },
    };
  }

  getSerialConfig() {
    return {
      baud: 115200,
      framing: 'Port $01/$02',
      rts: true,
    };
  }
}
