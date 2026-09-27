"use strict";


// Setting the page geometry
const COLUMN_COUNT = 40;

// Row 0 is the header, while rows 1-24 consists of page content
const ROW_COUNT = 25;
const CELL_WIDTH = 12;
const CELL_HEIGHT = 20;
const PAGE_WIDTH = COLUMN_COUNT * CELL_WIDTH;
const PAGE_HEIGHT = ROW_COUNT * CELL_HEIGHT;

// Header columns 0-7 do not carry any display text; the viewer only shows the page number
const HEADER_CONTROL_COLUMNS = 8;

// NOTE: Double height text does not have an effect on rows 0, 23, and 24
const LAST_DOUBLE_HEIGHT_ROW = 22;

const VIEWER_FONT_FAMILY = '"Bedstead Regular", monospace';

// This asks the browser to load the font
const VIEWER_FONT = `${CELL_HEIGHT}px ${VIEWER_FONT_FAMILY}`;

// Size and baseline that keep every glyph inside its cell. fitViewerFontToCell() measures the
// real font and replaces these; the starting values suit a typical monospace font.
const viewerFont = {
    size: CELL_HEIGHT - 4,
    baseline: CELL_HEIGHT - 5,
    css: `${CELL_HEIGHT - 4}px ${VIEWER_FONT_FAMILY}`
};

const SPACE = 0x20;
const SEVEN_BIT_MASK = 0x7f;

// Standard control codes
const ControlCode = {
    ALPHA_BLACK: 0x00,
    ALPHA_RED: 0x01,
    ALPHA_GREEN: 0x02,
    ALPHA_YELLOW: 0x03,
    ALPHA_BLUE: 0x04,
    ALPHA_MAGENTA: 0x05,
    ALPHA_CYAN: 0x06,
    ALPHA_WHITE: 0x07,
    FLASH: 0x08,
    STEADY: 0x09,
    END_BOX: 0x0a,
    START_BOX: 0x0b,
    NORMAL_SIZE: 0x0c,
    DOUBLE_HEIGHT: 0x0d,
    MOSAIC_BLACK: 0x10,
    MOSAIC_RED: 0x11,
    MOSAIC_GREEN: 0x12,
    MOSAIC_YELLOW: 0x13,
    MOSAIC_BLUE: 0x14,
    MOSAIC_MAGENTA: 0x15,
    MOSAIC_CYAN: 0x16,
    MOSAIC_WHITE: 0x17,
    CONCEAL: 0x18,
    CONTIGUOUS_MOSAIC: 0x19,
    SEPARATED_MOSAIC: 0x1a,
    BLACK_BACKGROUND: 0x1c,
    NEW_BACKGROUND: 0x1d,
    HOLD_MOSAICS: 0x1e,
    RELEASE_MOSAICS: 0x1f
};

const WHITE = 7;
const BLACK = 0;

// WST color palette (black, red, green, yellow, blue, magenta, cyan, white)
const PALETTE = ["#000", "#f00", "#0f0", "#ff0", "#00f", "#f0f", "#0ff", "#fff"];

// English national option subset (C12-C14 = 000), used by every U.S. WST service
const ENGLISH_CHARACTER_SUBS = {
    0x23: "£",
    0x5b: "←",
    0x5c: "½",
    0x5d: "→",
    0x5e: "↑",
    0x5f: "#",
    0x60: "—",
    0x7b: "¼",
    0x7c: "‖",
    0x7d: "¾",
    0x7e: "÷",
    0x7f: "■"
};

const isControlCode = byteValue => byteValue < SPACE;
const isAlphaColorCode = byteValue => byteValue >= ControlCode.ALPHA_BLACK && byteValue <= ControlCode.ALPHA_WHITE;
const isMosaicColorCode = byteValue => byteValue >= ControlCode.MOSAIC_BLACK && byteValue <= ControlCode.MOSAIC_WHITE;

// In mosaic mode, 0x40-0x5F still show as letters ("blast-through"), while everything else is a 2×3 block shape
const isMosaicShape = byteValue => byteValue < 0x40 || byteValue >= 0x60;

const characterForByte = byteValue => ENGLISH_CHARACTER_SUBS[byteValue] ?? String.fromCharCode(byteValue);

