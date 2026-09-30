"use strict";

// Packet length of T42 files is 42
const T42_PACKET_LENGTH = 42;

// Rows 0-24
const T42_DISPLAY_ROWS = 25;

// 40 columns
const T42_COLUMNS = 40;

// This includes the page number, subcode, and control bits
const HEADER_CONTROL_BYTES = 8;

// A "time filling" header
const FILLER_PAGE_NUMBER = 0xff;

// The 16 valid Hamming 8/4 code bytes, indexed by the 4-bit value they carry
const HAMMING_8_4_CODES = [
    0x15, 0x02, 0x49, 0x5e, 0x64, 0x73, 0x38, 0x2f,
    0xd0, 0xc7, 0x8c, 0x9b, 0xa1, 0xb6, 0xfd, 0xea
];

// Lookup table for every possible received byte: the 4-bit value, or -1 if the byte has two or more bit errors and can't be corrected
const HAMMING_8_4_DECODE = (() => {
    const table = new Int8Array(256).fill(-1);
    HAMMING_8_4_CODES.forEach((codeByte, value) => {
        table[codeByte] = value;
        for (let bitIndex = 0; bitIndex < 8; bitIndex++) {

            // If there is a single-bit error, this is correctable
            table[codeByte ^ (1 << bitIndex)] = value;
        }
    });
    return table;
})();

const decodeHamming84 = byteValue => HAMMING_8_4_DECODE[byteValue];


// & Count how many 1 bits are in a byte
function hasOddParity(byteValue) {
    let setBitCount = 0;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) setBitCount += (byteValue >> bitIndex) & 1;
    return setBitCount % 2 === 1;
}

// & Reads the magazine (1–8) and row number (0–31) from a packet's first two bytes
function decodePacketAddress(packet) {

    // First two bytes identify the packet
    const lowNibble = decodeHamming84(packet[0]);
    const highNibble = decodeHamming84(packet[1]);

    // If either can't be decoded, don't return anything; packet is too unreadable
    if (lowNibble < 0 || highNibble < 0) return null;

    // Extract the lower three bits
    const magazineBits = lowNibble & 0x07;
    return {

        // Magazine 0 becomes Magazine 8
        magazine: magazineBits === 0 ? 8 : magazineBits,

        // Construct row number from bits spread across the low and high nibbles
        rowNumber: (lowNibble >> 3) | (highNibble << 1)
    };
}

// & Reads the page number, subcode and control bits (C4–C14) from a header packet; this only applies to the first row (row 0)
function decodePageHeader(packet) {
    const nibbles = [];

    // Read the 8 Hamming nibbles
    for (let index = 2; index < 2 + HEADER_CONTROL_BYTES; index++) {
        const value = decodeHamming84(packet[index]);

        // If the value is less than 0, the header is too damaged to trust it; don't return a value
        if (value < 0) return null;
        nibbles.push(value);
    }

    // There are 8 header control bytes (packets 2-9); assign them from the "nibbles" array
    const [pageUnits, pageTens, subcode1, subcode2, subcode3, subcode4, controlBits7to10, controlBits11to14] = nibbles;

    // Combine pieces from 4 nibbles into a larger subcode
    const subcode = subcode1 | ((subcode2 & 0x07) << 4) | (subcode3 << 8) | ((subcode4 & 0x03) << 12);

    const flags = [];
    if (subcode2 & 0x08) flags.push(4);                                      // ^ C4  (erase page)
    if (subcode4 & 0x04) flags.push(5);                                      // ^ C5  (newsflash)
    if (subcode4 & 0x08) flags.push(6);                                      // ^ C6  (subtitle, if any)
    for (let bitIndex = 0; bitIndex < 4; bitIndex++) {
        if (controlBits7to10 & (1 << bitIndex)) flags.push(7 + bitIndex);    // ^ C7–C10
        if (controlBits11to14 & (1 << bitIndex)) flags.push(11 + bitIndex);  // ^ C11–C14
    }

    // Combine two b-bit nummbes to form the page number, assign the subcode, flags, and whether serial mode is enabled
    return {
        pageNumber: (pageTens << 4) | pageUnits,
        subcode,
        flags,
        isSerialMode: (controlBits11to14 & 0x01) !== 0                       // ^ C11: Any magazines sent one after another
    };
}

// & Columns in a packet's display bytes that failed the odd-parity check, e.g. [4, 17]. A single flipped bit will always breaks parity, so these are the characters not to trust
function parityErrorColumns(packet, firstIndex, firstColumn) {
    const columns = [];

    // If a byte fails, record the column number and don't correct the character
    for (let index = firstIndex; index < T42_PACKET_LENGTH; index++) {
        if (!hasOddParity(packet[index])) columns.push(firstColumn + index - firstIndex);
    }
    return columns;
}

