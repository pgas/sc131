/**
 * Small Computer Workshop (SCW) & SC131 / SC126 IDE Application
 * - VS Code-style Workbench with Activity Bar, Left Sidebar, Tabbed Center Views,
 *   Side-by-Side Split View, Docked Bottom Panel, and Hardware Sidebar.
 * - Supports three targets:
 *     1) SC131 Z180 Pocket Computer (RomWBW, SCM S6, Fuzix 0.4)
 *     2) SC126 Z180 RC2014 Motherboard (RomWBW, SCM S6, Fuzix 0.4, DS1302 RTC, 8-LED Bar)
 *     3) Simulated Z80 Computer (SCWorkshop pure Z80, Memory-Mapped Screen $4000, Line Printer $03)
 * - Two-pass Z80/Z180 Assembler with Interactive Listing, Intel HEX, Memory Dump, and Symbol Table.
 * - Multi-speed Execution: Run (Real-Time / Turbo), Jog (Animated ~600 ips), Walk (Animated ~12 ips), and Step.
 * - Instruction Simulation Trace & Interactive Number Base / ASCII Converter.
 */

import { SC131 } from '../emulator/sc131.js';
import { SC126 } from '../emulator/sc126.js';
import { SimulatedZ80 } from '../emulator/sim_z80.js';
import { assemble } from '../emulator/assembler.js';
import { SCW_EXAMPLES } from '../emulator/scw_examples.js';
import { disassembleRange, disassembleOne } from '../emulator/disasm.js';
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