// Level 1 decoders ignore 0x00 and 0x10 (Level 2.5 made them black). In recovered captures they are
// almost always bit errors, e.g. a "0" (0x30) that lost a bit, so Level 1 keeps rows readable.
const colorCodeApplies = (byteValue, level25Black) =>
    level25Black || (byteValue !== ControlCode.ALPHA_BLACK && byteValue !== ControlCode.MOSAIC_BLACK);


// & Draws a 2×3 block-mosaic character. Each block is one bit. heightScale 2 = double height.
function drawMosaicCharacter(context, left, top, byteValue, color, isSeparated, heightScale = 1) {
    const blockHeights = [6, 7, 7].map(height => height * heightScale);
    const blockWidth = CELL_WIDTH / 2;
    const gapX = isSeparated ? 2 : 0;
    const gapY = isSeparated ? 2 * heightScale : 0;

    /*
    * 0x01: top-left       0x02: top-right
    * 0x04: middle-left    0x08: middle-right
    * 0x10: bottom-left    0x40: bottom-right
    */
    const blockBits = [0x01, 0x02, 0x04, 0x08, 0x10, 0x40];

    context.fillStyle = color;

    let blockTop = top;
    for (let blockRow = 0; blockRow < 3; blockRow++) {
        for (let blockColumn = 0; blockColumn < 2; blockColumn++) {
            if (byteValue & blockBits[blockRow * 2 + blockColumn]) {
                context.fillRect(
                    left + blockColumn * blockWidth + gapX / 2,
                    blockTop + gapY / 2,
                    blockWidth - gapX,
                    blockHeights[blockRow] - gapY
                );
            }
        }
        blockTop += blockHeights[blockRow];
    }
}


// & Draws the foreground of one cell (letter or mosaic) without touching the background
function drawGlyph(context, left, top, byteValue, foregroundColor, isMosaic, isSeparated, heightScale = 1) {
    if (byteValue === SPACE || isControlCode(byteValue)) return;

    if (isMosaic && isMosaicShape(byteValue)) {
        drawMosaicCharacter(context, left, top, byteValue, PALETTE[foregroundColor], isSeparated, heightScale);
        return;
    }

    context.fillStyle = PALETTE[foregroundColor];
    const character = characterForByte(byteValue);

    if (heightScale === 1) {
        context.fillText(character, left + CELL_WIDTH / 2, top + viewerFont.baseline);
        return;
    }

    // For double height characters, stretch the glyph vertically from the top of the cell
    context.save();
    context.translate(left + CELL_WIDTH / 2, top);
    context.scale(1, heightScale);
    context.fillText(character, 0, viewerFont.baseline);
    context.restore();
}


// & Measure the viewer font and pick the largest size where every glyph fits inside one cell
function fitViewerFontToCell() {
    const context = document.createElement("canvas").getContext("2d");
    if (!context?.measureText) return;

    const MEASURE_SIZE = 100;
    context.font = `${MEASURE_SIZE}px ${VIEWER_FONT_FAMILY}`;
    const sampleCharacters = "HbdfhklAÉ|[]gjpqy£½¾■#@W";

    let ascent = 0;
    let descent = 0;
    let widest = 0;
    for (const character of sampleCharacters) {
        const metrics = context.measureText(character);
        if (!metrics) return;
        ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || 0);
        descent = Math.max(descent, metrics.actualBoundingBoxDescent || 0);
        widest = Math.max(widest, metrics.width || 0);
    }
    if (!ascent || !widest) return;

    const size = Math.floor(MEASURE_SIZE * Math.min(CELL_HEIGHT / (ascent + descent), CELL_WIDTH / widest));
    const glyphHeight = (ascent + descent) * size / MEASURE_SIZE;
    const topGap = (CELL_HEIGHT - glyphHeight) / 2;

    viewerFont.size = size;
    viewerFont.baseline = Math.round(topGap + ascent * size / MEASURE_SIZE);
    viewerFont.css = `${size}px ${VIEWER_FONT_FAMILY}`;
}

function prepareCanvasContext(canvas) {
    const context = canvas.getContext("2d");
    context.font = viewerFont.css;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    return context;
}

