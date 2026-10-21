/**
 * Dallas Semiconductor DS1302 Real-Time Clock & 31-Byte NVRAM Emulator
 * Connected to Port 0x0C on the SC126 Z180 Motherboard:
 *   Write Port 0x0C:
 *     Bit 7 (0x80): RTC_OUT (Data input to DS1302 when /RTC_WE = 0)
 *     Bit 6 (0x40): RTC_CLK (SCLK, active high)
 *     Bit 5 (0x20): /RTC_WE (Write Enable, active low: 0 = host driving I/O, 1 = reading I/O)
 *     Bit 4 (0x10): RTC_CE  (Chip Enable / /RST, active high)
 *   Read Port 0x0C:
 *     Bit 0 (0x01): RTC_IN  (Data output from DS1302)
 */

const toBcd = (val) => {
  const v = Math.max(0, Math.min(99, val | 0));
  return ((Math.floor(v / 10) & 0x0F) << 4) | (v % 10);
};

const fromBcd = (bcd) => (((bcd >> 4) & 0x0F) * 10) + (bcd & 0x0F);

export class DS1302 {
  constructor() {
    this.nvram = new Uint8Array(31);
    this.clockRegs = new Uint8Array(9);
    this.timeOffsetMs = 0; // Offset from host Date.now() when guest sets the RTC
    this.useHostTime = true;
    this.reset();
  }

  reset() {
    this.ce = 0;
    this.clk = 0;
    this.weBar = 1;
    this.dataIn = 0;
    this.dataOutBit = 1;

    this.state = 'IDLE'; // 'IDLE' | 'CMD' | 'READ' | 'WRITE'
    this.bitIdx = 0;
    this.cmdByte = 0;
    this.writeByte = 0;
    this.currentReadByte = 0;
    this.isRam = false;
    this.isBurst = false;
    this.regIdx = 0;
    this.burstIdx = 0;

    // Initialize Clock Halt = 0 (running), Write Protect = 0x80, Trickle Charge = 0x00
    this.clockRegs[0] = 0x00;
    this.clockRegs[7] = 0x80; // WP on
    this.clockRegs[8] = 0x00; // Trickle charger disabled by default
    this.secPollCount = 0;
    this.calibSeconds = 0;
  }

  syncClockRegsFromHost() {
    if (!this.useHostTime || (this.clockRegs[0] & 0x80)) return;
    const now = new Date(Date.now() + this.timeOffsetMs);
    this.clockRegs[0] = toBcd(now.getSeconds()) & 0x7F;
    this.clockRegs[1] = toBcd(now.getMinutes()) & 0x7F;
    this.clockRegs[2] = toBcd(now.getHours()) & 0x3F; // 24-hour mode
    this.clockRegs[3] = toBcd(now.getDate()) & 0x3F;
    this.clockRegs[4] = toBcd(now.getMonth() + 1) & 0x1F;
    this.clockRegs[5] = ((now.getDay() % 7) + 1) & 0x07; // 1..7
    this.clockRegs[6] = toBcd(now.getFullYear() % 100);
  }

  readTargetRegister(isRam, idx) {
    if (isRam) {
      return idx < 31 ? this.nvram[idx] : 0xFF;
    }
    if (!this.isBurst && idx === 0) {
      // Single-register 0x81 polling is used by RomWBW TSTCLK ($1C12) to calibrate
      // the Z180 CPU clock (expecting DE = 2304 iterations -> 18.432 MHz).
      if (this.clockRegs[0] & 0x80) return this.clockRegs[0];
      this.secPollCount++;
      if (this.secPollCount === 1) {
        this.syncClockRegsFromHost();
        this.calibSeconds = fromBcd(this.clockRegs[0] & 0x7F);
      } else if (this.secPollCount === 3) {
        // First second-edge transition for TSTCLK synchronization
        this.calibSeconds = (this.calibSeconds + 1) % 60;
      } else if (this.secPollCount > 3 && ((this.secPollCount - 3) % 2304 === 0)) {
        // Second-edge transition after exactly 2304 calibration loops (18.432 MHz)
        this.calibSeconds = (this.calibSeconds + 1) % 60;
      }
      return toBcd(this.calibSeconds) & 0x7F;
    }
    if (idx < 9) {
      if (idx <= 6) this.syncClockRegsFromHost();
      return this.clockRegs[idx];
    }
    return 0x00;
  }