// Remove the parity bits. Bytes that fail the parity check are kept as they are since the comparison view is where someone decides which page version is right
const displayBytesFrom = (packet, firstIndex) =>
    Array.from(packet.subarray(firstIndex, 2 + T42_COLUMNS), byteValue => byteValue & 0x7f);

// ! Main decoder function
function decodeT42(fileBytes) {
    const pagesByKey = new Map();              // ^ "110/0001" = { number, subcode, versions }
    const openVersionByMagazine = new Map();   // ^ magazine = page version currently being received
    const stats = { packets: 0, damagedAddresses: 0, damagedHeaders: 0, parityErrors: 0 };

    // Keep track of the page currently being received for each magazine
    const closeAllOpenVersions = () => openVersionByMagazine.clear();

    // Process the packets 42 bits at a time
    for (let offset = 0; offset + T42_PACKET_LENGTH <= fileBytes.length; offset += T42_PACKET_LENGTH) {
        const packet = fileBytes.subarray(offset, offset + T42_PACKET_LENGTH);
        stats.packets++;

        // Decode the address
        const address = decodePacketAddress(packet);

        // If damaged, discard the packet
        if (!address) {
            stats.damagedAddresses++;
            continue;
        }

        const { magazine, rowNumber } = address;

        // If row = 0, meaning a new page header, decode it
        if (rowNumber === 0) {
            const header = decodePageHeader(packet);

            // If the decode fails, close the current page transmission for that magazine and don't attach next rows to the wrong page
            if (!header) {
                stats.damagedHeaders++;
                openVersionByMagazine.delete(magazine);
                continue;
            }

            // In serial mode, a header from any magazine ends the page being sent
            if (header.isSerialMode) closeAllOpenVersions();
            else openVersionByMagazine.delete(magazine);

            // Ignore filler pages
            if (header.pageNumber === FILLER_PAGE_NUMBER) continue;

            const pageNumber = magazine.toString() + header.pageNumber.toString(16).toUpperCase().padStart(2, "0");

            // Create page version and put the header's display content into row0
            const rows = Array(T42_DISPLAY_ROWS).fill(null);
            rows[0] = Array(HEADER_CONTROL_BYTES).fill(0x20).concat(displayBytesFrom(packet, 2 + HEADER_CONTROL_BYTES));

            // Create array for all 25 rows
            const parityErrors = Array(T42_DISPLAY_ROWS).fill(null);

            // Check actual display-character portion of packet in row 0 for parity errors. Record positions using 0-39 column numbering
            parityErrors[0] = parityErrorColumns(packet, 2 + HEADER_CONTROL_BYTES, HEADER_CONTROL_BYTES);

            // Create object for each page version
            const version = {
                subcode: header.subcode.toString(16).toUpperCase().padStart(4, "0"),
                flags: header.flags,
                rows,
                parityErrors,
                receivedAt: stats.packets   // packet number of its header, so transmissions can be put back in broadcast order
            };
            const pageKey = `${pageNumber}/${version.subcode}`;
            if (!pagesByKey.has(pageKey)) {
                pagesByKey.set(pageKey, { number: pageNumber, subcode: version.subcode, versions: [] });
            }
            pagesByKey.get(pageKey).versions.push(version);
            openVersionByMagazine.set(magazine, version);
            continue;
        }

        // Rows 25–31 carry non-display data (links, enhancements); skip them for now
        if (rowNumber >= T42_DISPLAY_ROWS) continue;

        // The page the row belongs to
        const version = openVersionByMagazine.get(magazine);

        // Continue if a row arrived without a trusted header
        if (!version) continue;

        // Check the 40 display bytes starting at packet 2; report columns that have bad parity
        const badColumns = parityErrorColumns(packet, 2, 0);

        // Get how many characters failed
        stats.parityErrors += badColumns.length;

        // Record damaged rows
        version.parityErrors[rowNumber] = badColumns;

        // Store the 7-bit character values
        version.rows[rowNumber] = displayBytesFrom(packet, 2);
    }

    // Drop versions that only ever received a header because they add nothing to compare
    // * Map pages, remove pages with no useable versions, and sort by page number and subcode
    const pages = [...pagesByKey.values()]
        .map(page => ({ ...page, versions: page.versions.filter(version => version.rows.slice(1).some(Boolean)) }))
        .filter(page => page.versions.length > 0)
        .sort((firstPage, secondPage) =>
            firstPage.number.localeCompare(secondPage.number) || firstPage.subcode.localeCompare(secondPage.subcode));

    return { pages, stats };
}