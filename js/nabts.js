/*
~ nabts.js — NABTS (.t33) stream decoder and NAPLPS page renderer/animator for the browser.
 ~ JavaScript port of NABTS code used by Decode-Orc, specifically pull request 328.
 * Licence: GPL-3.0-or-later (inherited from decode-orc).
 * See https://github.com/decode-orc/decode-orc
 */
((globalScope, createLibrary) => {
    if (typeof module === 'object' && module.exports) {
        const loadDecoderFonts = () => {
            try { return require('./naplps-decoder-fonts.js'); } catch { return {}; }
        };
        module.exports = createLibrary(require('./naplps-font.js'), loadDecoderFonts);
    } else {
        globalScope.NABTS = createLibrary(globalScope.NAPLPS_FONT, () => globalScope.NAPLPS_DECODER_FONTS || {});
    }
})(typeof self !== 'undefined' ? self : globalThis, (FONT, loadDecoderFonts) => {
    'use strict';


    // * * * Python compatible headers * * *
    // * Python's % (result has the sign of the divisor)
    const pythonMod = (value, divisor) => {
        const remainder = value % divisor;
        return remainder < 0 ? remainder + divisor : remainder;
    };

    // * Python's round(): halves go to the even neighbor. */
    const roundHalfEven = (value) => {
        const whole = Math.floor(value), fraction = value - whole;
        if (fraction > 0.5) return whole + 1;
        if (fraction < 0.5) return whole;
        return whole % 2 === 0 ? whole : whole + 1;
    };

    // How many 1 bits a number has (used to measure Hamming distances between bytes)
    const countSetBits = (value) => {
        let count = 0;

        // Add the lowest bit, then shift right (>>> fills with zeros) until nothing is left
        while (value) { count += value & 1; value >>>= 1; }
        return count;
    };

    // * value >> bits, safe for addresses wider than 32 bits
    const shiftRight = (value, bits) => Math.floor(value / 2 ** bits);
    const toHex = (value, digits) => value.toString(16).toUpperCase().padStart(digits, '0');

    // Correctly rounded hypot (as Python's math.hypot). V8's Math.hypot can be 1 ulp off, which is enough to move a dash boundary on a textured line. sqrt, then one exact residual correction
    const splitDouble = (value) => {
        const scaled = 134217729 * value, high = scaled - (scaled - value);
        return [high, value - high];
    };

    // a × b as [rounded product, the rounding error], together exact
    const exactProduct = (a, b) => {
        const product = a * b, [aHigh, aLow] = splitDouble(a), [bHigh, bLow] = splitDouble(b);
        return [product, ((aHigh * bHigh - product) + aHigh * bLow + aLow * bHigh) + aLow * bLow];
    };

    // The length of the vector (dx, dy), i.e. √(dx² + dy²), rounded exactly like Python
    const hypot = (dx, dy) => {
        dx = Math.abs(dx); dy = Math.abs(dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Math.hypot(dx, dy);
        if (dx === 0) return dy;
        if (dy === 0) return dx;
        const [dxSquared, dxSquaredError] = exactProduct(dx, dx), [dySquared, dySquaredError] = exactProduct(dy, dy);
        const sumHigh = dxSquared + dySquared, carry = sumHigh - dxSquared;
        const sumLow = (dxSquared - (sumHigh - carry)) + (dySquared - carry) + dxSquaredError + dySquaredError;
        const root = Math.sqrt(sumHigh), [rootSquared, rootSquaredError] = exactProduct(root, root);
        const residual = ((sumHigh - rootSquared) - rootSquaredError) + sumLow;
        return root + residual / (2 * root);
    };

    // * * * Hamming 8/4 and parity * * *
    const HAMMING_CODEWORDS = [
        0x15, 0x02, 0x49, 0x5E,
        0x64, 0x73, 0x38, 0x2F,
        0xD0, 0xC7, 0x8C, 0x9B,
        0xA1, 0xB6, 0xFD, 0xEA
    ];

    // ^ Decoded nibble, or -1 if uncorrectable
    const HAMMING_VALUE = new Int8Array(256).fill(-1);   // decoded nibble, or -1 if uncorrectable

    // ^ 1 if the byte needed no correction
    const HAMMING_CLEAN = new Uint8Array(256);           // 1 if the byte needed no correction

    // ^ 1 if the byte has an odd number of 1 bits
    const ODD_PARITY = new Uint8Array(256);

    for (let byte = 0; byte < 256; byte++) {
        for (let nibble = 0; nibble < 16; nibble++) {
            const distance = countSetBits(byte ^ HAMMING_CODEWORDS[nibble]);
            if (distance === 0) { HAMMING_VALUE[byte] = nibble; HAMMING_CLEAN[byte] = 1; }
            else if (distance === 1) HAMMING_VALUE[byte] = nibble;
        }
        ODD_PARITY[byte] = countSetBits(byte) & 1;
    }

    const PACKET_SIZE = 33, PREFIX_SIZE = 5, MAX_BLOCK = 28;
    const DISPLAY_HEIGHT = 0.78125;   // X3.110 Table D1: the visible screen is the lower 0.78125 of the unit square

    // * * * Packets (CEA-516 §3) * * *
    const decodePacket = (packetBytes) => {
        const packet = { valid: false };
        const prefixNibbles = [];
        let correctedBytes = 0;
        for (let i = 0; i < PREFIX_SIZE; i++) {
            prefixNibbles.push(HAMMING_VALUE[packetBytes[i]]);
            if (prefixNibbles[i] < 0) return packet;
            if (!HAMMING_CLEAN[packetBytes[i]]) correctedBytes++;
        }
        // decode-orc PR #328 refuses a video line whose five prefix bytes all needed correction (a test signal read
        // as data) before it becomes a packet; a .t33 holds packets already, and decode-orc's own replay of one keeps
        // them, so they are only counted here
        packet.all_corrected = correctedBytes === PREFIX_SIZE;
        packet.whole = correctedBytes === 0;
        packet.valid = true;
        packet.channel = (prefixNibbles[0] << 8) | (prefixNibbles[1] << 4) | prefixNibbles[2];
        packet.attested = !!(HAMMING_CLEAN[packetBytes[0]] && HAMMING_CLEAN[packetBytes[1]] && HAMMING_CLEAN[packetBytes[2]]);
        packet.prefix = packetBytes.subarray(0, PREFIX_SIZE);
        packet.ci = prefixNibbles[3];                    // continuity index
        packet.ci_byte = packetBytes[3];
        const structure = prefixNibbles[4];
        packet.sync = !!(structure & 1);
        packet.not_full = !!(structure & 2);
        packet.suffix = (((structure >> 3) & 1) << 1) | ((structure >> 2) & 1);   // 0 none, 1 LRC, 2 LRC+spare, 3 burst
        const dataLength = MAX_BLOCK - [0, 1, 2, MAX_BLOCK][packet.suffix];
        // A synchronizing packet with no data block (PS says a 28-byte suffix) carries no group header; it is kept,
        // as decode-orc keeps it, so its continuity index still counts (a group open on its channel takes it as an
        // empty block)
        const data = packetBytes.slice(PREFIX_SIZE, PREFIX_SIZE + dataLength);
        packet.integrity = 'unchecked';
        if (packet.suffix === 1 || packet.suffix === 2) {
            const block = packetBytes.subarray(PREFIX_SIZE, PREFIX_SIZE + MAX_BLOCK);
            let checksum = 0;
            for (const byte of block) checksum ^= byte;
            const syndrome = checksum ^ 0xFF;
            if (syndrome === 0) packet.integrity = 'clean';
            else if ((syndrome & (syndrome - 1)) === 0) {      // a single bit is wrong …
                const badParity = [];
                for (let position = 0; position < block.length; position++) if (!ODD_PARITY[block[position]]) badParity.push(position);
                if (badParity.length === 1) {                    // … and parity says which byte
                    if (badParity[0] < dataLength) data[badParity[0]] ^= syndrome;
                    packet.integrity = 'corrected';
                } else packet.integrity = 'damaged';
            } else packet.integrity = 'damaged';
        }
        packet.data = data;
        // The whole 28-byte block as received, so a group can re-read a block whose PS byte was misread
        packet.block = packetBytes.subarray(PREFIX_SIZE, PREFIX_SIZE + MAX_BLOCK);
        return packet;
    };

    // * * * Data groups (§4) * * *
    const GROUP_HEADER_SIZE = 8, MAX_FURTHER_PACKETS = 67, MAX_OPEN_GROUPS = 32, LOOSE_RUN_MAX_GAP = 2, MAX_OPEN_LOOSE_RUNS = 8;

    /** The nibble whose Hamming 8/4 codeword is nearest a byte (the preferred one where it ties for nearest). */
    const nearestNibble = (byte, preferred = -1) => {
        let best = 0, bestDistance = 9;
        for (let nibble = 0; nibble < 16; nibble++) {
            const distance = countSetBits(byte ^ HAMMING_CODEWORDS[nibble]);
            if (distance < bestDistance || (distance === bestDistance && nibble === preferred)) { best = nibble; bestDistance = distance; }
        }
        return best;
    };

    const decodeGroupHeader = (bytes, lowNibbleFirst = false) => {
        if (bytes.length < GROUP_HEADER_SIZE) return null;
        const nibbles = [];
        let attested = true;
        let guessed = 0;
        for (let i = 0; i < GROUP_HEADER_SIZE; i++) {
            nibbles.push(HAMMING_VALUE[bytes[i]]);
            if (!HAMMING_CLEAN[bytes[i]]) attested = false;
            if (nibbles[i] < 0) {
                // JS-only: a byte with two bits wrong (WSBT 1984 reads the type byte 0x15 as 0x2A in half its group
                // headers) is read as the nearest codeword, type 0 where that is among them; with more than two
                // header bytes past correction the header is taken as lost
                if (++guessed > 2) return null;
                nibbles[i] = nearestNibble(bytes[i], i === 0 ? 0 : -1);
            }
        }
        const byteFrom = (first, second) => (lowNibbleFirst ? (second << 4) | first : (first << 4) | second);
        if (guessed) {
            const further = byteFrom(nibbles[3], nibbles[4]), finalBytes = byteFrom(nibbles[5], nibbles[6]);
            if (further > MAX_FURTHER_PACKETS || finalBytes > MAX_BLOCK) return null;
        }
        return {
            attested, type_attested: !!HAMMING_CLEAN[bytes[0]], guessed,
            type: nibbles[0], ci: nibbles[1], rep: nibbles[2], further: byteFrom(nibbles[3], nibbles[4]),
            final_bytes: byteFrom(nibbles[5], nibbles[6]), routing: nibbles[7]
        };
    };

    const detectHeaderNibbleOrder = (bytes, packetCount) => {
        let highFirst = 0, lowFirst = 0;
        for (let i = 0; i < packetCount; i++) {
            const packet = decodePacket(bytes.subarray(i * PACKET_SIZE, (i + 1) * PACKET_SIZE));
            if (!packet.valid || !packet.sync) continue;
            const asHigh = decodeGroupHeader(packet.data, false), asLow = decodeGroupHeader(packet.data, true);
            if (!asHigh || asHigh.guessed) continue;
            const plausible = (header) => !!header && header.further <= MAX_FURTHER_PACKETS && header.final_bytes <= MAX_BLOCK;
            if (plausible(asHigh) && !plausible(asLow)) highFirst++;
            else if (plausible(asLow) && !plausible(asHigh)) lowFirst++;
        }
        return lowFirst > highFirst;
    };

    class GroupAssembler {
        constructor(onGroup, lineCountKnown = false, lowNibbleFirst = false) {
            this.onGroup = onGroup;
            this.lowNibbleFirst = lowNibbleFirst;
            // A .t33 has no empty VBI lines, so the number of lines between a channel's packets is
            // unknown; a gap named by the continuity index is taken as it is.
            this.lineCountKnown = lineCountKnown;
            this.openGroups = new Map();
            this.looseRuns = new Map();                // channel → packets arriving with no group open (for salvage)
            this.onLoose = null;
            this.teletextChannels = new Set();         // channels seen carrying type-0 groups as transmitted
            this.idleFillChannels = new Set();
            this.clock = 0;
            this.stats = {
                packets: 0, prefix_bad: 0, prefix_test_signal: 0, prefix_whole: 0, header_bad: 0, orphans: 0,
                complete: 0, superseded: 0, unfinished: 0, foreign: 0,
                sync_misreads: 0, type_misreads: 0, width_misreads: 0, idle_fill: 0, loose_runs: 0, loose_packets: 0
            };
        }

        /** A block the suffix check vouches for: corrected, or clean with every byte passing parity (type 0). */
        static _vouched(group, packet) {
            if (packet.integrity === 'corrected') return true;
            if (packet.integrity !== 'clean') return false;
            if (group.header.type !== 0) return true;
            return packet.data.every((byte) => ODD_PARITY[byte]);
        }

        static _tallyIntegrity(group, packet) {
            if (packet.integrity === 'damaged') group.damaged += 1;
            else if (packet.integrity === 'unchecked' && packet.data.length > 0) group.unchecked += 1;
            // A clean longitudinal check with a byte failing parity: two wrong bits in one column
            else if (packet.integrity === 'clean' && !GroupAssembler._vouched(group, packet)) group.damaged += 1;
        }

        /** decode-orc PR #328: a block whose PS byte names another width than its group's is read at the group's width. */
        _atGroupWidth(group, packet) {
            if (!packet.data.length || !group.nominalLength || packet.data.length === group.nominalLength) return packet;
            this.stats.width_misreads += 1;
            return { ...packet, data: packet.block.slice(0, group.nominalLength), integrity: 'damaged' };
        }

        _appendPacket(group, packet) {
            if (!packet.data.length) return;
            group.lastOffset = group.stream.length;
            group.lastLength = packet.data.length;
            // 0 lost, 1 arrived, 2 vouched for by the block's suffix check
            const level = group.placeable ? (GroupAssembler._vouched(group, packet) ? 2 : 1) : 0;
            for (const byte of packet.data) {
                group.stream.push(byte);
                group.present.push(level);
            }
        }

        /** Norpak's byte-serial test pattern (idle fill): each byte is the one before shifted right by one. */
        static _isIdleFill(data, present) {
            let pairs = 0, steps = 0;
            for (let i = 0; i + 1 < data.length; i++) {
                if (!present[i] || !present[i + 1] || data[i] === data[i + 1]) continue;
                pairs++;
                if ((data[i + 1] & 0x3F) === ((data[i] >> 1) & 0x3F)) steps++;
            }
            return { pairs, pattern: pairs >= 64 && steps * 100 >= pairs * 50 };
        }

        _appendHole(group, missingPackets) {
            const length = missingPackets * group.nominalLength;
            for (let i = 0; i < length; i++) { group.stream.push(0); group.present.push(0); }
        }

        _emit(channel, group, outcome) {
            // decode-orc PR #328: a group that ended short keeps the length its header declared, the missing
            // blocks held open as a hole at its tail, so later links of a linked series keep their offsets
            if (outcome !== 'complete' && group.header.further > group.packetsSeen && group.nominalLength > 0) {
                this._appendHole(group, group.header.further - group.packetsSeen);
                group.lastOffset = group.stream.length - group.nominalLength;
                group.lastLength = group.nominalLength;
            }
            let end = group.lastOffset + group.lastLength;
            if (group.header.final_bytes === 0) end = group.lastOffset;
            else if (group.header.final_bytes < group.lastLength) end = group.lastOffset + group.header.final_bytes;
            end = Math.min(end, group.stream.length);
            const finished = {
                channel, channel_attested: group.attested, hdr: group.header, outcome,
                lost: group.lost, damaged: group.damaged, unchecked: group.unchecked,
                data: end > GROUP_HEADER_SIZE ? group.stream.slice(GROUP_HEADER_SIZE, end) : [],
                present: end > GROUP_HEADER_SIZE ? group.present.slice(GROUP_HEADER_SIZE, end) : [],
                clock: this.clock,
                // A header read from codewords guessed past correction can't vouch for a whole group (JS-only)
                intact: outcome === 'complete' && group.lost === 0 && group.damaged === 0 && group.unchecked === 0 && !group.header.guessed
            };
            this.stats[outcome] += 1;
            if (outcome === 'complete' && group.header.type !== 0) this.stats.foreign += 1;
            // An encoder's idle fill is not passed on as records
            const fill = GroupAssembler._isIdleFill(finished.data, finished.present);
            if (fill.pattern) this.idleFillChannels.add(channel);
            if (fill.pattern || (fill.pairs < 64 && this.idleFillChannels.has(channel))) { this.stats.idle_fill += 1; return; }
            if (group.header.type === 0 && group.header.type_attested && group.attested) this.teletextChannels.add(channel);
            this.onGroup(finished);
        }

        add(packet) {
            this.stats.packets += 1;
            this.clock += 1;
            if (!packet.valid) { this.stats.prefix_bad += 1; return; }
            if (packet.all_corrected) this.stats.prefix_test_signal += 1;
            if (packet.whole) this.stats.prefix_whole += 1;
            if (packet.sync) this._begin(packet); else this._extend(packet);
        }

        _begin(packet) {
            const header = decodeGroupHeader(packet.data, this.lowNibbleFirst);
            if (!header) {
                // A data packet whose PS byte was misread as synchronizing: if the open group expects exactly
                // this continuity index next, the packet is that group's next block (decode-orc PR #328)
                const open = this.openGroups.get(packet.channel);
                if (open && packet.ci === (open.lastIndex + 1) % 16) {
                    this.stats.sync_misreads += 1;
                    this._extend({ ...packet, sync: false });
                    return;
                }
                this.stats.header_bad += 1;
                // With no group open, the packet is a group's start with its header damaged, or a data packet of a
                // group whose start was lost: either way the head of whatever follows it on the channel
                if (!open) { this._endLoose(packet.channel); this._extendLoose(packet, true); }
                return;
            }
            // A teletext channel carries nothing but type 0: a type corrected into another value there is a misread
            if (header.type !== 0 && !header.type_attested && this.teletextChannels.has(packet.channel)) {
                header.type = 0;
                this.stats.type_misreads += 1;
            }
            this._endLoose(packet.channel);              // whatever ran loose on the channel ended before this group
            if (header.further > MAX_FURTHER_PACKETS) return;
            if (this.openGroups.has(packet.channel)) {
                const previous = this.openGroups.get(packet.channel);
                this.openGroups.delete(packet.channel);
                this._emit(packet.channel, previous, 'superseded');
            } else if (this.openGroups.size >= MAX_OPEN_GROUPS) return;
            const group = {
                header, attested: packet.attested, lastIndex: packet.ci, lastLine: this.clock,
                stream: [], present: [], nominalLength: packet.data.length, placeable: true, packetsSeen: 0,
                lastOffset: 0, lastLength: 0, lost: 0, damaged: 0, unchecked: 0
            };
            GroupAssembler._tallyIntegrity(group, packet);
            this._appendPacket(group, packet);
            if (header.further === 0) { this._emit(packet.channel, group, 'complete'); return; }
            this.openGroups.set(packet.channel, group);
        }

        /** How many packets were lost before this one, judged from its continuity index. */
        _missingPackets(group, packet, linesBetween) {
            const expectedIndex = (group.lastIndex + 1) % 16;
            const indexGap = pythonMod(packet.ci - expectedIndex, 16);
            if (indexGap <= linesBetween) return indexGap;
            const room = group.header.further - group.packetsSeen;
            const limit = Math.min(linesBetween, room, 15);
            let bestGap = 0, bestDistance = 99;
            for (let gap = 0; gap <= limit; gap++) {
                const distance = countSetBits(packet.ci_byte ^ HAMMING_CODEWORDS[(expectedIndex + gap) % 16]);
                if (distance < bestDistance) { bestGap = gap; bestDistance = distance; }
            }
            return bestGap;
        }

        _extend(packet) {
            const group = this.openGroups.get(packet.channel);
            if (!group) { this.stats.orphans += 1; this._extendLoose(packet, false); return; }
            const linesBetween = this.lineCountKnown ? this.clock - group.lastLine - 1 : 15;
            const missing = this._missingPackets(group, packet, linesBetween);
            if (missing) {
                group.lost += missing;
                const room = group.header.further - group.packetsSeen;
                group.packetsSeen = Math.min(group.packetsSeen + missing, group.header.further);
                if (missing > room) group.placeable = false; else this._appendHole(group, missing);
            }
            group.lastIndex = (group.lastIndex + 1 + missing) % 16;
            group.lastLine = this.clock;
            const block = this._atGroupWidth(group, packet);
            GroupAssembler._tallyIntegrity(group, block);
            this._appendPacket(group, block);
            group.packetsSeen += 1;
            if (group.packetsSeen >= group.header.further) {
                this.openGroups.delete(packet.channel);
                this._emit(packet.channel, group, 'complete');
            }
        }

        flush() {
            for (const channel of [...this.openGroups.keys()]) {
                const group = this.openGroups.get(channel);
                this.openGroups.delete(channel);
                this._emit(channel, group, 'unfinished');
            }
            for (const channel of [...this.looseRuns.keys()]) this._endLoose(channel);
        }

        /**
         * decode-orc PR #328: packets of a teletext channel that arrive with no group open — the body of a group
         * whose synchronizing packet was lost — are collected as a loose run, with a hole wherever the continuity
         * index says up to two packets went missing, for salvage to find the record they belong to.
         */
        _extendLoose(packet, starts) {
            if (!this.onLoose || !packet.data.length || !this.teletextChannels.has(packet.channel)) return;
            const append = (open) => {
                const { run } = open, width = run.block_bytes, atWidth = packet.data.length === width;
                let vouched = atWidth && (packet.integrity === 'corrected' || packet.integrity === 'clean');
                if (vouched && packet.integrity === 'clean') {
                    for (let i = 0; i < width; i++) if (!ODD_PARITY[packet.data[i]]) { vouched = false; break; }
                }
                const level = vouched ? 2 : 1;
                for (let i = 0; i < width; i++) {
                    run.data.push(i < packet.data.length ? packet.data[i] : packet.block[i]);
                    run.present.push(level);
                }
                run.packets += 1;
                open.lastIndex = packet.ci;
            };
            const open = this.looseRuns.get(packet.channel);
            if (open && !starts) {
                const gap = pythonMod(packet.ci - (open.lastIndex + 1), 16);
                const lines = this.lineCountKnown ? this.clock - open.lastLine - 1 : Infinity;
                const blocks = open.run.data.length / open.run.block_bytes;
                if (gap <= LOOSE_RUN_MAX_GAP && gap <= lines && blocks + gap + 1 <= MAX_FURTHER_PACKETS + 1) {
                    for (let i = 0; i < gap * open.run.block_bytes; i++) { open.run.data.push(0); open.run.present.push(0); }
                    append(open);
                    open.lastLine = this.clock;
                    return;
                }
            }
            if (open) this._endLoose(packet.channel);
            if (this.looseRuns.size >= MAX_OPEN_LOOSE_RUNS) return;
            const fresh = {
                run: { channel: packet.channel, data: [], present: [], packets: 0, starts_sync: starts, block_bytes: packet.data.length, clock: 0 },
                lastIndex: packet.ci, lastLine: this.clock
            };
            append(fresh);
            this.looseRuns.set(packet.channel, fresh);
        }

        _endLoose(channel) {
            const open = this.looseRuns.get(channel);
            if (!open) return;
            this.looseRuns.delete(channel);
            this.stats.loose_runs += 1;
            this.stats.loose_packets += open.run.packets;
            open.run.clock = this.clock;
            if (this.onLoose) this.onLoose(open.run);
        }
    }

    // * * * Records (§5) * * *
    /** Reads Hamming-coded nibbles one at a time; remembers whether any was bad or corrected. */
    class NibbleReader {
        constructor(bytes) { this.bytes = bytes; this.position = 0; this.failed = false; this.clean = true; }

        next() {
            if (this.failed || this.position >= this.bytes.length) { this.failed = true; return -1; }
            const value = HAMMING_VALUE[this.bytes[this.position]];
            if (value < 0) { this.failed = true; return -1; }
            if (!HAMMING_CLEAN[this.bytes[this.position]]) this.clean = false;
            this.position += 1;
            return value;
        }
    }

    const FLAG_NAMES = ['caption', 'delay', 'index', 'more', 'cyclic', 'auto_acquire', 'support_needed',
        'priority', 'alarm', 'update', 'support_record'];

    const decodeRecordHeader = (bytes) => {
        if (bytes.length < 5) return null;
        const reader = new NibbleReader(bytes);
        const recordType = reader.next(), descriptor = reader.next();
        if (reader.failed) return null;
        const header = { type: recordType };
        const longAddress = descriptor & 1, isLinked = descriptor & 2, hasFlags = descriptor & 4, hasExtensions = descriptor & 8;
        const digitCount = longAddress ? 9 : 3;
        let digits = [];
        for (let i = 0; i < digitCount; i++) digits.push(reader.next());
        if (reader.failed) return null;
        if (!longAddress) digits = [0, 0, 0, 0, ...digits, 0, 0];
        header.address = digits.reduce((address, digit) => address * 16 + digit, 0);
        header.long_form = !!longAddress;
        header.linked = false; header.more_links = false; header.order = 0;
        if (isLinked) {
            const linkHigh = reader.next(), linkLow = reader.next();
            if (reader.failed) return null;
            header.linked = true;
            header.more_links = !!(linkHigh & 8);
            header.order = ((linkHigh & 7) << 4) | linkLow;
        }
        header.flags = Object.fromEntries(FLAG_NAMES.map((name) => [name, false]));
        header.version = 0;
        if (hasFlags) {
            let flagGroup = 1;
            for (; ;) {
                const presence = reader.next();
                if (reader.failed) return null;
                for (let pair = 0; pair < 3; pair++) {
                    if (!((presence >> pair) & 1)) continue;
                    for (let half = 0; half < 2; half++) {
                        const flags = reader.next();
                        if (reader.failed) return null;
                        const flagIndex = pair * 2 + half + 1;
                        if (flagGroup !== 1) continue;
                        if (flagIndex === 3) {
                            header.flags.caption = !!(flags & 8); header.flags.delay = !!(flags & 4); header.flags.index = !!(flags & 2);
                        } else if (flagIndex === 4) {
                            header.flags.more = !!(flags & 8); header.flags.cyclic = !!(flags & 4);
                            header.flags.auto_acquire = !!(flags & 2); header.flags.support_needed = !!(flags & 1);
                        } else if (flagIndex === 5) {
                            header.flags.priority = !!(flags & 8); header.flags.alarm = !!(flags & 4);
                            header.flags.update = !!(flags & 2); header.flags.support_record = !!(flags & 1);
                        } else if (flagIndex === 6) header.version = flags;
                    }
                }
                if (!(presence & 8)) break;
                flagGroup += 1;
            }
        }
        header.attested = reader.clean;
        header.extensions = [];
        if (hasExtensions) {
            for (; ;) {
                const intro = reader.next(), size = reader.next();
                if (reader.failed) return null;
                const extensionData = [];
                for (let i = 0; i < size; i++) extensionData.push(reader.next());
                if (reader.failed) return null;
                header.extensions.push([intro & 7, size, extensionData]);
                if (!(intro & 8)) break;
            }
        }
        header.header_bytes = reader.position;
        return header;
    };

    const isShortAddress = (address) => (shiftRight(address, 20) & 0xFFFF) === 0 && (address % 256) === 0;
    const addressText = (address) => (isShortAddress(address) ? toHex(shiftRight(address, 8) & 0xFFF, 3) : toHex(address, 9));

    const reservedPurpose = (channel, address) => {
        const shortAddress = isShortAddress(address) ? (shiftRight(address, 8) & 0xFFF) : 0x1000;
        if (shortAddress === 0xFFF) return 'Support Record';
        if (channel === 0 && shortAddress === 0) return 'Master Index / power-up';
        if (channel === 0 && shortAddress === 0xFFE) return 'Service Application Record';
        if (channel === 0xA00 && shortAddress === 0) return 'Start of captioning';
        if (channel === 0xB00 && shortAddress === 0) return 'Start of Flash';
        return '';
    };

    /** Groups → messages (a single record, or an assembled linked series, §5.2.6). */
    class RecordAssembler {
        constructor(onMessage) {
            this.onMessage = onMessage;
            this.openSeries = new Map();
            this.reservedSeries = new Set();
            this.sequence = 0;
            this.stats = { groups: 0, foreign: 0, header_bad: 0, records: 0 };
            this.foreign = new Map();
        }

        /** A group of a reserved type that plainly carries a page: clean identity, presentation type, opens with SO. */
        static _carriesPage(group) {
            if (!group.channel_attested || !group.hdr.attested) return null;
            const header = decodeRecordHeader(group.data);
            if (!header || !header.attested || !isPresentation(header.type)) return null;
            if (header.header_bytes >= group.data.length || group.data[header.header_bytes] !== 0x0E ||
                !group.present[header.header_bytes]) return null;
            return header;
        }

        add(group) {
            this.stats.groups += 1;
            if (group.hdr.type !== 0) {
                // decode-orc PR #328: a page a service sent in a group of a reserved type, and the later records of its series
                const seriesKey = (header) => `${group.channel},${group.hdr.type},${header.address}`;
                const page = RecordAssembler._carriesPage(group);
                if (page) this.reservedSeries.add(seriesKey(page));
                let isPage = !!page;
                if (!isPage && group.channel_attested && group.hdr.attested) {
                    const header = decodeRecordHeader(group.data);
                    isPage = !!(header && header.attested && header.linked && header.order > 0 &&
                        this.reservedSeries.has(seriesKey(header)));
                }
                if (isPage) return this._addRecord(group);
            }
            if (group.hdr.type !== 0) {                          // not teletext (another data service)
                this.stats.foreign += 1;
                if (group.channel_attested && group.hdr.attested) {
                    const key = `${group.channel},${group.hdr.type}`;
                    this.foreign.set(key, (this.foreign.get(key) || 0) + 1);
                }
                return;
            }
            this._addRecord(group);
        }

        _addRecord(group) {
            const header = decodeRecordHeader(group.data);
            if (!header) { this.stats.header_bad += 1; return; }
            this.stats.records += 1;
            const data = group.data.slice(header.header_bytes), present = group.present.slice(header.header_bytes);
            const attested = header.attested && group.channel_attested;
            if (!header.linked) {
                this.onMessage({
                    channel: group.channel, address: header.address, long_form: header.long_form, type: header.type,
                    flags: { ...header.flags }, version: header.version, extensions: header.extensions,
                    data, present, complete: true, intact: group.intact, attested, header_attested: header.attested,
                    aligned: true, records: 1, clock: group.clock
                });
                return;
            }
            // A linked record that is both first and last is a later record whose link order was misread as 0
            if (header.order === 0 && !header.more_links) { this.stats.misread_first = (this.stats.misread_first || 0) + 1; return; }
            const key = `${group.channel},${header.address},${header.version}`;
            let series = this.openSeries.get(key);
            if (!series) {
                if (this.openSeries.size >= 64) {                 // too many open: give up on the oldest
                    let oldestKey = null, oldestSequence = Infinity;
                    for (const [openKey, open] of this.openSeries) {
                        if (open.sequence < oldestSequence) { oldestSequence = open.sequence; oldestKey = openKey; }
                    }
                    const oldest = this.openSeries.get(oldestKey);
                    this.openSeries.delete(oldestKey);
                    this._emit(oldest, false);
                }
                series = {
                    channel: group.channel, address: header.address, long_form: header.long_form, type: header.type,
                    flags: { ...header.flags }, version: header.version, extensions: header.extensions, parts: new Map(),
                    final: 999, intact: true, attested: false, header_attested: false, sequence: this.sequence++
                };
                this.openSeries.set(key, series);
            }
            if (header.order === 0) {
                series.flags = { ...header.flags }; series.extensions = header.extensions; series.type = header.type;
            }
            if (!group.intact) series.intact = false;
            if (attested) series.attested = true;
            if (header.attested) series.header_attested = true;
            if (!header.more_links) series.final = header.order;
            series.parts.set(header.order, [data, present]);
            series.clock = group.clock;
            // No record comes after the last one: a part held under a higher order had its order misread
            if (series.final <= 127) for (const order of [...series.parts.keys()]) if (order > series.final) series.parts.delete(order);
            if (series.final <= 127 && series.parts.size === series.final + 1) {
                this.openSeries.delete(key);
                this._emit(series, true);
            }
        }

        _emit(series, complete) {
            // A series that never received its first record is no message anyone was shown (decode-orc PR #328)
            if (!series.parts.has(0)) { this.stats.without_first = (this.stats.without_first || 0) + 1; return; }
            series.complete = complete;
            series.aligned = complete;
            series.records = series.parts.size;
            const orders = [...series.parts.keys()].sort((a, b) => a - b);
            series.data = [];
            series.present = [];
            for (const order of orders) {
                const [partData, partPresent] = series.parts.get(order);
                series.data = series.data.concat(partData);
                series.present = series.present.concat(partPresent);
            }
            this.onMessage(series);
        }

        flush() {
            for (const key of [...this.openSeries.keys()]) {
                const series = this.openSeries.get(key);
                this.openSeries.delete(key);
                this._emit(series, false);
            }
        }
    }

    // * * * Records (§5) * * *

    // ---------------------------------------------------------------------------
    // Record catalog and voting of damaged copies
    // A copy is [dataBytes, presentFlags]; presentFlags[i] is 0 where byte i was lost.
    // ---------------------------------------------------------------------------
    const MAX_COPIES = 64;                            // decode-orc PR #328 keeps 64 copies per record

    /** The length most copies agree on (ties go to the longer one). */
    const votedLength = (copies, included) => {
        let bestLength = 0, bestSupport = 0;
        copies.forEach(([data], i) => {
            if (included && !included[i]) return;
            let support = 0;
            copies.forEach(([otherData], j) => {
                if ((!included || included[j]) && otherData.length === data.length) support++;
            });
            if (support > bestSupport || (support === bestSupport && data.length > bestLength)) {
                bestLength = data.length;
                bestSupport = support;
            }
        });
        return bestLength;
    };

    /**
     * Byte-by-byte vote in three tiers (decode-orc PR #328): a byte whose block the suffix check vouched for
     * beats a parity-clean one, which beats a corrupt one; within a tier the most copies win, then the newest.
     * `vouching` (one flag per copy) says whose vouched bytes count as vouched; null = none.
     */
    // Columns 2 and 3 hold the PDI commands (and in text, the space, digits and punctuation): a reading there is
    // left to the grammar, which can tell a command from an operand
    const isCommandColumn = (byte) => (byte & 0x7F) >= 0x20 && (byte & 0x7F) <= 0x3F;
    const voteOverCopies = (copies, included, vouching = null) => {
        const length = votedLength(copies, included);
        const data = new Array(length).fill(0), present = new Array(length).fill(0), ties = [], contested = [], alternatives = [];
        for (let position = 0; position < length; position++) {
            const weight = new Map(), newestCopy = new Map(), vouchedWeight = new Map(), vouchedNewest = new Map();
            copies.forEach(([copyData, copyPresent], copyIndex) => {
                if (included && !included[copyIndex]) return;
                if (position >= copyData.length || (position < copyPresent.length && !copyPresent[position])) return;
                const value = copyData[position];
                weight.set(value, (weight.get(value) || 0) + 255);
                newestCopy.set(value, copyIndex);
                if (vouching && vouching[copyIndex] && copyPresent[position] === 2) {
                    vouchedWeight.set(value, (vouchedWeight.get(value) || 0) + 255);
                    vouchedNewest.set(value, copyIndex);
                }
            });
            if (!weight.size) continue;
            if (weight.size > 1) alternatives.push([position, [...weight.entries()]]);
            const tierOf = (value) => (vouchedWeight.has(value) ? 2 : ODD_PARITY[value]);
            const weightOf = (value) => (tierOf(value) === 2 ? vouchedWeight.get(value) : weight.get(value));
            const newestOf = (value) => (tierOf(value) === 2 ? vouchedNewest.get(value) : newestCopy.get(value));
            let winner = null;
            for (const value of weight.keys()) {
                if (winner === null) { winner = value; continue; }
                const tier = tierOf(value), winnerTier = tierOf(winner);
                if (tier < winnerTier) continue;
                if (tier === winnerTier && !(weightOf(value) > weightOf(winner) ||
                    (weightOf(value) === weightOf(winner) && newestOf(value) > newestOf(winner)))) continue;
                winner = value;
            }
            // JS-only: a reading that fails parity is one bit from what was sent, so it backs a passing reading one
            // bit away from it. Between two passing readings of one tier, the one such failed reads back (and the
            // other doesn't) wins when they outnumber the margin it lost by, outside columns 2 and 3 (CBS 1984-02-27 page 047: a line feed
            // held by 14 copies and backed by 25 reading 0x4A lost to "D" held by 11)
            if (tierOf(winner) >= 1 && !isCommandColumn(winner)) {
                const flipBacking = (value) => {
                    let backing = 0;
                    for (const [failed, failedWeight] of weight) {
                        if (ODD_PARITY[failed] || countSetBits((failed ^ value) & 0xFF) !== 1) continue;
                        backing += failedWeight;
                    }
                    return backing;
                };
                const winnerBacking = flipBacking(winner);
                let challenger = null, challengerScore = 0;
                for (const value of weight.keys()) {
                    if (value === winner || tierOf(value) !== tierOf(winner) || isCommandColumn(value)) continue;
                    // ... only where one of the two is a control code: a line feed read as a letter breaks a page's layout
                    if ((value & 0x7F) >= 0x20 && (winner & 0x7F) >= 0x20) continue;
                    const backing = flipBacking(value) - winnerBacking;
                    if (backing <= 0) continue;
                    const score = weightOf(value) + backing - weightOf(winner);
                    if (weightOf(value) < 2 * 255 || backing < weightOf(winner)) continue;
                    if (score > 0 && score > challengerScore) { challenger = value; challengerScore = score; }
                }
                if (challenger !== null) winner = challenger;
            }
            data[position] = winner;
            present[position] = tierOf(winner) === 2 ? 2 : 1;
            const tied = [...weight.keys()].filter((value) => value !== winner &&
                tierOf(value) === tierOf(winner) && weightOf(value) === weightOf(winner));
            if (tied.length) ties.push([position, [winner, ...tied]]);
            // JS-only: a reading outvoted but held by two or more copies and at least a sixth of the winner's weight,
            // passing parity as well, is kept as a contender the grammar may prefer (see settleContestedByGrammar)
            else {
                let runnerUp = null;
                for (const value of weight.keys()) {
                    if (value === winner || tierOf(value) !== tierOf(winner)) continue;
                    if (runnerUp === null || weightOf(value) > weightOf(runnerUp)) runnerUp = value;
                }
                if (runnerUp !== null && weightOf(runnerUp) >= 2 * 255 && weightOf(runnerUp) * 6 >= weightOf(winner)) contested.push([position, [winner, runnerUp]]);
            }
        }
        return [data, present, ties, contested, alternatives];
    };

    /** [bytes compared, bytes equal] between a copy (shifted by `slip`) and the vote. */
    const agreementWithVote = ([copyData, copyPresent], [voteData, votePresent], slip) => {
        let compared = 0, agreed = 0;
        for (let position = 0; position < voteData.length; position++) {
            const source = position + slip;
            if (!votePresent[position] || source < 0 || source >= copyData.length ||
                (source < copyPresent.length && !copyPresent[source])) continue;
            compared++;
            if (copyData[source] === voteData[position]) agreed++;
        }
        return [compared, agreed];
    };
    const isOutlier = ([compared, agreed]) => compared >= 16 && agreed * 100 < compared * 50;
    // A copy's vouched bytes outrank the rest only if it agrees with nearly all of the provisional vote
    const vouches = ([compared, agreed]) => compared > 0 && agreed * 100 >= compared * 90;
    const agreesBetter = ([comparedA, agreedA], [comparedB, agreedB]) =>
        agreedA * Math.max(1, comparedB) > agreedB * Math.max(1, comparedA);
    const shiftCopy = ([copyData, copyPresent], slip) => {
        const length = Math.max(0, copyData.length - slip);
        const data = new Array(length).fill(0), present = new Array(length).fill(0);
        for (let position = 0; position < length; position++) {
            const source = position + slip;
            if (source < 0 || source >= copyData.length || (source < copyPresent.length && !copyPresent[source])) continue;
            data[position] = copyData[source];
            present[position] = source < copyPresent.length ? copyPresent[source] : 1;
        }
        return [data, present];
    };

    /**
     * decode-orc PR #328: a copy whose group closed up over a block it lost without a hole agrees as far as that
     * block and holds the next block after it. Where fewer than half the copies reaching a position hold a byte, a
     * copy that (at the nearest 8 settled positions on one side) disagrees with the vote as it stands but agrees with
     * it one to three blocks further on abstains there. Returns, per copy, the positions to leave out (or null).
     */
    const CLOSED_UP_SHIFTS = [26, 27, 28, 52, 54, 56, 78, 81, 84], ALIGNMENT_WITNESSES = 8;
    const closedUpBytes = (copies, [voteData, votePresent], included) => {
        const length = voteData.length, holding = new Uint32Array(length), reaching = new Uint32Array(length);
        const has = ([data, present], position) => position < data.length && (position >= present.length || present[position] !== 0);
        copies.forEach((copy, c) => {
            if (included && !included[c]) return;
            const reach = Math.min(length, copy[0].length);
            for (let position = 0; position < reach; position++) {
                reaching[position]++;
                if (has(copy, position)) holding[position]++;
            }
        });
        const settled = (position) => votePresent[position] !== 0 && holding[position] >= 2 && holding[position] * 2 >= reaching[position];
        let any = false;
        for (let position = 0; position < length && !any; position++) any = holding[position] > 0 && !settled(position);
        if (!any) return null;
        const lanes = CLOSED_UP_SHIFTS.length + 1;
        let out = null;
        copies.forEach((copy, c) => {
            if (included && !included[c]) return;
            const [data] = copy, reach = Math.min(length, data.length), witnesses = [];
            const agreed = Array.from({ length: lanes }, () => [0]), judged = Array.from({ length: lanes }, () => [0]);
            for (let position = 0; position < reach; position++) {
                if (!has(copy, position) || !settled(position)) continue;
                witnesses.push(position);
                for (let lane = 0; lane < lanes; lane++) {
                    const at = position + (lane === 0 ? 0 : CLOSED_UP_SHIFTS[lane - 1]);
                    const counts = at < length && settled(at);
                    judged[lane].push(judged[lane][judged[lane].length - 1] + (counts ? 1 : 0));
                    agreed[lane].push(agreed[lane][agreed[lane].length - 1] + (counts && data[position] === voteData[at] ? 1 : 0));
                }
            }
            const majority = (lane, from, to) => {
                const count = judged[lane][to] - judged[lane][from];
                return count >= ALIGNMENT_WITNESSES / 2 && (agreed[lane][to] - agreed[lane][from]) * 2 >= count;
            };
            const moved = (from, to) => {
                const count = judged[0][to] - judged[0][from];
                if (count < ALIGNMENT_WITNESSES / 2 || majority(0, from, to)) return false;
                for (let lane = 1; lane < lanes; lane++) if (majority(lane, from, to)) return true;
                return false;
            };
            let next = 0;
            for (let position = 0; position < reach; position++) {
                while (next < witnesses.length && witnesses[next] < position) next++;
                if (!has(copy, position) || settled(position)) continue;
                const before = next > ALIGNMENT_WITNESSES ? next - ALIGNMENT_WITNESSES : 0;
                const after = Math.min(witnesses.length, next + ALIGNMENT_WITNESSES);
                if (!moved(before, next) && !moved(next, after)) continue;
                if (!out) out = copies.map(() => []);
                out[c].push(position);
            }
        });
        return out;
    };

    /** Vote a record from its damaged copies; copies that slipped by a few bytes are realigned. */
    const voteRecord = (copies) => {
        if (!copies.length) return [[], []];
        if (copies.length === 1) return copies[0];
        const provisional = voteOverCopies(copies), aligned = [...copies], included = copies.map(() => 1);
        const vouching = copies.map(() => 0);
        let dropped = 0;
        copies.forEach((copy, i) => {
            const unshifted = agreementWithVote(copy, provisional, 0);
            if (!isOutlier(unshifted)) { vouching[i] = vouches(unshifted) ? 1 : 0; return; }
            let best = unshifted, bestSlip = 0;
            for (let slip = -8; slip <= 8; slip++) {
                if (slip === 0) continue;
                const agreement = agreementWithVote(copy, provisional, slip);
                if (!isOutlier(agreement) && agreesBetter(agreement, best)) { best = agreement; bestSlip = slip; }
            }
            if (bestSlip) { aligned[i] = shiftCopy(copy, bestSlip); vouching[i] = vouches(best) ? 1 : 0; return; }
            included[i] = 0;
            dropped++;
        });
        const voters = dropped === 0 || dropped * 2 >= copies.length ? null : included;
        const closedUp = closedUpBytes(aligned, provisional, voters);
        if (closedUp) {
            closedUp.forEach((positions, c) => {
                if (!positions.length) return;
                const [data, present] = aligned[c], placed = Array.from({ length: data.length }, (_, i) => (i < present.length ? present[i] : 1));
                for (const position of positions) placed[position] = 0;
                aligned[c] = [data, placed];
            });
        }
        return voteOverCopies(aligned, voters, vouching);
    };

    /** The "More" successor by the +1 rule on the two low BCD digits (…09 → …10). */
    const nextPageAddress = (address) => {
        const tens = (address >> 4) & 0xF, units = address & 0xF;   // low byte only: safe in 32-bit
        if (tens > 9 || units > 9) return null;
        const next = tens * 10 + units + 1;
        if (next > 99) return null;
        return (address - (address % 256)) + ((Math.floor(next / 10) << 4) | (next % 10));
    };

    /**
     * The More record a header extension names (§5.2.8.4): an address on this channel, NO_MORE when it designates
     * something else (a macro or another channel), or null when no extension redefines the More record.
     */
    const NO_MORE = -1;
    const moreAddressFromExtensions = (extensions, channel = 0) => {
        const number = (digits) => digits.reduce((value, digit) => value * 16 + (digit & 0xF), 0);
        for (const [meaning, size, digits] of extensions) {
            if (meaning !== 1 || digits.length !== size) continue;
            if (size === 0) return 0;
            if (size === 3) return number(digits) * 256;
            if (size === 9) return number(digits);
            if (size === 2) {
                const column = digits[0] & 0xF;
                if (column >= 2 && column <= 7) return NO_MORE;          // a macro, not a record
                continue;
            }
            if (size === 6 || size === 12) {
                const named = number(digits.slice(0, 3));
                if (named !== channel) return NO_MORE;
                return size === 6 ? number(digits.slice(3)) * 256 : number(digits.slice(3));
            }
        }
        return null;
    };

    const FLAGS_VOTED = ['caption', 'cyclic', 'priority', 'alarm', 'update', 'support_record',
        'support_needed', 'index', 'more'];

    const MAX_GRAMMAR_TRIALS = 32;                   // per record: each trial interprets the whole record
    let grammarChecker = null, roleReader = null;
    const ROLE_UNREAD = 0, ROLE_CONTROL = 1, ROLE_TRANSPARENT = 2, ROLE_TEXT = 3, ROLE_PDI = 4, ROLE_DEFINITION = 5, ROLE_OTHER = 6;

    /** How a receiver freshly reset reads each byte of a record: text, PDI, control … (naplps_read_roles). */
    const readRoles = (bytes) => {
        if (!roleReader) {
            roleReader = new Interpreter([256, 200]);
            roleReader.checkingOnly = true;
            roleReader.traceRoles = true;
        }
        roleReader.resetDecoder();
        roleReader.run(bytes);
        return roleReader.roles;
    };

    const grammarProblems = (bytes) => {
        if (!grammarChecker) {
            grammarChecker = new Interpreter([256, 200]);
            grammarChecker.checkingOnly = true;
        }
        grammarChecker.resetDecoder();
        grammarChecker.run(bytes);
        let characters = 0;
        for (const prim of grammarChecker.prims) if (prim.kind === 'char') characters++;
        return [grammarChecker.lintSevere, grammarChecker.lint, grammarChecker.firstSevereAt, [...grammarChecker.problemsAt], characters];
    };

    const settleTiesByGrammar = (data, ties) => {
        let best = data, [bestSevere, bestProblems, firstSevereAt] = grammarProblems(data);
        const untried = new Map(ties);
        let trials = 0;
        while (bestSevere > 0 && trials < MAX_GRAMMAR_TRIALS) {
            // Only a byte read before the first problem can have caused it: try the nearest one first.
            let position = -1;
            for (const tied of untried.keys()) if (tied < firstSevereAt && tied > position) position = tied;
            if (position < 0) break;
            const candidates = untried.get(position);
            untried.delete(position);
            for (const candidate of candidates.slice(1)) {
                trials++;
                const trial = [...best];
                trial[position] = candidate;
                const [severe, problems, severeAt] = grammarProblems(trial);
                if (severe < bestSevere && (problems < bestProblems || severe === 0)) {
                    best = trial; bestSevere = severe; bestProblems = problems; firstSevereAt = severeAt;
                    break;
                }
            }
        }
        return bestSevere === 0 ? best : data;       // only a vote that reads cleanly is trusted
    };

    /**
     * JS-only: a byte most copies misread the same way, where a few copies hold another reading that passes parity
     * too, is settled by the grammar when the other reading takes away a problem and adds no severe one. A
     * damaged-alike majority is common where a byte's bits sit badly on a worn tape (WIVB's master index: ten copies
     * read the second stroke of its "W" logo's 0x58 as 0x28, LINE, which broke the stroke and drew a line off the
     * screen; two held 0x58, as the stroke repeated 32 bytes on has it).
     */
    const MAX_CONTESTED_TRIALS = 24, TIE_SETTLE_MIN_COPIES = 8;
    const settleContestedByGrammar = (data, contested) => {
        let best = data, [bestSevere, bestProblems, , problemsAt] = grammarProblems(data);
        if (!bestProblems) return data;
        const untried = new Map(contested);
        let trials = 0;
        // Each problem in turn: only a byte read shortly before it can have caused it, most likely the nearest
        for (let k = 0; k < problemsAt.length && trials < MAX_CONTESTED_TRIALS && bestProblems > 0; k++) {
            const problemAt = problemsAt[k];
            const near = [...untried.keys()].filter((at) => at <= problemAt && problemAt - at <= 64).sort((p, q) => q - p);
            for (const position of near.slice(0, 4)) {
                if (trials >= MAX_CONTESTED_TRIALS) break;
                const [, candidate] = untried.get(position);
                untried.delete(position);
                trials++;
                const trial = [...best];
                trial[position] = candidate;
                const [severe, problems] = grammarProblems(trial);
                if (severe <= bestSevere && problems < bestProblems) {
                    best = trial; bestSevere = severe; bestProblems = problems;
                    break;
                }
            }
        }
        return best;
    };

    /**
     * JS-only: pages draw the same figure more than once (a logo in two colors, a shadow under it), so a stretch of
     * bytes misread alike in every copy is often found intact elsewhere in the record. Where the grammar finds a
     * problem, the 22 bytes around it are looked for elsewhere in the record, matching but for one to four bytes
     * at it; those bytes are taken from the other copy of the stretch when that takes the problem away and
     * adds no severe one (CBS 1984-02-27 page 050: "GGB" read as "G'\"", POINT and TEXT, in the first of its two
     * ExtraVision logos, which an error burst that cancelled itself out in the packet's check let through).
     */
    const TEMPLATE_BEFORE = 12, TEMPLATE_AFTER = 10, TEMPLATE_SLACK = 3, TEMPLATE_MAX_DIFFERENCES = 4, MAX_TEMPLATE_TRIALS = 24;
    const repairBySelfTemplate = (data) => {
        let best = data, [bestSevere, bestProblems, , problemsAt] = grammarProblems(data);
        if (!bestProblems) return data;
        let trials = 0;
        const done = new Set();
        for (const problemAt of problemsAt) {
            if (trials >= MAX_TEMPLATE_TRIALS || bestProblems === 0) break;
            const from = problemAt - TEMPLATE_BEFORE, to = problemAt + TEMPLATE_AFTER;
            if (from < 0 || to > best.length) continue;
            const value = (k) => best[k] & 0x7F;
            let repaired = false;
            for (let q = 0; q + (to - from) <= best.length && trials < MAX_TEMPLATE_TRIALS && !repaired; q++) {
                if (Math.abs(q - from) < to - from) continue;
                // The stretch must match exactly but for a few bytes at the problem and just before it
                const differing = [];
                let fits = true;
                for (let k = 0; k < to - from && fits; k++) {
                    if (value(from + k) === value(q + k)) continue;
                    const at = from + k;
                    if (at < problemAt - TEMPLATE_SLACK || at > problemAt + 2 || differing.length >= TEMPLATE_MAX_DIFFERENCES) fits = false;
                    else differing.push(k);
                }
                if (!fits || !differing.length) continue;
                const key = differing.map((k) => `${from + k}:${value(q + k)}`).join(',');
                if (done.has(key)) continue;
                done.add(key);
                trials++;
                const trial = [...best];
                for (const k of differing) trial[from + k] = withOddParity(value(q + k));
                const [severe, problems] = grammarProblems(trial);
                if (severe <= bestSevere && problems < bestProblems) { best = trial; bestSevere = severe; bestProblems = problems; repaired = true; }
            }
        }
        return best;
    };

    /**
     * JS-only: CBS 1984-02-27 misreads bits 6 and 5 of a byte swapped (01 for 10: 0x5C as 0x3C, 0x47 as 0x27), which
     * passes parity and turns an operand into a command. Where the grammar finds a problem, a byte from 0x20 to 0x3F
     * just after a drawing command it left with no operands is tried as the operand from 0x40 to 0x5F it would be swapped back, and kept when the
     * problem goes, no severe one comes and another page of the recording holds the command so put right (its
     * opcode and three operand bytes), twice a record at most (pages 094 to 096: a background rectangle that lost its size, drawing them
     * black instead of gray).
     */
    const MAX_SWAP_TRIALS = 24, MAX_SWAPS = 2, SWAP_EVIDENCE = 4, SWAP_LOOKBACK = 4, SWAP_UNEVIDENCED_GAIN = 2;
    const repairBySwappedBits = (data, seenElsewhere, unevidenced = false) => {
        let best = data, [bestSevere, bestProblems, , problemsAt] = grammarProblems(data);
        if (!bestProblems) return data;
        const isCommand = (k) => (best[k] & 0x7F) >= 0x20 && (best[k] & 0x7F) <= 0x3F;
        // The bytes a problem may come from, each with the runs that must hold it elsewhere in the recording
        const candidatesFor = (problemAt) => {
            const candidates = [], command = best[problemAt] & 0x7F;
            // The byte just after a drawing command left with no operands
            if (command >= 0x28 && command <= 0x37 && problemAt + 1 < best.length && isCommand(problemAt + 1)) {
                candidates.push({ at: problemAt + 1, evidenceFrom: [problemAt], lookedBack: false });
            }
            const runsAround = (at) => [at - 3, at - 2, at - 1, at].filter((from) => from >= 0);
            // JS-only: the command byte at the problem itself, where it came straight after an operand: it may be the
            // operand that went on (CBS 1984-10-02's second copy of page 008: POINT SET 0x4B read as 0x2B, LINE, which
            // moved the REAGAN story and piled its first lines along the bottom)
            if (problemAt >= 1 && isCommand(problemAt) && (best[problemAt - 1] & 0x7F) >= 0x40) {
                candidates.push({ at: problemAt, evidenceFrom: runsAround(problemAt), lookedBack: false });
            }
            // JS-only: a few bytes before the problem, a command byte straight after another command, which may be
            // the first one's operand (Finance on CBS 1984-10-02: POINT SET 0x4A read as 0x2A, twice, drew the "N" of
            // its title askew and a stray line across the page)
            for (let k = problemAt - 1; k >= Math.max(1, problemAt - SWAP_LOOKBACK); k--) {
                if (isCommand(k) && isCommand(k - 1)) { candidates.push({ at: k, evidenceFrom: runsAround(k), lookedBack: true }); break; }
            }
            return candidates;
        };
        let trials = 0, swaps = 0;
        const tried = new Set();
        for (const problemAt of problemsAt) {
            if (trials >= MAX_SWAP_TRIALS || !bestProblems || swaps >= MAX_SWAPS) break;
            for (const { at, evidenceFrom, lookedBack } of candidatesFor(problemAt)) {
                if (tried.has(at) || trials >= MAX_SWAP_TRIALS) continue;
                tried.add(at);
                trials++;
                const trial = [...best];
                trial[at] = withOddParity((best[at] & 0x7F) ^ 0x60);
                // The command as put right must be one the recording sends elsewhere, byte for byte; a swap found by
                // looking back may do without in a record kept from an intact copy, where it takes two problems or more
                // away (a title drawn once); a voted record leaves such bytes to the recording's own confusions
                const evidenced = evidenceFrom.some((from) => seenElsewhere(trial, from));
                if (!evidenced && !(lookedBack && unevidenced)) continue;
                const [severe, problems] = grammarProblems(trial);
                const gain = bestProblems - problems;
                if (severe <= bestSevere && gain > 0 && (evidenced || gain >= SWAP_UNEVIDENCED_GAIN)) {
                    best = trial; bestSevere = severe; bestProblems = problems; swaps++;
                    break;
                }
            }
        }
        return best;
    };

    /**
     * JS-only: CBS 1985-06-29 also misreads a byte's parity bit and bit 6 swapped (0x68 received as 0xA8, which passes
     * parity and reads as 0x28, LINE), so a whole copy can pass every check with an operand turned into a command.
     * Where the grammar finds a problem, a command byte that arrived with its parity bit set and bit 6 clear, at the
     * problem or just before it, is tried as the operand the swap would have come from; it is kept when it takes away eight problems or more, leaves three or fewer (or a twentieth), and
     * at least a quarter of the record's problems (a misread command throws everything after it out of step: one such
     * byte on the "Lone Justice" ad made 340 problems, and the poster drew as abstract shapes) and adds no severe one.
     */
    const MAX_HIGH_SWAPS = 8, HIGH_SWAP_LOOKBACK = 3, HIGH_SWAP_TRIALS = 48, HIGH_SWAP_MIN_GAIN = 8, HIGH_SWAP_LEFT = 3;
    // JS-only: the swap the other way turns SI or SO (0x8F, 0x8E) into "O" or "N" (0x4F, 0x4E), and the text after it
    // runs as drawing commands, its spaces as RESETs, until the grammar breaks a phrase later (CBS 1984-10-02 page
    // 005: "News Update (cont.)" cleared the screen, leaving the page black)
    const SHIFT_SWAP_LOOKBACK = 24, SHIFT_SWAP_VETO_COPIES = 8;
    const highSwapped = (byte) => {
        if ((byte & 0xC0) === 0x80 && (byte & 0x7F) >= 0x20 && (byte & 0x7F) <= 0x3F) return (byte & 0x3F) | 0x40;
        if (byte === 0x4E || byte === 0x4F) return byte ^ 0xC0;
        return null;
    };
    const repairByHighBitSwap = (data, ruledOut = null) => {
        let best = data, [bestSevere, bestProblems, , problemsAt] = grammarProblems(data);
        let trials = 0;
        for (let swaps = 0; swaps < MAX_HIGH_SWAPS && bestProblems > 0 && trials < HIGH_SWAP_TRIALS; swaps++) {
            let improved = false;
            const tried = new Set();
            for (const problemAt of problemsAt.slice(0, 16)) {
                for (let at = Math.max(0, problemAt - SHIFT_SWAP_LOOKBACK); at <= problemAt && at < best.length; at++) {
                    const byte = best[at], swapped = highSwapped(byte);
                    if (tried.has(at) || swapped === null) continue;
                    if (byte & 0x80 && at < problemAt - HIGH_SWAP_LOOKBACK) continue;
                    // An SI or SO is not put back where many copies received the byte and none as that: an "O" they
                    // all agree on is an operand (CBS 1984-01-02's Hollywood Hotline: all 133 copies read 0x4F, and as
                    // SI it ran the page's drawing code out as text)
                    if (!(byte & 0x80) && ruledOut && ruledOut(at, swapped)) continue;
                    tried.add(at);
                    if (++trials > HIGH_SWAP_TRIALS) break;
                    const trial = [...best];
                    trial[at] = swapped;
                    const [severe, problems, , at2] = grammarProblems(trial);
                    if (severe <= bestSevere && bestProblems - problems >= Math.max(HIGH_SWAP_MIN_GAIN, bestProblems / 4) &&
                        problems <= Math.max(HIGH_SWAP_LEFT, bestProblems / 20)) {
                        best = trial; bestSevere = severe; bestProblems = problems; problemsAt = at2; improved = true;
                        break;
                    }
                }
                if (improved || trials > HIGH_SWAP_TRIALS) break;
            }
            if (!improved) break;
        }
        return best;
    };

    /**
     * JS-only: a byte the whole recording tends to misread one way (WIVB's tape reads 0x58 as 0x28, LINE, again
     * and again) is put back where every copy of a record misread it alike: just before a grammar problem, a PDI
     * opcode the recording usually confuses with an operand byte is tried as that operand, and kept when it takes
     * the problem away and adds no severe one.
     */
    const CONFUSION_MIN_COUNT = 8, CONFUSION_REACH = 24, MAX_CONFUSION_TRIALS = 32, CONFUSION_TEXT_SLACK = 0;
    const repairByConfusions = (data, present, partners) => {
        let best = data, [bestSevere, bestProblems, , problemsAt, bestCharacters] = grammarProblems(data);
        if (!bestProblems) return data;
        const tried = new Set();
        let trials = 0;
        for (let k = 0; k < problemsAt.length && trials < MAX_CONFUSION_TRIALS && bestProblems > 0; k++) {
            const problemAt = problemsAt[k];
            let fixed = false;
            for (let position = problemAt; position >= Math.max(0, problemAt - CONFUSION_REACH) && !fixed; position--) {
                if (tried.has(position) || (present && present[position] === 0)) continue;
                // Only a PDI opcode misread from an operand byte, or the other way round: the opcode cuts a figure
                // short and sends the rest of its operands to another command, the operand runs one figure on into the
                // next (WIVB's 0x24, POINT SET, read as 0x64), and the grammar sees both; it can't judge other
                // readings (text, controls) as well. Never RESET (0x20): it clears the screen and the state
                const value = best[position] & 0x7F, opcode = value >= 0x20 && value <= 0x3F;
                if (value < 0x20) continue;
                const list = (partners.get(value) || []).filter(([partner]) => (opcode ? partner >= 0x40 : partner > 0x20 && partner <= 0x3F));
                if (!list.length) continue;
                tried.add(position);
                for (const [partner] of list.slice(0, 2)) {
                    if (trials++ >= MAX_CONFUSION_TRIALS) break;
                    const trial = [...best];
                    trial[position] = withOddParity(partner);
                    const [severe, problems, , , characters] = grammarProblems(trial);
                    // ... and the text stays: a repair that loses characters has turned text into figure data
                    if (severe <= bestSevere && problems < bestProblems && characters >= bestCharacters - CONFUSION_TEXT_SLACK) {
                        best = trial; bestSevere = severe; bestProblems = problems; bestCharacters = characters; fixed = true;
                        break;
                    }
                }
            }
        }
        return best;
    };

    /**
     * JS-only: a contested byte inside a POINT SET's coordinate, which the grammar can't judge (any value is a
     * coordinate), is settled by the drawing: pages repeat a figure at another place (WIVB's three suns), and the
     * reading that puts the point where the figure's other copies have theirs, relative to the points either side,
     * is taken. Ten copies of the Extended Forecast read one of the middle sun's rays a few pixels low; two had it.
     */
    const MAX_MOTIF_TRIALS = 32, MOTIF_TOLERANCE = 1 / 1024;
    const pointTraceOf = (bytes) => {
        if (!grammarChecker) grammarProblems([]);
        grammarChecker.pointTrace = [];
        const [severe, problems] = grammarProblems(bytes);
        const trace = grammarChecker.pointTrace;
        grammarChecker.pointTrace = null;
        return [trace, severe, problems];
    };
    /** Whether the point at `k` sits, relative to its neighbors, where another copy of the figure puts it. */
    const inMotif = (points, k) => {
        if (k < 1 || k + 1 >= points.length) return null;
        const near = (a, b) => Math.abs(a - b) <= MOTIF_TOLERANCE;
        for (let j = 1; j + 1 < points.length; j++) {
            if (j === k) continue;
            const dx = points[j][0] - points[k][0], dy = points[j][1] - points[k][1];
            if (Math.abs(dx) < MOTIF_TOLERANCE && Math.abs(dy) < MOTIF_TOLERANCE) continue;
            if (near(points[j - 1][0] - points[k - 1][0], dx) && near(points[j - 1][1] - points[k - 1][1], dy) &&
                near(points[j + 1][0] - points[k + 1][0], dx) && near(points[j + 1][1] - points[k + 1][1], dy)) return true;
        }
        return false;
    };
    const settleContestedByMotif = (data, contested) => {
        let [trace, bestSevere, bestProblems] = pointTraceOf(data);
        if (trace.length < 6) return data;
        let best = data, trials = 0;
        for (const [position, [, candidate]] of contested) {
            if (trials >= MAX_MOTIF_TRIALS) break;
            const index = trace.findIndex((entry) => position > entry.from && position < entry.to);
            if (index < 0 || trace[index].points.length !== 1) continue;
            const points = trace.map((entry) => entry.points[0]);
            if (inMotif(points, index) !== false) continue;
            trials++;
            const trial = [...best];
            trial[position] = candidate;
            const [trialTrace, severe, problems] = pointTraceOf(trial);
            if (trialTrace.length !== trace.length || severe > bestSevere || problems > bestProblems) continue;
            if (inMotif(trialTrace.map((entry) => entry.points[0]), index)) {
                best = trial; trace = trialTrace; bestSevere = severe; bestProblems = problems;
            }
        }
        return best;
    };

    /**
     * JS-only: a word whose letters the copies read differently is settled by the recording's own vocabulary, the
     * words its pages show where every copy agreed: of the readings the copies give ("Uovjet", "[ovjet", "Sovjet",
     * "Soviet" …), the one the recording spells elsewhere is taken ("Soviet officials" on the same page). Only
     * letters are swapped for letters, so the page's layout can't change; a word no reading of which is in the
     * vocabulary is left as voted.
     */
    const WORD_MIN_LETTERS = 3, WORD_MAX_CONTESTED = 4, WORD_MAX_READINGS = 64;
    const isLetter = (byte) => { const c = byte & 0x7F; return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A); };
    const wordsOf = (data, roles) => {
        const words = [];
        let start = -1;
        for (let i = 0; i <= data.length; i++) {
            const inWord = i < data.length && roles[i] === ROLE_TEXT && isLetter(data[i]);
            if (inWord && start < 0) start = i;
            if (!inWord && start >= 0) { if (i - start >= WORD_MIN_LETTERS) words.push([start, i]); start = -1; }
        }
        return words;
    };
    const spell = (data, from, to) => String.fromCharCode(...data.slice(from, to).map((byte) => byte & 0x7F)).toLowerCase();
    const settleWordsByVocabulary = (records, readingsOf) => {
        if (!readingsOf.size) return;
        const vocabulary = new Map(), pending = [];
        for (const record of records) {
            if (!record.data || !record.data.length || !isPresentation(record.type)) continue;
            const roles = readRoles(record.data), readings = new Map(readingsOf.get(record) || []);
            for (const [from, to] of wordsOf(record.data, roles)) {
                const contested = [];
                for (let i = from; i < to; i++) if (readings.has(i)) contested.push(i);
                if (!contested.length) {
                    const word = spell(record.data, from, to);
                    vocabulary.set(word, (vocabulary.get(word) || 0) + 1);
                } else if (contested.length <= WORD_MAX_CONTESTED) pending.push([record, from, to, contested, readings]);
            }
        }
        // Letter pairs the vocabulary uses: a voted spelling with a pair no agreed word has ("Uovjet": "uo", "vj")
        // is not a word, and is put right when a reading the vocabulary has twice or more is among the copies'. A
        // spelling with no such pair may be a real word ("Fare", "Wild") and is let stand
        const pairs = new Set();
        for (const word of vocabulary.keys()) for (let i = 0; i + 1 < word.length; i++) pairs.add(word.slice(i, i + 2));
        const oddPair = (word) => { for (let i = 0; i + 1 < word.length; i++) if (!pairs.has(word.slice(i, i + 2))) return true; return false; };
        for (const [record, from, to, contested, readings] of pending) {
            const votedWord = spell(record.data, from, to);
            if (vocabulary.has(votedWord)) continue;
            if (!oddPair(votedWord)) continue;
            const minimumCount = 2;
            // Every combination of the letters the copies read at the contested positions
            let combinations = [[]];
            for (const position of contested) {
                // A letter of the same case, held by at least a third as many copies as the vote's: a reading the copies
                // all but ruled out, or one that changes a capital, is not one to choose by spelling
                const voted = record.data[position], votedWeight = readings.get(position).find(([value]) => value === voted)?.[1] || 0;
                const upper = (byte) => (byte & 0x7F) < 0x60;
                const letters = readings.get(position).filter(([value, weight]) => isLetter(value) &&
                    upper(value) === upper(voted) && weight * 3 >= votedWeight).map(([value]) => value);
                if (!letters.includes(voted)) letters.push(voted);
                combinations = combinations.flatMap((partial) => letters.map((letter) => [...partial, letter]));
                if (combinations.length > WORD_MAX_READINGS) break;
            }
            if (combinations.length > WORD_MAX_READINGS) continue;
            let best = null, bestCount = 0, tie = false;
            for (const letters of combinations) {
                const trial = record.data.slice(from, to);
                contested.forEach((position, k) => { trial[position - from] = letters[k]; });
                const count = vocabulary.get(spell(trial, 0, trial.length)) || 0;
                if (count > bestCount) { best = letters; bestCount = count; tie = false; } else if (count && count === bestCount) tie = true;
            }
            if (!best || tie || bestCount < minimumCount) continue;
            const data = record.data.slice();
            contested.forEach((position, k) => { data[position] = best[k]; });
            record.data = data;
        }
    };

    /**
     * JS-only: letters a recording misreads the same way in every copy (WSBT 1984 reads "the" as "t(j", "t(e" or
     * "thj" a third of the time: h as "(", e as "j") are learned from the recording itself and put back. A spelling
     * seen far less often than one a letter or two away from it ("thj" 13 times, "the" 170) teaches that swap; swaps
     * taught 20 or more times are applied to spellings no more than a fifth as common as what they become.
     */
    const SYSTEMATIC_MIN_LESSONS = 20, SYSTEMATIC_STRONG_LESSONS = 50, SYSTEMATIC_RATIO = 5, SYSTEMATIC_MIN_WORD = 3;
    const isWordByte = (byte) => isLetter(byte) || (byte & 0x7F) === 0x28;
    const settleSystematicMisreads = (records) => {
        const spans = [], counts = new Map();
        for (const record of records) {
            if (!record.data || !record.data.length || !isPresentation(record.type)) continue;
            const roles = readRoles(record.data);
            let start = -1;
            for (let i = 0; i <= record.data.length; i++) {
                const inWord = i < record.data.length && roles[i] === ROLE_TEXT && isWordByte(record.data[i]);
                if (inWord && start < 0) start = i;
                if (!inWord && start >= 0) {
                    if (i - start >= SYSTEMATIC_MIN_WORD) {
                        const word = spell(record.data, start, i);
                        spans.push([record, start, i, word]);
                        counts.set(word, (counts.get(word) || 0) + 1);
                    }
                    start = -1;
                }
            }
        }
        // Group spellings by length, to find the common word a letter or two from a rare one
        const byLength = new Map();
        for (const [word, count] of counts) {
            if (!byLength.has(word.length)) byLength.set(word.length, []);
            byLength.get(word.length).push([word, count]);
        }
        for (const list of byLength.values()) list.sort((a, b) => b[1] - a[1]);
        const nearestCommon = (word, count) => {
            for (const [other, otherCount] of byLength.get(word.length) || []) {
                if (otherCount < count * SYSTEMATIC_RATIO) break;
                if (other.includes('(')) continue;
                let differences = 0;
                for (let i = 0; i < word.length && differences < 3; i++) if (word[i] !== other[i]) differences++;
                if (differences && differences <= 2) return other;
            }
            return null;
        };
        // Only a spelling that can't be a word is taken for a misreading: one with a "(" in it, or a letter pair no
        // spelling seen three times or more has ("thj": "hj"); "are" next to "the" teaches nothing
        const pairs = new Set();
        for (const [word, count] of counts) {
            if (count < 3 || word.includes('(')) continue;
            for (let i = 0; i + 1 < word.length; i++) pairs.add(word.slice(i, i + 2));
        }
        const misread = (word) => {
            if (word.includes('(')) return true;
            for (let i = 0; i + 1 < word.length; i++) if (!pairs.has(word.slice(i, i + 2))) return true;
            return false;
        };
        const lessons = new Map();
        for (const [word, count] of counts) {
            if (!misread(word)) continue;
            const other = nearestCommon(word, count);
            if (!other) continue;
            for (let i = 0; i < word.length; i++) if (word[i] !== other[i]) {
                const key = word[i] + other[i];
                lessons.set(key, (lessons.get(key) || 0) + count);
            }
        }
        const swaps = new Set([...lessons].filter(([, n]) => n >= SYSTEMATIC_MIN_LESSONS).map(([key]) => key));
        if (!swaps.size) return;
        // A spelling with nothing odd about it is put right too where a single letter, swapped as the recording
        // swaps it most often (50 times or more), makes it a far commoner word: "thj" (common enough to have its
        // letter pairs counted) becomes "the"
        const strongSwaps = new Set([...lessons].filter(([, n]) => n >= SYSTEMATIC_STRONG_LESSONS).map(([key]) => key));
        const oneStrongSwap = (word, other) => {
            let differences = 0, strong = true;
            for (let i = 0; i < word.length; i++) if (word[i] !== other[i]) { differences++; if (!strongSwaps.has(word[i] + other[i])) strong = false; }
            return differences === 1 && strong;
        };
        for (const [record, from, to, word] of spans) {
            if (!misread(word)) {
                const other = nearestCommon(word, counts.get(word));
                if (!other || !oneStrongSwap(word, other)) continue;
            }
            // Words in capitals (names, call letters, headings) are left: their letter pairs are no guide
            const original = spell(record.data, from, to).length && String.fromCharCode(...record.data.slice(from, to).map((byte) => byte & 0x7F));
            if (original.slice(1) === original.slice(1).toUpperCase() && /[A-Z]/.test(original.slice(1))) continue;
            const other = nearestCommon(word, counts.get(word));
            if (!other) continue;
            let allowed = true;
            for (let i = 0; i < word.length; i++) if (word[i] !== other[i] && !swaps.has(word[i] + other[i])) { allowed = false; break; }
            if (!allowed) continue;
            const data = record.data.slice();
            for (let i = 0; i < word.length; i++) {
                if (word[i] === other[i]) continue;
                // Keep the letter's case: the vocabulary is spelled in lower case
                const original = data[from + i] & 0x7F, upper = original >= 0x41 && original <= 0x5A;
                const code = upper ? other.toUpperCase().charCodeAt(i) : other.charCodeAt(i);
                data[from + i] = withOddParity(code);
            }
            record.data = data;
        }
    };

    // ---------------------------------------------------------------------------
    // Contents (decode-orc PR #328): one identity (channel, address, version) can carry more than one page over a
    // recording — a carousel's versions come round again with new pages, a page is replaced without its version
    // moving. A copy that agrees with none of the contents held under its identity starts one of its own.
    // ---------------------------------------------------------------------------
    const SAME_CONTENT_PERCENT = 50, MAX_RECORD_SLIP = 8, OUTLIER_MIN_JUDGED = 16;
    const CONTENT_WINDOW_BYTES = 54, CONTENT_WINDOW_SLIP = 32, CONTENT_WINDOW_MIN_JUDGED = 8, CONTENT_WINDOW_PERCENT = 70;
    const JOIN_WINDOW_SLIP = 81;
    const PAGE_DIFFERENCE_BYTES = 32, PAGE_DIFFERENCE_RUN = 4, PAGE_DIFFERENCE_QUIET_REACH = 14, PAGE_DIFFERENCE_QUIET_FAILURES = 2;
    const PAGE_DIFFERENCE_VOUCHED_BYTES = 6, PAGE_DIFFERENCE_VOUCHED_PERCENT = 8, DISPLACEMENT_CONTEXT = 3, DISPLACEMENT_REACH = 96;
    const IDENTITY_MIN_JUDGED = 48, MISREAD_VERSION_RATIO = 20, MISREAD_VERSION_MIN_MAIN = 20, MISREAD_VERSION_AGREEMENT = 0.9;
    const MISADDRESSED_SEEN_RATIO = 4, SAME_IDENTITY_CONTENT = 0.5;
    const OVERRULE_MIN_COPIES = 3, OVERRULE_SHARE = 0.9;
    const MISNAMED_MAX_SEEN = 2, MISNAMED_SEEN_RATIO = 10, MISNAMED_AGREEMENT = 0.9;

    /** A copy's bytes as the content comparisons read them: each byte where it arrived passing parity, else -1. */
    const readingCache = new WeakMap();
    const byteReading = (copy) => {
        let reading = readingCache.get(copy);
        if (reading) return reading;
        const [data, present] = copy, n = data.length;
        const usable = new Int16Array(n), arrived = new Uint8Array(n), vouched = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            const came = i >= present.length || present[i] !== 0;
            arrived[i] = came ? 1 : 0;
            usable[i] = came && ODD_PARITY[data[i] & 0xFF] ? data[i] : -1;
            vouched[i] = usable[i] >= 0 && i < present.length && present[i] === 2 ? 1 : 0;
        }
        reading = { n, usable, arrived, vouched, index: null };
        readingCache.set(copy, reading);
        return reading;
    };
    /** Where each usable byte value stands in a reading, and a running count of usable bytes (for the fast paths). */
    const readingIndex = (reading) => {
        if (reading.index) return reading.index;
        const { n, usable } = reading, start = new Int32Array(257), prefix = new Int32Array(n + 1);
        for (let i = 0; i < n; i++) {
            prefix[i + 1] = prefix[i] + (usable[i] >= 0 ? 1 : 0);
            if (usable[i] >= 0) start[usable[i] + 1]++;
        }
        for (let v = 0; v < 256; v++) start[v + 1] += start[v];
        const fill = start.slice(0, 256), positions = new Int32Array(prefix[n]);
        for (let i = 0; i < n; i++) if (usable[i] >= 0) positions[fill[usable[i]]++] = i;
        reading.index = { start, positions, prefix };
        return reading.index;
    };
    /** First index in positions[lo, hi) holding a value ≥ target. */
    const lowerBound = (positions, lo, hi, target) => {
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (positions[mid] < target) lo = mid + 1; else hi = mid;
        }
        return lo;
    };
    let slipCounts = new Int32Array(0);
    const usableAt = (reading, position) => (position >= 0 && position < reading.n ? reading.usable[position] : -1);
    const failingAt = (reading, position) => position >= 0 && position < reading.n && reading.arrived[position] === 1 && reading.usable[position] < 0;

    /** [judged, agreed]: `copy`'s byte p + slip read as `held`'s byte p, over the bytes both hold passing parity. */
    const contentAgreementAt = (held, copy, slip, from = 0, to = Infinity) => {
        let judged = 0, agreed = 0;
        const end = Math.min(to, held.n), first = Math.max(from, -slip), last = Math.min(end, copy.n - slip);
        for (let p = first; p < last; p++) {
            const a = held.usable[p];
            if (a < 0) continue;
            const b = copy.usable[p + slip];
            if (b < 0) continue;
            judged++;
            if (a === b) agreed++;
        }
        return [judged, agreed];
    };

    /**
     * contentAgreementAt for every slip in [-maxSlip, maxSlip] at once over the whole of `held`: [judged[], agreed[]],
     * indexed by slip + maxSlip. Counted from where each byte value stands in the copy (same counts, fewer steps).
     */
    const allSlipAgreements = (held, copy, maxSlip) => {
        const span = 2 * maxSlip + 1, judged = new Int32Array(span), agreed = new Int32Array(span);
        const { start, positions, prefix } = readingIndex(copy), heldBytes = held.usable, copyBytes = copy.usable;
        const unusable = [];
        for (let p = 0; p < held.n; p++) {
            const value = heldBytes[p];
            if (value < 0) { unusable.push(p); continue; }
            const end = start[value + 1];
            for (let i = lowerBound(positions, start[value], end, p - maxSlip); i < end; i++) {
                const slip = positions[i] - p;
                if (slip > maxSlip) break;
                agreed[slip + maxSlip]++;
            }
        }
        for (let slip = -maxSlip; slip <= maxSlip; slip++) {
            const first = Math.max(0, -slip), last = Math.min(held.n, copy.n - slip);
            if (last <= first) continue;
            let count = prefix[last + slip] - prefix[first + slip];
            for (const p of unusable) if (p >= first && p < last && copyBytes[p + slip] >= 0) count--;
            judged[slip + maxSlip] = count;
        }
        return [judged, agreed];
    };

    /**
     * Whether copy's byte q, read as held's byte p, moved rather than changed: the copy's bytes around it
     * (3 either side, at least 4 usable) agree four in five with held's at some other offset within 96.
     * Only an offset where at least four context bytes match can pass, so the offsets are found from where the
     * context bytes stand in held rather than by trying all 192 (same answer, decode-orc does the latter).
     */
    const offsetHits = new Int32Array(2 * DISPLACEMENT_REACH + 1), offsetsTouched = [];
    const displaced = (held, p, copy, q) => {
        const width = 2 * DISPLACEMENT_CONTEXT + 1, context = new Array(width);
        let usableContext = 0;
        for (let k = 0; k < width; k++) {
            context[k] = usableAt(copy, q + k - DISPLACEMENT_CONTEXT);
            if (context[k] >= 0) usableContext++;
        }
        if (usableContext < 4) return false;
        const { start, positions } = readingIndex(held);
        offsetsTouched.length = 0;
        for (let k = 0; k < width; k++) {
            const value = context[k];
            if (value < 0) continue;
            const base = p + k - DISPLACEMENT_CONTEXT;
            const end = start[value + 1];
            for (let i = lowerBound(positions, start[value], end, base - DISPLACEMENT_REACH); i < end; i++) {
                const offset = positions[i] - base;
                if (offset > DISPLACEMENT_REACH) break;
                if (offset === 0) continue;
                if (offsetHits[offset + DISPLACEMENT_REACH]++ === 0) offsetsTouched.push(offset);
            }
        }
        let found = false;
        for (const offset of offsetsTouched) {
            const agreed = offsetHits[offset + DISPLACEMENT_REACH];
            offsetHits[offset + DISPLACEMENT_REACH] = 0;
            if (found || agreed < 4) continue;
            let judged = 0;
            for (let k = 0; k < width; k++) {
                if (context[k] >= 0 && usableAt(held, p + k - DISPLACEMENT_CONTEXT + offset) >= 0) judged++;
            }
            if (judged >= 4 && agreed * 5 >= judged * 4) found = true;
        }
        return found;
    };

    /** Whether `copy` (its byte p + slip read as held's p) carries something `held` does not: another page's bytes. */
    const carriesMoreThan = (held, copy, slip) => {
        const n = held.n;
        const differs = (p) => {
            const a = held.usable[p], b = usableAt(copy, p + slip);
            return a >= 0 && b >= 0 && a !== b;
        };
        let vouchedJudged = 0;
        const vouchedDiffering = [];
        for (let p = 0; p < n; p++) {
            const q = p + slip;
            if (!held.vouched[p] || q < 0 || q >= copy.n || !copy.vouched[q]) continue;
            vouchedJudged++;
            if (held.usable[p] !== copy.usable[q]) vouchedDiffering.push(p);
        }
        const vouchedEnough = (count) => count >= PAGE_DIFFERENCE_VOUCHED_BYTES && count * 100 >= vouchedJudged * PAGE_DIFFERENCE_VOUCHED_PERCENT;
        if (vouchedEnough(vouchedDiffering.length)) {
            let foreign = 0;
            for (const p of vouchedDiffering) {
                if (!displaced(held, p, copy, p + slip)) foreign++;
                if (vouchedEnough(foreign)) return true;          // the count only grows: the answer is settled
            }
        }
        const quiet = (from, to) => {
            let failing = 0;
            for (let p = from - PAGE_DIFFERENCE_QUIET_REACH; p < to + PAGE_DIFFERENCE_QUIET_REACH; p++) {
                if (failingAt(held, p)) failing++;
                if (failingAt(copy, p + slip)) failing++;
            }
            return failing <= PAGE_DIFFERENCE_QUIET_FAILURES;
        };
        let foreign = 0;
        for (let p = 0; p < n && foreign < PAGE_DIFFERENCE_BYTES;) {
            if (!differs(p)) { p++; continue; }
            let end = p;
            while (end < n && differs(end)) end++;
            if (end - p >= PAGE_DIFFERENCE_RUN && quiet(p, end)) {
                let run = 0;
                for (let k = p; k <= end; k++) {
                    if (k < end && !displaced(held, k, copy, k + slip)) {
                        run++;
                        if (run >= PAGE_DIFFERENCE_RUN && foreign + run >= PAGE_DIFFERENCE_BYTES) return true;   // settled
                        continue;
                    }
                    if (run >= PAGE_DIFFERENCE_RUN) foreign += run;
                    run = 0;
                }
            }
            p = end;
        }
        return foreign >= PAGE_DIFFERENCE_BYTES;
    };

    /** Two pages built on one layout rather than copies of one page: each carries something the other does not. */
    const differentPages = (a, b, slip) => carriesMoreThan(a, b, slip) && carriesMoreThan(b, a, -slip);

    /**
     * Agreement window by window, each window at its own best slip within maxSlip. Counted from where each byte
     * value stands in the copy and a running count of its usable bytes rather than slip by slip (same counts).
     */
    const windowedAgreement = (held, copy, maxSlip, needPercent = 0) => {
        let judged = 0, agreed = 0;
        const heldBytes = held.usable, copyBytes = copy.usable, span = 2 * maxSlip + 1;
        const { start, positions, prefix } = readingIndex(copy), heldPrefix = readingIndex(held).prefix;
        if (slipCounts.length < span) slipCounts = new Int32Array(span);
        for (let from = 0; from < held.n; from += CONTENT_WINDOW_BYTES) {
            // Even if every usable byte left were judged and agreed, the share could not reach what is needed:
            // the answer (fails) is settled, so stop counting
            if (needPercent > 0) {
                const left = heldPrefix[held.n] - heldPrefix[from];
                if ((agreed + left) * 100 < (judged + left) * needPercent) return [judged, agreed];
            }
            const to = Math.min(from + CONTENT_WINDOW_BYTES, held.n);
            let usableHere = 0;
            const unusable = [];
            for (let p = from; p < to; p++) if (heldBytes[p] >= 0) usableHere++; else unusable.push(p);
            if (usableHere < CONTENT_WINDOW_MIN_JUDGED) continue;      // no slip can judge enough here
            slipCounts.fill(0, 0, span);
            for (let p = from; p < to; p++) {
                const value = heldBytes[p];
                if (value < 0) continue;
                const end = start[value + 1];
                for (let i = lowerBound(positions, start[value], end, p - maxSlip); i < end; i++) {
                    const slip = positions[i] - p;
                    if (slip > maxSlip) break;
                    slipCounts[slip + maxSlip]++;
                }
            }
            let bestJudged = -1, bestAgreed = 0;
            for (let slip = -maxSlip; slip <= maxSlip; slip++) {
                const first = Math.max(from, -slip), last = Math.min(to, copy.n - slip);
                if (last <= first) continue;
                // usable pairs: the copy's usable bytes over the range, less those facing a held byte that is not
                let windowJudged = prefix[last + slip] - prefix[first + slip];
                for (const p of unusable) if (p >= first && p < last && copyBytes[p + slip] >= 0) windowJudged--;
                const windowAgreed = slipCounts[slip + maxSlip];
                if (windowJudged >= CONTENT_WINDOW_MIN_JUDGED && (bestJudged < 0 ||
                    windowAgreed * Math.max(1, bestJudged) > bestAgreed * Math.max(1, windowJudged))) {
                    bestJudged = windowJudged; bestAgreed = windowAgreed;
                }
            }
            if (bestJudged >= 0) { judged += bestJudged; agreed += bestAgreed; }
        }
        return [judged, agreed];
    };

    /** Whether `copy` agrees with `held` as a copy of its content does; returns {agreement, slip} or null. */
    const agreesAsOneContent = (held, heldIntact, copy, copyIntact, windowSlip) => {
        const longer = Math.max(held.n, copy.n), shorter = Math.min(held.n, copy.n);
        if (heldIntact && copyIntact && longer - shorter > MAX_RECORD_SLIP) return null;
        const same = ([judged, agreed]) => judged < OUTLIER_MIN_JUDGED || agreed * 100 >= judged * SAME_CONTENT_PERCENT;
        let agreement = contentAgreementAt(held, copy, 0), slip = 0;
        if (same(agreement)) return { agreement, slip };
        const [judgedAt, agreedAt] = allSlipAgreements(held, copy, MAX_RECORD_SLIP);
        for (let candidateSlip = -MAX_RECORD_SLIP; candidateSlip <= MAX_RECORD_SLIP; candidateSlip++) {
            if (candidateSlip === 0) continue;
            const candidate = [judgedAt[candidateSlip + MAX_RECORD_SLIP], agreedAt[candidateSlip + MAX_RECORD_SLIP]];
            if (agreesBetter(candidate, agreement)) { agreement = candidate; slip = candidateSlip; }
        }
        if (same(agreement)) return { agreement, slip };
        const lineUp = ([judged, agreed]) => judged >= OUTLIER_MIN_JUDGED && agreed * 100 >= judged * CONTENT_WINDOW_PERCENT;
        const overHeld = windowedAgreement(held, copy, windowSlip, CONTENT_WINDOW_PERCENT);
        if (lineUp(overHeld)) return { agreement: overHeld, slip };
        const overCopy = windowedAgreement(copy, held, windowSlip, CONTENT_WINDOW_PERCENT);
        if (lineUp(overCopy)) return { agreement: overCopy, slip };
        return null;
    };

    /**
     * Whether `copy` carries the content `held` does: its agreement, or null when it does not. With `why`, a copy
     * that agrees but carries another page on the same layout is reported as why.otherPage = true.
     */
    const sameContent = (heldCopy, heldIntact, copyOf, copyIntact, windowSlip = CONTENT_WINDOW_SLIP, why = null) => {
        const held = byteReading(heldCopy), copy = byteReading(copyOf);
        const found = agreesAsOneContent(held, heldIntact, copy, copyIntact, windowSlip);
        if (!found) return null;
        if (differentPages(held, copy, found.slip)) { if (why) why.otherPage = true; return null; }
        return found.agreement;
    };

    /** The best agreement of `b` with `a` (slip within ±8): [judged, agreed, slip]. */
    const bestSlipAgreement = (a, b) => {
        const [judgedAt, agreedAt] = allSlipAgreements(a, b, MAX_RECORD_SLIP);
        let best = [judgedAt[MAX_RECORD_SLIP], agreedAt[MAX_RECORD_SLIP]], bestSlip = 0;
        for (let slip = -MAX_RECORD_SLIP; slip <= MAX_RECORD_SLIP; slip++) {
            const candidate = [judgedAt[slip + MAX_RECORD_SLIP], agreedAt[slip + MAX_RECORD_SLIP]];
            if (agreesBetter(candidate, best)) { best = candidate; bestSlip = slip; }
        }
        return [best[0], best[1], bestSlip];
    };

    /** Share of parity-passing bytes two votes agree on (0 below 48 judged, or where they are two pages on one layout). */
    const voteAgreement = (aCopy, bCopy) => {
        const a = byteReading(aCopy), b = byteReading(bCopy);
        const [judged, agreed, slip] = bestSlipAgreement(b, a);
        if (judged < IDENTITY_MIN_JUDGED) return 0;
        const share = agreed / judged;
        if (share >= SAME_IDENTITY_CONTENT && differentPages(b, a, slip)) return 0;
        return share;
    };
    const viewsDifferAsPages = (aCopy, bCopy) => {
        const a = byteReading(aCopy), b = byteReading(bCopy);
        return differentPages(a, b, bestSlipAgreement(a, b)[2]);
    };
    const copiesAgree = (aCopy, bCopy) => {
        const [judged, agreed] = bestSlipAgreement(byteReading(aCopy), byteReading(bCopy));
        return judged >= IDENTITY_MIN_JUDGED && agreed * 2 >= judged;
    };
    const usableCount = (copy) => {
        const reading = byteReading(copy);
        let count = 0;
        for (let i = 0; i < reading.n; i++) if (reading.usable[i] >= 0) count++;
        return count;
    };

    const FLAG_TALLY = [...FLAGS_VOTED];

    class Catalog {
        constructor() {
            this.entries = new Map();          // `${channel},${address},${version},${content}` → entry
            this.identities = new Map();       // `${channel},${address},${version}` → [content numbers]
        }

        static identityKey(message) { return `${message.channel},${message.address},${message.version}`; }

        /** True unless a record's bytes fail odd parity too often to be final (fewer than 90% odd = not parity data at all). */
        static parityClean(data) {
            let odd = 0;
            for (const byte of data) odd += ODD_PARITY[byte & 0xFF];
            return data.length === 0 || odd === data.length || odd * 10 < data.length * 9;
        }

        /** 2 = complete, intact and parity-clean (final); 1 = complete and intact but with bad bytes; 0 = damaged. */
        static rank(message) {
            if (!(message.complete && message.intact)) return 0;
            return Catalog.parityClean(message.data) ? 2 : 1;
        }

        /** A compact key for a record's bytes, to count the copies that read them alike. */
        static contentKey(data) {
            let hash = 2166136261;
            for (const byte of data) hash = Math.imul(hash ^ (byte & 0x7F), 16777619);
            return `${data.length}:${hash >>> 0}`;
        }

        static takeMessage(entry, message) {
            entry.type = message.type;
            entry.records = message.records;
            entry.complete = message.complete;
            entry.data = message.data;
            entry.present = message.present;
            entry.representative = [message.data, message.present];
            entry.more_address = moreAddressFromExtensions(message.extensions, message.channel);
            // Teletext Rescue 1.2: an "intact" copy that still has bad-parity bytes supplies the header,
            // but its bytes go into the vote with the other copies instead of being taken as final
            entry.kept_rank = Catalog.rank(message);
            entry.kept_intact = entry.kept_rank === 2;
            entry.kept_whole = entry.kept_rank >= 1;       // complete and intact: as long as its record
        }

        /** Which content held under the message's identity it carries, or the next number for a new one. */
        contentOf(message) {
            const contents = this.identities.get(Catalog.identityKey(message)) || [];
            // Captions (§7.3.10.1): a caption's version names it only while it is on air, so every caption sent
            // under it is a different text. decode-orc keeps them as a stream; here they stay one record per version.
            if (isPresentation(message.type) && message.flags.caption && (message.attested || message.type === 1)) {
                return contents.length ? contents[0] : 0;
            }
            let next = 0, best = null, bestAgreement = null;
            const copy = [message.data, message.present], copyWhole = message.complete && message.intact;
            for (const content of contents) {
                next = Math.max(next, content + 1);
                if (!message.aligned) { if (best === null) best = content; continue; }
                const entry = this.entries.get(`${Catalog.identityKey(message)},${content}`);
                let agreement = sameContent(entry.representative, entry.kept_whole, copy, copyWhole);
                for (let held = 0; !agreement && held < entry.copies.length; held++) {
                    agreement = sameContent(entry.copies[held], false, copy, false);
                }
                if (!agreement) continue;
                if (best === null || bestAgreement === null || agreesBetter(agreement, bestAgreement)) { best = content; bestAgreement = agreement; }
            }
            return best === null ? next : best;
        }

        merge(message) {
            const identity = Catalog.identityKey(message), content = this.contentOf(message), key = `${identity},${content}`;
            // §5.2.2 reserves types 4 to 15: a copy carrying one had its header misread and names nothing as transmitted
            const attested = message.attested && message.type <= 3, headerAttested = message.header_attested && message.type <= 3;
            let entry = this.entries.get(key);
            const rank = Catalog.rank(message), good = rank === 2;
            if (!entry) {
                entry = {
                    channel: message.channel, address: message.address, version: message.version, long_form: message.long_form,
                    content, first: message.clock, seen: 0, intact_n: 0, attested_n: 0, header_attested_n: 0,
                    flags_set: Object.fromEntries(FLAG_TALLY.map((name) => [name, 0])),
                    flags_att: Object.fromEntries(FLAG_TALLY.map((name) => [name, 0])),
                    types: new Array(16).fill(0), types_att: new Array(16).fill(0),
                    copies: [], kept_intact: false, kept_whole: false, kept_rank: 0
                };
                Catalog.takeMessage(entry, message);
                this.entries.set(key, entry);
                if (!this.identities.has(identity)) this.identities.set(identity, []);
                this.identities.get(identity).push(content);
            } else if (!entry.intactDisagree &&
                (rank > entry.kept_rank || (rank === entry.kept_rank && message.data.length > entry.data.length))) {
                Catalog.takeMessage(entry, message);
            }
            // JS-only: a copy can pass every packet's check and still be wrong (two bits misread down one column of a
            // packet pass its suffix check). Where two intact copies differ, neither stands for the record: every copy
            // seen is voted, the intact ones with the rest (WCIA 1990's master index: one of its two intact copies read
            // a LINE as DOMAIN, and taken as the record, it drew a blank screen; on CBS 1985-06-29 most pages arrived
            // "intact" in a dozen or more different readings)
            const voter = [message.data, message.present];
            if (good) {
                if (!entry.intactCopies) entry.intactCopies = [];
                if (entry.intactCopies.length < MAX_COPIES) entry.intactCopies.push(voter);
            }
            const keep = (list) => { if (list.length >= MAX_COPIES) list.shift(); list.push(voter); };
            // (not captions: a caption's version is reused by every caption it carries, each intact and each different)
            if (good && !message.flags.caption && message.type !== 1) {
                if (!entry.intactReadings) entry.intactReadings = new Set();
                entry.intactReadings.add(Catalog.contentKey(message.data));
                if (entry.intactReadings.size > 1 && !entry.intactDisagree) {
                    entry.intactDisagree = true;
                    entry.kept_intact = false;
                    entry.kept_rank = 1;
                    entry.copies = [...(entry.spareCopies || [])];
                    entry.spareCopies = null;
                }
            }
            if (entry.intactDisagree) { if (message.aligned || good) keep(entry.copies); }
            else if (good) {
                // The copies seen so far are kept aside too, should a later intact copy disagree with this one
                if (!entry.spareCopies) entry.spareCopies = entry.copies.slice(-MAX_COPIES);
                entry.copies = [];
                keep(entry.spareCopies);
            }
            else if (!entry.kept_intact && message.aligned) keep(entry.copies);
            else if (message.aligned) keep(entry.spareCopies || (entry.spareCopies = []));
            for (const name of FLAG_TALLY) {
                if (message.flags[name]) {
                    entry.flags_set[name]++;
                    if (attested) entry.flags_att[name]++;
                }
            }
            entry.types[message.type & 0xF]++;
            if (attested) entry.types_att[message.type & 0xF]++;
            entry.last = message.clock;
            entry.seen++;
            entry.intact_n += message.complete && message.intact ? 1 : 0;
            entry.attested_n += attested ? 1 : 0;
            entry.header_attested_n += headerAttested ? 1 : 0;
        }

        /** The type most appearances carried (those that named the identity as transmitted, where any did). */
        static votedType(entry) {
            const types = entry.attested_n > 0 ? entry.types_att : entry.types;
            let chosen = entry.type, most = types[chosen & 0xF];
            for (let type = 0; type < 16; type++) if (types[type] > most) { most = types[type]; chosen = type; }
            return chosen;
        }

        /** What an entry's copies say its record is: their vote, or the kept copy. */
        static viewOf(entry) {
            if (!entry.copies.length) return entry.representative;
            const [data, present] = Catalog.votedCopies(entry);
            return [data, present];
        }

        /** The vote over an entry's copies, kept until its copies change (it is asked for more than once). */
        static votedCopies(entry) {
            const { copies } = entry, cached = entry.voteCache;
            if (cached && cached.copies === copies && cached.length === copies.length &&
                cached.first === copies[0] && cached.last === copies[copies.length - 1]) return cached.result;
            const result = voteRecord(copies);
            entry.voteCache = { copies, length: copies.length, first: copies[0], last: copies[copies.length - 1], result };
            return result;
        }

        /**
         * JS-only: where intact copies disagree, the record is voted from them alone, byte by byte; where they tie, the
         * other copies break the tie, and failing that the grammar (the copies whose checks failed carry the most
         * misreadings of all: on CBS 1985-06-29, voted in, they turned the EVTV ad to stripes, took the BASF ad's
         * background and the Eurythmics ad's face). Null where the intact copies are of different lengths.
         */
        static votedIntact(entry) {
            const intact = entry.intactCopies || [];
            if (intact.length < 2) return null;
            const length = intact[0][0].length;
            if (intact.some(([data]) => data.length !== length)) return null;
            const others = entry.copies.filter(([data]) => data.length === length && !intact.some(([held]) => held === data));
            const data = [], ties = [];
            for (let i = 0; i < length; i++) {
                const counts = new Map();
                for (const [held] of intact) counts.set(held[i], (counts.get(held[i]) || 0) + 1);
                let most = 0;
                for (const count of counts.values()) most = Math.max(most, count);
                let leaders = [...counts].filter(([, count]) => count === most).map(([byte]) => byte);
                if (leaders.length > 1) {
                    // The other copies break the tie, where they favor one of the readings
                    const support = leaders.map((byte) => others.filter(([held, present]) => present[i] && held[i] === byte).length);
                    const best = Math.max(...support);
                    const kept = leaders.filter((byte, k) => support[k] === best);
                    if (kept.length < leaders.length) leaders = kept;
                }
                data.push(leaders[0]);
                if (leaders.length > 1) ties.push([i, leaders]);
            }
            return ties.length ? settleTiesByGrammar(data, ties) : data;
        }

        /**
         * JS-only: a lone intact copy can carry a misread its checks let through. Where three or more of the other
         * copies, all holding the byte, agree on another reading, theirs is taken (CBS 1985-06-29's KKGO ad: its one
         * intact copy read "America's" as "Hmerica's").
         */
        static overruledIntact(data, spare) {
            const others = spare.filter(([held]) => held.length === data.length && held !== data);
            if (others.length < OVERRULE_MIN_COPIES) return data;
            let result = data;
            for (let i = 0; i < data.length; i++) {
                // The reading most of the copies that received the byte hold, where nine in ten hold it (all of them,
                // where there are only a few: a stray reading or two among dozens of copies is a tape's noise)
                const counts = new Map();
                let received = 0;
                for (const [held, present] of others) {
                    if (!present[i] || !ODD_PARITY[held[i] & 0xFF]) continue;     // a reading failing parity is no vote
                    received++;
                    counts.set(held[i], (counts.get(held[i]) || 0) + 1);
                }
                let first = null, agree = 0;
                for (const [value, count] of counts) if (count > agree) { first = value; agree = count; }
                if (first === null || first === data[i]) continue;
                if (agree < OVERRULE_MIN_COPIES || agree < received * OVERRULE_SHARE || !ODD_PARITY[first & 0xFF]) continue;
                if (result === data) result = [...data];
                result[i] = first;
            }
            return result;
        }

        static addTallies(target, source) {
            target.seen += source.seen;
            target.intact_n += source.intact_n;
            target.header_attested_n += source.header_attested_n;
            for (const name of FLAG_TALLY) target.flags_set[name] += source.flags_set[name];
            for (let type = 0; type < 16; type++) target.types[type] += source.types[type];
            target.first = Math.min(target.first, source.first);
            target.last = Math.max(target.last, source.last);
        }

        /** A misreading's appearances and copies go to the record it was a misreading of (into the room left). */
        static foldInto(target, misread) {
            Catalog.addTallies(target, misread);
            if (target.kept_intact) return;
            for (const copy of misread.copies) {
                if (target.copies.length >= MAX_COPIES) break;
                target.copies.push(copy);
            }
        }

        /** Two contents found to be one: the later one's appearances and copies join the earlier. */
        static absorb(target, source) {
            Catalog.addTallies(target, source);
            target.attested_n += source.attested_n;
            for (const name of FLAG_TALLY) target.flags_att[name] += source.flags_att[name];
            for (let type = 0; type < 16; type++) target.types_att[type] += source.types_att[type];
            if (source.kept_intact && !target.kept_intact) {
                for (const field of ['type', 'records', 'complete', 'data', 'present', 'representative', 'more_address',
                    'kept_rank', 'kept_intact', 'kept_whole', 'long_form']) target[field] = source[field];
                // JS-only: the copies the target held are kept aside, to overrule the intact copy where they agree
                // on another reading (CBS 1984-10-02's Weather Watch: the 185 copies reading a polygon's "b" and DEL
                // were set aside for one intact copy that read TEXT and SELECT COLOR there, and the page drew in
                // the wrong colors)
                target.spareCopies = target.copies.concat(source.spareCopies || []).slice(-MAX_COPIES);
                target.copies = [];
            } else if (!target.kept_intact) {
                target.copies = target.copies.concat(source.copies);
                if (target.copies.length > MAX_COPIES) target.copies = target.copies.slice(target.copies.length - MAX_COPIES);
            }
        }

        /** Once every copy is in, contents of one identity that turn out to be one page are joined. */
        joinContents() {
            for (const [identity, contents] of this.identities) {
                if (contents.length < 2) continue;
                const keys = contents.map((content) => `${identity},${content}`);
                const views = new Array(keys.length).fill(null);
                const view = (index) => {
                    if (!views[index]) views[index] = Catalog.viewOf(this.entries.get(keys[index]));
                    return views[index];
                };
                const joined = new Array(keys.length).fill(false);
                for (let later = 1; later < keys.length; later++) {
                    const source = this.entries.get(keys[later]);
                    for (let earlier = 0; earlier < later; earlier++) {
                        if (joined[earlier]) continue;
                        const target = this.entries.get(keys[earlier]);
                        // A copy given holes for blocks it never lost runs two or three blocks late: look that far too
                        if (sameContent(view(earlier), target.kept_whole, view(later), source.kept_whole) ||
                            sameContent(view(earlier), target.kept_whole, view(later), source.kept_whole, JOIN_WINDOW_SLIP)) {
                            Catalog.absorb(target, source);
                            views[earlier] = null;
                            joined[later] = true;
                            break;
                        }
                    }
                }
                // JS-only: a content that never arrived intact and was seen less often than the identity's most-seen
                // content is that page's damaged copies, not another page, when it lost bytes or shares its layout (both,
                // unless it was seen at most a fifth as often) (on the samples nearly all such
                // contents are copies that lost a stretch of packets). It is no longer listed. Its copies join the main
                // content's vote only when they are as long as it and it was seen at most a fifth as often (where it was seen
                // nearly as often, its damaged copies would outvote the few good ones): a copy a block longer or shorter has its bytes out of
                // place from the damage on, and voted in where few copies hold a byte it does harm.
                let main = -1;
                keys.forEach((key, index) => {
                    if (joined[index]) return;
                    if (main < 0 || this.entries.get(key).seen > this.entries.get(keys[main]).seen) main = index;
                });
                const mainEntry = this.entries.get(keys[main]);
                keys.forEach((key, index) => {
                    if (joined[index] || index === main) return;
                    const entry = this.entries.get(key);
                    if (entry.intact_n > 0 || entry.seen > mainEntry.seen) return;
                    // Only a content that lost at least a packet's worth of bytes is taken for damage: one that arrived
                    // whole but reads differently is another page (a session screen, an updated edition)
                    const [minorData, minorPresent] = Catalog.viewOf(entry), [mainData, mainPresent] = Catalog.viewOf(mainEntry);
                    let lostBytes = 0;
                    for (let i = 0; i < minorData.length; i++) if (minorPresent && i < minorPresent.length && minorPresent[i] === 0) lostBytes++;
                    const sameLength = minorData.length === mainData.length;
                    // ... or that is about as long as the main content and shares its layout (a quarter or more of the
                    // bytes both hold, where pages that differ share a few percent): a copy with blocks misplaced or misread
                    let sharesLayout = false, damagedLayout = false;
                    if (Math.abs(minorData.length - mainData.length) <= Math.max(28, mainData.length * 0.06)) {
                        let judged = 0, agreed = 0;
                        for (let i = 0; i < Math.min(minorData.length, mainData.length); i++) {
                            if (!salvageUsable(minorData, minorPresent, i) || !salvageUsable(mainData, mainPresent, i)) continue;
                            judged++;
                            if ((minorData[i] & 0x7F) === (mainData[i] & 0x7F)) agreed++;
                        }
                        sharesLayout = judged >= 64 && agreed * 4 >= judged;
                        // Losses blur the layout: with a stretch lost, a sixth or more of the bytes agreeing will do
                        damagedLayout = judged >= 64 && agreed * 100 >= judged * 15;
                    }
                    // Seen at most a fifth as often, losses or a shared layout are enough; seen nearly as often (both
                    // rare), it takes losses and a layout the damage left recognizable
                    const rare = entry.seen * 5 <= mainEntry.seen;
                    // ... or, however often seen, exactly as long as the main content with its layout shared: a page
                    // revised on the air changes length, while a recording whose packets are often misread (WCBS April
                    // 1985) gathers its spliced copies, which keep the length, into a content of their own
                    const spliced = sameLength && sharesLayout;
                    if (rare ? lostBytes < 27 && !sharesLayout : (lostBytes < 27 || !damagedLayout) && !spliced) return;
                    // Its copies only fill the room the main content's own copies leave: appended, they would push the
                    // main content's out of the 64 kept (CBS 1984-02-27 page 041: 46 copies with a block of packets
                    // misplaced outvoted the page's good ones)
                    Catalog.absorb(mainEntry, { ...entry, copies: [], kept_intact: false });
                    if (sameLength && rare && !mainEntry.kept_intact) {
                        for (const copy of entry.copies) {
                            if (mainEntry.copies.length >= MAX_COPIES) break;
                            mainEntry.copies.push(copy);
                        }
                    }
                    joined[index] = true;
                });
                const renumbered = [];
                keys.forEach((key, index) => {
                    const entry = this.entries.get(key);
                    this.entries.delete(key);
                    if (joined[index]) return;
                    entry.content = renumbered.length;
                    renumbered.push(entry);
                });
                renumbered.forEach((entry) => this.entries.set(`${identity},${entry.content}`, entry));
                this.identities.set(identity, renumbered.map((entry) => entry.content));
            }
        }

        /**
         * A version seen a handful of times inside the span of another version of the same address seen twenty
         * times as often, and carrying its bytes, is that version with its version nibble misread (§5.2.7.2).
         */
        foldMisreadVersions() {
            for (const [rareKey, rare] of [...this.entries]) {
                if (!this.entries.has(rareKey)) continue;
                let into = null, intoShare = 0;
                for (const [key, main] of this.entries) {
                    if (main.channel !== rare.channel || main.address !== rare.address || main.version === rare.version) continue;
                    if (main.seen < MISREAD_VERSION_MIN_MAIN || main.seen < MISREAD_VERSION_RATIO * rare.seen ||
                        rare.first < main.first || rare.last > main.last) continue;
                    const share = voteAgreement(Catalog.viewOf(rare), Catalog.viewOf(main));
                    if (share >= MISREAD_VERSION_AGREEMENT && share > intoShare) { into = key; intoShare = share; }
                }
                if (into === null) continue;
                Catalog.foldInto(this.entries.get(into), rare);
                this.removeEntry(rareKey);
            }
        }

        removeEntry(key) {
            const entry = this.entries.get(key);
            if (!entry) return;
            this.entries.delete(key);
            const identity = Catalog.identityKey(entry), contents = this.identities.get(identity);
            if (contents) {
                const left = contents.filter((content) => content !== entry.content);
                if (left.length) this.identities.set(identity, left); else this.identities.delete(identity);
            }
        }

        /** A record no copy named as transmitted is kept as a page of its own only if it reads as one. */
        static keepable(entry, view) {
            if (Catalog.votedType(entry) > 3) return false;
            if (usableCount(view) < IDENTITY_MIN_JUDGED) return false;
            if (entry.kept_whole) return true;
            // Copies of several pages misread onto one name agree with their vote but not with one another
            for (let a = 0; a < entry.copies.length; a++) {
                for (let b = a + 1; b < entry.copies.length; b++) if (copiesAgree(entry.copies[a], entry.copies[b])) return true;
            }
            return false;
        }

        static keptByItsHeader(entry, view) {
            return entry.header_attested_n > 0 && Catalog.votedType(entry) <= 3 && usableCount(view) >= IDENTITY_MIN_JUDGED;
        }

        /** Identities never received cleanly: fold into the page they carry, keep, or drop (decode-orc PR #328). */
        reconcile() {
            this.joinContents();
            this.foldMisreadVersions();
            const identityDigits = (entry) => {
                const digits = [(entry.channel >> 8) & 0xF, (entry.channel >> 4) & 0xF, entry.channel & 0xF];
                for (let bits = 32; bits >= 0; bits -= 4) digits.push(shiftRight(entry.address, bits) % 16);
                digits.push(entry.version & 0xF);
                return digits;
            };
            const keys = [...this.entries.keys()].sort((x, y) => {
                const p = this.entries.get(x), q = this.entries.get(y);
                return p.channel - q.channel || p.address - q.address || p.version - q.version || p.content - q.content;
            });
            const entries = keys.map((key) => this.entries.get(key));
            const digits = entries.map(identityDigits);
            const trusted = entries.map((entry) => entry.attested_n > 0);
            const result = { folded: 0, dropped: 0, kept: 0, misaddressed: 0 };
            if (!trusted.some(Boolean)) return result;
            const views = entries.map((entry) => Catalog.viewOf(entry));
            const agreementOf = (u, a) => {
                if (!views[u][0].length || !views[a][0].length) return NaN;
                if (u === a) return Catalog.keepable(entries[u], views[u]) ? 1 : NaN;
                return voteAgreement(views[u], views[a]);
            };
            const singleDigitNeighbor = (index) => {
                let found = null;
                for (let other = 0; other < entries.length; other++) {
                    if (!trusted[other] || misnamed[other] !== null) continue;
                    let differences = 0;
                    for (let d = 0; d < digits[index].length && differences <= 1; d++) {
                        if (digits[index][d] !== digits[other][d]) differences++;
                    }
                    if (differences !== 1) continue;
                    if (found !== null) return null;     // ambiguous: two neighbors
                    found = other;
                }
                return found;
            };
            // JS-only: a page named as transmitted only once or twice, whose bytes are another named page's (nine in
            // ten agreeing) seen ten times as often under the same version, its address a digit away, is that page
            // with its address misread past what the header's code caught (CBS 1984-02-27: a copy of page 009 read as
            // 029, where the real page 029 lost its header)
            const misnamed = entries.map((entry, i) => {
                if (!trusted[i] || entry.seen > MISNAMED_MAX_SEEN || entry.intact_n > 0) return null;
                let found = null;
                entries.forEach((other, j) => {
                    if (j === i || !trusted[j] || other.channel !== entry.channel || other.version !== entry.version ||
                        other.seen < MISNAMED_SEEN_RATIO * entry.seen) return;
                    let differences = 0;
                    for (let d = 0; d < digits[i].length; d++) if (digits[i][d] !== digits[j][d]) differences++;
                    if (differences !== 1) return;
                    if (views[i][0].length !== views[j][0].length || !(agreementOf(i, j) >= MISNAMED_AGREEMENT)) return;
                    if (found === null || other.seen > entries[found].seen) found = j;
                });
                return found;
            });
            const anchor = trusted.map((isTrusted, i) => isTrusted && misnamed[i] === null);
            const untrusted = entries.map((_, i) => i).filter((i) => !trusted[i])
                .sort((x, y) => entries[y].seen - entries[x].seen);
            const verdicts = new Array(entries.length).fill(null);
            for (const u of untrusted) {
                let match = null, matchAgreement = 0, ambiguous = false;
                for (let a = 0; a < entries.length; a++) {
                    if (!anchor[a] || a === u) continue;
                    const agree = agreementOf(u, a);
                    if (!(agree >= SAME_IDENTITY_CONTENT)) continue;
                    const better = match === null || agree > matchAgreement ||
                        (agree === matchAgreement && entries[a].seen > entries[match].seen);
                    if (better) { match = a; matchAgreement = agree; ambiguous = false; }
                    else if (agree === matchAgreement && entries[a].seen === entries[match].seen) ambiguous = true;
                }
                const neighbor = singleDigitNeighbor(u);
                if (match !== null && !ambiguous) verdicts[u] = ['fold', match];
                else if (match === null && entries[u].seen >= 2 && !Number.isNaN(agreementOf(u, u))) {
                    verdicts[u] = ['keep'];
                    anchor[u] = true;
                } else if (neighbor !== null) verdicts[u] = ['fold', neighbor];
                else verdicts[u] = ['drop'];
            }
            // The service's own data channel: the one most identities named as transmitted are on
            const attestedOnChannel = new Map(), named = new Set();
            entries.forEach((entry, i) => {
                if (!trusted[i]) return;
                attestedOnChannel.set(entry.channel, (attestedOnChannel.get(entry.channel) || 0) + 1);
                named.add(Catalog.identityKey(entry));
            });
            let serviceChannel = 0, mostAttested = 0;
            for (const [channel, count] of [...attestedOnChannel].sort((x, y) => x[0] - y[0])) {
                if (count > mostAttested) { serviceChannel = channel; mostAttested = count; }
            }
            for (const u of untrusted) {
                // A sighting folded into another page built on its layout would only blend the two
                if (verdicts[u][0] === 'fold' && viewsDifferAsPages(views[verdicts[u][1]], views[u])) verdicts[u] = ['drop'];
                if (verdicts[u][0] === 'drop' && entries[u].channel === serviceChannel && !named.has(Catalog.identityKey(entries[u])) &&
                    Catalog.keptByItsHeader(entries[u], views[u])) verdicts[u] = ['keep'];
            }
            // A record on another data channel, never intact, whose address and version a page of the service's
            // channel carries seen four times as often, is that page's packets misaddressed
            const standing = (i) => trusted[i] || verdicts[i][0] === 'keep';
            const misaddressed = entries.map((entry, i) => {
                if (entry.channel === serviceChannel || !standing(i) || entry.intact_n > 0) return false;
                let namesakeSeen = 0;
                entries.forEach((other, j) => {
                    if (other.channel === serviceChannel && other.address === entry.address && other.version === entry.version &&
                        standing(j)) namesakeSeen += other.seen;
                });
                return namesakeSeen >= MISADDRESSED_SEEN_RATIO * entry.seen;
            });
            for (const u of untrusted) if (verdicts[u][0] === 'fold' && misaddressed[verdicts[u][1]]) verdicts[u] = ['drop'];
            entries.forEach((entry, i) => {
                if (misnamed[i] === null || misaddressed[misnamed[i]]) return;
                Catalog.foldInto(entries[misnamed[i]], entry);
                result.folded++;
                this.removeEntry(keys[i]);
            });
            entries.forEach((entry, i) => {
                if (trusted[i] || misaddressed[i]) return;
                const [action, target] = verdicts[i];
                if (action === 'keep') { entry.unconfirmed = true; result.kept++; return; }
                if (action === 'fold') { Catalog.foldInto(entries[target], entry); result.folded++; } else result.dropped++;
                this.removeEntry(keys[i]);
            });
            entries.forEach((entry, i) => {
                if (!misaddressed[i]) return;
                result.misaddressed++;
                this.removeEntry(keys[i]);
            });
            return result;
        }

        records() {
            const entries = [...this.entries.values()];
            // Contents of one identity are listed most-seen first, so the page a service kept sending keeps the plain
            // name (000-004-v0) and a stray sighting with other contents comes after it as an edition (decode-orc
            // numbers them in order of arrival instead)
            entries.sort((a, b) => a.channel - b.channel || a.address - b.address || a.version - b.version ||
                b.seen - a.seen || a.content - b.content);
            const rank = new Map(), confusions = new Map(), readingsOf = new Map(), entryOf = new Map();
            const built = entries.map((entry) => {
                const { copies, representative, types, types_att, voteCache, intactReadings, spareCopies, intactCopies, ...fields } = entry;
                const record = { ...fields };
                entryOf.set(record, entry);
                const hasAttested = entry.attested_n > 0;
                const voters = hasAttested ? entry.attested_n : entry.seen;
                const flagCounts = hasAttested ? entry.flags_att : entry.flags_set;
                record.flags = Object.fromEntries(FLAGS_VOTED.map((name) => [name, flagCounts[name] * 2 > voters]));
                record.type = Catalog.votedType(entry);
                record.copies_voted = copies.length;
                record.unconfirmed = !!entry.unconfirmed;
                // Pages sent under one identity with different contents are listed once per content, in order of arrival
                const identity = Catalog.identityKey(entry);
                rank.set(identity, (rank.get(identity) || 0) + 1);
                record.edition = rank.get(identity);
                record.editions = (this.identities.get(Catalog.identityKey(entry)) || [0]).length;
                const intactVote = entry.intactDisagree ? Catalog.votedIntact(entry) : null;
                if (intactVote) {
                    record.data = intactVote;
                    record.present = new Array(intactVote.length).fill(2);
                    record.copies_voted = 0;
                } else if (copies.length) {
                    const [data, present, ties, contested, alternatives] = Catalog.votedCopies(entry);
                    if (alternatives && alternatives.length) readingsOf.set(record, alternatives);
                    record.data = ties && ties.length ? settleTiesByGrammar(data, ties) : data;
                    // JS-only: a byte the copies split evenly on is settled by the grammar as an outvoted reading is,
                    // where no severe problem called for it (CBS 1984-10-02's Kids' Time: POINT SET 0x24 or DC4 0x14,
                    // 29 copies each, and the menu under its title was drawn off the top of the screen)
                    if (ties && ties.length && copies.length >= TIE_SETTLE_MIN_COPIES && isPresentation(record.type)) {
                        const tiedPairs = ties.filter(([position]) => record.data[position] === data[position])
                            .map(([position, [winner, other]]) => [position, [winner, other]]);
                        if (tiedPairs.length) record.data = settleContestedByGrammar(record.data, tiedPairs);
                    }
                    if (contested && contested.length && isPresentation(record.type)) {
                        record.data = settleContestedByMotif(settleContestedByGrammar(record.data, contested), contested);
                        for (const [, [winner, runnerUp]] of contested) {
                            const a = winner & 0x7F, b = runnerUp & 0x7F, key = Math.min(a, b) * 128 + Math.max(a, b);
                            confusions.set(key, (confusions.get(key) || 0) + 1);
                        }
                    }
                    record.present = present;
                } else if (entry.kept_intact && record.data && entry.spareCopies && isPresentation(record.type)) {
                    record.data = Catalog.overruledIntact(record.data, entry.spareCopies);
                }
                record.addr_text = !entry.long_form ? addressText(entry.address) : toHex(entry.address, 9);
                record.purpose = reservedPurpose(entry.channel, entry.address);
                return record;
            });
            // JS-only: the misreadings this recording makes again and again (the pairs its contested bytes split
            // between) are tried where every copy misread a byte alike, and the grammar left a problem just after it
            const partners = new Map();
            for (const [key, count] of confusions) {
                if (count < CONFUSION_MIN_COUNT) continue;
                const a = Math.floor(key / 128), b = key % 128;
                for (const [from, to] of [[a, b], [b, a]]) {
                    if (!partners.has(from)) partners.set(from, []);
                    partners.get(from).push([to, count]);
                }
            }
            for (const list of partners.values()) list.sort((p, q) => q[1] - p[1]);
            // Every run of SWAP_EVIDENCE bytes the recording's pages hold, to confirm a command put right
            const runs = new Map();
            const runAt = (data, from) => String.fromCharCode(...data.slice(from, from + SWAP_EVIDENCE).map((byte) => byte & 0x7F));
            built.forEach((record, index) => {
                if (!record.data || !isPresentation(record.type)) return;
                for (let i = 0; i + SWAP_EVIDENCE <= record.data.length; i++) {
                    const run = runAt(record.data, i);
                    if (!runs.has(run)) runs.set(run, index);
                    else if (runs.get(run) !== index) runs.set(run, -1);
                }
            });
            built.forEach((record, index) => {
                if (!record.data || !record.data.length || !isPresentation(record.type)) return;
                const seenElsewhere = (trial, from) => {
                    const holder = runs.get(runAt(trial, from));
                    return holder !== undefined && holder !== index;
                };
                // A record kept from an intact copy is repaired only where bits were swapped, which its packets'
                // checks can't catch: the parity bit and bit 6, or bits 6 and 5 where another record holds the result
                // Whether some copy of the record received `value` at `at`
                const entry = entryOf.get(record);
                // Whether the copies rule a reading out: SHIFT_SWAP_VETO_COPIES or more received the byte, and none as
                // `value` (a misread shared by every copy is a thing of a record seen two or three times)
                const kept = [entry.copies, entry.spareCopies, entry.intactCopies].filter((list) => list && list.length);
                const ruledOut = !kept.length ? null : (at, value) => {
                    let received = 0;
                    for (const list of kept) {
                        for (const [copyData, copyPresent] of list) {
                            if (copyPresent && !copyPresent[at]) continue;
                            if (copyData[at] === value) return false;
                            received++;
                        }
                    }
                    return received >= SHIFT_SWAP_VETO_COPIES;
                };
                if (!record.copies_voted) { record.data = repairByHighBitSwap(repairBySwappedBits(record.data, seenElsewhere, true), ruledOut); return; }
                record.data = repairByHighBitSwap(repairBySwappedBits(repairBySelfTemplate(record.data), seenElsewhere), ruledOut);
            });
            if (partners.size) {
                for (const record of built) {
                    if (record.copies_voted && record.data && record.data.length && isPresentation(record.type)) {
                        record.data = repairByConfusions(record.data, record.present, partners);
                    }
                }
            }
            settleWordsByVocabulary(built, readingsOf);
            settleSystematicMisreads(built);
            return built;
        }
    }

    // ---------------------------------------------------------------------------
    // Salvage of groups whose synchronizing packet was lost (decode-orc PR #328, nabts_salvage.cpp)
    // ---------------------------------------------------------------------------

    /**
     * How a service writes NAPLPS, learned from its own records (naplps_dialect_model.cpp): which byte follows which,
     * in text and in PDI data separately, so a stretch can be scored as the one or the other.
     */
    class DialectModel {
        constructor() {
            this.textPairs = new Uint32Array(128 * 128);
            this.pdiPairs = new Uint32Array(128 * 128);
            this.textFirsts = new Float64Array(128);
            this.pdiFirsts = new Float64Array(128);
            this.records = 0;
        }

        learn(data, present, roles = readRoles(data)) {
            if (!data.length) return;
            this.records++;
            let stretch = 0, previous = -1;                       // 0 none, ROLE_TEXT or ROLE_PDI
            for (let i = 0; i < roles.length; i++) {
                const kind = roles[i] === ROLE_TEXT || roles[i] === ROLE_PDI ? roles[i] : 0;
                if (kind !== stretch) { previous = -1; stretch = kind; }
                const arrived = data[i] !== 0 && (!present || !present.length || present[i] !== 0);
                if (!kind || !arrived) { previous = -1; continue; }
                const byte = data[i] & 0x7F;
                if (previous >= 0) {
                    if (kind === ROLE_TEXT) { this.textPairs[previous * 128 + byte]++; this.textFirsts[previous]++; }
                    else { this.pdiPairs[previous * 128 + byte]++; this.pdiFirsts[previous]++; }
                }
                previous = byte;
            }
        }

        static score(pairs, firsts, bytes, from, count) {
            if (count < 2) return 0;
            let total = 0;
            for (let i = from + 1; i < from + count; i++) {
                const a = bytes[i - 1] & 0x7F, b = bytes[i] & 0x7F;
                total += Math.log((pairs[a * 128 + b] + 0.5) / (firsts[a] + 0.5 * 128));
            }
            return total / (count - 1);
        }

        textScore(bytes, from, count) { return DialectModel.score(this.textPairs, this.textFirsts, bytes, from, count); }

        pdiScore(bytes, from, count) { return DialectModel.score(this.pdiPairs, this.pdiFirsts, bytes, from, count); }
    }

    const SALVAGE_STRETCH = 6, SALVAGE_MAX_STRETCH_HITS = 32, SALVAGE_ALIGNMENTS_TRIED = 4, SALVAGE_CLEAR_MARGIN = 2.0;
    const SALVAGE_MIN_RUN_PACKETS = 3, SALVAGE_LONE_PAGE_USABLE = 90, SALVAGE_RESUME_SEARCH = 112;
    const SALVAGE_MIN_JUDGED = 40, SALVAGE_MIN_AGREE = 85, SALVAGE_MAX_RUNS = 65536, SALVAGE_MAX_BYTES = 32 << 20;
    const DIALECT_FLOOR_PERCENTILE = 10, DIALECT_FLOOR_MARGIN = 0.25, DIALECT_MIN_RECORDS = 8;
    const MAX_GROUP_BYTES = 1904, IDENTITY_LOST_BASE = 2 ** 40;

    const salvageUsable = (data, present, i) => (!present || !present.length || present[i] !== 0) && ODD_PARITY[data[i] & 0xFF] === 1;
    const usableStretch = (data, present, i) => {
        for (let k = 0; k < SALVAGE_STRETCH; k++) if (!salvageUsable(data, present, i + k)) return false;
        return true;
    };
    /** Six 7-bit bytes as one number (the channel keys an outer map). */
    const stretchKey = (data, i) => {
        let key = 0;
        for (let k = 0; k < SALVAGE_STRETCH; k++) key = key * 128 + (data[i + k] & 0x7F);
        return key;
    };
    const indexStretch = (index, channel, key, entry) => {
        if (!index.has(channel)) index.set(channel, new Map());
        const byKey = index.get(channel);
        let list = byKey.get(key);
        if (!list) byKey.set(key, list = []);
        list.push(entry[0], entry[1]);           // flat [target, position, target, position, …]
    };

    /** Where the index's stretches propose `run` sits: the most proposed placements first. */
    const salvageProposals = (index, run) => {
        const byKey = index.get(run.channel);
        if (!byKey || run.data.length < SALVAGE_STRETCH) return [];
        const votes = new Map(), n = run.data.length;
        // Usable bytes in a row ending at each position, so a stretch is tested once rather than byte by byte
        let streak = 0;
        for (let end = 0; end < n; end++) {
            streak = salvageUsable(run.data, run.present, end) ? streak + 1 : 0;
            if (streak < SALVAGE_STRETCH) continue;
            const i = end - SALVAGE_STRETCH + 1;
            const found = byKey.get(stretchKey(run.data, i));
            if (!found || found.length > 2 * SALVAGE_MAX_STRETCH_HITS) continue;
            for (let h = 0; h < found.length; h += 2) {
                // target and offset packed in one number (offset biased to stay positive), so placements sort by both
                const key = found[h] * 1048576 + (found[h + 1] - i + 524288);
                votes.set(key, (votes.get(key) || 0) + 1);
            }
        }
        const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        const out = [];
        for (let k = 0; k < ranked.length && k < SALVAGE_ALIGNMENTS_TRIED; k++) {
            const key = ranked[k][0], target = Math.floor(key / 1048576);
            out.push({ target, offset: key - target * 1048576 - 524288 });
        }
        return out;
    };

    /** [judged, agreed] of `run` against data/present at `offset`, over bytes both hold passing parity. */
    const salvageAgreement = (run, data, present, offset) => {
        let judged = 0, agreed = 0;
        for (let i = 0; i < run.data.length; i++) {
            const at = offset + i;
            if (at < 0 || at >= data.length || !salvageUsable(run.data, run.present, i) || !salvageUsable(data, present, at)) continue;
            judged++;
            if ((run.data[i] & 0x7F) === (data[at] & 0x7F)) agreed++;
        }
        return [judged, agreed];
    };
    const salvagePasses = ([judged, agreed]) => judged >= SALVAGE_MIN_JUDGED && agreed * 100 >= judged * SALVAGE_MIN_AGREE;
    const salvagePercent = ([judged, agreed]) => (judged === 0 ? 0 : 100 * agreed / judged);

    /** A run set against its candidate placements: the best that passes, whether another is close, and all that pass. */
    const placeRun = (run, candidates, bytesOf) => {
        const out = { best: null, ambiguous: false, passing: [] };
        let bestAgreement = null, runnerUp = null;
        for (const candidate of candidates) {
            const [data, present] = bytesOf(candidate.target);
            const agreement = salvageAgreement(run, data, present, candidate.offset);
            if (!salvagePasses(agreement)) continue;
            out.passing.push(candidate);
            if (!out.best || salvagePercent(agreement) > salvagePercent(bestAgreement)) {
                if (out.best && out.best.target !== candidate.target) runnerUp = salvagePercent(bestAgreement);
                out.best = candidate;
                bestAgreement = agreement;
            } else if (candidate.target !== out.best.target) runnerUp = Math.max(runnerUp ?? 0, salvagePercent(agreement));
        }
        out.ambiguous = !!out.best && runnerUp !== null && salvagePercent(bestAgreement) - runnerUp < SALVAGE_CLEAR_MARGIN;
        return out;
    };

    /** Clusters found to be one page, each with where its frame sits in its root's (a union-find with offsets). */
    class ClusterUnion {
        constructor() { this.parent = []; this.shift = []; this.lo = []; this.hi = []; }
        add(lo, hi) { this.parent.push(this.parent.length); this.shift.push(0); this.lo.push(lo); this.hi.push(hi); }
        find(cluster) {
            let shift = 0, at = cluster;
            while (this.parent[at] !== at) { shift += this.shift[at]; at = this.parent[at]; }
            return [at, shift];
        }
        extend(cluster, lo, hi) {
            const [root, shift] = this.find(cluster);
            this.lo[root] = Math.min(this.lo[root], lo + shift);
            this.hi[root] = Math.max(this.hi[root], hi + shift);
        }
        join(a, b, delta, longest) {
            const [rootA, shiftA] = this.find(a), [rootB, shiftB] = this.find(b);
            if (rootA === rootB) return;
            const moved = delta + shiftA - shiftB;
            const lo = Math.min(this.lo[rootA], this.lo[rootB] + moved), hi = Math.max(this.hi[rootA], this.hi[rootB] + moved);
            if (hi - lo > longest) return;
            this.parent[rootB] = rootA;
            this.shift[rootB] = moved;
            this.lo[rootA] = lo;
            this.hi[rootA] = hi;
        }
    }

    /** The mean log-likelihood per byte pair the model gives data, read as a receiver reads it; -Infinity if none. */
    const dialectScore = (model, data, present) => {
        const roles = readRoles(data);
        const arrived = (i) => data[i] !== 0 && (!present || !present.length || present[i] !== 0);
        let total = 0, pairs = 0, i = 0;
        while (i < roles.length) {
            const role = roles[i];
            if ((role !== ROLE_TEXT && role !== ROLE_PDI) || !arrived(i)) { i++; continue; }
            let j = i;
            while (j < roles.length && roles[j] === role && arrived(j)) j++;
            const count = j - i;
            if (count >= 2) {
                const mean = role === ROLE_TEXT ? model.textScore(data, i, count) : model.pdiScore(data, i, count);
                total += mean * (count - 1);
                pairs += count - 1;
            }
            i = j;
        }
        return pairs === 0 ? -Infinity : total / pairs;
    };

    /**
     * The packets of groups whose synchronizing packet was lost (decode-orc PR #328). A run that is a copy of a
     * catalogued record fills that record's holes — never a byte the vote settled. Runs no record holds are grouped,
     * and a group of two or more, or one clean run, becomes a page of its own listed without its identity
     * ("LOST1" …), if its code reads like the service's own pages.
     */
    /**
     * The fills a run may make where the record agrees with it right beside the hole (JS-only, not in decode-orc):
     * a run that agrees with a record overall can still have lost a packet without a gap showing, so its bytes after
     * that point sit a block out. A run's bytes go into a hole only where the nearest bytes both hold agree on each
     * side the run reaches, and at least one side vouches for it.
     */
    const SALVAGE_EDGE_WITNESSES = 6, SALVAGE_EDGE_REACH = 48, SALVAGE_EDGE_MIN = 4;
    const salvageVouchedFills = (run, record, offset, fills) => {
        if (!fills.length) return fills;
        const present = record.present || [];
        const side = (from, step) => {
            let judged = 0, agreed = 0;
            for (let at = from, walked = 0; walked < SALVAGE_EDGE_REACH && judged < SALVAGE_EDGE_WITNESSES; at += step, walked++) {
                const i = at - offset;
                if (i < 0 || i >= run.data.length || at < 0 || at >= record.data.length) break;
                if (!salvageUsable(run.data, run.present, i) || !salvageUsable(record.data, present, at)) continue;
                judged++;
                if ((run.data[i] & 0x7F) === (record.data[at] & 0x7F)) agreed++;
            }
            return { judged, agreed };
        };
        const kept = [];
        for (let start = 0; start < fills.length;) {
            let end = start;
            while (end + 1 < fills.length && fills[end + 1] === fills[end] + 1) end++;
            // Widen to the whole hole, so the witnesses are bytes the record holds
            let first = offset + fills[start], last = offset + fills[end];
            while (first - 1 >= 0 && present[first - 1] === 0) first--;
            while (last + 1 < record.data.length && present[last + 1] === 0) last++;
            const sides = [side(first - 1, -1), side(last + 1, 1)];
            const ok = sides.every((s) => s.judged === 0 || s.agreed * 6 >= s.judged * 5)
                && sides.some((s) => s.judged >= SALVAGE_EDGE_MIN && s.agreed * 6 >= s.judged * 5);
            if (ok) for (let k = start; k <= end; k++) kept.push(fills[k]);
            start = end + 1;
        }
        return kept;
    };

    class Salvage {
        constructor() {
            this.runs = [];
            this.bytes = 0;
            this.stats = {
                runs_held: 0, runs_refused: 0, runs_matched: 0, bytes_filled: 0, records_filled: 0,
                runs_unmatched: 0, runs_in_pages: 0, pages_found: 0, pages_refused: 0
            };
        }

        add(loose) {
            if (loose.packets < SALVAGE_MIN_RUN_PACKETS || !loose.data.length) return;
            if (this.runs.length >= SALVAGE_MAX_RUNS || this.bytes + loose.data.length > SALVAGE_MAX_BYTES) { this.stats.runs_refused++; return; }
            const run = { channel: loose.channel, data: loose.data, present: [...loose.present], clock: loose.clock };
            if (loose.starts_sync) {
                // The group header that did not decode, and the record header after it (all Hamming 8/4, which passes
                // odd parity), are no presentation code
                let skip = GROUP_HEADER_SIZE;
                if (run.data.length > skip) {
                    const header = decodeRecordHeader(run.data.slice(skip));
                    if (header) skip += header.header_bytes;
                }
                skip = Math.min(skip, run.data.length);
                for (let i = 0; i < skip; i++) run.present[i] = 0;
            }
            this.bytes += run.data.length;
            this.runs.push(run);
        }

        /** Fill the records' holes from runs that are copies of them, and append the pages the rest make up. */
        apply(records) {
            const stats = this.stats;
            stats.runs_held = this.runs.length;
            if (!this.runs.length) return stats;
            const runs = this.runs;

            // Channels a record was named on as transmitted, and the record types there
            // Captions are not catalogued records in decode-orc (they go to a caption stream), so they neither name a
            // channel for salvage nor take its runs
            const isCaption = (record) => !!(record.flags && record.flags.caption) && isPresentation(record.type);
            const namedChannels = new Map();
            for (const record of records) {
                if (record.attested_n > 0 && !record.identity_lost && !isCaption(record)) {
                    if (!namedChannels.has(record.channel)) namedChannels.set(record.channel, new Map());
                    const types = namedChannels.get(record.channel);
                    types.set(record.type, (types.get(record.type) || 0) + 1);
                }
            }
            const presentOf = (record) => record.present || [];
            const recordIndex = new Map(), named = records.length;
            for (let r = 0; r < named; r++) {
                const record = records[r];
                if (!namedChannels.has(record.channel) || record.data.length < SALVAGE_STRETCH || isCaption(record)) continue;
                for (let p = 0; p + SALVAGE_STRETCH <= record.data.length; p++) {
                    if (usableStretch(record.data, presentOf(record), p)) indexStretch(recordIndex, record.channel, stretchKey(record.data, p), [r, p]);
                }
            }
            const recordBytes = (r) => [records[r].data, presentOf(records[r])];

            const readings = new Map(), unmatched = [], taken = new Array(runs.length).fill(false);
            runs.forEach((run, h) => {
                if (!namedChannels.has(run.channel)) return;
                const placed = placeRun(run, salvageProposals(recordIndex, run), recordBytes);
                if (!placed.passing.length) { unmatched.push(h); return; }
                taken[h] = true;
                stats.runs_matched++;
                if (placed.ambiguous) return;
                const record = records[placed.best.target], present = record.present;
                if (!present || !present.length) return;          // arrived whole: nothing to fill
                const offset = placed.best.offset;
                const fills = [];
                for (let i = 0; i < run.data.length; i++) {
                    const at = offset + i;
                    if (at < 0 || at >= record.data.length || !salvageUsable(run.data, run.present, i)) continue;
                    if (present[at] !== 0) continue;              // the vote settled this byte, and a run is one reading
                    // JS-only: a single reading never supplies a clear screen or CAN (a misread 0x4C read as 0x0C would
                    // clear the screen); the hole is left for the interpreter, which reads past it. Other controls -- the
                    // shifts, line ends and cursor moves pages are full of -- are filled as decode-orc fills them, or a
                    // hole holding one is never filled whole (CBS 1984-01-02, a tape missing one packet in eight from
                    // its groups: its pages came out stacked and scrambled where decode-orc's are clean)
                    const code = run.data[i] & 0x7F;
                    if (code === 0x0C || code === 0x18) continue;
                    fills.push(i);
                }
                for (const i of salvageVouchedFills(run, record, offset, fills)) {
                    const at = offset + i;
                    const key = `${placed.best.target},${at}`;
                    if (!readings.has(key)) readings.set(key, new Map());
                    const values = readings.get(key);
                    values.set(run.data[i], (values.get(run.data[i]) || 0) + 256);
                }
            });
            // JS-only: a hole is filled only where the runs deliver all of it. A hole half filled leaves the code
            // mid-command either way, and a run with a gap of its own inside a hole may have lost a packet there too.
            const wholeHoles = new Set();
            for (const key of readings.keys()) {
                const [target, at] = key.split(',').map(Number);
                const present = records[target].present;
                if (at > 0 && present[at - 1] === 0) continue;      // not the first byte of its hole
                let end = at;
                while (end < present.length && present[end] === 0) end++;
                let covered = true;
                for (let k = at; k < end && covered; k++) covered = readings.has(`${target},${k}`);
                if (covered) for (let k = at; k < end; k++) wholeHoles.add(`${target},${k}`);
            }
            const filledPerRecord = new Map();
            for (const [key, values] of readings) {
                if (!wholeHoles.has(key)) continue;
                const [target, at] = key.split(',').map(Number);
                let chosen = null, most = -1;
                for (const [value, weight] of [...values].sort((a, b) => a[0] - b[0])) if (weight > most) { chosen = value; most = weight; }
                const record = records[target];
                if (!filledPerRecord.has(target)) {
                    // Copy before writing: the record's bytes may be shared with the catalog's caches
                    record.data = [...record.data];
                    record.present = [...record.present];
                }
                record.data[at] = chosen;
                record.present[at] = 1;
                filledPerRecord.set(target, (filledPerRecord.get(target) || 0) + 1);
            }
            for (const [target, count] of filledPerRecord) {
                records[target].bytes_salvaged = (records[target].bytes_salvaged || 0) + count;
                stats.bytes_filled += count;
            }
            stats.records_filled = filledPerRecord.size;
            stats.runs_unmatched = unmatched.length;

            // The rest are pages none of the records holds: each run joins the cluster it agrees with best
            const clusters = [], clusterIndex = new Map(), pagesOf = new ClusterUnion();
            const takeInto = (cluster, id, h, run, offset) => {
                const start = Math.min(cluster.base, offset);
                const end = Math.max(cluster.base + cluster.consensus.length, offset + run.data.length);
                if (start < cluster.base) {
                    const grow = cluster.base - start;
                    cluster.consensus = new Array(grow).fill(0).concat(cluster.consensus);
                    cluster.known = new Array(grow).fill(0).concat(cluster.known);
                    cluster.base = start;
                }
                while (cluster.consensus.length < end - cluster.base) { cluster.consensus.push(0); cluster.known.push(0); }
                for (let i = 0; i < run.data.length; i++) {
                    const p = offset + i - cluster.base;
                    if (cluster.known[p] === 0 && salvageUsable(run.data, run.present, i)) { cluster.consensus[p] = run.data[i]; cluster.known[p] = 1; }
                }
                for (let i = 0; i + SALVAGE_STRETCH <= run.data.length; i++) {
                    const at = offset + i;
                    if (usableStretch(run.data, run.present, i) && !cluster.indexed.has(at)) {
                        cluster.indexed.add(at);
                        indexStretch(clusterIndex, run.channel, stretchKey(run.data, i), [id, at]);
                    }
                }
                cluster.members.push([h, offset]);
            };
            const clusterBytes = (c) => [clusters[c].consensus, clusters[c].known];
            for (const h of unmatched) {
                const run = runs[h];
                const candidates = salvageProposals(clusterIndex, run).map(({ target, offset }) => ({ target, offset: offset - clusters[target].base }));
                const placed = placeRun(run, candidates, clusterBytes);
                if (placed.best) {
                    const cluster = clusters[placed.best.target], start = placed.best.offset + cluster.base;
                    takeInto(cluster, placed.best.target, h, run, start);
                    pagesOf.extend(placed.best.target, start, start + run.data.length);
                    for (const other of placed.passing) {
                        if (other.target === placed.best.target) continue;
                        const otherStart = other.offset + clusters[other.target].base;
                        pagesOf.join(placed.best.target, other.target, start - otherStart, MAX_GROUP_BYTES);
                    }
                    continue;
                }
                if (clusters.length >= SALVAGE_MAX_RUNS) continue;
                const id = clusters.length;
                clusters.push({ channel: run.channel, base: 0, consensus: [], known: [], members: [], indexed: new Set() });
                pagesOf.add(0, run.data.length);
                takeInto(clusters[id], id, h, run, 0);
            }
            const byRoot = new Map();
            clusters.forEach((cluster, c) => {
                const [root, shift] = pagesOf.find(c);
                if (!byRoot.has(root)) byRoot.set(root, { channel: cluster.channel, members: [] });
                const page = byRoot.get(root);
                for (const [h, offset] of cluster.members) page.members.push([h, offset + shift]);
            });

            // How each channel writes NAPLPS, from its named records, and the floor a page none of them holds must reach
            const dialects = new Map(), floors = new Map(), recordRoles = new Map();
            if (byRoot.size) {
                for (let r = 0; r < named; r++) {
                    const record = records[r];
                    if (!namedChannels.has(record.channel) || !isPresentation(record.type) || isCaption(record)) continue;
                    if (!dialects.has(record.channel)) dialects.set(record.channel, new DialectModel());
                    const roles = readRoles(record.data);
                    recordRoles.set(r, roles);
                    dialects.get(record.channel).learn(record.data, presentOf(record), roles);
                }
                for (const [channel, model] of dialects) {
                    const scores = [];
                    for (let r = 0; r < named; r++) {
                        const record = records[r];
                        if (record.channel !== channel || !isPresentation(record.type) || isCaption(record)) continue;
                        const score = dialectScore(model, record.data, presentOf(record));
                        if (Number.isFinite(score)) scores.push(score);
                    }
                    if (scores.length < DIALECT_MIN_RECORDS) continue;
                    scores.sort((a, b) => a - b);
                    floors.set(channel, scores[Math.floor(scores.length * DIALECT_FLOOR_PERCENTILE / 100)] - DIALECT_FLOOR_MARGIN);
                }
            }

            const nextNumber = new Map(), pages = [];
            for (const page of byRoot.values()) {
                const first = runs[page.members[0][0]];
                if (page.members.length < 2 && Salvage.usablePercent(first) < SALVAGE_LONE_PAGE_USABLE) continue;
                let spanStart = Infinity, spanEnd = -Infinity, firstClock = Infinity, lastClock = 0;
                for (const [h, offset] of page.members) {
                    spanStart = Math.min(spanStart, offset);
                    spanEnd = Math.max(spanEnd, offset + runs[h].data.length);
                }
                const span = spanEnd - spanStart, copies = [];
                for (const [h, offset] of page.members) {
                    const run = runs[h], data = new Array(span).fill(0), present = new Array(span).fill(0), at = offset - spanStart;
                    for (let i = 0; i < run.data.length; i++) { data[at + i] = run.data[i]; present[at + i] = run.present[i]; }
                    copies.push([data, present]);
                    firstClock = Math.min(firstClock, run.clock);
                    lastClock = Math.max(lastClock, run.clock);
                }
                const [votedData, votedPresent] = voteRecord(copies);
                let start = votedData.findIndex((_, i) => votedPresent[i] !== 0);
                if (start < 0) continue;
                // The record's head went with its synchronizing packet, and with it the shift that set the bytes in
                // their set: where the first shift the page holds is SI, what comes before it is PDI code, and the
                // page starts with the SO it must have followed (supplied, and marked as not received)
                let resumesInPdi = false, firstShift = start, shiftFound = false;
                for (let i = start; i < votedData.length && i < start + SALVAGE_RESUME_SEARCH; i++) {
                    if (votedPresent[i] === 0 || !ODD_PARITY[votedData[i] & 0xFF]) continue;
                    const code = votedData[i] & 0x7F;
                    if (code === 0x0E || code === 0x0F) { firstShift = i; shiftFound = true; resumesInPdi = code === 0x0F; break; }
                }
                const dialect = dialects.get(page.channel), dialectKnown = !!dialect && dialect.records >= DIALECT_MIN_RECORDS;
                if (!resumesInPdi && dialectKnown) {
                    const end = shiftFound ? firstShift : Math.min(votedData.length, start + SALVAGE_RESUME_SEARCH);
                    if (end > start + 1) resumesInPdi = dialect.pdiScore(votedData, start, end - start) > dialect.textScore(votedData, start, end - start);
                }
                const number = (nextNumber.get(page.channel) || 0) + 1;
                const types = namedChannels.get(page.channel);
                let type = 0, most = -1;
                for (const [candidate, count] of [...types].sort((a, b) => a[0] - b[0])) if (count > most) { type = candidate; most = count; }
                const data = new Array(MAX_BLOCK).fill(0), present = new Array(MAX_BLOCK).fill(0);
                if (resumesInPdi) { data.push(0x0E); present.push(0); }
                for (let i = start; i < votedData.length; i++) { data.push(votedData[i]); present.push(votedPresent[i]); }
                if (dialectKnown && floors.has(page.channel) && !(dialectScore(dialect, data, present) >= floors.get(page.channel))) {
                    stats.pages_refused++;
                    continue;
                }
                nextNumber.set(page.channel, number);
                stats.runs_in_pages += page.members.length;
                for (const [h] of page.members) taken[h] = true;
                pages.push({
                    channel: page.channel, address: IDENTITY_LOST_BASE + number, addr_text: `LOST${number}`, long_form: true,
                    version: 0, content: 0, edition: 1, editions: 1, type, records: 1, complete: false, more_address: null,
                    flags: Object.fromEntries(FLAGS_VOTED.map((name) => [name, false])),
                    data, present, first: firstClock, last: lastClock, seen: page.members.length, intact_n: 0, attested_n: 0,
                    header_attested_n: 0, copies_voted: page.members.length, unconfirmed: false, identity_lost: true,
                    bytes_salvaged: votedData.length - start, purpose: ''
                });
            }
            pages.sort((a, b) => a.channel - b.channel);
            stats.pages_found = pages.length;
            for (const page of pages) records.push(page);
            this.unplaced = runs.filter((_, h) => !taken[h]);
            this.runs = [];
            this.bytes = 0;
            return stats;
        }

        static usablePercent(run) {
            let count = 0, arrived = 0;
            for (let i = 0; i < run.data.length; i++) {
                if (run.present[i] === 0) continue;
                arrived++;
                if (ODD_PARITY[run.data[i] & 0xFF]) count++;
            }
            return arrived === 0 ? 0 : Math.floor(count * 100 / arrived);
        }
    }

    // * * * NAPLPS color * * *
    const makeColor = (green, red, blue, transparent) => green | (red << 3) | (blue << 6) | (transparent ? 512 : 0);
    const BLACK = 0, WHITE = makeColor(7, 7, 7, false), TRANSPARENT = makeColor(0, 0, 0, true);

    /** A fully saturated hue at `angle` degrees, as the default color map defines it. */
    const hueColor = (angle) => {
        const primaries = [[240.0, 0], [120.0, 1], [0.0, 2]];   // green, red, blue
        const angularDistance = (a, b) => { const d = Math.abs(a - b); return d > 180 ? 360 - d : d; };
        const byDistance = primaries.map(([primaryAngle, gun]) => [angularDistance(angle, primaryAngle), gun])
            .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        const guns = [0, 0, 0];
        guns[byDistance[0][1]] = 7;
        guns[byDistance[2][1]] = 0;
        guns[byDistance[1][1]] = Math.floor(byDistance[0][0] / 60.0 * 7 + 0.5);
        return makeColor(guns[0], guns[1], guns[2], false);
    };
    const DEFAULT_MAP = [
        ...Array.from({ length: 8 }, (_, level) => makeColor(level, level, level, false)),   // greys
        ...Array.from({ length: 8 }, (_, step) => hueColor(360.0 * step / 8))                // hues
    ];

    class ColorState {
        constructor() { this.reset(); }

        reset() {
            this.mode = 0;               // 0 direct color, 1 color map, 2 color map with background
            this.direct = WHITE;
            this.draw_addr = 0;
            this.bg_addr = 0;
            this.resetMap();
        }

        resetMap() {
            this.map = [...DEFAULT_MAP];
            this.used = new Array(16).fill(false);
        }

        resetDrawingToWhite() { this.mode = 0; this.direct = WHITE; }

        selectMapped(address) {
            this.mode = 1;
            this.draw_addr = pythonMod(address, 16);
            this.used[this.draw_addr] = true;
        }

        selectMappedWithBackground(drawAddress, backgroundAddress) {
            this.mode = 2;
            drawAddress = pythonMod(drawAddress, 16);
            backgroundAddress = pythonMod(backgroundAddress, 16);
            if (drawAddress !== backgroundAddress) { this.draw_addr = drawAddress; this.used[drawAddress] = true; }
            this.bg_addr = backgroundAddress;
            this.used[backgroundAddress] = true;
        }

        resetToMapped(selectWhite) {
            this.resetMap();
            this.mode = 1;
            if (selectWhite && this.map.includes(WHITE)) this.draw_addr = this.map.indexOf(WHITE);
        }

        setColor(color) {
            if (this.mode !== 0) { this.map[this.draw_addr] = color; this.used[this.draw_addr] = true; return; }
            this.direct = color;
            const existing = this.map.indexOf(color);
            if (existing >= 0) { this.draw_addr = existing; return; }
            for (let address = 0; address < 16; address++) {
                if (this.used[address] || this.map[address] === BLACK || this.map[address] === WHITE) continue;
                this.map[address] = color;
                this.used[address] = true;
                this.draw_addr = address;
                return;
            }
        }

        write(address, color) {
            this.map[pythonMod(address, 16)] = color;
            this.used[pythonMod(address, 16)] = true;
        }

        setTransparent() {
            if (this.mode === 0) this.direct = TRANSPARENT; else this.map[this.draw_addr] = TRANSPARENT;
        }

        drawing() { return this.mode === 0 ? this.direct : this.map[this.draw_addr]; }

        background() { return this.mode === 2 ? this.map[this.bg_addr] : BLACK; }
    }

    /** Next color-map address in NAPLPS bit-reversed order (null when exhausted). */
    const nextMapAddress = (address) => {
        for (let bit = 3; bit >= 0; bit--) {
            const mask = 1 << bit;
            if (!(address & mask)) {
                address |= mask;
                for (let higher = 3; higher > bit; higher--) address &= ~(1 << higher);
                return address;
            }
        }
        return null;
    };
    const mapAddressFromOperand = (value, byteCount) => {
        const bits = Math.max(1, byteCount) * 6;
        return bits <= 4 ? value << (4 - bits) : value >> (bits - 4);
    };

    // * * * NAPLPS PDI operands (§5.3.1) * * *
    /** A two's-complement fraction of `bitCount` bits, in [-1, 1). */
    const signedFraction = (bits, bitCount) => {
        if (bitCount <= 0) return 0.0;
        const negative = (bits >> (bitCount - 1)) & 1, magnitude = bits & ((1 << (bitCount - 1)) - 1);
        const value = bitCount > 1 ? magnitude / (1 << (bitCount - 1)) : 0.0;
        return negative ? value - 1.0 : value;
    };
    const clampToScreen = ([x, y]) => {
        if (!(x >= 0.0 && x < 1.0)) x = Math.min(Math.max(x, 0.0), 0.9999999);
        if (!(y >= 0.0 && y < 1.0)) y = Math.min(Math.max(y, 0.0), 0.9999999);
        return [x, y];
    };

    class OperandReader {
        /** format = [single-value bytes, multi-value bytes, 3-D coordinates?] (set by DOMAIN) */
        constructor(bytes, format) { this.bytes = bytes; this.position = 0; this.format = format; this.truncated = false; }

        empty() { return this.position >= this.bytes.length; }

        remaining() { return this.bytes.length - this.position; }

        _next() {
            if (this.position >= this.bytes.length) { this.truncated = true; return 0; }
            return this.bytes[this.position++] & 0x3F;
        }

        fixed() { this.truncated = false; return this._next(); }

        single() {
            this.truncated = false;
            let value = 0;
            for (let i = 0; i < this.format[0]; i++) value = (value << 6) | this._next();
            return value;
        }

        coord() {
            this.truncated = false;
            const components = this.format[2] ? 3 : 2;
            const bitsPerByte = Math.floor(6 / components), mask = (1 << bitsPerByte) - 1;
            const xShift = 6 - bitsPerByte, yShift = 6 - 2 * bitsPerByte;
            let xBits = 0, yBits = 0, bitCount = 0;
            for (let i = 0; i < this.format[1]; i++) {
                const byte = this._next();
                xBits = (xBits << bitsPerByte) | ((byte >> xShift) & mask);
                yBits = (yBits << bitsPerByte) | ((byte >> yShift) & mask);
                bitCount += bitsPerByte;
            }
            return [signedFraction(xBits, bitCount), signedFraction(yBits, bitCount)];
        }

        color() {
            this.truncated = false;
            const byteCount = Math.max(1, Math.min(this.format[1], this.remaining()));
            let green = 0, red = 0, blue = 0, bitsPerGun = 0;
            for (let i = 0; i < byteCount; i++) {
                const byte = this._next();
                for (let triple = 1; triple >= 0; triple--) {
                    const base = triple * 3;
                    green = (green << 1) | ((byte >> (base + 2)) & 1);
                    red = (red << 1) | ((byte >> (base + 1)) & 1);
                    blue = (blue << 1) | ((byte >> base) & 1);
                    bitsPerGun++;
                }
            }
            const toThreeBits = (value) => {
                if (bitsPerGun >= 3) return value >> (bitsPerGun - 3);
                const max = (1 << bitsPerGun) - 1;
                return max ? Math.floor((value * 7 + Math.floor(max / 2)) / max) : 0;
            };
            return makeColor(toThreeBits(green), toThreeBits(red), toThreeBits(blue), false);
        }
    }

    // * * * NAPLPS primitives and interpreter * * *
    /** One drawing primitive (point, line, arc, rect, poly, incr or char) with its attributes. */
    class Primitive {
        constructor(kind) {
            this.kind = kind;
            this.points = [];
            this.origin = [0.0, 0.0];
            this.size = [0.0, 0.0];
            this.filled = false;
            this.highlighted = false;
            this.pel = [0.0, 0.0];
            this.line_tex = 0;
            this.pattern = 0;
            this.mask_size = [0.0, 0.0];
            this.mode = 0;
            this.color = WHITE;
            this.background = BLACK;
            this.caddr = -1;          // color-map address of the drawing color (-1 = direct color)
            this.baddr = -1;          // color-map address of the background (-1 = none)
            this.blinking = false;
            this.blink_to = BLACK;
            this.blink_addr = -1;
            this.incr = null;
            this.char = 0;
            this.rep = 'P';           // character set: P primary, S supplementary, M mosaic, D DRCS
            this.rotation = 0;
            this.path = 0;
            this.reverse = false;
            this.underlined = false;
            this.t = 0.0;             // time it appears on screen (s)
            this.daddr = 0;           // drawing address, for blinking of direct colors
        }
    }

    const FIELD_NORMAL = [1.0 / 40.0, 5.0 / 128.0];   // 40 × 20 character cells

    class TextState {
        constructor() { this.reset(); }

        reset() {
            this.rotation = 0; this.path = 0; this.ics = 0; this.irs = 0; this.move = 0;
            this.field = FIELD_NORMAL; this.reverse = false; this.underlined = false;
        }
    }

    // Plain data (no methods) so they survive structured cloning out of the Web Worker.
    class DrcsCharacter {
        constructor(code, width, height) {
            this.code = code; this.w = width; this.h = height; this.el = new Array(width * height).fill(false);
        }
    }
    class FillMask {
        constructor(width = 0, height = 0) { this.w = width; this.h = height; this.el = new Array(width * height).fill(false); }
    }

    const ESC = 0x1B, NSR = 0x1F, CAN = 0x18, APS = 0x1C;
    const TRANSPARENT_C0 = new Set([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10, 0x11, 0x12, 0x13,
        0x14, 0x15, 0x16, 0x17]);
    // Nominal receiver drawing speed (seconds per primitive; the standard does not set one) and
    // C1 BLINK START timing in tenths of a second (§6.2.8.1: "implementation-dependent").
    const BLINK_C1 = [5, 5, 0];
    const SET_PRIMARY = 0, SET_SUPPLEMENTARY = 1, SET_PDI = 2, SET_MOSAIC = 3, SET_MACRO = 4, SET_DRCS = 5, SET_NULL = 6;
    const STORAGE_LIMIT = 3072, MAX_MACRO_DEPTH = 8;
    const DEFINITION_C1 = new Set([0x40, 0x41, 0x42, 0x43, 0x44, 0x45]);
    const DESIGNATION_SLOTS = {
        0x28: [0, false], 0x29: [1, true], 0x2A: [2, true], 0x2B: [3, true],
        0x2D: [1, true], 0x2E: [2, true], 0x2F: [3, true]
    };
    const DESIGNATION_SETS = {
        0x42: [SET_PRIMARY, false], 0x7C: [SET_SUPPLEMENTARY, false], 0x57: [SET_PDI, true],
        0x7D: [SET_MOSAIC, true], 0x7A: [SET_MACRO, true], 0x7B: [SET_DRCS, true]
    };

    /** bytes[position] is the byte after ESC. Returns [kind, length including ESC, slot, set or code]. */
    const parseEscape = (bytes, position) => {
        let i = position;
        const intermediates = [];
        while (i < bytes.length && bytes[i] >= 0x20 && bytes[i] <= 0x2F) { intermediates.push(bytes[i]); i++; }
        if (i >= bytes.length) return ['trunc', 1 + i - position, 0, 0];
        const final = bytes[i];
        if (!(final >= 0x30 && final <= 0x7E)) return ['bad', 1 + i - position, 0, 0];
        const length = 1 + i - position + 1;
        if (!intermediates.length) {
            if (final === 0x6E) return ['shift', length, 2, 0];
            if (final === 0x6F) return ['shift', length, 3, 0];
            if (final >= 0x40 && final <= 0x5F) return ['c1', length, 0, final];
            return ['unsup', length, 0, 0];
        }
        if (intermediates.length > 1 || intermediates[0] === 0x21 || intermediates[0] === 0x22) return ['unsup', length, 0, 0];
        const slot = DESIGNATION_SLOTS[intermediates[0]];
        if (!slot) return ['unsup', length, 0, 0];
        const [set, needs96] = DESIGNATION_SETS[final] || [SET_NULL, false];
        const [slotNumber, allows96] = slot;
        if (set === SET_NULL || (needs96 && !allows96)) return ['desig', length, slotNumber, SET_NULL];
        return ['desig', length, slotNumber, set];
    };
    const isNonSpacingAccent = (code) => code >= 0x40 && code <= 0x4F;

    const SPACING_FACTORS = [1.0, 1.25, 1.5, 1.0], ROW_SPACING_FACTORS = [1.0, 1.25, 1.5, 2.0];
    const PATH_DIRECTIONS = [[1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0]];

    // An area as [left, right, bottom, top]; a character field's extent from its origin as [x0, x1, y0, y1], by
    // rotation (decode-orc PR #328)
    const UNIT_SCREEN_AREA = [0.0, 1.0, 0.0, 1.0], FIELD_EDGE_TOLERANCE = 1e-9;
    const fieldExtent = (text) => {
        const width = Math.abs(text.field[0]), height = Math.abs(text.field[1]);
        return [[0, width, 0, height], [-height, 0, 0, width], [-width, 0, -height, 0], [0, height, -width, 0]][text.rotation & 3];
    };
    /** Whether a move to `next` in the direction (stepX, stepY) keeps the field inside `area` along that axis. */
    const moveFits = ([left, right, bottom, top], [x, y], [x0, x1, y0, y1], stepX, stepY) => {
        const fitsX = x + x0 >= left - FIELD_EDGE_TOLERANCE && x + x1 <= right + FIELD_EDGE_TOLERANCE;
        const fitsY = y + y0 >= bottom - FIELD_EDGE_TOLERANCE && y + y1 <= top + FIELD_EDGE_TOLERANCE;
        return (stepX === 0 || fitsX) && (stepY === 0 || fitsY);
    };
    /** `at` moved along (dx, dy), one of them zero, to put the field against that edge of `area`. */
    const againstEdge = ([x, y], [left, right, bottom, top], [x0, x1, y0, y1], dx, dy) => [
        dx < 0 ? left - x0 : dx > 0 ? right - x1 : x,
        dy < 0 ? bottom - y0 : dy > 0 ? top - y1 : y];

    // Proportional spacing (inter-character spacing code 3) as T.101 Annex D's Addendum, clause 11, has it
    // (decode-orc PR #328). Width classes 0 (narrowest) to 9 (full width), by row 0-15 and column 2-7 of the
    // primary (Table 1/T.101) and supplementary (Table 2/T.101) sets; 7/15 is not a character.
    const PRIMARY_WIDTH_CLASS = [
        [9, 5, 9, 5, 1, 5], [0, 1, 5, 6, 5, 5], [4, 5, 5, 5, 5, 5], [6, 5, 5, 5, 5, 5], [9, 5, 5, 9, 5, 2], [9, 5, 5, 5, 5, 5],
        [9, 5, 5, 9, 5, 9], [0, 5, 8, 9, 5, 9], [1, 5, 5, 9, 5, 9], [1, 5, 2, 9, 0, 5], [9, 0, 5, 9, 4, 5], [9, 3, 5, 4, 5, 5],
        [3, 5, 5, 9, 0, 0], [5, 8, 9, 4, 9, 5], [0, 5, 5, 2, 5, 9], [9, 8, 9, 9, 5, -1]];
    const SUPPLEMENTARY_WIDTH_CLASS = [
        [9, 4, 9, 5, 6, 9], [0, 9, 2, 1, 9, 9], [9, 4, 2, 9, 6, 6], [5, 4, 2, 9, 5, 5], [9, 7, 9, 9, 9, 6], [9, 6, 5, 6, 9, 0],
        [9, 9, 5, 9, 9, 4], [6, 0, 0, 9, 5, 4], [9, 9, 4, 9, 9, 7], [1, 1, 9, 9, 9, 9], [6, 6, 1, 9, 9, 9], [8, 8, 7, 9, 5, 6],
        [9, 9, 9, 9, 5, 4], [7, 9, 4, 9, 9, 2], [9, 9, 8, 9, 6, 5], [7, 8, 2, 9, 9, -1]];
    const FULL_WIDTH_CLASS = 9;
    // Clause 11.5: spacing units by font size 6-11 and width class, for fields narrower than 12/256 (two entries the
    // printed table gives as 0 are 10, as in CSA T500); clause 11.6: units taken off by class for wider fields
    const SMALL_FONT_UNITS = [
        [2, 3, 4, 3, 4, 5, 6, 4, 5, 6], [3, 4, 5, 4, 5, 6, 7, 5, 6, 7], [2, 3, 4, 4, 5, 6, 7, 6, 7, 8],
        [3, 4, 5, 5, 6, 7, 8, 7, 8, 9], [4, 5, 6, 6, 7, 8, 9, 8, 9, 10], [3, 4, 6, 6, 7, 8, 10, 8, 10, 11]];
    const LARGE_FONT_UNITS = [6, 5, 4, 4, 3, 2, 1, 2, 1, 0];

    const widthClass = (code, supplementary) => {
        if (code < 0x20 || code > 0x7F) return FULL_WIDTH_CLASS;
        const found = (supplementary ? SUPPLEMENTARY_WIDTH_CLASS : PRIMARY_WIDTH_CLASS)[code & 0x0F][(code >> 4) - 2];
        return found < 0 ? FULL_WIDTH_CLASS : found;
    };

    /** How far a character of `widthClass` moves the cursor in a field `fieldWidth` wide (clauses 11.2 to 11.6). */
    const proportionalDisplacement = (cls, fieldWidth) => {
        const column = Math.min(Math.max(cls, 0), FULL_WIDTH_CLASS);
        const units = Math.abs(fieldWidth) * 256;
        if (!(units > 0)) return 0;
        if (units < 12) {
            let scale = 1;
            while (units / scale < 6 && scale > 1 / 1024) scale /= 2;
            const size = Math.min(Math.max(Math.floor(units / scale + 1e-9), 6), 11);
            return SMALL_FONT_UNITS[size - 6][column] * scale / 256;
        }
        const n = Math.floor(units + 1e-9);
        const scaleFactor = ((Math.trunc((11 * n - 13) / 13)) | 1) - 1;
        const reduction = Math.floor((2 * LARGE_FONT_UNITS[column] * scaleFactor + 6) / 12);
        return (n - reduction) / 256;
    };

    /**
     * Whether text is spaced proportionally: spacing code 3 with the path running the way the character reads, as
     * both receivers of the day applied it (decode-orc PR #328).
     */
    const spacedProportionally = (text) => (text.ics & 3) === 3
        && ((text.rotation === 0 && text.path === 0) || (text.rotation === 1 && text.path === 2)
            || (text.rotation === 2 && text.path === 1) || (text.rotation === 3 && text.path === 3));

    // ---------------------------------------------------------------------------
    // Receiver pace (decode-orc PR #328, naplps_receiver_pace.cpp): how long a receiver of the day took over each part
    // of a page, measured by running each firmware over blocks of identical commands. Times in microseconds.
    // ---------------------------------------------------------------------------
    const PACE_TABLES = {
        // Norpak TTX 650 (1.79 MHz): fills and clears sweep up the screen from the bottom row
        ttx650: {
            faceChoice: 'columnsAndRows', character: 3400, largerCharacter: 4000, space: 1550, characterWithBackground: 6500,
            scaledCharacter: 10000, scaledCharacterRow: 400, scaledCharacterPixel: 0, scaledCharacterPixelCap: 0,
            scaledSpace: 2000, scaledSpacePixel: 0,
            point: 300, line: 3000, lineHorizontalPixel: 3.3, lineVerticalPixel: 290, lineSlopingPixel: 300,
            rectOutline: 6500, rectOutlineHorizontalPixel: 3.0, rectOutlineVerticalPixel: 290,
            rectFill: 3500, rectFillRow: 320, rectFillPixel: 2.8,
            polyOutlineVertex: 2800, polyOutlineHorizontalPixel: 3.0, polyOutlineVerticalPixel: 290, polyOutlineSlopingPixel: 300,
            polyFillVertex: 4100, polyFillRow: 600, polyFillPixel: 3.0,
            arcOutline: 9200, arcFilled: 12000, arcLengthPixel: 1410, arcFillRow: 500, arcFillPixel: 1.0,
            incrementalPoints: 3000, incrementalPel: 50, scroll: 50000,
            clear: 169000, macro: 1000, definitionByte: 200,
            reset: 2200, domain: 3200, text: 10800, texture: 1000, pointSet: 3600, field: 5900, setColor: 3100, wait: 2000,
            selectColor: 1100, blink: 2800, drawingCommand: 3500,
            shift: 300, cursorMove: 900, aps: 1000, nsr: 9800, otherC0: 500,
            sizeControl: 9500, blinkControl: 1800, otherC1: 1000, sweep: 'up'
        },
        // Panasonic TU-2000x (6809 at 1.5 MHz): fills and clears sweep down the screen from the top row
        tu2000x: {
            faceChoice: 'rowsAlone', character: 4700, largerCharacter: 4500, space: 3500, characterWithBackground: 5500,
            scaledCharacter: 4600, scaledCharacterRow: 0, scaledCharacterPixel: 80, scaledCharacterPixelCap: 9600,
            scaledSpace: 3500, scaledSpacePixel: 4.0,
            point: 100, line: 1600, lineHorizontalPixel: 180, lineVerticalPixel: 180, lineSlopingPixel: 650,
            rectOutline: 1700, rectOutlineHorizontalPixel: 180, rectOutlineVerticalPixel: 180,
            rectFill: 3700, rectFillRow: 770, rectFillPixel: 2.0,
            polyOutlineVertex: 3500, polyOutlineHorizontalPixel: 180, polyOutlineVerticalPixel: 180, polyOutlineSlopingPixel: 650,
            polyFillVertex: 10000, polyFillRow: 1000, polyFillPixel: 8.0,
            arcOutline: 5300, arcFilled: 7600, arcLengthPixel: 790, arcFillRow: 350, arcFillPixel: 0.5,
            incrementalPoints: 3000, incrementalPel: 50, scroll: 50000,
            clear: 70000, macro: 1000, definitionByte: 200,
            reset: 2600, domain: 2500, text: 3900, texture: 1400, pointSet: 2300, field: 3100, setColor: 8400, wait: 2000,
            selectColor: 1100, blink: 8500, drawingCommand: 2300,
            shift: 360, cursorMove: 600, aps: 1000, nsr: 3700, otherC0: 500,
            sizeControl: 2100, blinkControl: 8400, otherC1: 1000, sweep: 'down'
        }
    };
    const PACE_PIXELS_PER_UNIT = 256, PACE_TALLEST_CELL = 200;
    /** The viewer's original nominal drawing speed (seconds per figure; filled figures twice as long): pace 'classic'. */
    const CLASSIC_DRAW_COST = { char: 0.004, point: 0.004, line: 0.012, arc: 0.02, rect: 0.02, poly: 0.02, incr: 0.05 };

    const paceOutlineLengths = (points, closed) => {
        const lengths = { horizontal: 0, vertical: 0, sloping: 0 }, count = points.length;
        if (count < 2) return lengths;
        const edges = closed ? count : count - 1;
        for (let i = 0; i < edges; i++) {
            const from = points[i], to = points[(i + 1) % count];
            const dx = Math.abs(to[0] - from[0]) * PACE_PIXELS_PER_UNIT, dy = Math.abs(to[1] - from[1]) * PACE_PIXELS_PER_UNIT;
            if (dy < 0.5) lengths.horizontal += dx;
            else if (dx < 0.5) lengths.vertical += dy;
            else lengths.sloping += Math.max(dx, dy);
        }
        return lengths;
    };
    const paceSteppedLength = (points, closed) => {
        let length = 0;
        for (let i = 0; i + 1 < points.length; i++) {
            length += Math.max(Math.abs(points[i + 1][0] - points[i][0]), Math.abs(points[i + 1][1] - points[i][1]));
        }
        if (closed && points.length > 2) {
            const first = points[0], last = points[points.length - 1];
            length += Math.max(Math.abs(first[0] - last[0]), Math.abs(first[1] - last[1]));
        }
        return length * PACE_PIXELS_PER_UNIT;
    };
    const paceRowsSpanned = (points) => {
        if (!points.length) return 0;
        let low = Infinity, high = -Infinity;
        for (const [, y] of points) { low = Math.min(low, y); high = Math.max(high, y); }
        return Math.max(Math.min(high, DISPLAY_HEIGHT) - Math.max(low, 0), 0) * PACE_PIXELS_PER_UNIT;
    };
    const paceOnScreenPixels = (origin, size) => {
        const overlap = (from, extent, limit) => Math.max(Math.min(Math.max(from, from + extent), limit) - Math.max(Math.min(from, from + extent), 0), 0);
        return overlap(origin[0], size[0], 1) * overlap(origin[1], size[1], DISPLAY_HEIGHT) * PACE_PIXELS_PER_UNIT * PACE_PIXELS_PER_UNIT;
    };
    const paceEnclosedPixels = (points) => {
        let twice = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            twice += a[0] * b[1] - b[0] * a[1];
        }
        return Math.min(Math.abs(twice) / 2, 1) * PACE_PIXELS_PER_UNIT * PACE_PIXELS_PER_UNIT;
    };

    /** The face the receiver drew a field in, and whether it scaled it (rather than copying it from the ROM). */
    const paceFaceAtField = (table, columns, rows) => {
        if (table.faceChoice === 'columnsAndRows') {
            const face = chooseFace(256, columns, rows);
            return { face, scaled: columns >= 2 * face[1] || rows >= 2 * face[2] };
        }
        const normal = FONT.FACES[0], larger = FONT.FACES.find((face) => face[5]);
        let face = normal;
        if (larger && larger[1] <= columns && larger[2] <= rows) {
            const normalFits = normal[1] <= columns && normal[2] <= rows;
            if (!normalFits || rows % larger[2] <= rows % normal[2]) face = larger;
        }
        return { face, scaled: columns >= 2 * face[1] };
    };

    const paceCharacter = (table, prim) => {
        const width = Math.abs(prim.size[0]) * PACE_PIXELS_PER_UNIT, height = Math.abs(prim.size[1]) * PACE_PIXELS_PER_UNIT;
        const withBackground = prim.mode === 2;
        const space = prim.char === 0x20 && prim.rep === 'P' && !withBackground && !prim.reverse;
        const columns = Math.max(1, referencePixels(prim.size[0])), rows = Math.max(1, referencePixels(prim.size[1]));
        const drawn = paceFaceAtField(table, columns, rows);
        if (!drawn.scaled) {
            if (space) return table.space;
            if (withBackground) return table.characterWithBackground;
            return drawn.face[5] ? table.largerCharacter : table.character;
        }
        const cellRows = Math.min(height, PACE_TALLEST_CELL);
        const pixels = Math.min(width * cellRows, table.scaledCharacterPixelCap || Infinity);
        const cappedPixels = table.scaledCharacterPixelCap ? pixels : 0;
        if (space) return table.scaledSpace + table.scaledSpacePixel * cappedPixels;
        return table.scaledCharacter + table.scaledCharacterRow * cellRows + table.scaledCharacterPixel * cappedPixels;
    };

    /** Microseconds the receiver took to draw a figure as the interpreter emits it. */
    const paceFigure = (table, prim) => {
        const t = table;
        switch (prim.kind) {
            case 'char': return paceCharacter(t, prim);
            case 'point': return t.point;
            case 'line': {
                const lengths = paceOutlineLengths(prim.points, false);
                return t.line + t.lineHorizontalPixel * lengths.horizontal + t.lineVerticalPixel * lengths.vertical +
                    t.lineSlopingPixel * lengths.sloping;
            }
            case 'rect': {
                const width = Math.abs(prim.size[0]) * PACE_PIXELS_PER_UNIT, height = Math.abs(prim.size[1]) * PACE_PIXELS_PER_UNIT;
                if (!prim.filled) return t.rectOutline + t.rectOutlineHorizontalPixel * 2 * width + t.rectOutlineVerticalPixel * 2 * height;
                const far = [prim.origin[0] + prim.size[0], prim.origin[1] + prim.size[1]];
                return t.rectFill + t.rectFillRow * paceRowsSpanned([prim.origin, far]) + t.rectFillPixel * paceOnScreenPixels(prim.origin, prim.size);
            }
            case 'poly': {
                const vertices = prim.points.length;
                if (!prim.filled) {
                    const lengths = paceOutlineLengths(prim.points, true);
                    return t.polyOutlineVertex * vertices + t.polyOutlineHorizontalPixel * lengths.horizontal +
                        t.polyOutlineVerticalPixel * lengths.vertical + t.polyOutlineSlopingPixel * lengths.sloping;
                }
                return t.polyFillVertex * vertices + t.polyFillRow * paceRowsSpanned(prim.points) + t.polyFillPixel * paceEnclosedPixels(prim.points);
            }
            case 'arc': {
                const curve = arcToPolyline(prim.points, 1 / 512);
                if (!prim.filled) return t.arcOutline + t.arcLengthPixel * paceSteppedLength(curve, false);
                return t.arcFilled + t.arcLengthPixel * paceSteppedLength(curve, true) + t.arcFillRow * paceRowsSpanned(curve) +
                    t.arcFillPixel * paceEnclosedPixels(curve);
            }
            case 'incr': return t.incrementalPoints + t.incrementalPel * (prim.incr ? prim.incr.length : 0);
            default: return 0;
        }
    };
    const PACE_PDI = {
        0x20: 'reset', 0x21: 'domain', 0x22: 'text', 0x23: 'texture', 0x24: 'pointSet', 0x25: 'pointSet',
        0x38: 'field', 0x3C: 'setColor', 0x3D: 'wait', 0x3E: 'selectColor', 0x3F: 'blink'
    };
    const pacePdi = (table, opcode) => table[PACE_PDI[opcode] || 'drawingCommand'];
    const paceC0 = (table, code) => {
        if (code === 0x1B || code === 0x0C) return 0;                     // ESC: as its C1; CS: as the clear
        if (code === 0x0E || code === 0x0F || code === 0x19 || code === 0x1D) return table.shift;
        if (code >= 0x08 && code <= 0x0B || code === 0x0D || code === 0x1E) return table.cursorMove;
        if (code === 0x1C) return table.aps;
        if (code === 0x1F) return table.nsr;
        return table.otherC0;
    };
    const paceC1 = (table, control) => {
        if ((control >= 0x4A && control <= 0x4D) || control === 0x4F) return table.sizeControl;   // the size controls
        if (control === 0x4E || control === 0x5E) return table.blinkControl;                       // BLINK START / STOP
        return table.otherC1;
    };
    /** Rows a filled figure covers, as [low, high] in unit-screen y, for the sweep. */
    const paceFillRows = (prim) => {
        if (!prim.filled) return null;
        let points = prim.points || [];
        if (prim.kind === 'rect') points = [prim.origin, [prim.origin[0] + prim.size[0], prim.origin[1] + prim.size[1]]];
        else if (prim.kind === 'arc') points = arcToPolyline(prim.points, 1 / 512);
        else if (prim.kind !== 'poly') return null;
        if (!points.length) return null;
        let low = Infinity, high = -Infinity;
        for (const [, y] of points) { low = Math.min(low, y); high = Math.max(high, y); }
        low = Math.max(low, 0); high = Math.min(high, DISPLAY_HEIGHT);
        return high > low ? [low, high] : null;
    };

    class Interpreter {
        constructor(grid = [256, 200], { font = null, pace = 'off' } = {}) {
            this.grid = grid;
            this.paceTable = PACE_TABLES[pace] || null;      // a receiver's drawing times (decode-orc PR #328), or none
            this.classicPace = pace === 'classic';            // the viewer's original fixed time per figure
            this.decoderFont = resolveDecoderFont(font);
            this.prims = [];
            this.resetDecoder();
        }

        resetEnv() {
            this.g = [SET_PRIMARY, SET_PDI, SET_SUPPLEMENTARY, SET_MOSAIC];   // G0–G3
            this.locked = 0;
            this.invoked = 0;
            this.single = false;
        }

        resetDecoder() {
            this.resetEnv();
            this.fmt = [1, 3, false];
            this.pel = [0.0, 0.0];
            this.text = new TextState();
            this.line_tex = 0; this.pattern = 0; this.highlight = false; this.mask_size = FIELD_NORMAL;
            this.color = new ColorState();
            this.field_origin = [0.0, 0.0];
            this.field_size = [1.0, 1.0];
            this.cellAddressed = false;
            this.cursor = this.home();
            this.dp = [0.0, 0.0];                     // drawing point
            this.blink = new Array(16).fill(null);
            this.blinkOrder = [];
            this.c1Blink = null;
            this.macros = new Map();
            this.drcs = new Map();
            this.masks = [new FillMask(), new FillMask(), new FillMask(), new FillMask()];
            this.storage = 0;
        }

        home() { return [0.0, DISPLAY_HEIGHT - Math.abs(this.text.field[1])]; }

        nsrReset() {
            this.resetEnv();
            this.fmt = [1, 3, false];
            this.pel = [0.0, 0.0];
            this.text.reset();
            this.field_origin = [0.0, 0.0];
            this.field_size = [1.0, 1.0];
            this.line_tex = 0; this.pattern = 0; this.highlight = false; this.mask_size = FIELD_NORMAL;
            this.color.resetDrawingToWhite();
            this.c1Blink = null;
        }

        applyCaptionState() {
            this.nsrReset();
            this.cursor = [0.0, 0.0];
            this.dp = [0.0, 0.0];
            this.color.write(0, TRANSPARENT);
            this.color.write(1, BLACK);
            this.color.write(7, WHITE);
            this.color.selectMappedWithBackground(7, 1);
        }

        drcsSize() {
            const [gridWidth, gridHeight] = this.grid;
            const columns = Math.abs(this.text.field[0]) / (1.0 / gridWidth);
            const rows = Math.abs(this.text.field[1]) / (DISPLAY_HEIGHT / gridHeight);
            return [Math.min(Math.max(roundHalfEven(columns), 1), 256), Math.min(Math.max(roundHalfEven(rows), 1), 256)];
        }

        /** Interpret one record's NAPLPS bytes. keepDisplay draws over the previous record (a "More" chain). */
        run(recordBytes, keepDisplay = false) {
            this.cellAddressed = isCellAddressed(recordBytes);
            this.lint = 0;                            // grammar problems, for settling tied votes
            this.lintSevere = 0;
            this.firstSevereAt = -1;
            this.firstProblemAt = -1;
            this.problemsAt = [];
            const carried = keepDisplay ? this.prims : [];
            this.prims = carried;
            // Timeline for on-screen playback: primitives with their times, screen clears, color-map
            // and blink changes. Time = WAIT pauses (§5.3.2.8) + the receiver's drawing times (`pace`).
            this.clock = 0.0;
            this.events = [];
            for (const prim of carried) { prim.t = 0.0; this.events.push(['p', 0.0, prim]); }
            this._lastMapSnapshot = null;
            this._lastBlinkSnapshot = null;
            this.snapState();
            this.frames = [];                         // byte streams being read: the record, then macros
            this.collecting = null;
            this.body = [];
            this.def_code = 0;
            this.def_transmit = false;
            this.drcs_target = null;
            this.mask_target = null;
            this.have_last_drcs = false;
            this.last_drcs = 0x7F;
            this.last_graphic = null;
            this.def_frame = 0;
            this.def_had_code = false;
            this.wrap = 0;                            // 0 none, 1 armed, 2 after APR, 3 after APD
            // A byte failing odd parity (§3.3) is known to be wrong. A PDI opcode failing it is skipped, as the
            // TU-2000x did (decode-orc PR #328). Of the C0 controls only CS and CAN failing it are dropped: decode-orc
            // drops them all, but in a voted record a control failing parity is often the right control with its
            // parity bit lost, and on the samples here dropping the rest (APH, SI, ESC …) did more harm than good.
            // Transparent controls are stripped. A record passed without parity (no byte with b8 set) has nothing to test.
            const carriesParity = Array.prototype.some.call(recordBytes, (byte) => (byte & 0x80) !== 0);
            const kept = [], parityFailed = [];
            // With traceRoles set, how each byte of the record was read is kept in this.roles (see readRoles())
            // The kept bytes' positions in the record, so a problem found by the grammar check is placed in the record
            // itself (positions there skip the stripped bytes, the NULs of a lost packet among them)
            const roles = this.traceRoles ? new Uint8Array(recordBytes.length) : null;
            const keptIndex = roles || this.checkingOnly ? [] : null;
            this.keptIndex = keptIndex;
            for (let i = 0; i < recordBytes.length; i++) {
                const raw = recordBytes[i], byte = raw & 0x7F, failed = carriesParity && !ODD_PARITY[raw & 0xFF];
                if (byte < 0x20 && (TRANSPARENT_C0.has(byte) || (failed && (byte === 0x0C || byte === CAN)))) {
                    if (roles) roles[i] = ROLE_TRANSPARENT;
                    continue;
                }
                kept.push(byte);
                parityFailed.push(failed);
                if (keptIndex) keptIndex.push(i);
            }
            this.roles = roles;
            this.frames.push({ bytes: kept, position: 0, parityFailed: carriesParity ? parityFailed : null });
            let steps = 0;
            while (this.frames.length) {
                steps++;
                if (steps > 400000) break;              // guard against loops in damaged data
                let traceFrom = -1, role = ROLE_UNREAD;
                if (roles && this.frames.length === 1 && this.frames[0].position < kept.length) {
                    traceFrom = this.frames[0].position;
                    role = this.roleOf(kept[traceFrom]);
                }
                if (!this.step()) {
                    this.frames.pop();
                    if (this.frames.length && this.def_frame >= this.frames.length) this.def_frame = this.frames.length - 1;
                }
                if (traceFrom >= 0 && this.frames.length) {
                    for (let k = traceFrom; k < this.frames[0].position && k < keptIndex.length; k++) roles[keptIndex[k]] = role;
                }
            }
            // A macro definition the record never ends swallows the rest of the page: a misread byte read as ESC 4/0
            // (DEF MACRO) blanks it. Counted as severe for the grammar check when it takes most of what was left
            if (this.collecting === 'macro' && !this.def_transmit && this.def_frame === 0 &&
                this.def_record_length - this.def_began > 64) {
                this.lintSevere++;
                const began = this.recordPosition(this.def_began);
                if (this.firstSevereAt < 0 || began < this.firstSevereAt) this.firstSevereAt = began;
            }
            this.endDefinition();
            this.snapState();
            const finalMap = this.color.map;
            for (const prim of this.prims) {
                if (prim.caddr >= 0) prim.color = finalMap[pythonMod(prim.caddr, 16)];
                if (prim.baddr >= 0) prim.background = finalMap[pythonMod(prim.baddr, 16)];
                if (prim.blink_addr >= 0) prim.blink_to = finalMap[pythonMod(prim.blink_addr, 16)];
            }
            return {
                prims: [...this.prims], color_map: [...finalMap], drcs: new Map(this.drcs),
                masks: [...this.masks], events: this.events, end: this.clock, sweep: this.paceTable ? this.paceTable.sweep : null
            };
        }

        /** A position among the kept bytes as a position in the record as received. */
        recordPosition(position) {
            const index = this.keptIndex;
            if (!index || !index.length) return position;
            return position < index.length ? index[position] : index[index.length - 1] + 1 + (position - index.length);
        }

        /** Count a problem that wrecks the page (a late clear or RESET, a CAN) and where in the record it was. */
        /** A grammar problem that is not severe, and where the first one was. */
        noteProblem() {
            this.lint += 1;
            if (this.frames.length) {
                const at = this.recordPosition(this.frames[0].position);
                if (this.firstProblemAt < 0) this.firstProblemAt = at;
                if (this.problemsAt.length < 64) this.problemsAt.push(at);
            }
        }

        noteSevere() {
            this.lintSevere++;
            if (this.firstSevereAt < 0 && this.frames.length) this.firstSevereAt = this.recordPosition(this.frames[0].position);
        }

        /** Record a color-map or blink event if either changed since the last snapshot. */
        snapState() {
            if (this.checkingOnly) return;                   // the grammar check needs no playback events
            const mapSnapshot = this.color.map.join(','), blinkSnapshot = JSON.stringify(this.blink);
            if (mapSnapshot !== this._lastMapSnapshot) {
                this._lastMapSnapshot = mapSnapshot;
                this.events.push(['map', this.clock, [...this.color.map]]);
            }
            if (blinkSnapshot !== this._lastBlinkSnapshot) {
                this._lastBlinkSnapshot = blinkSnapshot;
                this.events.push(['blink', this.clock, [...this.blink]]);
            }
        }

        get frame() { return this.frames[this.frames.length - 1]; }

        /** How the record's next byte will be read (for readRoles()): with what follows it, as one command. */
        roleOf(byte) {
            if ((this.collecting === 'macro' || this.collecting === 'macrox') && this.def_frame === 0) return ROLE_DEFINITION;
            if (byte < 0x20) return ROLE_CONTROL;
            const set = this.g[this.invoked];
            if (set === SET_PDI) return ROLE_PDI;
            if (set === SET_MACRO || set === SET_NULL) return ROLE_OTHER;
            return ROLE_TEXT;
        }

        step() {
            const frame = this.frame, { bytes } = frame, position = frame.position;
            if (position >= bytes.length) return false;
            const byte = bytes[position];
            frame.position = position + 1;
            const fromDefiningFrame = this.frames.length - 1 === this.def_frame;
            if (this.collecting === 'macro' || this.collecting === 'macrox') {
                if (fromDefiningFrame) {
                    if (byte === ESC) {
                        const [kind, length, , c1Code] = parseEscape(bytes, frame.position);
                        if (kind === 'c1' && DEFINITION_C1.has(c1Code)) {
                            frame.position += length - 1;
                            this.endDefinition();
                            this.execC1(c1Code);
                            return true;
                        }
                    }
                    if (this.collecting === 'macro') {
                        this.body.push(byte);
                        if (this.paceTable) this.pace(this.paceTable.definitionByte);
                        return true;
                    }
                    const start = frame.position - 1;           // macro defined and executed at once
                    this.execByte(byte);
                    const defining = this.frames[this.def_frame];
                    for (let k = start; k < defining.position; k++) this.body.push(defining.bytes[k]);
                    return true;
                }
                this.execByte(byte);
                return true;
            }
            if ((this.collecting === 'drcs' || this.collecting === 'mask') && fromDefiningFrame && !TRANSPARENT_C0.has(byte)) {
                let terminates = false;
                if (byte === ESC) {
                    const [kind, , , c1Code] = parseEscape(bytes, frame.position);
                    terminates = kind === 'c1' && DEFINITION_C1.has(c1Code);
                }
                if (!terminates) this.def_had_code = true;
            }
            this.execByte(byte);
            return true;
        }

        execByte(byte) { if (byte < 0x20) this.execC0(byte); else this.execGraphic(byte); }

        execC0(byte) {
            if (TRANSPARENT_C0.has(byte)) return;
            if (this.paceTable) this.pace(paceC0(this.paceTable, byte));
            const frame = this.frame;
            if (byte === ESC) {
                const [kind, length, slot, value] = parseEscape(frame.bytes, frame.position);
                frame.position += length - 1;
                if (kind === 'bad' || kind === 'unsup' || kind === 'trunc') this.noteProblem();
                if (kind === 'desig') this.g[slot] = value;
                else if (kind === 'shift') { this.locked = this.invoked = slot; this.single = false; }
                else if (kind === 'c1') this.execC1(value);
                return;
            }
            switch (byte) {
                case 0x0F: this.locked = this.invoked = 0; this.single = false; break;   // SI
                case 0x0E: this.locked = this.invoked = 1; this.single = false; break;   // SO
                case 0x19: this.invoked = 2; this.single = true; break;                  // SS2
                case 0x1D: this.invoked = 3; this.single = true; break;                  // SS3
                case 0x08: this.moveBy('back'); break;                                    // APB
                case 0x09: this.moveBy('fwd'); break;                                     // APF
                case 0x0A:                                                                // APD
                    if (this.wrap === 1) { this.wrap = 3; return; }
                    if (this.wrap === 2) { this.wrap = 0; return; }
                    this.moveBy('down');
                    break;
                case 0x0B: this.moveBy('up'); break;                                      // APU
                case 0x0D:                                                                // APR
                    if (this.wrap === 1) { this.wrap = 2; return; }
                    if (this.wrap === 3) { this.wrap = 0; return; }
                    this.moveCursor([this.field_origin[0], this.cursor[1]]);
                    break;
                case 0x0C:                                                                // CS (clear screen)
                    if (this.color.mode === 2) this.clearDisplay(this.color.background(), this.color.bg_addr);
                    else this.clearDisplay(BLACK, -1);
                    this.moveCursor(this.home());
                    break;
                case 0x1E: this.moveCursor(this.home()); break;                           // APH
                case NSR: {                                                               // non-selective reset
                    this.nsrReset();
                    const { bytes, position } = frame;
                    if (position + 1 < bytes.length) {
                        const rowByte = bytes[position] & 0x7F, columnByte = bytes[position + 1] & 0x7F;
                        if (rowByte >= 0x40 && rowByte <= 0x7F && columnByte >= 0x40 && columnByte <= 0x7F) {
                            frame.position += 2;
                            const cellWidth = Math.abs(this.text.field[0]), cellHeight = Math.abs(this.text.field[1]);
                            this.moveCursor([(columnByte & 0x3F) * cellWidth, DISPLAY_HEIGHT - ((rowByte & 0x3F) + 1) * cellHeight]);
                            return;
                        }
                        if (rowByte >= 0x20 && rowByte < 0x40 && columnByte >= 0x20 && columnByte < 0x40) frame.position += 2;
                    }
                    this.moveCursor(this.home());
                    break;
                }
                case CAN:                                                                              // cancel macros
                    if (this.prims.length >= 20) { this.lint += 2; this.noteSevere(); }
                    this.frames.length = 1;
                    break;
                case APS: {                                                               // active position set
                    const { bytes, position } = frame;
                    if (position + 1 >= bytes.length) return;
                    const rowByte = bytes[position], columnByte = bytes[position + 1];
                    if (rowByte < 0x20 || columnByte < 0x20) return;
                    frame.position += 2;
                    const cellWidth = Math.abs(this.text.field[0]), cellHeight = Math.abs(this.text.field[1]);
                    this.moveCursor([((columnByte & 0x7F) - 32) * cellWidth, ((rowByte & 0x7F) - 32) * cellHeight]);
                    break;
                }
                default: break;
            }
        }

        clearDisplay(color, address) {
            if (this.prims.length >= 20) { this.lint += 4; this.noteSevere(); }
            this.prims = [];
            const started = this.clock;
            this.pace(this.paceTable ? this.paceTable.clear : 0);
            this.snapState();
            this.events.push(['clear', this.clock, this.clock - started]);
            if (color === BLACK && address < 0) return;
            const fill = new Primitive('rect');
            fill.filled = true;
            fill.origin = [0.0, 0.0];
            fill.size = [1.0, DISPLAY_HEIGHT];
            fill.points = [[0.0, 0.0], [1.0, DISPLAY_HEIGHT]];
            fill.mode = this.color.mode;
            fill.color = color;
            fill.caddr = address;
            fill.daddr = address >= 0 ? address : this.color.draw_addr;
            fill.t = this.clock;
            this.prims.push(fill);
            this.events.push(['p', this.clock, fill]);
        }

        execC1(code) {
            if (this.paceTable) this.pace(paceC1(this.paceTable, code));
            if (code >= 0x40 && code <= 0x44) {                    // DEF MACRO / DEFP / DEFT / DEF DRCS / DEF TEXTURE
                const terminated = this.collecting;
                this.endDefinition();
                if (code === 0x43 && terminated === 'drcs' && this.have_last_drcs) {
                    this.beginDefinition('drcs', this.last_drcs >= 0x7F ? 0x20 : this.last_drcs + 1);
                    return;
                }
                const frame = this.frame;
                let definedCode = 0;
                if (frame.position < frame.bytes.length) {
                    definedCode = frame.bytes[frame.position];
                    if (definedCode >= 0x20) frame.position++; else return;
                }
                if (code === 0x40) { this.def_transmit = false; this.beginDefinition('macro', definedCode); }
                else if (code === 0x41) { this.def_transmit = false; this.beginDefinition('macrox', definedCode); }
                else if (code === 0x42) { this.def_transmit = true; this.beginDefinition('macro', definedCode); }
                else if (code === 0x43) this.beginDefinition('drcs', definedCode);
                else this.beginDefinition('mask', definedCode);
                return;
            }
            switch (code) {
                case 0x45: this.endDefinition(); break;                       // END
                case 0x46: {                                                  // REPEAT
                    const frame = this.frame;
                    if (frame.position >= frame.bytes.length || this.last_graphic === null) return;
                    const count = frame.bytes[frame.position];
                    if (count < 0x40) return;
                    frame.position++;
                    const graphic = this.last_graphic;
                    for (let n = 0; n < (count & 0x3F); n++) this.execGraphic(graphic);
                    break;
                }
                case 0x47: {                                                  // REPEAT TO END OF LINE
                    if (this.last_graphic === null) return;
                    const cellWidth = Math.abs(this.text.field[0]);
                    if (cellWidth <= 0) return;
                    const rightEdge = this.field_origin[0] + Math.abs(this.field_size[0]);
                    const graphic = this.last_graphic, maxRepeats = Math.trunc(1.0 / cellWidth) + 1;
                    for (let n = 0; n < maxRepeats; n++) {
                        if (this.cursor[0] + cellWidth > rightEdge) break;
                        this.execGraphic(graphic);
                    }
                    break;
                }
                case 0x48: this.text.reverse = true; break;
                case 0x49: this.text.reverse = false; break;
                case 0x4A: this.text.field = [1.0 / 80.0, 5.0 / 128.0]; break;   // small text
                case 0x4B: this.text.field = [1.0 / 32.0, 3.0 / 64.0]; break;    // medium text
                case 0x4C: this.text.field = FIELD_NORMAL; break;                // normal size
                case 0x4D: this.text.field = [1.0 / 40.0, 5.0 / 64.0]; break;    // double height
                case 0x4F: this.text.field = [1.0 / 20.0, 5.0 / 64.0]; break;    // double size
                case 0x4E:                                                       // BLINK START
                    this.c1Blink = [...BLINK_C1, this.clock];
                    break;
                case 0x5E: this.c1Blink = null; break;                          // BLINK STOP
                case 0x59: this.text.underlined = true; break;
                case 0x5A: this.text.underlined = false; break;
                default: break;
            }
        }

        execGraphic(byte) {
            const set = this.g[this.invoked];
            if (this.single) { this.invoked = this.locked; this.single = false; }
            if (set === SET_PDI) {
                if (byte >= 0x20 && byte <= 0x3F) {
                    // An opcode failing parity is skipped; its operands follow as data with no opcode in front
                    const frame = this.frame;
                    if (frame.parityFailed && frame.parityFailed[frame.position - 1]) return;
                    this.execPdi(byte);
                }
                return;
            }
            if (set === SET_MACRO) { this.invokeMacro(byte); return; }
            if (set === SET_NULL) return;
            this.last_graphic = byte;
            const character = this.make('char');
            character.char = byte;
            character.rep = { [SET_PRIMARY]: 'P', [SET_SUPPLEMENTARY]: 'S', [SET_MOSAIC]: 'M' }[set] || 'D';
            character.origin = this.cursor;
            character.points = [this.cursor];
            character.size = this.text.field;
            character.rotation = this.text.rotation;
            character.path = this.text.path;
            character.reverse = this.text.reverse;
            character.underlined = this.text.underlined;
            const mark = set === SET_SUPPLEMENTARY && isNonSpacingAccent(byte);
            const advance = this.proportionalAdvance(byte, set, mark, character);
            this.emit(character);
            if (!mark) this.moveBy('fwd', advance);
        }

        /**
         * How far a character of the repertoire moves the cursor in proportional text (0: the usual step), with its
         * field moved back so its ink starts at the cursor, as both receivers laid it (decode-orc PR #328).
         */
        proportionalAdvance(byte, set, mark, character) {
            const repertoire = set === SET_PRIMARY || set === SET_SUPPLEMENTARY;
            if (!repertoire || !spacedProportionally(this.text)) { this.pendingMarkClass = -1; return 0; }
            const supplementary = set === SET_SUPPLEMENTARY;
            let cls = widthClass(byte, supplementary);
            const atMark = this.pendingMarkClass >= 0 && this.pendingMarkCursor
                && this.pendingMarkCursor[0] === this.cursor[0] && this.pendingMarkCursor[1] === this.cursor[1];
            if (mark) {
                // Its class waits for the letter it is put on (clause 11.1)
                this.pendingMarkClass = atMark ? Math.max(this.pendingMarkClass, cls) : cls;
                this.pendingMarkCursor = this.cursor;
                return 0;
            }
            if (atMark) cls = Math.max(cls, this.pendingMarkClass);
            this.pendingMarkClass = -1;
            const field = this.text.field;
            if (referencePixels(field[0]) < SMALLEST_FIELD_COLUMNS) cls = FULL_WIDTH_CLASS;
            let displacement = proportionalDisplacement(cls, field[0]);
            if (!atMark && field[0] > 0) {
                const codePoint = supplementary ? FONT.SUPPLEMENTARY.codePointAt(byte - 0x20) : byte;
                const extent = inkExtent(codePoint, field, this.decoderFont), offset = extent ? extent[0] / 256 : 0;
                if (offset) {
                    const [x, y] = character.origin;
                    character.origin = [
                        [x - offset, x, x + offset, x][this.text.rotation & 3],
                        [y, y - offset, y, y + offset][this.text.rotation & 3]];
                    character.points = [character.origin];
                }
                // JS-only: Table 1's widths fit the receivers' own narrow letters; a face whose letters are wider runs
                // them together (the default misc-fixed draws "l" 3 pixels wide where the class gives it 2, and at
                // double size "e" 10 wide where the class gives it 9). The next letter starts clear of this one's
                // ink: a pixel clear at double size or more, and at least not over it at normal size, where a pixel
                // more for every letter would run the lines past their ends (KCBS 1986's proportional headings read
                // "Tylenol" and "Shuttle" with their letters run together)
                if (extent) displacement = Math.max(displacement, (extent[1] - extent[0] + 1 + (extent[2] > 1 ? 1 : 0)) / 256);
            }
            return displacement;
        }

        /** The operand bytes that follow a PDI opcode. */
        gatherOperands() {
            const frame = this.frame, { bytes } = frame, operands = [];
            while (frame.position < bytes.length) {
                const byte = bytes[frame.position];
                if (byte >= 0x40 && byte <= 0x7F) { operands.push(byte); frame.position++; continue; }
                if (byte < 0x20 && TRANSPARENT_C0.has(byte)) { frame.position++; continue; }
                break;
            }
            return operands;
        }

        execPdi(opcode) {
            let operandBytes = this.gatherOperands();
            // The record ended inside this command: words that arrived whole are drawn, a partial last word is not,
            // and a figure only its last word closes (arc, polygon, incremental polygon) is not drawn at all
            const frame = this.frame;
            if (this.frames.length === 1 && frame.position >= frame.bytes.length && operandBytes.length) {
                if ((opcode >= 0x2C && opcode <= 0x2F) || (opcode >= 0x34 && opcode <= 0x37) || opcode === 0x3B) return;
                if (opcode >= 0x24 && opcode <= 0x38) {
                    const wordBytes = this.fmt[1], whole = operandBytes.length - (operandBytes.length % wordBytes);
                    if (whole === 0) return;
                    operandBytes = operandBytes.slice(0, whole);
                }
            }
            if (this.paceTable) this.pace(pacePdi(this.paceTable, opcode));
            const operands = new OperandReader(operandBytes, [...this.fmt]);
            if (opcode === 0x20) this.pdiReset(operands);
            else if (opcode === 0x21) this.pdiDomain(operands);
            else if (opcode === 0x22) this.pdiText(operands);
            else if (opcode === 0x23) this.pdiTexture(operands);
            else if (opcode === 0x3C) this.pdiSetColor(operands);
            else if (opcode === 0x3E) this.pdiSelectColor(operands);
            else if (opcode === 0x3F) this.pdiBlink(operands);
            else if (opcode === 0x3D) {                         // WAIT (§5.3.2.8)
                // The first byte must be the Figure 28 format byte (0x5C), or the whole command is a null operation;
                // each byte after it is a delay in tenths of a second, zero meaning two TV fields (decode-orc PR #328)
                if (!operandBytes.length || (operandBytes[0] & 0x3F) !== 0x1C) return;
                this.snapState();
                for (const byte of operandBytes.slice(1)) this.clock += (byte & 0x3F) ? 0.1 * (byte & 0x3F) : 0.033;
                this.clock = Math.min(this.clock, 15 * 60);
            }
            else if (opcode <= 0x27) this.pdiPoint(opcode, operands);
            else if (opcode <= 0x2B) this.pdiLine(opcode, operands);
            else if (opcode <= 0x2F) this.pdiArc(opcode, operands);
            else if (opcode <= 0x33) this.pdiRect(opcode, operands);
            else if (opcode <= 0x37) this.pdiPoly(opcode, operands);
            else if (opcode === 0x38) this.pdiField(operands);
            else this.pdiIncremental(opcode, operands, operandBytes);
            if (operands.truncated) this.noteProblem();
            // JS-only: a line, arc, rectangle or polygon with no operands draws nothing; as received it is nearly
            // always an operand misread as a command (CBS 1984-02-27 reads 0x5C as 0x3C: "RECT 3C 7F 79")
            else if (this.checkingOnly && opcode >= 0x28 && opcode <= 0x37 && !operandBytes.length) this.noteProblem();
        }

        pdiReset(operands) {
            if (this.prims.length >= 20) { this.lint += 2; this.noteSevere(); }
            const first = operands.empty() ? 0 : operands.fixed(), second = operands.empty() ? 0 : operands.fixed();
            const bit = (value, number) => (value >> (number - 1)) & 1;
            if (bit(first, 1)) { this.fmt = [1, 3, false]; this.pel = [0.0, 0.0]; }
            const colorAction = bit(first, 3) * 2 + bit(first, 2);
            if (colorAction === 1) { this.color.mode = 0; this.color.resetMap(); this.color.setColor(WHITE); }
            else if (colorAction === 2) this.color.resetToMapped(this.color.mode === 0);
            else if (colorAction === 3) this.color.resetToMapped(true);
            const screenAction = bit(first, 6) * 4 + bit(first, 5) * 2 + bit(first, 4);
            if (screenAction === 1 || screenAction === 7) this.clearDisplay(BLACK, -1);
            else if (screenAction === 2 || screenAction === 5 || screenAction === 6)
                this.clearDisplay(this.color.drawing(), this.color.mode === 0 ? -1 : this.color.draw_addr);
            if (bit(second, 1)) {
                this.text.reset();
                this.field_origin = [0.0, 0.0];
                this.field_size = [1.0, 1.0];
                this.moveCursor(this.home());
            }
            if (bit(second, 2)) this.blink = new Array(16).fill(null);
            if (bit(second, 4)) { this.line_tex = 0; this.pattern = 0; this.highlight = false; this.mask_size = FIELD_NORMAL; }
            if (bit(second, 5)) {
                for (const [macroBytes] of this.macros.values()) this.storage -= Math.min(this.storage, macroBytes.length);
                this.macros = new Map();
            }
            if (bit(second, 6)) {
                this.storage -= Math.min(this.storage, 11 * this.drcs.size);
                this.drcs = new Map();
            }
        }

        pdiDomain(operands) {
            if (operands.empty()) return;
            const formerFormat = this.fmt, formerPel = this.pel;
            const first = operands.fixed();
            this.fmt = [(first & 3) + 1, ((first >> 2) & 7) + 1, !!((first >> 5) & 1)];
            if (operands.empty()) return;
            // A DOMAIN declaring 1- or 2-byte coordinates whose own pel arrives in 3 bytes was written by a sender
            // still on 3, and 3 is what its coordinates go on being sent in (decode-orc PR #328)
            if (this.fmt[1] < 3 && operands.remaining() === 3) this.fmt[1] = 3;
            operands.format = [...this.fmt];
            this.pel = operands.coord();
            // JS-only: a DOMAIN with bytes left over after its pel doesn't fit its own header, and is set aside whole,
            // as the receiver it was authored on evidently did: the EVTV "IS AT THE WHEREHOUSE!" ad (CBS 1985-06-29)
            // sends one whose pel would be 84 by 13 pixels, which sweeps every outline across the page, and its
            // design (navy panels on orange) shows only with the pel left as it was
            if (!operands.empty()) {
                this.fmt = formerFormat;
                this.pel = formerPel;
                if (this.checkingOnly) this.noteProblem();
            }
        }

        pdiText(operands) {
            if (operands.empty()) return;
            const first = operands.fixed(), text = this.text;
            text.rotation = first & 3;
            text.path = (first >> 2) & 3;
            text.ics = (first >> 4) & 3;
            if (!operands.empty()) {
                const second = operands.fixed();
                text.irs = second & 3;
                text.move = (second >> 2) & 3;
            }
            if (!operands.empty()) text.field = operands.coord();
        }

        pdiTexture(operands) {
            if (operands.empty()) return;
            const first = operands.fixed();
            this.line_tex = first & 3;
            this.highlight = !!((first >> 2) & 1);
            this.pattern = (first >> 3) & 7;
            if (!operands.empty()) this.mask_size = operands.coord();
        }

        pdiSetColor(operands) {
            if (operands.empty()) { this.color.setTransparent(); return; }
            let first = true, address = 0;
            while (!operands.empty()) {
                const color = operands.color();
                if (first) { this.color.setColor(color); address = this.color.draw_addr; first = false; continue; }
                if (this.color.mode === 0) { this.color.setColor(color); continue; }
                address = nextMapAddress(address);
                if (address === null) break;
                this.color.write(address, color);
            }
        }

        pdiSelectColor(operands) {
            const bytesPerValue = this.fmt[0];
            const valueCount = bytesPerValue ? Math.ceil(operands.remaining() / bytesPerValue) : 0;
            if (valueCount === 0) { this.color.mode = 0; return; }
            const drawAddress = mapAddressFromOperand(operands.single(), bytesPerValue);
            if (valueCount === 1) { this.color.selectMapped(drawAddress); return; }
            const backgroundAddress = mapAddressFromOperand(operands.single(), bytesPerValue);
            this.color.selectMappedWithBackground(drawAddress, backgroundAddress);
        }

        /**
         * When a blink process defined now with a start delay of `delayTenths` first turns ON (decode-orc PR #328):
         * the delay is counted from the start of the ON interval of the most recently defined active process, the one
         * under way or the next (§5.3.2.7.2), and moved on a period where that has gone by; with none running, the
         * next tenth-of-a-second tick. This is what makes one command's processes chase in step, as the NBC peacock's
         * feathers do.
         */
        firstBlinkOn(delayTenths) {
            const clock = this.clock;
            let newest = null;
            for (let i = this.blinkOrder.length - 1; i >= 0 && !newest; i--) {
                if (this.blink.includes(this.blinkOrder[i])) newest = this.blinkOrder[i];
                else this.blinkOrder.splice(i, 1);
            }
            if (!newest) return Math.ceil(clock * 10 - 1e-9) / 10;
            const [, , onTenths, offTenths, , firstOn] = newest, period = 0.1 * (onTenths + offTenths);
            let start = firstOn;
            if (clock > firstOn && period > 0) {
                start = firstOn + Math.floor((clock - firstOn) / period + 1e-9) * period;
                if (clock - start >= 0.1 * onTenths - 1e-9) start += period;
            }
            start += 0.1 * delayTenths;
            if (start < clock - 1e-9 && period > 0) start += Math.ceil((clock - start) / period - 1e-9) * period;
            return start;
        }

        pdiBlink(operands) {
            if (operands.empty()) { this.blink[this.color.draw_addr] = null; return; }
            let fromAddress = this.color.draw_addr;
            for (; ;) {
                const toAddress = mapAddressFromOperand(operands.single(), this.fmt[0]);
                const onTime = operands.empty() ? 0 : operands.fixed();
                const offTime = operands.empty() ? 0 : operands.fixed();
                const delay = !operands.empty() ? operands.fixed() : 0;
                let process = null;
                if (onTime && offTime) {
                    process = [pythonMod(toAddress, 16), null, onTime, offTime, 0, this.firstBlinkOn(delay)];
                    this.blinkOrder.push(process);
                }
                this.blink[pythonMod(fromAddress, 16)] = process;
                if (operands.empty()) return;
                fromAddress = nextMapAddress(fromAddress);
                if (fromAddress === null) return;
            }
        }

        // Figures keep the coordinates the record gave and are clipped where they are drawn (decode-orc PR #328)
        resolve(point) { return point; }

        /** A polygon, arc or incremental polygon with a vertex off the unit screen is not drawn (TU-2000x behavior). */
        static offScreen(points) {
            return points.some(([x, y]) => !(x >= 0 && x < 1 && y >= 0 && y < 1));
        }

        pdiPoint(opcode, operands) {
            const relative = opcode === 0x25 || opcode === 0x27, visible = opcode === 0x26 || opcode === 0x27;
            const execute = (offset) => {
                const target = relative ? [this.dp[0] + offset[0], this.dp[1] + offset[1]] : offset;
                this.moveDp(target);
                if (visible) {
                    const point = this.make('point');
                    point.origin = target;
                    point.points = [target];
                    this.emit(point);
                }
            };
            // An operand with no data is zero-filled: the origin, or no displacement (§5.3.2.2.5)
            if (operands.empty()) { execute([0.0, 0.0]); return; }
            const traced = this.pointTrace && opcode === 0x24 && this.frames.length === 1 ? [] : null;
            while (!operands.empty()) {
                const offset = operands.coord();
                execute(offset);
                if (traced) traced.push(offset);
                if (operands.truncated) break;
            }
            if (traced && traced.length) {
                const end = this.recordPosition(this.frames[0].position);
                this.pointTrace.push({ from: end - operands.bytes.length - 1, to: end, points: traced });
            }
        }

        pdiLine(opcode, operands) {
            const relative = opcode === 0x29 || opcode === 0x2B, hasStart = opcode === 0x2A || opcode === 0x2B;
            if (operands.empty() && opcode === 0x28) {           // LINE (Absolute) with no data: to the origin
                const line = this.make('line');
                line.origin = this.dp;
                line.points = [this.dp, [0.0, 0.0]];
                this.emit(line);
                this.moveDp([0.0, 0.0]);
                return;
            }
            while (!operands.empty()) {
                let start = this.dp;
                if (hasStart) start = operands.coord();
                const offset = operands.empty() ? [0.0, 0.0] : operands.coord();    // a missing end is zero-filled
                const end = relative ? [start[0] + offset[0], start[1] + offset[1]] : offset;
                const line = this.make('line');
                line.origin = start;
                line.points = [start, end];
                this.emit(line);
                this.moveDp(end);
                if (operands.truncated) return;
            }
        }

        pdiArc(opcode, operands) {
            const filled = opcode === 0x2D || opcode === 0x2F, hasStart = opcode === 0x2E || opcode === 0x2F;
            let start = this.dp;
            if (hasStart) { if (operands.empty()) return; start = this.resolve(operands.coord()); }
            if (operands.empty()) return;
            const arc = this.make('arc');
            arc.filled = filled;
            arc.origin = start;
            arc.points = [start];
            let previous = start;
            while (!operands.empty() && arc.points.length < 256) {
                const offset = operands.coord();
                previous = this.resolve([previous[0] + offset[0], previous[1] + offset[1]]);
                arc.points.push(previous);
                if (operands.truncated) break;
            }
            if (arc.points.length < 2) return;
            if (arc.points.length === 2) arc.points.push(start);       // two points: a full circle
            const end = arc.points[arc.points.length - 1];
            if (!Interpreter.offScreen(arc.points)) this.emit(arc); else this.noteOffScreen();
            this.moveDp(end);
        }

        pdiRect(opcode, operands) {
            const filled = opcode === 0x31 || opcode === 0x33, hasStart = opcode === 0x32 || opcode === 0x33;
            while (!operands.empty()) {
                let start = this.dp;
                if (hasStart) { start = this.resolve(operands.coord()); if (operands.empty()) return; }
                const extent = operands.coord();
                const corner = this.resolve([start[0] + extent[0], start[1] + extent[1]]);
                const rect = this.make('rect');
                rect.filled = filled;
                rect.origin = start;
                rect.size = [corner[0] - start[0], corner[1] - start[1]];
                rect.points = [start, corner];
                this.emit(rect);
                this.moveDp(this.resolve([start[0] + extent[0], start[1]]));
                if (operands.truncated) return;
            }
        }

        pdiPoly(opcode, operands) {
            const filled = opcode === 0x35 || opcode === 0x37, hasStart = opcode === 0x36 || opcode === 0x37;
            let start = this.dp;
            if (hasStart) { if (operands.empty()) return; start = this.resolve(operands.coord()); }
            const poly = this.make('poly');
            poly.filled = filled;
            poly.origin = start;
            poly.points = [start];
            let previous = start;
            while (!operands.empty() && poly.points.length < 256) {
                const offset = operands.coord();
                if (offset[0] === 0.0 && offset[1] === 0.0) continue;
                previous = this.resolve([previous[0] + offset[0], previous[1] + offset[1]]);
                poly.points.push(previous);
                if (operands.truncated) break;
            }
            // A polygon of one or two points is still drawn: its outline is at least one pel (§5.3.2.2.6)
            if (!Interpreter.offScreen(poly.points)) this.emit(poly); else this.noteOffScreen();
            this.moveDp(start);
        }

        pdiField(operands) {
            if (operands.empty()) {
                this.field_origin = [0.0, 0.0];
                this.field_size = [1.0, 1.0];
                this.moveDp(this.field_origin);
                return;
            }
            const first = operands.coord();
            if (operands.empty()) { this.field_origin = this.dp; this.field_size = first; return; }
            const extent = operands.coord();
            this.field_origin = first;
            this.field_size = extent;
            this.moveDp(this.field_origin);
        }

        pdiIncremental(opcode, operands, operandBytes) {
            if (opcode === 0x39) {                                     // INCREMENTAL POINT: a run of pixel colors
                const run = this.make('incr');
                run.origin = this.field_origin;
                run.size = this.field_size;
                run.points = [this.field_origin];
                run.incr = operandBytes.map((byte) => byte & 0x3F);
                this.emit(run);
                return;
            }
            if (operands.empty()) return;                              // INCREMENTAL LINE / POLYGON
            let step = operands.coord();
            const polygon = opcode === 0x3B;
            // Three 2-bit move nibbles per byte, b6 to b1 (Tables 16 and 17): 01 step x, 10 step y, 11 both;
            // 00 makes the next nibble a modifier: 00 toggles drawing (a null for a polygon), 01/10/11 negate x/y/both
            const points = [this.dp], drawn = [];
            let current = this.dp, draw = true, modifierNext = false;
            while (!operands.empty()) {
                const byte = operands.fixed();
                for (let shift = 4; shift >= 0; shift -= 2) {
                    const nibble = (byte >> shift) & 3;
                    if (modifierNext) {
                        if (nibble === 0) { if (polygon) continue; draw = !draw; }
                        else if (nibble === 1) step = [-step[0], step[1]];
                        else if (nibble === 2) step = [step[0], -step[1]];
                        else step = [-step[0], -step[1]];
                        modifierNext = false;
                        continue;
                    }
                    if (nibble === 0) { modifierNext = true; continue; }
                    current = [current[0] + (nibble & 1 ? step[0] : 0), current[1] + (nibble & 2 ? step[1] : 0)];
                    points.push(current);
                    drawn.push(draw);
                }
            }
            if (polygon) {
                // The final point is implicitly the first, and the area is filled; at most 256 vertices
                if (points.length >= 2) {
                    const poly = this.make('poly');
                    poly.filled = true;
                    poly.points = points.slice(0, 256);
                    poly.origin = poly.points[0];
                    if (!Interpreter.offScreen(poly.points)) this.emit(poly); else this.noteOffScreen();
                }
                this.moveDp(points[0]);
                return;
            }
            // Every run of drawn steps is one line through all of its vertices
            let line = null;
            for (let i = 0; i + 1 < points.length; i++) {
                if (!drawn[i]) { if (line) { this.emit(line); line = null; } continue; }
                if (!line) { line = this.make('line'); line.points = [points[i]]; line.origin = points[i]; }
                line.points.push(points[i + 1]);
            }
            if (line) this.emit(line);
            this.moveDp(points[points.length - 1]);
        }

        /** A new primitive carrying the current drawing attributes. */
        make(kind) {
            const prim = new Primitive(kind);
            prim.pel = this.pel;
            prim.line_tex = this.line_tex;
            prim.pattern = this.pattern;
            prim.mask_size = this.mask_size;
            prim.highlighted = this.highlight;
            prim.mode = this.color.mode;
            prim.color = this.color.drawing();
            prim.background = this.color.background();
            if (this.color.mode !== 0) prim.caddr = this.color.draw_addr;
            if (this.color.mode === 2) prim.baddr = this.color.bg_addr;
            prim.daddr = this.color.draw_addr;
            const blink = this.blink[this.color.draw_addr];
            if (blink) {
                prim.blinking = true;
                prim.blink_addr = blink[0];
                prim.blink_to = blink[0] >= 0 ? this.color.map[blink[0]] : blink[1];
            }
            if (this.c1Blink) {
                prim.c1_blink = this.color.mode === 2
                    ? [this.color.bg_addr, null, ...this.c1Blink]
                    : [-1, BLACK, ...this.c1Blink];
            }
            return prim;
        }

        /**
         * JS-only, for the grammar check: a figure off the unit screen is "in error" (§5.3.1), and on the recordings
         * nearly always a damaged byte; it counts as a problem, so a contested reading that keeps it on the screen wins.
         */
        noteOffScreen() { if (this.checkingOnly) this.noteProblem(); }

        emit(prim) {
            if (this.collecting === 'drcs' || this.collecting === 'mask') { this.drawIntoDefinition(prim); return; }
            if (this.checkingOnly && prim.kind !== 'char' && prim.points.some(([x, y]) => (prim.kind === 'rect' ? !(x >= -1 / 256 && x <= 1 + 1 / 256 && y >= -1 / 256 && y <= 1 + 1 / 256) : !(x > -1 / 256 && x < 1 + 1 / 256 && y > -1 / 256 && y < 1 + 1 / 256)))) this.noteOffScreen();
            if (this.classicPace) {
                // The original nominal drawing speed: the figure appears at once, then a fixed time per kind of figure
                this.snapState();
                prim.t = this.clock;
                prim.draw = 0;
                this.prims.push(prim);
                this.events.push(['p', this.clock, prim]);
                this.clock += (CLASSIC_DRAW_COST[prim.kind] ?? 0.02) * (prim.filled ? 2.0 : 1.0);
                return;
            }
            // The figure is on the screen once the receiver has drawn it; a fill is swept on over that time
            const started = this.clock;
            this.pace(this.paceTable ? paceFigure(this.paceTable, prim) : 0);
            this.snapState();
            prim.t = this.clock;
            prim.draw = this.clock - started;
            this.prims.push(prim);
            this.events.push(['p', this.clock, prim]);
        }

        /** Advance the clock by what the receiver took over a command (nothing with the pace off). */
        pace(microseconds) {
            if (!this.paceTable || !(microseconds > 0) || this.checkingOnly) return;
            // Colour changes made before this belong before it on the clock
            this.snapState();
            this.clock = Math.min(this.clock + microseconds / 1e6, 15 * 60);
        }

        staysOnRow(point) {
            const horizontal = this.text.path === 0 || this.text.path === 1;
            const across = horizontal ? point[1] - this.cursor[1] : point[0] - this.cursor[0];
            const rowHeight = Math.abs(horizontal ? this.text.field[1] : this.text.field[0]);
            return Math.abs(across) < Math.max(rowHeight, 1e-9) * 0.5;
        }

        moveDp(point) {
            this.dp = point;
            if (this.text.move === 0 || this.text.move === 2) {
                const cursor = clampToScreen(point);            // the cursor, unlike a drawing, stays on the screen
                if (!this.staysOnRow(cursor)) this.wrap = 0;
                this.cursor = cursor;
            }
        }

        /** The area the cursor is confined to: the active field where the character field at the cursor lies in it. */
        confiningArea(extent) {
            const [originX, originY] = this.field_origin, [sizeX, sizeY] = this.field_size;
            if (originX === 0 && originY === 0 && sizeX === 1 && sizeY === 1) return UNIT_SCREEN_AREA;
            const shiftX = sizeX < 0 ? 1 / 256 : 0, shiftY = sizeY < 0 ? 1 / 256 : 0;
            const field = [Math.min(originX, originX + sizeX) + shiftX, Math.max(originX, originX + sizeX) + shiftX,
            Math.min(originY, originY + sizeY) + shiftY, Math.max(originY, originY + sizeY) + shiftY];
            return moveFits(field, this.cursor, extent, 1, 1) ? field : UNIT_SCREEN_AREA;
        }

        moveCursor(point) {
            this.wrap = 0;
            this.cursor = clampToScreen(point);
            if (this.text.move === 0 || this.text.move === 1) this.dp = this.cursor;
        }

        moveBy(direction, along = 0) {
            const text = this.text, horizontal = text.path === 0 || text.path === 1;
            // JS-only: a character steps a whole number of reference pixels, the field's width truncated to them, as
            // the pages show the receivers did: the default 1/40 field steps 6/256, not 6.4/256, which is what
            // lets index lines laid out to 42 columns (WIVB's "....p1") end inside their boxes instead of wrapping
            // Turned 90 or 270 degrees, the field's height lies across the screen and its width up it, so those are
            // what a movement along x or y is measured by (§5.3.2.3.4 "depending on the character path and character
            // rotation", decode-orc PR #328): WCIA 1990's network names run up the side of its TV listings
            // JS-only: a record that places its text by row and column (NSR or APS with a position) is laid out on
            // the grid of whole character fields those address, so there a character steps the field exactly and the
            // row stays on that grid: WCBS 1983-04-13 fills 40 columns of 1/40 edge to edge, which whole-pixel steps
            // ended at pixel 240, leaving a black strip down the right of every page
            const turned = (text.rotation & 1) === 1;
            const across = turned ? text.field[1] : text.field[0], up = turned ? text.field[0] : text.field[1];
            const pathExtent = Math.abs(horizontal ? across : up);
            const characterStep = (this.cellAddressed ? pathExtent : Math.max(1, referencePixels(pathExtent)) / 256) * SPACING_FACTORS[text.ics & 3];
            const rowStep = Math.abs(horizontal ? up : across) * ROW_SPACING_FACTORS[text.irs & 3];
            let distance = (direction === 'fwd' || direction === 'back') ? characterStep : rowStep;
            if (direction === 'fwd' && along > 0) distance = along;
            // APB and APF in proportional text step the full-width class (clause 11.1)
            else if ((direction === 'fwd' || direction === 'back') && spacedProportionally(text)) distance = proportionalDisplacement(FULL_WIDTH_CLASS, text.field[0]);
            const [pathX, pathY] = PATH_DIRECTIONS[text.path];
            const [stepX, stepY] = {
                fwd: [pathX, pathY], back: [-pathX, -pathY], down: [pathY, -pathX], up: [-pathY, pathX]
            }[direction];
            let newX = this.cursor[0] + stepX * distance, newY = this.cursor[1] + stepY * distance;
            const rightEdge = this.field_origin[0] + Math.abs(this.field_size[0]);
            let wrapped = direction === 'fwd' && text.path === 0 && newX + Math.abs(text.field[0]) > rightEdge + 1e-9;
            if (wrapped) { newX = this.field_origin[0]; newY -= rowStep; }
            // Along the other paths, a character that would leave the active field (where the cursor's field lies
            // in it) or the unit screen wraps the same way: back to the edge the path starts from, then one row on
            // (§5.3.2.3.6, decode-orc PR #328). KLFY 1991-06-29's "Premium Channels" footnote is sent on the upward
            // path its rotated channel names used, into a FIELD one row high, so each letter wraps to the next
            // "row", which on that path is one field to the right, and the footnote reads across the screen
            else if (direction === 'fwd' && text.path !== 0) {
                const extent = fieldExtent(text), area = this.confiningArea(extent);
                if (!moveFits(area, [newX, newY], extent, stepX, stepY)) {
                    const [startX, startY] = againstEdge(this.cursor, area, extent, -pathX, -pathY);
                    newX = startX + pathY * rowStep;
                    newY = startY - pathX * rowStep;
                    wrapped = true;
                }
            }
            this.moveCursor([newX, newY]);
            if (wrapped) this.wrap = 1;
        }

        beginDefinition(what, code) {
            this.collecting = what;
            this.body = [];
            this.def_code = code;
            this.drcs_target = null;
            this.mask_target = null;
            this.def_frame = this.frames.length ? this.frames.length - 1 : 0;
            this.def_had_code = false;
            this.def_began = this.frames.length ? this.frames[0].position : 0;
            this.def_record_length = this.frames.length ? this.frames[0].bytes.length : 0;
            // The buffer takes the aspect of the character field (DRCS) or mask size: its larger dimension spans the
            // whole unit axis and the other only its share (§6.2.3; decode-orc PR #328)
            const shape = what === 'mask' ? this.mask_size : this.text.field;
            const across = Math.abs(shape[0]), up = Math.abs(shape[1]);
            this.def_extent = across > 0 && up > 0 ? (across >= up ? [1, up / across] : [across / up, 1]) : [1, 1];
            if (what === 'drcs') {
                const [width, height] = this.drcsSize();
                if (code >= 0x20 && code <= 0x7F) {
                    if (!this.drcs.has(code)) {
                        if (this.storage + 11 <= STORAGE_LIMIT) {
                            this.storage += 11;
                            this.drcs.set(code, new DrcsCharacter(code, width, height));
                        }
                    } else this.drcs.set(code, new DrcsCharacter(code, width, height));
                    this.drcs_target = this.drcs.get(code) || null;
                }
                this.last_drcs = code;
                this.have_last_drcs = true;
                return;
            }
            if (what === 'mask') {
                if (!(code >= 0x41 && code <= 0x44)) { this.collecting = null; return; }
                this.mask_target = this.masks[code - 0x41] = new FillMask(16, 16);
            }
        }

        endDefinition() {
            const what = this.collecting;
            if (what === null) return;
            if (what === 'macro' || what === 'macrox') {
                const code = this.def_code;
                if (code >= 0x20 && code <= 0x7F) {
                    const previous = this.macros.get(code);
                    this.macros.delete(code);
                    if (previous) this.storage -= Math.min(this.storage, previous[0].length);
                    if (this.body.length && this.storage + this.body.length <= STORAGE_LIMIT) {
                        this.storage += this.body.length;
                        this.macros.set(code, [[...this.body], this.def_transmit]);
                    }
                }
            } else {
                if (what === 'drcs' && !this.def_had_code && this.drcs_target !== null) {   // empty definition deletes
                    this.drcs.delete(this.def_code);
                    this.storage -= Math.min(this.storage, 11);
                }
                this.dp = [0.0, 0.0];
            }
            this.collecting = null;
            this.body = [];
            this.drcs_target = null;
            this.mask_target = null;
            this.def_transmit = false;
        }

        drawIntoDefinition(prim) {
            const target = this.drcs_target || this.mask_target;
            if (!target || target.w === 0 || target.h === 0) return;
            const black = prim.color === BLACK;
            const surface = new Surface(target.w, target.h);
            const rasteriser = new Rasteriser(surface, target.w, target.h, true, this.decoderFont);
            const [extentX, extentY] = this.def_extent || [1, 1];
            rasteriser.columnsPerUnit = target.w / extentX;
            rasteriser.rowsPerUnit = target.h / extentY;
            drawPrimitive(rasteriser, prim, null, { definition: true, drcs: this.drcs });
            surface.cells.forEach((cell, i) => { if (cell !== -1) target.el[i] = !black; });
        }

        invokeMacro(code) {
            if (this.collecting === 'macrox' && code === this.def_code) return;
            const macro = this.macros.get(code);
            if (!macro || macro[1]) return;
            if (this.frames.length > MAX_MACRO_DEPTH) return;
            if (this.paceTable) this.pace(this.paceTable.macro);
            this.frames.push({ bytes: macro[0], position: 0 });
        }
    }

    // * * * Receiver raster (naplps_raster.cpp, nabts_raster_view.cpp) * * *
    /** A grid of cells; each holds an ink (an id, or a color inside definitions), or -1 for empty. */
    class Surface {
        constructor(width, height) { this.w = width; this.h = height; this.cells = new Int32Array(width * height).fill(-1); }

        put(column, row, ink) {
            if (column >= 0 && column < this.w && row >= 0 && row < this.h) this.cells[row * this.w + column] = ink;
        }
    }

    const pelSpan = (extent) => Math.max(1, Math.floor(Math.abs(extent) + 0.5));
    // A negative pel is counted back from the drawing point's own cell, as both receivers did (decode-orc PR #328)
    const pelAnchor = (position, extent) => {
        const own = Math.floor(position);
        return extent < 0 ? own - pelSpan(extent) + 1 : own;
    };

    /** Line textures as the Norpak TTX 650 laid them: is the index-th cell along the line lit, for a pel `pel` cells long? */
    const linePatternLit = (texture, pel, index) => {
        const period = texture === 1 ? 2 * pel : 6 * pel;
        const phase = ((index % period) + period) % period;
        if (texture === 1) return phase === 0;                          // dotted
        if (texture === 2) return phase <= 2 * pel;                     // dashed
        if (texture === 3) return phase === 0 || (phase >= 2 * pel && phase <= 4 * pel);   // dot-dash
        return true;
    };

    /** The cells of a straight line as the TTX 650 steps it: from its lower end, error starting at half the major axis. */
    const receiverLineCells = (x0, y0, x1, y1) => {
        if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
        const dx = x1 - x0, dy = y1 - y0, columnStep = dx >= 0 ? 1 : -1, across = Math.abs(dx);
        const steep = dy > across, major = steep ? dy : across, minor = steep ? across : dy;
        let error = major >> 1, x = x0, y = y0;
        const cells = [[x, y]];
        for (let step = 0; step < major; step++) {
            error += minor;
            if (error >= major) { x += columnStep; y += 1; error -= major; }
            else if (steep) y += 1;
            else x += columnStep;
            cells.push([x, y]);
        }
        return cells;
    };

    // Arcs traced cell by cell as the Norpak TTX 650 traced them (decode-orc PR #328): coordinates in 1/64 cell
    const ARC_UNIT = 64, ARC_LARGEST_CELL = 4096, ARC_MOST_STEPS = 200000, ARC_CLOSING_STEPS = 8;
    const roundHalfAway = (value) => (value < 0 ? -Math.round(-value) : Math.round(value));
    /** The cells of the arc (or circle) through three points, or { collinear } / null when it can't be traced. */
    const arcCells = (cellPoints) => {
        if (cellPoints.length !== 3) return null;
        const units = cellPoints.map(([column, row]) => [roundHalfAway(column * ARC_UNIT), roundHalfAway(row * ARC_UNIT)]);
        if (units.some(([x, y]) => Math.abs(x) > ARC_LARGEST_CELL * ARC_UNIT || Math.abs(y) > ARC_LARGEST_CELL * ARC_UNIT)) return null;
        const [[startX, startY], [middleX, middleY], [endX, endY]] = units;
        const ax = middleX - startX, ay = middleY - startY, bx = endX - middleX, by = endY - middleY;
        const cellOf = (value) => Math.floor(value / ARC_UNIT);
        let offsetX, offsetY, counterClockwise = false;
        const circle = ax + bx === 0 && ay + by === 0;
        if (circle) {                                       // centre half the diameter, truncated, from the start; clockwise
            offsetX = -(ax >> 1);
            offsetY = -(ay >> 1);
        } else {
            const cx = ax + bx, cy = ay + by;
            // Exact integer arithmetic: the products run past 2^53
            const bAx = BigInt(ax), bAy = BigInt(ay), bCx = BigInt(cx), bCy = BigInt(cy);
            const cross = bAx * bCy - bAy * bCx;
            if (cross === 0n) return { collinear: true };
            counterClockwise = cross > 0n;
            const a2 = bAx * bAx + bAy * bAy, c2 = bCx * bCx + bCy * bCy;
            offsetX = -Number((a2 * bCy - c2 * bAy) / (2n * cross));     // BigInt division truncates toward zero
            offsetY = -Number((c2 * bAx - a2 * bCx) / (2n * cross));
        }
        const start = [cellOf(startX), cellOf(startY)], end = [cellOf(endX), cellOf(endY)];
        if ([ax, ay, bx, by, ax + bx, ay + by].every((step) => Math.abs(step) <= ARC_UNIT)) return { path: [start], circle };
        let error = 0;
        const stepRound = () => {
            let stepX, stepY;
            if (counterClockwise) { stepY = offsetX < 0 ? -1 : 1; stepX = offsetY < 0 ? 1 : -1; }
            else { stepY = offsetX < 0 ? 1 : -1; stepX = offsetY < 0 ? -1 : 1; }
            const alongX = error + 2 * stepX * offsetX + ARC_UNIT, alongY = error + 2 * stepY * offsetY + ARC_UNIT;
            const diagonal = alongX + alongY - error;
            if (Math.abs(diagonal) < Math.abs(alongX) && Math.abs(diagonal) < Math.abs(alongY)) {
                offsetX += stepX * ARC_UNIT; offsetY += stepY * ARC_UNIT; error = diagonal;
                return [stepX, stepY];
            }
            if (Math.abs(alongX) <= Math.abs(alongY)) { offsetX += stepX * ARC_UNIT; error = alongX; return [stepX, 0]; }
            offsetY += stepY * ARC_UNIT; error = alongY;
            return [0, stepY];
        };
        let at = start;
        const path = [at];
        for (let steps = 0; steps < ARC_MOST_STEPS; steps++) {
            const [stepX, stepY] = stepRound();
            at = [at[0] + stepX, at[1] + stepY];
            path.push(at);
            if (circle && steps < 2) continue;
            if (Math.abs(end[0] - at[0]) <= 1 && Math.abs(end[1] - at[1]) <= 1) break;
        }
        for (let steps = 0; steps < ARC_CLOSING_STEPS; steps++) {
            const [stepX, stepY] = stepRound();
            const next = [at[0] + stepX, at[1] + stepY];
            if (Math.abs(end[0] - next[0]) > Math.abs(end[0] - at[0]) || Math.abs(end[1] - next[1]) > Math.abs(end[1] - at[1])) break;
            at = next;
            path.push(at);
        }
        path.push(end);
        return { path, circle };
    };

    // Line textures: [on-segments, period] in pel steps (solid, dotted, dashed, dot-dash)
    const LINE_TEXTURES = {
        0: [[[0.0, 1.0]], 1.0], 1: [[[0.0, 0.0]], 2.0],
        2: [[[0.0, 2.0]], 6.0], 3: [[[0.0, 2.0], [4.0, 4.0]], 6.0]
    };
    const TAU = 2 * Math.PI;
    const normaliseAngle = (angle) => { angle %= TAU; return angle < 0 ? angle + TAU : angle; };

    // Arc samples come from sin/cos, whose last-bit rounding differs between JS engines and C
    // libraries. Samples that should fall exactly on a raster row/column (common, since NAPLPS
    // coordinates are dyadic) could then land a hair either side of it. Quantising to 2^-36
    // removes that noise so every engine draws the same pixels.
    const QUANTUM = 2 ** 36;
    const quantise = ([x, y]) => [Math.round(x * QUANTUM) / QUANTUM, Math.round(y * QUANTUM) / QUANTUM];

    /** The arc through start, middle, end as a polyline (a full circle when start = end). */
    const arcToPolyline = (controlPoints, tolerance) => {
        if (controlPoints.length !== 3) return [...controlPoints];
        const [start, middle, end] = controlPoints, polyline = [];
        if (hypot(start[0] - end[0], start[1] - end[1]) < 1e-9) {     // full circle: start and middle are a diameter
            const centreX = (start[0] + middle[0]) / 2, centreY = (start[1] + middle[1]) / 2;
            const radius = hypot(start[0] - middle[0], start[1] - middle[1]) / 2;
            if (radius < 1e-9) return [start];
            const startAngle = Math.atan2(start[1] - centreY, start[0] - centreX);
            const angleStep = Math.sqrt(8 * tolerance / radius);
            const segments = Math.min(Math.max(angleStep > 0 ? Math.ceil(TAU / angleStep) : 1, 3), 8192);
            for (let i = 0; i <= segments; i++) {
                const angle = startAngle + TAU * i / segments;
                polyline.push([centreX + radius * Math.cos(angle), centreY + radius * Math.sin(angle)]);
            }
            return polyline.map(quantise);
        }
        const [ax, ay] = start, [bx, by] = middle, [cx, cy] = end;
        const determinant = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(determinant) < 1e-12) return [start, end];        // collinear: a straight line
        const aSquared = ax * ax + ay * ay, bSquared = bx * bx + by * by, cSquared = cx * cx + cy * cy;
        const centreX = (aSquared * (by - cy) + bSquared * (cy - ay) + cSquared * (ay - by)) / determinant;
        const centreY = (aSquared * (cx - bx) + bSquared * (ax - cx) + cSquared * (bx - ax)) / determinant;
        const radius = hypot(centreX - ax, centreY - ay);
        if (radius < 1e-9) return [start, end];
        const startAngle = Math.atan2(ay - centreY, ax - centreX);
        const toMiddle = normaliseAngle(Math.atan2(by - centreY, bx - centreX) - startAngle);
        let sweep = normaliseAngle(Math.atan2(cy - centreY, cx - centreX) - startAngle);
        if (toMiddle > sweep) sweep -= TAU;                          // go the way that passes the middle point
        const angleStep = Math.sqrt(8 * tolerance / radius);
        const segments = Math.min(Math.max(angleStep > 0 ? Math.ceil(Math.abs(sweep) / angleStep) : 1, 1), 8192);
        for (let i = 0; i <= segments; i++) {
            const angle = startAngle + sweep * i / segments;
            polyline.push([centreX + radius * Math.cos(angle), centreY + radius * Math.sin(angle)]);
        }
        return polyline.map(quantise);
    };

    /** Whether the fill pattern (hatching or a defined mask) covers the point (x, y). */
    const patternCovers = (pattern, pel, maskSize, mask, x, y) => {
        const inBand = (value, pitch) => {
            if (!(Math.abs(pitch) > 1e-9)) return true;
            return (Math.abs(Math.floor(value / Math.abs(pitch))) % 2.0) < 1.0;
        };
        if (pattern === 1) return inBand(x, pel[0]);                       // vertical hatching
        if (pattern === 2) return inBand(y, pel[1]);                       // horizontal hatching
        if (pattern === 3) return inBand(x, pel[0]) || inBand(y, pel[1]);  // cross-hatching
        // A programmable mask the page never defined is not a null pattern here (§5.3.2.4.4, which decode-orc follows):
        // CBS ExtraVision pages fill with mask A without ever defining it (KCBS 1985 has 40 pages that do, none that
        // define it), and they are drawn for a 50% dither. Read as one, it shades the crayons and the camera lens, and
        // gives the four zones of the time-zone map (KCBS p63) the four tones its legend shows. Masks B to D, never
        // defined either, fill solid (read as a dither, the Panasonic logo on KCBS p40 breaks up).
        if (!mask || !(mask.w > 0 && mask.h > 0)) {
            if (pattern !== 4) return true;
            const column = Math.floor(x * 256 + 1e-6), row = Math.floor(y * 256 + 1e-6);   // receiver pixels
            return ((column + row) & 1) === 0;
        }
        const cellWidth = Math.abs(maskSize[0]), cellHeight = Math.abs(maskSize[1]);
        if (!(cellWidth > 1e-9 && cellHeight > 1e-9)) return true;
        let fractionX = (x % cellWidth) / cellWidth, fractionY = (y % cellHeight) / cellHeight;
        if (fractionX < 0) fractionX += 1;
        if (fractionY < 0) fractionY += 1;
        if (maskSize[0] < 0) fractionX = 1 - fractionX;
        if (maskSize[1] < 0) fractionY = 1 - fractionY;
        const maskColumn = Math.min(Math.max(Math.trunc(fractionX * mask.w), 0), mask.w - 1);
        const maskRow = Math.min(Math.max(Math.trunc(fractionY * mask.h), 0), mask.h - 1);
        return mask.el[maskRow * mask.w + maskColumn];
    };

    const GLYPH_INDEX = new Map(FONT.CODES.map((codePoint, index) => [codePoint, index]));

    /** Whole cells of the reference receiver (256 across the unit screen) an extent covers (decode-orc PR #328). */
    /**
     * JS-only: whether a record lays its text out by row and column, addressing CELL_ADDRESSED_POSITIONS places or
     * more with NSR or APS (WCBS 1983-04-13 positions each of its rows so); the NSR at the home position that most
     * records begin with doesn't count. Control codes never occur as operands or text, so the bytes are just scanned.
     */
    const CELL_ADDRESSED_POSITIONS = 4;
    const isCellAddressed = (bytes) => {
        const positions = new Set();
        for (let i = 0; i + 2 < bytes.length; i++) {
            const code = bytes[i] & 0x7F, row = bytes[i + 1] & 0x7F, column = bytes[i + 2] & 0x7F;
            if (code === NSR && row >= 0x40 && column >= 0x40) positions.add((row & 0x3F) * 64 + (column & 0x3F));
            else if (code === APS && row >= 0x20 && column >= 0x20) positions.add((row - 32) * 64 + (column - 32));
            else continue;
            if (positions.size >= CELL_ADDRESSED_POSITIONS) return true;
        }
        return false;
    };

    const referencePixels = (extent) => Math.floor(Math.abs(extent) * 256 + 1e-6);
    const SMALLEST_FIELD_COLUMNS = 6, SMALLEST_FIELD_ROWS = 8;     // Table D1 items 2 and 5(g)

    /** Columns and rows a face leaves over in a field, or -1 where it does not fit. */
    const faceLeftover = (face, columns, rows) => (face[1] > columns || face[2] > rows ? -1 : (columns % face[1]) + (rows % face[2]));

    /**
     * The face a receiver at `gridWidth` draws a `columns` × `rows` field from (decode-orc PR #328).
     * The TTX 650 and TU-2000x held a normal 6×10 generator and a larger 8×12 one, and chose the one that leaves
     * the fewest columns and rows over at the reference grid (the larger on a tie). Above the reference grid the
     * normal generator holds the finer faces too, and takes the finest whose height divides the field.
     */
    const chooseFace = (gridWidth, columns, rows) => {
        const normal = FONT.FACES[0], larger = FONT.FACES.find((face) => face[5]);
        const factor = Math.max(1, Math.floor(gridWidth / 256));
        if (larger) {
            const asNormal = faceLeftover(normal, Math.floor(columns / factor), Math.floor(rows / factor));
            const asLarger = faceLeftover(larger, Math.floor(columns / factor), Math.floor(rows / factor));
            if (asLarger >= 0 && (asNormal < 0 || asLarger <= asNormal)) return larger;
        }
        if (factor === 1) return normal;
        let chosen = null, chosenDivides = false, chosenArea = 0;
        for (const face of FONT.FACES) {
            const [, faceWidth, faceHeight, , , isLarger] = face;
            if (isLarger || faceWidth > columns || faceHeight > rows) continue;
            const divides = rows % faceHeight === 0, area = faceWidth * faceHeight;
            if (chosen !== null) {
                if (chosenDivides && !divides) continue;
                if (divides === chosenDivides && area <= chosenArea) continue;
            }
            chosen = face;
            chosenDivides = divides;
            chosenArea = area;
        }
        return chosen || normal;
    };
    const COMPOSED = new Map((FONT.COMPOSITIONS || []).map(([base, mark, composed]) => [base * 0x110000 + mark, composed]));
    const MARK_FORMS = new Map((FONT.MARK_FORMS || []).map(([mark, overlay, spacing]) => [mark, { overlay, spacing }]));

    /** Table 25's line and triangle graphics, drawn from the character field itself rather than a pattern. */
    const FIELD_GRAPHICS = {
        0x56: 'horizontal', 0x57: 'vertical', 0x58: 'diagonal', 0x59: 'reverseDiagonal',
        0x5A: 'filledDiagonal', 0x5B: 'filledReverseDiagonal', 0x65: 'cross'
    };

    // A field edge is truncated to a whole cell with a little slack, so a field ending on a cell boundary and the
    // next one starting there land on the same side of it (decode-orc PR #328)
    const FIELD_EDGE_SLACK = 1e-6;
    const BASELINE_FRACTION = 0.2;                                  // Table D1 item 2
    const truncatedCell = (position) => Math.floor(position + FIELD_EDGE_SLACK);

    /** One axis of a character field on the surface: `extent` cells from `origin`, towards higher or lower indices. */
    class FieldAxis {
        constructor(origin, extent, direction) { this.origin = origin; this.extent = extent; this.direction = direction; }
        cellsWithin(distance) {
            return this.direction > 0 ? truncatedCell(this.origin + distance) - truncatedCell(this.origin)
                : truncatedCell(this.origin) - truncatedCell(this.origin - distance);
        }
        cells() { return this.cellsWithin(this.extent); }
        /** A field turned to run back along an axis starts from its origin's own cell, as both receivers laid it. */
        surface(index) { return this.direction > 0 ? truncatedCell(this.origin) + index : truncatedCell(this.origin) - index; }
        centre(index) {
            const middle = this.surface(index) + 0.5;
            return this.direction > 0 ? middle - this.origin : this.origin - middle;
        }
    }

    /** What a character puts in its field: lit is its shape. Row 0 is the field's foot. */
    class FieldImage {
        constructor(columns, rows) {
            this.columns = Math.max(0, columns); this.rows = Math.max(0, rows);
            this.lit = new Uint8Array(this.columns * this.rows);
        }
        at(column, row) { return column >= 0 && column < this.columns && row >= 0 && row < this.rows && this.lit[row * this.columns + column] !== 0; }
        set(column, row) { if (column >= 0 && column < this.columns && row >= 0 && row < this.rows) this.lit[row * this.columns + column] = 1; }
        fill(firstColumn, endColumn, firstRow, endRow) {
            for (let row = firstRow; row < endRow; row++) for (let column = firstColumn; column < endColumn; column++) this.set(column, row);
        }
    }

    /**
     * Where a `patternWidth` × `patternHeight` pattern sits in a field: at a whole multiple of its size (Appendix B),
     * squeezed where the field is a little short of it; centred across with any spare column to the right, and raised
     * to put its baseline at 20% of the field's height. A DRCS buffer (descent < 0) is laid from the field's origin.
     */
    const placePattern = (patternWidth, patternHeight, descent, field) => {
        const fit = (fieldCells, patternCells) => (fieldCells >= patternCells
            ? { scale: Math.floor(fieldCells / patternCells), cells: Math.floor(fieldCells / patternCells) * patternCells }
            : { scale: 1, cells: fieldCells });
        const across = fit(field.nominalColumns, patternWidth), up = fit(field.nominalRows, patternHeight);
        const place = { columns: across.cells, rows: up.cells, firstColumn: 0, firstRow: 0, scaleAcross: across.scale, scaleUp: up.scale };
        if (descent < 0) return place;
        place.firstColumn = Math.floor((field.nominalColumns - place.columns) / 2);
        if (place.rows === place.scaleUp * patternHeight) {
            const baseline = Math.round(BASELINE_FRACTION * field.up.extent);   // extent is never negative
            place.firstRow = Math.min(Math.max(baseline - place.scaleUp * descent, 0), field.nominalRows - place.rows);
        }
        return place;
    };

    /** Lay a pattern into the image at `place`, nearest-neighbour; `lit(column, rowFromTop)`. */
    const layPattern = (image, place, width, height, lit) => {
        if (place.columns <= 0 || place.rows <= 0 || width <= 0 || height <= 0) return;
        for (let row = 0; row < place.rows; row++) {
            const sourceRow = Math.min(height - 1, Math.floor((place.rows - 1 - row) * height / place.rows));
            for (let column = 0; column < place.columns; column++) {
                const sourceColumn = Math.min(width - 1, Math.floor(column * width / place.columns));
                if (lit(sourceColumn, sourceRow)) image.set(place.firstColumn + column, place.firstRow + row);
            }
        }
    };

    const facePattern = (face, codePoint) => {
        const index = GLYPH_INDEX.get(codePoint);
        if (index === undefined) return null;
        return face[3].slice(index * face[2], (index + 1) * face[2]);
    };
    /** The box drawn for a character the face has no pattern for: the capital H's extent outlined. */
    const replacementPatterns = new Map();
    const replacementPattern = (face) => {
        if (replacementPatterns.has(face)) return replacementPatterns.get(face);
        const [, width, height] = face, capital = facePattern(face, 0x48);
        let top = height, bottom = -1, spread = 0;
        for (let row = 0; capital && row < height; row++) {
            if (capital[row]) { top = Math.min(top, row); bottom = Math.max(bottom, row); spread |= capital[row]; }
        }
        if (bottom < 0) { top = 0; bottom = height - 1; spread = (1 << width) - 1; }
        let left = 0, right = 0;
        for (let column = 0; column < width; column++) {
            const bit = 1 << (width - 1 - column);
            if (spread & bit) { if (!left) left = bit; right = bit; }
        }
        const span = right === 0 ? 0 : ((left << 1) - right);
        const rows = new Array(height).fill(0);
        for (let row = top; row <= bottom; row++) rows[row] = (row === top || row === bottom) ? span : (left | right);
        replacementPatterns.set(face, rows);
        return rows;
    };
    /**
     * How far into its field a proportionally spaced character's ink starts: the columns its pattern leaves blank
     * before the ink, where the reference receiver drew it (decode-orc PR #328). Zero for a character with no ink.
     */
    /**
     * Where a character's ink lies across its field, in reference pixels as it is drawn: [first column, last column,
     * the face's pixel width] — in the decoder font when one is chosen (laid from the field's edge), else in the
     * receivers' face (centred) — or null for a character with no ink.
     */
    const inkExtent = (codePoint, field, decoderFont = null) => {
        const columns = Math.max(1, referencePixels(field[0])), rows = Math.max(1, referencePixels(field[1]));
        const choice = decoderFont ? chooseDecoderFace(decoderFont, codePoint, columns, rows) : null;
        const face = choice ? null : chooseFace(256, columns, rows);
        const width = choice ? choice.face.w : face[1], pattern = choice ? choice.rows : facePattern(face, codePoint);
        if (!pattern) return null;
        let firstLit = width, lastLit = -1;
        for (const bits of pattern) {
            for (let column = 0; column < width; column++) {
                if ((bits >> (width - 1 - column)) & 1) { firstLit = Math.min(firstLit, column); lastLit = Math.max(lastLit, column); }
            }
        }
        if (lastLit < 0) return null;
        const scale = choice ? Math.max(1, Math.floor(choice.scaleX)) : (columns >= width ? Math.floor(columns / width) : 1);
        const firstColumn = !choice && columns >= width ? Math.floor((columns - scale * width) / 2) : 0;
        return [firstColumn + firstLit * scale, firstColumn + (lastLit + 1) * scale - 1, scale];
    };
    const layRows = (image, place, face, rows) => layPattern(image, place, face[1], face[2], (column, row) => (rows[row] >> (face[1] - 1 - column)) & 1);
    const layFacePattern = (image, face, place, codePoint) => {
        let rows = facePattern(face, codePoint);
        for (const candidate of glyphCandidates(codePoint)) {
            if (rows) break;
            rows = facePattern(face, candidate);
        }
        if (!rows) return false;
        layRows(image, place, face, rows);
        return true;
    };
    const layOrBox = (image, face, place, codePoint) => {
        if (!layFacePattern(image, face, place, codePoint)) layRows(image, place, face, replacementPattern(face));
    };
    /** Marks with no letter: the first in its spacing form, any others laid over it (Table 26). */
    const laySpacingMarks = (image, face, place, marks) => {
        marks.forEach((mark, index) => {
            const forms = MARK_FORMS.get(mark);
            layOrBox(image, face, place, !forms ? mark : (index === 0 && forms.spacing ? forms.spacing : forms.overlay));
        });
    };

    /** Draw one of Table 25's field graphics edge to edge of the field, `weight` cells across and `weightUp` up. */
    const layFieldGraphic = (image, graphic, field, weight, weightUp) => {
        const width = field.across.extent, height = field.up.extent;
        if (!(width > 0) || !(height > 0) || image.columns <= 0 || image.rows <= 0) return;
        const horizontal = () => {
            const middle = height / 2;
            image.fill(0, image.columns, field.up.cellsWithin(middle - weightUp / 2), field.up.cellsWithin(middle + weightUp / 2));
        };
        const vertical = () => {
            const middle = width / 2;
            image.fill(field.across.cellsWithin(middle - weight / 2), field.across.cellsWithin(middle + weight / 2), 0, image.rows);
        };
        const diagonal = (reverse) => {
            const touch = 10 * FIELD_EDGE_SLACK;
            for (let row = 0; row < image.rows; row++) {
                const low = Math.min(Math.max(field.up.centre(row) - 0.5, 0), height);
                const high = Math.min(Math.max(field.up.centre(row) + 0.5, 0), height);
                const from = reverse ? width - high * width / height : low * width / height;
                const to = reverse ? width - low * width / height : high * width / height;
                const first = Math.min(Math.max(field.across.cellsWithin(from), 0), image.columns - 1);
                const last = Math.min(Math.max(Math.max(field.across.cellsWithin(Math.max(from, to - touch)), first + weight - 1), 0), image.columns - 1);
                image.fill(first, last + 1, row, row + 1);
            }
        };
        const triangle = (reverse) => {
            for (let row = 0; row < image.rows; row++) {
                const rise = field.up.centre(row);
                for (let column = 0; column < image.columns; column++) {
                    const run = field.across.centre(column), edge = reverse ? width - run : run;
                    if (rise * width <= edge * height) image.set(column, row);
                }
            }
        };
        if (graphic === 'horizontal') horizontal();
        else if (graphic === 'vertical') vertical();
        else if (graphic === 'cross') { horizontal(); vertical(); }
        else if (graphic === 'diagonal') diagonal(false);
        else if (graphic === 'reverseDiagonal') diagonal(true);
        else if (graphic === 'filledDiagonal') triangle(false);
        else if (graphic === 'filledReverseDiagonal') triangle(true);
    };

    const sameCharacterField = (a, b) => Math.abs(a.origin[0] - b.origin[0]) < 1e-6 && Math.abs(a.origin[1] - b.origin[1]) < 1e-6
        && Math.abs(a.size[0] - b.size[0]) < 1e-6 && Math.abs(a.size[1] - b.size[1]) < 1e-6 && a.rotation === b.rotation;

    const resolveDecoderFont = (font) => {
        if (!font) return null;
        if (typeof font === 'object') return font;
        return loadDecoderFonts()[font] || null;
    };

    const GLYPH_STAND_INS = {
        0x27: [0x2019], 0x60: [0x2018], 0x2019: [0x27], 0x2018: [0x60], 0x2015: [0x2014, 0x2D],
        0x2014: [0x2015, 0x2D], 0x2500: [0x2014, 0x2D], 0x2502: [0x7C], 0xA4: [0x24]
    };

    const glyphCandidates = (codePoint) => {
        const candidates = [codePoint, ...(GLYPH_STAND_INS[codePoint] || [])];
        const base = String.fromCodePoint(codePoint).normalize('NFD').codePointAt(0);
        if (base !== codePoint) candidates.push(base);
        return candidates;
    };

    const chooseDecoderFace = (fontSet, codePoint, cellColumns, cellRows) => {
        for (const candidate of glyphCandidates(codePoint)) {
            const faces = fontSet.faces.filter((face) => face.glyphs[candidate]);
            if (!faces.length) continue;
            let best = null;
            for (const face of faces) {
                if (face.w > cellColumns || face.h > cellRows) continue;
                const scaleX = Math.floor(cellColumns / face.w), scaleY = Math.floor(cellRows / face.h);
                const coverage = face.w * scaleX * face.h * scaleY;
                if (!best || coverage > best.coverage || (coverage === best.coverage && face.w * face.h > best.face.w * best.face.h)) {
                    best = { face, scaleX, scaleY, coverage };
                }
            }
            if (!best) {
                const smallest = faces.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b));
                best = { face: smallest, scaleX: cellColumns / smallest.w, scaleY: cellRows / smallest.h };
            }
            return { ...best, rows: best.face.glyphs[candidate] };
        }
        return null;
    };

    class Rasteriser {
        constructor(surface, gridWidth, gridHeight, unitSquare = false, decoderFont = null) {
            this.surface = surface;
            this.decoderFont = decoderFont;
            this.columnsPerUnit = gridWidth;
            this.rowsPerUnit = unitSquare ? gridHeight : gridHeight / DISPLAY_HEIGHT;
            this.traced = null;          // while tracing a fill outline: { c0, r0, w, h, cells }
        }

        toCells(point) { return [point[0] * this.columnsPerUnit, point[1] * this.rowsPerUnit]; }

        sizeToCells(size) { return [size[0] * this.columnsPerUnit, size[1] * this.rowsPerUnit]; }

        block(anchorColumn, anchorRow, pelSize, ink) {
            const lastColumn = anchorColumn + pelSpan(pelSize[0]) - 1, lastRow = anchorRow + pelSpan(pelSize[1]) - 1;
            const traced = this.traced;
            for (let row = anchorRow; row <= lastRow; row++) {
                for (let column = anchorColumn; column <= lastColumn; column++) {
                    if (traced) {
                        if (column >= traced.c0 && column < traced.c0 + traced.w && row >= traced.r0 && row < traced.r0 + traced.h)
                            traced.cells[(row - traced.r0) * traced.w + (column - traced.c0)] = 1;
                        continue;
                    }
                    this.surface.put(column, row, ink);
                }
            }
        }

        stampCells(where, pelSize, ink) {
            this.block(pelAnchor(where[0], pelSize[0]), pelAnchor(where[1], pelSize[1]), pelSize, ink);
        }

        stamp(point, pel, ink) { this.stampCells(this.toCells(point), this.sizeToCells(pel), ink); }

        /** Bresenham line of pel-sized blocks between two points in cell units. */
        sweep(from, to, pelSize, ink) {
            let fromColumn = pelAnchor(from[0], pelSize[0]), fromRow = pelAnchor(from[1], pelSize[1]);
            let toColumn = pelAnchor(to[0], pelSize[0]), toRow = pelAnchor(to[1], pelSize[1]);
            // Walk from the upper end, so a half-pixel tie lights the upper cell whichever end the line started from
            if (fromRow < toRow) [fromColumn, fromRow, toColumn, toRow] = [toColumn, toRow, fromColumn, fromRow];
            const columnDistance = Math.abs(toColumn - fromColumn), rowDistance = Math.abs(toRow - fromRow);
            const columnStep = toColumn >= fromColumn ? 1 : -1, rowStep = toRow >= fromRow ? 1 : -1;
            let column = fromColumn, row = fromRow, error = columnDistance - rowDistance;
            for (; ;) {
                this.block(column, row, pelSize, ink);
                if (column === toColumn && row === toRow) return;
                const doubledError = 2 * error;
                if (doubledError > -rowDistance) { error -= rowDistance; column += columnStep; }
                if (doubledError < columnDistance) { error += columnDistance; row += rowStep; }
            }
        }

        stroke(points, pel, texture, ink, closed = false, gaps = null, vertices = true) {
            if (!points.length) return;
            if (points.length === 1) { this.stamp(points[0], pel, ink); return; }
            const pelSize = this.sizeToCells(pel), [onSegments, period] = LINE_TEXTURES[texture];
            let phase = 0.0;
            const segmentCount = closed ? points.length : points.length - 1;
            for (let i = 0; i < segmentCount; i++) {
                const from = this.toCells(points[i]), to = this.toCells(points[(i + 1) % points.length]);
                const run = to[0] - from[0], rise = to[1] - from[1], length = hypot(run, rise);
                let stepLength = 0.0;                                     // length of one pel step along the line
                if (length > 0) {
                    const unitX = run / length, unitY = rise / length;
                    stepLength = Infinity;
                    if (Math.abs(unitX) > 1e-9) stepLength = Math.min(stepLength, pelSize[0] / Math.abs(unitX));
                    if (Math.abs(unitY) > 1e-9) stepLength = Math.min(stepLength, pelSize[1] / Math.abs(unitY));
                    if (!Number.isFinite(stepLength)) stepLength = 0.0;
                }
                if (texture === 0 || !(stepLength > 0)) { this.sweep(from, to, pelSize, ink); continue; }
                // Colour mode 2 draws a texture's gaps in the background colour
                if (gaps !== null) this.sweep(from, to, pelSize, gaps);
                if (vertices) {
                    // A straight line's pattern is registered to the screen, as the TTX 650 lays it: each cell of the line
                    // is lit by the pattern at its column (its row on a steep line); both ends are always drawn
                    const x0 = Math.floor(from[0]), y0 = Math.floor(from[1]), x1 = Math.floor(to[0]), y1 = Math.floor(to[1]);
                    const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
                    const pelCells = steep ? pelSpan(pelSize[1]) : pelSpan(pelSize[0]);
                    for (const [x, y] of receiverLineCells(x0, y0, x1, y1)) {
                        if (linePatternLit(texture, pelCells, steep ? y : x)) this.stampCells([x, y], pelSize, ink);
                    }
                    this.stampCells(from, pelSize, ink);
                    this.stampCells(to, pelSize, ink);
                    continue;
                }
                const pointAtStep = (steps) => {
                    const fraction = Math.min(Math.max(steps * stepLength / length, 0.0), 1.0);
                    return [from[0] + run * fraction, from[1] + rise * fraction];
                };
                const entry = phase, exit = entry + length / stepLength;
                for (let periodIndex = Math.floor(entry / period); periodIndex <= Math.floor(exit / period); periodIndex++) {
                    for (const [segmentStart, segmentEnd] of onSegments) {
                        const dashStart = Math.max(periodIndex * period + segmentStart, entry);
                        const dashEnd = Math.min(periodIndex * period + segmentEnd, exit);
                        if (dashEnd >= dashStart) this.sweep(pointAtStep(dashStart - entry), pointAtStep(dashEnd - entry), pelSize, ink);
                    }
                }
                if (i === 0) this.stampCells(from, pelSize, ink);               // a flattened curve: only its ends
                if (i + 1 === segmentCount) this.stampCells(to, pelSize, ink);
                phase = exit;
            }
        }

        fill(points, pel, pattern, maskSize, mask, ink, gaps = null) {
            if (points.length < 2) { if (points.length) this.stamp(points[0], pel, ink); return; }
            const pelSize = this.sizeToCells(pel);
            const cellPoints = points.map((point) => this.toCells(point));
            const xs = cellPoints.map((point) => point[0]), ys = cellPoints.map((point) => point[1]);
            const left = Math.min(...xs) + Math.min(0.0, pelSize[0]) - 2, right = Math.max(...xs) + Math.max(0.0, pelSize[0]) + 2;
            const bottom = Math.min(...ys) + Math.min(0.0, pelSize[1]) - 2, top = Math.max(...ys) + Math.max(0.0, pelSize[1]) + 2;
            const screenWidth = this.surface.w, screenHeight = this.surface.h;
            const clampColumn = (value) => Math.min(Math.max(Math.floor(value), -screenWidth), 2 * screenWidth);
            const clampRow = (value) => Math.min(Math.max(Math.floor(value), -screenHeight), 2 * screenHeight);
            const firstColumn = clampColumn(left), firstRow = clampRow(bottom);
            const width = clampColumn(Math.ceil(right)) - firstColumn + 1, height = clampRow(Math.ceil(top)) - firstRow + 1;
            if (width <= 0 || height <= 0) return;
            const cellCount = width * height;

            // 1. trace the outline into a scratch grid
            const outline = new Uint8Array(cellCount);
            this.traced = { c0: firstColumn, r0: firstRow, w: width, h: height, cells: outline };
            this.stroke(points, pel, 0, ink, true);
            this.traced = null;

            // 2. the figure is the outline plus every cell whose lower-left corner lies inside the path by the
            // odd-even rule, as the TTX 650 fills; a one-cell gap inside the figure stays open (decode-orc PR #328)
            const inFigure = Uint8Array.from(outline), vertexCount = cellPoints.length;
            for (let row = firstRow; row < firstRow + height; row++) {
                const corner = row, crossings = [];
                for (let i = 0; i < vertexCount; i++) {
                    const a = cellPoints[i], b = cellPoints[(i + 1) % vertexCount];
                    if ((a[1] <= corner && b[1] > corner) || (b[1] <= corner && a[1] > corner))
                        crossings.push(a[0] + (corner - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                }
                crossings.sort((p, q) => p - q);
                const rowBase = (row - firstRow) * width - firstColumn;
                for (let i = 0; i + 1 < crossings.length; i += 2) {
                    const spanStart = Math.max(firstColumn, Math.ceil(crossings[i]));
                    const spanEnd = Math.min(firstColumn + width - 1, Math.floor(crossings[i + 1]));
                    for (let column = spanStart; column <= spanEnd; column++) inFigure[rowBase + column] = 1;
                }
            }

            // 3. paint the figure (subject to the fill pattern; in colour mode 2 its gaps take the background)
            for (let row = Math.max(firstRow, 0); row < Math.min(firstRow + height, screenHeight); row++) {
                const rowBase = (row - firstRow) * width;
                for (let column = Math.max(firstColumn, 0); column < Math.min(firstColumn + width, screenWidth); column++) {
                    if (!inFigure[rowBase + column - firstColumn]) continue;
                    if (pattern && !patternCovers(pattern, pel, maskSize, mask,
                        (column + 0.5) / this.columnsPerUnit, (row + 0.5) / this.rowsPerUnit)) {
                        if (gaps !== null) this.surface.cells[row * screenWidth + column] = gaps;
                        continue;
                    }
                    this.surface.cells[row * screenWidth + column] = ink;
                }
            }
        }

        /** Stroke a traced cell path (an arc), the texture counted along it; ends always drawn. */
        strokeCells(path, pel, texture, ink, gaps = null) {
            const pelSize = this.sizeToCells(pel), pelCells = pelSpan(pelSize[0]);
            path.forEach((cell, index) => {
                const lit = texture === 0 || index === 0 || index + 1 === path.length || linePatternLit(texture, pelCells, index);
                if (lit) this.stampCells(cell, pelSize, ink);
                else if (gaps !== null) this.stampCells(cell, pelSize, gaps);
            });
        }

        /** Fill a traced cell outline: each row from its leftmost to rightmost outline cell, widened by the pel. */
        fillCells(outline, pel, pattern, maskSize, mask, ink, gaps = null) {
            if (!outline.length) return;
            const pelSize = this.sizeToCells(pel), pelColumns = pelSpan(pelSize[0]), pelRows = pelSpan(pelSize[1]);
            const screenWidth = this.surface.w, screenHeight = this.surface.h;
            let lowest = Infinity, highest = -Infinity;
            for (const [, row] of outline) { lowest = Math.min(lowest, row); highest = Math.max(highest, row); }
            const firstRow = Math.max(lowest, -screenHeight), lastRow = Math.min(highest, 2 * screenHeight);
            if (firstRow > lastRow) return;
            const leftOf = new Array(lastRow - firstRow + 1).fill(Infinity), rightOf = new Array(lastRow - firstRow + 1).fill(-Infinity);
            for (const [column, row] of outline) {
                if (row < firstRow || row > lastRow) continue;
                leftOf[row - firstRow] = Math.min(leftOf[row - firstRow], column);
                rightOf[row - firstRow] = Math.max(rightOf[row - firstRow], column);
            }
            const pelDown = pelSize[1] < 0;
            const firstFilled = pelDown ? firstRow - (pelRows - 1) : firstRow, lastFilled = pelDown ? lastRow : lastRow + (pelRows - 1);
            for (let row = Math.max(firstFilled, 0); row <= Math.min(lastFilled, screenHeight - 1); row++) {
                let left = Infinity, right = -Infinity;
                for (let reach = 0; reach < pelRows; reach++) {
                    const from = pelDown ? row + reach : row - reach;
                    if (from < firstRow || from > lastRow || leftOf[from - firstRow] > rightOf[from - firstRow]) continue;
                    left = Math.min(left, leftOf[from - firstRow]);
                    right = Math.max(right, rightOf[from - firstRow]);
                }
                if (left > right) continue;
                if (pelSize[0] < 0) left -= pelColumns - 1; else right += pelColumns - 1;
                for (let column = Math.max(left, 0); column <= Math.min(right, screenWidth - 1); column++) {
                    if (pattern && !patternCovers(pattern, pel, maskSize, mask,
                        (column + 0.5) / this.columnsPerUnit, (row + 0.5) / this.rowsPerUnit)) {
                        if (gaps !== null) this.surface.put(column, row, gaps);
                        continue;
                    }
                    this.surface.put(column, row, ink);
                }
            }
        }

        fillRectCells(left, bottom, width, height, ink) {
            if (width <= 0 || height <= 0) return;
            const firstColumn = Math.floor(left), lastColumn = Math.max(firstColumn, Math.ceil(left + width) - 1);
            const firstRow = Math.floor(bottom), lastRow = Math.max(firstRow, Math.ceil(bottom + height) - 1);
            for (let row = firstRow; row <= lastRow; row++) {
                for (let column = firstColumn; column <= lastColumn; column++) this.surface.put(column, row, ink);
            }
        }

        /**
         * A character field on the surface, in the field's own frame (decode-orc PR #328): `across` runs along the
         * character's width and `up` along its height, onto whichever surface axes the rotation turns them. Its cells
         * are the ones its edges truncate to, so a line of fields tiles the row with no gaps or overlaps.
         */
        characterField(prim) {
            const [originColumn, originRow] = this.toCells(prim.origin);
            const width = Math.abs(prim.size[0]), height = Math.abs(prim.size[1]);
            const perColumn = this.columnsPerUnit, perRow = this.rowsPerUnit;
            let across, up, acrossIsColumns;
            switch (prim.rotation) {
                case 1: across = new FieldAxis(originRow, width * perRow, 1); up = new FieldAxis(originColumn, height * perColumn, -1); acrossIsColumns = false; break;
                case 2: across = new FieldAxis(originColumn, width * perColumn, -1); up = new FieldAxis(originRow, height * perRow, -1); acrossIsColumns = true; break;
                case 3: across = new FieldAxis(originRow, width * perRow, -1); up = new FieldAxis(originColumn, height * perColumn, 1); acrossIsColumns = false; break;
                default: across = new FieldAxis(originColumn, width * perColumn, 1); up = new FieldAxis(originRow, height * perRow, 1); acrossIsColumns = true;
            }
            const field = {
                across, up, acrossIsColumns,
                acrossCellsPerUnit: acrossIsColumns ? perColumn : perRow, upCellsPerUnit: acrossIsColumns ? perRow : perColumn,
                columns: across.cells(), rows: up.cells(),
                nominalColumns: Math.max(1, truncatedCell(across.extent)), nominalRows: Math.max(1, truncatedCell(up.extent)),
                surfaceCell(column, row) {
                    const along = across.surface(column), rising = up.surface(row);
                    return acrossIsColumns ? [along, rising] : [rising, along];
                }
            };
            field.empty = field.columns <= 0 || field.rows <= 0;
            return field;
        }

        /** The surface cells a field covers, as a rectangle. */
        fieldRect(field) {
            const [firstColumn, firstRow] = field.surfaceCell(0, 0), [lastColumn, lastRow] = field.surfaceCell(field.columns - 1, field.rows - 1);
            return {
                column: Math.min(firstColumn, lastColumn), row: Math.min(firstRow, lastRow),
                columns: Math.abs(lastColumn - firstColumn) + 1, rows: Math.abs(lastRow - firstRow) + 1
            };
        }

        cellsOf(rect) {
            const { w, h, cells } = this.surface, out = new Int32Array(rect.columns * rect.rows);
            for (let row = 0; row < rect.rows; row++) {
                for (let column = 0; column < rect.columns; column++) {
                    const x = rect.column + column, y = rect.row + row;
                    out[row * rect.columns + column] = (x >= 0 && x < w && y >= 0 && y < h) ? cells[y * w + x] : -2;
                }
            }
            return out;
        }

        stillHolds(rect, saved) {
            const now = this.cellsOf(rect);
            return now.length === saved.length && now.every((value, index) => value === saved[index]);
        }

        putBack(rect, saved) {
            for (let row = 0; row < rect.rows; row++) {
                for (let column = 0; column < rect.columns; column++) {
                    const value = saved[row * rect.columns + column];
                    if (value !== -2) this.surface.cells[(rect.row + row) * this.surface.w + rect.column + column] = value;
                }
            }
        }

        /** A mosaic's six elements dividing the field's own cells; separated mode (underline) shrinks each by the pel. */
        mosaicImage(prim, field) {
            const image = new FieldImage(field.columns, field.rows), code = prim.char;
            const sixBits = (code & 0x20 || code === 0x5F) ? ((code & 0x1F) | ((code >> 1) & 0x20)) : 0;
            const splitAcross = field.across.cellsWithin(field.across.extent / 2);
            const splitUp = [0, field.up.cellsWithin(field.up.extent / 3), field.up.cellsWithin(2 * field.up.extent / 3), field.rows];
            const shrinkAcross = prim.underlined ? pelSpan(prim.pel[0] * field.acrossCellsPerUnit) : 0;
            const shrinkUp = prim.underlined ? pelSpan(prim.pel[1] * field.upCellsPerUnit) : 0;
            for (let element = 0; element < 6; element++) {
                if (!(sixBits & (1 << element))) continue;
                const right = element % 2 !== 0, band = 2 - Math.floor(element / 2);
                const firstColumn = right ? splitAcross : 0, endColumn = right ? field.columns : splitAcross;
                const firstRow = splitUp[band], endRow = splitUp[band + 1];
                image.fill(firstColumn, Math.max(firstColumn, endColumn - shrinkAcross), firstRow, Math.max(firstRow, endRow - shrinkUp));
            }
            return image;
        }

        /** Too small to present: one reference pixel at the field's origin, as the TTX 650 draws it. */
        static characterTooSmall(prim, drcs) {
            const columns = referencePixels(prim.size[0]), rows = referencePixels(prim.size[1]);
            if (prim.rep === 'P' || prim.rep === 'S') {
                if (prim.char === 0x20 || (prim.rep === 'S' && isNonSpacingAccent(prim.char))) return false;
                return columns < SMALLEST_FIELD_COLUMNS || rows < SMALLEST_FIELD_ROWS;
            }
            if (prim.rep === 'D') {
                const glyph = drcs ? drcs.get(prim.char) : null;
                return !!glyph && (columns < glyph.w || rows < glyph.h);
            }
            return false;
        }

        /**
         * Deposit an image into its field in the character's attributes: a negative dx/dy reflects the pattern in place,
         * reverse video swaps shape and surround, and the underline (dy of the logical pel, at least a cell) runs along
         * the field's origin edge, turned with the character.
         */
        depositFieldImage(field, image, prim, underline, ink, background) {
            const mirrorAcross = prim.size[0] < 0, mirrorUp = prim.size[1] < 0;
            const underlineRows = underline ? pelSpan(prim.pel[1] * field.upCellsPerUnit) : 0;
            const landing = (axis, cells, limit) => {
                const base = axis.surface(0);
                return axis.direction > 0 ? [Math.max(0, -base), Math.min(cells - 1, limit - 1 - base)]
                    : [Math.max(0, base - (limit - 1)), Math.min(cells - 1, base)];
            };
            const acrossLimit = field.acrossIsColumns ? this.surface.w : this.surface.h;
            const upLimit = field.acrossIsColumns ? this.surface.h : this.surface.w;
            const [firstColumn, lastColumn] = landing(field.across, field.columns, acrossLimit);
            const [firstRow, lastRow] = landing(field.up, field.rows, upLimit);
            for (let row = firstRow; row <= lastRow; row++) {
                for (let column = firstColumn; column <= lastColumn; column++) {
                    const lit = row < underlineRows || image.at(mirrorAcross ? field.columns - 1 - column : column, mirrorUp ? field.rows - 1 - row : row);
                    const pen = prim.reverse ? (lit ? background : ink) : (lit ? ink : background);
                    if (pen === null || pen === undefined) continue;
                    const [surfaceColumn, surfaceRow] = field.surfaceCell(column, row);
                    this.surface.put(surfaceColumn, surfaceRow, pen);
                }
            }
        }

        /** A letter from the optional decoder font, at whole multiples, centred vertically as before. */
        decoderImage(field, codePoint) {
            const choice = chooseDecoderFace(this.decoderFont, codePoint, field.nominalColumns, field.nominalRows);
            if (!choice) return null;
            const { face, rows: glyph, scaleX, scaleY } = choice, image = new FieldImage(field.columns, field.rows);
            const top = Math.ceil((field.nominalRows - face.h * scaleY) / 2);
            for (let fromTop = 0; fromTop < field.nominalRows; fromTop++) {
                const faceRow = Math.floor((fromTop - top) / scaleY);
                if (faceRow < 0 || faceRow >= face.h) continue;
                for (let column = 0; column < field.nominalColumns; column++) {
                    const faceColumn = Math.floor(column / scaleX);
                    if (faceColumn < face.w && ((glyph[faceRow] >> (face.w - 1 - faceColumn)) & 1)) image.set(column, field.nominalRows - 1 - fromTop);
                }
            }
            return image;
        }

        isUnitSquare() { return Math.abs(this.rowsPerUnit - this.surface.h) < 1e-9; }

        /**
         * Draw a character into its field (decode-orc PR #328): the receivers' face for the field, laid at a whole
         * multiple and placed on the baseline; mosaics tiling the field; DRCS from the origin; Table 25's line graphics
         * from the field itself; and accents (sent before their letter, without advancing) composed onto the letter.
         */
        depositCharacter(prim, drcs, ink, background) {
            const field = this.characterField(prim), rect = field.empty ? null : this.fieldRect(field);
            const mark = prim.rep === 'S' && isNonSpacingAccent(prim.char);
            const takesMarks = (prim.rep === 'P' || prim.rep === 'S') && !mark;
            let marks = [], before = null, takenBack = false;
            if (this.pendingMarks) {
                const pending = this.pendingMarks;
                this.pendingMarks = null;
                if ((mark || takesMarks) && sameCharacterField(pending.marks[pending.marks.length - 1], prim) && this.stillHolds(pending.rect, pending.after)) {
                    marks = pending.marks;
                    // The field goes back to what it held before the marks, so the letter is drawn once, composed —
                    // but only within the instant the marks were drawn in
                    if (prim.t === pending.t) { this.putBack(pending.rect, pending.before); before = pending.before; takenBack = true; }
                }
            }
            if (field.empty) return;
            if (mark && !takenBack) before = this.cellsOf(rect);

            const face = chooseFace(!this.isUnitSquare() ? this.surface.w : 256, field.nominalColumns, field.nominalRows);
            const place = placePattern(face[1], face[2], face[4], field);
            const unicodeOf = (p) => (p.rep === 'P' ? ((p.char >= 0x20 && p.char < 0x7F) ? p.char : 0x20) : FONT.SUPPLEMENTARY.codePointAt(p.char - 0x20));
            const markCodes = (list) => list.map(unicodeOf);
            let image = new FieldImage(field.columns, field.rows), underline = !!prim.underlined;

            const layLetter = (withMarks) => {
                const graphic = prim.rep === 'S' ? FIELD_GRAPHICS[prim.char] : undefined;
                let base = unicodeOf(prim);
                if (!graphic && base === 0x20 && withMarks.length) { laySpacingMarks(image, face, place, withMarks); return; }
                const overlays = [];
                for (const each of withMarks) {
                    const composed = graphic ? 0 : (COMPOSED.get(base * 0x110000 + each) || 0);
                    if (composed) base = composed;
                    else { const forms = MARK_FORMS.get(each); overlays.push(forms ? forms.overlay : each); }
                }
                if (graphic) layFieldGraphic(image, graphic, field, place.scaleAcross, place.scaleUp);
                else if (this.decoderFont && !withMarks.length) {
                    const decoded = this.decoderImage(field, base);
                    if (decoded) image = decoded; else layOrBox(image, face, place, base);
                } else layOrBox(image, face, place, base);
                for (const overlay of overlays) layOrBox(image, face, place, overlay);
            };

            if (prim.rep === 'M') {
                image = this.mosaicImage(prim, field);
                underline = false;                                          // "Mosaic characters are not underlined"
            } else if (prim.rep === 'D') {
                const glyph = drcs ? drcs.get(prim.char) : null;
                // The whole buffer, one element per pixel of the field it was defined in; element row 0 is the bottom
                if (glyph) layPattern(image, placePattern(glyph.w, glyph.h, -1, field), glyph.w, glyph.h,
                    (column, fromTop) => glyph.el[(glyph.h - 1 - fromTop) * glyph.w + column]);
            } else if (mark) {
                marks = marks.concat([prim]);
                laySpacingMarks(image, face, place, markCodes(marks));
            } else if (marks.length && !takenBack) {
                layLetter([]);
                laySpacingMarks(image, face, place, markCodes(marks));
            } else layLetter(markCodes(marks));

            if (!mark && Rasteriser.characterTooSmall(prim, drcs)) {
                image = new FieldImage(field.columns, field.rows);
                const referencePixel = Math.max(1, Math.round(this.columnsPerUnit / 256));
                image.fill(0, referencePixel, 0, referencePixel);
            }
            this.depositFieldImage(field, image, prim, underline, ink, background);
            if (mark) this.pendingMarks = { marks, rect, before, after: this.cellsOf(rect), t: prim.t };
        }

        /** INCREMENTAL POINT: lay a run of pixel colors across the field, row by row from the top. */
        colorRun(origin, size, pel, inks) {
            if (!inks.length) return;
            const left = Math.min(origin[0], origin[0] + size[0]), bottom = Math.min(origin[1], origin[1] + size[1]);
            const fieldWidth = Math.abs(size[0]), top = bottom + Math.abs(size[1]);
            const pixelWidth = Math.abs(pel[0]) > 1e-9 ? Math.abs(pel[0]) : 1.0 / this.columnsPerUnit;
            const pixelHeight = Math.abs(pel[1]) > 1e-9 ? Math.abs(pel[1]) : 1.0 / this.rowsPerUnit;
            const columns = Math.max(1, Math.floor(fieldWidth / pixelWidth));
            for (let i = 0; i < inks.length; i++) {
                const column = i % columns, row = Math.floor(i / columns);
                const x = left + column * pixelWidth, y = top - (row + 1) * pixelHeight;
                if (y + pixelHeight <= bottom) break;
                this.stamp([x, y], [pixelWidth, pixelHeight], inks[i]);
            }
        }
    }

    // An ink describes where a cell's color comes from:
    //   ['c', color]                 a fixed color
    //   ['m', mapAddress]             a color-map entry (recolored when the map changes)
    //   ['d', color, drawAddress]    a direct color that can still blink via its drawing address
    const foregroundInk = (prim) => {
        const ink = prim.caddr >= 0 ? ['m', prim.caddr] : ['d', prim.color, prim.daddr];
        return prim.c1_blink ? ['k', ...ink.slice(0, 2), ...prim.c1_blink] : ink;
    };

    /** pen turns an ink into what goes in a cell (the Player stores ink ids); without it, a color. */
    const drawPrimitive = (rasteriser, prim, page, { definition = false, drcs, pen } = {}) => {
        pen = pen || ((ink) => {
            if (ink[0] === 'm') return page ? page.color_map[pythonMod(ink[1], 16)] : prim.color;
            return ink[1];
        });
        const ink = definition ? prim.color : pen(foregroundInk(prim));
        const background = (prim.mode === 2 && prim.baddr >= 0 && !definition) ? pen(['m', prim.baddr]) : null;
        const gaps = background;                     // colour mode 2: texture and pattern gaps take the background
        const kind = prim.kind;
        if (kind === 'point') {
            if (prim.points.length) rasteriser.stamp(prim.points[0], prim.pel, ink);
        } else if (kind === 'line') {
            rasteriser.stroke(prim.points, prim.pel, prim.line_tex, ink, false, gaps);
        } else if (kind === 'arc' || kind === 'rect' || kind === 'poly') {
            const mask = (prim.pattern >= 4 && page) ? page.masks[prim.pattern - 4] : null;
            const highlightInk = () => (background !== null ? background : pen(['c', BLACK]));
            if (kind === 'arc' && prim.points.length === 3) {
                // An arc through three points is traced cell by cell as the TTX 650 traced it (decode-orc PR #328)
                const traced = arcCells(prim.points.map((point) => rasteriser.toCells(point)));
                if (traced && traced.collinear) { rasteriser.stroke(prim.points, prim.pel, prim.line_tex, ink, false, gaps); return; }
                if (traced) {
                    if (!prim.filled) { rasteriser.strokeCells(traced.path, prim.pel, prim.line_tex, ink, gaps); return; }
                    const outline = traced.circle ? traced.path : traced.path.concat(receiverLineCells(
                        ...traced.path[traced.path.length - 1], ...traced.path[0]));
                    rasteriser.fillCells(outline, prim.pel, definition ? 0 : prim.pattern, prim.mask_size, mask, ink, gaps);
                    // The chord is not part of the arc and is not highlighted (§5.3.3.3)
                    if (prim.highlighted && !definition) rasteriser.strokeCells(traced.path, prim.pel, 0, highlightInk());
                    return;
                }
            }
            let outline;
            if (kind === 'arc') outline = arcToPolyline(prim.points, 0.2 / rasteriser.columnsPerUnit);
            else if (kind === 'rect') {
                const [originX, originY] = prim.origin, farX = originX + prim.size[0], farY = originY + prim.size[1];
                outline = [prim.origin, [farX, originY], [farX, farY], [originX, farY]];
            } else outline = prim.points;
            const closed = kind !== 'arc', vertices = kind !== 'arc';
            if (!prim.filled) { rasteriser.stroke(outline, prim.pel, prim.line_tex, ink, closed, gaps, vertices); return; }
            rasteriser.fill(outline, prim.pel, definition ? 0 : prim.pattern, prim.mask_size, mask, ink, gaps);
            if (prim.highlighted && !definition) rasteriser.stroke(outline, prim.pel, 0, highlightInk(), closed);
        } else if (kind === 'incr') {
            if (definition) { rasteriser.stroke(prim.points, prim.pel, prim.line_tex, ink, false); return; }
            const inks = (prim.incr || []).map((value) => {
                if (prim.mode === 0) {
                    const twoBitGun = (offset) => ((((value >> (3 + offset)) & 1) << 1) | ((value >> offset) & 1)) << 1;
                    return pen(['c', makeColor(twoBitGun(2), twoBitGun(1), twoBitGun(0), false)]);
                }
                return pen(['m', pythonMod(value, 16)]);
            });
            rasteriser.colorRun(prim.origin, prim.size, prim.pel, inks);
        } else if (kind === 'char') {
            rasteriser.depositCharacter(prim, drcs ?? (page ? page.drcs : new Map()), ink, background);
        }
    };

    const THREE_BIT_TO_EIGHT = Array.from({ length: 8 }, (_, level) => Math.floor(level * 255 / 7));
    const colorToRgb = (color) => {
        if (color === null || color === undefined || (color & 512)) return [0, 0, 0];
        return [THREE_BIT_TO_EIGHT[(color >> 3) & 7], THREE_BIT_TO_EIGHT[color & 7], THREE_BIT_TO_EIGHT[(color >> 6) & 7]];
    };

    // * * * Player * * *
    /*
    * Player — the page over time, as on the receiver screen.
    * Primitives appear at their time (drawing speed + WAIT pauses);
    * a clear erases; a color-map change recolors what is already drawn (§5.3.2.5); blink processes (§5.3.2.7, §6.2.8) alternate map entries.
    * Each screen cell holds an ink id; color is resolved per frame.
    */
    class Player {
        constructor(page, [gridWidth, gridHeight] = [256, 200], { font = null } = {}) {
            this.page = page;
            this.decoderFont = resolveDecoderFont(font);
            this.gw = gridWidth;
            this.gh = gridHeight;
            this.events = page.events?.length ? page.events : page.prims.map((prim) => ['p', 0.0, prim]);
            this.end = page.end || 0.0;
            this.hasBlink = this.events.some(([type, , blinks]) => type === 'blink' && blinks.some(Boolean));
            this.reset();
        }

        reset() {
            this.nextEvent = 0;
            this.sweep = null;             // a fill or clear being swept across the screen (receiver pace)
            this.map = [...DEFAULT_MAP];
            this.blink = new Array(16).fill(null);
            this.inks = [['c', BLACK]];
            this.inkIds = new Map([[`c:${BLACK}`, 0]]);
            this.generation = 0;           // bumps whenever cells/map/blink change
            this._newSurface();
        }

        _newSurface() {
            this.surf = new Surface(this.gw, this.gh);
            this.rasteriser = new Rasteriser(this.surf, this.gw, this.gh, false, this.decoderFont);
        }

        /** The id of an ink, registering it the first time it is seen. */
        pen(ink) {
            const key = ink.join(':');
            let id = this.inkIds.get(key);
            if (id === undefined) {
                id = this.inks.length;
                this.inkIds.set(key, id);
                this.inks.push(ink);
            }
            return id;
        }

        /** Run events up to `time` seconds (null/undefined = all). Returns true if anything changed. */
        advance(time) {
            const events = this.events, options = { pen: (ink) => this.pen(ink) }, all = time === null || time === undefined;
            let changed = false;
            if (this.sweep && (all || time >= this.sweep.end)) { this.sweep = null; changed = true; }
            const run = ([type, , payload]) => {
                if (type === 'p') drawPrimitive(this.rasteriser, payload, this.page, options);
                else if (type === 'clear') this._newSurface();
                else if (type === 'map') this.map = payload;
                else if (type === 'blink') this.blink = payload;
            };
            while (this.nextEvent < events.length) {
                const event = events[this.nextEvent], [type, at, payload] = event;
                if (all || at <= time) { this.nextEvent++; this.sweep = null; run(event); changed = true; continue; }
                // At a receiver's pace a fill or a clear is swept onto the screen a row at a time over the time it took
                // (decode-orc PR #328): it is drawn when it starts, and the rows not reached yet keep what was there
                const duration = type === 'clear' ? payload || 0 : type === 'p' ? payload.draw || 0 : 0;
                const rows = type === 'clear' ? [0, DISPLAY_HEIGHT] : type === 'p' && duration > 0 ? paceFillRows(payload) : null;
                if (!this.page.sweep || !rows || duration <= 0 || at - duration > time) break;
                this.nextEvent++;
                const before = new Int32Array(this.surf.cells);
                run(event);
                const scale = this.gh / DISPLAY_HEIGHT;
                this.sweep = {
                    start: at - duration, end: at, before, up: this.page.sweep === 'up',
                    low: Math.max(0, Math.floor(rows[0] * scale)), high: Math.min(this.gh, Math.ceil(rows[1] * scale))
                };
                changed = true;
                break;
            }
            if (this.sweep) { this.sweepTime = time; changed = true; }
            if (changed) this.generation++;
            return changed;
        }

        done() { return this.nextEvent >= this.events.length && !this.sweep; }

        pauses(minimumSeconds = 2) {
            const found = [];
            for (let i = 1; i < this.events.length; i++) {
                const start = this.events[i - 1][1], end = this.events[i][1];
                if (end - start >= minimumSeconds) found.push([start, end]);
            }
            return found;
        }

        /** Is anything still going to change (more events, or an active blink)? */
        animating() {
            return !this.done() || this.blink.some((process) => process && process[2] && process[3]) ||
                this.inks.some((ink) => ink[0] === 'k' && ink[5] && ink[6]);
        }

        colorOf(ink, time) {
            if (ink[0] === 'c') return ink[1];
            if (ink[0] === 'k') {
                const [, kind, value, toAddress, toColor, onTenths, offTenths, delayTenths, startTime] = ink;
                let color = kind === 'm' ? this.map[pythonMod(value, 16)] : value;
                if (onTenths && offTenths && time !== null && time !== undefined) {
                    const phase = time - startTime - 0.1 * delayTenths;
                    if (phase >= 0 && (phase % (0.1 * (onTenths + offTenths))) < 0.1 * onTenths) {
                        color = toAddress >= 0 ? this.map[pythonMod(toAddress, 16)] : toColor;
                    }
                }
                return color;
            }
            let address, color;
            if (ink[0] === 'm') { address = pythonMod(ink[1], 16); color = this.map[address]; }
            else { address = pythonMod(ink[2], 16); color = ink[1]; }
            const process = this.blink[address];
            if (process && time !== null && time !== undefined) {
                const [toAddress, toColor, onTenths, offTenths, delayTenths, startTime] = process;
                if (onTenths && offTenths) {
                    const phase = time - startTime - 0.1 * delayTenths;
                    if (phase >= 0 && (phase % (0.1 * (onTenths + offTenths))) < 0.1 * onTenths) {
                        color = toAddress >= 0 ? this.map[pythonMod(toAddress, 16)] : toColor;
                    }
                }
            }
            return color;
        }

        /** RGB for every ink at `time` (null = blinking colors in their "on" phase). */
        palette(time) { return this.inks.map((ink) => colorToRgb(this.colorOf(ink, time))); }

        /** Write the frame at `time` into an RGBA buffer (Uint8ClampedArray, w*h*4), top row first. */
        paintRGBA(rgba, time) {
            const palette = this.palette(time), { gw: width, gh: height } = this, sweep = this.sweep;
            // Rows a sweep has not reached yet still show what was there before it
            let swept = null;
            if (sweep) {
                const fraction = Math.min(1, Math.max(0, (this.sweepTime - sweep.start) / (sweep.end - sweep.start)));
                const reach = sweep.low + fraction * (sweep.high - sweep.low);
                swept = (row) => row < sweep.low || row >= sweep.high || (sweep.up ? row < reach : row >= sweep.high - (reach - sweep.low));
            }
            for (let row = 0; row < height; row++) {
                const cells = swept && !swept(row) ? sweep.before : this.surf.cells;
                const source = row * width, target = (height - 1 - row) * width * 4;   // raster row 0 is the bottom
                for (let column = 0; column < width; column++) {
                    const inkId = cells[source + column], [red, green, blue] = palette[inkId < 0 ? 0 : inkId];
                    const offset = target + column * 4;
                    rgba[offset] = red; rgba[offset + 1] = green; rgba[offset + 2] = blue; rgba[offset + 3] = 255;
                }
            }
            return rgba;
        }
    }

    // * * * SVG export (after decode-orc PR #328's catalogue_svg_document) * * *
    /*
    * A page as an SVG document drawn from the receiver's cells: each run of cells one ink covers is a rectangle, so
    * the document is the screen the Player paints, as vectors. Animated, it plays the presentation with SMIL (SVG 1.1
    * §19), which a web browser runs with no script:
    *   - what each moment of the page's drawing adds (the cells it changed) is a group kept hidden until then;
    *   - a fill or clear a receiver swept onto the screen is revealed through a clip that grows over the sweep;
    *   - an ink whose color changes (a color-map change, a blink process) paints from a one-stop gradient whose stop
    *     color follows the ink's track, and the blinking repeats forever once the page is drawn.
    * Still, it is the finished page with blinking colors in their "on" phase, as the PNGs show it.
    */
    const SVG_WIDTH = 1536, SVG_HEIGHT = 1152, MAX_TRACK_STEPS = 4000;
    const hexColor = (color) => `#${colorToRgb(color).map((level) => level.toString(16).padStart(2, '0')).join('')}`;
    const svgTime = (seconds) => `${Math.max(0, Math.round(seconds * 1000)) / 1000}s`;

    /** The rectangles (x, y, width, height, ink id) covering the cells `wanted` picks out, y counted down from the top. */
    const cellRectangles = (cells, width, height, wanted) => {
        const rectangles = [], open = new Map();          // run key "x,w,ink" → rectangle still growing downward
        for (let y = 0; y < height; y++) {
            const row = height - 1 - y, runs = new Map();
            for (let x = 0; x < width;) {
                const at = row * width + x;
                if (!wanted(at)) { x++; continue; }
                const ink = Math.max(0, cells[at]);
                let end = x + 1;
                while (end < width && wanted(row * width + end) && Math.max(0, cells[row * width + end]) === ink) end++;
                const key = `${x},${end - x},${ink}`, growing = open.get(key);
                if (growing && growing[1] + growing[3] === y) { growing[3]++; runs.set(key, growing); }
                else { const rectangle = [x, y, end - x, 1, ink]; rectangles.push(rectangle); runs.set(key, rectangle); }
                x = end;
            }
            open.clear();
            for (const [key, rectangle] of runs) open.set(key, rectangle);
        }
        return rectangles;
    };

    /**
     * An ink's color over time: [[time, color], …] up to `loopStart`, then (if it blinks for good) one period of
     * `loop` repeated forever from `loopStart`.
     */
    const inkTrack = (player, ink, states) => {
        const steps = [];
        const add = (time, color) => { if (!steps.length || steps[steps.length - 1][1] !== color) steps.push([time, color]); };
        const processOf = () => {
            if (ink[0] === 'k') return ink[5] && ink[6] ? [ink[5], ink[6], ink[7], ink[8]] : null;
            const address = pythonMod(ink[0] === 'm' ? ink[1] : ink[2], 16), process = player.blink[address];
            return process && process[2] && process[3] ? [process[2], process[3], process[4], process[5]] : null;
        };
        const colorAt = (time) => player.colorOf(ink, time);
        let loop = null;
        states.forEach(([from, map, blink], index) => {
            const to = index + 1 < states.length ? states[index + 1][0] : Infinity;
            player.map = map; player.blink = blink;
            add(from, colorAt(from));
            const process = processOf();
            if (!process) return;
            const [on, off, delay, start] = process, period = 0.1 * (on + off), first = start + 0.1 * delay;
            // The toggles inside this stretch: on at first + k·period, off a tenth·on later
            let k = Math.max(0, Math.floor((from - first) / period));
            for (; steps.length < MAX_TRACK_STEPS; k++) {
                const onAt = first + k * period, offAt = onAt + 0.1 * on;
                if (to === Infinity && onAt >= from) {
                    loop = { start: onAt, period, on: colorAt(onAt + 1e-6), off: colorAt(offAt + 1e-6), onShare: on / (on + off) };
                    return;
                }
                if (onAt >= to) return;
                if (onAt >= from) add(onAt, colorAt(onAt + 1e-6));
                if (offAt >= from && offAt < to) add(offAt, colorAt(offAt + 1e-6));
            }
        });
        if (loop && loop.on === loop.off) loop = null;
        return { steps, loop };
    };

    const pageSVG = (page, [gridWidth, gridHeight] = [256, 200], { font = null, animated = true, title = '' } = {}) => {
        const player = new Player(page, [gridWidth, gridHeight], { font });
        const escapeText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" ` +
            `viewBox="0 0 ${gridWidth} ${gridHeight}" preserveAspectRatio="none" shape-rendering="crispEdges">` +
            (title ? `<title>${escapeText(title)}</title>` : '');
        const drawRectangles = (rectangles, fillOf) => rectangles.map(([x, y, width, height, ink]) =>
            `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fillOf(ink)}"/>`).join('');
        if (!animated) {
            player.advance(null);
            const palette = player.inks.map((ink) => hexColor(player.colorOf(ink, null)));
            const cells = player.surf.cells;
            return `${head}${drawRectangles(cellRectangles(cells, gridWidth, gridHeight, () => true), (ink) => palette[ink])}</svg>`;
        }

        // Play the page event by event, the way Player.advance does, noting what each moment changed
        const layers = [], states = [[0, [...player.map], [...player.blink]]];
        const options = { pen: (ink) => player.pen(ink) };
        const events = player.events;
        let previous = new Int32Array(player.surf.cells), current = null;
        const scale = gridHeight / DISPLAY_HEIGHT;
        const flush = () => {
            if (!current) return;
            const cells = player.surf.cells, changed = (at) => cells[at] !== previous[at];
            const rectangles = cellRectangles(cells, gridWidth, gridHeight, changed);
            if (rectangles.length) layers.push({ ...current, rectangles });
            previous = new Int32Array(cells);
            current = null;
        };
        for (const [type, at, payload] of events) {
            if (type === 'map' || type === 'blink') {
                if (type === 'map') player.map = payload; else player.blink = payload;
                const state = [at, [...player.map], [...player.blink]];
                if (states[states.length - 1][0] === at) states[states.length - 1] = state; else states.push(state);
                continue;
            }
            const duration = type === 'clear' ? payload || 0 : type === 'p' ? payload.draw || 0 : 0;
            const rows = type === 'clear' ? [0, DISPLAY_HEIGHT] : type === 'p' && duration > 0 ? paceFillRows(payload) : null;
            const swept = page.sweep && rows && duration > 0;
            const begin = swept ? at - duration : at;
            if (swept || !current || current.sweep || current.begin !== begin) flush();
            if (type === 'p') drawPrimitive(player.rasteriser, payload, page, options);
            else if (type === 'clear') player._newSurface();
            if (!current) current = { begin };
            if (swept) {
                current.sweep = {
                    end: at, up: page.sweep === 'up',
                    low: Math.max(0, Math.floor(rows[0] * scale)), high: Math.min(gridHeight, Math.ceil(rows[1] * scale))
                };
                flush();
            }
        }
        flush();
        // A sweep is cut short by whatever is drawn next, as the Player cuts it
        layers.forEach((layer, index) => {
            if (layer.sweep && index + 1 < layers.length) layer.sweep.cut = layers[index + 1].begin;
        });

        // Inks: a fixed color, or a gradient whose stop follows the ink's track
        const definitions = [], fills = player.inks.map((ink, id) => {
            const { steps, loop } = inkTrack(player, ink, states);
            if (steps.length === 1 && !loop) return hexColor(steps[0][1]);
            const name = `ink${id}`;
            let animations = '';
            const introEnd = loop ? loop.start : steps[steps.length - 1][0];
            if (steps.length > 1 && introEnd > 0) {
                const keyTimes = steps.map(([time]) => Math.min(1, time / introEnd).toFixed(5)).join(';');
                animations += `<animate attributeName="stop-color" calcMode="discrete" dur="${svgTime(introEnd)}" fill="freeze" ` +
                    `values="${steps.map(([, color]) => hexColor(color)).join(';')}" keyTimes="${keyTimes}"/>`;
            }
            if (loop) {
                animations += `<animate attributeName="stop-color" calcMode="discrete" begin="${svgTime(loop.start)}" ` +
                    `dur="${svgTime(loop.period)}" repeatCount="indefinite" values="${hexColor(loop.on)};${hexColor(loop.off)}" ` +
                    `keyTimes="0;${loop.onShare.toFixed(5)}"/>`;
            }
            definitions.push(`<linearGradient id="${name}"><stop offset="0" stop-color="${hexColor(steps[0][1])}">${animations}</stop></linearGradient>`);
            return `url(#${name})`;
        });

        const body = layers.map((layer, index) => {
            let opening = '<g', inner = '', clip = '';
            if (layer.begin > 0) {
                opening += ' visibility="hidden"';
                inner += `<set attributeName="visibility" to="visible" begin="${svgTime(layer.begin)}" fill="freeze"/>`;
            }
            if (layer.sweep) {
                // The band the sweep crosses grows from its starting edge; the rows outside it show at once
                const { low, high, up, end, cut } = layer.sweep, top = gridHeight - high, bottom = gridHeight - low;
                const stop = cut !== undefined && cut < end ? cut : end, span = high - low, length = end - layer.begin;
                // Row by row as the Player shows it: sweeping up, k rows are in once the sweep is past (k − 1) / span of
                // its time; sweeping down, once it is past k / span
                const fraction = Math.min(1, (stop - layer.begin) / Math.max(1e-6, length)), lag = up ? 1 : 0;
                const heights = [], keyTimes = [];
                for (let k = up ? 1 : 0; k <= span && (k - lag) / span <= fraction; k++) {
                    heights.push(k);
                    keyTimes.push(Math.min(1, ((k - lag) / span) / Math.max(1e-6, fraction)).toFixed(5));
                }
                if (!heights.length) { heights.push(0); keyTimes.push('0'); }
                const step = (attribute, values) => `<animate attributeName="${attribute}" calcMode="discrete" ` +
                    `values="${values.join(';')}" keyTimes="${keyTimes.join(';')}" begin="${svgTime(layer.begin)}" ` +
                    `dur="${svgTime(Math.max(0.001, stop - layer.begin))}" fill="freeze"/>`;
                const finish = (attribute, to) => (stop < end ? `<set attributeName="${attribute}" to="${to}" begin="${svgTime(stop)}" fill="freeze"/>` : '');
                const band = up
                    ? `<rect x="0" y="${bottom}" width="${gridWidth}" height="0">${step('y', heights.map((k) => bottom - k))}` +
                    `${step('height', heights)}${finish('y', top)}${finish('height', span)}</rect>`
                    : `<rect x="0" y="${top}" width="${gridWidth}" height="0">${step('height', heights)}${finish('height', span)}</rect>`;
                clip = `<clipPath id="sweep${index}"><rect x="0" y="0" width="${gridWidth}" height="${top}"/>` +
                    `<rect x="0" y="${bottom}" width="${gridWidth}" height="${gridHeight - bottom}"/>${band}</clipPath>`;
                opening += ` clip-path="url(#sweep${index})"`;
            }
            return `${clip}${opening}>${inner}${drawRectangles(layer.rectangles, (ink) => fills[ink])}</g>`;
        }).join('');
        // The screen starts black
        return `${head}<defs>${definitions.join('')}</defs><rect width="${gridWidth}" height="${gridHeight}" fill="#000000"/>${body}</svg>`;
    };

    // * * * Page text, as it remains on screen (for search and screen readers) * * *
    // * A later character replaces an earlier one in the same place, a filled rectangle wipes text under it, and drop shadows (the same text a pixel away) are not repeated.
    const pageText = (page) => {
        const placed = new Map();          // position key → [y, x, height, width, text, order]
        let order = 0, pendingAccents = '';
        for (const prim of page.prims) {
            if (prim.kind === 'rect' && prim.filled) {
                const [x0, y0] = prim.origin, x1 = x0 + prim.size[0], y1 = y0 + prim.size[1];
                const minX = Math.min(x0, x1), maxX = Math.max(x0, x1), minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
                for (const [key, [y, x, height, width]] of [...placed]) {
                    const centreX = x + width / 2, centreY = y + height / 2;
                    if (minX <= centreX && centreX <= maxX && minY <= centreY && centreY <= maxY) placed.delete(key);
                }
                continue;
            }
            if (prim.kind !== 'char' || prim.rep === 'M' || prim.rep === 'D') continue;
            if (prim.rep === 'S' && isNonSpacingAccent(prim.char)) {
                pendingAccents += FONT.SUPPLEMENTARY[prim.char - 0x20];
                continue;
            }
            const character = (prim.rep === 'P' && prim.char >= 0x20 && prim.char < 0x7F) ? String.fromCharCode(prim.char)
                : (prim.rep === 'S' ? FONT.SUPPLEMENTARY[prim.char - 0x20] : ' ');
            const [x, y] = prim.origin, width = Math.abs(prim.size[0]), height = Math.abs(prim.size[1]);
            const text = character + pendingAccents;
            pendingAccents = '';
            if (text.trim()) {
                const isShadow = [...placed.values()].slice(-120).some(([placedY, placedX, , , placedText]) =>
                    placedText === text && Math.abs(placedX - x) < width * 0.34 && Math.abs(placedY - y) < height * 0.34);
                if (isShadow) continue;
            }
            const key = `${roundHalfEven(x * 1024)},${roundHalfEven(y * 1024)}`;   // same position, to sub-pixel accuracy
            placed.delete(key);
            order++;
            placed.set(key, [y, x, height, width, text, order]);
        }
        const roundTo6 = (value) => Math.round(value * 1e6) / 1e6;
        const inReadingOrder = [...placed.values()].sort((a, b) => (roundTo6(b[0]) - roundTo6(a[0])) || (a[1] - b[1]));
        if (!inReadingOrder.length) return '';
        const output = [];
        let [lineY, , lineHeight] = inReadingOrder[0];
        inReadingOrder.forEach(([y, , height, , text], i) => {
            if (i && Math.abs(y - lineY) > Math.max(Math.max(lineHeight, height) / 2.0, 1e-6)) {
                output.push('\n');
                lineY = y;
                lineHeight = height;
            }
            output.push(text);
        });
        return output.join('').split('\n').map((line) => line.replace(/\s+$/, '')).join('\n');
    };

    // * * * Whole stream * * *
    const isPresentation = (recordType) => recordType === 0 || recordType === 1 || recordType === 3;

    /** A .t33 file → the record catalog and a summary. */
    const CONTINUITY_LOOKAHEAD = 8;
    /** The next data packet on `channel` among the packets after this one, or null. */
    const nextOnChannel = (queue, channel) => {
        for (const packet of queue) if (packet.valid && packet.channel === channel) return packet.sync ? null : packet;
        return null;
    };
    const correctContinuity = (packet, queue, assembler) => {
        if (!packet.valid || packet.sync) return;
        const open = assembler.openGroups.get(packet.channel);
        if (open) {
            const expected = (open.lastIndex + 1) % 16;
            if (packet.ci === expected) return;
            const next = nextOnChannel(queue, packet.channel), after = next && nextOnChannel(queue.slice(queue.indexOf(next) + 1), packet.channel);
            // ... when its channel number was read cleanly (a packet out of step with a damaged channel number is as
            // likely another channel's, misaddressed here), its index byte is at most three bits from the expected
            // one's (a two-bit misread; further off, it's another group's packet) and the two packets after it follow on
            if (packet.attested && next && next.ci === (expected + 1) % 16 && after && after.ci === (expected + 2) % 16 &&
                countSetBits(packet.ci_byte ^ HAMMING_CODEWORDS[expected]) <= 3) {
                packet.ci = expected;
                packet.ci_byte = HAMMING_CODEWORDS[expected];
                assembler.stats.ci_misreads = (assembler.stats.ci_misreads || 0) + 1;
            }
            return;
        }
        // A packet on a channel with no group open, its channel number not read cleanly, that takes up exactly where
        // a group open on another channel left off (and that channel's next packet follows it) is that group's
        if (packet.attested) return;
        for (const [channel, group] of assembler.openGroups) {
            // Its channel number read two bits or less from that channel's
            const distance = [0, 1, 2].reduce((sum, k) => sum + countSetBits(packet.prefix[k] ^ HAMMING_CODEWORDS[(channel >> (8 - 4 * k)) & 0xF]), 0);
            if (distance > 2) continue;
            const expected = (group.lastIndex + 1) % 16;
            if (packet.ci !== expected) continue;
            const next = nextOnChannel(queue, channel);
            if (!next || next.ci !== (expected + 1) % 16) continue;
            packet.channel = channel;
            assembler.stats.channel_misreads = (assembler.stats.channel_misreads || 0) + 1;
            return;
        }
    };

    const catalogStream = (bytes, packetCount, lowNibbleFirst, catalog, onProgress, salvage = null) => {
        const messages = [];
        const recordAssembler = new RecordAssembler((message) => messages.push(message));
        const groupAssembler = new GroupAssembler((group) => recordAssembler.add(group), false, lowNibbleFirst);
        if (salvage) groupAssembler.onLoose = (run) => salvage.add(run);
        // JS-only: a .t33 is read whole, so each packet is judged with the next few in view. A continuity index or
        // channel number misread past what its Hamming code corrects (WSBT 1984: a quarter of a group's packets) made
        // the group take the packet for a jump of many lost packets, close early, and leave the rest of its packets
        // with no group (seven in ten of that recording's packets). Where the packet's channel's next packet carries
        // the index after the one expected, the packet is the one expected
        const queue = [];
        const decodeAt = (index) => decodePacket(bytes.subarray(index * PACKET_SIZE, (index + 1) * PACKET_SIZE));
        for (let i = 0; i < Math.min(packetCount, CONTINUITY_LOOKAHEAD); i++) queue.push(decodeAt(i));
        for (let i = 0; i < packetCount; i++) {
            const packet = queue.shift();
            if (i + CONTINUITY_LOOKAHEAD < packetCount) queue.push(decodeAt(i + CONTINUITY_LOOKAHEAD));
            correctContinuity(packet, queue, groupAssembler);
            groupAssembler.add(packet);
            if (messages.length) {
                for (const message of messages) catalog.merge(message);
                messages.length = 0;
            }
            if (onProgress && i % 20000 === 0) onProgress(i, packetCount);
        }
        groupAssembler.flush();
        recordAssembler.flush();
        for (const message of messages) catalog.merge(message);
        return { groupAssembler, recordAssembler };
    };

    const readT33 = (input, onProgress) => {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const packetCount = Math.floor(bytes.length / PACKET_SIZE);
        const lowNibbleFirst = detectHeaderNibbleOrder(bytes, packetCount);
        const catalog = new Catalog();
        const salvage = new Salvage();
        const { groupAssembler, recordAssembler } = catalogStream(bytes, packetCount, lowNibbleFirst, catalog, onProgress, salvage);
        const reconciled = catalog.reconcile();
        // decode-orc PR #328: a stream where under a tenth of the packets arrived with a whole prefix is another
        // signal read as NABTS (every NABTS recording measured has at least 72 %), and nothing is listed
        const stats = groupAssembler.stats, notNabts = stats.packets >= 200 && stats.prefix_whole * 10 < stats.packets;
        const records = notNabts ? [] : catalog.records();
        const salvaged = notNabts ? null : salvage.apply(records);
        return {
            records,
            summary: {
                packets: packetCount, header_nibble_order: lowNibbleFirst ? 'low first' : 'high first',
                groups: groupAssembler.stats, records: recordAssembler.stats,
                foreign: recordAssembler.foreign, identities_folded: reconciled.folded, identities_dropped: reconciled.dropped,
                identities_kept: reconciled.kept, identities_misaddressed: reconciled.misaddressed,
                pages_with_contents: [...catalog.identities.values()].filter((contents) => contents.length > 1).length, cataloged: records.length, not_nabts: notNabts, salvage: salvaged
            }
        };
    };

    /** Interpret every presentation record into a page (like nabts_interpret_records). */
    // ---------------------------------------------------------------------------
    // Reconstruction of lost bytes from a record library (decode-orc PR #328, nabts_record_library.cpp and
    // naplps_reconstruct.cpp). A service writes its pages from templates, so a stretch a recording lost very often
    // stands, complete, in another record: where the bytes either side of the hole occur in such a record exactly
    // the hole's length apart, what lies between them there is what the hole lost.
    // ---------------------------------------------------------------------------
    const LIBRARY_ANCHOR_BYTES = 12, LIBRARY_MAX_CONTEXT = 64, LIBRARY_TRUSTED_CONTEXT = 56, LIBRARY_MIN_DISTINCT = 4;
    const LIBRARY_PREFERENCE_MARGIN = 16, LIBRARY_DOMINANT_RATIO = 10, LIBRARY_DOMINANT_MIN_RECORDS = 2;
    const LIBRARY_DOMINANT_CONTEXT = 32, LIBRARY_SAMPLE_STRIDE = 4;
    const SHIFT_MARGIN = 1.1, SHIFT_EVIDENCE_BYTES = 6, DIALECT_WINDOW_BYTES = 32;

    const libraryPresent = (present, index) => !present || !present.length || (index < present.length && present[index] !== 0);
    /** A byte that can stand in a context or a fill: delivered, and not the 0x00 a lost packet's filler reads as. */
    const libraryUsable = (data, present, index) => index < data.length && data[index] !== 0 && libraryPresent(present, index);

    /** A 12-byte anchor's hash as one number (two 26-bit lanes); one in four is sampled, chosen by the hash itself. */
    const anchorHash = (data, at) => {
        let a = 0x811C9DC5, b = 0x01000193;
        for (let i = 0; i < LIBRARY_ANCHOR_BYTES; i++) {
            const byte = data[at + i] + 1;
            a = Math.imul(a ^ byte, 0x01000193);
            b = Math.imul(b + byte, 0x5BD1E995) ^ (b >>> 15);
        }
        a ^= a >>> 13; a = Math.imul(a, 0x85EBCA6B); a ^= a >>> 16;
        b ^= b >>> 13; b = Math.imul(b, 0xC2B2AE35); b ^= b >>> 16;
        return (a >>> 6) * 67108864 + (b >>> 6);
    };
    const anchorSampled = (hash) => hash % LIBRARY_SAMPLE_STRIDE === 0;

    class RecordLibrary {
        constructor() { this.records = []; this.anchors = new Map(); }

        add(record) { this.records.push(record); return this.records.length - 1; }

        build() {
            this.anchors.clear();
            this.records.forEach(({ data, present }, r) => {
                if (data.length < LIBRARY_ANCHOR_BYTES) return;
                let unusable = 0;
                for (let i = 0; i < data.length; i++) {
                    if (!libraryUsable(data, present, i)) unusable++;
                    if (i >= LIBRARY_ANCHOR_BYTES && !libraryUsable(data, present, i - LIBRARY_ANCHOR_BYTES)) unusable--;
                    if (i + 1 < LIBRARY_ANCHOR_BYTES || unusable !== 0) continue;
                    const start = i + 1 - LIBRARY_ANCHOR_BYTES, hash = anchorHash(data, start);
                    if (!anchorSampled(hash)) continue;
                    let list = this.anchors.get(hash);
                    if (!list) this.anchors.set(hash, list = []);
                    list.push(r, start);
                }
            });
        }

        /** What the library offers for data[start, end): { bytes, record } or null. `wrong` marks bytes known wrong. */
        search(data, present, wrong, start, end, exclude) {
            if (start >= end || end > data.length) return null;
            const length = end - start;
            const isWrong = (index) => !!wrong && index < wrong.length && wrong[index] !== 0;
            let leftReach = 0, leftUsable = 0;
            while (leftUsable < LIBRARY_MAX_CONTEXT && leftReach < start && leftReach < 2 * LIBRARY_MAX_CONTEXT) {
                const at = start - 1 - leftReach;
                if (!isWrong(at)) { if (!libraryUsable(data, present, at)) break; leftUsable++; }
                leftReach++;
            }
            let rightReach = 0, rightUsable = 0;
            while (rightUsable < LIBRARY_MAX_CONTEXT && end + rightReach < data.length && rightReach < 2 * LIBRARY_MAX_CONTEXT) {
                const at = end + rightReach;
                if (!isWrong(at)) { if (!libraryUsable(data, present, at)) break; rightUsable++; }
                rightReach++;
            }
            if (leftUsable < LIBRARY_ANCHOR_BYTES || rightUsable < LIBRARY_ANCHOR_BYTES) return null;

            // Alignments any sampled anchor in either context proposes: the record, and where the hole would start
            const alignments = new Set();
            const propose = (from, to) => {
                for (let q = from; q + LIBRARY_ANCHOR_BYTES <= to; q++) {
                    const hash = anchorHash(data, q);
                    if (!anchorSampled(hash)) continue;
                    const list = this.anchors.get(hash);
                    if (!list) continue;
                    for (let k = 0; k < list.length; k += 2) {
                        if (list[k] === exclude) continue;
                        const refStart = list[k + 1] + start - q;
                        if (refStart >= 0) alignments.add(list[k] * 1048576 + refStart);
                    }
                }
            };
            propose(start - leftReach, start);
            propose(end, end + rightReach);

            const byFill = new Map();
            for (const alignment of alignments) {
                const recordIndex = Math.floor(alignment / 1048576), refStart = alignment - recordIndex * 1048576;
                const record = this.records[recordIndex], refEnd = refStart + length;
                if (refEnd > record.data.length) continue;
                let whole = true;
                for (let i = refStart; i < refEnd && whole; i++) whole = libraryUsable(record.data, record.present, i);
                if (!whole) continue;
                let left = 0, right = 0, leftSpan = 0, rightSpan = 0;
                while (leftSpan < leftReach && leftSpan < refStart) {
                    const at = start - 1 - leftSpan, there = refStart - 1 - leftSpan;
                    if (!isWrong(at)) {
                        if (!libraryUsable(record.data, record.present, there) || record.data[there] !== data[at]) break;
                        left++;
                    }
                    leftSpan++;
                }
                while (rightSpan < rightReach && refEnd + rightSpan < record.data.length) {
                    const at = end + rightSpan, there = refEnd + rightSpan;
                    if (!isWrong(at)) {
                        if (!libraryUsable(record.data, record.present, there) || record.data[there] !== data[at]) break;
                        right++;
                    }
                    rightSpan++;
                }
                if (left < LIBRARY_ANCHOR_BYTES || right < LIBRARY_ANCHOR_BYTES) continue;
                // A side that is padding, or one operand repeated, matches anywhere
                const distinctIn = (from, to) => {
                    const seen = new Set();
                    for (let i = from; i < to; i++) if (!isWrong(i)) seen.add(data[i]);
                    return seen.size;
                };
                if (distinctIn(start - leftSpan, start) < LIBRARY_MIN_DISTINCT || distinctIn(end, end + rightSpan) < LIBRARY_MIN_DISTINCT) continue;
                const bytes = record.data.slice(refStart, refEnd), key = bytes.join(',');
                if (!byFill.has(key)) byFill.set(key, { bytes, candidates: [] });
                byFill.get(key).candidates.push({ record: recordIndex, total: left + right });
            }
            if (!byFill.size) return null;

            let best = null, runnerUp = 0;
            const offers = [];
            for (const [key, { bytes, candidates }] of [...byFill].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
                const strongest = candidates.reduce((x, y) => (y.total > x.total ? y : x));
                const records = new Set(candidates.map((c) => c.record)).size;
                offers.push({ bytes, strongest, records });
                if (!best || strongest.total > best.strongest.total) {
                    if (best) runnerUp = Math.max(runnerUp, best.strongest.total);
                    best = { bytes, strongest, records };
                } else runnerUp = Math.max(runnerUp, strongest.total);
            }
            if (best.strongest.total < LIBRARY_TRUSTED_CONTEXT) return null;
            if (byFill.size > 1 && best.strongest.total < runnerUp + LIBRARY_PREFERENCE_MARGIN) {
                // One fill offered by far more records than any other is still the one sent
                const top = offers.reduce((x, y) => (y.records > x.records ? y : x));
                const next = Math.max(0, ...offers.filter((o) => o !== top).map((o) => o.records));
                const dominant = top.records >= LIBRARY_DOMINANT_MIN_RECORDS && top.records >= LIBRARY_DOMINANT_RATIO * next &&
                    top.strongest.total >= LIBRARY_DOMINANT_CONTEXT;
                if (!dominant) return null;
                best = top;
            }
            return { bytes: best.bytes, record: best.strongest.record };
        }
    }

    /** How the record was being read just before `offset`: 'text', 'pdi' or null. */
    const readStateBefore = (data, roles, offset) => {
        for (let i = Math.min(offset, roles.length); i-- > 0;) {
            const role = roles[i];
            if (role === ROLE_UNREAD || role === ROLE_TRANSPARENT) continue;
            if (role === ROLE_TEXT) return 'text';
            if (role === ROLE_PDI) return 'pdi';
            if (role === ROLE_CONTROL) {
                const byte = data[i] & 0x7F;
                return byte === 0x0E ? 'pdi' : byte === 0x0F ? 'text' : null;
            }
            return null;
        }
        return null;
    };
    const withOddParity = (byte) => (ODD_PARITY[byte & 0x7F] ? byte & 0x7F : (byte & 0x7F) | 0x80);
    const FLIP_MARGIN = 1.0;          // natural-log units per letter pair: the preferred reading is e times likelier

    /**
     * Rebuild what a recording lost of one record (naplps_reconstruct_record): bytes received failing parity are
     * replaced where the library vouches for what stood there, lost stretches are filled from the library, and a shift
     * the loss took is put back where the bytes after an unfilled stretch read far more like text than PDI data (or
     * the other way). Bytes that arrived passing parity are never changed. Returns { data, summary } or null.
     */
    const reconstructRecord = (data, present, library, self, model) => {
        const out = [...data], summary = { lost: 0, filled: 0, inferred: 0, corrupt: 0, corrected: 0 };
        const wrong = new Uint8Array(data.length);
        let anyWrong = false;
        for (let i = 0; i < data.length; i++) {
            if (libraryPresent(present, i) && data[i] !== 0 && !ODD_PARITY[data[i] & 0xFF]) { wrong[i] = 1; summary.corrupt++; anyWrong = true; }
        }
        for (let i = 0; anyWrong && i < data.length;) {
            if (!wrong[i]) { i++; continue; }
            let j = i;
            while (j < data.length && wrong[j]) j++;
            const answer = library.search(data, present, wrong, i, j, self);
            if (answer && answer.bytes.every((byte) => byte === 0 || ODD_PARITY[byte & 0xFF])) {
                for (let k = i; k < j; k++) out[k] = answer.bytes[k - i];
                summary.corrected += j - i;
            }
            i = j;
        }
        // JS-only: a lone byte failing parity that the library had nothing for is read as one bit flipped: of the
        // readings one bit away that pass parity, the one the recording's dialect clearly prefers between its
        // neighbors is taken, when it reads no worse to the grammar (NBC's "$8@", FIELD, received as "$(@", LINE,
        // which left its text in the wrong field and drew a line across the page)
        if (model && model.records && anyWrong) {
            for (let i = 1; i + 1 < out.length; i++) {
                if (!wrong[i] || wrong[i - 1] || wrong[i + 1] || ODD_PARITY[out[i] & 0xFF]) continue;
                if (!libraryPresent(present, i - 1) || !libraryPresent(present, i + 1)) continue;
                const roles = readRoles(out), role = roles[i] === ROLE_TEXT ? 'text' : roles[i] === ROLE_PDI ? 'pdi' : null;
                if (!role) continue;
                const from = Math.max(0, i - 2), count = Math.min(out.length, i + 3) - from;
                const scored = [];
                for (let bit = 0; bit < 8; bit++) {
                    const candidate = (out[i] ^ (1 << bit)) & 0xFF;
                    if (!ODD_PARITY[candidate] || (candidate & 0x7F) < 0x20 || (candidate & 0x7F) === 0x7F) continue;
                    const trial = out.slice(from, from + count);
                    trial[i - from] = candidate;
                    scored.push([role === 'text' ? model.textScore(trial, 0, count) : model.pdiScore(trial, 0, count), candidate]);
                }
                scored.sort((a, b) => b[0] - a[0]);
                if (!scored.length || (scored.length > 1 && scored[0][0] - scored[1][0] < FLIP_MARGIN)) continue;
                const trial = [...out];
                trial[i] = scored[0][1];
                const [severe, problems] = grammarProblems(trial), [baseSevere, baseProblems] = grammarProblems(out);
                if (severe > baseSevere || problems > baseProblems) continue;
                out[i] = scored[0][1];
                summary.corrected++;
            }
        }
        const holes = [];
        if (present && present.length) {
            for (let i = 0; i < data.length;) {
                if (libraryPresent(present, i)) { i++; continue; }
                let j = i;
                while (j < data.length && !libraryPresent(present, j)) j++;
                holes.push([i, j]);
                summary.lost += j - i;
                i = j;
            }
        }
        const filled = holes.map(([start, end]) => {
            const answer = library.search(data, present, null, start, end, self);
            if (!answer) return false;
            for (let k = start; k < end; k++) out[k] = answer.bytes[k - start];
            summary.filled += end - start;
            return true;
        });
        if (model && model.records) {
            let roles = null;
            holes.forEach(([start, end], h) => {
                if (filled[h] || start === 0) return;
                roles = roles || readRoles(out);
                const before = readStateBefore(out, roles, start);
                if (!before) return;
                let stop = end;
                while (stop < out.length && stop - end < DIALECT_WINDOW_BYTES && (out[stop] & 0x7F) >= 0x20) stop++;
                if (stop - end < SHIFT_EVIDENCE_BYTES) return;
                const text = model.textScore(out, end, stop - end), pdi = model.pdiScore(out, end, stop - end);
                const toText = before === 'pdi' && text - pdi >= SHIFT_MARGIN, toPdi = before === 'text' && pdi - text >= SHIFT_MARGIN;
                if (!toText && !toPdi) return;
                out[end - 1] = withOddParity(toText ? 0x0F : 0x0E);
                summary.inferred++;
                roles = null;
            });
        }
        if (!summary.corrected && !summary.filled && !summary.inferred) return { data: null, summary };
        return { data: out, summary };
    };

    /** Rebuild every presentation record from the recording's own records (decode-orc's "Reconstruct lost data"). */
    const reconstructRecords = (records) => {
        const library = new RecordLibrary(), model = new DialectModel(), index = new Map();
        for (const record of records) {
            if (!isPresentation(record.type) || !record.data?.length) continue;
            index.set(record, library.add({ data: record.data, present: record.present || [] }));
            model.learn(record.data, record.present || []);
        }
        library.build();
        for (const record of records) {
            record.rebuilt = null;
            record.reconstruction = null;
            if (!index.has(record)) continue;
            const { data, summary } = reconstructRecord(record.data, record.present || [], library, index.get(record), model);
            if (summary.lost || summary.corrupt) record.reconstruction = summary;
            if (data) record.rebuilt = data;
        }
    };

    /**
     * Run every presentation record into its page. `reconstruct` rebuilds lost and corrupt bytes from the
     * recording's other records first (the record's own data is left as recovered); `pace` sets the drawing speed:
     * 'classic' (the viewer's original fast, fixed time per figure), 'ttx650' (Norpak TTX 650), 'tu2000x'
     * (Panasonic TU-2000x) or 'off' (instant).
     */
    const interpret = (records, grid = [256, 200], { font = null, reconstruct = true, pace = 'classic' } = {}) => {
        const interpreter = new Interpreter(grid, { font, pace }), supportRecords = new Map(), latestByAddress = new Map();
        if (reconstruct) reconstructRecords(records);
        else for (const record of records) { record.rebuilt = null; record.reconstruction = null; }
        const codeOf = (record) => record.rebuilt || record.data;
        for (const record of records) {
            // Salvaged fragments have no page number, so they neither continue nor are continued by a page
            if (!isPresentation(record.type) || record.identity_lost) continue;
            if (record.flags.support_record) supportRecords.set(record.channel, record);
            // The most-seen content of an address stands for it in More chains (contents are listed most-seen first)
            const addressKey = `${record.channel},${record.address}`;
            if (!latestByAddress.has(addressKey) || record.version !== latestByAddress.get(addressKey).version) latestByAddress.set(addressKey, record);
        }
        // "More" chains: which page continues which (explicit extension, or the +1 rule)
        const predecessor = new Map();
        for (const record of latestByAddress.values()) {
            let successor = record.more_address;
            if (successor === NO_MORE) continue;                   // designated elsewhere: the More flag is not used
            if (successor === null || successor === undefined) {
                if (!record.flags.more) continue;
                successor = nextPageAddress(record.address);
                if (successor === null) continue;
            }
            // Only forward links continue a chain (decode-orc PR #328)
            if (successor <= record.address) continue;
            predecessor.set(`${record.channel},${successor}`, record);
        }
        // A sub-page (address not ending in 00) that no page continues is drawn over the nearest lower page
        // of its group, as a receiver showed it (CBS 1992 page 402 after 401)
        for (const record of latestByAddress.values()) {
            const key = `${record.channel},${record.address}`;
            if (record.address % 256 === 0 || predecessor.has(key)) continue;
            const group = Math.floor(record.address / 256);
            let best = null;
            for (const other of latestByAddress.values()) {
                if (other.channel === record.channel && other.address < record.address &&
                    Math.floor(other.address / 256) === group && (!best || other.address > best.address)) best = other;
            }
            if (best) predecessor.set(key, best);
        }
        for (const record of records) {
            record.page = null;
            record.chain_base = record.address;
            record.chain_pos = 0;
            record.text = '';
            if (!isPresentation(record.type) || !record.data?.length) continue;
            let earlierPages = [], address = record.address, isRing = false;
            const visited = new Set([record.address]);
            while (!record.identity_lost && predecessor.has(`${record.channel},${address}`)) {
                const previous = predecessor.get(`${record.channel},${address}`);
                if (visited.has(previous.address)) { isRing = true; break; }
                visited.add(previous.address);
                earlierPages.unshift(previous);
                address = previous.address;
            }
            if (isRing) {                                    // a closed loop: start from its lowest address
                let base = record.address, baseIndex = 0;
                earlierPages.forEach((page, i) => { if (page.address < base) { base = page.address; baseIndex = i; } });
                earlierPages = base === record.address ? [] : earlierPages.slice(baseIndex);
                address = base;
            }
            record.chain_base = address;
            record.chain_pos = earlierPages.length;
            const needsSupport = record.flags.support_needed || earlierPages.some((page) => page.flags.support_needed);
            const isCaption = record.flags.caption || earlierPages.some((page) => page.flags.caption);
            interpreter.resetDecoder();
            if (needsSupport && !record.flags.support_record && supportRecords.has(record.channel)) {
                interpreter.run(codeOf(supportRecords.get(record.channel)));
            }
            if (isCaption) interpreter.applyCaptionState();
            let keepDisplay = false;
            for (const page of earlierPages) { interpreter.run(codeOf(page), keepDisplay); keepDisplay = true; }
            record.page = interpreter.run(codeOf(record), keepDisplay);
            record.text = pageText(record.page);
        }
        return records;
    };

    const editionSuffix = (record, separator) => (record.edition > 1 ? `${separator}${record.edition}` : '');
    const recordLabel = (record) => `${toHex(record.channel, 3)}/${record.addr_text} v${record.version}${editionSuffix(record, ' e')}`;
    const recordName = (record) => `${toHex(record.channel, 3)}-${record.addr_text}-v${record.version}${editionSuffix(record, '-e')}`;
    const FLAG_LABELS = [['caption', 'captions'], ['cyclic', 'cyclic'], ['priority', 'priority'], ['alarm', 'alarm'],
    ['update', 'update'], ['support_record', 'support'], ['support_needed', 'needs support'],
    ['index', 'index'], ['more', 'more']];
    const flagsText = (record) => FLAG_LABELS.filter(([flag]) => record.flags[flag]).map(([, label]) => label).join(', ');

    return {
        readT33, interpret, Player, Interpreter, pageText, pageSVG,
        decoderFonts: () => loadDecoderFonts(), recordLabel, recordName, flagsText,
        addressText, isPresentation, rgb: colorToRgb, DEFAULT_MAP, DISPLAY_H: DISPLAY_HEIGHT,
        GRIDS: { '256 × 200 (receiver)': [256, 200], '512 × 400': [512, 400], '768 × 600': [768, 600] },
        _internal: { decodePacket, Catalog, Surface, Rasteriser, drawPrimitive, arcPolyline: arcToPolyline }
    };
});
