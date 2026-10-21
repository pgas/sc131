# SC131 — Z180 Pocket Computer JavaScript Emulator

A cycle-accurate, zero-dependency JavaScript hardware emulator for Stephen C. Cousins' **[SC131 Z180 Pocket Computer](https://smallcomputercentral.com/sc131-z180-pocket-computer/)** (*Small Computer Central*).

**Live Demo:** **[https://pgas.github.io/sc131/](https://pgas.github.io/sc131/)**

---

## Hardware Architecture Emulated

The emulator faithfully models the SC131 v1.0 printed circuit board and its integrated circuits:

| Component | Part | Function in SC131 |
| :--- | :--- | :--- |
| **U1** | `SST39SF040` / `W27E040` | **512 KB Flash ROM** mapped at physical `0x00000–0x7FFFF` (`A19 = 0`). Includes `JP1` write-protect jumper. |
| **U2** | `AS6C4008-55PCN` | **512 KB Static RAM** mapped at physical `0x80000–0xFFFFF` (`A19 = 1`). |
| **U3** | `74HCT139N` | Dual 2-to-4 decoder for memory chip-selects (`A19`, `/MREQ`) and I/O port decoding (`0x0C` & `0x0E`). |
| **U4** | `Z8S18020VSC` (Rev. N) | **Zilog Z8S180 CPU @ 18.432 MHz** (`X1` oscillator): full Z80 + Z180 instruction set (`MLT`, `IN0`, `OUT0`, `TST`, `TSTIO`, `OTIM`, `OTIMR`, `OTDM`, `OTDMR`, `SLP`), 1 MB MMU (`CBR`, `BBR`, `CBAR`), Dual ASCI (`ASCI0` & `ASCI1`) with programmable Baud Rate Generators, Dual 16-bit Programmable Reload Timers (`PRT0` & `PRT1`), `DMA0`, and Clocked Serial I/O (`CSI/O`) SPI master. |
| **U5** | `74HCT259N` | **8-bit Addressable Latch** at I/O ports `0x0C` (`12`) and `0x0E` (`14`):<br>• **Port `0x0C` (Q4)**: MicroSD SPI `/CS` (Bit 2, active low; high at reset)<br>• **Port `0x0E` (Q6)**: Orange Status `LED1` (Bit 2, active low; **ON** at reset) |
| **U6** | `LM1117-3.3` | 3.3 V LDO regulator powering the MicroSD card socket (`J1`) with `R1`–`R5` 5 V ↔ 3.3 V level shifting. |
| **U7** | `DS1233-5+` | **EconoReset Voltage Supervisor**: monitors `VCC` and asserts `/RESET` when supply voltage drops below `4.7 V` or when the rear-panel recessed reset switch (`SW1`) is pressed. |
| **J1** | MicroSDHC Socket | Full SPI mode 0 SDHC controller coupled to Z180 `CSI/O` (`CNTR` `0xCA` / `TRDR` `0xCB`) with hardware LSB-first bit ordering, supporting `CMD0`, `CMD8`, `CMD9`, `CMD10`, `CMD16`, `CMD17` (Read Block), `CMD24` (Write Block), `CMD55`, `CMD58`, `ACMD41`, and `ACMD51`. |

---

## Bundled Official Firmware & 8-Slice SDHC Image

The emulator ships with the unmodified official firmware and software distribution for the SC131:

1. **RomWBW v3.6.0 (`SCZ180_sc131_std.rom`, 512 KB)** — Wayne Warthen's RomWBW HBIOS v3.6.0 built specifically for the SC131, including ROM disk (`MD0`) and RAM disk (`MD1`), plus built-in ROM applications (`CP/M 2.2`, `Z-System`, `Forth`, `Microsoft BASIC`, `Tasteful BASIC`, `System Monitor`, `flash`).
2. **Small Computer Monitor S6 (`scm_s6.rom`, 32 KB)** — Stephen C. Cousins' standalone machine-code monitor for the SC131 (`S6` configuration).
3. **Pre-populated 8-Slice MicroSDHC Card (`assets/sc131_sdcard.simg`)** — Contains 8 bootable RomWBW v3.6.0 hard disk slices:
   - `2.0` (`SD0:0` / Drive `A:`): **CP/M 2.2** (`BBCBASIC`, `MBASIC`, `ASM`, `DDT`, `STAT`, `PIP`, `ED`, `SURVEY`, `XM`, etc.)
   - `2.1` (`SD0:1` / Drive `D:`): **ZSDOS 1.1 (Z-System)**
   - `2.2` (`SD0:2` / Drive `E:`): **CP/M 3.0 (CP/M Plus)**
   - `2.3` (`SD0:3` / Drive `F:`): **Classic Infocom & Text Games** (`Zork I–III`, `Hitchhiker's Guide`, `Colossal Cave Adventure`, `Ladder`, `Catchum`)
   - `2.4` (`SD0:4` / Drive `G:`): **WordStar 4.0**
   - `2.5` (`SD0:5` / Drive `H:`): **Borland Turbo Pascal 3.01A**
   - `2.6` (`SD0:6` / Drive `I:`): **Microsoft BASIC (`MBASIC`) & Games (`STARTREK.BAS`, `HAMURABI.BAS`, `LUNAR.BAS`)**
   - `2.7` (`SD0:7` / Drive `J:`): **Hi-Tech C Compiler v3.09**

---

## Quick Start Examples in the Emulator

- **Boot CP/M 2.2 from MicroSDHC:** At the `Boot [H=Help]:` prompt, type `2.0` (or `d` for default) and press **Enter** (or click the **CP/M 2.2 (SD0.0)** shortcut chip).
- **List all SD card OS slices:** Type `S` at the `Boot [H=Help]:` prompt.
- **Control the Orange Status LED (`LED1`) from Microsoft BASIC:**
  1. At the `Boot [H=Help]:` prompt, type `b` and press **Enter** twice.
  2. Turn Status LED1 **OFF**:
     ```basic
     OUT 14, 255
     ```
  3. Turn Status LED1 **ON**:
     ```basic
     OUT 14, 0
     ```
  4. Blink LED1 in a loop:
     ```basic
     10 OUT 14, 255 : FOR I=1 TO 400 : NEXT I
     20 OUT 14, 0   : FOR I=1 TO 400 : NEXT I
     30 GOTO 10
     RUN
     ```

---

## Running & Testing Locally

Requires **Node.js 18+** (zero external npm dependencies):

```bash
# Run the automated hardware & ROM boot test suite
npm test

# Build the static distribution into dist/
npm run build

# Serve locally on http://localhost:8080
npm start
```

---

## Project Structure

```text
├── assets/
│   ├── romwbw_sc131.rom     # Official RomWBW v3.6.0 SCZ180_sc131_std 512 KB ROM
│   ├── scm_s6.rom           # Official Small Computer Monitor S6 32 KB ROM
│   └── sc131_sdcard.simg    # Gzip-compressed 8-slice RomWBW MicroSDHC image
├── src/
│   ├── emulator/
│   │   ├── z180.js          # Zilog Z8S180 CPU, MMU, ASCI0/1, PRT0/1, DMA0, CSI/O
│   │   ├── sdcard.js        # SPI Mode 0 SDHC card controller & sparse image loader
│   │   ├── sc131.js         # SC131 board integration (U1-U7, JP1/JP2, LED1-3)
│   │   └── disasm.js        # Full Z80 + Z180 instruction disassembler
│   └── ui/
│       ├── terminal.js      # VT100 / ANSI / Kaypro / CP437 canvas terminal
│       └── app.js           # Interactive Enclosure/PCB view, Debugger, and Controls
├── tests/
│   └── sc131.test.js        # Automated unit & firmware boot integration tests
├── scripts/
│   └── build.js             # Static bundle builder for GitHub Pages
└── .github/workflows/
    └── deploy.yml           # GitHub Actions CI & GitHub Pages deployment
```
