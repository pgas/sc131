import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assemble } from '../src/emulator/assembler.js';
import { SCW_EXAMPLES } from '../src/emulator/scw_examples.js';
import { SimulatedZ80 } from '../src/emulator/sim_z80.js';
import { SC126 } from '../src/emulator/sc126.js';
import { SC131 } from '../src/emulator/sc131.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(__dirname, '../assets');
const scmBytes = new Uint8Array(fs.readFileSync(path.join(assetsDir, 'scm_s6.rom')));

describe('Execution Verification for all 10 SCWorkshop & SCMonitor Examples', () => {
  test('1. Count.asm (Simulated Z80): counts in register A and outputs to Port $00', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_count');
    const sim = new SimulatedZ80();
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);
    assert.equal(sim.cpu.pc, 0x0000);

    // Initial state
    assert.equal(sim.simLeds, 0);

    // Run 100 cycles
    sim.runCycles(100);
    // Register A and simLeds should have incremented
    assert.ok(sim.cpu.a > 0);
    assert.ok(sim.simLeds > 0);
    assert.equal(sim.getLeds().simLeds, sim.simLeds);
  });

  test('2. Ports.asm (Simulated Z80): mirrors toggle switches ($00) to output LEDs ($00)', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_ports');
    const sim = new SimulatedZ80();
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);

    // Set switches to 0xAA (10101010)
    sim.simSwitches = 0xAA;
    sim.runCycles(60);
    assert.equal(sim.simLeds, 0xAA);

    // Flip switches to 0x55 (01010101)
    sim.simSwitches = 0x55;
    sim.runCycles(60);
    assert.equal(sim.simLeds, 0x55);
  });

  test('3. Terminal.asm (Simulated Z80): prints welcome banner and echoes typed keys', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_terminal');
    let serialOutput = '';
    const sim = new SimulatedZ80({
      onSerialTx: (ch, byte) => {
        serialOutput += String.fromCharCode(byte & 0x7F);
      },
    });
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);

    // Run until full 84-character banner is printed (~4,000 cycles)
    sim.runCycles(8000);
    assert.ok(serialOutput.includes('SCWorkshop Simulated Z80 Terminal Ready!'));
    assert.ok(serialOutput.includes('Type keys in the terminal to echo them:'));

    // Now send a key 'Z' (ASCII 90 = 0x5A) into terminal
    serialOutput = '';
    sim.sendSerial(0, 'Z');
    sim.runCycles(1000);

    // Terminal.asm echoes key to Port $01 and Port $00
    assert.ok(serialOutput.includes('Z'));
    assert.equal(sim.simLeds, 0x5A); // ASCII 'Z'
  });

  test('4. Printer.asm (Simulated Z80): prints "Hello world" to line printer at Port $03', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_printer');
    let printerTextReceived = '';
    const sim = new SimulatedZ80({
      onPrinterOut: (b, text) => {
        printerTextReceived = text;
      },
    });
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);
    // 86 characters @ 58 cycles/char = ~5,000 cycles
    sim.runCycles(8000);

    assert.ok(sim.printerText.includes('Hello world from Small Computer Workshop!'));
    assert.ok(sim.printerText.includes('Z80 Line Printer Simulation on Port $03.'));
    assert.equal(printerTextReceived, sim.printerText);
    // Program should be in infinite loop at Done
    assert.equal(sim.cpu.pc, res.symbols.find((s) => s.name === 'Done').value);
  });

  test('5. Screen.asm (Simulated Z80): writes 3 rows to 2 KB memory-mapped video display ($4000)', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_screen');
    const sim = new SimulatedZ80();
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);
    // 188 characters @ 47 cycles/char = ~8,900 cycles
    sim.runCycles(15000);

    // Row 0 ($4000)
    let row0 = '';
    for (let i = 0; i < 50; i++) row0 += String.fromCharCode(sim.readPhysMem(0x4000 + i));
    assert.ok(row0.startsWith('*** SMALL COMPUTER WORKSHOP - MEMORY-MAPPED SCREEN'));

    // Row 2 ($4040)
    let row2 = '';
    for (let i = 0; i < 40; i++) row2 += String.fromCharCode(sim.readPhysMem(0x4040 + i));
    assert.ok(row2.startsWith('Hello world! Any write to $4000-$47FF'));

    // Row 4 ($4080)
    let row4 = '';
    for (let i = 0; i < 40; i++) row4 += String.fromCharCode(sim.readPhysMem(0x4080 + i));
    assert.ok(row4.startsWith('Designed by Stephen C. Cousins'));

    assert.equal(sim.screenDirty, true);
  });

  test('6. Interrupt.asm (Simulated Z80): services maskable interrupt in IM 1 and updates screen/printer', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_interrupt');
    let printerOutput = '';
    let serialOutput = '';
    const sim = new SimulatedZ80({
      onPrinterOut: (b, text) => { printerOutput = text; },
      onSerialTx: (ch, b) => { serialOutput += String.fromCharCode(b & 0x7F); },
    });
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    sim.loadAssembledProgram(res);

    // Run until foreground loop is counting with interrupts enabled
    sim.runCycles(200);
    assert.equal(sim.cpu.iff1, true);
    assert.equal(sim.cpu.im, 1);

    // Trigger interrupt #1
    sim.cpu.triggerInt0();
    sim.runCycles(200);

    // ISR should have written '0' to Screen ($4000), Printer, Serial, and incremented B to '1'
    assert.equal(String.fromCharCode(sim.readPhysMem(0x4000)), '0');
    assert.equal(printerOutput, '0');
    assert.equal(serialOutput, '0');
    assert.equal(sim.cpu.b, 0x31); // '1'

    // Trigger interrupt #2
    sim.cpu.triggerInt0();
    sim.runCycles(200);
    assert.equal(String.fromCharCode(sim.readPhysMem(0x4000)), '1');
    assert.equal(printerOutput, '01');
    assert.equal(serialOutput, '01');
    assert.equal(sim.cpu.b, 0x32); // '2'
  });

  test('7. SCM_LED_Light_Show.asm (SC126): executes Knight Rider scanner on Port $0D 8-LED bar', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    const board = new SC126();
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    board.loadAssembledProgram(res, { setPc: true });
    assert.equal(board.cpu.pc, 0x8000);

    // Run through initial LED shift instructions
    board.runCycles(300);
    // Port 0x0D diagnostic LEDs should have been lit
    assert.ok(board.diagLeds > 0);
    assert.equal(board.getLeds().diagByte, board.diagLeds);
  });

  test('8. SC131_Status_LED_Blink.asm (SC131): toggles Status LED1 (Port $0E) and outputs serial status', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'sc131_led1_blink');
    let serialText = '';
    const board = new SC131({
      onSerialTx: (ch, b) => {
        serialText += String.fromCharCode(b & 0x7F);
      },
    });
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    board.loadAssembledProgram(res, { setPc: true });
    assert.equal(board.cpu.pc, 0x8000);

    // Run first loop iteration and string print (~12,000 cycles)
    board.runCycles(12000);

    assert.ok(serialText.includes('SC131 Z180 Status LED1 (Port $0E) Blink Running...'));
    assert.ok(serialText.includes('LED1 = ON'));
    // Bit 2 of U5 latch should be 0 (LED ON)
    assert.equal(board.u5Latch[1], 0);
  });

  test('9. SCM_Idle_Timer_Demo.asm (SC126 on SCM S6): hooks SCM idle timer via RST $30 and returns to monitor', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_idle_timer');
    let sOut = '';
    const board = new SC126({
      onSerialTx: (ch, b) => {
        sOut += String.fromCharCode(b & 0x7F);
      },
    });

    // Boot Small Computer Monitor S6
    board.loadRom(scmBytes);
    board.reset();

    // SCM S6 boots and performs memory test (~15M cycles)
    board.runCycles(15_000_000);
    assert.ok(sOut.includes('*'), 'SCM S6 booted to prompt');

    // Assemble and load the idle timer demo into RAM at $8000
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    board.loadAssembledProgram(res, { setPc: false });

    // Execute via SCM command 'g 8000'
    sOut = '';
    board.sendSerial(0, 'g 8000\r');
    board.runCycles(2_000_000);

    // SCM S6 should have executed Start, called SCM API RST 30h, and returned to prompt
    assert.ok(sOut.includes('g 8000'));
    assert.ok(sOut.includes('*'));
  });

  test('10. Z180_Hardware_Multiply.asm (SC126): computes 1..12 multiplication table using Z180 MLT instruction', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'z180_mlt_demo');
    const board = new SC126();
    const res = assemble(ex.source);
    assert.equal(res.ok, true);

    board.loadAssembledProgram(res, { setPc: true });
    assert.equal(board.cpu.pc, 0x8000);

    // Run all 12 iterations (~8,000 cycles)
    board.runCycles(8000);

    // Verify multiplication table at $8100: D * 12 for D=1..12
    for (let d = 1; d <= 12; d++) {
      const addr = 0x8100 + (d - 1) * 2;
      const lo = board.cpu.memRead(addr);
      const hi = board.cpu.memRead(addr + 1);
      const product = lo | (hi << 8);
      assert.equal(product, d * 12, `Product for ${d} * 12 must be ${d * 12}`);
    }

    // Port 0x0D diagnostic LEDs show last product (12 * 12 = 144 = 0x90)
    assert.equal(board.diagLeds, 144);
  });
});