  writeTargetRegister(isRam, idx, val) {
    const b = val & 0xFF;
    // Register 7 (0x8E) is the Write Protect register itself
    if (!isRam && idx === 7) {
      this.clockRegs[7] = b & 0x80;
      return;
    }
    // Check Write Protect bit (Bit 7 of clockRegs[7])
    if (this.clockRegs[7] & 0x80) {
      return;
    }

    if (isRam) {
      if (idx < 31) this.nvram[idx] = b;
      return;
    }

    if (idx < 9) {
      this.clockRegs[idx] = b;
      if (idx === 6) {
        // Recompute offset from host clock when guest finishes setting year
        const sec = fromBcd(this.clockRegs[0] & 0x7F);
        const min = fromBcd(this.clockRegs[1] & 0x7F);
        const hr = fromBcd(this.clockRegs[2] & 0x3F);
        const dt = fromBcd(this.clockRegs[3] & 0x3F) || 1;
        const mon = (fromBcd(this.clockRegs[4] & 0x1F) || 1) - 1;
        const yr = 2000 + fromBcd(this.clockRegs[6]);
        const target = new Date(yr, mon, dt, hr, min, sec).getTime();
        if (!Number.isNaN(target)) {
          this.timeOffsetMs = target - Date.now();
        }
      }
    }
  }

  /**
   * Handle write to Port 0x0C on SC126
   * @param {number} val
   */
  writeLatch(val) {
    const newCe = (val & 0x10) ? 1 : 0;
    const newClk = (val & 0x40) ? 1 : 0;
    const newWeBar = (val & 0x20) ? 1 : 0;
    const newData = (val & 0x80) ? 1 : 0;

    if (!newCe) {
      // CE low resets the serial state machine
      this.ce = 0;
      this.clk = newClk;
      this.weBar = newWeBar;
      this.dataIn = newData;
      this.state = 'IDLE';
      this.bitIdx = 0;
      this.dataOutBit = 1;
      return;
    }

    if (!this.ce && newCe) {
      // Rising edge on CE starts a new command
      this.ce = 1;
      this.state = 'CMD';
      this.bitIdx = 0;
      this.cmdByte = 0;
    }

    const risingClk = !this.clk && newClk;
    const fallingClk = this.clk && !newClk;

    this.clk = newClk;
    this.weBar = newWeBar;
    this.dataIn = newData;

    if (risingClk) {
      if (this.state === 'CMD') {
        if (this.dataIn) {
          this.cmdByte |= (1 << this.bitIdx);
        }
        this.bitIdx++;
        if (this.bitIdx === 8) {
          if ((this.cmdByte & 0x80) === 0) {
            this.state = 'IDLE';
          } else {
            this.isRam = Boolean(this.cmdByte & 0x40);
            this.regIdx = (this.cmdByte >> 1) & 0x1F;
            this.isBurst = (this.regIdx === 0x1F);
            this.burstIdx = 0;
            this.bitIdx = 0;
            if (this.cmdByte & 0x01) {
              this.state = 'READ';
            } else {
              this.state = 'WRITE';
              this.writeByte = 0;
            }
          }
        }
      } else if (this.state === 'WRITE' && this.weBar === 0) {
        if (this.dataIn) {
          this.writeByte |= (1 << this.bitIdx);
        }
        this.bitIdx++;
        if (this.bitIdx === 8) {
          const targetIdx = this.isBurst ? this.burstIdx : this.regIdx;
          const maxBurst = this.isRam ? 31 : 8;
          if (!this.isBurst || this.burstIdx < maxBurst) {
            this.writeTargetRegister(this.isRam, targetIdx, this.writeByte);
          }
          if (this.isBurst) this.burstIdx++;
          else this.state = 'IDLE';
          this.bitIdx = 0;
          this.writeByte = 0;
        }
      }
    } else if (fallingClk) {
      if (this.state === 'READ') {
        if (this.bitIdx === 0) {
          const targetIdx = this.isBurst ? this.burstIdx : this.regIdx;
          this.currentReadByte = this.readTargetRegister(this.isRam, targetIdx);
        }
        this.dataOutBit = (this.currentReadByte >> this.bitIdx) & 0x01;
        this.bitIdx++;
        if (this.bitIdx === 8) {
          this.bitIdx = 0;
          if (this.isBurst) {
            this.burstIdx++;
          } else {
            this.state = 'IDLE';
          }
        }
      }
    }
  }

  /**
   * Return Bit 0 for Port 0x0C read
   */
  readBit() {
    if (!this.ce) return 1;
    if (this.weBar === 0) return this.dataIn;
    return this.dataOutBit & 0x01;
  }

  /**
   * Return formatted ISO-like string of current RTC time for UI inspector
   */
  getFormattedTime() {
    this.syncClockRegsFromHost();
    const yr = 2000 + fromBcd(this.clockRegs[6]);
    const mon = String(fromBcd(this.clockRegs[4] & 0x1F)).padStart(2, '0');
    const dt = String(fromBcd(this.clockRegs[3] & 0x3F)).padStart(2, '0');
    const hr = String(fromBcd(this.clockRegs[2] & 0x3F)).padStart(2, '0');
    const min = String(fromBcd(this.clockRegs[1] & 0x7F)).padStart(2, '0');
    const sec = String(fromBcd(this.clockRegs[0] & 0x7F)).padStart(2, '0');
    return `${yr}-${mon}-${dt} ${hr}:${min}:${sec}`;
  }
}
