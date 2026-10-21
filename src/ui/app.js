/**
 * Main Browser Application for SC131 & SC126 Z180 Emulators
 * - Supports switching between:
 *   1) SC131 Z180 Pocket Computer (Port 0x0C SPI /CS, Port 0x0E Orange Status LED1)
 *   2) SC126 Z180 RC2014 Motherboard (Port 0x0D 8-LED Bar, Port 0x0C DS1302 RTC + I2C + SPI /CS1)
 * - Supports RomWBW v3.6.0, Fuzix 0.4 Unix OS (rcbus-z180), and Small Computer Monitor S6
 * - Left Column: Prominent Terminal (80x25 CRT with simple scrollback) + Debugger below the terminal
 * - Right Column: Always-visible Hardware Panels
 */

import { SC131 } from '../emulator/sc131.js';
import { SC126 } from '../emulator/sc126.js';
import { disassembleRange } from '../emulator/disasm.js';
import { SerialTerminal } from './terminal.js';

const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hex5 = (v) => (v & 0xFFFFF).toString(16).toUpperCase().padStart(5, '0');
const hex6 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(6, '0');
const bin8 = (v) => (v & 0xFF).toString(2).padStart(8, '0');

const MEM_ROW_HEIGHT = 20;

async function decompressIfGzip(uint8) {
  if (uint8.byteLength >= 2 && uint8[0] === 0x1F && uint8[1] === 0x8B) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([uint8]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    }
  }
  return uint8;
}

class SC131EmulatorApp {
  constructor() {
    this.running = false;
    this.speedMultiplier = 1.0;
    this.activeSerialTab = 0;
    this.txRxBlink = [0, 0];
    this.sdBlinkTimeout = null;
    this.resetPulseTimer = null;
    this.romCache = {};
    this.sdBundleCache = null;
    this.fuzixSdBundleCache = null;
    this.activeSdKind = 'romwbw'; // 'romwbw' | 'fuzix' | 'custom'

    const params = new URLSearchParams(window.location.search);
    this.machineType = params.get('machine') === 'sc126' ? 'sc126' : 'sc131';

    this.debuggerVisible = true;
    this.debuggerLive = false;
    this.disasmBaseAddr = null; // null = follow PC when refreshed
    this.syncingMemInput = false;
    this.syncingTermScroll = false;

    // Prompt-driven Quick Launch queue (checked at end of each frame after runCycles)
    this.macroQueue = [];
    this.serialWatchBuffer = '';

    // Initialize terminals
    const canvas0 = document.getElementById('term-canvas-0');
    const canvas1 = document.getElementById('term-canvas-1');

    this.term0 = new SerialTerminal(canvas0, {
      cols: 80,
      rows: 25,
      size: 'lg',
      theme: 'amber',
      onInput: (b) => {
        this.board.sendSerial(0, b);
        this.triggerSerialDot(0);
      },
      onScrollChange: () => {
        if (this.activeSerialTab === 0) this.syncTerminalScrollbar();
      },
    });

    this.term1 = new SerialTerminal(canvas1, {
      cols: 80,
      rows: 25,
      size: 'lg',
      theme: 'amber',
      onInput: (b) => {
        this.board.sendSerial(1, b);
        this.triggerSerialDot(1);
      },
      onScrollChange: () => {
        if (this.activeSerialTab === 1) this.syncTerminalScrollbar();
      },
    });

    // Initialize both SC131 and SC126 boards
    this.boards = {
      sc131: new SC131({
        onSerialTx: (ch, byte) => this.handleBoardSerialTx('sc131', ch, byte),
        onLedChange: (leds) => {
          if (this.machineType === 'sc131') this.updateLedsUI(leds);
        },
        onSdActivity: (op, lba) => {
          if (this.machineType === 'sc131') this.handleSdActivity(op, lba);
        },
      }),
      sc126: new SC126({
        onSerialTx: (ch, byte) => this.handleBoardSerialTx('sc126', ch, byte),
        onLedChange: (leds) => {
          if (this.machineType === 'sc126') this.updateLedsUI(leds);
        },
        onSdActivity: (op, lba) => {
          if (this.machineType === 'sc126') this.handleSdActivity(op, lba);
        },
      }),
    };

    this.board = this.boards[this.machineType];
    this.sc131 = this.board; // backwards-compatible alias

    this.bindUI();
    this.setupTerminalScrollbar();
    this.syncMachineChrome();
    this.setupMemoryVirtualScroll();
    this.bootDefaultSystem();
  }

  handleBoardSerialTx(boardKey, ch, byte) {
    if (boardKey !== this.machineType) return;
    if (ch === 0) {
      this.term0.writeByte(byte);
      if (this.macroQueue.length > 0) {
        this.serialWatchBuffer += String.fromCharCode(byte & 0x7F);
        if (this.serialWatchBuffer.length > 512) {
          this.serialWatchBuffer = this.serialWatchBuffer.slice(-512);
        }
      }
    } else {
      this.term1.writeByte(byte);
    }
    this.triggerSerialDot(ch);
  }

  checkMacroWatchBuffer() {
    if (this.macroQueue.length === 0) return;
    const nextStep = this.macroQueue[0];
    if (this.serialWatchBuffer.includes(nextStep.waitFor)) {
      this.macroQueue.shift();
      this.serialWatchBuffer = '';
      this.board.sendSerial(0, nextStep.send);
      this.triggerSerialDot(0);
    }
  }

  getActiveTerminal() {
    return this.activeSerialTab === 0 ? this.term0 : this.term1;
  }

  setupTerminalScrollbar() {
    const sb = document.getElementById('term-scrollbar');
    if (!sb) return;
    sb.addEventListener('scroll', () => {
      if (this.syncingTermScroll) return;
      const term = this.getActiveTerminal();
      const sbLen = term.scrollback.length;
      if (sbLen === 0) return;
      const maxScrollTop = Math.max(1, sb.scrollHeight - sb.clientHeight);
      const ratioFromBottom = 1 - Math.max(0, Math.min(1, sb.scrollTop / maxScrollTop));
      const newOffset = Math.round(ratioFromBottom * sbLen);
      this.syncingTermScroll = true;
      term.setViewOffset(newOffset);
      this.syncingTermScroll = false;
    });
    this.syncTerminalScrollbar();
  }

