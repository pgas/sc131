/**
 * SC131 & SC126 Modern Hardware Emulator Application
 *
 * Dedicated, cycle-accurate hardware emulator for Stephen C. Cousins':
 * - SC131 Z180 Pocket Computer (18.432 MHz, 512K Flash, 512K SRAM, SDHC, Status LED1)
 * - SC126 Z180 RC2014 Motherboard (18.432 MHz, 512K Flash, 512K SRAM, SDHC, DS1302 RTC, 8-LED Bar)
 *
 * Runs RomWBW v3.6.0, CP/M 2.2, CP/M 3, WordStar 4, Turbo Pascal, BASIC, SCM S6, and Fuzix 0.4 Unix OS.
 */

import { SC131 } from '../emulator/sc131.js';
import { SC126 } from '../emulator/sc126.js';
import { SerialTerminal } from './terminal.js';

const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hex6 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(6, '0');
const bin8 = (v) => (v & 0xFF).toString(2).padStart(8, '0');

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

class SC131App {
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
    this.activeSdKind = 'romwbw';

    const params = new URLSearchParams(window.location.search);
    const mParam = params.get('machine');
    this.machineType = mParam === 'sc126' ? 'sc126' : 'sc131';
    this.firmwareType = 'romwbw';

    // Layout
    this.hardwareSidebarVisible = true;
    this.syncingTermScroll = false;

    // Macro queue for prompt-driven boots
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

    // Initialize target boards
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

    this.lastFrameTime = performance.now();
    this.cycleDebt = 0;
    this.fpsCounter = 0;
    this.fpsLastTime = performance.now();
    this.lastCycles = 0;
    this.totalExecutedCycles = 0;
    this.measuredMhz = 18.43;

