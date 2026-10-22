/**
 * SC131 & SC126 Modern Hardware Emulator Application
 *
 * Dedicated cycle-accurate emulator for Stephen C. Cousins':
 * - SC131 Z180 Pocket Computer (18.432 MHz, 512K Flash, 512K SRAM, SDHC, Status LED1)
 * - SC126 Z180 RC2014 Motherboard (18.432 MHz, 512K Flash, 512K SRAM, SDHC, DS1302 RTC, 8-LED Bar)
 *
 * Modern Dark Studio UI:
 * - Native desktop titlebar menu & Quick Boot shortcuts
 * - Layout toggle icons (Bottom Panel, Hardware Sidebar)
 * - Full-height Dual Serial Terminal (ASCI0 Console / ASCI1 Aux)
 * - Docked Bottom Debugger Panel (CPU & MMU, Disassembler, Virtualized Memory Hex)
 * - Hardware Sidebar reflecting the active physical machine
 */

import { SC131 } from '../emulator/sc131.js';
import { SC126 } from '../emulator/sc126.js';
import { disassembleRange, disassembleOne } from '../emulator/disasm.js';
import { SerialTerminal } from './terminal.js';

const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hex5 = (v) => (v & 0xFFFFF).toString(16).toUpperCase().padStart(5, '0');
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

    // Layout State
    this.hardwareSidebarVisible = true;
    this.debuggerVisible = true;
    this.debuggerLive = false;
    this.activeBottomTab = 'all';

    // Debugger State
    this.disasmBaseAddr = null;
    this.breakpoints = new Set();
    this.memSpace = 'logical';
    this.memBaseAddr = 0;
    this.syncingMemInput = false;
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
      this.term0.write(byte);
      this.triggerSerialDot(0);

      // Macro queue watch buffer
      if (this.macroQueue.length > 0) {
        const char = String.fromCharCode(byte);
        this.serialWatchBuffer += char;
        if (this.serialWatchBuffer.length > 256) {
          this.serialWatchBuffer = this.serialWatchBuffer.slice(-128);
        }
        this.checkMacroQueue();
      }
    } else if (ch === 1) {
      this.term1.write(byte);
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
    if (rwEl) rwEl.textContent = `${this.board.sdCard.readCount} / ${this.board.sdCard.writeCount}`;
  }

  updateLedsUI(leds) {
    if (this.machineType === 'sc131') {
      const led1 = document.getElementById('led-status');
      if (led1 && typeof leds.statusLed !== 'undefined') {
        led1.classList.toggle('on', leds.statusLed);
      }
      const pwr = document.getElementById('led-power');
      if (pwr && typeof leds.powerLed !== 'undefined') {
        pwr.classList.toggle('on', leds.powerLed);
      }
      const rst = document.getElementById('led-reset');
      if (rst && typeof leds.resetLed !== 'undefined') {
        rst.classList.toggle('on', leds.resetLed);
      }
    } else if (this.machineType === 'sc126') {
      const pwr = document.getElementById('sc126-led-power');
      if (pwr && typeof leds.powerLed !== 'undefined') {
        pwr.classList.toggle('on', leds.powerLed);
      }
      const rst = document.getElementById('sc126-led-reset');
      if (rst && typeof leds.resetLed !== 'undefined') {
        rst.classList.toggle('on', leds.resetLed);
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

    // Titlebar breadcrumb
    const crumbMachine = document.getElementById('crumb-machine-name');
    if (crumbMachine) {
      crumbMachine.textContent = isSc131 ? 'SC131 Pocket Computer' : 'SC126 RC2014 Motherboard';
    }
    const crumbFw = document.getElementById('crumb-firmware-name');
    if (crumbFw) {
      const fwNames = {
        romwbw: 'RomWBW v3.6.0',
        fuzix: 'Fuzix Unix 0.4',
        scm_s6: 'Small Computer Monitor S6',
      };
      crumbFw.textContent = fwNames[this.firmwareType] || 'RomWBW';
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

    // Menu checkmarks
    const chk131 = document.getElementById('menu-chk-sc131');
    const chk126 = document.getElementById('menu-chk-sc126');
    if (chk131) chk131.innerHTML = isSc131 ? '&#9679; ' : '&#9675; ';
    if (chk126) chk126.innerHTML = !isSc131 ? '&#9679; ' : '&#9675; ';

    const chkFwRom = document.getElementById('menu-chk-fw-romwbw');
    const chkFwFuz = document.getElementById('menu-chk-fw-fuzix');
    const chkFwScm = document.getElementById('menu-chk-fw-scm');
    if (chkFwRom) chkFwRom.innerHTML = this.firmwareType === 'romwbw' ? '&#9679; ' : '&#9675; ';
    if (chkFwFuz) chkFwFuz.innerHTML = this.firmwareType === 'fuzix' ? '&#9679; ' : '&#9675; ';
    if (chkFwScm) chkFwScm.innerHTML = this.firmwareType === 'scm_s6' ? '&#9679; ' : '&#9675; ';

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

    // Update SD Card Slot title
    const sdTitle = document.getElementById('sd-port-title');
    if (sdTitle) {
      sdTitle.textContent = isSc131
        ? 'P1 • SPI MicroSDHC Slot (Port 0x0C / CSIO)'
        : 'P1 • SPI MicroSDHC Slot (Port 0x0C System / CSIO)';
    }

    this.updateLedsUI({
      statusLed: this.board.statusLed,
      powerLed: this.board.powerLed,
      resetLed: this.board.resetLed,
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
      this.board.flashRom.set(this.romCache[romKey]);
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
    if (this.sdBundleCache) {
      this.board.sdCard.attachImage(this.sdBundleCache);
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
    if (this.fuzixSdBundleCache) {
      this.board.sdCard.attachImage(this.fuzixSdBundleCache);
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

    this.updateDebuggerViews();
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
    // Native Menu Bar setup
    this.setupMenubar();

    // Layout Toggle Buttons
    const btnToggleDebugger = document.getElementById('btn-toggle-debugger');
    if (btnToggleDebugger) {
      btnToggleDebugger.addEventListener('click', () => this.toggleDebuggerPanel());
    }

    const btnToggleHardware = document.getElementById('btn-toggle-hardware');
    if (btnToggleHardware) {
      btnToggleHardware.addEventListener('click', () => this.toggleHardwareSidebar());
    }

    const btnHideDebugger = document.getElementById('btn-hide-debugger');
    if (btnHideDebugger) {
      btnHideDebugger.addEventListener('click', () => this.toggleDebuggerPanel(false));
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

    // Terminal Quick Boot Dropdown
    const btnQuickBoot = document.getElementById('btn-quick-boot-term');
    const termQuickMenu = document.getElementById('term-quickboot-menu');
    if (btnQuickBoot && termQuickMenu) {
      btnQuickBoot.addEventListener('click', (e) => {
        e.stopPropagation();
        termQuickMenu.classList.toggle('hidden');
      });
      document.addEventListener('click', (e) => {
        if (!termQuickMenu.contains(e.target) && e.target !== btnQuickBoot) {
          termQuickMenu.classList.add('hidden');
        }
      });
    }

    // Quick Boot Macro Buttons (all items with data-macro)
    document.querySelectorAll('[data-macro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const macro = btn.getAttribute('data-macro');
        if (macro) {
          this.quickBootMacro(macro);
          this.closeAllMenus();
        }
      });
    });

    const fuzixBtns = [
      document.getElementById('btn-fuzix-launch'),
      document.getElementById('menu-launch-fuzix'),
    ];
    fuzixBtns.forEach((btn) => {
      if (btn) btn.addEventListener('click', () => {
        this.launchFuzixQuick();
        this.closeAllMenus();
      });
    });

    const ledBtns = [
      document.getElementById('btn-led-demo'),
      document.getElementById('menu-launch-led-demo'),
    ];
    ledBtns.forEach((btn) => {
      if (btn) btn.addEventListener('click', () => {
        this.launchLedDemoQuick();
        this.closeAllMenus();
      });
    });

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
        this.term0.setSize(e.target.value);
        this.term1.setSize(e.target.value);
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
        this.term0.wordStarArrowKeys = e.target.checked;
        this.term1.wordStarArrowKeys = e.target.checked;
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
        if (cell && this.board.writeIo) {
          const bit = parseInt(cell.getAttribute('data-bit'), 10);
          if (!isNaN(bit)) {
            const cur = this.board.diagLedsByte || 0;
            const updated = cur ^ (1 << bit);
            this.board.writeIo(0x0D, updated);
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
    const menuSdInput = document.getElementById('menu-file-sd');
    if (menuSdInput) {
      menuSdInput.addEventListener('change', (e) => this.handleCustomSdMount(e));
    }

    const btnSdExport = document.getElementById('btn-sd-export');
    const menuSdExport = document.getElementById('menu-file-export-sd');
    [btnSdExport, menuSdExport].forEach((btn) => {
      if (btn) btn.addEventListener('click', () => this.exportSdImage());
    });

    const btnSdEject = document.getElementById('btn-sd-eject');
    if (btnSdEject) {
      btnSdEject.addEventListener('click', () => {
        if (this.board.sdCard.image) {
          this.board.sdCard.detachImage();
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
      document.getElementById('menu-file-rom'),
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
    const sbPc = document.getElementById('sb-pc');
    if (sbPc) {
      sbPc.addEventListener('click', () => {
        this.toggleDebuggerPanel(true);
        this.disasmAt(this.board.cpu.pc);
      });
    }

    // Bottom Debugger Panel Setup
    this.setupDebuggerUI();

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        this.toggleHardwareSidebar();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        this.toggleDebuggerPanel();
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

  setupMenubar() {
    const menubar = document.querySelector('.vscode-menubar');
    if (!menubar) return;

    menubar.querySelectorAll('.menubar-item').forEach((item) => {
      const btn = item.querySelector('.menubar-btn');
      if (!btn) return;

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = item.classList.contains('open');
        this.closeAllMenus();
        if (!isOpen) item.classList.add('open');
      });

      item.addEventListener('mouseenter', () => {
        const anyOpen = menubar.querySelector('.menubar-item.open');
        if (anyOpen && anyOpen !== item) {
          anyOpen.classList.remove('open');
          item.classList.add('open');
        }
      });
    });

    document.addEventListener('click', (e) => {
      if (!menubar.contains(e.target)) {
        this.closeAllMenus();
      }
    });

    // Menubar machine selector items
    document.querySelectorAll('[data-machine-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = btn.getAttribute('data-machine-pick');
        this.switchMachine(m);
        this.closeAllMenus();
      });
    });

    // Menubar firmware selector items
    document.querySelectorAll('[data-fw-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fw = btn.getAttribute('data-fw-pick');
        this.setFirmware(fw);
        this.closeAllMenus();
      });
    });

    // Speed pickers
    document.querySelectorAll('[data-speed-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.speedMultiplier = parseFloat(btn.getAttribute('data-speed-pick')) || 1.0;
        this.closeAllMenus();
      });
    });

    // View menu items
    const menuPanel = document.getElementById('menu-view-panel');
    if (menuPanel) menuPanel.addEventListener('click', () => {
      this.toggleDebuggerPanel();
      this.closeAllMenus();
    });

    const menuHw = document.getElementById('menu-view-hardware');
    if (menuHw) menuHw.addEventListener('click', () => {
      this.toggleHardwareSidebar();
      this.closeAllMenus();
    });

    const menuThAmber = document.getElementById('menu-view-theme-amber');
    if (menuThAmber) menuThAmber.addEventListener('click', () => {
      this.term0.setTheme('amber');
      this.term1.setTheme('amber');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = 'amber';
      this.closeAllMenus();
    });

    const menuThGreen = document.getElementById('menu-view-theme-green');
    if (menuThGreen) menuThGreen.addEventListener('click', () => {
      this.term0.setTheme('green');
      this.term1.setTheme('green');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = 'green';
      this.closeAllMenus();
    });

    const menuThModern = document.getElementById('menu-view-theme-modern');
    if (menuThModern) menuThModern.addEventListener('click', () => {
      this.term0.setTheme('modern');
      this.term1.setTheme('modern');
      const sel = document.getElementById('theme-select');
      if (sel) sel.value = 'modern';
      this.closeAllMenus();
    });

    const menuRunPause = document.getElementById('menu-run-pause');
    if (menuRunPause) menuRunPause.addEventListener('click', () => {
      if (this.running) this.pause();
      else this.resume();
      this.closeAllMenus();
    });

    const menuStep = document.getElementById('menu-run-step');
    if (menuStep) menuStep.addEventListener('click', () => {
      this.stepInstruction();
      this.closeAllMenus();
    });

    const menuReset = document.getElementById('menu-run-reset');
    if (menuReset) menuReset.addEventListener('click', () => {
      this.resetHardwareTactile();
      this.closeAllMenus();
    });

    const menuAbout = document.getElementById('menu-help-about');
    if (menuAbout) menuAbout.addEventListener('click', () => {
      alert('SC131 & SC126 Z180 Hardware Emulator v1.0\n\nCycle-accurate emulator for Stephen C. Cousins\' SC131 Pocket Computer and SC126 RCBus Motherboard.\n\nRunning RomWBW v3.6.0, CP/M 2.2, CP/M 3, WordStar 4, Small Computer Monitor S6, and Fuzix 0.4 Unix OS.');
      this.closeAllMenus();
    });
  }

  closeAllMenus() {
    document.querySelectorAll('.menubar-item.open').forEach((item) => {
      item.classList.remove('open');
    });
    const termMenu = document.getElementById('term-quickboot-menu');
    if (termMenu) termMenu.classList.add('hidden');
  }

  toggleDebuggerPanel(forceState) {
    const panel = document.getElementById('debugger-section');
    const btn = document.getElementById('btn-toggle-debugger');
    if (!panel) return;

    this.debuggerVisible = typeof forceState === 'boolean' ? forceState : !this.debuggerVisible;
    panel.classList.toggle('hidden', !this.debuggerVisible);
    if (btn) btn.classList.toggle('active', this.debuggerVisible);

    if (this.debuggerVisible) {
      this.updateDebuggerViews();
    }
  }

  toggleHardwareSidebar(forceState) {
    const side = document.getElementById('side-column');
    const btn = document.getElementById('btn-toggle-hardware');
    if (!side) return;

    this.hardwareSidebarVisible = typeof forceState === 'boolean' ? forceState : !this.hardwareSidebarVisible;
    side.classList.toggle('hidden', !this.hardwareSidebarVisible);
    if (btn) btn.classList.toggle('active', this.hardwareSidebarVisible);
  }

  setupDebuggerUI() {
    // Bottom Panel Tabs
    const tabs = document.querySelectorAll('.bottom-tab');
    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        tabs.forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeBottomTab = tab.getAttribute('data-bottom-tab');
        this.syncBottomTabsView();
      });
    });

    const liveChk = document.getElementById('chk-debugger-live');
    if (liveChk) {
      liveChk.addEventListener('change', (e) => {
        this.debuggerLive = e.target.checked;
      });
    }

    const refreshBtn = document.getElementById('btn-debugger-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.updateDebuggerViews());
    }

    // Disassembler Controls
    const disasmPcBtn = document.getElementById('btn-disasm-pc');
    if (disasmPcBtn) {
      disasmPcBtn.addEventListener('click', () => {
        this.disasmBaseAddr = null;
        this.updateDisassembly();
      });
    }

    const disasmAddrInp = document.getElementById('disasm-addr-input');
    if (disasmAddrInp) {
      disasmAddrInp.addEventListener('change', (e) => {
        const addr = parseInt(e.target.value, 16);
        if (!isNaN(addr)) {
          this.disasmBaseAddr = addr & 0xFFFF;
          this.updateDisassembly();
        }
      });
    }

    const bpInp = document.getElementById('bp-input');
    const addBpBtn = document.getElementById('btn-add-bp');
    const clearBpBtn = document.getElementById('btn-clear-bp');

    if (addBpBtn && bpInp) {
      addBpBtn.addEventListener('click', () => {
        const addr = parseInt(bpInp.value, 16);
        if (!isNaN(addr)) {
          this.breakpoints.add(addr & 0xFFFF);
          bpInp.value = '';
          this.updateDisassembly();
        }
      });
    }

    if (clearBpBtn) {
      clearBpBtn.addEventListener('click', () => {
        this.breakpoints.clear();
        this.updateDisassembly();
      });
    }

    // Memory Hex Inspector Controls
    const memSpaceSelect = document.getElementById('mem-space-select');
    if (memSpaceSelect) {
      memSpaceSelect.addEventListener('change', (e) => {
        this.memSpace = e.target.value;
        this.updateMemoryRangeLabel();
        this.updateMemoryHex();
      });
    }

    const memAddrInp = document.getElementById('mem-addr-input');
    if (memAddrInp) {
      memAddrInp.addEventListener('change', (e) => {
        const addr = parseInt(e.target.value, 16);
        if (!isNaN(addr)) {
          this.scrollMemoryTo(addr);
        }
      });
    }

    document.querySelectorAll('[data-mem-jump]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const addr = parseInt(btn.getAttribute('data-mem-jump'), 16);
        if (!isNaN(addr)) this.scrollMemoryTo(addr);
      });
    });

    document.querySelectorAll('[data-mem-reg]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const reg = btn.getAttribute('data-mem-reg');
        let addr = 0;
        if (reg === 'pc') addr = this.board.cpu.pc;
        else if (reg === 'sp') addr = this.board.cpu.sp;
        else if (reg === 'hl') addr = this.board.cpu.hl;
        this.scrollMemoryTo(addr);
      });
    });

    const memScroll = document.getElementById('mem-scroll-container');
    if (memScroll) {
      memScroll.addEventListener('scroll', () => {
        this.handleMemoryScroll();
      });
    }
  }

  syncBottomTabsView() {
    const cardCpu = document.getElementById('card-cpu');
    const cardDisasm = document.getElementById('card-disasm');
    const cardMem = document.getElementById('card-memory');
    const topGrid = document.getElementById('debugger-top-grid');

    if (this.activeBottomTab === 'all') {
      if (topGrid) topGrid.classList.remove('hidden');
      if (cardCpu) cardCpu.classList.remove('hidden');
      if (cardDisasm) cardDisasm.classList.remove('hidden');
      if (cardMem) cardMem.classList.remove('hidden');
    } else if (this.activeBottomTab === 'cpu') {
      if (topGrid) topGrid.classList.remove('hidden');
      if (cardCpu) cardCpu.classList.remove('hidden');
      if (cardDisasm) cardDisasm.classList.add('hidden');
      if (cardMem) cardMem.classList.add('hidden');
    } else if (this.activeBottomTab === 'disasm') {
      if (topGrid) topGrid.classList.remove('hidden');
      if (cardCpu) cardCpu.classList.add('hidden');
      if (cardDisasm) cardDisasm.classList.remove('hidden');
      if (cardMem) cardMem.classList.add('hidden');
    } else if (this.activeBottomTab === 'memory') {
      if (topGrid) topGrid.classList.add('hidden');
      if (cardMem) cardMem.classList.remove('hidden');
    }
  }

  updateDebuggerViews() {
    if (!this.debuggerVisible) return;
    this.updateCpuRegistersUI();
    this.updateDisassembly();
    this.updateMemoryHex();
  }

  updateCpuRegistersUI() {
    const cpu = this.board.cpu;
    if (!cpu) return;

    const setReg = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = hex4(val);
    };

    setReg('reg-pc', cpu.pc);
    setReg('reg-sp', cpu.sp);
    setReg('reg-af', (cpu.a << 8) | cpu.f);
    setReg('reg-bc', cpu.bc);
    setReg('reg-de', cpu.de);
    setReg('reg-hl', cpu.hl);
    setReg('reg-ix', cpu.ix);
    setReg('reg-iy', cpu.iy);
    setReg('reg-af2', (cpu.a2 << 8) | cpu.f2);
    setReg('reg-bc2', cpu.bc2);
    setReg('reg-de2', cpu.de2);
    setReg('reg-hl2', cpu.hl2);

    const irEl = document.getElementById('reg-ir');
    if (irEl) irEl.textContent = `${hex2(cpu.i)} / ${hex2(cpu.r)}`;

    const flagsEl = document.getElementById('reg-flags');
    if (flagsEl) {
      const f = cpu.f;
      const s = (f & 0x80) ? 'S' : '.';
      const z = (f & 0x40) ? 'Z' : '.';
      const h = (f & 0x10) ? 'H' : '.';
      const pv = (f & 0x04) ? 'P' : '.';
      const n = (f & 0x02) ? 'N' : '.';
      const c = (f & 0x01) ? 'C' : '.';
      flagsEl.textContent = `${s}${z}.${h}.${pv}${n}${c}`;
    }

    const modeBadge = document.getElementById('cpu-mode-badge');
    if (modeBadge) {
      const im = cpu.im;
      const iff = cpu.iff1 ? 'EI' : 'DI';
      modeBadge.textContent = `IM ${im} • ${iff}`;
    }

    // MMU Translation Table
    const mmu = cpu.mmu;
    if (mmu) {
      const rawEl = document.getElementById('mmu-regs-raw');
      if (rawEl) {
        rawEl.textContent = `CBAR=${hex2(mmu.cbar)} BBR=${hex2(mmu.bbr)} CBR=${hex2(mmu.cbr)}`;
      }

      const barsEl = document.getElementById('mmu-bars');
      if (barsEl) {
        const ca0End = mmu.ba;
        const bankEnd = mmu.ca;

        const ca0Phys = mmu.cbr << 12;
        const bankPhys = (mmu.bbr << 12) + (ca0End << 12);
        const ca1Phys = (mmu.cbr << 12) + (bankEnd << 12);

        barsEl.innerHTML = `
          <div class="mmu-row">
            <span>Common 1: $${hex4(bankEnd << 12)}&ndash;$FFFF</span>
            <span>&rarr; Phys $${hex5(ca1Phys)} &bull; ${ca1Phys >= 0x80000 ? 'SRAM' : 'ROM'}</span>
          </div>
          <div class="mmu-row">
            <span>Bank Area: $${hex4(ca0End << 12)}&ndash;$${hex4((bankEnd << 12) - 1)}</span>
            <span>&rarr; Phys $${hex5(bankPhys)} &bull; ${bankPhys >= 0x80000 ? 'SRAM' : 'ROM'}</span>
          </div>
          <div class="mmu-row">
            <span>Common 0: $0000&ndash;$${hex4((ca0End << 12) - 1)}</span>
            <span>&rarr; Phys $${hex5(ca0Phys)} &bull; ${ca0Phys >= 0x80000 ? 'SRAM' : 'ROM'}</span>
          </div>
        `;
      }
    }
  }

  updateDisassembly() {
    const listEl = document.getElementById('disasm-view');
    if (!listEl) return;

    const pc = this.board.cpu.pc;
    const base = this.disasmBaseAddr !== null ? this.disasmBaseAddr : Math.max(0, pc - 4);

    const readByte = (addr) => this.board.readMem(addr & 0xFFFF);
    const instructions = disassembleRange(readByte, base, 16);

    let html = '';
    for (const inst of instructions) {
      const isPc = inst.address === pc;
      const isBp = this.breakpoints.has(inst.address);
      const rowClass = `disasm-row ${isPc ? 'pc-active' : ''} ${isBp ? 'bp-hit' : ''}`;
      const bytesStr = inst.bytes.map(hex2).join(' ').padEnd(12, ' ');

      html += `
        <div class="${rowClass}" data-addr="${hex4(inst.address)}">
          <span class="disasm-bp-dot ${isBp ? 'active' : ''}"></span>
          <span class="disasm-addr">$${hex4(inst.address)}</span>
          <span class="disasm-bytes">${bytesStr}</span>
          <span class="disasm-mnemonic">${inst.mnemonic} ${inst.operands}</span>
        </div>
      `;
    }
    listEl.innerHTML = html;

    // Click on row toggles breakpoint
    listEl.querySelectorAll('.disasm-row').forEach((row) => {
      row.addEventListener('click', () => {
        const addr = parseInt(row.getAttribute('data-addr'), 16);
        if (this.breakpoints.has(addr)) this.breakpoints.delete(addr);
        else this.breakpoints.add(addr);
        this.updateDisassembly();
      });
    });
  }

  disasmAt(addr) {
    this.disasmBaseAddr = addr & 0xFFFF;
    this.updateDisassembly();
  }

  updateMemoryRangeLabel() {
    const lbl = document.getElementById('mem-range-label');
    if (!lbl) return;
    if (this.memSpace === 'logical') {
      lbl.textContent = '$0000 – $FFFF (64 KB Logical CPU)';
    } else if (this.memSpace === 'rom') {
      lbl.textContent = '$00000 – $7FFFF (512 KB Physical Flash ROM)';
    } else if (this.memSpace === 'ram') {
      lbl.textContent = '$80000 – $FFFFF (512 KB Physical SRAM)';
    }
  }

  getTotalMemoryBytes() {
    return this.memSpace === 'logical' ? 0x10000 : 0x80000;
  }

  scrollMemoryTo(addr) {
    const max = this.getTotalMemoryBytes();
    const clamped = Math.max(0, Math.min(addr, max - 16));
    const rowIndex = Math.floor(clamped / 16);
    const container = document.getElementById('mem-scroll-container');
    if (container) {
      container.scrollTop = rowIndex * MEM_ROW_HEIGHT;
    }
    const inp = document.getElementById('mem-addr-input');
    if (inp) inp.value = hex4(clamped);
  }

  handleMemoryScroll() {
    const container = document.getElementById('mem-scroll-container');
    if (!container) return;
    const top = container.scrollTop;
    const rowIndex = Math.floor(top / MEM_ROW_HEIGHT);
    const addr = rowIndex * 16;
    this.memBaseAddr = addr;

    const inp = document.getElementById('mem-addr-input');
    if (inp && !this.syncingMemInput) {
      inp.value = hex4(addr);
    }
    this.renderMemoryRows();
  }

  updateMemoryHex() {
    const spacer = document.getElementById('mem-scroll-spacer');
    if (spacer) {
      const totalRows = this.getTotalMemoryBytes() / 16;
      spacer.style.height = `${totalRows * MEM_ROW_HEIGHT}px`;
    }
    this.renderMemoryRows();
  }

  renderMemoryRows() {
    const viewport = document.getElementById('mem-hex-view');
    const container = document.getElementById('mem-scroll-container');
    if (!viewport || !container) return;

    const top = container.scrollTop;
    const height = container.clientHeight || 200;
    const startRow = Math.max(0, Math.floor(top / MEM_ROW_HEIGHT) - 1);
    const visibleRowCount = Math.ceil(height / MEM_ROW_HEIGHT) + 3;

    viewport.style.transform = `translateY(${startRow * MEM_ROW_HEIGHT}px)`;

    const totalBytes = this.getTotalMemoryBytes();
    let html = '';

    for (let r = 0; r < visibleRowCount; r++) {
      const addr = (startRow + r) * 16;
      if (addr >= totalBytes) break;

      let hexBytes = '';
      let ascii = '';

      for (let c = 0; c < 16; c++) {
        const byteAddr = addr + c;
        let val = 0;
        if (this.memSpace === 'logical') {
          val = this.board.readMem(byteAddr);
        } else if (this.memSpace === 'rom') {
          val = this.board.flashRom[byteAddr] || 0;
        } else if (this.memSpace === 'ram') {
          val = this.board.sram[byteAddr] || 0;
        }

        hexBytes += hex2(val) + (c === 7 ? '  ' : ' ');
        ascii += (val >= 32 && val <= 126) ? String.fromCharCode(val) : '.';
      }

      const addrLabel = this.memSpace === 'logical' ? hex4(addr) : hex5(addr);
      html += `
        <div class="hex-row">
          <span class="hex-row-addr">${addrLabel}</span>
          <span class="hex-row-bytes">${hexBytes}</span>
          <span class="hex-row-ascii">${ascii}</span>
        </div>
      `;
    }
    viewport.innerHTML = html;
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
      this.board.sdCard.attachImage(img);
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
    const img = this.board.sdCard.image;
    if (!img) {
      alert('No SD card image is currently mounted.');
      return;
    }
    const blob = new Blob([img], { type: 'application/octet-stream' });
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
      this.board.flashRom.fill(0xFF);
      this.board.flashRom.set(bytes);
      this.resetHardwareTactile();
      alert(`Loaded custom ROM "${file.name}" (${bytes.byteLength} bytes) into Flash ROM U1.`);
      e.target.value = '';
    } catch (err) {
      alert(`Error loading ROM file: ${err.message}`);
    }
  }

  stepInstruction() {
    if (this.running) this.pause();
    this.board.stepCycles(1);
    this.updateDebuggerViews();
  }

  pause() {
    this.running = false;
    const btn = document.getElementById('btn-run-pause');
    if (btn) {
      btn.textContent = '▶ Run';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
    }
    const sbCpu = document.getElementById('sb-cpu-state');
    if (sbCpu) sbCpu.textContent = '⏸ Paused';

    this.updateDebuggerViews();
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

    const chunkSize = 20000;
    let cyclesDone = 0;
    let hitBreakpoint = false;

    while (cyclesDone < cyclesToRun && !hitBreakpoint) {
      const slice = Math.min(chunkSize, cyclesToRun - cyclesDone);
      const executed = this.board.stepCycles(slice);
      cyclesDone += executed;

      // Breakpoint check
      if (this.breakpoints.size > 0 && this.breakpoints.has(this.board.cpu.pc)) {
        hitBreakpoint = true;
        this.pause();
        this.disasmAt(this.board.cpu.pc);
        break;
      }

      if (executed === 0) break;
    }

    this.cycleDebt = cyclesToRun - cyclesDone;

    // Performance telemetry
    this.fpsCounter++;
    if (timestamp - this.fpsLastTime >= 500) {
      const elapsedSec = (timestamp - this.fpsLastTime) / 1000;
      const cyclesDelta = this.board.totalCycles - this.lastCycles;
      this.measuredMhz = (cyclesDelta / elapsedSec) / 1000000;
      this.lastCycles = this.board.totalCycles;
      this.fpsLastTime = timestamp;
      this.fpsCounter = 0;

      const perfEl = document.getElementById('perf-counter');
      if (perfEl) {
        perfEl.textContent = `${this.measuredMhz.toFixed(2)} MHz • ${this.board.totalCycles.toLocaleString()} cycles`;
      }

      const sbCycles = document.getElementById('sb-cycles');
      if (sbCycles) {
        sbCycles.textContent = `${this.board.totalCycles.toLocaleString()} cycles`;
      }

      const sbPc = document.getElementById('sb-pc');
      if (sbPc) {
        sbPc.textContent = `PC: $${hex4(this.board.cpu.pc)}`;
      }

      this.updateSc126RtcUI();

      if (this.debuggerLive) {
        this.updateDebuggerViews();
      }
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
