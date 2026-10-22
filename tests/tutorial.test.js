import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { SC126 } from '../src/emulator/sc126.js';
import { assemble } from '../src/emulator/assembler.js';
import { SCW_EXAMPLES } from '../src/emulator/scw_examples.js';
import { disassembleOne } from '../src/emulator/disasm.js';

describe('Small Computer Workshop Interactive Tutorial & LED Walkthrough Verification', () => {
  test('Step 1 & 2: Assembles SCM_LED_Light_Show.asm with .PROC Z180 and .ORG 8000h', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    assert.ok(ex, 'SCM_LED_Light_Show.asm example must exist');

    const res = assemble(ex.source);
    assert.equal(res.ok, true, 'Assembly must succeed with 0 errors');
    assert.equal(res.origin, 0x8000, 'Origin address must be $8000');
    assert.ok(res.byteCount > 20, 'Binary byte count must be greater than 20 bytes');
    assert.ok(res.listingText.includes('8000: 06 03'), 'Listing.txt must include $8000 address');
    assert.ok(res.intelHex.startsWith(':'), 'IntelHex.hex must start with standard colon prefix');
  });

  test('Step 3: Loads program into SC126 RAM at $8000 and executes initial instructions', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    const board = new SC126();
    const res = assemble(ex.source);

    board.loadAssembledProgram(res, { setPc: true });
    assert.equal(board.cpu.pc, 0x8000, 'PC must be initialized to origin $8000');

    // Instruction 1: LD B, 3 (06 03)
    board.cpu.step();
    assert.equal(board.cpu.b, 3, 'Register B must be 3');
    assert.equal(board.cpu.pc, 0x8002, 'PC must advance to $8002');

    // Instruction 2: LD A, 01h (3E 01)
    board.cpu.step();
    assert.equal(board.cpu.a, 0x01, 'Register A must be $01');
    assert.equal(board.cpu.pc, 0x8004, 'PC must advance to $8004');

    // Instruction 3: OUT (DiagPort), A (D3 0D)
    board.cpu.step();
    assert.equal(board.diagLeds, 0x01, 'Port $0D 8-LED bar must have bit 0 lit (0x01)');
  });

  test('Step 4: Records Instruction Trace with PC, Mnemonic, and Register telemetry', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    const board = new SC126();
    const res = assemble(ex.source);
    board.loadAssembledProgram(res, { setPc: true });

    const traceEntries = [];
    for (let step = 1; step <= 8; step++) {
      const pc = board.cpu.pc;
      const readFn = (addr) => board.cpu.memRead(addr);
      const disasm = disassembleOne(readFn, pc);
      const st = board.cpu.getState();

      traceEntries.push({
        step,
        pc,
        mnemonic: disasm.mnemonic,
        bytes: disasm.bytes,
        af: st.af,
        bc: st.bc,
        de: st.de,
        hl: st.hl,
      });

      board.cpu.step();
    }

    assert.equal(traceEntries.length, 8, 'Must record 8 trace steps');
    assert.equal(traceEntries[0].pc, 0x8000);
    assert.ok(traceEntries[0].mnemonic.includes('LD B,'));
    assert.equal(traceEntries[1].pc, 0x8002);
    assert.ok(traceEntries[1].mnemonic.includes('LD A,'));
    assert.equal(traceEntries[2].pc, 0x8004);
    assert.ok(traceEntries[2].mnemonic.includes('OUT ($0D),A') || traceEntries[2].mnemonic.includes('OUT (0Dh),A'));
  });

  test('Step 5: Disassembler decodes instructions accurately from $8000 and supports breakpoints', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    const board = new SC126();
    const res = assemble(ex.source);
    board.loadAssembledProgram(res, { setPc: true });

    const readFn = (addr) => board.cpu.memRead(addr);
    const d1 = disassembleOne(readFn, 0x8000);
    assert.ok(d1.mnemonic.includes('LD B,'));
    assert.equal(d1.length, 2);

    const d2 = disassembleOne(readFn, 0x8000 + d1.length);
    assert.ok(d2.mnemonic.includes('LD A,'));

    // Test breakpoint halting
    board.breakpoints = new Set([0x8004]);
    const { breakpointHit } = board.runCycles(500);
    assert.equal(breakpointHit, true, 'CPU must halt on breakpoint at $8004');
    assert.equal(board.cpu.pc, 0x8004, 'PC must be halted at $8004');
  });

  test('Step 6: Memory viewer reads raw SRAM bytes at $8000-$8020 accurately', () => {
    const ex = SCW_EXAMPLES.find((e) => e.id === 'scm_led_show');
    const board = new SC126();
    const res = assemble(ex.source);
    board.loadAssembledProgram(res, { setPc: true });

    // Inspect first 6 bytes: 06 03 3E 01 D3 0D
    const b0 = board.cpu.memRead(0x8000);
    const b1 = board.cpu.memRead(0x8001);
    const b2 = board.cpu.memRead(0x8002);
    const b3 = board.cpu.memRead(0x8003);
    const b4 = board.cpu.memRead(0x8004);
    const b5 = board.cpu.memRead(0x8005);

    assert.equal(b0, 0x06, 'Byte 0 must be 0x06 (LD B, n)');
    assert.equal(b1, 0x03, 'Byte 1 must be 0x03');
    assert.equal(b2, 0x3E, 'Byte 2 must be 0x3E (LD A, n)');
    assert.equal(b3, 0x01, 'Byte 3 must be 0x01');
    assert.equal(b4, 0xD3, 'Byte 4 must be 0xD3 (OUT (n), A)');
    assert.equal(b5, 0x0D, 'Byte 5 must be 0x0D (Port $0D)');
  });
});
