import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { SC131 } from '../src/emulator/sc131.js';
import { SC126 } from '../src/emulator/sc126.js';
import { Z180_REG } from '../src/emulator/z180.js';
import { disassembleOne } from '../src/emulator/disasm.js';
import { SerialTerminal } from '../src/ui/terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '../assets');

const romwbwBytes = new Uint8Array(fs.readFileSync(path.join(assetsDir, 'romwbw_sc131.rom')));
const romwbw126Bytes = new Uint8Array(fs.readFileSync(path.join(assetsDir, 'romwbw_sc126.rom')));
const scmBytes = new Uint8Array(fs.readFileSync(path.join(assetsDir, 'scm_s6.rom')));
const sdCompressed = fs.readFileSync(path.join(assetsDir, 'sc131_sdcard.simg'));
const sdBundleBytes = new Uint8Array(zlib.gunzipSync(sdCompressed));
const fuzixCompressed = fs.readFileSync(path.join(assetsDir, 'fuzix_sdcard.simg'));
const fuzixBundleBytes = new Uint8Array(zlib.gunzipSync(fuzixCompressed));

describe('SC131 Z180 Pocket Computer Emulator', () => {
  test('Z180 extended instructions (MLT, IN0, OUT0, TST, OTIMR) and MMU translation', () => {
    const sc = new SC131();
    // Enable Flash write via JP1 to place test code at 0x0000
    sc.jp1WriteEnable = true;

    // Program:
    // 0000: LD A, $C0       (3E C0)
    // 0002: OUT0 ($3F), A   (ED 39 3F) -> Move Z180 internal I/O base to $C0
    // 0005: LD DE, $0506    (11 06 05)
    // 0008: MLT DE          (ED 5C)    -> DE = 5 * 6 = 30 ($001E)
    // 000A: LD A, $1E       (3E 1E)
    // 000C: TST E           (ED 1C)    -> Z=0, H=1
    // 000E: OUT ($0E), A    (D3 0E)    -> Bit 2 of $1E is 1 -> Status LED OFF
    // 0010: HALT            (76)
    const code = [
      0x3E, 0xC0,
      0xED, 0x39, 0x3F,
      0x11, 0x06, 0x05,
      0xED, 0x5C,
      0x3E, 0x1E,
      0xED, 0x1C,
      0xD3, 0x0E,
      0x76,
    ];
    code.forEach((b, i) => sc.writePhysMem(i, b));
    sc.jp1WriteEnable = false;

    sc.reset();
    // At hardware reset, Status LED1 is ON (active low latch = 0)
    assert.equal(sc.getLeds().status, true);

    sc.runCycles(200);
    assert.equal(sc.cpu.halted, true);
    assert.equal(sc.cpu.getDE(), 30);
    assert.equal(sc.cpu.ioRegs[Z180_REG.ICR], 0xC0);
    // Bit 2 of 0x1E is 1 -> Status LED1 turned OFF
    assert.equal(sc.getLeds().status, false);
  });

  test('DS1233-5+ EconoReset supervisor holds CPU in reset below 4.7V', () => {
    const sc = new SC131();
    sc.supplyVoltage = 4.5;
    assert.equal(sc.isHeldInReset(), true);
    assert.equal(sc.getLeds().reset, true);
    assert.equal(sc.getLeds().status, false);

    const res = sc.runCycles(1000);
    assert.equal(res.cyclesExecuted, 0);

    sc.supplyVoltage = 5.0;
    assert.equal(sc.isHeldInReset(), false);
    assert.equal(sc.getLeds().reset, false);
  });

  test('Disassembler decodes Z180 extended opcodes accurately', () => {
    const mem = new Uint8Array([
      0xED, 0x39, 0x3F, // OUT0 ($3F),A
      0xED, 0x38, 0xC4, // IN0 A,($C4)
      0xED, 0x5C,       // MLT DE
      0xED, 0x64, 0xAA, // TST $AA
      0xED, 0x93,       // OTIMR
      0xED, 0x76,       // SLP
    ]);
    const rb = (a) => mem[a];
    assert.equal(disassembleOne(rb, 0).mnemonic, 'OUT0 ($3F),A');
    assert.equal(disassembleOne(rb, 3).mnemonic, 'IN0 A,($C4)');
    assert.equal(disassembleOne(rb, 6).mnemonic, 'MLT DE');
    assert.equal(disassembleOne(rb, 8).mnemonic, 'TST $AA');
    assert.equal(disassembleOne(rb, 11).mnemonic, 'OTIMR');
    assert.equal(disassembleOne(rb, 13).mnemonic, 'SLP');
  });

  test('Boots official RomWBW v3.6.0 (SCZ180_sc131_std.rom) and detects Z8S180-N, ASCI0/1, and SDHC card', () => {
    let consoleOut = '';
    const sc = new SC131({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b);
      },
    });
    sc.loadRom(romwbwBytes);
    sc.sdcard.loadSparseBundle(sdBundleBytes);
    sc.reset();

    sc.runCycles(50_000_000);

    assert.match(consoleOut, /RomWBW HBIOS v3\.6\.0/);
    assert.match(consoleOut, /Small Computer SC131 \[SCZ180_sc131_std\] Z8S180-N @ 18\.432MHz IO=0xC0/);
    assert.match(consoleOut, /512KB ROM, 512KB RAM/);
    assert.match(consoleOut, /ROM VERIFY: 00 00 00 00 PASS/);
    assert.match(consoleOut, /ASCI0: IO=0xC0 ASCI W\/BRG MODE=115200,8,N,1/);
    assert.match(consoleOut, /SD0: SDHC NAME=SC131/);
    assert.match(consoleOut, /Boot \[H=Help\]:/);

    // Check Slice Inventory ('S')
    consoleOut = '';
    sc.sendSerial(0, 'S\r');
    sc.runCycles(45_000_000);
    assert.match(consoleOut, /2\.0\s+CP\/M 2\.2/);
    assert.match(consoleOut, /2\.1\s+ZSDOS 1\.1/);
    assert.match(consoleOut, /2\.2\s+CP\/M 3/);
    assert.match(consoleOut, /2\.3\s+Games/);

    // Boot CP/M 2.2 from SD0.0 ('2.0') and run DIR
    consoleOut = '';
    sc.sendSerial(0, '2.0\r');
    sc.runCycles(40_000_000);
    assert.match(consoleOut, /CP\/M-80 v2\.2, 54\.0K TPA/);
    assert.match(consoleOut, /A>/);

    consoleOut = '';
    sc.sendSerial(0, 'DIR\r');
    sc.runCycles(25_000_000);
    assert.match(consoleOut, /BBCBASIC COM/);
    assert.match(consoleOut, /MBASIC\s+COM/);
  });

  test('Controls Status LED1 (Port 14 / 0x0E) from RomWBW Microsoft BASIC', () => {
    let consoleOut = '';
    const sc = new SC131({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b);
      },
    });
    sc.loadRom(romwbwBytes);
    sc.reset();
    sc.runCycles(50_000_000);

    // Launch BASIC ('B') and accept default Memory top
    consoleOut = '';
    sc.sendSerial(0, 'B\r\r');
    sc.runCycles(20_000_000);
    assert.match(consoleOut, /Z80 BASIC Ver 4\.7b/);
    assert.match(consoleOut, /Ok/);

    // Turn Status LED OFF: OUT 14, 255
    sc.sendSerial(0, 'OUT 14, 255\r');
    sc.runCycles(5_000_000);
    assert.equal(sc.getLeds().status, false);

    // Turn Status LED ON: OUT 14, 0
    sc.sendSerial(0, 'OUT 14, 0\r');
    sc.runCycles(5_000_000);
    assert.equal(sc.getLeds().status, true);
  });

  test('Boots Small Computer Monitor S6 (scm_s6.rom) and executes monitor commands', () => {
    let consoleOut = '';
    const sc = new SC131({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b);
      },
    });
    sc.loadRom(scmBytes);
    sc.reset();

    sc.runCycles(20_000_000);
    assert.match(consoleOut, /Small Computer Monitor/);
    assert.match(consoleOut, /\*/);

    consoleOut = '';
    sc.sendSerial(0, 'DEVICES\r');
    sc.runCycles(10_000_000);
    assert.match(consoleOut, /Z180 ASCI\s+@ C0/);
  });

  test('Boots WordStar 4.0 from SD0.4 (Slice 4) and renders Opening Menu and CHAPTER1.DOC in SerialTerminal', () => {
    const fakeCanvas = {
      getContext: () => ({
        setTransform() {},
        fillRect() {},
        fillText() {},
        strokeRect() {},
      }),
      addEventListener() {},
      style: {},
    };
    const term = new SerialTerminal(fakeCanvas);
    const sc = new SC131({
      onSerialTx: (ch, b) => {
        if (ch === 0) term.writeByte(b);
      },
    });
    sc.loadRom(romwbwBytes);
    sc.sdcard.loadSparseBundle(sdBundleBytes);
    sc.reset();

    sc.runCycles(50_000_000);
    sc.sendSerial(0, '2.4\r');
    sc.runCycles(40_000_000);
    sc.sendSerial(0, 'WS\r');
    sc.runCycles(120_000_000);

    const menuScreen = term.getScreenText();
    assert.match(menuScreen, /WordStar, CP\/M Edition, Release 4/);
    assert.match(menuScreen, /O P E N I N G   M E N U/);
    assert.match(menuScreen, /CHAPTER1\.DOC/);
    assert.equal(term.cursorRow, 0);
    assert.equal(term.cursorCol, 0);

    sc.sendSerial(0, 'DCHAPTER1.DOC\r');
    sc.runCycles(120_000_000);
    const editScreen = term.getScreenText();
    assert.match(editScreen, /E D I T   M E N U/);
    assert.match(editScreen, /This is chapter 1\./);
  });
});