    this.setupUI();
    this.syncMachineChrome();
    this.initEmulator();
  }

  get board() {
    return this.boards[this.machineType] || this.boards.sc131;
  }

  handleBoardSerialTx(machine, ch, byte) {
    if (machine !== this.machineType) return;

    if (ch === 0) {
      this.term0.writeByte(byte);
      this.triggerSerialDot(0);

      if (this.macroQueue.length > 0) {
        const char = String.fromCharCode(byte & 0x7F);
        this.serialWatchBuffer += char;
        if (this.serialWatchBuffer.length > 512) {
          this.serialWatchBuffer = this.serialWatchBuffer.slice(-256);
        }
        this.checkMacroQueue();
      }
    } else if (ch === 1) {
      this.term1.writeByte(byte);
      this.triggerSerialDot(1);
    }
  }

  triggerSerialDot(ch) {
    const dot = document.getElementById(`txrx-${ch}`);
    if (dot) {
      dot.classList.add('active');
      clearTimeout(this.txRxBlink[ch]);
      this.txRxBlink[ch] = setTimeout(() => dot.classList.remove('active'), 60);
    }
  }

  handleSdActivity(op, lba) {
    const led = document.getElementById('led-sd-act');
    if (led) {
      led.classList.add('on');
      clearTimeout(this.sdBlinkTimeout);
      this.sdBlinkTimeout = setTimeout(() => led.classList.remove('on'), 50);
    }

    const opEl = document.getElementById('sd-last-op');
    const lbaEl = document.getElementById('sd-last-lba');
    const rwEl = document.getElementById('sd-rw-count');
    if (opEl) opEl.textContent = op;
    if (lbaEl) lbaEl.textContent = '0x' + hex6(lba);
    if (rwEl && this.board.sdcard) {
      rwEl.textContent = `${this.board.sdcard.readCount} / ${this.board.sdcard.writeCount}`;
    }
  }

  updateLedsUI(leds) {
    if (this.machineType === 'sc131') {
      const led1 = document.getElementById('led-status');
      if (led1 && typeof leds.status !== 'undefined') {
        led1.classList.toggle('on', leds.status);
      }
      const pwr = document.getElementById('led-power');
      if (pwr && typeof leds.power !== 'undefined') {
        pwr.classList.toggle('on', leds.power);
      }
      const rst = document.getElementById('led-reset');
      if (rst && typeof leds.reset !== 'undefined') {
        rst.classList.toggle('on', leds.reset);
      }
    } else if (this.machineType === 'sc126') {
      const pwr = document.getElementById('sc126-led-power');
      if (pwr && typeof leds.power !== 'undefined') {
        pwr.classList.toggle('on', leds.power);
      }
      const rst = document.getElementById('sc126-led-reset');
      if (rst && typeof leds.reset !== 'undefined') {
        rst.classList.toggle('on', leds.reset);
      }
      if (typeof leds.diagByte !== 'undefined') {
        this.updateSc126DiagBarUI(leds.diagByte);
      }
    }
  }

  updateSc126DiagBarUI(b) {
    const hexEl = document.getElementById('sc126-diag-hex');
    if (hexEl) hexEl.textContent = `$${hex2(b)} (${bin8(b)})`;
    for (let bit = 0; bit < 8; bit++) {
      const ledEl = document.getElementById(`diag-led-${bit}`);
      if (ledEl) {
        ledEl.classList.toggle('on', (b & (1 << bit)) !== 0);
      }
    }
  }

  updateSc126RtcUI() {
    if (this.machineType !== 'sc126') return;
    const timeEl = document.getElementById('sc126-rtc-time');
    if (timeEl && this.board.ds1302) {
      timeEl.textContent = this.board.ds1302.getFormattedTime();
    }
    const ceBadge = document.getElementById('sc126-rtc-ce');
    if (ceBadge) {
      ceBadge.classList.toggle('on', this.board.rtcCe === 1);
    }
    const i2cEl = document.getElementById('sc126-i2c-status');
    if (i2cEl) {
      i2cEl.textContent = `SCL=${this.board.i2cScl} SDA=${this.board.i2cSdaIn} • /CS2=${this.board.spiCs2}`;
    }
  }

  syncMachineChrome() {
    const isSc131 = this.machineType === 'sc131';

    // Badge & Title
    const badge = document.getElementById('brand-badge');
    if (badge) badge.textContent = isSc131 ? '⚡ SC131' : '⚡ SC126';

    const title = document.getElementById('brand-title');
    if (title) title.textContent = isSc131 ? 'SC131 Z180 Pocket Computer' : 'SC126 Z180 RC2014 Motherboard';

    const subtitle = document.getElementById('brand-subtitle-text');
    if (subtitle) {
      subtitle.textContent = isSc131
        ? 'Zilog Z8S180-N @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • SPI SDHC'
        : 'Zilog Z8S180-N @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • DS1302 RTC • Port 0x0D 8-LED Bar';
    }

    const docLink = document.getElementById('brand-doc-link');
    if (docLink) {
      docLink.href = isSc131
        ? 'https://smallcomputercentral.com/sc131-z180-pocket-computer/'
        : 'https://smallcomputercentral.com/rcbus/sc100-series/sc126-z180-motherboard-rc2014/';
    }

    const btnReset = document.getElementById('btn-reset');
    if (btnReset) {
      btnReset.textContent = isSc131 ? 'Reset (SW1)' : 'Reset (SW2)';
    }

    // Select dropdowns
    const mSelect = document.getElementById('machine-select');
    if (mSelect && mSelect.value !== this.machineType) {
      mSelect.value = this.machineType;
    }
    const fwSelect = document.getElementById('firmware-select');
    if (fwSelect && fwSelect.value !== this.firmwareType) {
      fwSelect.value = this.firmwareType;
    }

    // Hardware Sidebar Panels
    const sc131Front = document.getElementById('hw-front-sc131');
    const sc126Front = document.getElementById('hw-front-sc126');
    const sc131Grid = document.getElementById('pcb-grid-sc131');
    const sc126Grid = document.getElementById('pcb-grid-sc126');
    const pcbTitle = document.getElementById('pcb-card-title');
    const pcbSilkL = document.getElementById('pcb-silk-left');
    const pcbSilkR = document.getElementById('pcb-silk-right');

    if (sc131Front) sc131Front.classList.toggle('hidden', !isSc131);
    if (sc126Front) sc126Front.classList.toggle('hidden', isSc131);
    if (sc131Grid) sc131Grid.classList.toggle('hidden', !isSc131);
    if (sc126Grid) sc126Grid.classList.toggle('hidden', isSc131);

    if (pcbTitle) {
      pcbTitle.textContent = isSc131 ? 'SC131 v1.0 Motherboard PCB' : 'SC126 v1.1 Motherboard PCB';
    }
    if (pcbSilkL) {
      pcbSilkL.textContent = isSc131 ? 'SC131 v1.0 • S. C. Cousins' : 'SC126 v1.1 • RCBus / RC2014';
    }
    if (pcbSilkR) {
      pcbSilkR.textContent = isSc131 ? '101.6 × 66.1 mm' : '100 × 160 mm RCBus';
    }

    // Status bar badge
    const sbMachine = document.getElementById('sb-machine');
    if (sbMachine) {
      sbMachine.textContent = isSc131 ? '⎇ SC131 (Z8S180)' : '⎇ SC126 (Z8S180)';
    }

    // SD Card Slot title
    const sdTitle = document.getElementById('sd-port-title');
    if (sdTitle) {
      sdTitle.textContent = isSc131
        ? 'P1 • SPI MicroSDHC Slot (Port 0x0C / CSIO)'
        : 'P1 • SPI MicroSDHC Slot (Port 0x0C System / CSIO)';
    }

    this.updateLedsUI({
      status: this.board.statusLed,
      power: this.board.powerLed,
      reset: this.board.resetLed,
      diagByte: this.board.diagLedsByte || 0,
    });
  }

  async switchMachine(type) {
    if (type !== 'sc131' && type !== 'sc126') return;
    if (this.machineType === type) return;

    this.machineType = type;
    this.syncMachineChrome();

    // Update URL query without page reload
    const url = new URL(window.location.href);
    url.searchParams.set('machine', type);
    window.history.replaceState({}, '', url.toString());

    await this.applyFirmwareAndBoot(this.firmwareType);
  }

  async setFirmware(fw) {
    this.firmwareType = fw;
    this.syncMachineChrome();
    await this.applyFirmwareAndBoot(fw);
  }

  async applyFirmwareAndBoot(fw) {
    const romKey = this.machineType === 'sc131'
      ? (fw === 'scm_s6' ? 'scm_s6' : 'romwbw_sc131')
      : (fw === 'scm_s6' ? 'scm_s6' : 'romwbw_sc126');

    if (!this.romCache[romKey]) {
      await this.loadRomFile(romKey);
    }
    if (this.romCache[romKey]) {
      this.board.loadRom(this.romCache[romKey]);
    }

    if (fw === 'fuzix') {
      await this.mountFuzixSdImage();
    } else {
      await this.mountDefaultRomWBWSdImage();
    }

    this.resetHardwareTactile();
    this.resume();
  }

  async loadRomFile(key) {
    const files = {
      romwbw_sc131: './assets/romwbw_sc131.rom',
      romwbw_sc126: './assets/romwbw_sc126.rom',
      scm_s6: './assets/scm_s6.rom',
    };
    const path = files[key];
    if (!path) return;
    try {
      const resp = await fetch(path);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      this.romCache[key] = new Uint8Array(buf);
    } catch (err) {
      console.warn(`Could not load ROM ${key}:`, err);
    }
  }

  async mountDefaultRomWBWSdImage() {
    this.activeSdKind = 'romwbw';
    if (!this.sdBundleCache) {
      try {
        const resp = await fetch('./assets/sc131_sdcard.simg');
        if (resp.ok) {
          const raw = new Uint8Array(await resp.arrayBuffer());
          this.sdBundleCache = await decompressIfGzip(raw);
        }
      } catch (err) {
        console.warn('Could not load sc131_sdcard.simg:', err);
      }
    }
    if (this.sdBundleCache && this.board.sdcard) {
      this.board.sdcard.attachImage(this.sdBundleCache);
      const statEl = document.getElementById('sd-status-text');
      if (statEl) statEl.textContent = 'SD0: 68 MB SDHC (8 Slices)';
      const sbSd = document.getElementById('sb-sd');
      if (sbSd) sbSd.textContent = 'SDHC: RomWBW (68MB)';
    }
  }

  async mountFuzixSdImage() {
    this.activeSdKind = 'fuzix';
    if (!this.fuzixSdBundleCache) {
      try {
        const resp = await fetch('./assets/fuzix_sdcard.simg');
        if (resp.ok) {
          const raw = new Uint8Array(await resp.arrayBuffer());
          this.fuzixSdBundleCache = await decompressIfGzip(raw);
        }
      } catch (err) {
        console.warn('Could not load fuzix_sdcard.simg:', err);
      }
    }
    if (this.fuzixSdBundleCache && this.board.sdcard) {
      this.board.sdcard.attachImage(this.fuzixSdBundleCache);
      const statEl = document.getElementById('sd-status-text');
      if (statEl) statEl.textContent = 'SD0: Fuzix 0.4 Unix (32MB)';
      const sbSd = document.getElementById('sb-sd');
      if (sbSd) sbSd.textContent = 'SDHC: Fuzix Unix (32MB)';
    }
  }

  resetHardwareTactile() {
    this.board.reset();
    this.clearMacroQueue();
    this.term0.reset();
    this.term1.reset();

    const led = document.getElementById(this.machineType === 'sc131' ? 'led-reset' : 'sc126-led-reset');
    if (led) {
      led.classList.add('on');
      clearTimeout(this.resetPulseTimer);
      this.resetPulseTimer = setTimeout(() => led.classList.remove('on'), 250);
    }
  }

  queueMacro(promptPattern, responseString) {
    this.macroQueue.push({
      pattern: promptPattern,
      response: responseString,
      fired: false,
    });
  }

  clearMacroQueue() {
    this.macroQueue = [];
    this.serialWatchBuffer = '';
  }

  checkMacroQueue() {
    for (const item of this.macroQueue) {
      if (!item.fired) {
        let match = false;
        if (typeof item.pattern === 'string') {
          match = this.serialWatchBuffer.includes(item.pattern);
        } else if (item.pattern instanceof RegExp) {
          match = item.pattern.test(this.serialWatchBuffer);
        }
        if (match) {
          item.fired = true;
          for (let i = 0; i < item.response.length; i++) {
            this.board.sendSerial(0, item.response.charCodeAt(i));
          }
        }
      }
    }
    this.macroQueue = this.macroQueue.filter((m) => !m.fired);
  }

  quickBootMacro(macroStr) {
    if (!this.running) this.resume();

    // If RomWBW boot menu prompt is present, send directly
    if (this.serialWatchBuffer.includes('Boot [') || this.serialWatchBuffer.includes('>') || this.serialWatchBuffer.includes('$')) {
      for (let i = 0; i < macroStr.length; i++) {
        this.board.sendSerial(0, macroStr.charCodeAt(i));
      }
    } else {
      // Hardware reset and queue macro for RomWBW boot prompt
      this.resetHardwareTactile();
      this.queueMacro('Boot [', macroStr);
    }
  }

  launchFuzixQuick() {
    this.setFirmware('fuzix');
  }

  launchLedDemoQuick() {
    // RomWBW Microsoft BASIC LED blink demo
    this.quickBootMacro('B\r\r');
    this.queueMacro('Ok', '10 FOR I=1 TO 500: OUT 14,0: FOR J=1 TO 50: NEXT J: OUT 14,4: FOR J=1 TO 50: NEXT J: NEXT I\rRUN\r');
  }

  setupUI() {
    // Layout Toggle Button
    const btnToggleHardware = document.getElementById('btn-toggle-hardware');
    if (btnToggleHardware) {
      btnToggleHardware.addEventListener('click', () => this.toggleHardwareSidebar());
    }

    // Machine & Firmware selectors
    const mSelect = document.getElementById('machine-select');
    if (mSelect) {
      mSelect.addEventListener('change', (e) => this.switchMachine(e.target.value));
    }

    const fwSelect = document.getElementById('firmware-select');
    if (fwSelect) {
      fwSelect.addEventListener('change', (e) => this.setFirmware(e.target.value));
    }

    const speedSelect = document.getElementById('speed-select');
    if (speedSelect) {
      speedSelect.addEventListener('change', (e) => {
        this.speedMultiplier = parseFloat(e.target.value) || 1.0;
        const pill = document.getElementById('status-pill');
        if (pill && this.running) {
          pill.textContent = `RUNNING @ ${(18.432 * this.speedMultiplier).toFixed(2)} MHz`;
        }
      });
    }

    // Execution Buttons
    const btnRunPause = document.getElementById('btn-run-pause');
    if (btnRunPause) {
      btnRunPause.addEventListener('click', () => {
        if (this.running) this.pause();
        else this.resume();
      });
    }

    const btnStep = document.getElementById('btn-step');
    if (btnStep) {
      btnStep.addEventListener('click', () => this.stepInstruction());
    }

    const btnReset = document.getElementById('btn-reset');
    if (btnReset) {
      btnReset.addEventListener('click', () => this.resetHardwareTactile());
    }

    // Quick Launch Bar Buttons (all items with data-macro)
    document.querySelectorAll('[data-macro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const macro = btn.getAttribute('data-macro');
        if (macro) {
          this.quickBootMacro(macro);
        }
      });
    });

    const fuzixBtn = document.getElementById('btn-fuzix-launch');
    if (fuzixBtn) {
      fuzixBtn.addEventListener('click', () => this.launchFuzixQuick());
    }

    const ledBtn = document.getElementById('btn-led-demo');
    if (ledBtn) {
      ledBtn.addEventListener('click', () => this.launchLedDemoQuick());
    }

    // Terminal Tabs (ASCI0 vs ASCI1)
    const tabA = document.getElementById('tab-asci0');
    const tabB = document.getElementById('tab-asci1');
    const canvas0 = document.getElementById('term-canvas-0');
    const canvas1 = document.getElementById('term-canvas-1');

    if (tabA && tabB) {
      tabA.addEventListener('click', () => {
        this.activeSerialTab = 0;
        tabA.classList.add('active');
        tabB.classList.remove('active');
        canvas0.classList.remove('hidden');
        canvas1.classList.add('hidden');
        this.term0.focus();
        this.syncTerminalScrollbar();
      });
      tabB.addEventListener('click', () => {
        this.activeSerialTab = 1;
        tabB.classList.add('active');
        tabA.classList.remove('active');
        canvas1.classList.remove('hidden');
        canvas0.classList.add('hidden');
        this.term1.focus();
        this.syncTerminalScrollbar();
      });
    }

    // Terminal Size & Theme
    const sizeSel = document.getElementById('term-size-select');
    if (sizeSel) {
      sizeSel.addEventListener('change', (e) => {
        this.term0.setSizePreset(e.target.value);
        this.term1.setSizePreset(e.target.value);
        this.syncTerminalScrollbar();
      });
    }

    const themeSel = document.getElementById('theme-select');
    if (themeSel) {
      themeSel.addEventListener('change', (e) => {
        this.term0.setTheme(e.target.value);
        this.term1.setTheme(e.target.value);
      });
    }

    const wsChk = document.getElementById('chk-wordstar');
    if (wsChk) {
      wsChk.addEventListener('change', (e) => {
        this.term0.wordstarArrows = e.target.checked;
        this.term1.wordstarArrows = e.target.checked;
      });
    }

    const scanChk = document.getElementById('chk-scanlines');
    if (scanChk) {
      scanChk.addEventListener('change', (e) => {
        const wrap = document.querySelector('.terminal-viewport');
        if (wrap) wrap.classList.toggle('no-scanlines', !e.target.checked);
      });
    }

    // Terminal Copy, Paste, Clear
    const btnPaste = document.getElementById('btn-paste');
    if (btnPaste) {
      btnPaste.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          for (let i = 0; i < text.length; i++) {
            this.board.sendSerial(this.activeSerialTab, text.charCodeAt(i));
          }
        } catch {
          const text = prompt('Paste text to send over Serial Console:');
          if (text) {
            for (let i = 0; i < text.length; i++) {
              this.board.sendSerial(this.activeSerialTab, text.charCodeAt(i));
            }
          }
        }
      });
    }

    const btnCopy = document.getElementById('btn-copy-screen');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => {
        const term = this.activeSerialTab === 0 ? this.term0 : this.term1;
        navigator.clipboard.writeText(term.getScreenText());
        btnCopy.textContent = 'Copied!';
        setTimeout(() => (btnCopy.textContent = 'Copy'), 1200);
      });
    }

    const btnClear = document.getElementById('btn-clear-term');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        const term = this.activeSerialTab === 0 ? this.term0 : this.term1;
        term.reset();
      });
    }

    // Terminal Scrollbar
    const termScrollbar = document.getElementById('term-scrollbar');
    if (termScrollbar) {
      termScrollbar.addEventListener('scroll', () => {
        if (this.syncingTermScroll) return;
        const term = this.activeSerialTab === 0 ? this.term0 : this.term1;
        const maxScroll = termScrollbar.scrollHeight - termScrollbar.clientHeight;
        if (maxScroll <= 0) return;
        const ratio = termScrollbar.scrollTop / maxScroll;
        term.scrollOffset = Math.round(ratio * term.scrollback.length);
        term.render();
      });
    }

    // Tactile Hardware Switches
    const hwReset = document.getElementById('hw-reset-btn');
    if (hwReset) hwReset.addEventListener('click', () => this.resetHardwareTactile());

    const sc126Reset = document.getElementById('sc126-reset-btn');
    if (sc126Reset) sc126Reset.addEventListener('click', () => this.resetHardwareTactile());

    // SC126 8-LED Diagnostic Bar Click-to-toggle
    const sc126Bar = document.getElementById('sc126-led-bar');
    if (sc126Bar) {
      sc126Bar.addEventListener('click', (e) => {
        const cell = e.target.closest('.diag-led-cell');
        if (cell && this.board.writeExtIO) {
          const bit = parseInt(cell.getAttribute('data-bit'), 10);
          if (!isNaN(bit)) {
            const cur = this.board.diagLeds || 0;
            const updated = cur ^ (1 << bit);
            this.board.writeExtIO(0x0D, updated);
            this.updateSc126DiagBarUI(updated);
          }
        }
      });
    }

    // Supply Voltage Slider (DS1233 supervisor)
    const vccSlider = document.getElementById('vcc-slider');
    const vccVal = document.getElementById('vcc-val');
    const sbVcc = document.getElementById('sb-vcc');
    if (vccSlider) {
      vccSlider.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        if (vccVal) vccVal.textContent = v.toFixed(2) + 'V';
        if (sbVcc) sbVcc.textContent = 'Vcc: ' + v.toFixed(2) + 'V';
        this.boards.sc131.voltage = v;
        this.boards.sc126.voltage = v;
      });
    }

    // MicroSD Mount, Export, Eject
    const sdInput = document.getElementById('sd-file-input');
    if (sdInput) {
      sdInput.addEventListener('change', (e) => this.handleCustomSdMount(e));
    }

    const btnSdExport = document.getElementById('btn-sd-export');
    if (btnSdExport) {
      btnSdExport.addEventListener('click', () => this.exportSdImage());
    }

    const btnSdEject = document.getElementById('btn-sd-eject');
    if (btnSdEject) {
      btnSdEject.addEventListener('click', () => {
        if (this.board.sdcard && this.board.sdcard.image) {
          this.board.sdcard.detachImage();
          btnSdEject.textContent = 'Insert SD';
          const stat = document.getElementById('sd-status-text');
          if (stat) stat.textContent = 'SD0: [Ejected / No Card]';
        } else {
          this.mountDefaultRomWBWSdImage();
          btnSdEject.textContent = 'Eject SD';
        }
      });
    }

    // Custom ROM file inputs
    const romInputs = [
      document.getElementById('rom-file-input'),
      document.getElementById('rom-file-input-sc126'),
    ];
    romInputs.forEach((inp) => {
      if (inp) inp.addEventListener('change', (e) => this.handleCustomRomUpload(e));
    });

    // Jumpers
    const btnJp1 = document.getElementById('btn-jp1');
    if (btnJp1) {
      btnJp1.addEventListener('click', () => {
        this.board.jp1WriteEnable = !this.board.jp1WriteEnable;
        if (this.board.jp1WriteEnable) {
          btnJp1.className = 'jumper-btn wr';
          btnJp1.textContent = 'JP1: Wr (Flash Writable)';
        } else {
          btnJp1.className = 'jumper-btn rd';
          btnJp1.textContent = 'JP1: Rd (Write Protected)';
        }
      });
    }

    // Status bar clickable elements
    const sbMachine = document.getElementById('sb-machine');
    if (sbMachine) {
      sbMachine.addEventListener('click', () => {
        this.switchMachine(this.machineType === 'sc131' ? 'sc126' : 'sc131');
      });
    }

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleHardwareSidebar();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        this.resetHardwareTactile();
      } else if (e.key === 'F5' || e.key === 'F8') {
        e.preventDefault();
        if (this.running) this.pause();
        else this.resume();
      } else if (e.key === 'F10') {
        e.preventDefault();
        this.stepInstruction();
      }
    });
  }

  toggleHardwareSidebar(forceState) {
    const side = document.getElementById('side-column');
    const btn = document.getElementById('btn-toggle-hardware');
    if (!side) return;

    this.hardwareSidebarVisible = typeof forceState === 'boolean' ? forceState : !this.hardwareSidebarVisible;
    side.classList.toggle('hidden', !this.hardwareSidebarVisible);
    if (btn) btn.classList.toggle('active', this.hardwareSidebarVisible);
  }

  syncTerminalScrollbar() {
    const term = this.activeSerialTab === 0 ? this.term0 : this.term1;
    const scrollbar = document.getElementById('term-scrollbar');
    const spacer = document.getElementById('term-scroll-spacer');
    if (!scrollbar || !spacer) return;

    const totalLines = term.scrollback.length + term.rows;
    spacer.style.height = `${Math.max(scrollbar.clientHeight + 1, totalLines * 16)}px`;

    this.syncingTermScroll = true;
    if (term.scrollback.length > 0) {
      const ratio = term.scrollOffset / term.scrollback.length;
      scrollbar.scrollTop = Math.round(ratio * (scrollbar.scrollHeight - scrollbar.clientHeight));
    } else {
      scrollbar.scrollTop = 0;
    }
    this.syncingTermScroll = false;
  }

  async handleCustomSdMount(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const raw = new Uint8Array(ab);
      const img = await decompressIfGzip(raw);
      if (this.board.sdcard) {
        this.board.sdcard.attachImage(img);
      }
      const stat = document.getElementById('sd-status-text');
      if (stat) stat.textContent = `SD0: ${file.name} (${(img.byteLength / (1024 * 1024)).toFixed(1)} MB)`;
      const sbSd = document.getElementById('sb-sd');
      if (sbSd) sbSd.textContent = `SDHC: ${file.name}`;
      e.target.value = '';
    } catch (err) {
      alert(`Could not mount SD image: ${err.message}`);
    }
  }

  exportSdImage() {
    if (!this.board.sdcard || !this.board.sdcard.image) {
      alert('No SD card image is currently mounted.');
      return;
    }
    const blob = new Blob([this.board.sdcard.image], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.machineType}_sdcard_export.img`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async handleCustomRomUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      if (bytes.byteLength > 512 * 1024) {
        alert('ROM file exceeds 512 KB Flash ROM capacity.');
        return;
      }
      this.board.loadRom(bytes);
      this.resetHardwareTactile();
      alert(`Loaded custom ROM "${file.name}" (${bytes.byteLength} bytes) into Flash ROM.`);
      e.target.value = '';
    } catch (err) {
      alert(`Error loading ROM file: ${err.message}`);
    }
  }

  stepInstruction() {
    if (this.running) this.pause();
    this.board.cpu.step();
    this.totalExecutedCycles++;
  }

  pause() {
    this.running = false;
    const btn = document.getElementById('btn-run-pause');
    if (btn) {
      btn.textContent = '▶ Run';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
    }
    const pill = document.getElementById('status-pill');
    if (pill) {
      pill.textContent = 'PAUSED';
      pill.className = 'pill pill-paused';
    }
    const sbCpu = document.getElementById('sb-cpu-state');
    if (sbCpu) sbCpu.textContent = '⏸ Paused';
  }

  resume() {
    this.running = true;
    this.lastFrameTime = performance.now();
    const btn = document.getElementById('btn-run-pause');
    if (btn) {
      btn.textContent = 'Pause';
      btn.classList.remove('btn-success');
      btn.classList.add('btn-primary');
    }
    const pill = document.getElementById('status-pill');
    if (pill) {
      pill.textContent = `RUNNING @ ${(18.432 * this.speedMultiplier).toFixed(2)} MHz`;
      pill.className = 'pill pill-running';
    }
    const sbCpu = document.getElementById('sb-cpu-state');
    if (sbCpu) sbCpu.textContent = `● ${(18.432 * this.speedMultiplier).toFixed(2)} MHz`;

    requestAnimationFrame((t) => this.runLoop(t));
  }

  runLoop(timestamp) {
    if (!this.running) return;

    const deltaMs = Math.min(timestamp - this.lastFrameTime, 100);
    this.lastFrameTime = timestamp;

    const targetFreq = 18432000 * this.speedMultiplier;
    const cyclesToRun = Math.floor((targetFreq * deltaMs) / 1000) + this.cycleDebt;

    const chunkSize = 25000;
    let cyclesDone = 0;

    while (cyclesDone < cyclesToRun) {
      const slice = Math.min(chunkSize, cyclesToRun - cyclesDone);
      const res = this.board.runCycles(slice);
      cyclesDone += res.cyclesExecuted;
      this.totalExecutedCycles += res.cyclesExecuted;

      if (res.breakpointHit) {
        this.pause();
        break;
      }
      if (res.cyclesExecuted === 0) break;
    }

    this.cycleDebt = cyclesToRun - cyclesDone;

    // Performance telemetry update (~2 times per second)
    this.fpsCounter++;
    if (timestamp - this.fpsLastTime >= 500) {
      const elapsedSec = (timestamp - this.fpsLastTime) / 1000;
      const cyclesDelta = this.totalExecutedCycles - this.lastCycles;
      this.measuredMhz = (cyclesDelta / elapsedSec) / 1000000;
      this.lastCycles = this.totalExecutedCycles;
      this.fpsLastTime = timestamp;
      this.fpsCounter = 0;

      const perfEl = document.getElementById('perf-counter');
      if (perfEl) {
        perfEl.textContent = `${this.measuredMhz.toFixed(2)} MHz • ${this.totalExecutedCycles.toLocaleString()} cycles`;
      }

      const sbCycles = document.getElementById('sb-cycles');
      if (sbCycles) {
        sbCycles.textContent = `${this.totalExecutedCycles.toLocaleString()} cycles`;
      }

      const sbPc = document.getElementById('sb-pc');
      if (sbPc && this.board.cpu) {
        sbPc.textContent = `PC: $${hex4(this.board.cpu.pc)}`;
      }

      this.updateSc126RtcUI();
    }

    if (this.running) {
      requestAnimationFrame((t) => this.runLoop(t));
    }
  }

  async initEmulator() {
    // Preload default ROMs
    await Promise.all([
      this.loadRomFile('romwbw_sc131'),
      this.loadRomFile('romwbw_sc126'),
      this.loadRomFile('scm_s6'),
    ]);

    await this.applyFirmwareAndBoot('romwbw');
  }
}

// Instantiate application on DOM ready
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    window.app = new SC131App();
  });
}

export { SC131App };