// & Does this row switch on double height, in a row where double height is allowed?
function rowUsesDoubleHeight(rowBytes, rowNumber) {
    if (!rowBytes || rowNumber < 1 || rowNumber > LAST_DOUBLE_HEIGHT_ROW) return false;
    return rowBytes.some(byteValue => (byteValue & SEVEN_BIT_MASK) === ControlCode.DOUBLE_HEIGHT);
}


/*
 * & Draw one row with full Level 1 attribute handling.
 *
 * options:
 *   rowNumber        decides whether double height is allowed on this row
 *   flashOn          false during the "off" half of the flash cycle
 *   level25Black     true treats 0x00 / 0x10 as alpha / mosaic black (see colorCodeApplies)
 *   boxedOnly        newsflash / subtitle pages (C5 / C6): only boxed cells are shown
 *   outsideBoxColor  what to paint outside the boxes when boxedOnly is on
 *
 * Returns { spansTwoRows }: true when the row used double height, so the row below is covered.
 */
function drawRow(context, rowBytes, top, revealConcealed = false, options = {}) {
    const {
        rowNumber = 0,
        flashOn = true,
        level25Black = false,
        boxedOnly = false,
        outsideBoxColor = "#000"
    } = options;

    const spansTwoRows = rowUsesDoubleHeight(rowBytes, rowNumber);
    const backgroundHeight = spansTwoRows ? CELL_HEIGHT * 2 : CELL_HEIGHT;

    // Every row starts with Level 1 defaults
    let foregroundColor = WHITE;
    let backgroundColor = BLACK;
    let isMosaic = false;
    let isSeparated = false;
    let isConcealed = false;
    let isFlashing = false;
    let isDoubleHeight = false;
    let isBoxed = false;
    let isHoldingMosaics = false;

    // This is the most recent mosaic character, which is shown in place of control codes while holding
    let heldByte = SPACE;
    let heldSeparated = false;

    for (let column = 0; column < COLUMN_COUNT; column++) {
        const byteValue = rowBytes[column] & SEVEN_BIT_MASK;
        const left = column * CELL_WIDTH;
        const isControl = isControlCode(byteValue);

        // Set-at codes: change this cell
        if (isControl) {
            switch (byteValue) {
                case ControlCode.STEADY: isFlashing = false; break;
                case ControlCode.NORMAL_SIZE:
                    if (isDoubleHeight) { isDoubleHeight = false; heldByte = SPACE; }
                    break;
                case ControlCode.CONCEAL: isConcealed = true; break;
                case ControlCode.CONTIGUOUS_MOSAIC: isSeparated = false; break;
                case ControlCode.SEPARATED_MOSAIC: isSeparated = true; break;
                case ControlCode.BLACK_BACKGROUND: backgroundColor = BLACK; break;
                case ControlCode.NEW_BACKGROUND: backgroundColor = foregroundColor; break;
                case ControlCode.HOLD_MOSAICS: isHoldingMosaics = true; break;
            }
        }

        // Work out what this cell shows
        let glyphByte = byteValue;
        let glyphIsMosaic = isMosaic;
        let glyphIsSeparated = isSeparated;

        if (isControl) {
            if (isHoldingMosaics && isMosaic) {
                glyphByte = heldByte;
                glyphIsMosaic = true;
                glyphIsSeparated = heldSeparated;
            } else {
                glyphByte = SPACE;
            }
        } else if (isMosaic && isMosaicShape(byteValue)) {
            heldByte = byteValue;
            heldSeparated = isSeparated;
        }

        if ((isConcealed && !revealConcealed) || (isFlashing && !flashOn)) glyphByte = SPACE;

        // Paint the cell
        if (boxedOnly && !isBoxed) {
            context.fillStyle = outsideBoxColor;
            context.fillRect(left, top, CELL_WIDTH, backgroundHeight);
        } else {
            context.fillStyle = PALETTE[backgroundColor];
            context.fillRect(left, top, CELL_WIDTH, backgroundHeight);
            drawGlyph(context, left, top, glyphByte, foregroundColor, glyphIsMosaic, glyphIsSeparated, isDoubleHeight ? 2 : 1);
        }

        if (!isControl) continue;

        // Set-after codes: take effect from the next cell
        if (isAlphaColorCode(byteValue)) {
            if (colorCodeApplies(byteValue, level25Black)) {

                // Leaving mosaic mode resets the held character
                if (isMosaic) heldByte = SPACE;
                foregroundColor = byteValue;
                isMosaic = false;
                isConcealed = false;
            }
        } else if (isMosaicColorCode(byteValue)) {
            if (colorCodeApplies(byteValue, level25Black)) {

                // Entering mosaic mode resets the held character
                if (!isMosaic) heldByte = SPACE;
                foregroundColor = byteValue - ControlCode.MOSAIC_BLACK;
                isMosaic = true;
                isConcealed = false;
            }
        } else {
            switch (byteValue) {
                case ControlCode.FLASH: isFlashing = true; break;
                case ControlCode.START_BOX: isBoxed = true; break;
                case ControlCode.END_BOX: isBoxed = false; break;
                case ControlCode.DOUBLE_HEIGHT:
                    if (spansTwoRows && !isDoubleHeight) { isDoubleHeight = true; heldByte = SPACE; }
                    break;
                case ControlCode.RELEASE_MOSAICS: isHoldingMosaics = false; break;
            }
        }
    }

    return { spansTwoRows };
}

