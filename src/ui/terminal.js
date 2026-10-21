/**
 * VT100 / ANSI / Kaypro / CP437 Serial Terminal Emulator for SC131
 * Renders an 80x25 (with scrollback) character grid onto a high-DPI Canvas
 * and handles keyboard/paste input for RomWBW, CP/M, WordStar, BASIC, Forth, and Games.
 */

// CP437 (IBM PC) high-bit character mapping (0x80 - 0xFF) for RomWBW games (e.g., 2048, Ladder)
const CP437_HIGH = [
  'Ç','ü','é','â','ä','à','å','ç','ê','ë','è','ï','î','ì','Ä','Å',
  'É','æ','Æ','ô','ö','ò','û','ù','ÿ','Ö','Ü','¢','£','¥','₧','ƒ',
  'á','í','ó','ú','ñ','Ñ','ª','º','¿','⌐','¬','½','¼','¡','«','»',
  '░','▒','▓','│','┤','╡','╢','╖','╕','╣','║','╗','╝','╜','╛','┐',
  '└','┴','┬','├','─','┼','╞','╟','╚','╔','╩','╦','╠','═','╬','╧',
  '╨','╤','╥','╙','╘','╒','╓','╫','╪','┘','┌','█','▄','▌','▐','▀',
  'α','ß','Γ','π','Σ','σ','µ','τ','Φ','Θ','Ω','δ','∞','φε','∩','≡',
  '±','≥','≤','⌠','⌡','÷','≈','°','∙','·','√','ⁿ','²','■',' ',
];

const THEMES = {
  amber: {
    bg: '#100c05',
    fg: '#ffb000',
    bold: '#ffd466',
    dim: '#996800',
    cursor: '#ffb000',
    scanline: 'rgba(0, 0, 0, 0.22)',
    palette: [
      '#100c05', '#d75f00', '#ffb000', '#ff8700',
      '#af8700', '#d78700', '#ffaf00', '#e6a100',
      '#664800', '#ff6f00', '#ffc833', '#ffd75f',
      '#dfaf00', '#ffaf5f', '#ffe082', '#fff3cc',
    ],
  },
  green: {
    bg: '#061109',
    fg: '#33ff66',
    bold: '#88ffaa',
    dim: '#198c36',
    cursor: '#33ff66',
    scanline: 'rgba(0, 0, 0, 0.22)',
    palette: [
      '#061109', '#ff5555', '#33ff66', '#f1fa8c',
      '#44aaff', '#ff79c6', '#50fa7b', '#d0f5dc',
      '#1e592d', '#ff6e6e', '#69ff94', '#ffffa5',
      '#8be9fd', '#ff92df', '#a4ffff', '#ffffff',
    ],
  },
  modern: {
    bg: '#0c1017',
    fg: '#e2e8f0',
    bold: '#ffffff',
    dim: '#64748b',
    cursor: '#38bdf8',
    scanline: 'rgba(0, 0, 0, 0.08)',
    palette: [
      '#0c1017', '#ef4444', '#22c55e', '#eab308',
      '#3b82f6', '#a855f7', '#06b6d4', '#e2e8f0',
      '#475569', '#f87171', '#4ade80', '#facc15',
      '#60a5fa', '#c084fc', '#22d3ee', '#ffffff',
    ],
  },
};

export class SerialTerminal {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {number} [options.cols=80]
   * @param {number} [options.rows=25]
   * @param {string} [options.theme='amber']
   * @param {(byte: number) => void} [options.onInput]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cols = options.cols || 80;
    this.rows = options.rows || 25;
    this.themeName = options.theme || 'amber';
    this.onInput = options.onInput || null;
    this.wordstarArrows = false; // If true, map arrow keys to ^E/^X/^S/^D
    this.crtScanlines = true;

    this.charWidth = 11;
    this.charHeight = 22;
    this.fontSize = 16;
    this.sizePreset = options.size || 'lg';
    this.cursorBlink = true;
    this.cursorVisible = true;
    this.focused = false;

