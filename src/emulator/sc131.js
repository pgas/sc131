/**
 * SC131 - Z180 Pocket Computer Emulator
 * Designed by Stephen C Cousins (Small Computer Central)
 * https://smallcomputercentral.com/sc131-z180-pocket-computer/
 *
 * Hardware Architecture:
 *  - U1: SST39SF040 512 KB Flash ROM (Physical 0x00000 - 0x7FFFF)
 *  - U2: AS6C4008 512 KB Static RAM (Physical 0x80000 - 0xFFFFF)
 *  - U3: 74AHCT139 Dual 2-to-4 Decoder (Memory A19 split + I/O 0b00XXXXXX enable)
 *  - U4: Z8S18020VSC / Z8S18033VSC 68-pin PLCC CPU @ 18.432 MHz (X1 oscillator)
 *  - U5: 74HCT259 8-bit Addressable Latch:
 *        - Port 0x0C (0b00X0XX0X): Bit 2 = SPI /CS (Micro SD Card select, active low)
 *        - Port 0x0E (0b00X0XX1X): Bit 2 = Status LED1 (Orange, active low; ON at reset)
 *  - U7: DS1233-5+ EconoReset Voltage Supervisor (holds /RESET low if Vcc < 4.7V or SW1 pressed)
 *  - LED1: Orange Status LED (Software controlled via Port 0x0E bit 2, active low)
 *  - LED2: Green Power LED (5V DC present)
 *  - LED3: Red Reset LED (Active during power-on reset, SW1 button press, or Vcc < 4.7V)
 *  - JP1: Flash Write Protect Jumper ('Rd' = Read-Only default, 'Wr' = Write Enabled)
 *  - JP2: Serial Port B Power Jumper
 */

import { Z180, Z180_REG } from './z180.js';
import { SDCard } from './sdcard.js';

export class SC131 {
  /**
   * @param {object} [options]
   * @param {(ch: number, byte: number) => void} [options.onSerialTx]
   * @param {(leds: { power: boolean, status: boolean, reset: boolean, sdSelect: boolean }) => void} [options.onLedChange]
   * @param {(op: string, lba: number) => void} [options.onSdActivity]
   */
  constructor(options = {}) {
    this.onSerialTx = options.onSerialTx || null;
    this.onLedChange = options.onLedChange || null;
    this.onSdActivity = options.onSdActivity || null;

    // 512 KB Flash ROM (0x00000 - 0x7FFFF) & 512 KB SRAM (0x80000 - 0xFFFFF)
    this.rom = new Uint8Array(512 * 1024);
    this.rom.fill(0xFF);
    this.ram = new Uint8Array(512 * 1024);
    this.ram.fill(0x00);

    // Jumpers & Power Supervisor (DS1233-5+)
    this.jp1WriteEnable = false; // false = 'Rd' (write-protected), true = 'Wr' (writable)
    this.jp2PowerPortB = false;
    this.supplyVoltage = 5.0; // Volts (DS1233-5+ trips below 4.7V)
    this.resetButtonPressed = false;
    this.resetPulseRemainingMs = 0;

    // U5 (74HCT259) addressable latch outputs (cleared to 0 on hardware /RESET)
    this.u5Latch = new Uint8Array(8);

    // SPI Micro SD Card
    this.sdcard = new SDCard({
      sizeMB: 64,
      productName: 'SC131',
      onActivity: (op, lba) => {
        if (this.onSdActivity) this.onSdActivity(op, lba);
      },
    });

    // Z8S180 CPU
    this.cpu = new Z180({
      readPhysMem: (physAddr) => this.readPhysMem(physAddr),
      writePhysMem: (physAddr, val) => this.writePhysMem(physAddr, val),
      readExtIO: (port) => this.readExtIO(port),
      writeExtIO: (port, val) => this.writeExtIO(port, val),
      onSerialTx: (ch, byte) => {
        if (this.onSerialTx) this.onSerialTx(ch, byte);
      },
      onCsioTx: (byte) => this.sdcard.spiTransmit(byte),
      onCsioRx: () => this.sdcard.spiReceive(),
    });

    this.breakpoints = new Set();
    this.reset();
  }

  /**
   * Load binary firmware into U1 512KB Flash ROM
   * @param {Uint8Array} data
   */
  loadRom(data) {
    this.rom.fill(0xFF);
    this.rom.set(data.subarray(0, Math.min(data.byteLength, this.rom.byteLength)));
  }