  syncTerminalScrollbar() {
    if (this.syncingTermScroll) return;
    const sb = document.getElementById('term-scrollbar');
    const spacer = document.getElementById('term-scroll-spacer');
    const term = this.getActiveTerminal();
    if (!sb || !spacer || !term) return;
    const viewHeight = term.rows * term.charHeight + 16;
    const totalRows = term.rows + term.scrollback.length;
    const totalHeight = totalRows * term.charHeight + 16;

    sb.style.height = `${viewHeight}px`;
    spacer.style.height = `${totalHeight}px`;

    this.syncingTermScroll = true;
    const maxScrollTop = Math.max(0, totalHeight - viewHeight);
    if (term.scrollback.length === 0 || term.viewOffset <= 0) {
      sb.scrollTop = maxScrollTop;
    } else {
      const frac = 1 - term.viewOffset / term.scrollback.length;
      sb.scrollTop = Math.round(frac * maxScrollTop);
    }
    this.syncingTermScroll = false;
  }

  triggerSerialDot(ch) {
    const el = document.getElementById(ch === 0 ? 'txrx-0' : 'txrx-1');
    if (!el) return;
    el.classList.add('active');
    clearTimeout(this.txRxBlink[ch]);
    this.txRxBlink[ch] = setTimeout(() => el.classList.remove('active'), 90);
  }

  updateLedsUI(leds) {
    if (this.machineType === 'sc131') {
      document.getElementById('led-status')?.classList.toggle('on', leds.status);
      document.getElementById('led-power')?.classList.toggle('on', leds.power);
      document.getElementById('led-reset')?.classList.toggle('on', leds.reset);
    } else {
      document.getElementById('sc126-led-power')?.classList.toggle('on', leds.power);
      document.getElementById('sc126-led-reset')?.classList.toggle('on', leds.reset);
      const diag = leds.diagByte ?? 0;
      for (let bit = 0; bit < 8; bit++) {
        const el = document.getElementById(`diag-led-${bit}`);
        el?.classList.toggle('on', ((diag >> bit) & 1) !== 0);
      }
      const hexEl = document.getElementById('sc126-diag-hex');
      if (hexEl) {
        hexEl.textContent = `$${hex2(diag)} (${bin8(diag)})`;
      }
      document.getElementById('sc126-rtc-ce')?.classList.toggle('on', Boolean(leds.rtcCe));
      const i2cEl = document.getElementById('sc126-i2c-status');
      if (i2cEl) {
        i2cEl.textContent = `SCL=${leds.i2cScl ? 1 : 0} SDA=${leds.i2cSda ? 1 : 0} • /CS2=${leds.spiCs2 ? 0 : 1}`;
      }
    }
    document.getElementById('led-sd-act')?.classList.toggle('on', leds.sdSelect);
  }

  handleSdActivity(op, lba) {
    const opEl = document.getElementById('sd-last-op');
    const lbaEl = document.getElementById('sd-last-lba');
    const rwEl = document.getElementById('sd-rw-count');
    if (opEl) opEl.textContent = op;
    if (lbaEl) lbaEl.textContent = '0x' + hex6(lba);
    if (rwEl) rwEl.textContent = `${this.board.sdcard.readCount} / ${this.board.sdcard.writeCount}`;

    const sdLed = document.getElementById('led-sd-act');
    if (sdLed) {
      sdLed.classList.add('on');
      clearTimeout(this.sdBlinkTimeout);
      this.sdBlinkTimeout = setTimeout(() => {
        sdLed.classList.toggle('on', this.board.getLeds().sdSelect);
      }, 65);
    }
  }

  syncMachineChrome() {
    const is126 = this.machineType === 'sc126';
    const machineSel = document.getElementById('machine-select');
    if (machineSel && machineSel.value !== this.machineType) {
      machineSel.value = this.machineType;
    }

    const badge = document.getElementById('brand-badge');
    const title = document.getElementById('brand-title');
    const sub = document.getElementById('brand-subtitle-text');
    const link = document.getElementById('brand-doc-link');
    const fwOpt = document.getElementById('fw-opt-romwbw');
    const btnReset = document.getElementById('btn-reset');
    const btnLedDemo = document.getElementById('btn-led-demo');

    if (badge) badge.textContent = is126 ? 'SC126' : 'SC131';
    if (title) {
      title.textContent = is126
        ? 'SC126 Z180 RC2014 Motherboard Emulator'
        : 'SC131 Z180 Pocket Computer Emulator';
    }
    if (sub) {
      sub.textContent = is126
        ? 'Z8S180 @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • Port $0D 8-LED Bar • DS1302 RTC • SPI SDHC'
        : 'Zilog Z8S180 @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • SPI SDHC';
    }
    if (link) {
      link.href = is126
        ? 'https://smallcomputercentral.com/rcbus/sc100-series/sc126-z180-motherboard-rc2014/'
        : 'https://smallcomputercentral.com/sc131-z180-pocket-computer/';
    }
    if (fwOpt) {
      fwOpt.textContent = is126
        ? 'RomWBW v3.6.0 (SCZ180_sc126_std)'
        : 'RomWBW v3.6.0 (SCZ180_sc131_std)';
    }
    if (btnReset) {
      btnReset.textContent = is126 ? 'Reset (SW2)' : 'Reset (SW1)';
    }
    if (btnLedDemo) {
      btnLedDemo.textContent = is126 ? '8-LED Bar Demo' : 'LED1 Blink Demo';
      btnLedDemo.title = is126
        ? 'Reset to BASIC and run an 8-LED Knight Rider scanner on Port 13 (0x0D)'
        : 'Reset to BASIC and blink the Orange Status LED1 on Port 14 (0x0E)';
    }

    // Toggle right-column hardware cards
    document.getElementById('hw-front-sc131')?.classList.toggle('hidden', is126);
    document.getElementById('hw-front-sc126')?.classList.toggle('hidden', !is126);
    document.getElementById('pcb-grid-sc131')?.classList.toggle('hidden', is126);
    document.getElementById('pcb-grid-sc126')?.classList.toggle('hidden', !is126);

    const sdPortTitle = document.getElementById('sd-port-title');
    if (sdPortTitle) {
      sdPortTitle.textContent = is126
        ? 'P7 • SPI MicroSDHC Slot (Port 0x0C /CS1)'
        : 'P1 • SPI MicroSDHC Slot (Port 0x0C / CSIO)';
    }

    const pcbTitle = document.getElementById('pcb-card-title');
    const silkL = document.getElementById('pcb-silk-left');
    const silkR = document.getElementById('pcb-silk-right');
    if (pcbTitle) {
      pcbTitle.textContent = is126 ? 'SC126 v1.0 RC2014 Motherboard' : 'SC131 v1.0 Motherboard PCB';
    }
    if (silkL) {
      silkL.textContent = is126 ? 'SC126 v1.0 • RCBus-80' : 'SC131 v1.0 • S. C. Cousins';
    }
    if (silkR) {
      silkR.textContent = is126 ? '101.6 × 99.1 mm' : '101.6 × 66.1 mm';
    }

    this.updateLedsUI(this.board.getLeds());
  }