    this.reset();
    this.setupEvents();
    this.setSizePreset(this.sizePreset);
  }

  setSizePreset(preset) {
    const presets = {
      sm: { cw: 9, ch: 18, fs: 14 },
      md: { cw: 10, ch: 20, fs: 15 },
      lg: { cw: 11, ch: 22, fs: 16.5 },
      xl: { cw: 13, ch: 26, fs: 19.5 },
    };
    const p = presets[preset] || presets.lg;
    this.sizePreset = preset;
    this.charWidth = p.cw;
    this.charHeight = p.ch;
    this.fontSize = p.fs;
    this.resizeCanvas();
  }

  makeEmptyCell() {
    return {
      ch: ' ',
      fg: 7,
      bg: 0,
      bold: false,
      dim: false,
      underline: false,
      inverse: false,
    };
  }

  makeEmptyRow() {
    const row = new Array(this.cols);
    for (let c = 0; c < this.cols; c++) {
      row[c] = this.makeEmptyCell();
    }
    return row;
  }

  reset() {
    this.grid = new Array(this.rows);
    for (let r = 0; r < this.rows; r++) {
      this.grid[r] = this.makeEmptyRow();
    }

    this.cursorRow = 0;
    this.cursorCol = 0;
    this.savedRow = 0;
    this.savedCol = 0;
    this.scrollTop = 0;
    this.scrollBottom = this.rows - 1;

    // Current SGR attributes
    this.attrFg = 7;
    this.attrBg = 0;
    this.attrBold = false;
    this.attrDim = false;
    this.attrUnderline = false;
    this.attrInverse = false;

    // Escape parser state
    this.escState = 'NORMAL'; // 'NORMAL' | 'ESC' | 'CSI' | 'ESC_EQ_ROW' | 'ESC_EQ_COL'
    this.csiBuffer = '';
    this.eqRow = 0;

    this.dirty = true;
  }

  setTheme(name) {
    if (THEMES[name]) {
      this.themeName = name;
      this.dirty = true;
      this.render();
    }
  }

  resizeCanvas() {
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const width = this.cols * this.charWidth + 16;
    const height = this.rows * this.charHeight + 16;
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.dirty = true;
    this.render();
  }

  setupEvents() {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('focus', () => {
      this.focused = true;
      this.dirty = true;
      this.render();
    });
    this.canvas.addEventListener('blur', () => {
      this.focused = false;
      this.dirty = true;
      this.render();
    });
    this.canvas.addEventListener('mousedown', () => {
      this.canvas.focus();
    });

    this.canvas.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.canvas.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (text) this.pasteText(text);
    });

    if (typeof window !== 'undefined') {
      this.blinkTimer = setInterval(() => {
        this.cursorBlink = !this.cursorBlink;
        if (this.focused) {
          this.dirty = true;
          this.render();
        }
      }, 530);
    }
  }

  pasteText(text) {
    if (!this.onInput) return;
    const normalized = text.replace(/\r?\n/g, '\r');
    for (let i = 0; i < normalized.length; i++) {
      this.onInput(normalized.charCodeAt(i) & 0x7F);
    }
  }

  sendSeq(str) {
    if (!this.onInput) return;
    for (let i = 0; i < str.length; i++) {
      this.onInput(str.charCodeAt(i) & 0xFF);
    }
  }

  handleKeyDown(e) {
    if (!this.onInput) return;

    // Allow browser copy/paste/reload shortcuts
    if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V' || e.key === 'r' || e.key === 'R')) {
      if (e.metaKey) return;
    }

    this.scrollOffset = 0;

    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toUpperCase();
      if (k.length === 1 && k >= 'A' && k <= 'Z') {
        e.preventDefault();
        this.onInput(k.charCodeAt(0) - 64);
        return;
      }
      if (e.key === '[' || e.key === '3') { e.preventDefault(); this.onInput(0x1B); return; }
      if (e.key === '\\' || e.key === '4') { e.preventDefault(); this.onInput(0x1C); return; }
      if (e.key === ']' || e.key === '5') { e.preventDefault(); this.onInput(0x1D); return; }
      if (e.key === '^' || e.key === '6') { e.preventDefault(); this.onInput(0x1E); return; }
      if (e.key === '_' || e.key === '7') { e.preventDefault(); this.onInput(0x1F); return; }
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        this.onInput(0x0D);
        return;
      case 'Backspace':
        e.preventDefault();
        this.onInput(0x08);
        return;
      case 'Delete':
        e.preventDefault();
        this.onInput(0x7F);
        return;
      case 'Tab':
        e.preventDefault();
        this.onInput(0x09);
        return;
      case 'Escape':
        e.preventDefault();
        this.onInput(0x1B);
        return;
      case 'ArrowUp':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x05' : '\x1b[A');
        return;
      case 'ArrowDown':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x18' : '\x1b[B');
        return;
      case 'ArrowRight':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x04' : '\x1b[C');
        return;
      case 'ArrowLeft':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x13' : '\x1b[D');
        return;
      case 'Home':
        e.preventDefault();
        this.sendSeq('\x1b[H');
        return;
      case 'End':
        e.preventDefault();
        this.sendSeq('\x1b[F');
        return;
      case 'PageUp':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x12' : '\x1b[5~');
        return;
      case 'PageDown':
        e.preventDefault();
        this.sendSeq(this.wordstarArrows ? '\x03' : '\x1b[6~');
        return;
    }

    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      this.onInput(e.key.charCodeAt(0) & 0xFF);
    }
  }

  scrollUp(lines = 1) {
    for (let i = 0; i < lines; i++) {
      for (let r = this.scrollTop; r < this.scrollBottom; r++) {
        this.grid[r] = this.grid[r + 1];
      }
      this.grid[this.scrollBottom] = this.makeEmptyRow();
    }
  }

  scrollDown(lines = 1) {
    for (let i = 0; i < lines; i++) {
      for (let r = this.scrollBottom; r > this.scrollTop; r--) {
        this.grid[r] = this.grid[r - 1];
      }
      this.grid[this.scrollTop] = this.makeEmptyRow();
    }
  }

  lineFeed() {
    if (this.cursorRow === this.scrollBottom) {
      this.scrollUp(1);
    } else if (this.cursorRow < this.rows - 1) {
      this.cursorRow++;
    }
  }

  putChar(ch) {
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.lineFeed();
    }
    const cell = this.grid[this.cursorRow][this.cursorCol];
    cell.ch = ch;
    cell.fg = this.attrFg;
    cell.bg = this.attrBg;
    cell.bold = this.attrBold;
    cell.dim = this.attrDim;
    cell.underline = this.attrUnderline;
    cell.inverse = this.attrInverse;
    this.cursorCol++;
  }

  /**
   * Write a single byte from the Z180 serial port into the terminal
   * @param {number} byte
   */
  writeByte(byte) {
    const b = byte & 0xFF;

    if (this.escState === 'ESC') {
      const ch = String.fromCharCode(b);
      if (ch === '[') {
        this.escState = 'CSI';
        this.csiBuffer = '';
        return;
      }
      if (ch === '=' || ch === 'Y') {
        // ADM-3A / Kaypro / VT52 direct cursor addressing: ESC = row col
        this.escState = 'ESC_EQ_ROW';
        return;
      }
      if (ch === '7') {
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
      } else if (ch === '8') {
        this.cursorRow = this.savedRow;
        this.cursorCol = this.savedCol;
      } else if (ch === 'c') {
        this.reset();
      } else if (ch === 'D') {
        this.lineFeed();
      } else if (ch === 'M') {
        if (this.cursorRow === this.scrollTop) this.scrollDown(1);
        else if (this.cursorRow > 0) this.cursorRow--;
      } else if (ch === 'A') {
        this.cursorRow = Math.max(0, this.cursorRow - 1);
      } else if (ch === 'B') {
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + 1);
      } else if (ch === 'C') {
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + 1);
      } else if (ch === 'H') {
        this.cursorRow = 0;
        this.cursorCol = 0;
      } else if (ch === 'J') {
        this.clearScreen(0);
      } else if (ch === 'K') {
        this.clearLine(0);
      }
      this.escState = 'NORMAL';
      this.dirty = true;
      return;
    }

    if (this.escState === 'ESC_EQ_ROW') {
      this.eqRow = Math.max(0, Math.min(this.rows - 1, b - 32));
      this.escState = 'ESC_EQ_COL';
      return;
    }

    if (this.escState === 'ESC_EQ_COL') {
      this.cursorRow = this.eqRow;
      this.cursorCol = Math.max(0, Math.min(this.cols - 1, b - 32));
      this.escState = 'NORMAL';
      this.dirty = true;
      return;
    }

    if (this.escState === 'CSI') {
      if (b >= 0x40 && b <= 0x7E) {
        this.handleCSI(this.csiBuffer, String.fromCharCode(b));
        this.escState = 'NORMAL';
        this.dirty = true;
      } else {
        this.csiBuffer += String.fromCharCode(b);
        if (this.csiBuffer.length > 32) {
          this.escState = 'NORMAL';
        }
      }
      return;
    }

    // Normal state
    switch (b) {
      case 0x00:
      case 0x07: // BEL
        break;
      case 0x08: // BS
        if (this.cursorCol > 0) this.cursorCol--;
        break;
      case 0x09: // TAB
        this.cursorCol = Math.min(this.cols - 1, (this.cursorCol + 8) & ~7);
        break;
      case 0x0A: // LF
      case 0x0B: // VT
        this.lineFeed();
        break;
      case 0x0C: // FF (Clear screen in many retro BASICs / monitors)
        this.clearScreen(2);
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      case 0x0D: // CR
        this.cursorCol = 0;
        break;
      case 0x1A: // ^Z (ADM-3A / Kaypro Clear Screen)
        this.clearScreen(2);
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      case 0x1B: // ESC
        this.escState = 'ESC';
        break;
      default:
        if (b >= 0x20 && b <= 0x7E) {
          this.putChar(String.fromCharCode(b));
        } else if (b >= 0x80) {
          this.putChar(CP437_HIGH[b - 0x80] || ' ');
        }
        break;
    }
    this.dirty = true;
  }

  clearLine(mode) {
    const row = this.grid[this.cursorRow];
    if (mode === 0) {
      for (let c = this.cursorCol; c < this.cols; c++) row[c] = this.makeEmptyCell();
    } else if (mode === 1) {
      for (let c = 0; c <= Math.min(this.cols - 1, this.cursorCol); c++) row[c] = this.makeEmptyCell();
    } else if (mode === 2) {
      this.grid[this.cursorRow] = this.makeEmptyRow();
    }
  }

  clearScreen(mode) {
    if (mode === 0) {
      this.clearLine(0);
      for (let r = this.cursorRow + 1; r < this.rows; r++) {
        this.grid[r] = this.makeEmptyRow();
      }
    } else if (mode === 1) {
      for (let r = 0; r < this.cursorRow; r++) {
        this.grid[r] = this.makeEmptyRow();
      }
      this.clearLine(1);
    } else if (mode === 2 || mode === 3) {
      for (let r = 0; r < this.rows; r++) {
        this.grid[r] = this.makeEmptyRow();
      }
    }
  }

  handleCSI(buf, finalChar) {
    const privateMode = buf.startsWith('?');
    const clean = privateMode ? buf.slice(1) : buf;
    const parts = clean.length > 0 ? clean.split(';').map((s) => parseInt(s, 10)) : [];
    const p0 = Number.isNaN(parts[0]) || parts[0] === undefined ? 1 : parts[0];
    const p1 = Number.isNaN(parts[1]) || parts[1] === undefined ? 1 : parts[1];

    if (privateMode) {
      if (parts[0] === 25) {
        if (finalChar === 'h') this.cursorVisible = true;
        if (finalChar === 'l') this.cursorVisible = false;
      }
      return;
    }

    switch (finalChar) {
      case 'A': // CUU
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        break;
      case 'B': // CUD
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        break;
      case 'C': // CUF
        this.cursorCol = Math.min(this.cols - 1, this.cursorCol + Math.max(1, p0));
        break;
      case 'D': // CUB
        this.cursorCol = Math.max(0, this.cursorCol - Math.max(1, p0));
        break;
      case 'E': // CNL
        this.cursorRow = Math.min(this.rows - 1, this.cursorRow + Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'F': // CPL
        this.cursorRow = Math.max(0, this.cursorRow - Math.max(1, p0));
        this.cursorCol = 0;
        break;
      case 'G': // CHA
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, p0 - 1));
        break;
      case 'd': // VPA
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, p0 - 1));
        break;
      case 'H':
      case 'f': // CUP
        this.cursorRow = Math.max(0, Math.min(this.rows - 1, p0 - 1));
        this.cursorCol = Math.max(0, Math.min(this.cols - 1, p1 - 1));
        break;
      case 'J': // ED
        this.clearScreen(parts[0] || 0);
        if ((parts[0] || 0) === 2) {
          this.cursorRow = 0;
          this.cursorCol = 0;
        }
        break;
      case 'K': // EL
        this.clearLine(parts[0] || 0);
        break;
      case 'L': { // IL (Insert Lines)
        const count = Math.max(1, p0);
        for (let i = 0; i < count; i++) {
          for (let r = this.scrollBottom; r > this.cursorRow; r--) {
            this.grid[r] = this.grid[r - 1];
          }
          this.grid[this.cursorRow] = this.makeEmptyRow();
        }
        break;
      }
      case 'M': { // DL (Delete Lines)
        const count = Math.max(1, p0);
        for (let i = 0; i < count; i++) {
          for (let r = this.cursorRow; r < this.scrollBottom; r++) {
            this.grid[r] = this.grid[r + 1];
          }
          this.grid[this.scrollBottom] = this.makeEmptyRow();
        }
        break;
      }
      case 'P': { // DCH (Delete Characters)
        const count = Math.max(1, p0);
        const row = this.grid[this.cursorRow];
        row.splice(this.cursorCol, count);
        while (row.length < this.cols) row.push(this.makeEmptyCell());
        break;
      }
      case '@': { // ICH (Insert Characters)
        const count = Math.max(1, p0);
        const row = this.grid[this.cursorRow];
        for (let i = 0; i < count; i++) {
          row.splice(this.cursorCol, 0, this.makeEmptyCell());
          row.pop();
        }
        break;
      }
      case 'r': // DECSTBM (Set Top and Bottom Margins)
        this.scrollTop = Math.max(0, Math.min(this.rows - 1, p0 - 1));
        this.scrollBottom = Math.max(this.scrollTop, Math.min(this.rows - 1, (parts[1] || this.rows) - 1));
        this.cursorRow = 0;
        this.cursorCol = 0;
        break;
      case 's':
        this.savedRow = this.cursorRow;
        this.savedCol = this.cursorCol;
        break;
      case 'u':
        this.cursorRow = this.savedRow;
        this.cursorCol = this.savedCol;
        break;
      case 'm': { // SGR
        const codes = parts.length === 0 ? [0] : parts;
        for (const rawCode of codes) {
          const code = Number.isNaN(rawCode) ? 0 : rawCode;
          if (code === 0) {
            this.attrFg = 7;
            this.attrBg = 0;
            this.attrBold = false;
            this.attrDim = false;
            this.attrUnderline = false;
            this.attrInverse = false;
          } else if (code === 1) {
            this.attrBold = true;
          } else if (code === 2) {
            this.attrDim = true;
          } else if (code === 4) {
            this.attrUnderline = true;
          } else if (code === 7) {
            this.attrInverse = true;
          } else if (code === 22) {
            this.attrBold = false;
            this.attrDim = false;
          } else if (code === 24) {
            this.attrUnderline = false;
          } else if (code === 27) {
            this.attrInverse = false;
          } else if (code >= 30 && code <= 37) {
            this.attrFg = code - 30;
          } else if (code === 39) {
            this.attrFg = 7;
          } else if (code >= 40 && code <= 47) {
            this.attrBg = code - 40;
          } else if (code === 49) {
            this.attrBg = 0;
          } else if (code >= 90 && code <= 97) {
            this.attrFg = code - 90 + 8;
          } else if (code >= 100 && code <= 107) {
            this.attrBg = code - 100 + 8;
          }
        }
        break;
      }
    }
  }

  /**
   * Extract visible screen text as string (useful for copy to clipboard / testing)
   */
  getScreenText() {
    return this.grid.map((row) => row.map((c) => c.ch).join('').trimEnd()).join('\n');
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;

    const theme = THEMES[this.themeName] || THEMES.amber;
    const ctx = this.ctx;
    const pad = 8;
    const width = this.cols * this.charWidth + pad * 2;
    const height = this.rows * this.charHeight + pad * 2;

    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    ctx.font = `${this.fontSize || 16}px "JetBrains Mono", "Fira Code", "Cascadia Mono", "Courier New", monospace`;
    ctx.textBaseline = 'top';

    for (let r = 0; r < this.rows; r++) {
      const row = this.grid[r];
      if (!row) continue;

      const y = pad + r * this.charHeight;
      for (let c = 0; c < this.cols; c++) {
        const cell = row[c];
        const x = pad + c * this.charWidth;

        let fgIdx = cell.fg;
        let bgIdx = cell.bg;
        if (cell.bold && fgIdx < 8) fgIdx += 8;

        let fgColor = fgIdx === 7 ? (cell.bold ? theme.bold : cell.dim ? theme.dim : theme.fg) : theme.palette[fgIdx];
        let bgColor = bgIdx === 0 ? theme.bg : theme.palette[bgIdx];

        if (cell.inverse) {
          const tmp = fgColor;
          fgColor = bgColor;
          bgColor = tmp;
        }

        if (bgColor !== theme.bg) {
          ctx.fillStyle = bgColor;
          ctx.fillRect(x, y, this.charWidth, this.charHeight);
        }

        if (cell.ch !== ' ') {
          ctx.fillStyle = fgColor;
          ctx.fillText(cell.ch, x, y + 2);
        }

        if (cell.underline) {
          ctx.fillStyle = fgColor;
          ctx.fillRect(x, y + this.charHeight - 2, this.charWidth, 1);
        }
      }
    }

    // Draw cursor
    if (this.cursorVisible) {
      const cx = pad + Math.min(this.cols - 1, this.cursorCol) * this.charWidth;
      const cy = pad + this.cursorRow * this.charHeight;
      ctx.fillStyle = theme.cursor;
      if (!this.focused) {
        ctx.strokeStyle = theme.cursor;
        ctx.lineWidth = 1;
        ctx.strokeRect(cx + 0.5, cy + 0.5, this.charWidth - 1, this.charHeight - 1);
      } else if (this.cursorBlink) {
        ctx.globalAlpha = 0.82;
        ctx.fillRect(cx, cy, this.charWidth, this.charHeight);
        ctx.globalAlpha = 1.0;
        const curCell = this.grid[this.cursorRow]?.[this.cursorCol];
        if (curCell && curCell.ch !== ' ') {
          ctx.fillStyle = theme.bg;
          ctx.fillText(curCell.ch, cx, cy + 2);
        }
      }
    }

    // Subtle CRT scanline effect
    if (this.crtScanlines) {
      ctx.fillStyle = theme.scanline;
      for (let y = 0; y < height; y += 2) {
        ctx.fillRect(0, y, width, 1);
      }
    }
  }
}
