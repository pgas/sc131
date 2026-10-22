import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { assemble, evaluateExpression } from '../src/emulator/assembler.js';
import { SCW_EXAMPLES } from '../src/emulator/scw_examples.js';
import { SimulatedZ80 } from '../src/emulator/sim_z80.js';

describe('Small Computer Workshop (SCW) Assembler & Simulator', () => {
  test('Expression evaluation supports numbers, operators, chars, and unary HIGH/LOW', () => {
    const syms = new Map([
      ['BASE', 0x8000],
      ['OFFSET', 0x0020],
    ]);
    assert.equal(evaluateExpression('10 + 20 * 2', syms, 0, 'GLOBAL', 2), 50);
    assert.equal(evaluateExpression('0x1000 + 0x0020', syms, 0, 'GLOBAL', 2), 0x1020);
    assert.equal(evaluateExpression('$8000 + $20', syms, 0, 'GLOBAL', 2), 0x8020);
    assert.equal(evaluateExpression('0FFh', syms, 0, 'GLOBAL', 2), 0xFF);
    assert.equal(evaluateExpression('%10101010', syms, 0, 'GLOBAL', 2), 0xAA);
    assert.equal(evaluateExpression('0b11000011', syms, 0, 'GLOBAL', 2), 0xC3);
    assert.equal(evaluateExpression("'A'", syms, 0, 'GLOBAL', 2), 65);
    assert.equal(evaluateExpression('HIGH(BASE)', syms, 0, 'GLOBAL', 2), 0x80);
    assert.equal(evaluateExpression('LOW(BASE)', syms, 0, 'GLOBAL', 2), 0x00);
    assert.equal(evaluateExpression('BASE + OFFSET', syms, 0, 'GLOBAL', 2), 0x8020);
    assert.equal(evaluateExpression('1 << 4', syms, 0, 'GLOBAL', 2), 16);
  });

  test('Assembles Count.asm and produces accurate Intel HEX and listing', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_count');
    assert.ok(ex);
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.origin, 0x0000);
    assert.equal(res.byteCount, 8); // LD A,0 (2) + OUT (00h),A (2) + INC A (1) + JP Loop (3) = 8 bytes
    assert.ok(res.intelHex.includes(':08000000'));
    assert.ok(res.listingText.includes('0000: 3E 00'));
    assert.ok(res.symbols.some((s) => s.name === 'Loop' && s.value === 0x0002));
  });

  test('Assembles Screen.asm ($4000 memory-mapped video RAM)', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_screen');
    assert.ok(ex);
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.origin, 0x0000);
    assert.ok(res.symbols.some((s) => s.name === 'Screen' && s.value === 0x4000));
    assert.ok(res.symbols.some((s) => s.name === 'Row2' && s.value === 0x4040));
  });

  test('Assembles Interrupt.asm with IM 1 and RST 0x38 vector', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_interrupt');
    assert.ok(ex);
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.ok(res.symbols.some((s) => s.name === 'IntSub' && s.value > 0x0100));
  });

  test('Assembles SCM_LED_Light_Show.asm with local @labels', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    assert.ok(ex);
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.origin, 0x8000);
    assert.ok(res.symbols.some((s) => s.name.includes('@Loop')));
  });

  test('Assembles Z180_Hardware_Multiply.asm with MLT instruction', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'z180_mlt_demo');
    assert.ok(ex);
    const res = assemble(ex.source);
    assert.equal(res.ok, true);
    assert.equal(res.errors.length, 0);
    assert.equal(res.origin, 0x8000);
    // MLT BC opcode is ED 4C
    const mltSeg = res.segments.find((s) => s.bytes.includes(0xED) && s.bytes.includes(0x4C));
    assert.ok(mltSeg);
  });

  test('SimulatedZ80 executes Count.asm and drives Output Port $00 LEDs', () => {
    const sim = new SimulatedZ80();
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_count');
    const res = assemble(ex.source);
    sim.loadAssembledProgram(res);

    assert.equal(sim.cpu.pc, 0x0000);
    // Run for 50 cycles so it loops and outputs count 1
    sim.runCycles(50);
    assert.ok(sim.simLeds > 0);
    assert.equal(sim.getLeds().simLeds, sim.simLeds);
  });

  test('SimulatedZ80 reads Port $00 toggle switches to Output LEDs (Ports.asm)', () => {
    const sim = new SimulatedZ80();
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_ports');
    const res = assemble(ex.source);
    sim.loadAssembledProgram(res);

    sim.simSwitches = 0x5A; // Set toggle switches to 01011010
    sim.runCycles(50);
    assert.equal(sim.simLeds, 0x5A);

    sim.simSwitches = 0xC3; // Flip switches
    sim.runCycles(50);
    assert.equal(sim.simLeds, 0xC3);
  });

  test('SimulatedZ80 updates Memory-Mapped Screen ($4000-$47FF) and Line Printer ($03)', () => {
    let printerOutput = '';
    const sim = new SimulatedZ80({
      onPrinterOut: (b, text) => {
        printerOutput = text;
      },
    });

    // Write directly to Screen RAM ($4000)
    sim.writePhysMem(0x4000, 0x48); // 'H'
    sim.writePhysMem(0x4001, 0x49); // 'I'
    assert.equal(sim.readPhysMem(0x4000), 0x48);
    assert.equal(sim.readPhysMem(0x4001), 0x49);
    assert.equal(sim.screenDirty, true);

    // Write to Line Printer Port $03
    sim.writeExtIO(0x03, 0x4F); // 'O'
    sim.writeExtIO(0x03, 0x4B); // 'K'
    sim.writeExtIO(0x03, 0x0A); // '\n'
    assert.equal(sim.printerText, 'OK\n');
    assert.equal(printerOutput, 'OK\n');
  });

  test('SimulatedZ80 handles hardware Interrupt button in IM 1', () => {
    const sim = new SimulatedZ80();
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scw_interrupt');
    const res = assemble(ex.source);
    sim.loadAssembledProgram(res);

    // Run until interrupts are enabled in foreground loop
    sim.runCycles(200);
    assert.equal(sim.cpu.iff1, true);
    assert.equal(sim.cpu.im, 1);

    // Fire interrupt
    sim.cpu.triggerInt0();
    assert.equal(sim.cpu.int0Line, true);

    // Run cycles to service interrupt (jumps to $0038 then IntSub)
    sim.runCycles(150);
    // IntSub writes counter '0' (0x30) to Screen $4000 and increments B
    assert.equal(sim.readPhysMem(0x4000), 0x30); // '0'
    assert.equal(sim.cpu.b, 0x31); // '1'
  });
});