  setDebuggerVisible(visible) {
    this.debuggerVisible = Boolean(visible);
    const sec = document.getElementById('debugger-section');
    const btn = document.getElementById('btn-toggle-debugger');
    sec?.classList.toggle('hidden', !this.debuggerVisible);
    btn?.classList.toggle('active', this.debuggerVisible);
    if (this.debuggerVisible) {
      this.updateInspectorUI(true);
    }
  }

  async fetchAssetBytes(path) {
    const resp = await fetch(path);
    if (!resp.ok) throw new Error(`Failed to fetch ${path}: ${resp.status}`);
    const ab = await resp.arrayBuffer();
    return new Uint8Array(ab);
  }

  getRomAssetPath(machine = this.machineType, fwKey = 'romwbw') {
    if (fwKey === 'scm_s6') return './assets/scm_s6.rom';
    return machine === 'sc126' ? './assets/romwbw_sc126.rom' : './assets/romwbw_sc131.rom';
  }

  async ensureRomLoaded(machine = this.machineType, fwKey = 'romwbw') {
    const actualFw = fwKey === 'scm_s6' ? 'scm_s6' : 'romwbw';
    const cacheKey = actualFw === 'scm_s6' ? 'scm_s6' : `romwbw_${machine}`;
    if (!this.romCache[cacheKey]) {
      this.romCache[cacheKey] = await this.fetchAssetBytes(this.getRomAssetPath(machine, actualFw));
    }
    this.boards[machine].loadRom(this.romCache[cacheKey]);
  }

  async ensureSdLoaded(kind = 'romwbw') {
    const st = document.getElementById('sd-status-text');
    if (kind === 'fuzix') {
      if (!this.fuzixSdBundleCache) {
        const raw = await this.fetchAssetBytes('./assets/fuzix_sdcard.simg');
        this.fuzixSdBundleCache = await decompressIfGzip(raw);
      }
      this.board.sdcard.loadSparseBundle(this.fuzixSdBundleCache);
      this.board.sdcard.present = true;
      this.activeSdKind = 'fuzix';
      if (st) st.textContent = 'SD0: 40 MB Fuzix 0.4 RootFS + Swap';
    } else if (kind === 'romwbw') {
      if (!this.sdBundleCache) {
        const raw = await this.fetchAssetBytes('./assets/sc131_sdcard.simg');
        this.sdBundleCache = await decompressIfGzip(raw);
      }
      this.board.sdcard.loadSparseBundle(this.sdBundleCache);
      this.board.sdcard.present = true;
      this.activeSdKind = 'romwbw';
      if (st) st.textContent = 'SD0: 68 MB SDHC (8 Slices)';
    }
  }

  async bootDefaultSystem() {
    try {
      const [romBytes, sdRaw] = await Promise.all([
        this.fetchAssetBytes(this.getRomAssetPath(this.machineType, 'romwbw')),
        this.fetchAssetBytes('./assets/sc131_sdcard.simg'),
      ]);
      this.romCache[`romwbw_${this.machineType}`] = romBytes;
      this.sdBundleCache = await decompressIfGzip(sdRaw);

      this.boards.sc131.sdcard.loadSparseBundle(this.sdBundleCache);
      this.boards.sc126.sdcard.loadSparseBundle(this.sdBundleCache);
      this.activeSdKind = 'romwbw';

      this.board.loadRom(romBytes);
      this.triggerHardwareResetPulse(180);
      this.running = true;
      this.startLoop();
      this.term0.canvas.focus();
    } catch (err) {
      console.error('Error loading default assets:', err);
      const msg = `\r\n[Error loading ROM/SD assets: ${err.message}]\r\n`;
      for (let i = 0; i < msg.length; i++) this.term0.writeByte(msg.charCodeAt(i));
      this.term0.render();
    }
  }

  async switchMachine(newMachine) {
    if (newMachine !== 'sc131' && newMachine !== 'sc126') return;
    this.clearMacroQueue();
    this.machineType = newMachine;
    this.board = this.boards[this.machineType];
    this.sc131 = this.board;
    this.syncMachineChrome();

    const fwKey = document.getElementById('firmware-select')?.value || 'romwbw';
    if (fwKey === 'fuzix') {
      await this.launchFuzix();
    } else {
      await this.ensureRomLoaded(this.machineType, fwKey);
      if (fwKey === 'romwbw') await this.ensureSdLoaded('romwbw');
      this.triggerHardwareResetPulse(180);
      this.running = true;
      this.updateRunPauseButton();
      this.updateInspectorUI(true);
      this.term0.canvas.focus();
    }
  }

