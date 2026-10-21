/**
 * SPI Micro SDHC Card Emulator for SC131 (Z180 CSIO + U5 Latch Bit 2 /CS)
 *
 * Implements the SD Physical Layer Simplified Specification SPI mode protocol
 * as used by Wayne Warthen's RomWBW HBIOS (sd.asm, SDMODE_SC).
 *
 * Supports sparse 512-byte sector storage so a 64MB+ multi-slice SDHC image
 * occupies minimal memory while allowing fast sector reads/writes and image export.
 */

export class SDCard {
  /**
   * @param {object} [options]
   * @param {number} [options.sizeMB=64] Card capacity in MB (default 64MB = 131072 blocks)
   * @param {string} [options.productName='SC131'] 5-char ASCII product name in CID
   * @param {(op: string, lba: number) => void} [options.onActivity] Callback on sector read/write
   */
  constructor(options = {}) {
    this.sizeMB = options.sizeMB || 64;
    this.totalBlocks = this.sizeMB * 2048; // 512-byte blocks
    this.productName = (options.productName || 'SC131').padEnd(5, ' ').slice(0, 5);
    this.onActivity = options.onActivity || null;

    // Sparse sector storage: Map<lba: number, Uint8Array(512)>
    this.sectors = new Map();
    // Base flat image (optional Uint8Array) for fast initial reads without copying all sectors
    this.baseImage = null;

    this.present = true;
    this.writeProtected = false;
    this.emptyFillByte = 0xE5;
    this.readCount = 0;
    this.writeCount = 0;
    this.lastLba = 0;
    this.lastOp = 'IDLE';

    this.reset();
  }

  reset() {
    this.selected = false;
    this.inIdleState = true;
    this.appCmdPending = false;
    this.cmdBuf = [];
    this.txQueue = [];
    this.txIndex = 0;
    this.writeState = 'NONE'; // 'NONE' | 'WAIT_TOKEN' | 'RECEIVING_DATA' | 'RECEIVING_CRC'
    this.writeLba = 0;
    this.writeBuf = new Uint8Array(512);
    this.writeOffset = 0;
    this.crcCount = 0;
  }

  /**
   * Load a raw binary disk image (Uint8Array) as the base image
   * @param {Uint8Array} data
   */
  loadImage(data) {
    this.sectors.clear();
    this.baseImage = data;
    const minBlocks = Math.ceil(data.byteLength / 512);
    if (minBlocks > this.totalBlocks) {
      this.sizeMB = Math.ceil(minBlocks / 2048);
      this.totalBlocks = this.sizeMB * 2048;
    }
  }

  /**
   * Load a sparse sector map ({ lba: Uint8Array(512) } or array of [lba, Uint8Array])
   */
  loadSparseSectors(entries, sizeMB = 64) {
    this.sectors.clear();
    this.baseImage = null;
    this.sizeMB = sizeMB;
    this.totalBlocks = this.sizeMB * 2048;
    for (const [lba, data] of entries) {
      const buf = new Uint8Array(512);
      buf.set(data.subarray(0, 512));
      this.sectors.set(lba, buf);
    }
  }

  /**
   * Load a packed SC131SD1 sparse sector bundle (Uint8Array)
   * Header: "SC131SD1" (8B) + sizeMB (uint32 LE) + count (uint32 LE)
   * Records: count * (lba (uint32 LE) + 512B sector data)
   */
  loadSparseBundle(bundleBytes) {
    const view = new DataView(bundleBytes.buffer, bundleBytes.byteOffset, bundleBytes.byteLength);
    const magic = String.fromCharCode(...bundleBytes.subarray(0, 8));
    if (magic !== 'SC131SD1' && magic !== 'SC131SD0') {
      // Fallback: treat as raw flat image
      this.emptyFillByte = 0x00;
      this.loadImage(bundleBytes);
      return;
    }
    this.emptyFillByte = magic === 'SC131SD0' ? 0x00 : 0xE5;
    const sizeMB = view.getUint32(8, true);
    const count = view.getUint32(12, true);
    this.sectors.clear();
    this.baseImage = null;
    this.sizeMB = Math.max(64, sizeMB);
    this.totalBlocks = this.sizeMB * 2048;

    let offset = 16;
    for (let i = 0; i < count && offset + 516 <= bundleBytes.byteLength; i++) {
      const lba = view.getUint32(offset, true);
      const sec = new Uint8Array(512);
      sec.set(bundleBytes.subarray(offset + 4, offset + 516));
      this.sectors.set(lba, sec);
      offset += 516;
    }
  }