describe('SC126 Z180 RC2014 Motherboard Emulator', () => {
  test('Boots official RomWBW v3.6.0 (SCZ180_sc126_std.rom), detects DS1302 RTC, SDHC, and drives Port 0x0D 8-LED bar', () => {
    let consoleOut = '';
    const diagHistory = [];
    const sc126 = new SC126({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b);
      },
      onLedChange: (leds) => {
        if (diagHistory.length === 0 || diagHistory[diagHistory.length - 1] !== leds.diagByte) {
          diagHistory.push(leds.diagByte);
        }
      },
    });
    sc126.loadRom(romwbw126Bytes);
    sc126.sdcard.loadSparseBundle(sdBundleBytes);
    sc126.reset();

    sc126.runCycles(35_000_000);

    assert.match(consoleOut, /RomWBW HBIOS v3\.6\.0/);
    assert.match(consoleOut, /Small Computer SC126 \[SCZ180_sc126_std\] Z8S180-N @ 18\.432MHz IO=0xC0/);
    assert.match(consoleOut, /512KB ROM, 512KB RAM/);
    assert.match(consoleOut, /ROM VERIFY: 00 00 00 00 PASS/);
    assert.match(consoleOut, /DSRTC: MODE=STD IO=0x0C/);
    assert.match(consoleOut, /SD0: SDHC NAME=SC126/);
    assert.match(consoleOut, /Boot \[H=Help\]:/);

    // Verify 8-bit Port 0x0D diagnostic LED bar progression during POST
    assert.ok(diagHistory.includes(0x03));
    assert.ok(diagHistory.includes(0x07));
    assert.ok(diagHistory.includes(0x0F));
    assert.ok(diagHistory.includes(0x1F));
    assert.ok(diagHistory.includes(0x3F));
    assert.ok(diagHistory.includes(0x7F));
    assert.ok(diagHistory.includes(0xFF));

    // Launch BASIC and write 0xAA (170) to Port 13 (0x0D)
    consoleOut = '';
    sc126.sendSerial(0, 'B\r\r');
    sc126.runCycles(20_000_000);
    assert.match(consoleOut, /Z80 BASIC Ver 4\.7b/);
    sc126.sendSerial(0, 'OUT 13, 170\r');
    sc126.runCycles(5_000_000);
    assert.equal(sc126.getLeds().diagByte, 0xAA);
  });

  test('Boots Small Computer Monitor S6 on SC126 and detects Diagnostic LEDs @ 0D', () => {
    let consoleOut = '';
    const sc126 = new SC126({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b);
      },
    });
    sc126.loadRom(scmBytes);
    sc126.reset();
    sc126.runCycles(15_000_000);
    assert.match(consoleOut, /Small Computer Monitor - SC126/);

    consoleOut = '';
    sc126.sendSerial(0, 'DEVICES\r');
    sc126.runCycles(8_000_000);
    assert.match(consoleOut, /Diagnostic LEDs\s+@ 0D\s+detected/);
  });

  test('Boots Fuzix 0.4 Unix OS (fuzix_sdcard.simg) on SC126 to root shell and executes uname -a', () => {
    let consoleOut = '';
    const sc126 = new SC126({
      onSerialTx: (ch, b) => {
        if (ch === 0) consoleOut += String.fromCharCode(b & 0x7F);
      },
    });
    sc126.loadRom(romwbw126Bytes);
    sc126.sdcard.loadSparseBundle(fuzixBundleBytes);
    sc126.reset();

    sc126.runCycles(35_000_000);
    assert.match(consoleOut, /Boot \[H=Help\]: /);

    consoleOut = '';
    sc126.sendSerial(0, '4\r');
    for (let i = 0; i < 40; i++) {
      sc126.runCycles(5_000_000);
      if (consoleOut.includes('bootdev: ')) break;
    }
    assert.match(consoleOut, /FUZIX version 0\.4/);
    assert.match(consoleOut, /DS1302 detected at 0x0C\./);
    assert.match(consoleOut, /bootdev: /);

    sc126.sendSerial(0, 'hda1\r');
    for (let i = 0; i < 20; i++) {
      sc126.runCycles(5_000_000);
      if (consoleOut.includes('login: ')) break;
    }
    assert.match(consoleOut, /Checking root file system\./);
    assert.match(consoleOut, /Welcome to Fuzix/);
    assert.match(consoleOut, /login: /);

    sc126.sendSerial(0, 'root\r');
    for (let i = 0; i < 20; i++) {
      sc126.runCycles(5_000_000);
      if (consoleOut.includes('# ')) break;
    }
    sc126.sendSerial(0, 'uname -a\r');
    sc126.runCycles(15_000_000);
    assert.match(consoleOut, /Fuzix 0\.4\s+rcbus-z180/);
  });
});