  async switchFirmware(fwKey) {
    try {
      if (fwKey === 'fuzix') {
        await this.launchFuzix();
        return;
      }
      await this.ensureRomLoaded(this.machineType, fwKey);
      if (fwKey === 'romwbw' && this.activeSdKind === 'fuzix') {
        await this.ensureSdLoaded('romwbw');
      }
      this.triggerHardwareResetPulse(200);
      this.running = true;
      this.updateRunPauseButton();
      this.term0.canvas.focus();
    } catch (err) {
      console.error('Failed to switch firmware:', err);
    }
  }

  async launchFuzix() {
    this.clearMacroQueue();
    const fwSel = document.getElementById('firmware-select');
    if (fwSel) fwSel.value = 'fuzix';

    await this.ensureRomLoaded(this.machineType, 'romwbw');
    await this.ensureSdLoaded('fuzix');

    const is126 = this.machineType === 'sc126';
    const steps = is126
      ? [
          { waitFor: 'Boot [H=Help]: ', send: '4\r' },
          { waitFor: 'bootdev: ', send: 'hda1\r' },
        ]
      : [
          { waitFor: 'Boot [H=Help]: ', send: '2\r' },
          { waitFor: 'bootdev: ', send: 'hda1\r' },
          { waitFor: 'Enter new date: ', send: '\r' },
        ];

    this.resetAndStartMacroSteps(steps);
  }

  clearMacroQueue() {
    this.macroQueue = [];
    this.serialWatchBuffer = '';
    if (this.resetPulseTimer) {
      clearTimeout(this.resetPulseTimer);
      this.resetPulseTimer = null;
    }
  }

  triggerHardwareResetPulse(durationMs = 220) {
    this.clearMacroQueue();
    this.term0.reset();
    this.term1.reset();
    this.term0.render();
    this.term1.render();
    this.board.reset();
    this.board.resetPulseRemainingMs = durationMs;
    this.board.notifyLeds();
    this.updateStatusPill();

    this.resetPulseTimer = setTimeout(() => {
      this.resetPulseTimer = null;
      this.board.resetPulseRemainingMs = 0;
      this.board.notifyLeds();
      this.updateStatusPill();
      this.updateInspectorUI(true);
    }, durationMs);
  }

  resetAndStartMacroSteps(steps) {
    this.clearMacroQueue();
    this.activeSerialTab = 0;
    this.term0.reset();
    this.term1.reset();
    this.term0.render();
    this.term1.render();
    this.board.reset();
    this.board.resetPulseRemainingMs = 0;
    this.board.notifyLeds();
    this.running = true;
    this.updateRunPauseButton();
    this.updateStatusPill();
    this.macroQueue = steps;
    this.getActiveTerminal().canvas.focus();
  }

  /**
   * Reset the terminal and active board back to RomWBW Boot Loader and execute prompt-sequenced steps
   */
  async runQuickLaunch(steps) {
    this.clearMacroQueue();
    await this.ensureRomLoaded(this.machineType, 'romwbw');
    if (this.activeSdKind === 'fuzix') {
      await this.ensureSdLoaded('romwbw');
    }
    const fwSel = document.getElementById('firmware-select');
    if (fwSel) fwSel.value = 'romwbw';

    this.resetAndStartMacroSteps(steps);
  }

  runLedBlinkDemo() {
    if (this.machineType === 'sc126') {
      const prog126 = [
        '10 PRINT "SC126 8-LED BAR (PORT 13 / $0D) KNIGHT RIDER DEMO"',
        '20 FOR R=1 TO 4',
        '30 FOR B=0 TO 7 : V=2^B : OUT 13, V',
        '40 FOR D=1 TO 650 : NEXT D : NEXT B',
        '50 FOR B=6 TO 1 STEP -1 : V=2^B : OUT 13, V',
        '60 FOR D=1 TO 650 : NEXT D : NEXT B',
        '70 NEXT R',
        '80 OUT 13, 170 : PRINT "DONE! PORT 13 SET TO $AA (10101010)."',
        'RUN',
        '',
      ].join('\r');

      this.runQuickLaunch([
        { waitFor: 'Boot [H=Help]: ', send: 'B\r' },
        { waitFor: 'Memory top?', send: '\r' },
        { waitFor: 'Ok', send: prog126 },
      ]);
      return;
    }

    const prog131 = [
      '10 PRINT "SC131 STATUS LED1 (PORT 14) BLINK DEMO"',
      '20 FOR I=1 TO 6',
      '30 PRINT "LED1 ON  (OUT 14, 0)" : OUT 14, 0',
      '40 FOR D=1 TO 2500 : NEXT D',
      '50 PRINT "LED1 OFF (OUT 14, 255)" : OUT 14, 255',
      '60 FOR D=1 TO 2500 : NEXT D',
      '70 NEXT I',
      '80 OUT 14, 0 : PRINT "DONE! LED1 LEFT ON."',
      'RUN',
      '',
    ].join('\r');

    this.runQuickLaunch([
      { waitFor: 'Boot [H=Help]: ', send: 'B\r' },
      { waitFor: 'Memory top?', send: '\r' },
      { waitFor: 'Ok', send: prog131 },
    ]);
  }