class SCWorkshopApp {
  constructor() {
    this.running = false;
    this.speedMultiplier = 1.0;
    this.simulationMode = 'run'; // 'run' | 'jog' | 'walk' | 'paused'
    this.walkTimer = null;
    this.jogAccumulator = 0;

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
    this.machineType = mParam === 'sc126' ? 'sc126' : (mParam === 'sim_z80' ? 'sim_z80' : 'sc131');

    // Layout State
    this.activeCenterTab = 'terminal';
    this.splitMode = false;
    this.activeSidebarView = 'explorer';
    this.sidebarVisible = true;
    this.hardwareSidebarVisible = true;
    this.debuggerVisible = true;
    this.debuggerLive = false;
    this.activeBottomTab = 'all';

    this.disasmBaseAddr = null;
    this.syncingMemInput = false;
    this.syncingTermScroll = false;
    this.syncingConversions = false;

    // Macro queue for prompt-driven boots
    this.macroQueue = [];
    this.serialWatchBuffer = '';

    // Assembler & Trace State
    this.currentAsmResult = null;
    this.currentAsmFileName = 'Count.asm';
    this.currentExampleId = 'scw_count';
    this.traceBuffer = [];
    this.traceStepCount = 0;

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

    // Initialize all three machine targets
    this.boards = {
      sc131: new SC131({
        onSerialTx: (ch, byte) => this.handleBoardSerialTx('sc131', ch, byte),
        onLedChange: (leds) => {
          if (this.machineType === 'sc131') this.updateLedsUI(leds);
        },
        onSdActivity: (op, lba) => {
          if (this.machineType === 'sc131') this.handleSdActivity(op, lba);
        },
        onPrinterOut: (b, text) => {
          if (this.machineType === 'sc131') this.updatePrinterUI(text);
        },
        onScreenWrite: () => {
          if (this.machineType === 'sc131') this.updateSimScreenUI();
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
        onPrinterOut: (b, text) => {
          if (this.machineType === 'sc126') this.updatePrinterUI(text);
        },
        onScreenWrite: () => {
          if (this.machineType === 'sc126') this.updateSimScreenUI();
        },
      }),
      sim_z80: new SimulatedZ80({
        onSerialTx: (ch, byte) => this.handleBoardSerialTx('sim_z80', ch, byte),
        onLedChange: (leds) => {
          if (this.machineType === 'sim_z80') this.updateLedsUI(leds);
        },
        onPrinterOut: (b, text) => {
          if (this.machineType === 'sim_z80') this.updatePrinterUI(text);
        },
        onScreenWrite: () => {
          if (this.machineType === 'sim_z80') this.updateSimScreenUI();
        },
      }),
    };

    this.board = this.boards[this.machineType];
    this.sc131 = this.board; // backwards compatibility

    this.initExamplesUI();
    this.bindUI();
    this.setupTerminalScrollbar();
    this.syncMachineChrome();
    this.setupMemoryVirtualScroll();
    this.setupConversionsTool();

    // Default boot behavior
    if (this.machineType === 'sim_z80') {
      this.loadExampleById('scw_count');
      this.startLoop();
    } else {
      this.loadExampleById(this.machineType === 'sc126' ? 'scm_led_show' : 'sc131_led1_blink');
      this.bootDefaultSystem();
    }
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
    const is126 = this.machineType === 'sc126';
    const isSim = this.machineType === 'sim_z80';

    if (this.machineType === 'sc131') {
      document.getElementById('led-status')?.classList.toggle('on', leds.status);
      document.getElementById('led-power')?.classList.toggle('on', leds.power);
      document.getElementById('led-reset')?.classList.toggle('on', leds.reset);
    } else if (is126) {
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

    // Update SCWorkshop Simulated I/O Port $00 in Right Sidebar
    const simLedsByte = leds.simLeds ?? (leds.diagByte ?? 0);
    const simSwitchesByte = leds.simSwitches ?? (this.board.simSwitches ?? 0);
    for (let bit = 0; bit < 8; bit++) {
      const ledEl = document.getElementById(`sim-out-led-${bit}`);
      ledEl?.classList.toggle('on', ((simLedsByte >> bit) & 1) !== 0);

      const swBtn = document.querySelector(`.sim-sw-btn[data-sw-bit="${bit}"]`);
      if (swBtn) {
        const on = ((simSwitchesByte >> bit) & 1) !== 0;
        swBtn.classList.toggle('on', on);
        const lever = swBtn.querySelector('.sw-lever');
        if (lever) lever.textContent = on ? '1' : '0';
      }
    }
    const outHexEl = document.getElementById('sim-out-hex');
    if (outHexEl) outHexEl.textContent = `$${hex2(simLedsByte)} (${bin8(simLedsByte)})`;
    const inHexEl = document.getElementById('sim-in-hex');
    if (inHexEl) inHexEl.textContent = `$${hex2(simSwitchesByte)} (${bin8(simSwitchesByte)})`;

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

  updatePrinterUI(text = this.board.printerText) {
    const el = document.getElementById('sim-printer-view');
    if (el) {
      el.textContent = text || '[Simulated Line Printer Ready (Port $03)]';
      el.scrollTop = el.scrollHeight;
    }
  }

  updateSimScreenUI() {
    const el = document.getElementById('sim-screen-view');
    if (!el) return;
    const lines = [];
    for (let row = 0; row < 32; row++) {
      let line = '';
      for (let col = 0; col < 64; col++) {
        const addr = 0x4000 + row * 64 + col;
        const b = this.board.cpu.memRead(addr);
        const ch = (b >= 32 && b <= 126) ? String.fromCharCode(b) : ' ';
        line += ch;
      }
      lines.push(line);
    }
    el.textContent = lines.join('\n');
  }

  syncMachineChrome() {
    const is126 = this.machineType === 'sc126';
    const isSim = this.machineType === 'sim_z80';

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
    const fwGroup = document.getElementById('firmware-control-group');

    if (badge) badge.textContent = isSim ? 'SCW' : (is126 ? 'SC126' : 'SC131');
    if (title) {
      title.textContent = isSim
        ? 'Small Computer Workshop — Simulated Z80 Computer'
        : (is126
          ? 'SC126 Z180 RC2014 Motherboard IDE & Emulator'
          : 'SC131 Z180 Pocket Computer IDE & Emulator');
    }
    if (sub) {
      sub.textContent = isSim
        ? 'Simulated Z80 @ 4.0 MHz • 64 KB RAM • Screen $4000 • Printer $03 • Ports $00/$01/$02'
        : (is126
          ? 'Z8S180 @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • Port $0D 8-LED Bar • DS1302 RTC'
          : 'Zilog Z8S180 @ 18.432 MHz • 512 KB Flash • 512 KB SRAM • SPI SDHC');
    }
    if (link) {
      link.href = isSim
        ? 'https://smallcomputercentral.com/small-computer-workshop/'
        : (is126
          ? 'https://smallcomputercentral.com/rcbus/sc100-series/sc126-z180-motherboard-rc2014/'
          : 'https://smallcomputercentral.com/sc131-z180-pocket-computer/');
    }
    if (fwOpt) {
      fwOpt.textContent = is126
        ? 'RomWBW v3.6.0 (SCZ180_sc126_std)'
        : 'RomWBW v3.6.0 (SCZ180_sc131_std)';
    }
    if (btnReset) {
      btnReset.textContent = isSim ? 'Reset (Z80)' : (is126 ? 'Reset (SW2)' : 'Reset (SW1)');
    }
    if (btnLedDemo) {
      btnLedDemo.textContent = is126 ? '8-LED Bar Demo' : 'LED1 Blink Demo';
    }

    if (fwGroup) {
      fwGroup.style.display = isSim ? 'none' : 'flex';
    }

    // Toggle hardware sidebar components strictly reflecting the selected machine
    document.getElementById('hw-sim-io')?.classList.toggle('hidden', !isSim);
    document.getElementById('hw-card-sim-arch')?.classList.toggle('hidden', !isSim);
    document.getElementById('hw-front-sc131')?.classList.toggle('hidden', is126 || isSim);
    document.getElementById('hw-front-sc126')?.classList.toggle('hidden', !is126);
    document.getElementById('hw-card-sd')?.classList.toggle('hidden', isSim);
    document.getElementById('hw-card-pcb')?.classList.toggle('hidden', isSim);
    document.getElementById('pcb-grid-sc131')?.classList.toggle('hidden', is126 || isSim);
    document.getElementById('pcb-grid-sc126')?.classList.toggle('hidden', !is126);

    // Hide sidebar OS/ROM quick launch when on Simulated Z80
    document.getElementById('sidebar-quicklaunch-section')?.classList.toggle('hidden', isSim);

    // Dynamic PCB and hardware titles reflecting machine
    const pcbCardTitle = document.getElementById('pcb-card-title');
    const pcbSilkLeft = document.getElementById('pcb-silk-left');
    const pcbSilkRight = document.getElementById('pcb-silk-right');
    const sdPortTitle = document.getElementById('sd-port-title');
    if (pcbCardTitle) {
      pcbCardTitle.textContent = is126 ? 'SC126 v1.1 Motherboard PCB' : 'SC131 v1.0 Motherboard PCB';
    }
    if (pcbSilkLeft) {
      pcbSilkLeft.textContent = is126 ? 'SC126 v1.1 • S. C. Cousins' : 'SC131 v1.0 • S. C. Cousins';
    }
    if (pcbSilkRight) {
      pcbSilkRight.textContent = is126 ? '160 × 100 mm RC2014' : '101.6 × 66.1 mm';
    }
    if (sdPortTitle) {
      sdPortTitle.textContent = is126 ? 'P1 • SPI MicroSDHC Slot (Port 0x0C / RCBus)' : 'P1 • SPI MicroSDHC Slot (Port 0x0C / CSIO)';
    }

    // Update Topbar Breadcrumb Machine Part
    const crumbMachine = document.getElementById('crumb-machine-name');
    if (crumbMachine) {
      crumbMachine.textContent = isSim ? 'Simulated Z80' : (is126 ? 'SC126 RCBus' : 'SC131 Pocket');
    }

    // Update Menu Bar Machine Checkmarks
    const chk131 = document.getElementById('menu-chk-sc131');
    const chk126 = document.getElementById('menu-chk-sc126');
    const chkSim = document.getElementById('menu-chk-sim');
    if (chk131) chk131.textContent = (!is126 && !isSim) ? '● ' : '○ ';
    if (chk126) chk126.textContent = is126 ? '● ' : '○ ';
    if (chkSim) chkSim.textContent = isSim ? '● ' : '○ ';

    const sbMachine = document.getElementById('sb-machine');
    if (sbMachine) {
      sbMachine.textContent = isSim ? '⎇ Simulated Z80 (4 MHz)' : (is126 ? '⎇ SC126 (Z8S180)' : '⎇ SC131 (Z8S180)');
    }

    this.updateLedsUI(this.board.getLeds());
    this.updatePrinterUI();
    this.updateSimScreenUI();
  }

  initExamplesUI() {
    const sel = document.getElementById('example-select');
    const treeSim = document.getElementById('scw-examples-sim');
    const treeScm = document.getElementById('scw-examples-scm');

    if (sel) sel.innerHTML = '';
    if (treeSim) treeSim.innerHTML = '';
    if (treeScm) treeScm.innerHTML = '';

    SCW_EXAMPLES.forEach((ex) => {
      if (sel) {
        const opt = document.createElement('option');
        opt.value = ex.id;
        opt.textContent = `${ex.name} — ${ex.title.split('—')[0].trim()}`;
        sel.appendChild(opt);
      }

      const item = document.createElement('div');
      item.className = `tree-file-item ${ex.id === this.currentExampleId ? 'active' : ''}`;
      item.setAttribute('data-example-id', ex.id);
      item.innerHTML = `<span>&#128196;</span> <span>${ex.name}</span> <span class="tree-file-badge">${ex.machine}</span>`;
      item.title = `${ex.title}\n${ex.description}`;
      item.addEventListener('click', () => this.loadExampleById(ex.id));

      if (ex.machine === 'sim_z80') {
        treeSim?.appendChild(item);
      } else {
        treeScm?.appendChild(item);
      }
    });

    sel?.addEventListener('change', (e) => this.loadExampleById(e.target.value));
  }

  loadExampleById(id) {
    const ex = SCW_EXAMPLES.find((e) => e.id === id);
    if (!ex) return;
    this.currentExampleId = ex.id;
    this.currentAsmFileName = ex.name;

    const textarea = document.getElementById('asm-editor-textarea');
    if (textarea) {
      textarea.value = ex.source;
      this.syncEditorGutter();
    }

    const nameTab = document.getElementById('tab-editor-filename');
    if (nameTab) nameTab.textContent = ex.name;

    const crumbFile = document.getElementById('crumb-file-name');
    if (crumbFile) crumbFile.textContent = ex.name;

    const sel = document.getElementById('example-select');
    if (sel && sel.value !== id) sel.value = id;

    document.querySelectorAll('.tree-file-item').forEach((item) => {
      item.classList.toggle('active', item.getAttribute('data-example-id') === id);
    });

    const targetBadge = document.getElementById('editor-target-badge');
    if (targetBadge) {
      targetBadge.textContent = `#TARGET ${ex.machine === 'sim_z80' ? 'Simulated_Z80' : ex.machine.toUpperCase()}`;
    }

    // Auto-switch machine if example is specifically designed for a different target
    if (ex.machine === 'sim_z80' && this.machineType !== 'sim_z80') {
      this.switchMachine('sim_z80', false);
    } else if (ex.machine === 'sc126' && this.machineType === 'sim_z80') {
      this.switchMachine('sc126', false);
    } else if (ex.machine === 'sc131' && this.machineType === 'sim_z80') {
      this.switchMachine('sc131', false);
    }

    this.assembleCurrentSource({ silent: true });
  }

  syncEditorGutter() {
    const textarea = document.getElementById('asm-editor-textarea');
    const gutter = document.getElementById('asm-line-gutter');
    if (!textarea || !gutter) return;

    const lines = textarea.value.split('\n').length;
    const nums = [];
    for (let i = 1; i <= lines; i++) nums.push(i);
    gutter.textContent = nums.join('\n');
    gutter.scrollTop = textarea.scrollTop;
  }

  assembleCurrentSource({ silent = false } = {}) {
    const textarea = document.getElementById('asm-editor-textarea');
    const source = textarea ? textarea.value : '';
    const res = assemble(source);
    this.currentAsmResult = res;

    // Update Assembler & Symbols Sidebar
    const statBadge = document.getElementById('asm-stat-badge');
    const statTarget = document.getElementById('asm-stat-target');
    const statOrigin = document.getElementById('asm-stat-origin');
    const statSize = document.getElementById('asm-stat-size');
    const sbAsm = document.getElementById('sb-asm');

    if (statBadge) {
      statBadge.textContent = res.ok ? 'Build OK' : `${res.errors.length} Error(s)`;
      statBadge.className = res.ok ? 'text-ok' : 'text-err';
    }
    if (statTarget) statTarget.textContent = res.target;
    if (statOrigin) statOrigin.textContent = `$${hex4(res.origin)}`;
    if (statSize) statSize.textContent = `${res.byteCount} bytes`;
    if (sbAsm) sbAsm.textContent = res.ok ? `Assembler: OK ($${hex4(res.origin)}, ${res.byteCount}B)` : `Assembler: ${res.errors.length} Error(s)`;

    // Update Symbol Table list in sidebar
    const symListEl = document.getElementById('sidebar-symbols-list');
    if (symListEl) {
      symListEl.innerHTML = res.symbols.map((s) => `
        <div class="symbol-row-item" data-addr="${s.value}">
          <span>${s.name}</span>
          <span class="sym-val">$${hex4(s.value)}</span>
        </div>
      `).join('');

      symListEl.querySelectorAll('.symbol-row-item').forEach((item) => {
        item.addEventListener('click', () => {
          const addr = parseInt(item.getAttribute('data-addr'), 10);
          this.disasmBaseAddr = addr;
          this.updateDisasmUI();
          this.switchBottomTab('disasm');
        });
      });
    }

    // Update Listing.txt view
    this.updateListingUI(res);

    // Update IntelHex & Memory Dump view
    const hexPre = document.getElementById('intelhex-output');
    if (hexPre) hexPre.textContent = res.intelHex;
    const memPre = document.getElementById('memtxt-output');
    if (memPre) memPre.textContent = `${res.memoryText}\n\n${res.symbolsText}`;

    // Update Problems / Assembler Output view
    const probEl = document.getElementById('problems-view');
    const probCount = document.getElementById('problems-count');
    if (probCount) probCount.textContent = res.errors.length;
    if (probEl) {
      if (res.ok) {
        probEl.innerHTML = `<div class="problem-item ok">✔ Assembly successful: ${res.byteCount} bytes assembled at $${hex4(res.origin)} (Target: ${res.target}, Proc: ${res.processor}).</div>`;
      } else {
        probEl.innerHTML = res.errors.map((e) => `
          <div class="problem-item err">
            <span>✖ Line ${e.line}: ${e.message}</span>
            <code style="opacity:0.8;">${e.source || ''}</code>
          </div>
        `).join('');
      }
    }

    const statusMsg = document.getElementById('editor-status-msg');
    if (statusMsg) {
      statusMsg.textContent = res.ok
        ? `Built ${res.byteCount} bytes at $${hex4(res.origin)} (${res.target})`
        : `Build failed: ${res.errors[0]?.message || 'Errors'}`;
    }

    if (!silent && !res.ok) {
      this.switchBottomTab('problems');
    }

    return res;
  }

  updateListingUI(res = this.currentAsmResult) {
    const listEl = document.getElementById('listing-view');
    if (!listEl || !res) return;

    const curPc = this.board.cpu.pc;
    const lines = res.listingText.split('\n');
    listEl.innerHTML = lines.map((l) => {
      const m = /^([0-9A-Fa-f]{4}):/.exec(l);
      const rowAddr = m ? parseInt(m[1], 16) : null;
      const isPc = rowAddr !== null && rowAddr === curPc;
      const hasBp = rowAddr !== null && this.board.breakpoints.has(rowAddr);
      return `<div class="listing-row ${isPc ? 'current-pc' : ''} ${hasBp ? 'has-bp' : ''}" data-addr="${rowAddr !== null ? rowAddr : ''}">${hasBp ? '● ' : '  '}${l}</div>`;
    }).join('');

    listEl.querySelectorAll('.listing-row[data-addr]').forEach((row) => {
      row.addEventListener('click', () => {
        const raw = row.getAttribute('data-addr');
        if (!raw) return;
        const addr = parseInt(raw, 10);
        if (Number.isNaN(addr)) return;
        if (this.board.breakpoints.has(addr)) this.board.breakpoints.delete(addr);
        else this.board.breakpoints.add(addr);
        this.updateListingUI();
        this.updateDisasmUI();
      });
    });
  }

  loadProgramIntoMemory({ setPc = false } = {}) {
    const res = this.assembleCurrentSource();
    if (!res.ok) {
      alert(`Cannot load program with assembly errors:\n${res.errors.map((e) => `Line ${e.line}: ${e.message}`).join('\n')}`);
      return false;
    }
    this.board.loadAssembledProgram(res, { setPc });
    this.updateInspectorUI(true);
    return true;
  }

  buildAndRun() {
    const ok = this.loadProgramIntoMemory({ setPc: true });
    if (!ok) return;

    this.setSimulationMode('run');
    this.updateRunPauseButton();
    this.updateStatusPill();
    this.getActiveTerminal().canvas.focus();
  }

  buildAndWalk() {
    const ok = this.loadProgramIntoMemory({ setPc: true });
    if (!ok) return;

    this.setSimulationMode('walk');
  }

  setSimulationMode(mode) {
    if (this.walkTimer) {
      clearInterval(this.walkTimer);
      this.walkTimer = null;
    }

    this.simulationMode = mode;
    this.running = mode === 'run';

    document.getElementById('btn-walk')?.classList.toggle('active', mode === 'walk');
    document.getElementById('btn-jog')?.classList.toggle('active', mode === 'jog');

    const ind = document.getElementById('walk-step-indicator');
    if (ind) {
      ind.classList.toggle('hidden', mode !== 'walk' && mode !== 'jog');
      ind.textContent = mode === 'walk' ? '🚶 WALKING (~12 ips)' : (mode === 'jog' ? '⚡ JOGGING (~600 ips)' : '');
    }

    const sbMode = document.getElementById('sb-mode');
    if (sbMode) sbMode.textContent = `Mode: ${mode.toUpperCase()}`;

    if (mode === 'walk') {
      this.walkTimer = setInterval(() => {
        this.stepSingleInstruction({ isAnimated: true });
      }, 85); // ~12 instructions per second
    }

    this.updateRunPauseButton();
    this.updateStatusPill();
    this.updateInspectorUI(true);
  }

  stepSingleInstruction({ isAnimated = false } = {}) {
    if (this.board.isHeldInReset()) return;

    const stBefore = this.board.cpu.getState();
    const inst = disassembleOne((a) => this.board.cpu.memRead(a), stBefore.pc);

    this.board.cpu.step();

    const stAfter = this.board.cpu.getState();

    // Record to simulation trace
    this.recordTraceEntry(stBefore.pc, inst, stAfter);

    // Live update source code & listing line highlight
    this.highlightActiveExecutionLine(stAfter.pc);

    this.term0.render();
    this.term1.render();
    this.updateStatusPill();
    this.updateInspectorUI(true);

    if (this.board.breakpoints.has(stAfter.pc)) {
      this.setSimulationMode('paused');
    }
  }

  recordTraceEntry(pc, inst, st) {
    this.traceStepCount++;
    const f = st.af & 0xFF;
    const flagStr = [
      (f & 0x80) ? 'S' : '.',
      (f & 0x40) ? 'Z' : '.',
      (f & 0x20) ? '5' : '.',
      (f & 0x10) ? 'H' : '.',
      (f & 0x08) ? '3' : '.',
      (f & 0x04) ? 'P' : '.',
      (f & 0x02) ? 'N' : '.',
      (f & 0x01) ? 'C' : '.',
    ].join('');

    const entry = {
      step: this.traceStepCount,
      pc,
      bytes: inst.bytes.map(hex2).join(' '),
      mnemonic: inst.mnemonic,
      af: hex4(st.af),
      bc: hex4(st.bc),
      de: hex4(st.de),
      hl: hex4(st.hl),
      sp: hex4(st.sp),
      flags: flagStr,
    };

    this.traceBuffer.push(entry);
    if (this.traceBuffer.length > 200) this.traceBuffer.shift();

    const countEl = document.getElementById('trace-count');
    if (countEl) countEl.textContent = this.traceBuffer.length;

    const view = document.getElementById('trace-view');
    if (view && (this.activeBottomTab === 'trace' || this.activeBottomTab === 'all')) {
      const row = document.createElement('div');
      row.className = 'trace-row';
      row.innerHTML = `
        <span>#${entry.step}</span>
        <span>$${hex4(entry.pc)}</span>
        <span>${entry.bytes}</span>
        <span>${entry.mnemonic}</span>
        <span>${entry.af}</span>
        <span>${entry.bc}</span>
        <span>${entry.de}</span>
        <span>${entry.hl}</span>
        <span>${entry.sp}</span>
        <span>${entry.flags}</span>
      `;
      view.appendChild(row);
      if (view.childNodes.length > 200) view.removeChild(view.firstChild);
      view.scrollTop = view.scrollHeight;
    }
  }

  highlightActiveExecutionLine(pc) {
    const banner = document.getElementById('asm-active-line-banner');
    const lineNumEl = document.getElementById('asm-exec-line-num');
    const pcEl = document.getElementById('asm-exec-pc');
    const codeEl = document.getElementById('asm-exec-line-code');

    const res = this.currentAsmResult;
    const lineNum = res?.addrToLine?.get(pc);

    if (banner && lineNum) {
      banner.classList.remove('hidden');
      if (lineNumEl) lineNumEl.textContent = lineNum;
      if (pcEl) pcEl.textContent = `$${hex4(pc)}`;
      const textarea = document.getElementById('asm-editor-textarea');
      if (textarea && codeEl) {
        const textLines = textarea.value.split('\n');
        codeEl.textContent = (textLines[lineNum - 1] || '').trim();
      }
    }

    this.updateListingUI();
  }

  sendHexToSerial() {
    const res = this.assembleCurrentSource();
    if (!res.ok) {
      alert('Cannot send Intel HEX with errors');
      return;
    }
    const lines = res.intelHex.split('\n');
    let idx = 0;
    const sendNext = () => {
      if (idx >= lines.length) return;
      const line = lines[idx++].trim();
      if (line) {
        this.board.sendSerial(this.activeSerialTab, line + '\r');
      }
      setTimeout(sendNext, 45); // pacing for Small Computer Monitor hex loader
    };
    sendNext();
    this.switchCenterTab('terminal');
    this.getActiveTerminal().canvas.focus();
  }

  setupConversionsTool() {
    const hexIn = document.getElementById('conv-hex');
    const decIn = document.getElementById('conv-dec');
    const signedIn = document.getElementById('conv-signed');
    const binHiIn = document.getElementById('conv-bin-hi');
    const binLoIn = document.getElementById('conv-bin-lo');
    const asciiIn = document.getElementById('conv-ascii');

    const updateAllFromVal = (val16, source) => {
      if (this.syncingConversions) return;
      this.syncingConversions = true;
      const u16 = val16 & 0xFFFF;
      const s16 = u16 < 32768 ? u16 : u16 - 65536;
      const hi = (u16 >> 8) & 0xFF;
      const lo = u16 & 0xFF;

      if (source !== 'hex' && hexIn) hexIn.value = hex4(u16);
      if (source !== 'dec' && decIn) decIn.value = u16.toString(10);
      if (source !== 'signed' && signedIn) signedIn.value = s16.toString(10);
      if (source !== 'bin-hi' && binHiIn) binHiIn.value = bin8(hi);
      if (source !== 'bin-lo' && binLoIn) binLoIn.value = bin8(lo);
      if (source !== 'ascii' && asciiIn) {
        asciiIn.value = (lo >= 32 && lo <= 126) ? String.fromCharCode(lo) : '.';
      }
      this.syncingConversions = false;
    };

    hexIn?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value.trim(), 16);
      if (!Number.isNaN(v)) updateAllFromVal(v, 'hex');
    });

    decIn?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value.trim(), 10);
      if (!Number.isNaN(v)) updateAllFromVal(v, 'dec');
    });

    signedIn?.addEventListener('input', (e) => {
      const v = parseInt(e.target.value.trim(), 10);
      if (!Number.isNaN(v)) updateAllFromVal(v < 0 ? (65536 + v) : v, 'signed');
    });

    const handleBin = () => {
      const hi = parseInt(binHiIn?.value || '0', 2) || 0;
      const lo = parseInt(binLoIn?.value || '0', 2) || 0;
      updateAllFromVal((hi << 8) | lo, 'bin');
    };
    binHiIn?.addEventListener('input', handleBin);
    binLoIn?.addEventListener('input', handleBin);

    asciiIn?.addEventListener('input', (e) => {
      const ch = e.target.value;
      if (ch.length > 0) updateAllFromVal(ch.charCodeAt(0), 'ascii');
    });
  }

  switchCenterTab(tabKey) {
    this.activeCenterTab = tabKey;
    document.querySelectorAll('.vscode-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-center-tab') === tabKey);
    });

    if (this.splitMode) {
      // In split mode, terminal and editor are both displayed side-by-side
      document.getElementById('pane-terminal')?.classList.remove('hidden');
      document.getElementById('pane-editor')?.classList.remove('hidden');
      document.getElementById('pane-listing')?.classList.add('hidden');
      document.getElementById('pane-hexout')?.classList.add('hidden');
      document.getElementById('pane-peripherals')?.classList.add('hidden');
      return;
    }

    // Single-pane mode
    const panes = ['terminal', 'editor', 'listing', 'hexout', 'peripherals'];
    panes.forEach((p) => {
      const el = document.getElementById(`pane-${p}`);
      el?.classList.toggle('hidden', p !== tabKey);
      el?.classList.toggle('active-pane', p === tabKey);
    });

    if (tabKey === 'terminal') {
      this.getActiveTerminal().dirty = true;
      this.getActiveTerminal().render();
    } else if (tabKey === 'peripherals') {
      this.updateSimScreenUI();
      this.updatePrinterUI();
    }
  }

  toggleSplitMode() {
    this.splitMode = !this.splitMode;
    const panesContainer = document.getElementById('workbench-panes');
    panesContainer?.classList.toggle('split-mode', this.splitMode);

    const btnSplit = document.getElementById('btn-toggle-split');
    const btnSplitEditor = document.getElementById('btn-split-editor-term');
    btnSplit?.classList.toggle('active', this.splitMode);
    btnSplitEditor?.classList.toggle('active', this.splitMode);

    const sbSplit = document.getElementById('sb-split');
    if (sbSplit) sbSplit.textContent = this.splitMode ? 'View: Split Side-by-Side' : 'View: Single Pane';

    this.switchCenterTab(this.splitMode ? 'editor' : this.activeCenterTab);
  }

  switchSidebarView(viewKey) {
    this.activeSidebarView = viewKey;
    document.querySelectorAll('.activity-btn[data-sidebar-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-sidebar-view') === viewKey);
    });

    const views = ['explorer', 'assembler', 'tools'];
    views.forEach((v) => {
      document.getElementById(`sidebar-view-${v}`)?.classList.toggle('hidden', v !== viewKey);
    });

    if (!this.sidebarVisible) {
      this.setSidebarVisible(true);
    }
  }

  setSidebarVisible(visible) {
    this.sidebarVisible = visible;
    const sb = document.getElementById('left-sidebar');
    const btn = document.getElementById('btn-toggle-sidebar');
    sb?.classList.toggle('hidden', !visible);
    btn?.classList.toggle('active', visible);
  }

  setHardwareSidebarVisible(visible) {
    this.hardwareSidebarVisible = visible;
    const hw = document.getElementById('side-column');
    const btn = document.getElementById('btn-toggle-hardware');
    hw?.classList.toggle('hidden', !visible);
    btn?.classList.toggle('active', visible);
  }

  switchBottomTab(tabKey) {
    this.activeBottomTab = tabKey;
    document.querySelectorAll('.bottom-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-bottom-tab') === tabKey);
    });

    const topGrid = document.getElementById('debugger-top-grid');
    const cardCpu = document.getElementById('card-cpu');
    const cardDisasm = document.getElementById('card-disasm');
    const cardMem = document.getElementById('card-memory');
    const cardTrace = document.getElementById('card-trace');
    const cardProb = document.getElementById('card-problems');

    if (tabKey === 'all') {
      topGrid?.classList.remove('hidden');
      cardCpu?.classList.remove('hidden');
      cardDisasm?.classList.remove('hidden');
      cardMem?.classList.remove('hidden');
      cardTrace?.classList.add('hidden');
      cardProb?.classList.add('hidden');
    } else if (tabKey === 'cpu') {
      topGrid?.classList.remove('hidden');
      cardCpu?.classList.remove('hidden');
      cardDisasm?.classList.add('hidden');
      cardMem?.classList.add('hidden');
      cardTrace?.classList.add('hidden');
      cardProb?.classList.add('hidden');
    } else if (tabKey === 'disasm') {
      topGrid?.classList.remove('hidden');
      cardCpu?.classList.add('hidden');
      cardDisasm?.classList.remove('hidden');
      cardMem?.classList.add('hidden');
      cardTrace?.classList.add('hidden');
      cardProb?.classList.add('hidden');
    } else if (tabKey === 'memory') {
      topGrid?.classList.add('hidden');
      cardMem?.classList.remove('hidden');
      cardTrace?.classList.add('hidden');
      cardProb?.classList.add('hidden');
    } else if (tabKey === 'trace') {
      topGrid?.classList.add('hidden');
      cardMem?.classList.add('hidden');
      cardTrace?.classList.remove('hidden');
      cardProb?.classList.add('hidden');
    } else if (tabKey === 'problems') {
      topGrid?.classList.add('hidden');
      cardMem?.classList.add('hidden');
      cardTrace?.classList.add('hidden');
      cardProb?.classList.remove('hidden');
    }

    this.updateInspectorUI(true);
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
    if (machine === 'sim_z80') return;
    const actualFw = fwKey === 'scm_s6' ? 'scm_s6' : 'romwbw';
    const cacheKey = actualFw === 'scm_s6' ? 'scm_s6' : `romwbw_${machine}`;
    if (!this.romCache[cacheKey]) {
      this.romCache[cacheKey] = await this.fetchAssetBytes(this.getRomAssetPath(machine, actualFw));
    }
    this.boards[machine].loadRom(this.romCache[cacheKey]);
  }

  async ensureSdLoaded(kind = 'romwbw') {
    if (this.machineType === 'sim_z80') return;
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

  async switchMachine(newMachine, reboot = true) {
    if (!this.boards[newMachine]) return;
    this.clearMacroQueue();
    this.setSimulationMode('paused');
    this.machineType = newMachine;
    this.board = this.boards[this.machineType];
    this.sc131 = this.board;
    this.syncMachineChrome();

    if (this.machineType === 'sim_z80') {
      this.board.reset();
      this.updateRunPauseButton();
      this.updateInspectorUI(true);
      return;
    }

    if (reboot) {
      const fwKey = document.getElementById('firmware-select')?.value || 'romwbw';
      if (fwKey === 'fuzix') {
        await this.launchFuzix();
      } else {
        await this.ensureRomLoaded(this.machineType, fwKey);
        if (fwKey === 'romwbw') await this.ensureSdLoaded('romwbw');
        this.triggerHardwareResetPulse(180);
        this.setSimulationMode('run');
        this.updateInspectorUI(true);
        this.term0.canvas.focus();
      }
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
      this.setSimulationMode('run');
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
    this.setSimulationMode('run');
    this.macroQueue = steps;
    this.switchCenterTab('terminal');
    this.getActiveTerminal().canvas.focus();
  }

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
    // Target Machine selector
    document.getElementById('machine-select')?.addEventListener('change', (e) => {
      this.switchMachine(e.target.value);
    });

    // Activity Bar view buttons
    document.querySelectorAll('.activity-btn[data-sidebar-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const view = btn.getAttribute('data-sidebar-view');
        this.switchSidebarView(view);
      });
    });

    // Layout buttons
    document.getElementById('btn-toggle-sidebar')?.addEventListener('click', () => {
      this.setSidebarVisible(!this.sidebarVisible);
    });
    document.getElementById('btn-toggle-split')?.addEventListener('click', () => {
      this.toggleSplitMode();
    });
    document.getElementById('btn-split-editor-term')?.addEventListener('click', () => {
      this.toggleSplitMode();
    });
    document.getElementById('activity-split-btn')?.addEventListener('click', () => {
      this.toggleSplitMode();
    });
    document.getElementById('btn-toggle-debugger')?.addEventListener('click', () => {
      this.setDebuggerVisible(!this.debuggerVisible);
    });
    document.getElementById('btn-hide-debugger')?.addEventListener('click', () => {
      this.setDebuggerVisible(false);
    });
    document.getElementById('btn-toggle-hardware')?.addEventListener('click', () => {
      this.setHardwareSidebarVisible(!this.hardwareSidebarVisible);
    });

    // Center tab switching
    document.querySelectorAll('.vscode-tab[data-center-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-center-tab');
        this.switchCenterTab(key);
      });
    });

    // Bottom panel tab switching
    document.querySelectorAll('.bottom-tab[data-bottom-tab]').forEach((tab) => {
      tab.addEventListener('click', () => {
        const key = tab.getAttribute('data-bottom-tab');
        this.switchBottomTab(key);
      });
    });

    // Code Editor Textarea events (Tab key indentation, cursor tracking, scroll sync)
    const textarea = document.getElementById('asm-editor-textarea');
    textarea?.addEventListener('input', () => {
      this.syncEditorGutter();
    });
    textarea?.addEventListener('scroll', () => {
      this.syncEditorGutter();
    });
    textarea?.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '    ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 4;
        this.syncEditorGutter();
      } else if (e.key === 'F7') {
        e.preventDefault();
        this.assembleCurrentSource();
      } else if (e.key === 'F5') {
        e.preventDefault();
        this.buildAndRun();
      } else if (e.key === 'F10') {
        e.preventDefault();
        this.stepSingleInstruction();
      }
    });

    const updateCursorPos = () => {
      if (!textarea) return;
      const pos = textarea.selectionStart;
      const text = textarea.value.substring(0, pos);
      const lines = text.split('\n');
      const curRow = lines.length;
      const curCol = lines[lines.length - 1].length + 1;
      const cursorEl = document.getElementById('editor-cursor-pos');
      if (cursorEl) cursorEl.textContent = `Ln ${curRow}, Col ${curCol}`;
    };
    textarea?.addEventListener('keyup', updateCursorPos);
    textarea?.addEventListener('click', updateCursorPos);

    // Build & Execution Toolbar actions
    const doAssemble = () => {
      this.assembleCurrentSource();
      this.switchCenterTab('editor');
    };
    document.getElementById('btn-assemble')?.addEventListener('click', doAssemble);
    document.getElementById('btn-editor-assemble')?.addEventListener('click', doAssemble);
    document.getElementById('btn-side-assemble')?.addEventListener('click', doAssemble);

    const doBuildRun = () => this.buildAndRun();
    document.getElementById('btn-assemble-run')?.addEventListener('click', doBuildRun);
    document.getElementById('btn-editor-run')?.addEventListener('click', doBuildRun);
    document.getElementById('btn-side-build-run')?.addEventListener('click', doBuildRun);

    document.getElementById('btn-editor-load')?.addEventListener('click', () => {
      this.loadProgramIntoMemory({ setPc: false });
    });
    document.getElementById('btn-side-load-mem')?.addEventListener('click', () => {
      this.loadProgramIntoMemory({ setPc: false });
    });

    document.getElementById('btn-editor-walk')?.addEventListener('click', () => {
      this.buildAndWalk();
    });

    document.getElementById('btn-jog')?.addEventListener('click', () => {
      if (this.simulationMode === 'jog') {
        this.setSimulationMode('paused');
      } else {
        this.setSimulationMode('jog');
      }
    });

    document.getElementById('btn-walk')?.addEventListener('click', () => {
      if (this.simulationMode === 'walk') {
        this.setSimulationMode('paused');
      } else {
        this.setSimulationMode('walk');
      }
    });

    document.getElementById('btn-step')?.addEventListener('click', () => {
      this.setSimulationMode('paused');
      this.stepSingleInstruction();
    });

    document.getElementById('btn-interrupt')?.addEventListener('click', () => {
      this.board.cpu.triggerInt0();
      this.updateStatusPill();
    });

    document.getElementById('btn-run-pause')?.addEventListener('click', () => {
      if (this.simulationMode === 'run') {
        this.setSimulationMode('paused');
      } else {
        this.setSimulationMode('run');
      }
    });

    // Reset buttons
    const doReset = () => {
      this.setSimulationMode('paused');
      this.triggerHardwareResetPulse(250);
      this.getActiveTerminal().canvas.focus();
    };
    document.getElementById('btn-reset')?.addEventListener('click', doReset);
    document.getElementById('hw-reset-btn')?.addEventListener('click', doReset);
    document.getElementById('sc126-reset-btn')?.addEventListener('click', doReset);

    // Send HEX to SCM / Serial
    const doSendHex = () => this.sendHexToSerial();
    document.getElementById('btn-editor-scm-hex')?.addEventListener('click', doSendHex);
    document.getElementById('btn-side-send-scm')?.addEventListener('click', doSendHex);
    document.getElementById('btn-send-intelhex-term')?.addEventListener('click', doSendHex);

    // New .asm template
    document.getElementById('btn-new-asm')?.addEventListener('click', () => {
      if (textarea) {
        textarea.value = `; **********************************************************************\n; **  Custom Z80 / Z180 Assembly Program                              **\n; **********************************************************************\n\n            #TARGET     ${this.machineType === 'sim_z80' ? 'Simulated_Z80' : (this.machineType === 'sc126' ? 'SC126' : 'SC131')}\n            .ORG        ${this.machineType === 'sim_z80' ? '0000h' : '8000h'}\n\nStart:      LD   A, 0\nLoop:       OUT  (00h), A\n            INC  A\n            JP   Loop\n\n            .END\n`;
        this.syncEditorGutter();
        this.currentAsmFileName = 'Untitled.asm';
        const nameTab = document.getElementById('tab-editor-filename');
        if (nameTab) nameTab.textContent = 'Untitled.asm';
        this.switchCenterTab('editor');
      }
    });

    // Upload & Download .asm / .hex / .lst
    document.getElementById('asm-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      if (textarea) {
        textarea.value = text;
        this.syncEditorGutter();
        this.currentAsmFileName = file.name;
        const nameTab = document.getElementById('tab-editor-filename');
        if (nameTab) nameTab.textContent = file.name;
        this.switchCenterTab('editor');
        this.assembleCurrentSource();
      }
    });

    const downloadBlob = (filename, content, type = 'text/plain') => {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    };

    document.getElementById('btn-download-asm')?.addEventListener('click', () => {
      downloadBlob(this.currentAsmFileName || 'Program.asm', textarea?.value || '');
    });
    document.getElementById('btn-download-hex')?.addEventListener('click', () => {
      const res = this.currentAsmResult || this.assembleCurrentSource();
      downloadBlob((this.currentAsmFileName || 'Program').replace(/\.[^/.]+$/, '') + '.hex', res.intelHex || '');
    });
    document.getElementById('btn-download-lst')?.addEventListener('click', () => {
      const res = this.currentAsmResult || this.assembleCurrentSource();
      downloadBlob((this.currentAsmFileName || 'Program').replace(/\.[^/.]+$/, '') + '.lst', res.listingText || '');
    });

    document.getElementById('btn-copy-listing')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.currentAsmResult?.listingText || '');
    });
    document.getElementById('btn-copy-intelhex')?.addEventListener('click', () => {
      navigator.clipboard?.writeText(this.currentAsmResult?.intelHex || '');
    });

    // Clear Simulation Trace
    document.getElementById('btn-clear-trace')?.addEventListener('click', () => {
      this.traceBuffer.length = 0;
      this.traceStepCount = 0;
      const view = document.getElementById('trace-view');
      if (view) view.innerHTML = '';
      const countEl = document.getElementById('trace-count');
      if (countEl) countEl.textContent = '0';
    });

    // Clear Simulated Screen & Printer
    document.getElementById('btn-clear-sim-screen')?.addEventListener('click', () => {
      this.board.clearScreen?.();
      this.updateSimScreenUI();
    });
    document.getElementById('btn-clear-sim-printer')?.addEventListener('click', () => {
      this.board.clearPrinter?.();
      this.updatePrinterUI('');
    });

    // Interactive SCWorkshop Port $00 Input Switches (click toggles bit in PortIn)
    document.querySelectorAll('#sim-switch-bar .sim-sw-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const bit = parseInt(btn.getAttribute('data-sw-bit') || '0', 10);
        this.board.simSwitches = (this.board.simSwitches ^ (1 << bit)) & 0xFF;
        this.updateLedsUI(this.board.getLeds());
      });
    });

    // Interactive SC126 8-LED bar click to toggle bit in Port 0x0D
    document.querySelectorAll('#sc126-led-bar .diag-led-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const bit = parseInt(cell.getAttribute('data-bit') || '0', 10);
        this.boards.sc126.writeExtIO(0x0D, this.boards.sc126.diagLeds ^ (1 << bit));
      });
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

    // Hardware Jumpers
    const btnJp1 = document.getElementById('btn-jp1');
    btnJp1?.addEventListener('click', () => {
      this.board.jp1WriteEnable = !this.board.jp1WriteEnable;
      btnJp1.classList.toggle('rd', !this.board.jp1WriteEnable);
      btnJp1.classList.toggle('wr', this.board.jp1WriteEnable);
      btnJp1.textContent = this.board.jp1WriteEnable
        ? 'JP1: Wr (Flash Write Enabled)'
        : 'JP1: Rd (Write Protected)';
    });

    const btnJp2 = document.getElementById('btn-jp2');
    btnJp2?.addEventListener('click', () => {
      this.board.jp2PowerPortB = !this.board.jp2PowerPortB;
      btnJp2.classList.toggle('rd', this.board.jp2PowerPortB);
      btnJp2.textContent = this.board.jp2PowerPortB
        ? 'JP2: Fitted (Port B 5V Connected)'
        : 'JP2: Open (Via Port A)';
    });

    // Vcc Voltage Supervisor Slider
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

    // Custom ROM file upload
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
      downloadBlob(`${this.machineType}_sdcard_export.img`, data, 'application/octet-stream');
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

    // Quick-launch macros
    document.querySelectorAll('[data-macro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const rawMacro = btn.getAttribute('data-macro');
        if (!rawMacro) return;

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
        this.updateListingUI();
      }
    });

    document.getElementById('btn-clear-bp')?.addEventListener('click', () => {
      this.board.breakpoints.clear();
      this.updateDisasmUI();
      this.updateListingUI();
    });
  }

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

    // =========================================================================
    // Native IDE Menu Bar & Quick Boot Dropdown Navigation
    // =========================================================================
    const menuItems = document.querySelectorAll('.menubar-item');
    let activeMenu = null;

    const closeAllMenus = () => {
      menuItems.forEach((m) => m.classList.remove('open'));
      document.getElementById('term-quickboot-menu')?.classList.add('hidden');
      activeMenu = null;
    };

    menuItems.forEach((item) => {
      const btn = item.querySelector('.menubar-btn');
      btn?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.classList.contains('open')) {
          closeAllMenus();
        } else {
          closeAllMenus();
          item.classList.add('open');
          activeMenu = item;
        }
      });

      item.addEventListener('mouseenter', () => {
        if (activeMenu && activeMenu !== item) {
          closeAllMenus();
          item.classList.add('open');
          activeMenu = item;
        }
      });
    });

    // Terminal Quick Boot Dropdown
    const termQuickBtn = document.getElementById('btn-quick-boot-term');
    const termQuickMenu = document.getElementById('term-quickboot-menu');
    termQuickBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeAllMenus();
      termQuickMenu?.classList.toggle('hidden');
    });

    // Close open menus when clicking outside
    window.addEventListener('click', (e) => {
      if (!e.target.closest('.menubar-item') && !e.target.closest('.terminal-quickboot-wrap')) {
        closeAllMenus();
      }
    });

    // Close open menus on Escape key
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllMenus();
    });

    // Wire Menu File Actions
    document.getElementById('menu-file-new')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-new-asm')?.click();
    });

    document.getElementById('asm-file-input-menu')?.addEventListener('change', (e) => {
      closeAllMenus();
      const file = e.target.files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          const content = evt.target?.result;
          if (typeof content === 'string') {
            this.currentAsmFileName = file.name;
            const textarea = document.getElementById('asm-editor-textarea');
            if (textarea) textarea.value = content;
            const nameTab = document.getElementById('tab-editor-filename');
            if (nameTab) nameTab.textContent = file.name;
            const crumbFile = document.getElementById('crumb-file-name');
            if (crumbFile) crumbFile.textContent = file.name;
            this.syncEditorGutter();
            this.assembleCurrentSource({ silent: true });
            this.switchCenterTab('editor');
          }
        };
        reader.readAsText(file);
      }
    });

    document.getElementById('menu-file-save-asm')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-download-asm')?.click();
    });
    document.getElementById('menu-file-save-hex')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-download-hex')?.click();
    });
    document.getElementById('menu-file-save-lst')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-download-lst')?.click();
    });

    // Wire Menu Edit Actions
    document.getElementById('menu-edit-conv')?.addEventListener('click', () => {
      closeAllMenus();
      this.switchSidebarView('tools');
    });
    document.getElementById('menu-edit-clear-term')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-clear-term')?.click();
    });
    document.getElementById('menu-edit-copy-term')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-copy-screen')?.click();
    });
    document.getElementById('menu-edit-paste-term')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-paste')?.click();
    });

    // Wire Menu View Actions
    document.getElementById('menu-view-sidebar')?.addEventListener('click', () => {
      closeAllMenus();
      this.setSidebarVisible(!this.sidebarVisible);
    });
    document.getElementById('menu-view-split')?.addEventListener('click', () => {
      closeAllMenus();
      this.toggleSplitMode();
    });
    document.getElementById('menu-view-panel')?.addEventListener('click', () => {
      closeAllMenus();
      this.setDebuggerVisible(!this.debuggerVisible);
    });
    document.getElementById('menu-view-hardware')?.addEventListener('click', () => {
      closeAllMenus();
      this.setHardwareSidebarVisible(!this.hardwareSidebarVisible);
    });
    document.getElementById('menu-view-term-tab')?.addEventListener('click', () => {
      closeAllMenus();
      this.switchCenterTab('terminal');
    });
    document.getElementById('menu-view-editor-tab')?.addEventListener('click', () => {
      closeAllMenus();
      this.switchCenterTab('editor');
    });
    document.getElementById('menu-view-sim-periph')?.addEventListener('click', () => {
      closeAllMenus();
      this.switchCenterTab('peripherals');
    });

    // Wire Menu Machine & Firmware & Speed Picks
    document.querySelectorAll('[data-machine-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeAllMenus();
        const m = btn.getAttribute('data-machine-pick');
        if (m) this.switchMachine(m);
      });
    });

    document.querySelectorAll('[data-fw-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeAllMenus();
        const fw = btn.getAttribute('data-fw-pick');
        if (fw) {
          const fwSel = document.getElementById('firmware-select');
          if (fwSel) fwSel.value = fw;
          this.switchFirmware(fw);
        }
      });
    });

    document.querySelectorAll('[data-speed-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        closeAllMenus();
        const sp = btn.getAttribute('data-speed-pick');
        if (sp) {
          this.speedMultiplier = parseFloat(sp) || 1.0;
          this.clockMultiplier = this.speedMultiplier;
          const spSel = document.getElementById('speed-select');
          if (spSel) spSel.value = sp;
          this.updateInspectorUI(true);
        }
      });
    });

    // Wire Menu Quick Boot special actions
    document.getElementById('menu-launch-fuzix')?.addEventListener('click', () => {
      closeAllMenus();
      this.launchFuzix();
    });
    document.getElementById('menu-launch-led-demo')?.addEventListener('click', () => {
      closeAllMenus();
      this.runLedBlinkDemo();
    });

    // Wire Menu Run Actions
    document.getElementById('menu-run-assemble-run')?.addEventListener('click', () => {
      closeAllMenus();
      this.buildAndRun();
    });
    document.getElementById('menu-run-assemble')?.addEventListener('click', () => {
      closeAllMenus();
      this.assembleCurrentSource();
    });
    document.getElementById('menu-run-pause')?.addEventListener('click', () => {
      closeAllMenus();
      document.getElementById('btn-run-pause')?.click();
    });
    document.getElementById('menu-run-step')?.addEventListener('click', () => {
      closeAllMenus();
      this.stepSingleInstruction();
    });
    document.getElementById('menu-run-walk')?.addEventListener('click', () => {
      closeAllMenus();
      this.setSimulationMode(this.simulationMode === 'walk' ? 'paused' : 'walk');
    });
    document.getElementById('menu-run-jog')?.addEventListener('click', () => {
      closeAllMenus();
      this.setSimulationMode(this.simulationMode === 'jog' ? 'paused' : 'jog');
    });
    document.getElementById('menu-run-interrupt')?.addEventListener('click', () => {
      closeAllMenus();
      if (this.board?.triggerInt0) {
        this.board.triggerInt0();
        this.updateInspectorUI(true);
      }
    });
    document.getElementById('menu-run-reset')?.addEventListener('click', () => {
      closeAllMenus();
      this.triggerHardwareResetPulse(220);
    });

    // Simulated Z80 Hardware Interrupt Push Button
    document.getElementById('hw-sim-int-btn')?.addEventListener('click', () => {
      if (this.board?.triggerInt0) {
        this.board.triggerInt0();
        const btn = document.getElementById('hw-sim-int-btn');
        btn?.classList.add('active');
        setTimeout(() => btn?.classList.remove('active'), 180);
        this.updateInspectorUI(true);
      }
    });

    // Clickable Status Bar items
    document.getElementById('sb-machine')?.addEventListener('click', () => {
      // Cycle through machines
      const next = this.machineType === 'sc131' ? 'sc126' : (this.machineType === 'sc126' ? 'sim_z80' : 'sc131');
      this.switchMachine(next);
    });

    document.getElementById('sb-pc')?.addEventListener('click', () => {
      this.setDebuggerVisible(true);
      this.switchBottomTab('disasm');
      document.getElementById('btn-disasm-pc')?.click();
    });

    document.getElementById('sb-asm')?.addEventListener('click', () => {
      this.setDebuggerVisible(true);
      this.switchBottomTab('problems');
    });

    // Global IDE Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;

      if (e.key === 'F5') {
        e.preventDefault();
        this.buildAndRun();
      } else if (e.key === 'F7') {
        e.preventDefault();
        this.assembleCurrentSource();
      } else if (e.key === 'F8') {
        e.preventDefault();
        document.getElementById('btn-run-pause')?.click();
      } else if (e.key === 'F10') {
        e.preventDefault();
        this.stepSingleInstruction();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        this.setSidebarVisible(!this.sidebarVisible);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'j' || e.key === 'J')) {
        e.preventDefault();
        this.setDebuggerVisible(!this.debuggerVisible);
      }
    });
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
    if (btn) btn.textContent = this.running ? 'Pause' : 'Run';
    const menuRunPause = document.getElementById('menu-run-pause');
    if (menuRunPause) {
      const label = menuRunPause.querySelector('span:first-child');
      if (label) label.textContent = this.running ? 'Pause CPU' : 'Resume CPU';
    }
  }

  updateStatusPill() {
    const pill = document.getElementById('status-pill');
    if (!pill) return;
    pill.classList.remove('pill-running', 'pill-paused', 'pill-reset');
    if (this.board.isHeldInReset()) {
      pill.classList.add('pill-reset');
      pill.textContent = this.board.supplyVoltage < 4.7
        ? `DS1233 BROWNOUT RESET (${this.board.supplyVoltage.toFixed(2)}V < 4.7V)`
        : `HARDWARE RESET`;
    } else if (this.simulationMode === 'walk') {
      pill.classList.add('pill-paused');
      pill.textContent = `WALKING @ PC=$${hex4(this.board.cpu.pc)}`;
    } else if (this.simulationMode === 'jog') {
      pill.classList.add('pill-running');
      pill.textContent = `JOGGING @ PC=$${hex4(this.board.cpu.pc)}`;
    } else if (this.running) {
      pill.classList.add('pill-running');
      const mhz = ((this.board.cpu.getPhiHz() * this.speedMultiplier) / 1e6).toFixed(3);
      pill.textContent = `RUNNING @ ${mhz} MHz`;
    } else {
      pill.classList.add('pill-paused');
      pill.textContent = `PAUSED @ PC=$${hex4(this.board.cpu.pc)}`;
    }

    const sbPc = document.getElementById('sb-pc');
    if (sbPc) sbPc.textContent = `PC: $${hex4(this.board.cpu.pc)}`;

    const sbCpuState = document.getElementById('sb-cpu-state');
    if (sbCpuState) {
      if (this.board.isHeldInReset()) {
        sbCpuState.textContent = '↺ In Reset';
      } else if (this.simulationMode === 'walk') {
        sbCpuState.textContent = '🚶 Walk (~12 ips)';
      } else if (this.simulationMode === 'jog') {
        sbCpuState.textContent = '⚡ Jog (~600 ips)';
      } else if (this.running) {
        const mhz = ((this.board.cpu.getPhiHz() * this.speedMultiplier) / 1e6).toFixed(2);
        sbCpuState.textContent = `● ${mhz} MHz`;
      } else {
        sbCpuState.textContent = '⏸ Paused';
      }
    }

    const sbCycles = document.getElementById('sb-cycles');
    if (sbCycles) {
      const cyc = this.board.cpu.cycles;
      sbCycles.textContent = cyc >= 1_000_000 ? `${(cyc / 1_000_000).toFixed(2)}M cycles` : `${cyc.toLocaleString()} cycles`;
    }
  }

  startLoop() {
    let lastTime = performance.now();
    let uiTick = 0;

    const frame = (now) => {
      const dtMs = Math.min(50, Math.max(1, now - lastTime));
      lastTime = now;

      if (!this.board.isHeldInReset()) {
        if (this.simulationMode === 'run' && this.running) {
          const phiHz = this.board.cpu.getPhiHz();
          const effectiveMult = this.macroQueue.length > 0 ? Math.max(this.speedMultiplier, 4.0) : this.speedMultiplier;
          const targetCycles = Math.round((phiHz * effectiveMult * dtMs) / 1000);
          const { breakpointHit } = this.board.runCycles(targetCycles);
          this.checkMacroWatchBuffer();
          if (breakpointHit) {
            this.setSimulationMode('paused');
            this.disasmBaseAddr = null;
            if (!this.debuggerVisible) this.setDebuggerVisible(true);
            this.updateInspectorUI(true);
          }
        } else if (this.simulationMode === 'jog') {
          // Jog mode: animated ~600 instructions per second
          this.jogAccumulator += dtMs;
          const targetSteps = Math.min(25, Math.floor((this.jogAccumulator / 1000) * 600));
          if (targetSteps > 0) {
            this.jogAccumulator = 0;
            for (let i = 0; i < targetSteps; i++) {
              this.stepSingleInstruction({ isAnimated: true });
              if (this.simulationMode !== 'jog') break;
            }
          }
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

    const sbSerial = document.getElementById('sb-serial');
    if (sbSerial) sbSerial.textContent = `ASCI0: ${s0.baud} ${s0.framing}`;

    if (this.machineType === 'sc126' && this.board.rtc) {
      const rtcTimeEl = document.getElementById('sc126-rtc-time');
      if (rtcTimeEl) {
        rtcTimeEl.textContent = this.board.rtc.getFormattedTime();
      }
    }

    if (!this.debuggerVisible) return;

    if (force || !this.running || this.debuggerLive || this.simulationMode === 'walk' || this.simulationMode === 'jog') {
      this.updateCpuMmuUI(st);
      this.updateDisasmUI(st);
      this.renderVisibleMemoryHex();
      if (this.board.screenDirty) {
        this.updateSimScreenUI();
        this.board.screenDirty = false;
      }
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
        const isRam = info.region.includes('RAM');
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
        this.updateListingUI();
      });
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.scwApp = new SCWorkshopApp();
  window.sc131App = window.scwApp; // backwards-compatible alias
});
