/**
 * Main Browser Application for SC131 Z180 Pocket Computer Emulator
 * - Left Column: Prominent Terminal (scrollbar-only scrollback) + Debugger below the terminal
 * - Right Column: Always-visible SC131 Hardware Panels (Enclosure, SDHC, Serial/Supervisor, PCB & Jumpers)
 */

import { SC131 } from '../emulator/sc131.js';
import { disassembleRange } from '../emulator/disasm.js';
import { SerialTerminal } from './terminal.js';

const hex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const hex4 = (v) => (v & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
const hex5 = (v) => (v & 0xFFFFF).toString(16).toUpperCase().padStart(5, '0');
const hex6 = (v) => (v >>> 0).toString(16).toUpperCase().padStart(6, '0');

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
    this.romCache = {};

    this.debuggerVisible = true;
    this.debuggerLive = false;
    this.disasmBaseAddr = null; // null = follow PC when refreshed
    this.syncingMemInput = false;

    // Initialize terminals
    const canvas0 = document.getElementById('term-canvas-0');
    const canvas1 = document.getElementById('term-canvas-1');

    this.term0 = new SerialTerminal(canvas0, {
      cols: 80,
      rows: 25,
      size: 'lg',
      theme: 'amber',
      onInput: (b) => {
        this.sc131.sendSerial(0, b);
        this.triggerSerialDot(0);
      },
    });

    this.term1 = new SerialTerminal(canvas1, {
      cols: 80,
      rows: 25,
      size: 'lg',
      theme: 'amber',
      onInput: (b) => {
        this.sc131.sendSerial(1, b);
        this.triggerSerialDot(1);
      },
    });

    // Initialize SC131 hardware
    this.sc131 = new SC131({
      onSerialTx: (ch, byte) => {
        if (ch === 0) this.term0.writeByte(byte);
        else this.term1.writeByte(byte);
        this.triggerSerialDot(ch);
      },
      onLedChange: (leds) => this.updateLedsUI(leds),
      onSdActivity: (op, lba) => this.handleSdActivity(op, lba),
    });

    this.bindUI();
    this.setupMemoryVirtualScroll();
    this.bootDefaultSystem();
  }

  getActiveTerminal() {
    return this.activeSerialTab === 0 ? this.term0 : this.term1;
  }

  triggerSerialDot(ch) {
    const el = document.getElementById(ch === 0 ? 'txrx-0' : 'txrx-1');
    if (!el) return;
    el.classList.add('active');
    clearTimeout(this.txRxBlink[ch]);
    this.txRxBlink[ch] = setTimeout(() => el.classList.remove('active'), 90);
  }

  updateLedsUI(leds) {
    document.getElementById('led-status')?.classList.toggle('on', leds.status);
    document.getElementById('led-power')?.classList.toggle('on', leds.power);
    document.getElementById('led-reset')?.classList.toggle('on', leds.reset);
    document.getElementById('led-sd-act')?.classList.toggle('on', leds.sdSelect);
  }

  handleSdActivity(op, lba) {
    const opEl = document.getElementById('sd-last-op');
    const lbaEl = document.getElementById('sd-last-lba');
    const rwEl = document.getElementById('sd-rw-count');
    if (opEl) opEl.textContent = op;
    if (lbaEl) lbaEl.textContent = '0x' + hex6(lba);
    if (rwEl) rwEl.textContent = `${this.sc131.sdcard.readCount} / ${this.sc131.sdcard.writeCount}`;

    const sdLed = document.getElementById('led-sd-act');
    if (sdLed) {
      sdLed.classList.add('on');
      clearTimeout(this.sdBlinkTimeout);
      this.sdBlinkTimeout = setTimeout(() => {
        sdLed.classList.toggle('on', this.sc131.getLeds().sdSelect);
      }, 65);
    }
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

  async bootDefaultSystem() {
    try {
      const [romBytes, sdRaw] = await Promise.all([
        this.fetchAssetBytes('./assets/romwbw_sc131.rom'),
        this.fetchAssetBytes('./assets/sc131_sdcard.simg'),
      ]);
      this.romCache.romwbw = romBytes;
      const sdBundle = await decompressIfGzip(sdRaw);
      this.sc131.loadRom(romBytes);
      this.sc131.sdcard.loadSparseBundle(sdBundle);
      this.triggerHardwareResetPulse(220);
      this.running = true;
      this.startLoop();
      this.term0.canvas.focus();
    } catch (err) {
      console.error('Error loading default SC131 assets:', err);
      const msg = `\r\n[Error loading SC131 ROM/SD assets: ${err.message}]\r\n`;
      for (let i = 0; i < msg.length; i++) this.term0.writeByte(msg.charCodeAt(i));
      this.term0.render();
    }
  }

  async switchFirmware(fwKey) {
    try {
      if (fwKey === 'romwbw') {
        if (!this.romCache.romwbw) {
          this.romCache.romwbw = await this.fetchAssetBytes('./assets/romwbw_sc131.rom');
        }
        this.sc131.loadRom(this.romCache.romwbw);
      } else if (fwKey === 'scm_s6') {
        if (!this.romCache.scm_s6) {
          this.romCache.scm_s6 = await this.fetchAssetBytes('./assets/scm_s6.rom');
        }
        this.sc131.loadRom(this.romCache.scm_s6);
      }
      this.term0.reset();
      this.term1.reset();
      this.triggerHardwareResetPulse(250);
      this.running = true;
      this.updateRunPauseButton();
      this.term0.canvas.focus();
    } catch (err) {
      console.error('Failed to switch firmware:', err);
    }
  }

  triggerHardwareResetPulse(durationMs = 280) {
    this.sc131.reset();
    this.sc131.resetPulseRemainingMs = durationMs;
    this.sc131.notifyLeds();
    this.updateStatusPill();

    setTimeout(() => {
      this.sc131.resetPulseRemainingMs = 0;
      this.sc131.notifyLeds();
      this.updateStatusPill();
      this.updateInspectorUI(true);
    }, durationMs);
  }

  sendMacroString(str, delayMs = 18) {
    this.running = true;
    this.updateRunPauseButton();
    let idx = 0;
    const stepChar = () => {
      if (idx >= str.length) return;
      this.sc131.sendSerial(this.activeSerialTab, str.charCodeAt(idx) & 0xFF);
      this.triggerSerialDot(this.activeSerialTab);
      idx++;
      if (idx < str.length) setTimeout(stepChar, delayMs);
    };
    stepChar();
    this.getActiveTerminal().canvas.focus();
  }

  runLedBlinkDemo() {
    const prog = [
      '10 PRINT "SC131 STATUS LED1 (PORT 14) BLINK DEMO"',
      '20 FOR I=1 TO 6',
      '30 PRINT "LED1 ON  (OUT 14, 0)" : OUT 14, 0',
      '40 FOR D=1 TO 1200 : NEXT D',
      '50 PRINT "LED1 OFF (OUT 14, 255)" : OUT 14, 255',
      '60 FOR D=1 TO 1200 : NEXT D',
      '70 NEXT I',
      '80 OUT 14, 0 : PRINT "DONE! LED1 LEFT ON."',
      'RUN',
      '',
    ].join('\r');
    this.sendMacroString(prog, 10);
  }

  bindUI() {
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
      this.sc131.cpu.step();
      this.term0.render();
      this.term1.render();
      this.updateStatusPill();
      this.updateInspectorUI(true);
    });

    // Reset buttons (topbar + SW1 tactile button on front panel)
    const doReset = () => {
      this.triggerHardwareResetPulse(320);
      this.term0.canvas.focus();
    };
    document.getElementById('btn-reset')?.addEventListener('click', doReset);
    document.getElementById('hw-reset-btn')?.addEventListener('click', doReset);

    // JP1 Flash Write Protect Jumper
    const btnJp1 = document.getElementById('btn-jp1');
    btnJp1?.addEventListener('click', () => {
      this.sc131.jp1WriteEnable = !this.sc131.jp1WriteEnable;
      btnJp1.classList.toggle('rd', !this.sc131.jp1WriteEnable);
      btnJp1.classList.toggle('wr', this.sc131.jp1WriteEnable);
      btnJp1.textContent = this.sc131.jp1WriteEnable
        ? 'JP1: Wr (Flash Write Enabled)'
        : 'JP1: Rd (Write Protected)';
    });

    // JP2 Serial Port B Power Jumper
    const btnJp2 = document.getElementById('btn-jp2');
    btnJp2?.addEventListener('click', () => {
      this.sc131.jp2PowerPortB = !this.sc131.jp2PowerPortB;
      btnJp2.classList.toggle('rd', this.sc131.jp2PowerPortB);
      btnJp2.textContent = this.sc131.jp2PowerPortB
        ? 'JP2: Fitted (Port B 5V Connected)'
        : 'JP2: Open (Via Port A)';
    });

    // Vcc Voltage Supervisor Slider (DS1233-5+ trips below 4.7V)
    const vccSlider = document.getElementById('vcc-slider');
    const vccVal = document.getElementById('vcc-val');
    vccSlider?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      const wasReset = this.sc131.isHeldInReset();
      this.sc131.supplyVoltage = v;
      if (vccVal) vccVal.textContent = v.toFixed(2) + 'V';
      const nowReset = this.sc131.isHeldInReset();
      if (wasReset && !nowReset) {
        this.triggerHardwareResetPulse(250);
      } else {
        this.sc131.notifyLeds();
        this.updateStatusPill();
      }
    });

    // Custom ROM file upload
    document.getElementById('rom-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      if (file.name.toLowerCase().endsWith('.hex')) {
        const text = new TextDecoder().decode(bytes);
        this.sc131.loadIntelHexRom(text);
      } else {
        this.sc131.loadRom(bytes);
      }
      this.term0.reset();
      this.triggerHardwareResetPulse(250);
    });

    // Custom SD card image mount
    document.getElementById('sd-file-input')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const ab = await file.arrayBuffer();
      const raw = await decompressIfGzip(new Uint8Array(ab));
      this.sc131.sdcard.loadSparseBundle(raw);
      this.sc131.sdcard.present = true;
      const st = document.getElementById('sd-status-text');
      if (st) st.textContent = `SD0: ${file.name} (${this.sc131.sdcard.sizeMB} MB)`;
    });

    // Export SD card image
    document.getElementById('btn-sd-export')?.addEventListener('click', () => {
      const data = this.sc131.sdcard.exportImage(18);
      const blob = new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sc131_sdcard_export.img';
      a.click();
      URL.revokeObjectURL(url);
    });

    // Eject / Insert SD card
    const btnEject = document.getElementById('btn-sd-eject');
    btnEject?.addEventListener('click', () => {
      this.sc131.sdcard.present = !this.sc131.sdcard.present;
      btnEject.textContent = this.sc131.sdcard.present ? 'Eject SD' : 'Insert SD';
      const st = document.getElementById('sd-status-text');
      if (st) {
        st.textContent = this.sc131.sdcard.present
          ? `SD0: ${this.sc131.sdcard.sizeMB} MB SDHC (Present)`
          : 'SD0: [Card Ejected]';
      }
    });

    // Quick-launch macros
    document.querySelectorAll('[data-macro]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const macro = btn.getAttribute('data-macro');
        if (macro) this.sendMacroString(macro);
      });
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
      this.term1.canvas.focus();
    });

    // Terminal Size selector
    document.getElementById('term-size-select')?.addEventListener('change', (e) => {
      const preset = e.target.value;
      this.term0.setSizePreset(preset);
      this.term1.setSizePreset(preset);
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
        if (text) this.sendMacroString(text.replace(/\r?\n/g, '\r'), 6);
      } catch {
        const text = window.prompt('Paste text to send to SC131 serial port:');
        if (text) this.sendMacroString(text.replace(/\r?\n/g, '\r'), 6);
      }
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
        if (this.sc131.breakpoints.has(a16)) this.sc131.breakpoints.delete(a16);
        else this.sc131.breakpoints.add(a16);
        input.value = '';
        this.updateDisasmUI();
      }
    });

    document.getElementById('btn-clear-bp')?.addEventListener('click', () => {
      this.sc131.breakpoints.clear();
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
        else label.textContent = '$00000 – $7FFFF (512 KB Static RAM U2)';
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
        const st = this.sc131.cpu.getState();
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
        if (space === 'logical') b = this.sc131.cpu.memRead(a & 0xFFFF);
        else if (space === 'rom') b = this.sc131.rom[a & 0x7FFFF];
        else b = this.sc131.ram[a & 0x7FFFF];
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
    if (this.sc131.isHeldInReset()) {
      pill.classList.add('pill-reset');
      pill.textContent = this.sc131.supplyVoltage < 4.7
        ? `DS1233 BROWNOUT RESET (${this.sc131.supplyVoltage.toFixed(2)}V < 4.7V)`
        : 'HARDWARE RESET (SW1)';
    } else if (this.running) {
      pill.classList.add('pill-running');
      const mhz = ((this.sc131.cpu.getPhiHz() * this.speedMultiplier) / 1e6).toFixed(3);
      pill.textContent = `RUNNING @ ${mhz} MHz`;
    } else {
      pill.classList.add('pill-paused');
      pill.textContent = `PAUSED @ PC=$${hex4(this.sc131.cpu.pc)}`;
    }
  }

  startLoop() {
    let lastTime = performance.now();
    let uiTick = 0;

    const frame = (now) => {
      const dtMs = Math.min(50, Math.max(1, now - lastTime));
      lastTime = now;

      if (this.running && !this.sc131.isHeldInReset()) {
        const phiHz = this.sc131.cpu.getPhiHz();
        const targetCycles = Math.round((phiHz * this.speedMultiplier * dtMs) / 1000);
        const { breakpointHit } = this.sc131.runCycles(targetCycles);
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
    const st = this.sc131.cpu.getState();
    const mhz = (st.phiHz / 1e6).toFixed(3);

    const perfEl = document.getElementById('perf-counter');
    if (perfEl) {
      perfEl.textContent = `PHI ${mhz} MHz • ${(st.cycles / 1e6).toFixed(1)}M T-states`;
    }

    // Update always-visible right-column hardware status
    const s0 = this.sc131.getSerialConfig(0);
    const s1 = this.sc131.getSerialConfig(1);
    const phiEl = document.getElementById('pcb-phi-label');
    const a0El = document.getElementById('asci0-cfg');
    const a1El = document.getElementById('asci1-cfg');
    if (phiEl) phiEl.textContent = `PHI = ${mhz} MHz`;
    if (a0El) a0El.textContent = `${s0.baud} ${s0.framing}`;
    if (a1El) a1El.textContent = `${s1.baud} ${s1.framing}`;
    document.getElementById('asci0-rts')?.classList.toggle('on', s0.rts);

    if (!this.debuggerVisible) return;

    if (force || !this.running || this.debuggerLive) {
      this.updateCpuMmuUI(st);
      this.updateDisasmUI(st);
      this.renderVisibleMemoryHex();
    }
  }

  updateCpuMmuUI(st = this.sc131.cpu.getState()) {
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

    const mmu = this.sc131.getMmuSummary();
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

  updateDisasmUI(st = this.sc131.cpu.getState()) {
    const disasmEl = document.getElementById('disasm-view');
    if (!disasmEl) return;

    const startAddr = this.disasmBaseAddr !== null ? this.disasmBaseAddr : st.pc;
    const lines = disassembleRange((a) => this.sc131.cpu.memRead(a), startAddr, 64);
    disasmEl.innerHTML = lines.map((inst) => {
      const isPc = inst.addr === st.pc;
      const hasBp = this.sc131.breakpoints.has(inst.addr);
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
        if (this.sc131.breakpoints.has(a)) this.sc131.breakpoints.delete(a);
        else this.sc131.breakpoints.add(a);
        this.updateDisasmUI();
      });
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.sc131App = new SC131EmulatorApp();
});