  bindUI() {
    // Machine selector (SC131 vs SC126)
    document.getElementById('machine-select')?.addEventListener('change', (e) => {
      this.switchMachine(e.target.value);
    });

    // Interactive SC126 8-LED bar click to toggle bit in Port 0x0D
    document.querySelectorAll('#sc126-led-bar .diag-led-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const bit = parseInt(cell.getAttribute('data-bit') || '0', 10);
        this.boards.sc126.writeExtIO(0x0D, this.boards.sc126.diagLeds ^ (1 << bit));
      });
    });

    // Show/Hide Debugger section below terminal
    document.getElementById('btn-toggle-debugger')?.addEventListener('click', () => {
      this.setDebuggerVisible(!this.debuggerVisible);
    });
    document.getElementById('btn-hide-debugger')?.addEventListener('click', () => {
      this.setDebuggerVisible(false);
    });

    // Debugger Live & Snapshot Refresh controls
    document.getElementById('chk-debugger-live')?.addEventListener('change', (e) => {
      this.debuggerLive = e.target.checked;
      if (this.debuggerLive) this.updateInspectorUI(true);
    });
    document.getElementById('btn-debugger-refresh')?.addEventListener('click', () => {
      this.updateInspectorUI(true);
    });

    // Firmware selector
    document.getElementById('firmware-select')?.addEventListener('change', (e) => {
      this.switchFirmware(e.target.value);
    });

    // Speed selector
    document.getElementById('speed-select')?.addEventListener('change', (e) => {
      this.speedMultiplier = parseFloat(e.target.value) || 1.0;
      this.updateStatusPill();
    });

    // Run / Pause
    document.getElementById('btn-run-pause')?.addEventListener('click', () => {
      this.running = !this.running;
      this.updateRunPauseButton();
      this.updateStatusPill();
      this.updateInspectorUI(true);
    });

    // Single Step
    document.getElementById('btn-step')?.addEventListener('click', () => {
      this.running = false;
      this.disasmBaseAddr = null;
      this.updateRunPauseButton();
      if (!this.debuggerVisible) this.setDebuggerVisible(true);
      this.board.cpu.step();
      this.term0.render();
      this.term1.render();
      this.updateStatusPill();
      this.updateInspectorUI(true);
    });

    // Reset buttons (topbar + SW1 on SC131 + SW2 on SC126)
    const doReset = () => {
      this.triggerHardwareResetPulse(250);
      this.term0.canvas.focus();
    };
    document.getElementById('btn-reset')?.addEventListener('click', doReset);
    document.getElementById('hw-reset-btn')?.addEventListener('click', doReset);
    document.getElementById('sc126-reset-btn')?.addEventListener('click', doReset);

    // JP1 Flash Write Protect Jumper
    const btnJp1 = document.getElementById('btn-jp1');
    btnJp1?.addEventListener('click', () => {
      this.board.jp1WriteEnable = !this.board.jp1WriteEnable;
      btnJp1.classList.toggle('rd', !this.board.jp1WriteEnable);
      btnJp1.classList.toggle('wr', this.board.jp1WriteEnable);
      btnJp1.textContent = this.board.jp1WriteEnable
        ? 'JP1: Wr (Flash Write Enabled)'
        : 'JP1: Rd (Write Protected)';
    });

    // JP2 Serial Port B Power Jumper
    const btnJp2 = document.getElementById('btn-jp2');
    btnJp2?.addEventListener('click', () => {
      this.board.jp2PowerPortB = !this.board.jp2PowerPortB;
      btnJp2.classList.toggle('rd', this.board.jp2PowerPortB);
      btnJp2.textContent = this.board.jp2PowerPortB
        ? 'JP2: Fitted (Port B 5V Connected)'
        : 'JP2: Open (Via Port A)';
    });

    // Vcc Voltage Supervisor Slider (DS1233-5+ trips below 4.7V)
    const vccSlider = document.getElementById('vcc-slider');
    const vccVal = document.getElementById('vcc-val');
    vccSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const wasReset = this.board.isHeldInReset();
      this.board.supplyVoltage = v;
      if (vccVal) vccVal.textContent = v.toFixed(2) + 'V';
      const nowReset = this.board.isHeldInReset();
      if (wasReset && !nowReset) {
        this.triggerHardwareResetPulse(220);
      } else {
        this.board.notifyLeds();
        this.updateStatusPill();
      }
    });

    // Custom ROM file upload (both SC131 & SC126 inputs)
    const handleRomUpload = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      if (file.name.toLowerCase().endsWith('.hex')) {
        const text = new TextDecoder().decode(bytes);
        this.board.loadIntelHexRom(text);
      } else {
        this.board.loadRom(bytes);
      }
      this.term0.reset();
      this.triggerHardwareResetPulse(220);
    };
    document.getElementById('rom-file-input')?.addEventListener('change', handleRomUpload);
    document.getElementById('rom-file-input-sc126')?.addEventListener('change', handleRomUpload);

    // Custom SD card image mount
    document.getElementById('sd-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const ab = await file.arrayBuffer();
      const raw = await decompressIfGzip(new Uint8Array(ab));
      this.board.sdcard.loadSparseBundle(raw);
      this.board.sdcard.present = true;
      this.activeSdKind = 'custom';
      const st = document.getElementById('sd-status-text');
      if (st) st.textContent = `SD0: ${file.name} (${this.board.sdcard.sizeMB} MB)`;
    });

    // Export SD card image
    document.getElementById('btn-sd-export')?.addEventListener('click', () => {
      const data = this.board.sdcard.exportImage(18);
      const blob = new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${this.machineType}_sdcard_export.img`;
      a.click();
      URL.revokeObjectURL(url);
    });

    // Eject / Insert SD card
    const btnEject = document.getElementById('btn-sd-eject');
    btnEject?.addEventListener('click', () => {
      this.board.sdcard.present = !this.board.sdcard.present;
      btnEject.textContent = this.board.sdcard.present ? 'Eject SD' : 'Insert SD';
      const st = document.getElementById('sd-status-text');
      if (st) {
        st.textContent = this.board.sdcard.present
          ? `SD0: ${this.board.sdcard.sizeMB} MB SDHC (Present)`
          : 'SD0: [Card Ejected]';
      }
    });

    // Quick-launch macros (always reset terminal & active board and boot cleanly to target)
    document.querySelectorAll('[data-macro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rawMacro = btn.getAttribute('data-macro');
        if (!rawMacro) return;

        // On SC126, SD0 is Disk 4 (4.0..4.5), whereas on SC131 SD0 is Disk 2 (2.0..2.5)
        const is126 = this.machineType === 'sc126';
        const macro = (is126 && rawMacro.startsWith('2.'))
          ? '4.' + rawMacro.slice(2)
          : rawMacro;

        if (rawMacro.startsWith('2.4')) {
          const wsChk = document.getElementById('chk-wordstar');
          if (wsChk) wsChk.checked = true;
          this.term0.wordstarArrows = true;
          this.term1.wordstarArrows = true;
          this.runQuickLaunch([
            { waitFor: 'Boot [H=Help]: ', send: macro },
            { waitFor: 'A>', send: 'WS\r' },
          ]);
        } else if (rawMacro.startsWith('B')) {
          this.runQuickLaunch([
            { waitFor: 'Boot [H=Help]: ', send: 'B\r' },
            { waitFor: 'Memory top?', send: '\r' },
          ]);
        } else {
          this.runQuickLaunch([
            { waitFor: 'Boot [H=Help]: ', send: macro },
          ]);
        }
      });
    });

    document.getElementById('btn-fuzix-launch')?.addEventListener('click', () => {
      this.launchFuzix();
    });

    document.getElementById('btn-led-demo')?.addEventListener('click', () => {
      this.runLedBlinkDemo();
    });

    // Serial Port A / B Tabs
    const tab0 = document.getElementById('tab-asci0');
    const tab1 = document.getElementById('tab-asci1');
    tab0?.addEventListener('click', () => {
      this.activeSerialTab = 0;
      tab0.classList.add('active');
      tab1?.classList.remove('active');
      this.term0.canvas.classList.remove('hidden');
      this.term1.canvas.classList.add('hidden');
      this.term0.dirty = true;
      this.term0.render();
      this.syncTerminalScrollbar();
      this.term0.canvas.focus();
    });

    tab1?.addEventListener('click', () => {
      this.activeSerialTab = 1;
      tab1.classList.add('active');
      tab0?.classList.remove('active');
      this.term1.canvas.classList.remove('hidden');
      this.term0.canvas.classList.add('hidden');
      this.term1.dirty = true;
      this.term1.render();
      this.syncTerminalScrollbar();
      this.term1.canvas.focus();
    });

    // Terminal Size selector
    document.getElementById('term-size-select')?.addEventListener('change', (e) => {
      const preset = e.target.value;
      this.term0.setSizePreset(preset);
      this.term1.setSizePreset(preset);
      this.syncTerminalScrollbar();
      this.getActiveTerminal().canvas.focus();
    });

    // Terminal toolbar controls
    document.getElementById('theme-select')?.addEventListener('change', (e) => {
      this.term0.setTheme(e.target.value);
      this.term1.setTheme(e.target.value);
    });

    document.getElementById('chk-wordstar')?.addEventListener('change', (e) => {
      this.term0.wordstarArrows = e.target.checked;
      this.term1.wordstarArrows = e.target.checked;
    });

    document.getElementById('chk-scanlines')?.addEventListener('change', (e) => {
      this.term0.crtScanlines = e.target.checked;
      this.term1.crtScanlines = e.target.checked;
      this.term0.dirty = true;
      this.term1.dirty = true;
      this.term0.render();
      this.term1.render();
    });

    document.getElementById('btn-paste')?.addEventListener('click', async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) this.board.sendSerial(this.activeSerialTab, text.replace(/\r?\n/g, '\r'));
      } catch {
        const text = window.prompt('Paste text to send to serial port:');
        if (text) this.board.sendSerial(this.activeSerialTab, text.replace(/\r?\n/g, '\r'));
      }
      this.getActiveTerminal().canvas.focus();
    });

    document.getElementById('btn-copy-screen')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.getActiveTerminal().getScreenText());
    });

    document.getElementById('btn-clear-term')?.addEventListener('click', () => {
      const term = this.getActiveTerminal();
      term.reset();
      term.render();
      term.canvas.focus();
    });

    // Disassembler address & breakpoint controls
    document.getElementById('btn-disasm-pc')?.addEventListener('click', () => {
      this.disasmBaseAddr = null;
      const addrIn = document.getElementById('disasm-addr-input');
      if (addrIn) addrIn.value = '';
      this.updateDisasmUI();
    });

    document.getElementById('disasm-addr-input')?.addEventListener('input', (e) => {
      const val = e.target.value.trim();
      if (!val) {
        this.disasmBaseAddr = null;
      } else {
        const parsed = parseInt(val, 16);
        if (!Number.isNaN(parsed)) this.disasmBaseAddr = parsed & 0xFFFF;
      }
      this.updateDisasmUI();
    });

    document.getElementById('btn-add-bp')?.addEventListener('click', () => {
      const input = document.getElementById('bp-input');
      if (!input) return;
      const addr = parseInt(input.value.trim(), 16);
      if (!Number.isNaN(addr)) {
        const a16 = addr & 0xFFFF;
        if (this.board.breakpoints.has(a16)) this.board.breakpoints.delete(a16);
        else this.board.breakpoints.add(a16);
        input.value = '';
        this.updateDisasmUI();
      }
    });

    document.getElementById('btn-clear-bp')?.addEventListener('click', () => {
      this.board.breakpoints.clear();
      this.updateDisasmUI();
    });
  }

  /**
   * Set up the virtualized full-range scrollable Memory Hex Inspector
   */
  setupMemoryVirtualScroll() {
    const container = document.getElementById('mem-scroll-container');
    const spaceSelect = document.getElementById('mem-space-select');
    const addrInput = document.getElementById('mem-addr-input');

    const updateMemRangeDimensions = () => {
      const space = spaceSelect?.value || 'logical';
      const totalBytes = space === 'logical' ? 0x10000 : 0x80000;
      const totalRows = totalBytes / 16;
      const spacer = document.getElementById('mem-scroll-spacer');
      if (spacer) spacer.style.height = `${totalRows * MEM_ROW_HEIGHT}px`;

      const label = document.getElementById('mem-range-label');
      if (label) {
        if (space === 'logical') label.textContent = '$0000 – $FFFF (64 KB Logical CPU)';
        else if (space === 'rom') label.textContent = '$00000 – $7FFFF (512 KB Flash ROM U1)';
        else label.textContent = '$00000 – $7FFFF (512 KB Static RAM)';
      }
      this.renderVisibleMemoryHex();
    };

    container?.addEventListener('scroll', () => {
      this.renderVisibleMemoryHex();
      if (!this.syncingMemInput && addrInput) {
        const topRow = Math.floor(container.scrollTop / MEM_ROW_HEIGHT);
        const space = spaceSelect?.value || 'logical';
        const addr = topRow * 16;
        addrInput.value = space === 'logical' ? hex4(addr) : hex5(addr);
      }
    });

    spaceSelect?.addEventListener('change', () => {
      if (container) container.scrollTop = 0;
      updateMemRangeDimensions();
    });

    const scrollToAddress = (addr) => {
      if (!container) return;
      const space = spaceSelect?.value || 'logical';
      const maxAddr = space === 'logical' ? 0xFFFF : 0x7FFFF;
      const clamped = Math.max(0, Math.min(maxAddr, addr));
      const row = Math.floor(clamped / 16);
      this.syncingMemInput = true;
      container.scrollTop = row * MEM_ROW_HEIGHT;
      this.syncingMemInput = false;
      if (addrInput) {
        addrInput.value = space === 'logical' ? hex4(clamped & ~0xF) : hex5(clamped & ~0xF);
      }
      this.renderVisibleMemoryHex();
    };

    addrInput?.addEventListener('input', () => {
      const parsed = parseInt(addrInput.value.trim(), 16);
      if (!Number.isNaN(parsed)) {
        scrollToAddress(parsed);
      }
    });

    document.querySelectorAll('[data-mem-jump]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hex = btn.getAttribute('data-mem-jump') || '0000';
        scrollToAddress(parseInt(hex, 16) || 0);
      });
    });

    document.querySelectorAll('[data-mem-reg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reg = btn.getAttribute('data-mem-reg');
        const st = this.board.cpu.getState();
        if (spaceSelect) spaceSelect.value = 'logical';
        updateMemRangeDimensions();
        if (reg === 'pc') scrollToAddress(st.pc);
        else if (reg === 'sp') scrollToAddress(st.sp);
        else if (reg === 'hl') scrollToAddress(st.hl);
      });
    });

    updateMemRangeDimensions();
  }

  renderVisibleMemoryHex() {
    const container = document.getElementById('mem-scroll-container');
    const viewport = document.getElementById('mem-hex-view');
    const space = document.getElementById('mem-space-select')?.value || 'logical';
    if (!container || !viewport) return;

    const totalRows = (space === 'logical' ? 0x10000 : 0x80000) / 16;
    const scrollTop = container.scrollTop;
    const visibleRowCount = Math.ceil((container.clientHeight || 260) / MEM_ROW_HEIGHT) + 2;
    const startRow = Math.max(0, Math.min(totalRows - 1, Math.floor(scrollTop / MEM_ROW_HEIGHT)));
    const endRow = Math.min(totalRows, startRow + visibleRowCount);

    viewport.style.transform = `translateY(${startRow * MEM_ROW_HEIGHT}px)`;

    const htmlRows = [];
    for (let r = startRow; r < endRow; r++) {
      const rowAddr = r * 16;
      const hexCols = [];
      let ascii = '';
      for (let c = 0; c < 16; c++) {
        const a = rowAddr + c;
        let b = 0;
        if (space === 'logical') b = this.board.cpu.memRead(a & 0xFFFF);
        else if (space === 'rom') b = this.board.rom[a & 0x7FFFF];
        else b = this.board.ram[a & 0x7FFFF];
        hexCols.push(hex2(b));
        const ch = (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
        ascii += ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
      }
      const addrLabel = space === 'logical' ? hex4(rowAddr) : hex5(rowAddr);
      const bytesStr = `${hexCols.slice(0, 8).join(' ')}   ${hexCols.slice(8).join(' ')}`;
      htmlRows.push(
        `<div class="hex-row"><span class="hex-addr">${addrLabel}:</span><span class="hex-bytes">${bytesStr}</span><span class="hex-ascii">|${ascii}|</span></div>`
      );
    }
    viewport.innerHTML = htmlRows.join('');
  }

  updateRunPauseButton() {
    const btn = document.getElementById('btn-run-pause');
    if (!btn) return;
    btn.textContent = this.running ? 'Pause' : 'Run';
  }

  updateStatusPill() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    pill.classList.remove('pill-running', 'pill-paused', 'pill-reset');
    if (this.board.isHeldInReset()) {
      pill.classList.add('pill-reset');
      pill.textContent = this.board.supplyVoltage < 4.7
        ? `DS1233 BROWNOUT RESET (${this.board.supplyVoltage.toFixed(2)}V < 4.7V)`
        : `HARDWARE RESET (${this.machineType === 'sc126' ? 'SW2' : 'SW1'})`;
    } else if (this.running) {
      pill.classList.add('pill-running');
      const mhz = ((this.board.cpu.getPhiHz() * this.speedMultiplier) / 1e6).toFixed(3);
      pill.textContent = `RUNNING @ ${mhz} MHz`;
    } else {
      pill.classList.add('pill-paused');
      pill.textContent = `PAUSED @ PC=$${hex4(this.board.cpu.pc)}`;
    }
  }

  startLoop() {
    let lastTime = performance.now();
    let uiTick = 0;

    const frame = (now) => {
      const dtMs = Math.min(50, Math.max(1, now - lastTime));
      lastTime = now;

      if (this.running && !this.board.isHeldInReset()) {
        const phiHz = this.board.cpu.getPhiHz();
        const effectiveMult = this.macroQueue.length > 0 ? Math.max(this.speedMultiplier, 4.0) : this.speedMultiplier;
        const targetCycles = Math.round((phiHz * effectiveMult * dtMs) / 1000);
        const { breakpointHit } = this.board.runCycles(targetCycles);
        this.checkMacroWatchBuffer();
        if (breakpointHit) {
          this.running = false;
          this.disasmBaseAddr = null;
          if (!this.debuggerVisible) this.setDebuggerVisible(true);
          this.updateRunPauseButton();
          this.updateStatusPill();
          this.updateInspectorUI(true);
        }
      }

      this.term0.render();
      this.term1.render();

      uiTick++;
      if (uiTick >= 6) {
        uiTick = 0;
        this.updateInspectorUI(false);
      }

      requestAnimationFrame(frame);
    };

    requestAnimationFrame(frame);
  }

  updateInspectorUI(force = false) {
    const st = this.board.cpu.getState();
    const mhz = (st.phiHz / 1e6).toFixed(3);

    const perfEl = document.getElementById('perf-counter');
    if (perfEl) {
      perfEl.textContent = `PHI ${mhz} MHz • ${(st.cycles / 1e6).toFixed(1)}M T-states`;
    }

    // Update always-visible right-column hardware status
    const s0 = this.board.getSerialConfig(0);
    const s1 = this.board.getSerialConfig(1);
    const phiEl = document.getElementById('pcb-phi-label');
    const phiEl126 = document.getElementById('pcb-phi-label-sc126');
    const a0El = document.getElementById('asci0-cfg');
    const a1El = document.getElementById('asci1-cfg');
    if (phiEl) phiEl.textContent = `PHI = ${mhz} MHz`;
    if (phiEl126) phiEl126.textContent = `PHI = ${mhz} MHz`;
    if (a0El) a0El.textContent = `${s0.baud} ${s0.framing}`;
    if (a1El) a1El.textContent = `${s1.baud} ${s1.framing}`;
    document.getElementById('asci0-rts')?.classList.toggle('on', s0.rts);

    if (this.machineType === 'sc126' && this.board.rtc) {
      const rtcTimeEl = document.getElementById('sc126-rtc-time');
      if (rtcTimeEl) {
        rtcTimeEl.textContent = this.board.rtc.getFormattedTime();
      }
    }

    if (!this.debuggerVisible) return;

    if (force || !this.running || this.debuggerLive) {
      this.updateCpuMmuUI(st);
      this.updateDisasmUI(st);
      this.renderVisibleMemoryHex();
    }
  }

  updateCpuMmuUI(st = this.board.cpu.getState()) {
    const setTxt = (id, txt) => {
      const el = document.getElementById(id);
      if (el && el.textContent !== txt) el.textContent = txt;
    };

    setTxt('reg-pc', hex4(st.pc));
    setTxt('reg-sp', hex4(st.sp));
    setTxt('reg-af', hex4(st.af));
    setTxt('reg-bc', hex4(st.bc));
    setTxt('reg-de', hex4(st.de));
    setTxt('reg-hl', hex4(st.hl));
    setTxt('reg-ix', hex4(st.ix));
    setTxt('reg-iy', hex4(st.iy));
    setTxt('reg-af2', hex4(st.af_));
    setTxt('reg-bc2', hex4(st.bc_));
    setTxt('reg-de2', hex4(st.de_));
    setTxt('reg-hl2', hex4(st.hl_));
    setTxt('reg-ir', `${hex2(st.i)} / ${hex2(st.r)}`);

    const f = st.af & 0xFF;
    const flagStr = [
      (f & 0x80) ? 'S' : '·',
      (f & 0x40) ? 'Z' : '·',
      (f & 0x20) ? '5' : '·',
      (f & 0x10) ? 'H' : '·',
      (f & 0x08) ? '3' : '·',
      (f & 0x04) ? 'P' : '·',
      (f & 0x02) ? 'N' : '·',
      (f & 0x01) ? 'C' : '·',
    ].join('');
    setTxt('reg-flags', flagStr);
    setTxt('cpu-mode-badge', `IM ${st.im} • ${st.iff1 ? 'EI' : 'DI'}${st.halted ? ' • HALT' : ''}`);

    const mmu = this.board.getMmuSummary();
    setTxt('mmu-regs-raw', `CBAR=${hex2(mmu.cbar)} BBR=${hex2(mmu.bbr)} CBR=${hex2(mmu.cbr)}`);
    const mmuContainer = document.getElementById('mmu-bars');
    if (mmuContainer) {
      const areas = [
        { name: 'Common 0', info: mmu.common0 },
        { name: 'Bank Area', info: mmu.bankArea },
        { name: 'Common 1', info: mmu.common1 },
      ].filter((a) => a.info.active);

      mmuContainer.innerHTML = areas.map(({ name, info }) => {
        const isRam = info.region.includes('SRAM');
        return `<div class="mmu-row ${isRam ? 'ram' : 'rom'}">
          <span><strong>${name}</strong> ($${hex4(info.logicalStart)}–$${hex4(info.logicalEnd)})</span>
          <span>&rarr; $${hex5(info.physAddr)} [${info.region} Bank $${hex2(info.romwbwBankId)}]</span>
        </div>`;
      }).join('');
    }
  }

  updateDisasmUI(st = this.board.cpu.getState()) {
    const disasmEl = document.getElementById('disasm-view');
    if (!disasmEl) return;

    const startAddr = this.disasmBaseAddr !== null ? this.disasmBaseAddr : st.pc;
    const lines = disassembleRange((a) => this.board.cpu.memRead(a), startAddr, 64);
    disasmEl.innerHTML = lines.map((inst) => {
      const isPc = inst.addr === st.pc;
      const hasBp = this.board.breakpoints.has(inst.addr);
      const bytesHex = inst.bytes.map((b) => hex2(b)).join(' ');
      return `<div class="disasm-row ${isPc ? 'current-pc' : ''} ${hasBp ? 'has-bp' : ''}" data-addr="${inst.addr}">
        <span>${hasBp ? '●' : ' '}$${hex4(inst.addr)}</span>
        <span>${bytesHex}</span>
        <span>${inst.mnemonic}</span>
      </div>`;
    }).join('');

    disasmEl.querySelectorAll('.disasm-row').forEach((row) => {
      row.addEventListener('click', () => {
        const a = parseInt(row.getAttribute('data-addr'), 10);
        if (this.board.breakpoints.has(a)) this.board.breakpoints.delete(a);
        else this.board.breakpoints.add(a);
        this.updateDisasmUI();
      });
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.sc131App = new SC131EmulatorApp();
});
