/**
 * SC126 Z180 Motherboard (RC2014 / RCBus) Hardware Board Emulator
 * By Stephen C. Cousins (Small Computer Central)
 * https://smallcomputercentral.com/rcbus/sc100-series/sc126-z180-motherboard-rc2014/
 *
 * Emulates:
 *  - U1: 512 KB Flash ROM Socket 1 (SST39SF040) @ Physical 0x00000 - 0x7FFFF (FS=0)
 *  - U2: 512 KB Flash ROM Socket 2 (SST39SF040) @ Physical 0x00000 - 0x7FFFF (FS=1)
 *  - U3: 512 KB Static RAM (AS6C4008-55PCN)     @ Physical 0x80000 - 0xFFFFF (A19 = 1)
 *  - U4: Zilog Z8S180 CPU @ 18.432 MHz (X1 Oscillator)
 *  - U6: 74HCT273 8-bit Latch at Port 0x0C (DS1302 RTC, I2C, /SPI_CS1, /SPI_CS2, Flash Select)
 *  - U7: 74HCT273 8-bit Latch at Port 0x0D (8x Green Diagnostic LEDs L7..L0)
 *  - U8: 74HCT244 Buffer at Port 0x0C Read (Bit 7 = I2C_SDA, Bit 0 = DS1302 RTC_IN)
 *  - U9: Dallas DS1302 Real-Time Clock + 31B Battery-Backed NVRAM
 *  - U10: DS1233-5+ EconoReset Voltage Supervisor (< 4.7V brownout reset & SW2 Reset Switch)
 *  - P7: SPI MicroSDHC Card Slot (/SPI_CS1 = Port 0x0C Bit 2)
 */

import { Z180, Z180_REG } from './z180.js';
import { SDCard } from './sdcard.js';
import { DS1302 } from './ds1302.js';

export class SC126 {
  /**
   * @param {object} [options]
   * @param {(ch: number, byte: number) => void} [options.onSerialTx]
   * @param {(leds: {status: boolean, power: boolean, reset: boolean, sdSelect: boolean, diagByte: number}) => void} [options.onLedChange]
   * @param {(op: string, lba: number) => void} [options.onSdActivity]
   */
  constructor(options = {}) {
    this.boardType = 'sc126';
    this.oscillatorHz = 18_432_000;
    this.rom = new Uint8Array(512 * 1024);  // U1 Primary 512 KB Flash
    this.rom2 = new Uint8Array(512 * 1024); // U2 Secondary 512 KB Flash
    this.ram = new Uint8Array(512 * 1024);  // U3 512 KB SRAM
    this.rom.fill(0xFF);
    this.rom2.fill(0xFF);
    this.ram.fill(0x00);

    // Hardware Jumpers
    this.jp1WriteEnable = false; // U1 Flash write enable
    this.jp2PowerPortB = false;  // Serial Port B 5V power jumper
    this.jpFlashSelect = 0;      // 0 = U1 (RomWBW), 1 = U2 (Secondary/SCM)

    // Power & DS1233-5+ Reset Supervisor State
    this.supplyVoltage = 5.0;
    this.resetButtonPressed = false;
    this.resetPulseRemainingMs = 0;

    // Port 0x0C Latch (U6 74HCT273) & Port 0x0D Diagnostic LEDs (U7 74HCT273)
    this.port0C = 0x24; // Quiescent: /RTC_WE = 1 (0x20), /SPI_CS1 = 1 (0x04)
    this.diagLeds = 0x00; // Port 0x0D 8-bit LED bar (L7..L0)

    this.onSerialTx = options.onSerialTx || null;
    this.onLedChange = options.onLedChange || null;
    this.onSdActivity = options.onSdActivity || null;

    // Dallas DS1302 Real-Time Clock & NVRAM (U9)
    this.rtc = new DS1302();

    // SPI MicroSDHC Card (P7)
    this.sdcard = new SDCard({
      sizeMB: 64,
      productName: 'SC126',
      onActivity: (op, lba) => {
        if (this.onSdActivity) this.onSdActivity(op, lba);
      },
    });

    // Z8S180 CPU (U4)
    this.cpu = new Z180({
      readPhysMem: (physAddr) => this.readPhysMem(physAddr),
      writePhysMem: (physAddr, val) => this.writePhysMem(physAddr, val),
      readExtIO: (port16) => this.readExtIO(port16),
      writeExtIO: (port16, val) => this.writeExtIO(port16, val),
      onSerialTx: (ch, byte) => {
        if (this.onSerialTx) this.onSerialTx(ch, byte);
      },
      onCsioTx: (byte) => this.sdcard.spiTransmit(byte),
      onCsioRx: () => this.sdcard.spiReceive(),
    });

    this.breakpoints = new Set();
    this.reset();
  }