//   Draw a whole page onto the canvas
function drawPage(canvas, pageRows, options = {}) {
    const {
        revealConcealed = false,
        flashOn = true,
        level25Black = false,
        boxedOnly = false,
        outsideBoxColor = "#000",
        hideHeader = false,
        hideBody = false,
        scale = 1
    } = options;

    canvas.width = PAGE_WIDTH * scale;
    canvas.height = PAGE_HEIGHT * scale;
    const context = prepareCanvasContext(canvas);
    context.scale(scale, scale);

    context.fillStyle = "#000";
    context.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
    if (boxedOnly) {
        context.fillStyle = outsideBoxColor;
        context.fillRect(0, CELL_HEIGHT, PAGE_WIDTH, PAGE_HEIGHT - CELL_HEIGHT);
    }

    // This is true when the row above was double height
    let rowIsCovered = false;

    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        const rowBytes = pageRows[rowNumber];

        if (rowIsCovered) {
            rowIsCovered = false;
            continue;
        }

        const isHidden = (rowNumber === 0 && hideHeader) || (rowNumber > 0 && hideBody);
        if (isHidden || !rowBytes) continue;

        const { spansTwoRows } = drawRow(context, rowBytes, rowNumber * CELL_HEIGHT, revealConcealed, {
            rowNumber,
            flashOn,
            level25Black,
            boxedOnly: boxedOnly && rowNumber > 0,
            outsideBoxColor
        });
        rowIsCovered = spansTwoRows;
    }
}



// & Plain text of a row. Control codes and mosaic shapes become spaces, so screen readers don't read block graphics out as punctuation. Concealed text stays hidden unless revealed.
function rowToPlainText(rowBytes, { revealConcealed = false, level25Black = false } = {}) {
    let isMosaic = false;
    let isConcealed = false;
    let text = "";

    for (const byte of rowBytes) {
        const byteValue = byte & SEVEN_BIT_MASK;

        if (isControlCode(byteValue)) {
            text += " ";
            if (byteValue === ControlCode.CONCEAL) isConcealed = true;
            else if ((isAlphaColorCode(byteValue) || isMosaicColorCode(byteValue)) && colorCodeApplies(byteValue, level25Black)) {
                isMosaic = isMosaicColorCode(byteValue);
                isConcealed = false;
            }
            continue;
        }

        if (isConcealed && !revealConcealed) text += " ";
        else text += isMosaic && isMosaicShape(byteValue) ? " " : characterForByte(byteValue);
    }

    return text;
}


// & The text a viewer can see on the page: header text, then each visible row that has any text. Rows covered by double height are skipped, just as they are on screen.
function pageToText(pageRows, options = {}) {
    const lines = [];
    let rowIsCovered = false;

    pageRows.forEach((rowBytes, rowNumber) => {
        if (rowIsCovered) {
            rowIsCovered = false;
            return;
        }
        if (!rowBytes) return;

        const visibleBytes = rowNumber === 0 ? rowBytes.slice(HEADER_CONTROL_COLUMNS) : rowBytes;
        const text = rowToPlainText(visibleBytes, options);
        rowIsCovered = rowUsesDoubleHeight(rowBytes, rowNumber);

        if (text.trim()) lines.push(rowNumber === 0 ? text.trim() : text.trimEnd());
    });

    return lines.join("\n");
}