  /**
   * Read a 512-byte sector at LBA
   */
  readSector(lba) {
    if (this.sectors.has(lba)) {
      return this.sectors.get(lba);
    }
    const out = new Uint8Array(512);
    const byteOffset = lba * 512;
    if (this.baseImage && byteOffset < this.baseImage.byteLength) {
      const slice = this.baseImage.subarray(byteOffset, Math.min(byteOffset + 512, this.baseImage.byteLength));
      out.set(slice);
      if (slice.byteLength < 512) {
        out.fill(this.emptyFillByte, slice.byteLength);
      }
    } else {
      out.fill(this.emptyFillByte);
    }
    return out;
  }

  /**
   * Write a 512-byte sector at LBA
   */
  writeSector(lba, data) {
    const copy = new Uint8Array(512);
    copy.set(data.subarray(0, 512));
    this.sectors.set(lba, copy);
  }

  /**
   * Export the active region of the SD card as a contiguous Uint8Array
   */
  exportImage(maxMB = 18) {
    const blocks = Math.min(this.totalBlocks, maxMB * 2048);
    const out = new Uint8Array(blocks * 512);
    out.fill(0xE5);
    if (this.baseImage) {
      out.set(this.baseImage.subarray(0, Math.min(this.baseImage.byteLength, out.byteLength)));
    }
    for (const [lba, sector] of this.sectors.entries()) {
      if (lba < blocks) {
        out.set(sector, lba * 512);
      }
    }
    return out;
  }

  /**
   * Set SPI Chip Select state (true = selected / active low asserted)
   */
  setChipSelect(selected) {
    if (this.selected && !selected) {
      // Deselecting card resets command framing & flushes unread response bytes
      this.cmdBuf.length = 0;
      this.txQueue.length = 0;
      this.txIndex = 0;
      this.writeState = 'NONE';
    } else if (!this.selected && selected) {
      this.cmdBuf.length = 0;
    }
    this.selected = selected;
  }

  queueResponse(bytes) {
    this.txQueue = bytes;
    this.txIndex = 0;
  }

  shiftTxByte() {
    if (this.txIndex < this.txQueue.length) {
      const b = this.txQueue[this.txIndex++];
      if (this.txIndex >= this.txQueue.length) {
        this.txQueue.length = 0;
        this.txIndex = 0;
      }
      return b;
    }
    return 0xFF;
  }

  /**
   * Called when Z180 CSIO transmits a byte (MOSI)
   */
  spiTransmit(byte) {
    if (!this.present || !this.selected) {
      return 0xFF;
    }

    const b = byte & 0xFF;

    // Handle active block write data phase (CMD24)
    if (this.writeState === 'WAIT_TOKEN') {
      this.shiftTxByte();
      if (b === 0xFE) {
        this.writeState = 'RECEIVING_DATA';
        this.writeOffset = 0;
      }
      return 0xFF;
    }

    if (this.writeState === 'RECEIVING_DATA') {
      this.writeBuf[this.writeOffset++] = b;
      if (this.writeOffset >= 512) {
        this.writeState = 'RECEIVING_CRC';
        this.crcCount = 0;
      }
      return 0xFF;
    }

    if (this.writeState === 'RECEIVING_CRC') {
      this.crcCount++;
      if (this.crcCount >= 2) {
        this.writeSector(this.writeLba, this.writeBuf);
        this.writeCount++;
        this.lastLba = this.writeLba;
        this.lastOp = 'WRITE';
        if (this.onActivity) this.onActivity('WRITE', this.writeLba);
        this.writeState = 'NONE';
        // Queue Data Accepted token (0x05) followed by ready (0xFF)
        this.queueResponse([0x05, 0xFF]);
      }
      return 0xFF;
    }

    // Normal command framing
    if (this.cmdBuf.length === 0) {
      if ((b & 0xC0) === 0x40) {
        this.cmdBuf.push(b);
      } else {
        // Idle / fill clocks on MOSI advance any pending response byte
        this.shiftTxByte();
      }
      return 0xFF;
    }

    this.cmdBuf.push(b);
    if (this.cmdBuf.length === 6) {
      const cmd = this.cmdBuf.slice();
      this.cmdBuf.length = 0;
      this.processCommand(cmd);
    }
    return 0xFF;
  }

  /**
   * Called when Z180 CSIO receives a byte (MISO)
   */
  spiReceive() {
    if (!this.present || !this.selected) {
      return 0xFF;
    }
    return this.shiftTxByte();
  }