  loadRom(data, offset = 0) {
    this.rom.fill(0xFF);
    const len = Math.min(data.length, this.rom.length - offset);
    this.rom.set(data.subarray(0, len), offset);
  }

  loadSecondaryRom(data, offset = 0) {
    this.rom2.fill(0xFF);
    const len = Math.min(data.length, this.rom2.length - offset);
    this.rom2.set(data.subarray(0, len), offset);
  }

  loadIntelHexRom(hexText) {
    this.rom.fill(0xFF);
    let upperAddr = 0;
    const lines = hexText.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith(':')) continue;
      const count = parseInt(line.slice(1, 3), 16);
      const addr16 = parseInt(line.slice(3, 7), 16);
      const type = parseInt(line.slice(7, 9), 16);
      if (type === 0x00) {
        const base = (upperAddr << 16) + addr16;
        for (let i = 0; i < count; i++) {
          const b = parseInt(line.slice(9 + i * 2, 11 + i * 2), 16);
          if (base + i < this.rom.length) {
            this.rom[base + i] = b;
          }
        }
      } else if (type === 0x04) {
        upperAddr = parseInt(line.slice(9, 13), 16);
      } else if (type === 0x01) {
        break;
      }
    }
  }

  reset() {
    this.cpu.reset();
    this.sdcard.reset();
    this.rtc.reset();
    this.port0C = 0x24;
    this.diagLeds = 0x00;
    this.sdcard.setChipSelect(false);
    this.rtc.writeLatch(this.port0C);
    this.notifyLeds();
  }

  isHeldInReset() {
    return this.supplyVoltage < 4.7 || this.resetButtonPressed || this.resetPulseRemainingMs > 0;
  }

  getLeds() {
    const inReset = this.isHeldInReset();
    const power = this.supplyVoltage >= 3.0;
    const status = power && !inReset && ((this.diagLeds & 0xFF) !== 0);
    const sdSelect = power && !inReset && ((this.port0C & 0x04) === 0);
    return {
      status,
      power,
      reset: power && inReset,
      sdSelect,
      diagByte: (power && !inReset) ? (this.diagLeds & 0xFF) : 0x00,
      i2cScl: Boolean(this.port0C & 0x01),
      i2cSda: Boolean(this.port0C & 0x80),
      rtcCe: Boolean(this.port0C & 0x10),
      spiCs2: (this.port0C & 0x08) === 0,
    };
  }

  notifyLeds() {
    if (this.onLedChange) {
      this.onLedChange(this.getLeds());
    }
  }

  readPhysMem(physAddr) {
    const addr = physAddr & 0xFFFFF;
    if ((addr & 0x80000) === 0) {
      return this.rom[addr & 0x7FFFF];
    }
    return this.ram[addr & 0x7FFFF];
  }

  writePhysMem(physAddr, val) {
    const addr = physAddr & 0xFFFFF;
    if ((addr & 0x80000) === 0) {
      if (this.jp1WriteEnable) {
        this.rom[addr & 0x7FFFF] = val & 0xFF;
      }
      return;
    }
    this.ram[addr & 0x7FFFF] = val & 0xFF;
  }

  readExtIO(port16) {
    const port = port16 & 0xFF;
    if (port === 0x0C) {
      // U8 74HCT244 buffer on Port 0x0C:
      // Bit 7 = I2C_SDA (1 when pulled up), Bit 0 = DS1302 RTC_IN
      const rtcBit = this.rtc.readBit() & 0x01;
      const sdaBit = (this.port0C & 0x80) ? 0x80 : 0x00;
      return sdaBit | 0x7E | rtcBit;
    }
    if (port === 0x0D) {
      return this.diagLeds & 0xFF;
    }
    return 0xFF;
  }

  writeExtIO(port16, val) {
    const port = port16 & 0xFF;
    const b = val & 0xFF;

    if (port === 0x0C) {
      const prev0C = this.port0C;
      this.port0C = b;
      // Update DS1302 RTC lines (Bits 7..4)
      this.rtc.writeLatch(b);
      // Update SPI MicroSDHC /CS1 (Bit 2, active low)
      const cs1Selected = (b & 0x04) === 0;
      this.sdcard.setChipSelect(cs1Selected);
      if ((prev0C & 0x1D) !== (b & 0x1D)) {
        this.notifyLeds();
      }
      return;
    }

    if (port === 0x0D) {
      if (this.diagLeds !== b) {
        this.diagLeds = b;
        this.notifyLeds();
      }
    }
  }

  sendSerial(ch, data) {
    if (typeof data === 'number') {
      this.cpu.receiveSerial(ch, data & 0xFF);
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
        region: isRam ? 'SRAM (U3)' : 'Flash ROM (U1)',
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
}
