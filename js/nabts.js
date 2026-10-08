/*! nabts.js — NABTS (.t33) stream decoder and NAPLPS page renderer/animator for the browser.
 * JavaScript port of pages/nabts.py from AssunaYuuki's Teletext Rescue, itself a port of decode-orc
 * (orc/plugins/stages/nabts_sink). Licence: GPL-3.0-or-later (inherited from decode-orc).
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
        for (let i = 0; i < PREFIX_SIZE; i++) {
            prefixNibbles.push(HAMMING_VALUE[packetBytes[i]]);
            if (prefixNibbles[i] < 0) return packet;
        }
        packet.valid = true;
        packet.channel = (prefixNibbles[0] << 8) | (prefixNibbles[1] << 4) | prefixNibbles[2];
        packet.attested = !!(HAMMING_CLEAN[packetBytes[0]] && HAMMING_CLEAN[packetBytes[1]] && HAMMING_CLEAN[packetBytes[2]]);
        packet.ci = prefixNibbles[3];                    // continuity index
        packet.ci_byte = packetBytes[3];
        const structure = prefixNibbles[4];
        packet.sync = !!(structure & 1);
        packet.not_full = !!(structure & 2);
        packet.suffix = (((structure >> 3) & 1) << 1) | ((structure >> 2) & 1);   // 0 none, 1 LRC, 2 LRC+spare, 3 burst
        const dataLength = MAX_BLOCK - [0, 1, 2, MAX_BLOCK][packet.suffix];
        if (packet.sync && dataLength === 0) { packet.valid = false; return packet; }
        const data = Array.from(packetBytes.subarray(PREFIX_SIZE, PREFIX_SIZE + dataLength));
        packet.integrity = 'unchecked';
        if (packet.suffix === 1 || packet.suffix === 2) {
            const block = packetBytes.subarray(PREFIX_SIZE, PREFIX_SIZE + MAX_BLOCK);
            let checksum = 0;
            for (const byte of block) checksum ^= byte;
            const syndrome = checksum ^ 0xFF;
            if (syndrome === 0) packet.integrity = 'clean';
            else if ((syndrome & (syndrome - 1)) === 0) {      // a single bit is wrong …
                const badParity = [];
                block.forEach((byte, position) => { if (!ODD_PARITY[byte]) badParity.push(position); });
                if (badParity.length === 1) {                    // … and parity says which byte
                    if (badParity[0] < dataLength) data[badParity[0]] ^= syndrome;
                    packet.integrity = 'corrected';
                } else packet.integrity = 'damaged';
            } else packet.integrity = 'damaged';
        }
        packet.data = data;
        return packet;
    };

    // * * * Data groups (§4) * * *
    const GROUP_HEADER_SIZE = 8, MAX_FURTHER_PACKETS = 67, MAX_OPEN_GROUPS = 32;

    const decodeGroupHeader = (bytes, lowNibbleFirst = false) => {
        if (bytes.length < GROUP_HEADER_SIZE) return null;
        const nibbles = [];
        let attested = true;
        for (let i = 0; i < GROUP_HEADER_SIZE; i++) {
            nibbles.push(HAMMING_VALUE[bytes[i]]);
            if (nibbles[i] < 0) return null;
            if (!HAMMING_CLEAN[bytes[i]]) attested = false;
        }
        const byteFrom = (first, second) => (lowNibbleFirst ? (second << 4) | first : (first << 4) | second);
        return {
            attested, type: nibbles[0], ci: nibbles[1], rep: nibbles[2], further: byteFrom(nibbles[3], nibbles[4]),
            final_bytes: byteFrom(nibbles[5], nibbles[6]), routing: nibbles[7]
        };
    };

    const detectHeaderNibbleOrder = (bytes, packetCount) => {
        let highFirst = 0, lowFirst = 0;
        for (let i = 0; i < packetCount; i++) {
            const packet = decodePacket(bytes.subarray(i * PACKET_SIZE, (i + 1) * PACKET_SIZE));
            if (!packet.valid || !packet.sync) continue;
            const asHigh = decodeGroupHeader(packet.data, false), asLow = decodeGroupHeader(packet.data, true);
            if (!asHigh) continue;
            const plausible = (header) => header.further <= MAX_FURTHER_PACKETS && header.final_bytes <= MAX_BLOCK;
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
            this.clock = 0;
            this.stats = {
                packets: 0, prefix_bad: 0, header_bad: 0, orphans: 0,
                complete: 0, superseded: 0, unfinished: 0, foreign: 0
            };
        }

        static _tallyIntegrity(group, packet) {
            if (packet.integrity === 'damaged') group.damaged += 1;
            else if (packet.integrity === 'unchecked' && packet.data.length > 0) group.unchecked += 1;
        }

        _appendPacket(group, packet) {
            if (!packet.data.length) return;
            group.lastOffset = group.stream.length;
            group.lastLength = packet.data.length;
            for (const byte of packet.data) {
                group.stream.push(byte);
                group.present.push(group.placeable ? 1 : 0);
            }
        }

        _appendHole(group, missingPackets) {
            const length = missingPackets * group.nominalLength;
            for (let i = 0; i < length; i++) { group.stream.push(0); group.present.push(0); }
        }

        _emit(channel, group, outcome) {
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
                intact: outcome === 'complete' && group.lost === 0 && group.damaged === 0 && group.unchecked === 0
            };
            this.stats[outcome] += 1;
            if (outcome === 'complete' && group.header.type !== 0) this.stats.foreign += 1;
            this.onGroup(finished);
        }

        add(packet) {
            this.stats.packets += 1;
            this.clock += 1;
            if (!packet.valid) { this.stats.prefix_bad += 1; return; }
            if (packet.sync) this._begin(packet); else this._extend(packet);
        }

        _begin(packet) {
            const header = decodeGroupHeader(packet.data, this.lowNibbleFirst);
            if (!header) { this.stats.header_bad += 1; return; }
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
            if (!group) { this.stats.orphans += 1; return; }
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
            GroupAssembler._tallyIntegrity(group, packet);
            this._appendPacket(group, packet);
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
            this.sequence = 0;
            this.stats = { groups: 0, foreign: 0, header_bad: 0, records: 0 };
            this.foreign = new Map();
        }

        add(group) {
            this.stats.groups += 1;
            if (group.hdr.type !== 0) {                          // not teletext (another data service)
                this.stats.foreign += 1;
                if (group.channel_attested && group.hdr.attested) {
                    const key = `${group.channel},${group.hdr.type}`;
                    this.foreign.set(key, (this.foreign.get(key) || 0) + 1);
                }
                return;
            }
            const header = decodeRecordHeader(group.data);
            if (!header) { this.stats.header_bad += 1; return; }
            this.stats.records += 1;
            const data = group.data.slice(header.header_bytes), present = group.present.slice(header.header_bytes);
            const attested = header.attested && group.channel_attested;
            if (!header.linked) {
                this.onMessage({
                    channel: group.channel, address: header.address, long_form: header.long_form, type: header.type,
                    flags: { ...header.flags }, version: header.version, extensions: header.extensions,
                    data, present, complete: true, intact: group.intact, attested,
                    aligned: true, records: 1, clock: group.clock
                });
                return;
            }
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
                    final: 999, intact: true, attested: false, sequence: this.sequence++
                };
                this.openSeries.set(key, series);
            }
            if (header.order === 0) {
                series.flags = { ...header.flags }; series.extensions = header.extensions; series.type = header.type;
            }
            if (!group.intact) series.intact = false;
            if (attested) series.attested = true;
            if (!header.more_links) series.final = header.order;
            series.parts.set(header.order, [data, present]);
            series.clock = group.clock;
            if (series.final <= 127 && series.parts.size === series.final + 1) {
                this.openSeries.delete(key);
                this._emit(series, true);
            }
        }

        _emit(series, complete) {
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
    const MAX_COPIES = 16;

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

    /** Byte-by-byte majority vote; odd parity wins over even, then weight, then the newest copy. */
    const voteOverCopies = (copies, included) => {
        const length = votedLength(copies, included);
        const data = new Array(length).fill(0), present = new Array(length).fill(0), ties = [];
        for (let position = 0; position < length; position++) {
            const weight = new Map(), newestCopy = new Map();
            copies.forEach(([copyData, copyPresent], copyIndex) => {
                if (included && !included[copyIndex]) return;
                if (position >= copyData.length || (position < copyPresent.length && !copyPresent[position])) return;
                const value = copyData[position];
                weight.set(value, (weight.get(value) || 0) + 255);
                newestCopy.set(value, copyIndex);
            });
            if (!weight.size) continue;
            let winner = null;
            for (const [value, valueWeight] of weight) {
                if (winner === null) { winner = value; continue; }
                const winnerOdd = ODD_PARITY[winner], valueOdd = ODD_PARITY[value];
                if (winnerOdd && !valueOdd) continue;
                const beatsWinner = valueWeight > weight.get(winner) ||
                    (valueWeight === weight.get(winner) && newestCopy.get(value) > newestCopy.get(winner));
                if (winnerOdd === valueOdd && !beatsWinner) continue;
                winner = value;
            }
            data[position] = winner;
            present[position] = 1;
            const tied = [...weight.keys()].filter((value) => value !== winner &&
                ODD_PARITY[value] === ODD_PARITY[winner] && weight.get(value) === weight.get(winner));
            if (tied.length) ties.push([position, [winner, ...tied]]);
        }
        return [data, present, ties];
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
    const agreesBetter = ([comparedA, agreedA], [comparedB, agreedB]) =>
        agreedA * Math.max(1, comparedB) > agreedB * Math.max(1, comparedA);
    const shiftCopy = ([copyData, copyPresent], slip) => {
        const length = Math.max(0, copyData.length - slip);
        const data = new Array(length).fill(0), present = new Array(length).fill(0);
        for (let position = 0; position < length; position++) {
            const source = position + slip;
            if (source < 0 || source >= copyData.length || (source < copyPresent.length && !copyPresent[source])) continue;
            data[position] = copyData[source];
            present[position] = 1;
        }
        return [data, present];
    };

    /** Vote a record from its damaged copies; copies that slipped by a few bytes are realigned. */
    const voteRecord = (copies) => {
        if (!copies.length) return [[], []];
        if (copies.length === 1) return copies[0];
        const provisional = voteOverCopies(copies), aligned = [...copies], included = copies.map(() => 1);
        let dropped = 0;
        copies.forEach((copy, i) => {
            const unshifted = agreementWithVote(copy, provisional, 0);
            if (!isOutlier(unshifted)) return;
            let best = unshifted, bestSlip = 0;
            for (let slip = -8; slip <= 8; slip++) {
                if (slip === 0) continue;
                const agreement = agreementWithVote(copy, provisional, slip);
                if (!isOutlier(agreement) && agreesBetter(agreement, best)) { best = agreement; bestSlip = slip; }
            }
            if (bestSlip) { aligned[i] = shiftCopy(copy, bestSlip); return; }
            included[i] = 0;
            dropped++;
        });
        if (dropped === 0 || dropped * 2 >= copies.length) return voteOverCopies(aligned);
        return voteOverCopies(aligned, included);
    };

    /** The "More" successor by the +1 rule on the two low BCD digits (…09 → …10). */
    const nextPageAddress = (address) => {
        const tens = (address >> 4) & 0xF, units = address & 0xF;   // low byte only: safe in 32-bit
        if (tens > 9 || units > 9) return null;
        const next = tens * 10 + units + 1;
        if (next > 99) return null;
        return (address - (address % 256)) + ((Math.floor(next / 10) << 4) | (next % 10));
    };

    const moreAddressFromExtensions = (extensions) => {
        for (const [meaning, size, digits] of extensions) {
            if (meaning !== 1) continue;
            if (size === 0) return 0;
            if (size === 3 || size === 9) {
                const value = digits.reduce((address, digit) => address * 16 + (digit & 0xF), 0);
                return size === 3 ? value * 256 : value;
            }
        }
        return null;
    };

    const FLAGS_VOTED = ['caption', 'cyclic', 'priority', 'alarm', 'update', 'support_record',
        'support_needed', 'index', 'more'];

    const MAX_GRAMMAR_TRIALS = 32;                   // per record: each trial interprets the whole record
    let grammarChecker = null;

    const grammarProblems = (bytes) => {
        if (!grammarChecker) {
            grammarChecker = new Interpreter([256, 200]);
            grammarChecker.checkingOnly = true;
        }
        grammarChecker.resetDecoder();
        grammarChecker.run(bytes);
        return [grammarChecker.lintSevere, grammarChecker.lint, grammarChecker.firstSevereAt];
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
                if (severe < bestSevere && problems < bestProblems) {
                    best = trial; bestSevere = severe; bestProblems = problems; firstSevereAt = severeAt;
                    break;
                }
            }
        }
        return bestSevere === 0 ? best : data;       // only a vote that reads cleanly is trusted
    };

    const EDITION_SAME_CONTENT = 0.85, EDITION_SAMPLE_STEP = 3, EDITION_MIN_SAMPLES = 24;
    const EDITION_CONFIRM = 3, EDITION_LOOK_BACK = 8, EDITION_OLD_RETURNS = 0.1;

    const sampleCopy = (message) => {
        const length = Math.ceil(message.data.length / EDITION_SAMPLE_STEP);
        const data = new Uint8Array(length), present = new Uint8Array(length);
        for (let i = 0, j = 0; i < message.data.length; i += EDITION_SAMPLE_STEP, j++) {
            data[j] = message.data[i] & 0x7F;
            present[j] = message.present ? (message.present[i] ? 1 : 0) : 1;
        }
        return { clock: message.clock, data, present };
    };

    const sampleAgreement = (a, b) => {
        let compared = 0, same = 0;
        for (let i = 0; i < Math.min(a.data.length, b.data.length); i++) {
            if (!a.present[i] || !b.present[i]) continue;
            compared++;
            if (a.data[i] === b.data[i]) same++;
        }
        return compared >= EDITION_MIN_SAMPLES ? same / compared : NaN;
    };

    const findEditionChanges = (copies) => {
        const changes = [];
        const agrees = (a, b) => sampleAgreement(a, b) >= EDITION_SAME_CONTENT;
        const matchesAny = (copy, group) => group.some((other) => agrees(copy, other));
        let start = 0;
        for (let t = start + EDITION_CONFIRM; t + EDITION_CONFIRM <= copies.length; t++) {
            const run = copies.slice(t, t + EDITION_CONFIRM);
            if (!run.every((copy, i) => run.every((other, j) => i === j || agrees(copy, other)))) continue;
            const before = copies.slice(Math.max(start, t - EDITION_LOOK_BACK), t);
            if (run.some((copy) => matchesAny(copy, before))) continue;
            if (!before.some((copy) => before.filter((other) => other !== copy && agrees(copy, other)).length >= EDITION_CONFIRM - 1)) continue;
            const after = copies.slice(t);
            const oldReturns = after.filter((copy) => matchesAny(copy, before)).length;
            if (oldReturns > EDITION_OLD_RETURNS * after.length) continue;
            changes.push(copies[t].clock);
            start = t;
            t = start + EDITION_CONFIRM - 1;
        }
        return changes;
    };

    class Catalog {
        constructor(editionChanges = null) {
            this.entries = new Map();
            this.editionChanges = editionChanges;
            this.history = editionChanges ? null : new Map();
        }

        static baseKey(message) { return `${message.channel},${message.address},${message.version}`; }

        findEditionChanges() {
            const found = new Map();
            for (const [baseKey, copies] of this.history) {
                if (copies.length < 2 * EDITION_CONFIRM) continue;
                const changes = findEditionChanges(copies);
                if (changes.length) found.set(baseKey, changes);
            }
            return found;
        }

        static takeMessage(entry, message) {
            entry.type = message.type;
            entry.records = message.records;
            entry.complete = message.complete;
            entry.data = message.data;
            entry.present = message.present;
            entry.more_address = moreAddressFromExtensions(message.extensions);
            entry.kept_intact = !!(message.complete && message.intact);
        }

        merge(message) {
            const baseKey = Catalog.baseKey(message);
            let edition = 1;
            if (this.history) {
                if (!this.history.has(baseKey)) this.history.set(baseKey, []);
                this.history.get(baseKey).push(sampleCopy(message));
            } else {
                for (const clock of this.editionChanges.get(baseKey) || []) if (message.clock >= clock) edition++;
            }
            const key = edition > 1 ? `${baseKey}#${edition}` : baseKey;
            let entry = this.entries.get(key);
            const good = message.complete && message.intact;
            if (!entry) {
                entry = {
                    channel: message.channel, address: message.address, version: message.version, long_form: message.long_form,
                    first: message.clock, seen: 0, intact_n: 0, attested_n: 0,
                    flags_set: Object.fromEntries(FLAGS_VOTED.map((name) => [name, 0])),
                    flags_att: Object.fromEntries(FLAGS_VOTED.map((name) => [name, 0])),
                    copies: [], kept_intact: false, edition
                };
                Catalog.takeMessage(entry, message);
                this.entries.set(key, entry);
            } else if ((good !== entry.kept_intact && good) ||
                (good === entry.kept_intact && message.data.length > entry.data.length)) {
                Catalog.takeMessage(entry, message);
            }
            if (good) entry.copies = [];
            else if (!entry.kept_intact && message.aligned) {
                if (entry.copies.length >= MAX_COPIES) entry.copies.shift();
                entry.copies.push([message.data, message.present]);
            }
            for (const name of FLAGS_VOTED) {
                if (message.flags[name]) {
                    entry.flags_set[name]++;
                    if (message.attested) entry.flags_att[name]++;
                }
            }
            entry.last = message.clock;
            entry.seen++;
            entry.intact_n += good ? 1 : 0;
            entry.attested_n += message.attested ? 1 : 0;
        }

        /** Identities never received cleanly: fold into a neighbor one digit away, or drop. */
        reconcile() {
            const identityDigits = (entry) => {
                const digits = [(entry.channel >> 8) & 0xF, (entry.channel >> 4) & 0xF, entry.channel & 0xF];
                for (let bits = 32; bits >= 0; bits -= 4) digits.push(shiftRight(entry.address, bits) % 16);
                digits.push(entry.version & 0xF);
                return digits;
            };
            const contentAgreement = (a, b) => {
                const longer = Math.max(a.length, b.length);
                if (longer === 0) return NaN;
                let same = 0;
                for (let i = 0; i < Math.min(a.length, b.length); i++) if (((a[i] ^ b[i]) & 0x7F) === 0) same++;
                return same / longer;
            };
            const SAME_CONTENT = 0.5, RECURRING = 2;
            const keys = [...this.entries.keys()].sort((x, y) => {
                const p = this.entries.get(x), q = this.entries.get(y);
                return p.channel - q.channel || p.address - q.address || p.version - q.version;
            });
            const entries = keys.map((key) => this.entries.get(key));
            const digits = entries.map(identityDigits);
            const trusted = entries.map((entry) => entry.attested_n > 0);
            if (!trusted.some(Boolean)) return [0, 0, 0];
            const singleDigitNeighbor = (index) => {
                let found = null;
                for (let other = 0; other < entries.length; other++) {
                    if (!trusted[other]) continue;
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
            const anchor = [...trusted];
            const untrusted = entries.map((_, i) => i).filter((i) => !trusted[i])
                .sort((x, y) => entries[y].seen - entries[x].seen);
            const verdicts = new Array(entries.length).fill(null);
            for (const u of untrusted) {
                let match = null, matchAgreement = 0, ambiguous = false;
                for (let a = 0; a < entries.length; a++) {
                    if (!anchor[a] || a === u) continue;
                    const agree = contentAgreement(entries[u].data, entries[a].data);
                    if (!(agree >= SAME_CONTENT)) continue;
                    const better = match === null || agree > matchAgreement ||
                        (agree === matchAgreement && entries[a].seen > entries[match].seen);
                    if (better) { match = a; matchAgreement = agree; ambiguous = false; }
                    else if (agree === matchAgreement && entries[a].seen === entries[match].seen) ambiguous = true;
                }
                const neighbor = singleDigitNeighbor(u);
                if (match !== null && !ambiguous) verdicts[u] = ['fold', match];
                else if (match === null && entries[u].seen >= RECURRING && entries[u].data.length > 0) {
                    verdicts[u] = ['keep'];
                    anchor[u] = true;
                } else if (neighbor !== null) verdicts[u] = ['fold', neighbor];
                else verdicts[u] = ['drop'];
            }
            let folded = 0, dropped = 0, kept = 0;
            for (let i = 0; i < entries.length; i++) {
                if (trusted[i]) continue;
                const entry = entries[i], [action, target] = verdicts[i];
                if (action === 'keep') { entry.unconfirmed = true; kept++; continue; }
                this.entries.delete(keys[i]);
                if (action === 'drop') { dropped++; continue; }
                const into = entries[target];
                into.seen += entry.seen;
                into.intact_n += entry.intact_n;
                for (const name of FLAGS_VOTED) into.flags_set[name] += entry.flags_set[name];
                into.first = Math.min(into.first, entry.first);
                into.last = Math.max(into.last, entry.last);
                if (!into.kept_intact) {
                    for (const copy of entry.copies) {
                        if (into.copies.length >= MAX_COPIES) break;
                        into.copies.push(copy);
                    }
                }
                folded++;
            }
            return [folded, dropped, kept];
        }

        records() {
            const entries = [...this.entries.values()];
            entries.sort((a, b) => a.channel - b.channel || a.address - b.address || a.version - b.version || a.edition - b.edition);
            const editionCount = new Map();
            for (const entry of entries) {
                const baseKey = Catalog.baseKey(entry);
                editionCount.set(baseKey, (editionCount.get(baseKey) || 0) + 1);
            }
            return entries.map((entry) => {
                const { copies, ...fields } = entry;
                const record = { ...fields };
                const hasAttested = entry.attested_n > 0;
                const voters = hasAttested ? entry.attested_n : entry.seen;
                const flagCounts = hasAttested ? entry.flags_att : entry.flags_set;
                record.flags = Object.fromEntries(FLAGS_VOTED.map((name) => [name, flagCounts[name] * 2 > voters]));
                record.copies_voted = copies.length;
                record.unconfirmed = !!entry.unconfirmed;
                record.editions = editionCount.get(Catalog.baseKey(entry));
                if (copies.length) {
                    const [data, present, ties] = voteRecord(copies);
                    record.data = ties && ties.length ? settleTiesByGrammar(data, ties) : data;
                    record.present = present;
                }
                record.addr_text = !entry.long_form ? addressText(entry.address) : toHex(entry.address, 9);
                record.purpose = reservedPurpose(entry.channel, entry.address);
                return record;
            });
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
    const DRAW_COST = { char: 0.004, point: 0.004, line: 0.012, arc: 0.02, rect: 0.02, poly: 0.02, incr: 0.05 };
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

    class Interpreter {
        constructor(grid = [256, 200], { font = null } = {}) {
            this.grid = grid;
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
            this.cursor = this.home();
            this.dp = [0.0, 0.0];                     // drawing point
            this.blink = new Array(16).fill(null);
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
            this.lint = 0;                            // grammar problems, for settling tied votes
            this.lintSevere = 0;
            this.firstSevereAt = -1;
            const carried = keepDisplay ? this.prims : [];
            this.prims = carried;
            // Timeline for on-screen playback: primitives with their times, screen clears, color-map
            // and blink changes. Time = WAIT pauses (§5.3.2.8) + the nominal drawing speed (DRAW_COST).
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
            const corrupt = Array.from(recordBytes, (byte) => !ODD_PARITY[byte & 0xFF]);
            const corruptCount = corrupt.filter(Boolean).length;
            this.frames.push({
                bytes: Array.from(recordBytes, (byte) => byte & 0x7F), position: 0,
                corrupt: corruptCount && corruptCount < 0.3 * corrupt.length ? corrupt : null
            });
            let steps = 0;
            while (this.frames.length) {
                steps++;
                if (steps > 400000) break;              // guard against loops in damaged data
                if (!this.step()) {
                    this.frames.pop();
                    if (this.frames.length && this.def_frame >= this.frames.length) this.def_frame = this.frames.length - 1;
                }
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
                masks: [...this.masks], events: this.events, end: this.clock
            };
        }

        /** Count a problem that wrecks the page (a late clear or RESET, a CAN) and where in the record it was. */
        noteSevere() {
            this.lintSevere++;
            if (this.firstSevereAt < 0 && this.frames.length) this.firstSevereAt = this.frames[0].position;
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
                    if (this.collecting === 'macro') { this.body.push(byte); return true; }
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
            const frame = this.frame;
            if (frame.corrupt && frame.corrupt[frame.position - 1] && (byte === 0x0C || byte === CAN)) return;
            if (byte === ESC) {
                const [kind, length, slot, value] = parseEscape(frame.bytes, frame.position);
                frame.position += length - 1;
                if (kind === 'bad' || kind === 'unsup' || kind === 'trunc') this.lint += 1;
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
            this.snapState();
            this.events.push(['clear', this.clock]);
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
            if (set === SET_PDI) { if (byte >= 0x20 && byte <= 0x3F) this.execPdi(byte); return; }
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
            this.emit(character);
            if (set !== SET_SUPPLEMENTARY || !isNonSpacingAccent(byte)) this.moveBy('fwd');
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
            const operandBytes = this.gatherOperands(), operands = new OperandReader(operandBytes, [...this.fmt]);
            if (opcode === 0x20) this.pdiReset(operands);
            else if (opcode === 0x21) this.pdiDomain(operands);
            else if (opcode === 0x22) this.pdiText(operands);
            else if (opcode === 0x23) this.pdiTexture(operands);
            else if (opcode === 0x3C) this.pdiSetColor(operands);
            else if (opcode === 0x3E) this.pdiSelectColor(operands);
            else if (opcode === 0x3F) this.pdiBlink(operands);
            else if (opcode === 0x3D) {                         // WAIT (§5.3.2.8), tenths of a second
                this.snapState();
                this.clock += 0.1 * operandBytes.reduce((total, byte) => total + (byte & 0x3F), 0);
            }
            else if (opcode <= 0x27) this.pdiPoint(opcode, operands);
            else if (opcode <= 0x2B) this.pdiLine(opcode, operands);
            else if (opcode <= 0x2F) this.pdiArc(opcode, operands);
            else if (opcode <= 0x33) this.pdiRect(opcode, operands);
            else if (opcode <= 0x37) this.pdiPoly(opcode, operands);
            else if (opcode === 0x38) this.pdiField(operands);
            else this.pdiIncremental(opcode, operands, operandBytes);
            if (operands.truncated) this.lint += 1;
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
            const first = operands.fixed();
            this.fmt = [(first & 3) + 1, ((first >> 2) & 7) + 1, !!((first >> 5) & 1)];
            if (operands.empty()) return;
            operands.format = [...this.fmt];
            this.pel = operands.coord();
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
            const valueCount = bytesPerValue ? Math.floor(operands.remaining() / bytesPerValue) : 0;
            if (valueCount === 0) { this.color.mode = 0; return; }
            const drawAddress = mapAddressFromOperand(operands.single(), bytesPerValue);
            if (valueCount === 1) { this.color.selectMapped(drawAddress); return; }
            const backgroundAddress = mapAddressFromOperand(operands.single(), bytesPerValue);
            this.color.selectMappedWithBackground(drawAddress, backgroundAddress);
        }

        pdiBlink(operands) {
            if (operands.empty()) { this.blink[this.color.draw_addr] = null; return; }
            let fromAddress = this.color.draw_addr;
            for (; ;) {
                const toAddress = mapAddressFromOperand(operands.single(), this.fmt[0]);
                const onTime = operands.empty() ? 0 : operands.fixed();
                const offTime = operands.empty() ? 0 : operands.fixed();
                const delay = !operands.empty() ? operands.fixed() : 0;
                this.blink[pythonMod(fromAddress, 16)] = (onTime && offTime)
                    ? [pythonMod(toAddress, 16), null, onTime, offTime, delay, this.clock]
                    : null;
                if (operands.empty()) return;
                fromAddress = nextMapAddress(fromAddress);
                if (fromAddress === null) return;
            }
        }

        resolve(point) { return clampToScreen(point); }

        pdiPoint(opcode, operands) {
            const relative = opcode === 0x25 || opcode === 0x27, visible = opcode === 0x26 || opcode === 0x27;
            while (!operands.empty()) {
                const offset = operands.coord();
                const target = this.resolve(relative ? [this.dp[0] + offset[0], this.dp[1] + offset[1]] : offset);
                this.moveDp(target);
                if (visible) {
                    const point = this.make('point');
                    point.origin = target;
                    point.points = [target];
                    this.emit(point);
                }
                if (operands.truncated) return;
            }
        }

        pdiLine(opcode, operands) {
            const relative = opcode === 0x29 || opcode === 0x2B, hasStart = opcode === 0x2A || opcode === 0x2B;
            while (!operands.empty()) {
                let start = this.dp;
                if (hasStart) { start = this.resolve(operands.coord()); if (operands.empty()) return; }
                const offset = operands.coord();
                const end = relative ? this.resolve([start[0] + offset[0], start[1] + offset[1]]) : this.resolve(offset);
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
            this.emit(arc);
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
            if (poly.points.length < 3) return;
            this.emit(poly);
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
            this.field_origin = this.resolve(first);
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
            const step = operands.coord();
            const poly = this.make('poly');
            poly.filled = opcode === 0x3B;
            poly.origin = this.dp;
            poly.points = [this.dp];
            let current = this.dp;
            while (!operands.empty() && poly.points.length < 256) {
                const direction = operands.fixed() & 7;
                const dx = [1, 2, 3].includes(direction) ? step[0] : ([5, 6, 7].includes(direction) ? -step[0] : 0.0);
                const dy = [3, 4, 5].includes(direction) ? step[1] : ([7, 0, 1].includes(direction) ? -step[1] : 0.0);
                current = this.resolve([current[0] + dx, current[1] + dy]);
                poly.points.push(current);
            }
            if (poly.points.length >= 2) this.emit(poly);
            this.moveDp(current);
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

        emit(prim) {
            if (this.collecting === 'drcs' || this.collecting === 'mask') { this.drawIntoDefinition(prim); return; }
            this.snapState();
            prim.t = this.clock;
            this.prims.push(prim);
            this.events.push(['p', this.clock, prim]);
            this.clock += (DRAW_COST[prim.kind] ?? 0.02) * (prim.filled ? 2.0 : 1.0);
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
                if (!this.staysOnRow(point)) this.wrap = 0;
                this.cursor = point;
            }
        }

        moveCursor(point) {
            this.wrap = 0;
            this.cursor = this.resolve(point);
            if (this.text.move === 0 || this.text.move === 1) this.dp = this.cursor;
        }

        moveBy(direction) {
            const text = this.text, horizontal = text.path === 0 || text.path === 1;
            const characterStep = Math.abs(horizontal ? text.field[0] : text.field[1]) * SPACING_FACTORS[text.ics & 3];
            const rowStep = Math.abs(horizontal ? text.field[1] : text.field[0]) * ROW_SPACING_FACTORS[text.irs & 3];
            const distance = (direction === 'fwd' || direction === 'back') ? characterStep : rowStep;
            const [pathX, pathY] = PATH_DIRECTIONS[text.path];
            const [stepX, stepY] = {
                fwd: [pathX, pathY], back: [-pathX, -pathY], down: [pathY, -pathX], up: [-pathY, pathX]
            }[direction];
            let newX = this.cursor[0] + stepX * distance, newY = this.cursor[1] + stepY * distance;
            const rightEdge = this.field_origin[0] + Math.abs(this.field_size[0]);
            const wrapped = direction === 'fwd' && text.path === 0 && newX + Math.abs(text.field[0]) > rightEdge + 1e-9;
            if (wrapped) { newX = this.field_origin[0]; newY -= rowStep; }
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
            drawPrimitive(rasteriser, prim, null, { definition: true, drcs: this.drcs });
            surface.cells.forEach((cell, i) => { if (cell !== -1) target.el[i] = !black; });
        }

        invokeMacro(code) {
            if (this.collecting === 'macrox' && code === this.def_code) return;
            const macro = this.macros.get(code);
            if (!macro || macro[1]) return;
            if (this.frames.length > MAX_MACRO_DEPTH) return;
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

    const pelAnchor = (position, extent) => Math.floor(Math.min(position, position + extent));
    const pelSpan = (extent) => Math.max(1, Math.floor(Math.abs(extent) + 0.5));

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
        if (!mask || !(mask.w > 0 && mask.h > 0)) return true;
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

    /** The largest font face that fits the character cell (only 6×10 at the receiver's 256 columns). */
    const chooseFace = (gridWidth, cellColumns, cellRows) => {
        const facesAvailable = gridWidth <= 256 ? 1 : FONT.FACES.length;
        let chosen = null, chosenDividesRows = false, chosenArea = 0;
        for (const face of FONT.FACES.slice(0, facesAvailable)) {
            const [, faceWidth, faceHeight] = face;
            if (faceWidth > cellColumns || faceHeight > cellRows) continue;
            const dividesRows = cellRows % faceHeight === 0, area = faceWidth * faceHeight;
            if (chosen !== null) {
                if (chosenDividesRows && !dividesRows) continue;
                if (dividesRows === chosenDividesRows && area <= chosenArea) continue;
            }
            chosen = face;
            chosenDividesRows = dividesRows;
            chosenArea = area;
        }
        return chosen || FONT.FACES[0];
    };
    const glyphRows = (face, codePoint) => {
        const index = GLYPH_INDEX.get(codePoint);
        if (index === undefined) return null;
        const faceHeight = face[2];
        return face[3].slice(index * faceHeight, (index + 1) * faceHeight);
    };

    const resolveDecoderFont = (font) => {
        if (!font) return null;
        if (typeof font === 'object') return font;
        return loadDecoderFonts()[font] || null;
    };

    const GLYPH_STAND_INS = {
        0x27: [0x2019], 0x60: [0x2018], 0x2019: [0x27], 0x2018: [0x60], 0x2015: [0x2014, 0x2D],
        0x2014: [0x2015, 0x2D], 0x2500: [0x2014, 0x2D], 0x2502: [0x7C], 0xA4: [0x24]
    };

    const CELL_EPSILON = 1e-6;

    const LINE_GLYPHS = { 0x2015: [true, false], 0x2500: [true, false], 0x2502: [false, true], 0x253C: [true, true] };

    const lineGlyph = (codePoint, width, height) => {
        const lines = LINE_GLYPHS[codePoint];
        if (!lines) return null;
        const [horizontal, vertical] = lines, middleRow = Math.floor(height / 2), middleBit = 1 << (width - 1 - Math.floor(width / 2));
        return Array.from({ length: height }, (_, row) => (horizontal && row === middleRow ? (1 << width) - 1 : 0) | (vertical ? middleBit : 0));
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
            const fromColumn = pelAnchor(from[0], pelSize[0]), fromRow = pelAnchor(from[1], pelSize[1]);
            const toColumn = pelAnchor(to[0], pelSize[0]), toRow = pelAnchor(to[1], pelSize[1]);
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

        stroke(points, pel, texture, ink, closed = false) {
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
                this.stampCells(from, pelSize, ink);
                this.stampCells(to, pelSize, ink);
                phase = exit;
            }
        }

        fill(points, pel, pattern, maskSize, mask, ink) {
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

            // 2. scanlines: which cells are inside the polygon
            const enclosed = new Uint8Array(cellCount), vertexCount = cellPoints.length;
            for (let row = firstRow; row < firstRow + height; row++) {
                const sampleY = row + 0.5, crossings = [];
                for (let i = 0; i < vertexCount; i++) {
                    const a = cellPoints[i], b = cellPoints[(i + 1) % vertexCount];
                    if ((a[1] <= sampleY && sampleY < b[1]) || (b[1] <= sampleY && sampleY < a[1]))
                        crossings.push(a[0] + (sampleY - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
                }
                crossings.sort((p, q) => p - q);
                const rowBase = (row - firstRow) * width - firstColumn;
                for (let i = 0; i < crossings.length - 1; i += 2) {
                    const spanStart = Math.max(firstColumn, Math.ceil(crossings[i] - 0.5));
                    const spanEnd = Math.min(firstColumn + width - 1, Math.floor(crossings[i + 1] - 0.5));
                    for (let column = spanStart; column <= spanEnd; column++) enclosed[rowBase + column] = 1;
                }
            }

            // 3. flood the outside, starting from cells clearly outside and not next to the outline
            const outside = new Uint8Array(cellCount), nearOutline = new Uint8Array(cellCount);
            for (let index = 0; index < cellCount; index++) {
                if (!outline[index]) continue;
                const y = Math.floor(index / width), x = index - y * width;
                for (let dy = -1; dy <= 1; dy++) {
                    const neighborY = y + dy;
                    if (neighborY < 0 || neighborY >= height) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const neighborX = x + dx;
                        if (neighborX >= 0 && neighborX < width) nearOutline[neighborY * width + neighborX] = 1;
                    }
                }
            }
            const toVisit = [];
            for (let index = 0; index < cellCount; index++) {
                if (!enclosed[index] && !outline[index] && !nearOutline[index]) { outside[index] = 1; toVisit.push(index); }
            }
            while (toVisit.length) {
                const index = toVisit.pop();
                const y = Math.floor(index / width), x = index - y * width;
                for (const [neighborX, neighborY] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
                    if (neighborX >= 0 && neighborX < width && neighborY >= 0 && neighborY < height) {
                        const neighbor = neighborY * width + neighborX;
                        if (!outside[neighbor] && !outline[neighbor]) { outside[neighbor] = 1; toVisit.push(neighbor); }
                    }
                }
            }

            // 4. paint everything that is not outside (subject to the fill pattern)
            for (let row = Math.max(firstRow, 0); row < Math.min(firstRow + height, screenHeight); row++) {
                const rowBase = (row - firstRow) * width;
                for (let column = Math.max(firstColumn, 0); column < Math.min(firstColumn + width, screenWidth); column++) {
                    if (outside[rowBase + column - firstColumn]) continue;
                    if (pattern && !patternCovers(pattern, pel, maskSize, mask,
                        (column + 0.5) / this.columnsPerUnit, (row + 0.5) / this.rowsPerUnit)) continue;
                    this.surface.cells[row * screenWidth + column] = ink;
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

        /** The character cell size in whole raster cells, or null if it is empty. */
        characterCellSize(prim) {
            const size = this.sizeToCells(prim.size);
            if (Math.abs(size[0]) < 1e-9 || Math.abs(size[1]) < 1e-9) return null;
            return [Math.max(1, roundHalfEven(Math.abs(size[0]))), Math.max(1, roundHalfEven(Math.abs(size[1])))];
        }

        /** Scale a bitmap (rows of bits, MSB = left) into the character cell, honouring rotation and reverse. */
        depositCells(prim, isLit, ink, background) {
            const cellSize = this.characterCellSize(prim);
            if (!cellSize) return;
            const [columns, rows] = cellSize, origin = this.toCells(prim.origin);
            const columnDirection = prim.size[0] < 0 ? -1.0 : 1.0, rowDirection = prim.size[1] < 0 ? -1.0 : 1.0;
            const anchorColumn = Math.floor(origin[0] + CELL_EPSILON), anchorRow = Math.floor(origin[1] + CELL_EPSILON);
            const unlitPen = prim.reverse ? ink : background;
            if (unlitPen !== null && unlitPen !== undefined && prim.rotation === 0) {
                const size = this.sizeToCells(prim.size);
                const left = Math.min(origin[0], origin[0] + size[0]), bottom = Math.min(origin[1], origin[1] + size[1]);
                const endColumn = Math.floor(left + Math.abs(size[0]) + CELL_EPSILON), endRow = Math.floor(bottom + Math.abs(size[1]) + CELL_EPSILON);
                for (let row = Math.floor(bottom + CELL_EPSILON); row < endRow; row++) {
                    for (let column = Math.floor(left + CELL_EPSILON); column < endColumn; column++) this.surface.put(column, row, unlitPen);
                }
            }
            for (let row = 0; row < rows; row++) {
                for (let column = 0; column < columns; column++) {
                    const lit = isLit(column, row, columns, rows);
                    const pen = prim.reverse ? (lit ? background : ink) : (lit ? ink : background);
                    if (pen === null || pen === undefined) continue;
                    let placedColumn = column, placedRow = rows - 1 - row;
                    if (prim.rotation === 1) [placedColumn, placedRow] = [-placedRow + rows - 1, placedColumn];
                    else if (prim.rotation === 2) [placedColumn, placedRow] = [columns - 1 - placedColumn, rows - 1 - placedRow];
                    else if (prim.rotation === 3) [placedColumn, placedRow] = [placedRow, columns - 1 - placedColumn];
                    const screenColumn = anchorColumn + columnDirection * placedColumn + (columnDirection < 0 ? -1 : 0);
                    const screenRow = anchorRow + rowDirection * placedRow + (rowDirection < 0 ? -1 : 0);
                    this.surface.put(screenColumn, screenRow, pen);
                }
            }
        }

        depositBitmap(prim, bitmapRows, bitmapWidth, bitmapHeight, ink, background) {
            this.depositCells(prim, (column, row, columns, rows) => {
                const sourceRow = Math.min(Math.max(Math.floor(bitmapHeight * row / rows), 0), bitmapHeight - 1);
                const sourceColumn = Math.min(Math.max(Math.floor(bitmapWidth * column / columns), 0), bitmapWidth - 1);
                return (bitmapRows[sourceRow] >> (bitmapWidth - 1 - sourceColumn)) & 1;
            }, ink, background);
        }

        depositDecoderCharacter(prim, codePoint, ink, background) {
            const cellSize = this.characterCellSize(prim);
            if (!cellSize) return true;
            const choice = chooseDecoderFace(this.decoderFont, codePoint, cellSize[0], cellSize[1]);
            if (!choice) return false;
            const { face, rows: glyph, scaleX, scaleY } = choice;
            const top = Math.ceil((cellSize[1] - face.h * scaleY) / 2);
            this.depositCells(prim, (column, row) => {
                const faceColumn = Math.floor(column / scaleX), faceRow = Math.floor((row - top) / scaleY);
                if (faceColumn < 0 || faceColumn >= face.w || faceRow < 0 || faceRow >= face.h) return 0;
                return (glyph[faceRow] >> (face.w - 1 - faceColumn)) & 1;
            }, ink, background);
            return true;
        }

        isUnitSquare() { return Math.abs(this.rowsPerUnit - this.surface.h) < 1e-9; }

        depositCharacter(prim, drcs, ink, background) {
            if (prim.rep === 'M') {                                   // mosaic: 2 × 3 block elements
                const code = prim.char;
                const sixBits = (code & 0x20 || code === 0x5F) ? ((code & 0x1F) | ((code >> 1) & 0x20)) : 0;
                const size = this.sizeToCells(prim.size), origin = this.toCells(prim.origin);
                const left = Math.min(origin[0], origin[0] + size[0]), bottom = Math.min(origin[1], origin[1] + size[1]);
                const width = Math.abs(size[0]), height = Math.abs(size[1]);
                if (width < 1e-9 || height < 1e-9) return;
                const pelSize = this.sizeToCells(prim.pel);
                const gapX = prim.underlined ? Math.abs(pelSize[0]) : 0.0, gapY = prim.underlined ? Math.abs(pelSize[1]) : 0.0;
                const elementWidth = width / 2.0, elementHeight = height / 3.0;
                if (background !== null) this.fillRectCells(left, bottom, width, height, background);
                for (let element = 0; element < 6; element++) {
                    if (!(sixBits & (1 << element))) continue;
                    const elementColumn = element % 2, rowFromTop = Math.floor(element / 2);
                    this.fillRectCells(left + elementColumn * elementWidth, bottom + (2 - rowFromTop) * elementHeight,
                        Math.max(0.0, elementWidth - gapX), Math.max(0.0, elementHeight - gapY),
                        (prim.reverse && background !== null) ? background : ink);
                }
                return;
            }
            if (prim.rep === 'D') {                                   // dynamically redefined character
                const glyph = drcs ? drcs.get(prim.char) : null;
                if (!glyph) return;
                const glyphWidth = Math.min(glyph.w, 8), rows = new Array(glyph.h).fill(0);
                for (let row = 0; row < glyph.h; row++) {
                    let bits = 0;
                    for (let column = 0; column < Math.min(glyph.w, 8); column++) {
                        if (glyph.el[row * glyph.w + column]) bits |= 1 << (glyph.w - 1 - column);
                    }
                    rows[glyph.h - 1 - row] = glyph.w > glyphWidth ? bits >> (glyph.w - glyphWidth) : bits;
                }
                this.depositBitmap(prim, rows, glyphWidth, glyph.h, ink, background);
                return;
            }
            let codePoint = prim.rep === 'P' ? prim.char : FONT.SUPPLEMENTARY.charCodeAt(prim.char - 0x20);
            if (prim.rep === 'P' && !(codePoint >= 0x20 && codePoint < 0x7F)) codePoint = 0x20;
            if (this.decoderFont && this.depositDecoderCharacter(prim, codePoint, ink, background)) return;
            const cellSize = this.characterCellSize(prim);
            if (!cellSize) return;
            const face = chooseFace(!this.isUnitSquare() ? this.surface.w : 256, cellSize[0], cellSize[1]);
            let rows = glyphRows(face, codePoint) || lineGlyph(codePoint, face[1], face[2]);
            for (const candidate of glyphCandidates(codePoint)) {
                if (rows) break;
                rows = glyphRows(face, candidate);
            }
            this.depositBitmap(prim, rows || new Array(face[2]).fill(0), face[1], face[2], ink, background);
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
        const kind = prim.kind;
        if (kind === 'point') {
            if (prim.points.length) rasteriser.stamp(prim.points[0], prim.pel, ink);
        } else if (kind === 'line') {
            rasteriser.stroke(prim.points, prim.pel, prim.line_tex, ink, false);
        } else if (kind === 'arc' || kind === 'rect' || kind === 'poly') {
            let outline;
            if (kind === 'arc') outline = arcToPolyline(prim.points, 0.2 / rasteriser.columnsPerUnit);
            else if (kind === 'rect') {
                const [originX, originY] = prim.origin, farX = originX + prim.size[0], farY = originY + prim.size[1];
                outline = [prim.origin, [farX, originY], [farX, farY], [originX, farY]];
            } else outline = prim.points;
            if (!prim.filled) { rasteriser.stroke(outline, prim.pel, prim.line_tex, ink, kind === 'rect'); return; }
            const mask = (prim.pattern >= 4 && page) ? page.masks[prim.pattern - 4] : null;
            rasteriser.fill(outline, prim.pel, definition ? 0 : prim.pattern, prim.mask_size, mask, ink);
            if (prim.highlighted && !definition) {
                const highlight = background !== null ? background : pen(['c', BLACK]);
                rasteriser.stroke(outline, prim.pel, 0, highlight, kind !== 'arc');
            }
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
            const events = this.events, options = { pen: (ink) => this.pen(ink) };
            let changed = false;
            while (this.nextEvent < events.length && (time === null || time === undefined || events[this.nextEvent][1] <= time)) {
                const [type, , payload] = events[this.nextEvent++];
                changed = true;
                if (type === 'p') drawPrimitive(this.rasteriser, payload, this.page, options);
                else if (type === 'clear') this._newSurface();
                else if (type === 'map') this.map = payload;
                else if (type === 'blink') this.blink = payload;
            }
            if (changed) this.generation++;
            return changed;
        }

        done() { return this.nextEvent >= this.events.length; }

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
                    if (phase >= 0 && (phase % (0.1 * (onTenths + offTenths))) >= 0.1 * onTenths) {
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
                    if (phase >= 0 && (phase % (0.1 * (onTenths + offTenths))) >= 0.1 * onTenths) {
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
            const palette = this.palette(time), { gw: width, gh: height } = this, cells = this.surf.cells;
            for (let row = 0; row < height; row++) {
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
    const catalogStream = (bytes, packetCount, lowNibbleFirst, catalog, onProgress) => {
        const messages = [];
        const recordAssembler = new RecordAssembler((message) => messages.push(message));
        const groupAssembler = new GroupAssembler((group) => recordAssembler.add(group), false, lowNibbleFirst);
        for (let i = 0; i < packetCount; i++) {
            groupAssembler.add(decodePacket(bytes.subarray(i * PACKET_SIZE, (i + 1) * PACKET_SIZE)));
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
        let catalog = new Catalog();
        let { groupAssembler, recordAssembler } = catalogStream(bytes, packetCount, lowNibbleFirst, catalog, onProgress);
        const editionChanges = catalog.findEditionChanges();
        if (editionChanges.size) {
            catalog = new Catalog(editionChanges);
            ({ groupAssembler, recordAssembler } = catalogStream(bytes, packetCount, lowNibbleFirst, catalog, onProgress));
        }
        const [folded, dropped, kept] = catalog.reconcile();
        const records = catalog.records();
        return {
            records,
            summary: {
                packets: packetCount, header_nibble_order: lowNibbleFirst ? 'low first' : 'high first',
                groups: groupAssembler.stats, records: recordAssembler.stats,
                foreign: recordAssembler.foreign, identities_folded: folded, identities_dropped: dropped,
                identities_kept: kept, pages_updated: editionChanges.size, cataloged: records.length
            }
        };
    };

    /** Interpret every presentation record into a page (like nabts_interpret_records). */
    const interpret = (records, grid = [256, 200], { font = null } = {}) => {
        const interpreter = new Interpreter(grid, { font }), supportRecords = new Map(), latestByAddress = new Map();
        for (const record of records) {
            if (!isPresentation(record.type)) continue;
            if (record.flags.support_record) supportRecords.set(record.channel, record);
            latestByAddress.set(`${record.channel},${record.address}`, record);
        }
        // "More" chains: which page continues which (explicit extension, or the +1 rule)
        const predecessor = new Map();
        for (const record of latestByAddress.values()) {
            let successor = record.more_address;
            if (successor === null || successor === undefined) {
                if (!record.flags.more) continue;
                successor = nextPageAddress(record.address);
                if (successor === null) continue;
            }
            if (successor === record.address) continue;
            predecessor.set(`${record.channel},${successor}`, record);
        }
        for (const record of records) {
            record.page = null;
            record.chain_base = record.address;
            record.chain_pos = 0;
            record.text = '';
            if (!isPresentation(record.type) || !record.data?.length) continue;
            let earlierPages = [], address = record.address, isRing = false;
            const visited = new Set([record.address]);
            while (predecessor.has(`${record.channel},${address}`)) {
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
                interpreter.run(supportRecords.get(record.channel).data);
            }
            if (isCaption) interpreter.applyCaptionState();
            let keepDisplay = false;
            for (const page of earlierPages) { interpreter.run(page.data, keepDisplay); keepDisplay = true; }
            record.page = interpreter.run(record.data, keepDisplay);
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
        readT33, interpret, Player, Interpreter, pageText,
        decoderFonts: () => loadDecoderFonts(), recordLabel, recordName, flagsText,
        addressText, isPresentation, rgb: colorToRgb, DEFAULT_MAP, DISPLAY_H: DISPLAY_HEIGHT,
        GRIDS: { '256 × 200 (receiver)': [256, 200], '512 × 400': [512, 400], '768 × 600': [768, 600] },
        _internal: { decodePacket, Catalog, Surface, Rasteriser, drawPrimitive, arcPolyline: arcToPolyline }
    };
});