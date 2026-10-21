# SC131 & SC126 — Z180 Pocket Computer & RC2014 Motherboard Emulator

A cycle-accurate, zero-dependency JavaScript hardware emulator for two of Stephen C. Cousins' Z180 computers (*Small Computer Central*):
- **[SC131 Z180 Pocket Computer](https://smallcomputercentral.com/sc131-z180-pocket-computer/)**
- **[SC126 Z180 Motherboard (RC2014 / RCBus)](https://smallcomputercentral.com/rcbus/sc100-series/sc126-z180-motherboard-rc2014/)**

**Live Demo:**
- **SC131 Pocket Computer:** **[https://pgas.github.io/sc131/](https://pgas.github.io/sc131/)**
- **SC126 Z180 Motherboard (RC2014):** **[https://pgas.github.io/sc131/?machine=sc126](https://pgas.github.io/sc131/?machine=sc126)**

---

## Hardware Architectures Emulated

Use the **Hardware Board** dropdown in the top bar to switch between the **SC131 Pocket Computer** and the **SC126 RC2014 Motherboard**:

### 1. SC131 Z180 Pocket Computer (`sc131.js`)
| Component | Part | Function in SC131 |
| :--- | :--- | :--- |
| **U1** | `SST39SF040` / `W27E040` | **512 KB Flash ROM** mapped at physical `0x00000–0x7FFFF` (`A19 = 0`). Includes `JP1` write-protect jumper. |
| **U2** | `AS6C4008-55PCN` | **512 KB Static RAM** mapped at physical `0x80000–0xFFFFF` (`A19 = 1`). |
| **U3** | `74HCT139N` | Dual 2-to-4 decoder for memory chip-selects (`A19`, `/MREQ`) and I/O port decoding (`0x0C` & `0x0E`). |
| **U4** | `Z8S18020VSC` (Rev. N) | **Zilog Z8S180 CPU @ 18.432 MHz** (`X1` oscillator): full Z80 + Z180 instruction set (`MLT`, `IN0`, `OUT0`, `TST`, `TSTIO`, `OTIM`, `OTIMR`, `OTDM`, `OTDMR`, `SLP`), 1 MB MMU (`CBR`, `BBR`, `CBAR`), Dual ASCI (`ASCI0` & `ASCI1`), Dual 16-bit Programmable Reload Timers (`PRT0` & `PRT1`), `DMA0`, and Clocked Serial I/O (`CSI/O`) SPI master. |
| **U5** | `74HCT259N` | **8-bit Addressable Latch** at I/O ports `0x0C` (`12`) and `0x0E` (`14`):<br>• **Port `0x0C`**: MicroSD SPI `/CS` (Bit 2, active low)<br>• **Port `0x0E`**: Orange Status `LED1` (Bit 2, active low; **ON** at reset) |
| **U7** | `DS1233-5+` | **EconoReset Voltage Supervisor**: monitors `VCC` (`< 4.7 V`) and `SW1` tactile reset button. |

### 2. SC126 Z180 Motherboard for RC2014 / RCBus (`sc126.js`, `ds1302.js`)
| Component | Part | Function in SC126 |
| :--- | :--- | :--- |
| **U1 / U2** | `SST39SF040` | **Dual 512 KB Flash ROM** sockets mapped at physical `0x00000–0x7FFFF` (`A19 = 0`). |
| **U3** | `AS6C4008-55PCN` | **512 KB Static RAM** mapped at physical `0x80000–0xFFFFF` (`A19 = 1`). |
| **U4** | `Z8S18020VSC` (Rev. N) | **Zilog Z8S180 CPU @ 18.432 MHz** (`X1` oscillator), internal I/O at `0xC0–0xFF`. |
| **U7** | `74HCT273` | **Port `0x0D` (`13`) 8-Bit Green Diagnostic LED Bar (`L7..L0`)**: active-high latch cleared at reset; displays RomWBW POST progress, Small Computer Monitor diagnostics, and user output (`OUT 13, n`). |
| **U6 / U8** | `74HCT273` / `74HCT244` | **Port `0x0C` (`12`) System Latch & Read Buffer**:<br>• Write bits: `D7`=`RTC_OUT`/`I2C_SDA`, `D6`=`RTC_CLK`, `D5`=`/RTC_WE`, `D4`=`RTC_CE`, `D3`=`/SPI_CS2`, `D2`=`/SPI_CS1` (MicroSDHC), `D1`=`Flash Select`, `D0`=`I2C_SCL`<br>• Read bits: `D7`=`I2C_SDA`, `D0`=`RTC_IN` |
| **U9** | `DS1302+` | **Dallas Real-Time Clock & 31-Byte Battery-Backed NVRAM** (`BT1` CR2032) bit-banged via Port `0x0C` (`DSRTC: MODE=STD IO=0x0C`). |
| **U10** | `DS1233-5+` | **EconoReset Voltage Supervisor** (`< 4.7 V`) and `SW2` tactile reset button. |

---

## Bundled Official Firmware & 8-Slice SDHC Image

The emulator ships with the unmodified official firmware and software distribution for both boards:

1. **RomWBW v3.6.0 for SC131 (`assets/romwbw_sc131.rom`, `SCZ180_sc131_std.rom`, 512 KB)**
2. **RomWBW v3.6.0 for SC126 (`assets/romwbw_sc126.rom`, `SCZ180_sc126_std.rom`, 512 KB)**
3. **Small Computer Monitor S6 (`assets/scm_s6.rom`, 32 KB)** — Stephen C. Cousins' standalone monitor supporting both SC131 and SC126 (`S6` configuration).
4. **Pre-populated 8-Slice MicroSDHC Card (`assets/sc131_sdcard.simg`)** — Contains 8 bootable RomWBW v3.6.0 hard disk slices:
   - `2.0` (`SD0:0` / Drive `A:`): **CP/M 2.2** (`BBCBASIC`, `MBASIC`, `ASM`, `DDT`, `STAT`, `PIP`, `ED`, `SURVEY`, `XM`, etc.)
   - `2.1` (`SD0:1` / Drive `D:`): **ZSDOS 1.1 (Z-System)**
   - `2.2` (`SD0:2` / Drive `E:`): **CP/M 3.0 (CP/M Plus)**
   - `2.3` (`SD0:3` / Drive `F:`): **Classic Infocom & Text Games** (`Zork I–III`, `Hitchhiker's Guide`, `Colossal Cave Adventure`, `Ladder`, `Catchum`)
   - `2.4` (`SD0:4` / Drive `G:`): **WordStar 4.0**
   - `2.5` (`SD0:5` / Drive `H:`): **Borland Turbo Pascal 3.01A**
   - `2.6` (`SD0:6` / Drive `I:`): **Microsoft BASIC (`MBASIC`) & Games (`STARTREK.BAS`, `HAMURABI.BAS`, `LUNAR.BAS`)**
   - `2.7` (`SD0:7` / Drive `J:`): **Hi-Tech C Compiler v3.09**

---

## Running & Testing Locally

Requires **Node.js 18+** (zero external npm dependencies):

```bash
# Run the automated hardware & ROM boot test suite (SC131 + SC126)
npm test

# Build the static distribution into dist/
npm run build

# Serve locally on http://localhost:8080
npm start
```