  processCommand(cmdBytes) {
    const cmd = cmdBytes[0] & 0x3F;
    const p0 = cmdBytes[1];
    const p1 = cmdBytes[2];
    const p2 = cmdBytes[3];
    const p3 = cmdBytes[4];
    const arg = ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;

    if (this.appCmdPending) {
      this.appCmdPending = false;
      switch (cmd) {
        case 41: // ACMD41: SD_SEND_OP_COND
          this.inIdleState = false;
          // 1 fill byte (consumed by SD_PUT($FF) in SD_EXECCMD) + R1 = 0x00 (Ready)
          this.queueResponse([0xFF, 0x00]);
          return;

        case 51: { // ACMD51: SEND_SCR (8 bytes)
          // SCR for SDHC (Version 2.00, SD_SECURITY = 3 -> SDHC)
          const scr = [0x02, 0x35, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00];
          this.queueResponse([0xFF, 0x00, 0xFF, 0xFE, ...scr, 0xFF, 0xFF]);
          return;
        }

        default:
          this.queueResponse([0xFF, 0x00]);
          return;
      }
    }

    switch (cmd) {
      case 0: // CMD0: GO_IDLE_STATE
        this.inIdleState = true;
        this.queueResponse([0xFF, 0x01]);
        break;

      case 1: // CMD1: SEND_OP_COND
        this.inIdleState = false;
        this.queueResponse([0xFF, 0x00]);
        break;

      case 8: // CMD8: SEND_IF_COND (R7: R1 + 4 bytes)
        this.queueResponse([0xFF, this.inIdleState ? 0x01 : 0x00, 0x00, 0x00, p2, p3]);
        break;

      case 9: { // CMD9: SEND_CSD (16 bytes)
        // CSD Version 2.0 (SDHC): C_SIZE = (totalBlocks / 1024) - 1
        const cSize = Math.max(0, (this.totalBlocks >>> 10) - 1);
        const csd = [
          0x40, // CSD_STRUCTURE = 1 (CSD v2.0)
          0x0E, // TAAC
          0x00, // NSAC
          0x32, // TRAN_SPEED
          0x5B, // CCC high
          0x59, // CCC low | READ_BL_LEN (9 = 512 bytes)
          0x00,
          (cSize >>> 16) & 0x3F,
          (cSize >>> 8) & 0xFF,
          cSize & 0xFF,
          0x7F,
          0x80,
          0x0A,
          0x40,
          0x00,
          0x01,
        ];
        this.queueResponse([0xFF, 0x00, 0xFF, 0xFE, ...csd, 0xFF, 0xFF]);
        break;
      }

      case 10: { // CMD10: SEND_CID (16 bytes)
        // Bytes 3..7 are PNM (5 ASCII characters printed by RomWBW at boot)
        const pnm = Array.from(this.productName).map((c) => c.charCodeAt(0));
        const cid = [
          0x03,       // MID
          0x53, 0x43, // OID ("SC")
          ...pnm,     // PNM ("SC131")
          0x10,       // PRV (1.0)
          0x00, 0x00, 0x01, 0x31, // PSN
          0x01, 0x6A, // MDT
          0x01,       // CRC7 | 1
        ];
        this.queueResponse([0xFF, 0x00, 0xFF, 0xFE, ...cid, 0xFF, 0xFF]);
        break;
      }

      case 16: // CMD16: SET_BLOCKLEN
        this.queueResponse([0xFF, 0x00]);
        break;

      case 17: { // CMD17: READ_SINGLE_BLOCK
        const lba = arg >>> 0;
        const sector = this.readSector(lba);
        this.readCount++;
        this.lastLba = lba;
        this.lastOp = 'READ';
        if (this.onActivity) this.onActivity('READ', lba);

        const resp = new Array(518);
        resp[0] = 0xFF; // Fill byte consumed by SD_PUT($FF)
        resp[1] = 0x00; // R1 = OK
        resp[2] = 0xFF; // Inter-frame fill before token
        resp[3] = 0xFE; // Data Start Token
        for (let i = 0; i < 512; i++) {
          resp[4 + i] = sector[i];
        }
        resp[516] = 0xFF; // CRC1
        resp[517] = 0xFF; // CRC2
        this.queueResponse(resp);
        break;
      }

      case 24: { // CMD24: WRITE_BLOCK
        this.writeLba = arg >>> 0;
        this.writeState = 'WAIT_TOKEN';
        this.queueResponse([0xFF, 0x00]);
        break;
      }

      case 55: // CMD55: APP_CMD
        this.appCmdPending = true;
        this.queueResponse([0xFF, this.inIdleState ? 0x01 : 0x00]);
        break;

      case 58: // CMD58: READ_OCR (R3: R1 + 4 bytes OCR)
        // Bit 31 = Power up ready, Bit 30 = CCS (1 = SDHC/SDXC block addressing)
        this.queueResponse([0xFF, 0x00, 0xC0, 0xFF, 0x80, 0x00]);
        break;

      case 59: // CMD59: CRC_ON_OFF
        this.queueResponse([0xFF, 0x00]);
        break;

      default:
        this.queueResponse([0xFF, 0x04]); // Illegal command
        break;
    }
  }
}
