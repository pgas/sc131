/**
 * Bundled Small Computer Workshop (SCW) & Small Computer Monitor (SCM) Assembly Examples
 * Based on Stephen C. Cousins' official SCWorkshop v0.3.9 & SCMonitor v1.3.1 example suite.
 */

export const SCW_EXAMPLES = [
  {
    id: 'scw_count',
    category: 'Simulated Z80 (SCW)',
    name: 'Count.asm',
    title: 'Count — Simple 8-Bit Register Counter',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'walk',
    description: 'Counts up in register A at $0000. Ideal for testing Step, Walk, and Simulation Trace.',
    source: `; **********************************************************************
; **  Simple counter example                    by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Walk
; Counts in register A and outputs to Port $00 (Simulated LEDs).

            #TARGET     Simulated_Z80
            .ORG        0000h

            LD   A, 0           ; Clear register A
Loop:       OUT  (00h), A       ; Show count on Simulated Output Port $00
            INC  A              ; Increment A
            JP   Loop           ; Repeat forever

            .END
`,
  },
  {
    id: 'scw_ports',
    category: 'Simulated Z80 (SCW)',
    name: 'Ports.asm',
    title: 'Ports — Read Input Switches ($00) to Output LEDs ($00)',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'walk',
    description: 'Reads Simulated Input Port $00 (8 toggle switches) and writes to Output Port $00 (8 LEDs).',
    source: `; **********************************************************************
; **  Port I/O example                          by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Walk or Jog
; Toggle the 8 Input Switches (Port $00) in the Right Hardware Sidebar
; to see them mirrored onto the 8 Output LEDs!

            #TARGET     Simulated_Z80
            .ORG        0000h

Loop:       IN   A, (00h)       ; Read input port $00 (switches)
            OUT  (00h), A       ; Write to output port $00 (LEDs)
            JP   Loop           ; Repeat continuously

            .END
`,
  },
  {
    id: 'scw_terminal',
    category: 'Simulated Z80 (SCW)',
    name: 'Terminal.asm',
    title: 'Terminal — Echo Keys on Simulated Terminal ($01/$02)',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'jog',
    description: 'Prints a greeting to Terminal Output Port $01 and echoes keys typed into Terminal Input Port $02.',
    source: `; **********************************************************************
; **  Terminal I/O example                      by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Jog or Run
; Uses Simulated Terminal Output (Port $01) and Input (Port $02).

            #TARGET     Simulated_Z80
            .ORG        0000h

TermOut:    .EQU 01h            ; Terminal output port
TermIn:     .EQU 02h            ; Terminal input port

            LD   HL, Banner     ; Point to welcome banner
PrintLoop:  LD   A, (HL)        ; Get character from string
            OR   A              ; Null terminator?
            JR   Z, EchoLoop    ; Yes -> start keyboard echo loop
            OUT  (TermOut), A   ; Output character to terminal
            INC  HL             ; Advance pointer
            JR   PrintLoop

EchoLoop:   IN   A, (TermIn)    ; Read character from terminal keyboard
            OR   A              ; Was a key pressed (non-zero)?
            JR   Z, EchoLoop    ; No -> keep polling
            OUT  (TermOut), A   ; Echo character to terminal
            OUT  (00h), A       ; Also show ASCII code on Port $00 LEDs
            JR   EchoLoop       ; Repeat forever

Banner:     .DB  "SCWorkshop Simulated Z80 Terminal Ready!", 0Dh, 0Ah
            .DB  "Type keys in the terminal to echo them:", 0Dh, 0Ah, 0

            .END
`,
  },
  {
    id: 'scw_printer',
    category: 'Simulated Z80 (SCW)',
    name: 'Printer.asm',
    title: 'Printer — Hello World to Simulated Line Printer ($03)',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'walk',
    description: 'Outputs "Hello world" to the Simulated Line Printer at Port $03.',
    source: `; **********************************************************************
; **  Printer output example                    by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Walk
; Open the "Simulated Printer" tab to view the printed paper output.

            #TARGET     Simulated_Z80
            .ORG        0000h

PrintOut:   .EQU 3              ; Printer output port

            LD   HL, Text       ; Point to start of text
Loop:       LD   A, (HL)        ; Get character from text string
            OR   A              ; Null terminator?
            JR   Z, Done        ; Yes, so we're finished
            OUT  (PrintOut), A  ; Output character to printer (Port $03)
            OUT  (01h), A       ; Also mirror to serial terminal
            INC  HL             ; Point to next character
            JR   Loop           ; Loop back for next character

Done:       JR   Done           ; Endless loop when complete

Text:       .DB  "Hello world from Small Computer Workshop!", 0Dh, 0Ah
            .DB  "Z80 Line Printer Simulation on Port $03.", 0Dh, 0Ah, 0

            .END
`,
  },
  {
    id: 'scw_screen',
    category: 'Simulated Z80 (SCW)',
    name: 'Screen.asm',
    title: 'Screen — Memory-Mapped Video Display ($4000–$47FF)',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'walk',
    description: 'Writes text directly to the 2 KB Memory-Mapped Character Display at $4000–$47FF (64x32).',
    source: `; **********************************************************************
; **  Memory-mapped screen example              by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Walk or Jog
; Writes directly to the Simulated Screen RAM at $4000-$47FF (64 cols x 32 rows).

            #TARGET     Simulated_Z80
            .ORG        0000h

Screen:     .EQU 4000h          ; Start of memory-mapped character screen
Row2:       .EQU 4040h          ; Second row (64 characters per row)
Row4:       .EQU 4080h          ; Fourth row

            LD   HL, Text1      ; Copy Line 1 to row 0 ($4000)
            LD   DE, Screen
            CALL CopyStr

            LD   HL, Text2      ; Copy Line 2 to row 2 ($4040)
            LD   DE, Row2
            CALL CopyStr

            LD   HL, Text3      ; Copy Line 3 to row 4 ($4080)
            LD   DE, Row4
            CALL CopyStr

Done:       JP   Done           ; Endless loop

CopyStr:    LD   A, (HL)        ; Get character from string
            OR   A              ; Null terminator?
            RET  Z              ; Return when done
            LD   (DE), A        ; Write character to video RAM
            INC  HL
            INC  DE
            JR   CopyStr

Text1:      .DB  "*** SMALL COMPUTER WORKSHOP - MEMORY-MAPPED SCREEN ($4000) ***", 0
Text2:      .DB  "Hello world! Any write to $4000-$47FF updates this 64x32 CRT.", 0
Text3:      .DB  "Designed by Stephen C. Cousins (Small Computer Central).", 0

            .END
`,
  },
  {
    id: 'scw_interrupt',
    category: 'Simulated Z80 (SCW)',
    name: 'Interrupt.asm',
    title: 'Interrupt — IM 1 Interrupt Handler ($0038)',
    machine: 'sim_z80',
    origin: 0x0000,
    recommendedMode: 'jog',
    description: 'Demonstrates Z80 Interrupt Mode 1 (RST $38). Click the "Interrupt" button in the toolbar to fire!',
    source: `; **********************************************************************
; **  Interrupt Mode 1 example                  by Stephen C Cousins  **
; **********************************************************************
; Recommended simulation speed: Jog
; Click the "Interrupt (INT0)" button in the top toolbar while running:
; Each interrupt increments B and updates the Simulated Screen ($4000) & Printer ($03).

            #TARGET     Simulated_Z80

            .ORG 0000h          ; Reset vector
            JP   Start          ; Jump over vectors

            .ORG 0038h          ; Interrupt Mode 1 vector ($0038)
            JP   IntSub         ; Jump to interrupt handler

            .ORG 0100h          ; Main program
Start:      LD   SP, 8000h      ; Set up stack pointer
            LD   A, 0           ; Zero foreground counter
            LD   B, '0'         ; Initialize interrupt ASCII counter
            IM   1              ; Select Interrupt Mode 1 (vector $0038)
            EI                  ; Enable interrupts

Loop:       INC  A              ; Increment foreground counter
            OUT  (00h), A       ; Show activity on Port $00 LEDs
            JP   Loop           ; Foreground loop

; Interrupt service routine (triggered by Interrupt button)
IntSub:     PUSH AF             ; Preserve AF
            LD   A, B           ; Get interrupt counter character
            LD   (4000h), A     ; Write to top-left of Simulated Screen ($4000)
            OUT  (03h), A       ; Write to Simulated Printer (Port $03)
            OUT  (01h), A       ; Write to Serial Terminal (Port $01)
            INC  B              ; Next ASCII character
            POP  AF             ; Restore AF
            EI                  ; Re-enable interrupts
            RETI                ; Return from interrupt

            .END
`,
  },
  {
    id: 'scm_led_show',
    category: 'SCMonitor / SC126 / SC131',
    name: 'SCM_LED_Light_Show.asm',
    title: 'SC126 / RC2014 — 8-LED Light Show (Port $0D / $00)',
    machine: 'sc126',
    origin: 0x8000,
    recommendedMode: 'run',
    description: 'Knight Rider scanner & binary counter on the SC126 8-LED diagnostic bar (Port $0D) at $8000.',
    source: `; **********************************************************************
; **  SC126 / SCMonitor LED Light Show          by Stephen C Cousins  **
; **********************************************************************
; Assembles at $8000 in RAM. Writes patterns to SC126 Port $0D (8-LED bar)
; and Port $00 (Simulated I/O LEDs). Press any key in SCM to exit.

            #TARGET     SC126
            .PROC       Z180
            .ORG        8000h

DiagPort:   .EQU 0Dh            ; SC126 motherboard 8-LED bar port

Start:      LD   B, 3           ; Repeat scanner 3 times
ScanLoop:   LD   A, 01h         ; Start at bit 0 (L0)
ShiftLeft:  OUT  (DiagPort), A  ; Update SC126 8-LED bar
            OUT  (00h), A       ; Also update Simulated Port $00 LEDs
            CALL Delay
            RLCA                ; Shift LED left
            JR   NC, ShiftLeft

            LD   A, 40h         ; Shift back right from L6 to L1
ShiftRight: OUT  (DiagPort), A
            OUT  (00h), A
            CALL Delay
            RRCA
            CP   01h
            JR   NZ, ShiftRight
            DJNZ ScanLoop

            ; Binary count 00h..FFh on LEDs
            LD   A, 00h
CountLoop:  OUT  (DiagPort), A
            OUT  (00h), A
            CALL ShortDelay
            INC  A
            JR   NZ, CountLoop

            JR   Start          ; Repeat show

Delay:      PUSH BC
            LD   BC, 6000h
@Loop:      DEC  BC
            LD   A, B
            OR   C
            JR   NZ, @Loop
            POP  BC
            RET

ShortDelay: PUSH BC
            LD   BC, 1800h
@Loop:      DEC  BC
            LD   A, B
            OR   C
            JR   NZ, @Loop
            POP  BC
            RET

            .END
`,
  },
  {
    id: 'sc131_led1_blink',
    category: 'SCMonitor / SC126 / SC131',
    name: 'SC131_Status_LED_Blink.asm',
    title: 'SC131 — Status LED1 Blink & Serial Message ($8000)',
    machine: 'sc131',
    origin: 0x8000,
    recommendedMode: 'run',
    description: 'Toggles the SC131 Orange Status LED1 (Port $0E bit 2, active low) and prints status via Z180 ASCI0.',
    source: `; **********************************************************************
; **  SC131 Pocket Computer Status LED1 Blink   by Stephen C Cousins  **
; **********************************************************************
; Assembles at $8000 in RAM. Controls SC131 U5 (74HCT259) Status LED1
; on Port $0E (Bit 2: 0 = LED ON, 1 = LED OFF).

            #TARGET     SC131
            .PROC       Z180
            .ORG        8000h

LedPort:    .EQU 0Eh            ; SC131 Status LED1 latch port
STAT0:      .EQU 04h            ; Z180 ASCI0 Status Register
TDR0:       .EQU 06h            ; Z180 ASCI0 Transmit Data Register

Start:      LD   HL, MsgStart
            CALL PrintStr

BlinkLoop:  ; Turn Orange Status LED1 ON (Bit 2 = 0)
            LD   A, 00h
            OUT  (LedPort), A
            OUT  (00h), A
            LD   HL, MsgOn
            CALL PrintStr
            CALL Delay

            ; Turn Orange Status LED1 OFF (Bit 2 = 1 -> 04h)
            LD   A, 04h
            OUT  (LedPort), A
            OUT  (00h), A
            LD   HL, MsgOff
            CALL PrintStr
            CALL Delay

            JR   BlinkLoop

; Print null-terminated string at HL to Z180 ASCI0
PrintStr:   LD   A, (HL)
            OR   A
            RET  Z
@WaitTx:    IN0  B, (STAT0)     ; Read Z180 STAT0 (or if ICR=C0h, also works in SCM/RomWBW)
            OUT0 (TDR0), A      ; Transmit byte on Z180 ASCI0
            OUT  (01h), A       ; Also send to Simulated Terminal port
            INC  HL
            JR   PrintStr

Delay:      LD   DE, 0004h
@Outer:     LD   BC, 0FFFFh
@Inner:     DEC  BC
            LD   A, B
            OR   C
            JR   NZ, @Inner
            DEC  DE
            LD   A, D
            OR   E
            JR   NZ, @Outer
            RET

MsgStart:   .DB  0Dh, 0Ah, "SC131 Z180 Status LED1 (Port $0E) Blink Running...", 0Dh, 0Ah, 0
MsgOn:      .DB  "  LED1 = ON  (OUT $0E, $00)", 0Dh, 0Ah, 0
MsgOff:     .DB  "  LED1 = OFF (OUT $0E, $04)", 0Dh, 0Ah, 0

            .END
`,
  },
  {
    id: 'scm_idle_timer',
    category: 'SCMonitor / SC126 / SC131',
    name: 'SCM_Idle_Timer_Demo.asm',
    title: 'SCMonitor — Background Flasher via SCM API ($8000)',
    machine: 'sc126',
    origin: 0x8000,
    recommendedMode: 'run',
    description: 'Uses Small Computer Monitor S6 API (RST $30) to hook the idle timer and flash LEDs in the background!',
    source: `; **********************************************************************
; **  Idle Timer Demo v2.0                      by Stephen C Cousins  **
; **********************************************************************
; Requires Small Computer Monitor (SCM S6) running in ROM.
; Sets up a background 1 Hz toggle on the diagnostic LEDs using SCM's
; RST $30 API and returns cleanly to the '*' monitor prompt!

            #TARGET     SC126
            .PROC       Z180
            .ORG        8000h

Start:      LD   DE, Poll       ; Address of our background polling event
            LD   C, 13h         ; SCM API 0x13 = Claim/set idle handler
            RST  30h            ; Call Small Computer Monitor API
            LD   A, 100         ; Delay = 100 x 10ms (1 second)
            LD   C, 12h         ; SCM API 0x12 = Set idle timer1
            RST  30h            ; Call Small Computer Monitor API
            RET                 ; Return to SCM '*' prompt!

; Background event polled by Small Computer Monitor while waiting for keys:
Poll:       LD   C, 12h         ; SCM API 0x12 = Read/check idle timer1
            RST  30h            ; Returns NZ when timer expires
            RET  Z              ; Not expired yet -> return
            LD   A, (State)     ; Get current LED pattern
            XOR  0FFh           ; Invert all 8 LEDs
            LD   (State), A     ; Save state
            OUT  (0Dh), A       ; Output to SC126 Port $0D LEDs
            OUT  (00h), A       ; Output to Port $00 LEDs
            LD   A, 50          ; Reload timer = 50 x 10ms (500ms)
            LD   C, 12h         ; SCM API 0x12 = Set idle timer1
            RST  30h
            RET

State:      .DB  55h            ; Alternating LED pattern

            .END
`,
  },
  {
    id: 'z180_mlt_demo',
    category: 'SCMonitor / SC126 / SC131',
    name: 'Z180_Hardware_Multiply.asm',
    title: 'Z180 — Hardware 8x8 Multiply (MLT) & Screen Table',
    machine: 'sc126',
    origin: 0x8000,
    recommendedMode: 'walk',
    description: 'Demonstrates the Z180 hardware MLT BC / MLT DE / MLT HL instructions and writes a multiplication table.',
    source: `; **********************************************************************
; **  Z180 Hardware Multiply (MLT) Demo         Small Computer Central **
; **********************************************************************
; Demonstrates the Z180-exclusive MLT instruction (8-bit x 8-bit -> 16-bit
; in 17 T-states) and writes products to memory at $8100 and Port $0D.

            #TARGET     SC126
            .PROC       Z180
            .ORG        8000h

TableDest:  .EQU 8100h          ; Store results at $8100

Start:      LD   IX, TableDest
            LD   D, 1           ; Multiplier D = 1..12
Loop:       LD   B, D
            LD   C, 12          ; Compute B * 12 using Z180 hardware MLT
            MLT  BC             ; BC = B * C (single 2-byte Z180 instruction!)
            LD   A, C           ; Low byte of product
            OUT  (0Dh), A       ; Show product on SC126 8-LED bar
            OUT  (00h), A       ; Show product on Simulated Port $00
            LD   (IX+0), C      ; Store low byte in table
            LD   (IX+1), B      ; Store high byte in table
            INC  IX
            INC  IX
            INC  D
            LD   A, D
            CP   13
            JR   C, Loop

Done:       JR   Done           ; Complete! Table is at $8100, last product on LEDs

            .END
`,
  },
];