  /**
   * Load Intel HEX string into U1 512KB Flash ROM
   * @param {string} hexText
   */
  loadIntelHexRom(hexText) {
    this.rom.fill(0xFF);
    let upperBase = 0;
    const lines = hexText.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith(':')) continue;
      const count = parseInt(line.slice(1, 3), 16);
      const addr = parseInt(line.slice(3, 7), 16);
      const type = parseInt(line.slice(7, 9), 16);
      if (type === 0x00) {
        for (let i = 0; i < count; i++) {
          const b = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
          const phys = (upperBase + addr + i) & 0x7FFFF;
          this.rom[phys] = b;
        }
      } else if (type === 0x04) {
        upperBase = parseInt(line.slice(9, 13), 16) << 16;
      } else if (type === 0x01) {
        break;
      }
    }
  }

  /**
   * Hardware reset (via SW1 reset button or DS1233 power-up supervisor)
   */
  reset() {
    this.cpu.reset();
    this.sdcard.reset();
    // Hardware /RESET clears U5 (74HCT259) all latches to 0:
    // Output Q1 (Status LED, active low) = 0 -> Status LED is ON at reset!
    // Output Q0 (SPI /CS, active low) = 0 -> deasserted by firmware on boot
    this.u5Latch.fill(0);
    this.u5Latch[0] = 1; // Keep SD card deselected prior to first port 0x0C write
    this.sdcard.setChipSelect(false);
    this.notifyLeds();
  }

  /**
   * Check if DS1233-5+ supervisor is holding the Z180 in /RESET
   */
  isHeldInReset() {
    return this.supplyVoltage < 4.7 || this.resetButtonPressed || this.resetPulseRemainingMs > 0;
  }

  /**
   * Return current state of the three SC131 front-panel LEDs and SPI select
   */
  getLeds() {
    const powerOk = this.supplyVoltage >= 3.0;
    const inReset = this.isHeldInReset();
    // LED1 (Orange Status LED) is wired active-low to U5 latch Q1 (port 0x0E bit 2)
    const statusLed = powerOk && !inReset && this.u5Latch[1] === 0;
    // LED2 (Green Power LED) indicates 5V supply
    const powerLed = powerOk;
    // LED3 (Red Reset LED) indicates DS1233 is asserting /RESET
    const resetLed = powerOk && inReset;
    const sdSelect = powerOk && !inReset && this.u5Latch[0] === 0;
    return {
      status: statusLed, // LED1 (Orange)
      power: powerLed,   // LED2 (Green)
      reset: resetLed,   // LED3 (Red)
      sdSelect,
    };
  }

  notifyLeds() {
    if (this.onLedChange) {
      this.onLedChange(this.getLeds());
    }
  }

  /**
   * Physical 20-bit memory read (0x00000 - 0xFFFFF)
   * Decoded by U3A (74AHCT139) using A19:
   *   A19 = 0 (0x00000 - 0x7FFFF) -> U1 512KB Flash ROM
   *   A19 = 1 (0x80000 - 0xFFFFF) -> U2 512KB Static RAM
   */
  readPhysMem(physAddr) {
    const addr = physAddr & 0xFFFFF;
    if ((addr & 0x80000) === 0) {
      return this.rom[addr & 0x7FFFF];
    } else {
      return this.ram[addr & 0x7FFFF];
    }
  }

  /**
   * Physical 20-bit memory write (0x00000 - 0xFFFFF)
   */
  writePhysMem(physAddr, val) {
    const addr = physAddr & 0xFFFFF;
    if ((addr & 0x80000) === 0) {
      // U1 Flash ROM is only writable if JP1 jumper is in 'Wr' position
      if (this.jp1WriteEnable) {
        this.rom[addr & 0x7FFFF] = val & 0xFF;
      }
    } else {
      this.ram[addr & 0x7FFFF] = val & 0xFF;
    }
  }

  /**
   * External I/O Port Read
   * SC131 has no external readable I/O ports (U5 74HCT259 is write-only),
   * so external I/O reads return 0xFF (open bus pull-up).
   */
  readExtIO(_port) {
    return 0xFF;
  }

  /**
   * External I/O Port Write
   * U3B (74AHCT139) enables U5 (74HCT259) when I/O address matches 0b00XXXXXX (0x00 - 0x3F).
   * U5 latches data bit 2 (D2) into the output addressed by A3, A2, A1:
   *   - SPI Enable (0b00X0XX0X, convention 0x0C): Bit 2 = SPI /CS (active low)
   *   - Status LED (0b00X0XX1X, convention 0x0E): Bit 2 = Status LED1 (active low)
   */
  writeExtIO(port, val) {
    const p = port & 0xFF;
    if ((p & 0xC0) === 0x00) {
      const bit2 = (val >> 2) & 1;
      // Conventional ports are 0x0C (SPI /CS) and 0x0E (Status LED),
      // while Fuzix & SCM S6 also write diagnostic LEDs to 0x0D.
      if ((p & 0x23) === 0x00) {
        // 0b00X0XX00 -> SPI /CS latch (0x0C)
        const prev = this.u5Latch[0];
        this.u5Latch[0] = bit2;
        this.sdcard.setChipSelect(bit2 === 0);
        if (prev !== bit2) this.notifyLeds();
      } else if ((p & 0x22) === 0x02 || p === 0x0D) {
        // 0b00X0XX1X -> Status LED1 latch (0x0E / 0x0D)
        const prev = this.u5Latch[1];
        this.u5Latch[1] = bit2;
        if (prev !== bit2) this.notifyLeds();
      }
    }
  }

  /**
   * Send a character or string to Serial Port A (ch=0) or Serial Port B (ch=1)
   * @param {number} ch 0 for ASCI0 (Port A), 1 for ASCI1 (Port B)
   * @param {string|number|Uint8Array} data
   */
  sendSerial(ch, data) {
    if (typeof data === 'number') {
      this.cpu.receiveSerial(ch, data);
    } else if (typeof data === 'string') {
      for (let i = 0; i < data.length; i++) {
        this.cpu.receiveSerial(ch, data.charCodeAt(i) & 0xFF);
      }
    } else if (data instanceof Uint8Array || Array.isArray(data)) {
      for (let i = 0; i < data.length; i++) {
        this.cpu.receiveSerial(ch, data[i] & 0xFF);
      }
    }
  }

  /**
   * Run the Z180 CPU for up to `targetCycles` T-states.
   * Stops early if a breakpoint is hit.
   * @returns {{ cyclesExecuted: number, breakpointHit: boolean }}
   */
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

  /**
   * Decode current ASCI baud rate and framing for UI display
   */
  getSerialConfig(ch = 0) {
    const cntla = this.cpu.ioRegs[ch === 0 ? Z180_REG.CNTLA0 : Z180_REG.CNTLA1];
    const cntlb = this.cpu.ioRegs[ch === 0 ? Z180_REG.CNTLB0 : Z180_REG.CNTLB1];
    const asext = this.cpu.ioRegs[ch === 0 ? Z180_REG.ASEXT0 : Z180_REG.ASEXT1];
    const astcL = this.cpu.ioRegs[ch === 0 ? Z180_REG.ASTC0L : Z180_REG.ASTC1L];
    const astcH = this.cpu.ioRegs[ch === 0 ? Z180_REG.ASTC0H : Z180_REG.ASTC1H];

    const dataBits = (cntla & 0x04) ? 8 : 7;
    const stopBits = (cntla & 0x01) ? 2 : 1;
    const parity = (cntla & 0x02) ? ((cntlb & 0x10) ? 'O' : 'E') : 'N';

    const phi = this.cpu.getPhiHz();
    let baud = 115200;
    if (asext & 0x08) {
      // BRG mode: baud = PHI / (2 * (TC + 2) * (X1 ? 1 : (DR ? 64 : 16)))
      const tc = astcL | (astcH << 8);
      const factor = (asext & 0x10) ? 1 : ((cntlb & 0x08) ? 64 : 16);
      baud = Math.round(phi / (2 * (tc + 2) * factor));
    } else {
      const ps = (cntlb & 0x20) ? 30 : 10;
      const dr = (cntlb & 0x08) ? 64 : 16;
      const ss = cntlb & 0x07;
      const div = ss < 7 ? (1 << ss) : 1;
      baud = Math.round(phi / (ps * dr * div));
    }

    return {
      baud,
      dataBits,
      parity,
      stopBits,
      framing: `${dataBits}${parity}${stopBits}`,
      rts: (cntla & 0x10) === 0,
      rxEnabled: (cntla & 0x40) !== 0,
      txEnabled: (cntla & 0x20) !== 0,
    };
  }

  /**
   * Return human-readable MMU window summary for UI inspector
   */
  getMmuSummary() {
    const cbar = this.cpu.ioRegs[Z180_REG.CBAR];
    const bbr = this.cpu.ioRegs[Z180_REG.BBR];
    const cbr = this.cpu.ioRegs[Z180_REG.CBR];
    const baStart = (cbar & 0x0F) << 12;
    const ca1Start = (cbar & 0xF0) << 8;

    const describePhys = (phys) => {
      const p = phys & 0xFFFFF;
      const isRam = (p & 0x80000) !== 0;
      const bank32k = (p >> 15) & 0x0F;
      return {
        physAddr: p,
        region: isRam ? 'SRAM (U2)' : 'Flash ROM (U1)',
        bank32k,
        romwbwBankId: isRam ? (0x80 | bank32k) : bank32k,
      };
    };

    return {
      cbar,
      bbr,
      cbr,
      common0: {
        logicalStart: 0x0000,
        logicalEnd: baStart > 0 ? baStart - 1 : -1,
        active: baStart > 0,
        ...describePhys(0x00000),
      },
      bankArea: {
        logicalStart: baStart,
        logicalEnd: ca1Start > baStart ? ca1Start - 1 : -1,
        active: ca1Start > baStart,
        ...describePhys((baStart + (bbr << 12)) & 0xFFFFF),
      },
      common1: {
        logicalStart: ca1Start,
        logicalEnd: 0xFFFF,
        active: true,
        ...describePhys((ca1Start + (cbr << 12)) & 0xFFFFF),
      },
    };
  }
}
