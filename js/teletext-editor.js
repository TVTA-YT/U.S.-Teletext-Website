"use strict";

const CaptureDecoder = {
    async loadFile(name, bytes) {
        if (name.endsWith(".json")) {
            const data = JSON.parse(new TextDecoder().decode(bytes));

            // If the input file is a session JSON, restore the user's saved work
            if (data.format === SESSION_FORMAT) return { session: data };
            return data;
        }

        if (name.endsWith(".t42")) {
            return decodeT42(bytes);
        }

        throw new Error("Unsupported file type. Choose a T42 or JSON file.")
    }
};

/*
* 40 columns since we're converting T34 to T42
* 25 rows total
* Character width is 12
* Character height is 20
*/
const COLUMN_COUNT = 40
const ROW_COUNT = 25
const CELL_WIDTH = 12
const CELL_HEIGHT = 20;

const VIEWER_FONT_FAMILY = '"Bedstead Regular", monospace';

// Ask the browser to load the font
const VIEWER_FONT = `${CELL_HEIGHT}px ${VIEWER_FONT_FAMILY}`;

// This sets the size and baseline that keeps every glyph inside its cell
const viewerFont = {
    size: CELL_HEIGHT - 4,

    // Pixels fron the top of the cell to the text baseline
    baseline: CELL_HEIGHT - 5,

    css: `${CELL_HEIGHT - 4}px ${VIEWER_FONT_FAMILY}`
};


// Various codes
const SPACE = 0x20;
const FIRST_PRINTABLE_BYTE = 0x20;
const LAST_BYTE = 0x7f;
const PARITY_BYTE = 0x80;
const SEVEN_BIT_MASK = 0x7f;

// Control codes
const ControlCode = {
    ALPHA_BLACK: 0x00,
    ALPHA_RED: 0x01,
    ALPHA_GREEN: 0x02,
    ALPHA_YELLOW: 0x03,
    ALPHA_BLUE: 0x04,
    ALPHA_MAGENTA: 0x05,
    ALPHA_CYAN: 0x06,
    ALPHA_WHITE: 0x07,
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
const COLOR_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

// Special characters
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

const HIGHLIGHT_ROW_MISSING_FROM_FINAL = "#20c997";

// Row-number gutter drawn down the left of the two viewers

// ^ The teletext page itself, in canvas pixels
const PAGE_WIDTH = COLUMN_COUNT * CELL_WIDTH;

const ROW_NUMBER_GUTTER_WIDTH = 22;
const ROW_NUMBER_FONT = "11px monospace";
const ROW_NUMBER_COLOR = "#8a8a8a";
const ROW_NUMBER_CURRENT_COLOR = "#ffffff";

const HIGHLIGHT_ROW_DIFFERS_FROM_FINAL = "#ffc107";

const isControlCode = byteValue => byteValue < FIRST_PRINTABLE_BYTE;
const isAlphaColorCode = byteValue => byteValue >= ControlCode.ALPHA_BLACK && byteValue <= ControlCode.ALPHA_WHITE;
const isMosaicColorCode = byteValue => byteValue >= ControlCode.MOSAIC_BLACK && byteValue <= ControlCode.MOSAIC_WHITE;

const isMosaicShape = byteValue => byteValue < 0x40 || byteValue >= 0x60;

const characterForByte = byteValue => ENGLISH_CHARACTER_SUBS[byteValue] ?? String.fromCharCode(byteValue);


// & Draws 2x3 block-mosaic character. Each block is 1 bit
function drawMosaicCharacter(context, left, top, byteValue, color, isSeparated) {
    const blockHeights = [6, 7, 7];
    const blockWidth = CELL_WIDTH / 2;
    const separationGap = isSeparated ? 2 : 0;

    /*
    * 0x01: top-left
    * 0x02: top-right
    * 0x04: middle-left
    * 0x08: middle-right
    * 0x10: bottom-left
    * 0x40: bottom-right
    */
    const blockBits = [0x01, 0x02, 0x04, 0x08, 0x10, 0x40];

    context.fillStyle = color;

    let blockTop = top;
    for (let blockRow = 0; blockRow < 3; blockRow++) {
        for (let blockColumn = 0; blockColumn < 2; blockColumn++) {
            const bit = blockBits[blockRow * 2 + blockColumn];
            if (byteValue & bit) {
                context.fillRect(
                    left + blockColumn * blockWidth + separationGap / 2,
                    blockTop + separationGap / 2,
                    blockWidth - separationGap,
                    blockHeights[blockRow] - separationGap
                );
            }
        }
        blockTop += blockHeights[blockRow];
    }
}


// & Draw the cell
function drawCell(context, left, top, byteValue, foregroundColor, backgroundColor, isMosaic, isSeparated) {
    context.fillStyle = PALETTE[backgroundColor];
    context.fillRect(left, top, CELL_WIDTH, CELL_HEIGHT);

    if (isControlCode(byteValue)) return;

    if (isMosaic && isMosaicShape(byteValue)) {
        drawMosaicCharacter(context, left, top, byteValue, PALETTE[foregroundColor], isSeparated);
        return;
    }

    context.fillStyle = PALETTE[foregroundColor];
    context.fillText(characterForByte(byteValue), left + CELL_WIDTH / 2, top + viewerFont.baseline);
}

// & Measure the viewer font and pick the largest size where the tallest ascender and the deepest descender (g, j, p, q, y) both fit inside one cell, and no glyph is wider than a cell
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

        // Measuring is not supported, so keep the starting values
        if (!metrics) return;
        ascent = Math.max(ascent, metrics.actualBoundingBoxAscent || 0);
        descent = Math.max(descent, metrics.actualBoundingBoxDescent || 0);
        widest = Math.max(widest, metrics.width || 0);
    }

    // Again, measuring not supported, keep starting values
    if (!ascent || !widest) return;

    const scaleForHeight = CELL_HEIGHT / (ascent + descent);
    const scaleForWidth = CELL_WIDTH / widest;
    const size = Math.floor(MEASURE_SIZE * Math.min(scaleForHeight, scaleForWidth));

    // Center the glyph box vertically in the cell, then place the baseline under its ascent
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

function drawRow(context, rowBytes, top, revealConcealed) {
    let foregroundColor = WHITE;
    let backgroundColor = BLACK;
    let isMosaic = false;
    let isSeparated = false;
    let isConcealed = false;

    // Hold Graphics (1E): while it's on, a control-code cell shows the last block graphic instead of a blank block
    // * Services use it to change color or background mid-shape without a gap
    let isHoldingMosaics = false;
    let heldByte = SPACE;
    let heldSeparated = false;

    for (let column = 0; column < COLUMN_COUNT; column++) {
        const byteValue = rowBytes[column] & SEVEN_BIT_MASK;
        const left = column * CELL_WIDTH;

        if (isControlCode(byteValue)) {
            // Set-at codes take effect in this cell
            if (byteValue === ControlCode.NEW_BACKGROUND) backgroundColor = foregroundColor;
            else if (byteValue === ControlCode.BLACK_BACKGROUND) backgroundColor = BLACK;
            else if (byteValue === ControlCode.HOLD_MOSAICS) isHoldingMosaics = true;

            if (isHoldingMosaics && isMosaic) {
                drawCell(context, left, top, heldByte, foregroundColor, backgroundColor, true, heldSeparated);
            } else {
                drawCell(context, left, top, SPACE, foregroundColor, backgroundColor, false, false);
            }

            // Set-after codes take effect from the next cell. Switching between text and graphics forgets the held block
            if (isAlphaColorCode(byteValue)) {
                if (isMosaic) heldByte = SPACE;
                foregroundColor = byteValue;
                isMosaic = false;
                isConcealed = false;
            } else if (isMosaicColorCode(byteValue)) {
                if (!isMosaic) heldByte = SPACE;
                foregroundColor = byteValue - ControlCode.MOSAIC_BLACK;
                isMosaic = true;
                isConcealed = false;
            } else if (byteValue === ControlCode.CONCEAL) {
                isConcealed = true;
            } else if (byteValue === ControlCode.CONTIGUOUS_MOSAIC) {
                isSeparated = false;
            } else if (byteValue === ControlCode.SEPARATED_MOSAIC) {
                isSeparated = true;
            } else if (byteValue === ControlCode.RELEASE_MOSAICS) {
                isHoldingMosaics = false;
            }
            continue;
        }

        // Remember the last block graphic for Hold Graphics
        if (isMosaic && isMosaicShape(byteValue)) {
            heldByte = byteValue;
            heldSeparated = isSeparated;
        }

        const byteToDraw = isConcealed && !revealConcealed ? SPACE : byteValue;

        drawCell(context, left, top, byteToDraw, foregroundColor, backgroundColor, isMosaic, isSeparated);
    }
}

// & Numbers 0–24 down the gutter; the current row's number is brighter
function drawRowNumbers(context, currentRow) {
    context.save();
    context.font = ROW_NUMBER_FONT;
    context.textAlign = "right";
    context.textBaseline = "middle";
    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        context.fillStyle = rowNumber === currentRow ? ROW_NUMBER_CURRENT_COLOR : ROW_NUMBER_COLOR;
        context.fillText(String(rowNumber), ROW_NUMBER_GUTTER_WIDTH - 5, rowNumber * CELL_HEIGHT + CELL_HEIGHT / 2);
    }
    context.restore();
}

function drawPage(canvas, pageRows, options = {}) {
    const {
        highlightMissingRows = true,
        revealConcealed = false,
        cursor = null,
        rowOutlines = {},
        selection = null,
        pastePreview = null,
        showRowNumbers = false,
        scale = 1  // 2 draws everything twice the size (e.g. for PNG export)
    } = options;

    const gutterWidth = showRowNumbers ? ROW_NUMBER_GUTTER_WIDTH : 0;
    const drawingWidth = gutterWidth + PAGE_WIDTH;
    const drawingHeight = ROW_COUNT * CELL_HEIGHT;
    canvas.width = drawingWidth * scale;
    canvas.height = drawingHeight * scale;
    const context = prepareCanvasContext(canvas);

    // Everything below is drawn at the page size and is sharply scaled up
    context.scale(scale, scale);
    context.fillStyle = "#000";
    context.fillRect(0, 0, drawingWidth, drawingHeight);

    if (showRowNumbers) {
        drawRowNumbers(context, cursor?.row ?? selection?.endRow ?? null);

        // Everything below is drawn in page coordinates
        context.translate(gutterWidth, 0);
    }

    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        const rowBytes = pageRows[rowNumber];
        const top = rowNumber * CELL_HEIGHT

        if (!rowBytes) {
            if (highlightMissingRows) {
                context.fillStyle = "rgba(220, 53, 69, .35)";
                context.fillRect(0, top, PAGE_WIDTH, CELL_HEIGHT);
            }
            continue;
        }

        drawRow(context, rowBytes, top, revealConcealed);

        if (rowOutlines[rowNumber]) {
            context.strokeStyle = rowOutlines[rowNumber];
            context.lineWidth = 2;
            context.strokeRect(1, top + 1, PAGE_WIDTH - 2, CELL_HEIGHT - 2);
        }
    }

    if (selection) {
        const bounds = getSelectionBounds(selection);
        const left = bounds.left * CELL_WIDTH;
        const top = bounds.top * CELL_HEIGHT;
        const width = (bounds.right - bounds.left + 1) * CELL_WIDTH;
        const height = (bounds.bottom - bounds.top + 1) * CELL_HEIGHT;
        context.fillStyle = "rgba(13, 110, 253, .35)";
        context.fillRect(left, top, width, height);
        context.strokeStyle = "#6ea8fe";
        context.lineWidth = 2;
        context.strokeRect(left + 1, top + 1, width - 2, height - 2);
    }

    if (pastePreview) {
        const visibleWidth = Math.min(pastePreview.width, COLUMN_COUNT - pastePreview.column);
        const visibleHeight = Math.min(pastePreview.height, ROW_COUNT - pastePreview.row);
        context.save();
        context.setLineDash([4, 3]);
        context.strokeStyle = HIGHLIGHT_ROW_MISSING_FROM_FINAL;
        context.lineWidth = 2;
        context.strokeRect(pastePreview.column * CELL_WIDTH + 1, pastePreview.row * CELL_HEIGHT + 1, visibleWidth * CELL_WIDTH - 2, visibleHeight * CELL_HEIGHT - 2);
        context.restore();
    }

    if (cursor) {
        context.strokeStyle = "#fff";
        context.lineWidth = 2;
        context.strokeRect(cursor.column * CELL_WIDTH + 1, cursor.row * CELL_HEIGHT + 1, CELL_WIDTH - 2, CELL_HEIGHT - 2);
    }
}

const rowToPlainText = rowBytes => rowBytes.map(byteValue => {
    const sevenBitValue = byteValue & SEVEN_BIT_MASK;
    return isControlCode(sevenBitValue) ? " " : characterForByte(sevenBitValue);
}).join("");


function pageToScreenReaderText(pageRows) {
    return pageRows.map((rowBytes, rowNumber) =>
        rowBytes ? `Row ${rowNumber}: ${rowToPlainText(rowBytes).trimEnd()}` : `Row ${rowNumber}: not received`).join("\n");
}

const editorState = {
    decodedPages: [],
    groupedPages: [],                    // * decodedPages with subpages that share a subcode separated by content
    sortedPages: [],                     // * groupedPages before any transmissions were separated by hand
    separatedTransmissions: new Set(),   // * receivedAt of each transmission made its own subpage by hand
    pages: [],
    selectedPageIndex: -1,
    comparedVersionIndex: 0,
    finalPageRows: [],
    cursor: { column: 0, row: 0 },
    selection: null,
    finalSelection: null,                // * Characters selected on the final page to copy to another page
    lastSelected: "compared",            // * Which view the latest selection was made in, "compared" or "final"
    clipboard: null,
    showPastePreview: false,             // * Dashed outline of where a paste would land, which is shown after copying and hidden after pasting
    undoHistory: [],
    removedPageKeys: new Set(),
    removalSteps: [],                    // * Each removal's keys, newest last, so they can be restored one step at a time. Also logs entries removed from the list (pages to not be exported)
    checkedPageKeys: new Set(),          // * Entries ticked in the page list for "Remove checked"
    lastCheckedIndex: null,              // * For shift-click range selection
    editedPageRows: new Map(),           // * Entry key: its final final page that's kept when switching pages
    sourceFileName: "",
    hasUnsavedChanges: false             // * Set by any change, cleared by "Save Work" or opening a file
};

// Limit undo steps to 200
const MAX_UNDO_STEPS = 200;

const getElement = id => document.getElementById(id);

// Page elements
const elements = {
    statusBar: getElement("status"),
    fileInput: getElement("fileInput"),
    pageList: getElement("pageList"),
    pageFilter: getElement("pageFilter"),
    finalCanvas: getElement("finalCanvas"),
    finalText: getElement("finalText"),
    comparedCanvas: getElement("compareCanvas"),
    comparedText: getElement("compareText"),
    comparedCaption: getElement("compareCaption"),
    versionStrip: getElement("versionStrip"),
    comparisonTableBody: getElement("diffBody"),
    clipboardSummary: getElement("clipInfo"),
    cursorColumn: getElement("curX"),
    cursorRow: getElement("curY"),
    cursorHexInput: getElement("curHex"),
    cursorHexWithParity: getElement("curParity"),
    pageNumberInput: getElement("pageNum"),
    subcodeInput: getElement("subcode"),
    characterMap: getElement("charMap"),
    colorCodes: getElement("colorCodes"),
    highlightMissingOptions: getElement("optMissing"),
    revealOption: getElement("optReveal"),
    splitOption: getElement("optSplit"),
    groupOption: getElement("optGroup"),
    removeCheckedButton: getElement("removeCheckedButton"),
};

const getDisplayOptions = () => ({
    highlightMissingRows: elements.highlightMissingOptions.checked,
    revealConcealed: elements.revealOption.checked
});

const getSelectedPage = () => editorState.pages[editorState.selectedPageIndex];
const getComparedVersion = () => getSelectedPage().versions[editorState.comparedVersionIndex];
const getComparedRows = () => getComparedVersion().rows;
const comparedVersionLabel = () => `version ${editorState.comparedVersionIndex + 1}`;

const announceStatus = message => { elements.statusBar.textContent = message };

// When comparing, 2 rolls will match when all 40 bytes match
const rowsMatch = (firstRow, secondRow) => firstRow.join(",") === secondRow.join(",");

const clampColumn = column => Math.max(0, Math.min(COLUMN_COUNT - 1, column));
const clampRow = row => Math.max(0, Math.min(ROW_COUNT - 1, row));


const getSelectionBounds = selection => ({
    left: Math.min(selection.anchorColumn, selection.endColumn),
    top: Math.min(selection.anchorRow, selection.endRow),
    right: Math.max(selection.anchorColumn, selection.endColumn),
    bottom: Math.max(selection.anchorRow, selection.endRow)
});

const singleCellSelection = (column, row) => ({
    anchorColumn: column,
    anchorRow: row,
    endColumn: column,
    endRow: row
})


// & Create snapshot of current page before making a change so that the change can be undone if requested
function saveUndoStep() {
    editorState.undoHistory.push(editorState.finalPageRows.map(rowBytes => rowBytes ? rowBytes.slice() : null));
    if (editorState.undoHistory.length > MAX_UNDO_STEPS) editorState.undoHistory.shift();

    // Every change will start here, so the current page will be "edited"
    rememberEdits();
}


// & Keep this entry's final page, so switching away and back doesn't lose the edits
function rememberEdits() {
    const page = getSelectedPage();
    if (page) editorState.editedPageRows.set(pageKey(page), editorState.finalPageRows);
    editorState.hasUnsavedChanges = true;
}


// & Undo previous change
function undoLastChange() {

    // If there is no change to undo
    if (editorState.undoHistory.length === 0) {
        announceStatus("Nothing to undo.");
        return;
    }

    editorState.finalPageRows = editorState.undoHistory.pop();
    rememberEdits();
    renderEverything();
    announceStatus("Undid previous change.")
}


// & Copy values from compared version into final version (the colors and graphics mode in effect at a column (e.g. { foreground: 3, background: 4, isMosaic: true, isSeparated: false })
// * NOTE: A byte such as 0x61 shows as "a" or as a block graphic depending on the control codes to its left in the row
function attributesBefore(rowBytes, column) {
    const attributes = { foreground: WHITE, background: BLACK, isMosaic: false, isSeparated: false };
    for (let index = 0; index < column; index++) {
        const byteValue = rowBytes[index] & SEVEN_BIT_MASK;
        if (isAlphaColorCode(byteValue)) {
            attributes.foreground = byteValue;
            attributes.isMosaic = false;
        } else if (isMosaicColorCode(byteValue)) {
            attributes.foreground = byteValue - ControlCode.MOSAIC_BLACK;
            attributes.isMosaic = true;
        } else if (byteValue === ControlCode.CONTIGUOUS_MOSAIC) {
            attributes.isSeparated = false;
        } else if (byteValue === ControlCode.SEPARATED_MOSAIC) {
            attributes.isSeparated = true;
        } else if (byteValue === ControlCode.NEW_BACKGROUND) {
            attributes.background = attributes.foreground;   // * New background takes the current foreground color
        } else if (byteValue === ControlCode.BLACK_BACKGROUND) {
            attributes.background = BLACK;
        }
    }
    return attributes;
}


// & Control codes that change a row from one set of attributes to another (e.g. [0x14, 0x1d, 0x13] for yellow mosaics on a blue background)
function codesToSwitch(fromAttributes, toAttributes) {
    const codes = [];
    const current = { ...fromAttributes };
    const colorCode = (color, isMosaic) => color + (isMosaic ? ControlCode.MOSAIC_BLACK : 0);

    if (toAttributes.background !== current.background) {
        if (toAttributes.background === BLACK) {
            codes.push(ControlCode.BLACK_BACKGROUND);
        } else {

            // "New Background" uses the foreground color, so switch to the background color first
            if (current.foreground !== toAttributes.background || current.isMosaic !== toAttributes.isMosaic) {
                codes.push(colorCode(toAttributes.background, toAttributes.isMosaic));
                current.foreground = toAttributes.background;
                current.isMosaic = toAttributes.isMosaic;
            }
            codes.push(ControlCode.NEW_BACKGROUND);
        }
    }
    if (toAttributes.isMosaic && toAttributes.isSeparated !== current.isSeparated) {
        codes.push(toAttributes.isSeparated ? ControlCode.SEPARATED_MOSAIC : ControlCode.CONTIGUOUS_MOSAIC);
    }
    if (toAttributes.foreground !== current.foreground || toAttributes.isMosaic !== current.isMosaic) {
        codes.push(colorCode(toAttributes.foreground, toAttributes.isMosaic));
    }
    return codes;
}


// & True if any byte would draw something (not a space or a control code)
const hasVisibleCharacters = rowBytes => rowBytes.some(byteValue => (byteValue & SEVEN_BIT_MASK) > SPACE);


// & After new bytes that end just before 'column', put the row back into the mode it had there before the change so the rest of the row keeps its original look
/*
* NOTE: The code is only written over a space.
* This Returns false if it was needed but there was no space for it
*/
function switchBackAfter(rowBytes, originalBytes, column) {
    if (column >= COLUMN_COUNT) return true;
    const codes = codesToSwitch(attributesBefore(rowBytes, column), attributesBefore(originalBytes, column));
    if (codes.length === 0) return true;

    const cells = rowBytes.slice(column, column + codes.length);
    if (cells.length !== codes.length || !cells.every(byteValue => byteValue === SPACE)) return false;
    codes.forEach((code, index) => { rowBytes[column + index] = code; });
    return true;
}


// & Copy the selection from whichever view it was last made in
function copyLatestSelection() {
    if (editorState.lastSelected === "final" && editorState.finalSelection) copyFinalSelection();
    else copySelection();
}


// & Copy characters selected on the final page. The clipboard stays filled when another page is selected
function copyFinalSelection() {
    if (!editorState.finalSelection) {
        announceStatus("Drag across the final page to select characters first.");
        return;
    }
    copyRegion(editorState.finalPageRows, editorState.finalSelection, `the final page of ${pageLabel(getSelectedPage())}`);
}


function copySelection() {
    if (!editorState.selection) {
        announceStatus("Select characters in the compared version first.")
        return;
    }
    copyRegion(getComparedRows(), editorState.selection, comparedVersionLabel());
}


// & Put a rectangle of characters on the editor's clipboard (and plain text on the system clipboard)
function copyRegion(sourceRows, selection, sourceLabel) {
    const bounds = getSelectionBounds(selection);
    const comparedRows = sourceRows;
    const copiedRows = [];

    // This is per row for color and mosaic mode at the selection's left edge
    const startAttributes = [];

    for (let rowNumber = bounds.top; rowNumber <= bounds.bottom; rowNumber++) {
        const rowBytes = comparedRows[rowNumber];
        copiedRows.push(rowBytes ? rowBytes.slice(bounds.left, bounds.right + 1) : null);
        startAttributes.push(rowBytes ? attributesBefore(rowBytes, bounds.left) : null);
    }

    editorState.clipboard = {
        sourceColumn: bounds.left,
        sourceRow: bounds.top,
        width: bounds.right - bounds.left + 1,
        height: bounds.bottom - bounds.top + 1,
        rows: copiedRows,
        startAttributes
    };

    // Put plain text version of page contents in clipboard
    const plainText = copiedRows.map(rowBytes => rowBytes ? rowToPlainText(rowBytes) : "").join("\n");
    navigator.clipboard?.writeText(plainText).catch(() => { });

    editorState.showPastePreview = true;
    renderClipboardSummary();
    renderPageViews();

    const { width, height } = editorState.clipboard;
    announceStatus(`Copied ${width} × ${height} characters from ${sourceLabel}, row ${bounds.top}, column ${bounds.left}. Select another page and paste.`);
}


// & Paste content copied to the clipboard
function pasteClipboard(targetColumn, targetRow) {
    const clipboard = editorState.clipboard;

    if (!clipboard) {
        announceStatus("Nothing copied yet.");
        return;
    }

    saveUndoStep();

    let pastedCount = 0;
    const rowsWithAddedCodes = [];
    const rowsWithoutRoom = [];

    clipboard.rows.forEach((copiedBytes, rowOffset) => {
        const destinationRow = targetRow + rowOffset;
        if (!copiedBytes || destinationRow >= ROW_COUNT) return;

        const destinationBytes = getOrCreateFinalRow(destinationRow);
        const originalBytes = destinationBytes.slice();
        copiedBytes.forEach((byteValue, columnOffset) => {
            const destinationColumn = targetColumn + columnOffset;

            if (destinationColumn < COLUMN_COUNT) {
                destinationBytes[destinationColumn] = byteValue;
                pastedCount++
            }
        });

        const wantedAttributes = clipboard.startAttributes?.[rowOffset];
        if (!wantedAttributes || !hasVisibleCharacters(copiedBytes)) return;

        // Before the paste: add the color or mosaic code the copied characters had to their left so block graphics stay block graphics
        // * A control code shows as a space
        const codesBefore = codesToSwitch(attributesBefore(destinationBytes, targetColumn), wantedAttributes);
        if (codesBefore.length) {
            const firstCodeColumn = targetColumn - codesBefore.length;
            if (firstCodeColumn < 0) {
                rowsWithoutRoom.push(destinationRow);
            } else {
                codesBefore.forEach((code, index) => { destinationBytes[firstCodeColumn + index] = code; });
                rowsWithAddedCodes.push(destinationRow);
            }
        }

        // After the paste: switch back so the rest of the row (and anything typed there later) looks the way it did
        switchBackAfter(destinationBytes, originalBytes, targetColumn + copiedBytes.length);
    });

    // The copy is still there for another pste job
    editorState.showPastePreview = false;
    renderEverything();
    let message = `Pasted: ${pastedCount} character${pastedCount === 1 ? "" : "s"} at row ${targetRow}, column ${targetColumn}.`;
    if (rowsWithAddedCodes.length) {
        message += ` Added color/mosaic codes just left of the paste on row(s) ${rowsWithAddedCodes.join(", ")} so it looks the same as the copy.`;
    }
    if (rowsWithoutRoom.length) {
        message += ` Row(s) ${rowsWithoutRoom.join(", ")} had no room for the color/mosaic codes before column ${targetColumn}; paste a few columns further right.`;
    }
    announceStatus(message);
}


// & If data from comparison page is pasted in the same position as the editing page
function pasteAtOriginalPosition() {
    if (editorState.clipboard) {
        pasteClipboard(editorState.clipboard.sourceColumn, editorState.clipboard.sourceRow);
    } else {
        announceStatus("Nothing copied yet.")
    }
}

const visibleCharacterCount = rowBytes => rowBytes.filter(byteValue => (byteValue & SEVEN_BIT_MASK) > SPACE).length;


// Two copies of a row count as the same text if no more than this share of their characters differ or no more than a couple of characters on short rows
const SAME_ROW_TEXT_LIMIT = 0.35;
const SAME_ROW_TEXT_ALLOWANCE = 2;

// & Skip parity failures and shared spaces if two copies of a row carry the same text, which also allows for errors
function isSameRowText(firstCopy, secondCopy) {
    let compared = 0;
    let different = 0;
    for (let column = 0; column < COLUMN_COUNT; column++) {
        if (firstCopy.badColumns.includes(column) || secondCopy.badColumns.includes(column)) continue;
        const firstByte = firstCopy.rowBytes[column] & SEVEN_BIT_MASK;
        const secondByte = secondCopy.rowBytes[column] & SEVEN_BIT_MASK;
        if (firstByte === SPACE && secondByte === SPACE) continue;
        compared++;
        if (firstByte !== secondByte) different++;
    }
    return different <= Math.max(SAME_ROW_TEXT_ALLOWANCE, compared * SAME_ROW_TEXT_LIMIT);
}


// & Build the final page from the versions, one row at a time
/*
* First, sort the copites of the row into families of the same text and keep the one with the mot copies.
* Next, inside that family, iterate each character and vote on it. Each chaeracter is whichever value most page copies agree on
* If a row only turns up a few transmissions, the row is dropped.
*/
const MIN_VERSIONS_TO_DROP_STRAY_ROWS = 4;

// Applies to the typical number of copies per row
const STRAY_ROW_SHARE = 0.4;

function buildFinalPageFromVersions(versions) {
    const copiesByRow = Array.from({ length: ROW_COUNT }, (_, rowNumber) => versions
        .filter(version => version.rows[rowNumber])
        .map(version => ({ rowBytes: version.rows[rowNumber], badColumns: version.parityErrors?.[rowNumber] ?? [] })));

    // Typical number of copies a real row has in these versions (median over the rows received at all)
    const rowCounts = copiesByRow.slice(1).map(copies => copies.length).filter(Boolean).sort((first, second) => first - second);
    const typicalCopies = rowCounts.length ? rowCounts[Math.floor(rowCounts.length / 2)] : 0;
    const dropStrayRows = versions.length >= MIN_VERSIONS_TO_DROP_STRAY_ROWS;

    return copiesByRow.map((copies, rowNumber) => {
        if (copies.length === 0) return null;

        const families = [];
        for (const copy of copies) {
            const family = families.find(candidate => isSameRowText(candidate[0], copy));
            if (family) family.push(copy);
            else families.push([copy]);
        }
        const winningFamily = families.reduce((best, family) =>
            family.length > best.length
                || (family.length === best.length && visibleCharacterCount(family[0].rowBytes) > visibleCharacterCount(best[0].rowBytes))
                ? family : best);

        if (dropStrayRows && rowNumber > 0 && winningFamily.length < typicalCopies * STRAY_ROW_SHARE) return null;

        return Array.from({ length: COLUMN_COUNT }, (_, column) => {
            const votes = new Map();   // byte → score
            for (const { rowBytes, badColumns } of winningFamily) {
                const byteValue = rowBytes[column] & SEVEN_BIT_MASK;
                const weight = badColumns.includes(column) ? 0.001 : 1;
                votes.set(byteValue, (votes.get(byteValue) ?? 0) + weight);
            }
            let winner = SPACE;
            let bestScore = -1;
            for (const [byteValue, score] of votes) {

                // On a tie, prefer a character over a space because text gets lost far more often than it appears
                if (score > bestScore || (score === bestScore && winner === SPACE && byteValue !== SPACE)) {
                    winner = byteValue;
                    bestScore = score;
                }
            }
            return winner;
        });
    });
}


// & This is needed because in bit 7, WST transmits each byte with odd parity
function addOddParityBit(byteValue) {
    const sevenBitValue = byteValue & SEVEN_BIT_MASK;
    let setBitCount = 0;
    for (let bitIndex = 0; bitIndex < 7; bitIndex++) setBitCount += (sevenBitValue >> bitIndex) & 1;
    return setBitCount % 2 === 0 ? sevenBitValue | PARITY_BYTE : sevenBitValue;
}

const toHexString = byteValue => byteValue.toString(16).toUpperCase().padStart(2, "0");

// & Label for page, subpage, or page transmission
function pageLabel(page) {
    let label = `P${page.number}`;
    if (page.subcode) label += `/${page.subcode}`;
    if (page.subpage) label += ` subpage ${page.subpage}`;
    if (page.transmission) label += ` #${page.transmission}`;
    return label;
}

// & How a subpage is named in the list: its subcode, or "Subpage 2" when it was separated by content
function subpageName(page) {
    if (!page.subpage) return page.subcode;
    const hasOwnSubcode = page.subcode && page.subcode !== "0000";
    return hasOwnSubcode ? `${page.subcode} · ${page.subpage}` : `Subpage ${page.subpage}`;
}

// & Safe file name for exports, e.g. "P129-0000-subpage-2" or "P199-0000-3"
const exportFileName = page => pageLabel(page).replace(/[\/ #]+/g, "-");

const subpageCount = page => editorState.pages.filter(otherPage => otherPage.number === page.number).length;


// & Text for an entry in the page list. Under a "P199 ..." heading, the page number is already shown, so the entry only needs its subcode or transmission. If also on its own, it needs the page number as well
function entryLabel(page, isUnderHeading) {
    if (isUnderHeading) return page.transmission ? `#${page.transmission}` : subpageName(page);
    return page.transmission ? `P${page.number} #${page.transmission}` : `P${page.number}`;
}


// & Render the interface
function renderPageList() {
    const filterText = elements.pageFilter.value.trim();
    elements.pageList.innerHTML = "";
    let previousNumber = null;

    editorState.pages.forEach((page, pageIndex) => {
        if (filterText && !page.number.startsWith(filterText)) return;

        const subpages = subpageCount(page);
        const isSubpage = subpages > 1;

        if (isSubpage && page.number !== previousNumber) {
            const heading = document.createElement("div");
            heading.className = "list-group-item small fw-semibold";
            heading.textContent = `P${page.number} · ${subpages} ${page.transmission ? "transmissions" : "subpages"}`;
            elements.pageList.append(heading);
        }

        previousNumber = page.number;

        const key = pageKey(page);
        const isSelected = pageIndex === editorState.selectedPageIndex;
        const versionCount = page.versions.length;
        const isEdited = editorState.editedPageRows.has(key);

        let spokenLabel = `Page ${page.number}`;
        if (page.transmission) spokenLabel += `, transmission ${page.transmission}${page.subpage ? `, subpage ${page.subpage}` : ""}`;
        else if (isSubpage) spokenLabel += `, ${page.subpage ? `subpage ${page.subpage}` : `subpage ${page.subcode}`}, ${versionCount} version${versionCount > 1 ? "s" : ""}`;
        else spokenLabel += `, ${versionCount} version${versionCount > 1 ? "s" : ""}`;
        if (isEdited) spokenLabel += ", edited";

        // For each row: a checkbox for removing several pages at once and a button that opens the page
        const listRow = document.createElement("div");
        listRow.className = "list-group-item d-flex align-items-center gap-2" + (isSelected ? " active" : "") + (isSubpage ? " ps-4" : "");

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "form-check-input m-0 flex-shrink-0";
        checkbox.checked = editorState.checkedPageKeys.has(key);
        checkbox.setAttribute("aria-label", `Select ${spokenLabel}`);
        checkbox.addEventListener("click", event => toggleChecked(pageIndex, checkbox.checked, event.shiftKey));

        const button = document.createElement("button");
        button.type = "button";
        button.className = "flex-grow-1 d-flex justify-content-between gap-2 border-0 bg-transparent p-0 text-reset text-start";
        button.setAttribute("aria-current", isSelected ? "true" : "false");
        button.setAttribute("aria-label", spokenLabel);
        button.innerHTML = `
        <span>${entryLabel(page, isSubpage)}</span>
        <span class="text-nowrap">${page.transmission ? (page.subpage ? `subpage ${page.subpage}` : `sub ${page.subcode}`) : `${versionCount} version${versionCount > 1 ? "s" : ""}`}${isEdited ? " · edited" : ""}</span>
        `;
        button.addEventListener("click", () => selectPage(pageIndex));

        listRow.append(checkbox, button);
        elements.pageList.append(listRow);
    });

    renderRemoveCheckedButton();
}


// & Tick or untick an entry. Shift-click ticks everything between it and the last one clicked
function toggleChecked(pageIndex, isChecked, extendRange) {
    const filterText = elements.pageFilter.value.trim();
    const isShown = page => !filterText || page.number.startsWith(filterText);

    let firstIndex = pageIndex;
    let lastIndex = pageIndex;
    if (extendRange && editorState.lastCheckedIndex !== null) {
        firstIndex = Math.min(pageIndex, editorState.lastCheckedIndex);
        lastIndex = Math.max(pageIndex, editorState.lastCheckedIndex);
    }

    for (let index = firstIndex; index <= lastIndex; index++) {
        const page = editorState.pages[index];

        // Don't tick pages hidden by the filter
        if (!isShown(page)) continue;
        if (isChecked) editorState.checkedPageKeys.add(pageKey(page));
        else editorState.checkedPageKeys.delete(pageKey(page));
    }

    editorState.lastCheckedIndex = pageIndex;
    renderPageList();
}


// & Show how many entries are ticked on the "Remove checked" button
function renderRemoveCheckedButton() {
    const button = elements.removeCheckedButton;
    if (!button) return;
    button.disabled = editorState.checkedPageKeys === 0;
    button.querySelector(".checked-count").textContent = editorState.checkedPageKeys.size;
}


// & Render version thumbnails
function renderVersionThumbnails() {
    elements.versionStrip.innerHTML = "";
    getSelectedPage().versions.forEach((version, versionIndex) => {
        const receivedRowCount = version.rows.filter(Boolean).length;
        const isFinalSource = versionIndex === getSelectedPage().baseVersionIndex;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "editor-version-thumbnails";
        button.setAttribute("aria-pressed", versionIndex === editorState.comparedVersionIndex);
        button.setAttribute("aria-label", `Version ${versionIndex + 1}, ${receivedRowCount} of ${ROW_COUNT} rows received${isFinalSource ? ", final page copied from this version" : ""}`);

        const thumbnail = document.createElement("canvas");
        drawPage(thumbnail, version.rows, getDisplayOptions());
        button.append(thumbnail);
        button.insertAdjacentHTML("beforeend",
            `<div class="small mt-1">v${versionIndex + 1} · ${receivedRowCount}/${ROW_COUNT} rows${isFinalSource ? " · final" : ""}</div>`
        );

        button.addEventListener("click", () => {
            editorState.comparedVersionIndex = versionIndex;
            renderEverything();
        });

        elements.versionStrip.append(button);
    });
}

// & List rows where the compared version could fill a gap or differs from final page
function renderRowComparisonTable() {
    const tableBody = elements.comparisonTableBody;
    tableBody.innerHTML = "";
    const comparedRows = getComparedRows();
    let listedRowCount = 0;

    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        const finalRow = editorState.finalPageRows[rowNumber];
        const comparedRow = comparedRows[rowNumber];
        if (!comparedRow) continue;

        const isMissingFromFinal = !finalRow;
        const differsFromFinal = finalRow && !rowsMatch(finalRow, comparedRow);
        if (!isMissingFromFinal && !differsFromFinal) continue;
        listedRowCount++;

        const tableRow = document.createElement("tr");
        tableRow.className = isMissingFromFinal ? "row-missing" : "row-differs";
        tableRow.innerHTML = `
        <th scope="row">${rowNumber}</th>
        <td>${isMissingFromFinal ? "Missing" : "Has a different row"}</td>
        <td>Received</td>
        <td class="text-end">
            <button class="btn btn-sm btn-outline-primary">Use this row</button>
        </td>
        `;

        tableRow.querySelector("button").addEventListener("click", () => {
            saveUndoStep();
            editorState.finalPageRows[rowNumber] = comparedRow.slice();
            announceStatus(`Row ${rowNumber} copied from ${comparedVersionLabel()}`);
            renderEverything();
        });

        tableBody.append(tableRow);
    }

    if (listedRowCount === 0) {
        tableBody.innerHTML = `
        <tr>
            <td colspan="4">Final page already has everything this version has.</td>
        </tr>
        `;
    }
}


// & Render the inspector
function renderInspector() {
    const comparedVersion = getComparedVersion();
    elements.pageNumberInput.value = getSelectedPage().number;
    elements.subcodeInput.value = comparedVersion.subcode ?? "";
    renderCursorDetails();
}


// & Render cursor details
function renderCursorDetails() {
    const { column, row } = editorState.cursor;
    const byteUnderCursor = editorState.finalPageRows[row]?.[column];
    elements.cursorColumn.textContent = column;
    elements.cursorRow.textContent = row;
    elements.cursorHexInput.value = byteUnderCursor === undefined ? "" : toHexString(byteUnderCursor & SEVEN_BIT_MASK);
    elements.cursorHexWithParity.textContent = byteUnderCursor === undefined ? "--" : toHexString(addOddParityBit(byteUnderCursor));
}


// & Render clipboard summary
function renderClipboardSummary() {
    const clipboard = editorState.clipboard;
    elements.clipboardSummary.textContent = clipboard
        ? `Clipboard: ${clipboard.width} × ${clipboard.height} from row ${clipboard.sourceRow}, column ${clipboard.sourceColumn}.`
        : `Drag across the compared version to select characters to copy.`;
}


// & Draw final page and compared version side by side
function renderPageViews() {
    const clipboard = editorState.clipboard;
    const pastePreview = clipboard && editorState.showPastePreview
        ? {
            column: editorState.cursor.column,
            row: editorState.cursor.row,
            width: clipboard.width,
            height: clipboard.height
        }
        : null;

    drawPage(elements.finalCanvas, editorState.finalPageRows, {
        ...getDisplayOptions(),
        cursor: editorState.cursor,
        selection: editorState.finalSelection,
        pastePreview,
        showRowNumbers: true
    });

    elements.finalText.textContent = pageToScreenReaderText(editorState.finalPageRows);

    const comparedRows = getComparedRows();
    const rowOutlines = [];

    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        const finalRow = editorState.finalPageRows[rowNumber];
        const comparedRow = comparedRows[rowNumber];
        if (!comparedRow) continue;
        if (!finalRow) rowOutlines[rowNumber] = HIGHLIGHT_ROW_MISSING_FROM_FINAL;
        else if (!rowsMatch(finalRow, comparedRow)) rowOutlines[rowNumber] = HIGHLIGHT_ROW_DIFFERS_FROM_FINAL;
    }


    drawPage(elements.comparedCanvas, comparedRows, {
        ...getDisplayOptions(),
        rowOutlines,
        selection: editorState.selection,
        showRowNumbers: true
    });

    elements.comparedText.textContent = pageToScreenReaderText(comparedRows);
    elements.comparedCaption.textContent = `Compared version: v${editorState.comparedVersionIndex + 1}`;
}


// & Render everything
function renderEverything() {
    if (editorState.selectedPageIndex < 0) return;
    renderPageList();
    renderPageViews();
    renderVersionThumbnails();
    renderRowComparisonTable();
    renderInspector();
}


// & Render character map
function renderCharacterMap() {
    const showMosaics = document.querySelector('input[name="cmSet"]:checked').value === "mosaic";
    elements.characterMap.innerHTML = "";

    for (let byteValue = FIRST_PRINTABLE_BYTE; byteValue <= LAST_BYTE; byteValue++) {
        const hexLabel = `0x${toHexString(byteValue)}`;
        const button = document.createElement("button");
        button.type = "button";
        button.title = hexLabel;
        button.setAttribute("aria-label", showMosaics ? `Mosaic ${hexLabel}` : `${characterForByte(byteValue)} (${hexLabel})`);

        const preview = document.createElement("canvas");
        preview.width = CELL_WIDTH;
        preview.height = CELL_HEIGHT;
        drawCell(prepareCanvasContext(preview), 0, 0, byteValue, WHITE, BLACK, showMosaics, false);
        button.append(preview);

        button.addEventListener("click", () => {
            writeByteAtCursor(byteValue);
            elements.finalCanvas.focus();
        });

        elements.characterMap.append(button);
    }
}


// & Buttons that put a color code at the cursor: text colors, mosaic colors and backgrounds
function renderColorCodeButtons() {
    if (!elements.colorCodes) return;
    elements.colorCodes.innerHTML = "";

    const addGroup = (label, choices) => {
        const group = document.createElement("div");
        group.className = "d-flex flex-wrap align-items-center gap-1 mb-2";
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", `${label} color codes`);

        const heading = document.createElement("span");
        heading.className = "small me-1 page-section-text";
        heading.style.minWidth = "6em";
        heading.textContent = label;
        group.append(heading);

        choices.forEach(({ code, name, content, style }) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-sm btn-outline-light p-0 border background-button";
            button.style.cssText = `min-width: 2rem; height: 2rem; border-radius: 0.25rem; ${style}; color: #fff`;
            button.innerHTML = content;
            button.title = `${name} (0x${toHexString(code)})`;
            button.setAttribute("aria-label", `Insert ${name} code, 0x${toHexString(code)}`);
            button.addEventListener("click", () => insertControlCode(code, name));
            group.append(button);
        });
        elements.colorCodes.append(group);
    };

    // Convert red to white because black isn't a text or mosaic color
    const colors = [1, 2, 3, 4, 5, 6, 7];
    addGroup("Text", colors.map(color => ({
        code: color,
        name: `${COLOR_NAMES[color]} text`,
        content: `<span aria-hidden="true" style="font-weight: bold">A</span>`,
        style: `background: #000; color: ${PALETTE[color]};`
    })));
    addGroup("Mosaics", colors.map(color => ({
        code: ControlCode.MOSAIC_BLACK + color,
        name: `${COLOR_NAMES[color]} mosaics`,
        content: "",
        style: `background: ${PALETTE[color]};`
    })));
    addGroup("Background", [
        { code: ControlCode.NEW_BACKGROUND, name: "new background (the color set just before it)", content: "New", style: "padding: 0 0.4rem !important;" },
        { code: ControlCode.BLACK_BACKGROUND, name: "black background", content: "Black", style: "padding: 0 0.4rem !important;" }
    ]);
}


// & Write a color code at the cursor. If writing over an existing code, it replaces it, which recolors what follows.
function insertControlCode(code, name) {
    if (editorState.selectedPageIndex < 0) return;
    const { column, row } = editorState.cursor;
    const replacedByte = (editorState.finalPageRows[row]?.[column] ?? SPACE) & SEVEN_BIT_MASK;
    writeByteAtCursor(code);

    let message = `Put the ${name} code at row ${row}, column ${column}. It shows as a space and applies to everything to its right, up to the next color code.`;
    if (replacedByte > SPACE) message += ` It replaced the "${characterForByte(replacedByte)}" that was previously in this position there; undo the change if you need it back.`;
    announceStatus(message);
    elements.finalCanvas.focus();
}


// & Unique key for a list entry, e.g. "199/0000/6" (transmission 6) or "199/0000/all"
// * Separated subpages use their subpageId (the order they were first seen in) which never changes, meaning edits in saved work stay attached even though the list shows them in counter order
const pageKey = page => {
    const subpageId = page.subpageId ?? page.subpage;
    return `${page.number}/${page.subcode ?? ""}${subpageId ? `~${subpageId}` : ""}/${page.transmission ?? "all"}`;
};


// & Build page list (split into transmissions or not), leaving out removed entries
function buildPageList() {
    const separateSubpages = elements.groupOption ? elements.groupOption.checked : true;
    const basePages = separateSubpages ? editorState.groupedPages : editorState.decodedPages;

    const allEntries = !elements.splitOption?.checked
        ? basePages
        : basePages.flatMap(page => {
            if (page.versions.length < 2) return [page];
            return page.versions.map((version, versionIndex) => ({
                ...page,

                // The transmission's place in the capture
                transmission: version.transmissionNumber ?? versionIndex + 1,
                baseVersionIndex: versionIndex
            }));
        });

    // Hide removed entries
    return allEntries.filter(page => !editorState.removedPageKeys.has(pageKey(page)));
}


// & The final page an entry starts with before any editing
function startingRowsFor(page) {
    if (page.baseVersionIndex !== undefined) {
        return page.versions[page.baseVersionIndex].rows.map(rowBytes => rowBytes ? rowBytes.slice() : null);
    }
    return buildFinalPageFromVersions(page.versions);
}


// & Remove several entries from the list at once. Their versions stay available for comparison. This returns how many were removed
function removeEntries(keysToRemove) {
    const currentKey = pageKey(getSelectedPage());
    const oldIndex = editorState.selectedPageIndex;
    const remainingCount = editorState.pages.filter(page => !keysToRemove.has(pageKey(page))).length;

    if (remainingCount === 0) {
        announceStatus("Can't remove every page in the list. One page must stay in the list.");
        return 0;
    }

    editorState.hasUnsavedChanges = true;
    keysToRemove.forEach(key => {
        editorState.removedPageKeys.add(key);
        editorState.checkedPageKeys.delete(key);
    });
    editorState.removalSteps.push([...keysToRemove]);
    editorState.lastCheckedIndex = null;
    editorState.pages = buildPageList();

    // Stay on the same entry if it's still there; otherwise the one now in its place
    const currentIndex = editorState.pages.findIndex(page => pageKey(page) === currentKey);
    selectPage(currentIndex >= 0 ? currentIndex : Math.min(oldIndex, editorState.pages.length - 1));
    return keysToRemove.size;
}


// & Remove the selected entry from the list
function removeSelectedPage() {
    const page = getSelectedPage();
    if (removeEntries(new Set([pageKey(page)]))) {
        announceStatus(`${pageLabel(page)} removed from the list and will not be exported. Its transmissions are still available to compare.`);
    }
}


// & Remove every ticked entry
function removeCheckedPages() {
    const removedCount = removeEntries(new Set(editorState.checkedPageKeys));
    if (removedCount) announceStatus(`Removed ${removedCount} checked page(s) from the list.`);
}


// & Check if 2 copies of a row agree
// * Characters that failed the parity check in either copy are ignored because a bit error always breaks parity. Every other character must match
function rowsAgree(firstRow, secondRow, firstBadColumns = [], secondBadColumns = []) {
    for (let column = 0; column < COLUMN_COUNT; column++) {
        if (firstBadColumns.includes(column) || secondBadColumns.includes(column)) continue;
        if ((firstRow[column] & SEVEN_BIT_MASK) !== (secondRow[column] & SEVEN_BIT_MASK)) return false;
    }
    return true;
}


// & Check if 2 transmissions look like the same subpage
// * Every row that both received (rows 1–24; row 0 carries the clock and other headers) must agree and at least one of those rows must have visible text
function looksLikeSameSubpage(firstVersion, secondVersion) {
    let agreeingTextRows = 0;
    for (let rowNumber = 1; rowNumber < ROW_COUNT; rowNumber++) {
        const firstRow = firstVersion.rows[rowNumber];
        const secondRow = secondVersion.rows[rowNumber];

        // If missing in one page copy, there's no evidence either way
        if (!firstRow || !secondRow) continue;

        const firstBad = firstVersion.parityErrors?.[rowNumber] ?? [];
        const secondBad = secondVersion.parityErrors?.[rowNumber] ?? [];
        if (!rowsAgree(firstRow, secondRow, firstBad, secondBad)) return false;
        if (visibleCharacterCount(firstRow) > 0) agreeingTextRows++;
    }
    return agreeingTextRows > 0;
}


// & Put back the pages taken out by the most recent removal (click again to go further back)
function restoreLastRemoval() {
    const lastStep = editorState.removalSteps.pop();
    if (!lastStep) {
        announceStatus("No removed pages to restore.");
        return;
    }
    lastStep.forEach(key => editorState.removedPageKeys.delete(key));
    editorState.hasUnsavedChanges = true;
    editorState.pages = buildPageList();

    // Show the first page that came back
    const restoredIndex = editorState.pages.findIndex(page => lastStep.includes(pageKey(page)));
    selectPage(Math.max(0, restoredIndex));

    const stepsLeft = editorState.removalSteps.length;
    announceStatus(`Restored ${lastStep.length} page(s) from the last removal.`
        + (stepsLeft ? ` ${stepsLeft} earlier removal(s) can still be restored.` : ""));
}


// & Put every removed entry back in the list
function restoreAllRemovedPages() {
    const restoredCount = editorState.removedPageKeys.size;
    if (restoredCount === 0) {
        announceStatus("No removed pages to restore.");
        return;
    }
    const currentKey = pageKey(getSelectedPage());
    editorState.removedPageKeys.clear();
    editorState.removalSteps = [];
    editorState.hasUnsavedChanges = true;
    editorState.pages = buildPageList();
    selectPage(Math.max(0, editorState.pages.findIndex(page => pageKey(page) === currentKey)));
    announceStatus(`Restored all ${restoredCount} removed page(s).`);
}


// & Compare two transmissions character by character over rows 1–24 that both received (row 0 has the clock), skipping characters that failed the parity check and places where both are spaces
// * This returns how many characters were compared and how many of them differ
function compareTransmissions(firstVersion, secondVersion) {
    let compared = 0;
    let different = 0;
    for (let rowNumber = 1; rowNumber < ROW_COUNT; rowNumber++) {
        const firstRow = firstVersion.rows[rowNumber];
        const secondRow = secondVersion.rows[rowNumber];
        if (!firstRow || !secondRow) continue;

        const firstBad = firstVersion.parityErrors?.[rowNumber] ?? [];
        const secondBad = secondVersion.parityErrors?.[rowNumber] ?? [];
        for (let column = 0; column < COLUMN_COUNT; column++) {
            if (firstBad.includes(column) || secondBad.includes(column)) continue;
            const firstByte = firstRow[column] & SEVEN_BIT_MASK;
            const secondByte = secondRow[column] & SEVEN_BIT_MASK;
            if (firstByte === SPACE && secondByte === SPACE) continue;
            compared++;
            if (firstByte !== secondByte) different++;
        }
    }
    return { compared, different };
}

// & The share of compared characters that differ (0 = identical, 1 = nothing alike), or null if the two transmissions have too little in common to judge (e.g., they received different rows)
const MIN_CHARACTERS_TO_COMPARE = 20;
function differenceRate(firstVersion, secondVersion) {
    const { compared, different } = compareTransmissions(firstVersion, secondVersion);
    return compared >= MIN_CHARACTERS_TO_COMPARE ? different / compared : null;
}


// Limits for sorting transmissions into subpages
// ^ For longer captures, the rest join the nearest subpage afterwards
const MAX_VERSIONS_TO_CLUSTER = 150;

// ^ Two transmissions that agree become a subpage. A page that matches nothing is usually a scrambled page
const MIN_SUBPAGE_SIZE = 2;

// ^ Never merge groups that differ by more than this amount, regarless of how noisy the data is
const MAX_MERGE_DIFFERENCE = 0.45;

// ^ Once voted, real subpages differ by more thatn this (noise levels under 0.2)
const DIFFERENT_SUBPAGE_LIMIT = 0.25;

// ^ Even on a clean capture, two copies of one page can differ by a stray character
// * Never merge less leniently than this or those copies stay apart and get filed under a different page
const MIN_MERGE_DIFFERENCE = 0.02;

// ^ A transmission that matches no subpage starts its own (Keyfax sends each subpage only about once a minute, so many are seen once or twice).
// * Unless the page's biggest subpage was seen at least 4 times as often: then it's a stray, such as another page with a damaged page number
const RARE_LEFTOVER_SHARE = 0.25;


// & Check if the page counters on subpages are different; if they do, these are not the same subpage
// * Counters with different totals (e.g. "4/4" and "1/2") don't count because that means one of them is damaged
function countersDiffer(firstRows, secondRows) {
    const firstCounter = readSubpageCounter(firstRows);
    const secondCounter = readSubpageCounter(secondRows);
    return Boolean(firstCounter && secondCounter
        && firstCounter.total === secondCounter.total && firstCounter.number !== secondCounter.number);
}

// True if a transmission received at least one display row (rows 1–24), not just a header
const hasDisplayRows = version => version.rows.slice(1).some(Boolean);

// & The subpage holding the transmission sent closest in time to this one
function nearestInBroadcastOrder(subpages, version) {
    let nearest = subpages[0];
    let nearestGap = Infinity;
    for (const group of subpages) {
        for (const other of group) {
            const gap = Math.abs((other.transmissionNumber ?? 0) - (version.transmissionNumber ?? 0));
            if (gap < nearestGap && hasDisplayRows(other)) {
                nearestGap = gap;
                nearest = group;
            }
        }
    }
    return nearest;
}


// & Sort a page's transmissions into subpages by how alike they are
/*
* Every transmission starts on its own. The two most alike groups keep merging until what's left differs by more than the capture's noise,
* Copies of one subpage differ only by errors, while different subpages differ in their actual text content.
*/
function groupVersionsBySubpage(versions) {
    const count = Math.min(versions.length, MAX_VERSIONS_TO_CLUSTER);
    if (count < 2) return [versions];

    // How different every pair is
    const differences = Array.from({ length: count }, () => Array(count).fill(null));
    for (let first = 0; first < count; first++) {
        for (let second = first + 1; second < count; second++) {
            differences[first][second] = differences[second][first] = differenceRate(versions[first], versions[second]);
        }
    }

    // The capture's noise level (how far each transmission is from its closest match (median over all pages))
    const closestDifferences = differences
        .map(row => Math.min(...row.filter(value => value !== null)))
        .filter(Number.isFinite)
        .sort((first, second) => first - second);
    if (closestDifferences.length === 0) return [versions];
    const noiseLevel = closestDifferences[Math.floor(closestDifferences.length / 2)];

    // Merge anything within a couple of times the noise level (a clean capture merges only exact matches)
    const mergeLimit = Math.min(MAX_MERGE_DIFFERENCE, Math.max(MIN_MERGE_DIFFERENCE, noiseLevel * 2.5 + 0.002));

    // The average difference between two groups over the pairs that could be compared
    const groupDifference = (firstGroup, secondGroup) => {
        let total = 0;
        let pairs = 0;
        for (const first of firstGroup) {
            for (const second of secondGroup) {
                if (differences[first][second] === null) continue;
                total += differences[first][second];
                pairs++;
            }
        }
        return pairs ? total / pairs : null;
    };

    // Keep merging the two most alike groups
    let groups = Array.from({ length: count }, (_, index) => [index]);
    while (groups.length > 1) {
        let best = null;
        for (let first = 0; first < groups.length; first++) {
            for (let second = first + 1; second < groups.length; second++) {
                const difference = groupDifference(groups[first], groups[second]);
                if (difference !== null && (!best || difference < best.difference)) best = { first, second, difference };
            }
        }
        if (!best || best.difference > mergeLimit) break;
        groups[best.first] = groups[best.first].concat(groups[best.second]);
        groups.splice(best.second, 1);
    }

    // Small leftover groups (such as damaged copies or rows from another page mixed in) join the nearest real subpage. Transmissions beyond the clustering limit do the same
    let subpages = groups.map(group => group.map(index => versions[index]));
    const leftovers = versions.slice(count);
    if (count >= MIN_SUBPAGE_SIZE * 2) {
        const large = subpages.filter(group => group.length >= MIN_SUBPAGE_SIZE);
        if (large.length > 0) {
            subpages.filter(group => group.length < MIN_SUBPAGE_SIZE).forEach(group => leftovers.push(...group));
            subpages = large;
        }
    }
    if (leftovers.length > 0) {
        const votedPages = subpages.map(group => ({ rows: buildFinalPageFromVersions(group) }));
        const largestSize = Math.max(...subpages.map(group => group.length));
        const leftoverSubpages = new Set();
        const withoutText = [];
        for (const version of leftovers) {
            let closestIndex = -1;
            let closestDifference = Infinity;
            let comparable = false;
            votedPages.forEach((votedPage, groupIndex) => {
                const difference = differenceRate(votedPage, version);
                if (difference === null) return;
                comparable = true;

                // Pages with different counts (e.g. "1/3" and "2/3") cannot be joined together
                if (countersDiffer(votedPage.rows, version.rows)) return;
                if (difference < closestDifference) {
                    closestDifference = difference;
                    closestIndex = groupIndex;
                }
            });

            // A damaged copy joins the subpage it's closest to
            // * One whose counter matches none of them is a page seen only once, so it keeps its own entry
            // * One with nothing to compare (such as a header with no rows) goes with the transmission next to it in broadcast order
            // * One that matches no subpage at all is a subpage seen only once or twice (Keyfax sends each one about once a minute), so it starts its own
            if (closestIndex >= 0 && closestDifference <= MAX_MERGE_DIFFERENCE) subpages[closestIndex].push(version);
            else if (comparable) {
                const group = [version];
                subpages.push(group);
                votedPages.push({ rows: version.rows });   // later leftovers can join it
                leftoverSubpages.add(group);
            }
            else withoutText.push(version);
        }
        withoutText.forEach(version => nearestInBroadcastOrder(subpages, version).push(version));

        // New subpages seen far less often than the biggest one are strays, so each of their transmissions joins the closest of the original subpages after all
        for (const group of leftoverSubpages) {
            if (group.length >= largestSize * RARE_LEFTOVER_SHARE) continue;
            const groupIndex = subpages.indexOf(group);
            subpages.splice(groupIndex, 1);
            votedPages.splice(groupIndex, 1);

            for (const version of group) {
                let closestIndex = 0;
                let closestDifference = Infinity;
                votedPages.forEach((votedPage, index) => {
                    if (leftoverSubpages.has(subpages[index])) return;
                    const difference = differenceRate(votedPage, version);
                    if (difference !== null && difference < closestDifference) {
                        closestDifference = difference;
                        closestIndex = index;
                    }
                });
                subpages[closestIndex].push(version);
            }
        }
    }

    // Subpages must actually have different text content.
    // * Noise, missing rows, or a lost last 8 columns can split one page into several groups that read the same once each is voted, so merge any that do
    const votedSubpages = subpages.map(group => ({ rows: buildFinalPageFromVersions(group) }));
    while (subpages.length > 1) {
        let closest = null;
        for (let first = 0; first < subpages.length; first++) {
            for (let second = first + 1; second < subpages.length; second++) {
                // * Groups with no rows in common (partial transmissions, as on P287) can't disagree, so they count as the same
                const difference = countersDiffer(votedSubpages[first].rows, votedSubpages[second].rows)
                    ? 1
                    : differenceRate(votedSubpages[first], votedSubpages[second]) ?? 0;
                if (!closest || difference < closest.difference) closest = { first, second, difference };
            }
        }
        if (closest.difference >= DIFFERENT_SUBPAGE_LIMIT) break;
        subpages[closest.first] = subpages[closest.first].concat(subpages[closest.second]);
        subpages.splice(closest.second, 1);
        votedSubpages[closest.first] = { rows: buildFinalPageFromVersions(subpages[closest.first]) };
        votedSubpages.splice(closest.second, 1);
    }

    // First-seen subpage first, and each subpage's transmissions in the order they were received
    return subpages
        .map(group => group.sort((first, second) => first.transmissionNumber - second.transmissionNumber))
        .sort((first, second) => first[0].transmissionNumber - second[0].transmissionNumber);
}


/*
* Two sets of transmissions are the same page if their close matches differ by no more than this
* A subcode seen only once or twice with a value real rotating pages don't use (such as 0701 or 3001), is a damaged header, so it joins the nearest page more readily
*/
const SAME_PAGE_LIMIT = 0.3;
const SAME_PAGE_LIMIT_FOR_DAMAGED_SUBCODES = 0.55;
const RARE_SUBCODE_VERSIONS = 2;
const RARE_SUBCODE_SHARE = 0.15;
const HIGHEST_USUAL_SUBCODE = 0x00ff;

// Two different subcodes that both look like real ones (0001-00FF), and were each sent a fair share of the time, are separate subpages unless their text is almost identical
// * Pages that look alike, such as the scrambled sports pages, would otherwise be merged
// * A real-looking subcode seen far less often than the page's main one is still a damaged header
const SAME_PAGE_LIMIT_FOR_USUAL_SUBCODES = 0.05;
const RARE_USUAL_SUBCODE_SHARE = 0.2;   // seen at most this share as often as the page's most-sent subcode
const isUsualSubcode = page => parseInt(page.subcode, 16) <= HIGHEST_USUAL_SUBCODE;

// & How different two sets of transmissions can be and still count as the same page
function samePageLimit(page, realPage, mostSent) {
    if (looksDamaged(page)) return SAME_PAGE_LIMIT_FOR_DAMAGED_SUBCODES;
    const isRare = page.versions.length <= mostSent * RARE_USUAL_SUBCODE_SHARE;
    if (!isRare && isUsualSubcode(page) && isUsualSubcode(realPage) && page.subcode !== realPage.subcode) return SAME_PAGE_LIMIT_FOR_USUAL_SUBCODES;
    return SAME_PAGE_LIMIT;
}
const looksDamaged = page =>
    page.versions.length <= RARE_SUBCODE_VERSIONS && parseInt(page.subcode, 16) > HIGHEST_USUAL_SUBCODE;

// Match 40 versions per set to keep long captures quick
const MAX_VERSIONS_TO_MATCH = 40;

// & How alike two sets of transmissions are: the third-closest pair's difference (so one lucky match isn't enough for this case)
function setDifference(firstVersions, secondVersions) {
    const rates = [];
    for (const first of firstVersions.slice(0, MAX_VERSIONS_TO_MATCH)) {
        for (const second of secondVersions.slice(0, MAX_VERSIONS_TO_MATCH)) {
            const rate = differenceRate(first, second);
            if (rate !== null) rates.push(rate);
        }
    }
    if (rates.length === 0) return 1;
    rates.sort((first, second) => first - second);
    return rates[Math.min(2, rates.length - 1)];
}


// & Many services number their subpages on screen: "1/5", "2/5", etc. (such as Electra at the end of row 1).
// * Read it from a voted page, but allow for one damaged separator (e.g. "3W5"). Returns { number, total } object or null

// Do not use row 0 because a date (such as one formatted as 4/13) could be mistaken for a row
const COUNTER_ROWS = [1, 2, 3, 24, 23, 22];
function readSubpageCounter(pageRows) {
    for (const rowNumber of COUNTER_ROWS) {
        const rowBytes = pageRows[rowNumber];
        if (!rowBytes) continue;
        const text = String.fromCharCode(...rowBytes.map(byteValue =>
            (byteValue & SEVEN_BIT_MASK) < FIRST_PRINTABLE_BYTE ? SPACE : byteValue & SEVEN_BIT_MASK)).trimEnd();
        const match = text.match(/\b(\d{1,2}) ?\/ ?(\d{1,2})\b/) ?? text.match(/\b(\d{1,2})[^\w\s](\d{1,2})$|\b(\d)W(\d)$/);
        if (!match) continue;
        const number = Number(match[1] ?? match[3]);
        const total = Number(match[2] ?? match[4]);
        if (number >= 1 && total >= 2 && number <= total) return { number, total };
    }
    return null;
}


// & Put separated subpages in their on-screen order (1/5, 2/5, etc.) when the pages show a counter, otherwise keep the order they first turned up in
// * Each keeps a subpageId (first-seen order) for its key
function orderSubpages(groups) {
    const counters = groups.map(versions => readSubpageCounter(buildFinalPageFromVersions(versions)));

    // The total most of them agree on (a damaged copy, for example, might read 3/6 instead of 3/5)
    const totalVotes = new Map();
    counters.forEach(counter => { if (counter) totalVotes.set(counter.total, (totalVotes.get(counter.total) ?? 0) + 1); });
    const [total] = [...totalVotes].sort((first, second) => second[1] - first[1])[0] ?? [];

    const numbers = counters.map(counter => (total && counter?.total === total ? counter.number : null));
    const used = new Set();
    numbers.forEach((number, groupIndex) => {
        if (number === null) return;

        // Two cannot be bth 3/5, so trust only teh one that was first seen
        if (used.has(number)) numbers[groupIndex] = null;
        else used.add(number);
    });

    // A subpage with no readable counter, such as a title page, takes its number from where it sits in the rotation.
    // * for example, if sent right before 2/7, it is 1/7, and if sent right after 6/7, it is 7/7. Repeat this so a run of several can be worked out
    if (total) {
        const broadcastOrder = groups
            .flatMap((versions, groupIndex) => versions.filter(hasDisplayRows).map(version => ({ groupIndex, at: version.transmissionNumber ?? 0 })))
            .sort((first, second) => first.at - second.at)
            .map(entry => entry.groupIndex)
            .filter((groupIndex, position, order) => position === 0 || order[position - 1] !== groupIndex);   // one entry per run
        let changed = true;
        while (changed) {
            changed = false;
            numbers.forEach((number, groupIndex) => {
                if (number !== null) return;
                const votes = new Map();
                broadcastOrder.forEach((entry, position) => {
                    if (entry !== groupIndex) return;
                    const next = numbers[broadcastOrder[position + 1]];
                    const previous = numbers[broadcastOrder[position - 1]];
                    if (next != null) { const guess = next === 1 ? total : next - 1; votes.set(guess, (votes.get(guess) ?? 0) + 1); }
                    if (previous != null) { const guess = previous === total ? 1 : previous + 1; votes.set(guess, (votes.get(guess) ?? 0) + 1); }
                });
                const [best] = [...votes].filter(([guess]) => !used.has(guess)).sort((first, second) => second[1] - first[1])[0] ?? [];
                if (best !== undefined) {
                    numbers[groupIndex] = best;
                    used.add(best);
                    changed = true;
                }
            });
        }
    }

    // If there's still one subpage with an unreadable counter and one number left over, then that's its number
    const unknown = numbers.flatMap((number, groupIndex) => (number === null ? [groupIndex] : []));
    const free = total ? Array.from({ length: total }, (_, index) => index + 1).filter(number => !used.has(number)) : [];
    if (unknown.length === 1 && free.length === 1) numbers[unknown[0]] = free[0];

    // Known numbers first, in order. Any without one follow, numbered after them, in first-seen order
    const highestKnown = Math.max(0, ...numbers.filter(number => number !== null));
    let nextSpare = highestKnown;
    return groups
        .map((versions, groupIndex) => ({ versions, subpageId: groupIndex + 1, number: numbers[groupIndex] }))
        .sort((first, second) => (first.number ?? Infinity) - (second.number ?? Infinity) || first.subpageId - second.subpageId)
        .map(({ versions, subpageId, number }) => ({ versions, subpageId, subpage: number ?? ++nextSpare }));
}

// & Clean up how a capture's transmissions are filed into pages and subpages
function sortOutSubpages(pages) {
    const pagesByNumber = new Map();
    pages.forEach(page => {
        if (!pagesByNumber.has(page.number)) pagesByNumber.set(page.number, []);
        pagesByNumber.get(page.number).push(page);
    });

    const result = [];
    for (const samePagesNumber of pagesByNumber.values()) {

        // First, merge subcodes with matching text
        const bySize = [...samePagesNumber].sort((first, second) => second.versions.length - first.versions.length);
        const realPages = [];
        for (const page of bySize) {
            const versions = page.versions.map(version => ({ ...version }));
            let closest = null;
            for (const realPage of realPages) {
                const difference = setDifference(versions, realPage.versions);
                if (difference > samePageLimit(page, realPage, bySize[0].versions.length)) continue;
                if (!closest || difference < closest.difference) closest = { realPage, difference };
            }
            if (closest) closest.realPage.versions.push(...versions);
            else realPages.push({ ...page, versions });
        }
        realPages.sort((first, second) => first.subcode.localeCompare(second.subcode));

        // Put each page's transmissions in broadcast order and number them
        realPages.forEach(page => {
            page.versions.sort((first, second) => (first.receivedAt ?? 0) - (second.receivedAt ?? 0));
            page.versions.forEach((version, versionIndex) => { version.transmissionNumber = versionIndex + 1; });
        });

        // Next, if there is 1 real subcode, separate its subpages by content
        // * Damaged subcodes that were too scrambled to join in step 1 (P134/3700) don't count as a second subcode
        // * Their transmissions are sorted in with the rest and join the nearest subpage
        const mostSent = Math.max(...realPages.map(page => page.versions.length));
        const isStray = page => looksDamaged(page)
            || (parseInt(page.subcode, 16) > HIGHEST_USUAL_SUBCODE && page.versions.length <= mostSent * RARE_SUBCODE_SHARE);
        const genuinePages = realPages.filter(page => !isStray(page));
        if (genuinePages.length === 1) {
            const allVersions = realPages
                .flatMap(page => page.versions.map(version => ({ ...version })))
                .sort((first, second) => (first.receivedAt ?? 0) - (second.receivedAt ?? 0));
            allVersions.forEach((version, versionIndex) => { version.transmissionNumber = versionIndex + 1; });

            const groups = groupVersionsBySubpage(allVersions);
            if (groups.length > 1) {
                orderSubpages(groups).forEach(({ versions, subpageId, subpage }) =>
                    result.push({ ...genuinePages[0], subpageId, subpage, versions }));
                continue;
            }
        }
        result.push(...realPages);
    }
    return result;
}


// & Move each hand-separated transmission out of its entry and into a new subpage entry
// * "sortedPage"s" is left as it was. Entries that change are copied
function applySeparatedTransmissions(sortedPages) {
    if (editorState.separatedTransmissions.size === 0) return sortedPages;

    const result = [];
    for (const page of sortedPages) {
        const separated = page.versions.filter(version => editorState.separatedTransmissions.has(version.receivedAt));
        const remaining = page.versions.filter(version => !editorState.separatedTransmissions.has(version.receivedAt));
        if (separated.length === 0 || remaining.length === 0) {
            result.push(page);
            continue;
        }

        // The entry the transmissions came from keeps its key (subpageId 0 adds nothing to it) but becomes a subpage
        result.push({ ...page, versions: remaining, subpageId: page.subpageId ?? 0, subpage: page.subpage ?? 1 });
        separated.forEach(version =>
            result.push({ ...page, versions: [version], subpageId: `t${version.receivedAt}`, subpage: null }));
    }

    // Number the new subpages after the existing ones of the same page
    const highestByNumber = new Map();
    result.forEach(page => highestByNumber.set(page.number, Math.max(highestByNumber.get(page.number) ?? 0, page.subpage ?? 0)));
    result
        .filter(page => page.subpage === null)
        .sort((first, second) => first.versions[0].receivedAt - second.versions[0].receivedAt)
        .forEach(page => {
            page.subpage = highestByNumber.get(page.number) + 1;
            highestByNumber.set(page.number, page.subpage);
        });

    return result;
}


// & Rebuild the list after separating or rejoining, and show the entry that isToShow picks
function rebuildAfterSeparation(isToShow) {
    editorState.groupedPages = applySeparatedTransmissions(editorState.sortedPages);
    editorState.checkedPageKeys.clear();
    editorState.lastCheckedIndex = null;
    editorState.pages = buildPageList();
    editorState.hasUnsavedChanges = true;
    selectPage(Math.max(0, editorState.pages.findIndex(isToShow)));
}


// & Give the compared transmission (or, when transmissions are split, the selected one) its own subpage entry
function separateTransmission() {
    const page = getSelectedPage();
    if (elements.groupOption && !elements.groupOption.checked) {
        announceStatus("Turn on separating subpages first. Hand-separated subpages are part of that view.");
        return;
    }

    const versionIndex = page.baseVersionIndex ?? editorState.comparedVersionIndex;
    const version = page.versions[versionIndex];
    if (version.receivedAt === undefined) {
        announceStatus("This capture was decoded without transmission positions. Open the T42 again to separate transmissions.");
        return;
    }
    const entryVersions = editorState.groupedPages.find(entry => entry.versions.includes(version))?.versions ?? [];
    if (entryVersions.length < 2) {
        announceStatus(`${pageLabel(page)} only has this one transmission, so it's already on its own.`);
        return;
    }

    editorState.separatedTransmissions.add(version.receivedAt);
    rebuildAfterSeparation(entry => entry.subpageId === `t${version.receivedAt}`);
    const transmissionLabel = page.transmission ? `P${page.number} #${page.transmission}` : `Version ${versionIndex + 1} of P${page.number}`;
    announceStatus(`${transmissionLabel} is now its own subpage. Edit it like any other entry. \"Rejoin\" puts it back.`);
}


// & Put a hand-separated subpage back into the entry it came from
function rejoinTransmission() {
    const page = getSelectedPage();
    const separated = page.versions.filter(version => editorState.separatedTransmissions.has(version.receivedAt));
    if (!String(page.subpageId ?? "").startsWith("t") || separated.length === 0) {
        announceStatus(`${pageLabel(page)} wasn't separated by hand; nothing to rejoin.`);
        return;
    }

    separated.forEach(version => editorState.separatedTransmissions.delete(version.receivedAt));
    editorState.editedPageRows.delete(pageKey(page));
    rebuildAfterSeparation(entry => entry.number === page.number && entry.versions.includes(separated[0]));
    announceStatus(`Rejoined the transmission to P${page.number}. Edits made to it as a separate subpage were discarded.`);
}


// & Load new set of decoded pages
function loadPages(decodedPages, { separatedTransmissions = [] } = {}) {

    // Number each transmission in capture order, so it keeps its number when subpages are separated
    decodedPages.forEach(page => page.versions.forEach((version, versionIndex) => { version.transmissionNumber = versionIndex + 1; }));
    editorState.decodedPages = decodedPages;
    editorState.sortedPages = sortOutSubpages(decodedPages);
    editorState.separatedTransmissions = new Set(separatedTransmissions);
    editorState.groupedPages = applySeparatedTransmissions(editorState.sortedPages);
    editorState.removedPageKeys.clear();
    editorState.removalSteps = [];
    editorState.editedPageRows.clear();
    editorState.checkedPageKeys.clear();
    editorState.lastCheckedIndex = null;
    editorState.hasUnsavedChanges = false;
    editorState.pages = buildPageList();
    selectPage(0);
}


// & Blank viewers and empty panels, shown before a file is opened
function showEmptyEditor() {
    editorState.selectedPageIndex = -1;
    editorState.finalPageRows = [];
    editorState.selection = null;
    editorState.finalSelection = null;
    editorState.undoHistory = [];

    const blankRows = Array(ROW_COUNT).fill(null);
    drawPage(elements.finalCanvas, blankRows, { highlightMissingRows: false, showRowNumbers: true });
    drawPage(elements.comparedCanvas, blankRows, { highlightMissingRows: false, showRowNumbers: true });

    renderPageList();
    elements.versionStrip.innerHTML = "";
    elements.comparisonTableBody.innerHTML = "";
    elements.finalText.textContent = "";
    elements.comparedText.textContent = "";
    elements.comparedCaption.textContent = "Compared version";
    elements.pageNumberInput.value = "";
    elements.subcodeInput.value = "";
}


// & Find the other transmission that shares the most identical rows with this one. In a raw capture, that is most likely the same subpage from another rotation.
function mostSimilarVersionIndex(versions, baseIndex, candidateIndices = versions.map((version, versionIndex) => versionIndex)) {
    const baseRows = versions[baseIndex].rows;
    let bestIndex = -1;
    let bestScore = -1;

    candidateIndices.forEach(versionIndex => {
        const version = versions[versionIndex];
        if (versionIndex === baseIndex) return;
        let matchingRows = 0;

        // Row 0 is the header, which changes every time
        for (let rowNumber = 1; rowNumber < ROW_COUNT; rowNumber++) {
            const baseRow = baseRows[rowNumber];
            const otherRow = version.rows[rowNumber];
            if (baseRow && otherRow && rowsMatch(baseRow, otherRow)) matchingRows++;
        }

        // A transmission that passes the same-subpage test always beats one that doesn't
        if (looksLikeSameSubpage(versions[baseIndex], version)) matchingRows += 100;
        if (matchingRows > bestScore) {
            bestScore = matchingRows;
            bestIndex = versionIndex;
        }
    });

    return bestIndex === -1 ? baseIndex : bestIndex;
}


// & Select a page. startOver throws away this entry's edits (used by "Rebuild Final Page").
function selectPage(pageIndex, { startOver = false } = {}) {
    if (!editorState.pages[pageIndex]) {
        showEmptyEditor();
        return;
    }
    editorState.selectedPageIndex = pageIndex;

    const page = getSelectedPage();
    if (startOver) editorState.editedPageRows.delete(pageKey(page));
    const savedRows = editorState.editedPageRows.get(pageKey(page));

    // Split mode: compare with the most similar other transmission. Otherwise, start with version 1
    editorState.comparedVersionIndex = page.baseVersionIndex !== undefined
        ? mostSimilarVersionIndex(page.versions, page.baseVersionIndex)
        : 0;
    editorState.finalPageRows = savedRows ?? startingRowsFor(page);

    editorState.cursor = { column: 0, row: 0 };
    editorState.selection = null;
    editorState.finalSelection = null;
    editorState.undoHistory = [];
    renderEverything();
    if (savedRows) {
        announceStatus(`${pageLabel(page)}: the final edited page.`);
        return;
    }
    announceStatus(page.baseVersionIndex !== undefined
        ? `${pageLabel(page)}: final page copied from transmission ${page.transmission}`
        + (page.subpage ? ` (this subpage was sent ${page.versions.length} times).` : ` of ${page.versions.length}.`)
        : `${pageLabel(page)}: final page built from ${page.versions.length} version(s).`
    );
}


// & A row that was never received is null, so typing into it will first create a blank row
function getOrCreateFinalRow(rowNumber) {
    if (!editorState.finalPageRows[rowNumber]) {
        editorState.finalPageRows[rowNumber] = Array(COLUMN_COUNT).fill(SPACE);
    }
    return editorState.finalPageRows[rowNumber];
}


// & Set the necessary byte at the cursor position
function setByteAtCursor(byteValue) {
    getOrCreateFinalRow(editorState.cursor.row)[editorState.cursor.column] = byteValue;
}


// & Write the byte
function writeByteAtCursor(byteValue) {
    saveUndoStep();
    setByteAtCursor(byteValue);
    moveCursor(1, 0);
    renderEverything();
}


// & Typed keys always give text, never block graphics
function typeCharacterAtCursor(byteValue) {
    const { column, row } = editorState.cursor;
    if (byteValue === SPACE || !editorState.finalPageRows[row]) {
        writeByteAtCursor(byteValue);
        return;
    }

    saveUndoStep();
    const rowBytes = getOrCreateFinalRow(row);
    const originalBytes = rowBytes.slice();
    const attributes = attributesBefore(rowBytes, column);
    let letterColumn = column;

    if (attributes.isMosaic) {
        const textCode = attributes.foreground;
        if (column > 0 && rowBytes[column - 1] === SPACE) {
            rowBytes[column - 1] = textCode;
        } else {
            rowBytes[column] = textCode;
            letterColumn = column + 1;
        }
    }

    if (letterColumn < COLUMN_COUNT) {
        rowBytes[letterColumn] = byteValue;
        if (!switchBackAfter(rowBytes, originalBytes, letterColumn + 1)) {
            announceStatus("No space after this letter for a mosaic code; the characters to its right may now show as text. Undo to put it back.");
        }
    }

    editorState.cursor.column = letterColumn;
    moveCursor(1, 0);
    renderEverything();
}


// & Erase the byte before the cursor is deleting a character
function eraseBeforeCursor() {
    saveUndoStep();
    moveCursor(-1, 0);
    setByteAtCursor(SPACE);
    renderEverything();
}


// & Move the cursor as someone types
function moveCursor(columnStep, rowStep) {
    editorState.cursor.column = clampColumn(editorState.cursor.column + columnStep);
    editorState.cursor.row = clampRow(editorState.cursor.row + rowStep);
    renderPageViews();
    renderCursorDetails();
}


/*
* *** ! SportScreen descrambling ! ***
* On Later Electra samples, there are pages for sports subscription services: SportScreen, HSW, SuperSCREEN, and CSW.
* Rows 1-22 were scrambled so only their own decoders could read them. The scrambled lines appear as random text and mosaic characters.
* These services shared the same encryption system.
* Each 7-bit character is XORed with a 20-column pattern that starts at column 3; nothing else changes it. XOR undoes itself, so the same step scrambles the page again
*/

// ! Key for descrambling SportScreen pages
const SPORTSCREEN_KEY = [
    0x04, 0x05, 0x3e, 0x06,
    0x0a, 0x08, 0x09, 0x09,
    0x08, 0x0a, 0x06, 0x3e,
    0x05, 0x04, 0x03, 0x20,
    0x01, 0x01, 0x20, 0x03
];

// ! The first and last rows to look at
const SPORTSCREEN_FIRST_ROW = 1;
const SPORTSCREEN_LAST_ROW = 22;

// ! Row 23 is partially left alone because the phone number is plaintext, but the text before it is de-scrambled
const SPORTSCREEN_FOOTER_ROW = 23;

const sportScreenKeyFor = column => SPORTSCREEN_KEY[(column - 3 + SPORTSCREEN_KEY.length) % SPORTSCREEN_KEY.length];

// & Count blank cells both ways: plain spaces and spaces scrambled with their column's key
function countSportScreenBlanks(pageRows) {

    // Get raw row counts
    let readableBlanks = 0;
    let scrambledBlanks = 0;

    // Examine only the SportScreen rows
    for (let rowNumber = SPORTSCREEN_FIRST_ROW; rowNumber <= SPORTSCREEN_LAST_ROW; rowNumber++) {

        // Examine each row. Defensive programming applied so an empty array is used if "pageRows[rowNumber]" doesn't exist
        (pageRows[rowNumber] ?? []).forEach((byteValue, column) => {

            // Strip high bit and keep only the row 7 bits
            const value = byteValue & SEVEN_BIT_MASK;

            // If a space (0x20), count them
            if (value === SPACE) readableBlanks++;

            // Detect a scrambled space
            else if (value === (SPACE ^ sportScreenKeyFor(column))) scrambledBlanks++;
        });
    }
    return { readableBlanks, scrambledBlanks };
}

// & Figure out if the current page is a scrambled page
// * Row 23 is never changed by unscrambling and every one of these services ends it with two scrambled spaces (bytes 00 21 in columns 38-39). Older SportScreen footers also name the service
// * A page still scrambled is also recognized by at least a row's worth of scrambled spaces
function isSportScreenPage(pageRows) {

    // ^ 1. Check for a scrambled footer
    const footer = (pageRows[SPORTSCREEN_FOOTER_ROW] ?? []).map(byteValue => byteValue & SEVEN_BIT_MASK);

    // ^ 2. If there are scrambled bits at columns 38 and 39 in the footer row, the page is a SportScreen page
    if (footer[38] === (SPACE ^ sportScreenKeyFor(38)) && footer[39] === (SPACE ^ sportScreenKeyFor(39))) return true;

    // ^ 3. Check and see if the footer includes "SportScreen" in plaintext
    if (String.fromCharCode(...footer).includes("SportScreen")) return true;

    // If none of those 3 worked, fall back to statistical detection
    const { readableBlanks, scrambledBlanks } = countSportScreenBlanks(pageRows);
    return scrambledBlanks >= COLUMN_COUNT && scrambledBlanks > readableBlanks;
}

// & If the page is currently scrambled, a space becomes its column's key value XOR space. Blank cells are mostly spaces when readable
function isSportScreenScrambled(pageRows) {
    const { readableBlanks, scrambledBlanks } = countSportScreenBlanks(pageRows);
    return scrambledBlanks > readableBlanks;
}

// ^ There are 8 columns in the SportScreen footer that are scrambled. Store only these columns
const SPORTSCREEN_CODE_COLUMNS = 8;

// ^ 3 categories of valid code characters: spaces (0x20), numbers (0x30 - 0x39), and uppercase letters (A-Z)
const isCodeCharacter = byteValue => byteValue === SPACE || (byteValue >= 0x30 && byteValue <= 0x39) || (byteValue >= 0x41 || byteValue <= 0x5a);

// ^ Apply the XOR de-scrambling code only those specific columns in the footer
const toggledFooterCode = footer => footer.map((byteValue, column) => column < SPORTSCREEN_CODE_COLUMNS ? (byteValue & SEVEN_BIT_MASK) ^ sportScreenKeyFor(column) : byteValue);

// & Determine if the code is scrambled
function isFooterCodeScrambled(footer) {

    // Take first 8 bytes, keep only bytes that look like valid characters, then count them
    const codeCharacters = rowBytes => rowBytes.slice(0, SPORTSCREEN_CODE_COLUMNS).filter(byteValue => isCodeCharacter(byteValue & SEVEN_BIT_MASK)).length;

    // Compare columns before and after toggling
    return codeCharacters(toggledFooterCode(footer)) > codeCharacters(footer);
}


/*
* *** ! Mel Stewart's Picks descrambling ! *** ----
* On later Electra samples, Mel Stewart's Picks used a different encryption scheme.
* Each character's last three bits are swapped in pairs (1 becomes 4, 2 becomes 7, and 3 becomes 6, for example; this is based on XOR 5.
* Characters ending in 0 or 5 are left alone. So "CJJQGDII" is FOOTBALL, while spaces, P, H, E and M look untouched.
* It applies to every row except the header.
* These pages have no noticeable blank pattern, so they are recognized by words; this means that un-swapping must turn up common words such as these: "THE", "FOR", "CALL", and "FINAL").
*/

// ^ Start with the first and last rows
const LETTER_SWAP_FIRST_ROW = 1;
const LETTER_SWAP_LAST_ROW = 24;

// ^ 3 recognizable words must be detected at minimum for decryption to be applied
const LETTER_SWAP_MIN_WORDS = 3;

// ! This is required for the letter swap. If this wasn't here, every row would be affected regardless of whether it used letter-swap
const LETTER_SWAP_WORDS = new Set(`THE AND FOR OF TO IS IN ON AT BY OR NOT ARE ALL CALL CALLS FREE NEWS ONLY WITH FROM THIS
    THAT YOUR YOU OUR DAY DAYS WEEK TODAY TIME TIMES LINE LINES OPEN FINAL SCORE SCORES GAME GAMES PICKS PICK BEST PLAY PLAYS
    SPORTS FOOTBALL BASKETBALL BASEBALL HOCKEY COLLEGE NFL NBA NHL OVER UNDER TOTAL EASTERN INFORMATION MATTER LAWS`.split(/\s+/)
);

// ^ Swap the binary bits. Only the last low 7 bits need to be XOR'd. Flip only bits 0 and 2 (e.g. 010 becomes 111 and 011 becomes 110)
// * Control characters are not to be swapped. If the bottom 3 bits are 000 and 101, leave it alone
const swapLetterBits = byteValue => (byteValue < SPACE || [0, 5].includes(byteValue & 7) ? byteValue : byteValue ^ 5);

// & How many common words a page's text contains
function countCommonWords(rows) {
    let text = "";

    // Extract rows 1-24
    for (let rowNumber = LETTER_SWAP_FIRST_ROW; rowNumber <= LETTER_SWAP_LAST_ROW; rowNumber++) {
        text += String.fromCharCode(...(rows[rowNumber] ?? []).map(byteValue => {

            // Converted to printable ASCII characters
            const value = byteValue & SEVEN_BIT_MASK;
            return value >= SPACE && value < 0x7f ? value : SPACE;
        })) + " ";
    }

    // Extract letter sequences then count how many of those words appear in the known word list
    return (text.match(/[A-Za-z]+/g) ?? []).filter(word => LETTER_SWAP_WORDS.has(word.toUpperCase())).length;
}

// ^ Create rows with the letter swap applied
const letterSwappedRows = rows => rows.map((rowBytes, rowNumber) =>
    // !
    rowBytes && rowNumber >= LETTER_SWAP_FIRST_ROW && rowNumber <= LETTER_SWAP_LAST_ROW
        ? rowBytes.map(byteValue => swapLetterBits(byteValue & SEVEN_BIT_MASK))
        : rowBytes);

// & Figure out if the current page is scrambled with letter-swap. The page must reveal many more common words than it currently shows
function isLetterSwapped(rows) {

    // Get how many recognizable words are visible
    const shownWords = countCommonWords(rows);

    // Get how many recognizable words appear if the letter-swap is applied
    const swappedWords = countCommonWords(letterSwappedRows(rows));

    // Return the swapped words
    return swappedWords >= LETTER_SWAP_MIN_WORDS && swappedWords > shownWords * 2;
}


// & Unscramble or re-scramble the final page
function toggleSportScreenScrambling() {

    // ^ If the current page is a Mel Stewart (letter-swap) page and not a SportScreen (XOR) page
    if (!isSportScreenPage(editorState.finalPageRows) && isLetterSwapped(editorState.finalPageRows)) {
        saveUndoStep();
        letterSwappedRows(editorState.finalPageRows).forEach((rowBytes, rowNumber) => { editorState.finalPageRows[rowNumber] = rowBytes; });
        rememberEdits();
        renderEverything();
        announceStatus(`${pageLabel(getSelectedPage())} is unscrambled using letter-swap. Undo to go back.`);
        return;
    }

    // ^ If the current page is not a SportScreen page, leave it alone
    if (!isSportScreenPage(editorState.finalPageRows)) {
        announceStatus("This page isn't scrambled. It isn't one of the scrambles subcarrier services (SportScreen, HSW, SuperSCREEN, CSW) or a letter-swapped page (Mel Stewart's Picks).");
        return;
    }

    saveUndoStep();

    const isUnscrambling = isSportScreenScrambled(editorState.finalPageRows);

    // ^ If the current page is a SportScreen page, apply descrambling
    for (let rowNumber = SPORTSCREEN_FIRST_ROW; rowNumber <= SPORTSCREEN_LAST_ROW; rowNumber++) {
        const rowBytes = editorState.finalPageRows[rowNumber];
        if (!rowBytes) continue;

        // Process every byte with XOR
        rowBytes.forEach((byteValue, column) => { rowBytes[column] = (byteValue & SEVEN_BIT_MASK) ^ sportScreenKeyFor(column); });
    }

    const footer = editorState.finalPageRows[SPORTSCREEN_FOOTER_ROW];
    if (footer && isFooterCodeScrambled(footer) === isUnscrambling) editorState.finalPageRows[SPORTSCREEN_FOOTER_ROW] = toggledFooterCode(footer);

    renderEverything();

    announceStatus(isSportScreenScrambled(editorState.finalPageRows)
        ? `${pageLabel(getSelectedPage())} has been re-scrambled, as was seen by those without a decoder. Undo to go back.`
        : `${pageLabel(getSelectedPage())} is unscrambled. Rows 1-22 now read as how those with a decoder saw them; Undo to go back.`);
}


// & Fill rows missing in final version with rows from the compared version
function fillMissingRowsFromComparedVersion() {
    const comparedRows = getComparedRows();
    saveUndoStep();
    let filledCount = 0;
    for (let rowNumber = 0; rowNumber < ROW_COUNT; rowNumber++) {
        if (!editorState.finalPageRows[rowNumber] && comparedRows[rowNumber]) {
            editorState.finalPageRows[rowNumber] = comparedRows[rowNumber].slice();
            filledCount++
        }
    }

    renderEverything();
    announceStatus(filledCount
        ? `Filled ${filledCount} missing row(s) from ${comparedVersionLabel()}.`
        : "Nothing to fill from this version."
    );
}


// & Apply hex value from inspector
function applyHexFromInspector() {
    const byteValue = parseInt(elements.cursorHexInput.value, 16);

    if (Number.isNaN(byteValue) || byteValue > LAST_BYTE) {
        announceStatus("Enter a hex value from 00 to 7F.")
        return;
    }

    saveUndoStep();
    setByteAtCursor(byteValue);
    renderEverything();
}


// & Download file
function downloadFile(fileName, blob) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Pages are drawn at twice the on-screen size, 960 × 1000, the same as Decode-Orc's images
const PNG_EXPORT_SCALE = 2;

// & The final page to export for an entry is the one on screen for the selected entry, otherwise its saved edits or the page built from its versions
function rowsForExport(page, pageIndex) {
    if (pageIndex === editorState.selectedPageIndex) return editorState.finalPageRows;
    return editorState.editedPageRows.get(pageKey(page)) ?? startingRowsFor(page);
}

// & Draw a page and turn it into a PNG
function renderPageAsPNG(pageRows) {
    return new Promise((resolve, reject) => {
        const canvas = document.createElement("canvas");
        drawPage(canvas, pageRows, {
            highlightMissingRows: false,
            revealConcealed: elements.revealOption.checked,
            scale: PNG_EXPORT_SCALE
        });
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("the browser couldn't make the image")), "image/png");
    });
}

// & Export the page being edited as one PNG
async function exportCurrentPageAsPNG() {
    const page = getSelectedPage();
    try {
        const blob = await renderPageAsPNG(editorState.finalPageRows);
        downloadFile(`${exportFileName(page)}.png`, blob);
        announceStatus(`Exported ${pageLabel(page)} as a 960 × 1000 PNG.`);
    } catch (error) {
        announceStatus(`Couldn't export PNG: ${error.message}.`);
    }
}

// & Export every entry in the list as PNGs and put them into a ZIP file
let isExportingImages = false;
async function exportAllPagesAsPNG() {
    if (isExportingImages) return;
    isExportingImages = true;

    try {
        const files = [];
        const usedNames = new Set();
        for (const [pageIndex, page] of editorState.pages.entries()) {
            if (pageIndex % 10 === 0) announceStatus(`Making images: ${pageIndex} of ${editorState.pages.length}...`);

            let name = exportFileName(page);
            for (let copy = 2; usedNames.has(name); copy++) name = `${exportFileName(page)}-${copy}`;
            usedNames.add(name);

            const blob = await renderPageAsPNG(rowsForExport(page, pageIndex));
            files.push({ name: `${name}.png`, bytes: new Uint8Array(await blob.arrayBuffer()) });
        }

        const baseName = editorState.sourceFileName.replace(/\.[^.]+$/, "");
        downloadFile(`${baseName}-pages-png.zip`, createZip(files));
        announceStatus(`Exported ${files.length} page(s) as 960 × 1000 PNGs in ${baseName}-pages-png.zip; ${editorState.removedPageKeys.size} removed page(s) left out.`);
    } catch (error) {
        announceStatus(`Couldn't export PNG files: ${error.message}.`);
    } finally {
        isExportingImages = false;
    }
}

// ! Create the ZIP
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let value = 0; value < 256; value++) {
        let crc = value;
        for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
        table[value] = crc >>> 0;
    }
    return table;
})();

// & Checksum every ZIP entry needs
function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byteValue of bytes) crc = CRC32_TABLE[(crc ^ byteValue) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// & Build a ZIP file from [{ name, bytes }]
function createZip(files) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const UTF8_NAMES = 0x0800;

    const fileParts = [];
    const directoryParts = [];
    let offset = 0;

    for (const { name, bytes } of files) {
        const nameBytes = encoder.encode(name);
        const checksum = crc32(bytes);

        const localHeader = new DataView(new ArrayBuffer(30));
        localHeader.setUint32(0, 0x04034b50, true);
        localHeader.setUint16(4, 20, true);
        localHeader.setUint16(6, UTF8_NAMES, true);
        localHeader.setUint16(8, 0, true);
        localHeader.setUint16(10, dosTime, true);
        localHeader.setUint16(12, dosDate, true);
        localHeader.setUint32(14, checksum, true);
        localHeader.setUint32(18, bytes.length, true);
        localHeader.setUint32(22, bytes.length, true);
        localHeader.setUint16(26, nameBytes.length, true);
        localHeader.setUint16(28, 0, true);
        fileParts.push(localHeader, nameBytes, bytes);

        const directoryEntry = new DataView(new ArrayBuffer(46));
        directoryEntry.setUint32(0, 0x02014b50, true);
        directoryEntry.setUint16(4, 20, true);
        directoryEntry.setUint16(6, 20, true);
        directoryEntry.setUint16(8, UTF8_NAMES, true);
        directoryEntry.setUint16(10, 0, true);
        directoryEntry.setUint16(12, dosTime, true);
        directoryEntry.setUint16(14, dosDate, true);
        directoryEntry.setUint32(16, checksum, true);
        directoryEntry.setUint32(20, bytes.length, true);
        directoryEntry.setUint32(24, bytes.length, true);
        directoryEntry.setUint16(28, nameBytes.length, true);
        directoryEntry.setUint32(42, offset, true);
        directoryParts.push(directoryEntry, nameBytes);

        offset += 30 + nameBytes.length + bytes.length;
    }

    const directorySize = directoryParts.reduce((total, part) => total + part.byteLength, 0);
    const endRecord = new DataView(new ArrayBuffer(22));
    endRecord.setUint32(0, 0x06054b50, true);
    endRecord.setUint16(8, files.length, true);
    endRecord.setUint16(10, files.length, true);
    endRecord.setUint32(12, directorySize, true);
    endRecord.setUint32(16, offset, true);

    return new Blob([...fileParts, ...directoryParts, endRecord], { type: "application/zip" });
}


// & Export every entry still in the list as one JSON file
function votedFlagsFor(page) {
    if (page.baseVersionIndex !== undefined) return page.versions[page.baseVersionIndex].flags ?? [];

    const counts = new Map();
    page.versions.forEach(version => (version.flags ?? []).forEach(flag => counts.set(flag, (counts.get(flag) ?? 0) + 1)));
    return [...counts]
        .filter(([, count]) => count * 2 > page.versions.length)
        .map(([flag]) => flag)
        .sort((first, second) => first - second);
}


// & Export all pages in a JSON file
function exportAllPagesAsJSON() {
    const exportedPages = editorState.pages.map(page => {
        const key = pageKey(page);
        const sourceVersion = page.versions[page.baseVersionIndex ?? 0];
        const exportedPage = {
            page: page.number,
            subcode: page.subcode ?? sourceVersion.subcode ?? "",
            flags: votedFlagsFor(page),
            edited: editorState.editedPageRows.has(key),
            rows: editorState.editedPageRows.get(key) ?? startingRowsFor(page)
        };
        if (page.subpage) exportedPage.subpage = page.subpage;
        if (page.transmission) exportedPage.transmission = page.transmission;
        return exportedPage;
    });

    const exportData = {
        source: editorState.sourceFileName,
        removedCount: editorState.removedPageKeys.size,
        pages: exportedPages
    };
    const json = JSON.stringify(exportData, null, 2);
    const baseName = editorState.sourceFileName.replace(/\.[^.]+$/, "");
    downloadFile(`${baseName}-final.json`, new Blob([json], { type: "application/json" }));
    announceStatus(`Exported ${exportedPages.length} page(s); ${editorState.removedPageKeys.size} removed page(s) left out.`);
}


const SESSION_FORMAT = "editor-session";
const SESSION_VERSION = 1;

const rowToHex = rowBytes => rowBytes ? rowBytes.map(toHexString).join("") : null;
const hexToRow = hexText => hexText ? Array.from({ length: hexText.length / 2 }, (_, index) => parseInt(hexText.substr(index * 2, 2), 16)) : null;


// & Download everything needed to carry on later
function saveSession() {
    const selectedPage = getSelectedPage();
    const session = {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        savedAt: new Date().toISOString(),
        sourceFileName: editorState.sourceFileName,
        splitTransmissions: Boolean(elements.splitOption?.checked),
        separateSubpages: elements.groupOption ? elements.groupOption.checked : true,
        selectedKey: selectedPage ? pageKey(selectedPage) : null,
        removedPageKeys: [...editorState.removedPageKeys],
        separatedTransmissions: [...editorState.separatedTransmissions],
        removalSteps: editorState.removalSteps,
        editedPageRows: Object.fromEntries(
            [...editorState.editedPageRows].map(([key, rows]) => [key, rows.map(rowToHex)])),
        pages: editorState.decodedPages.map(page => ({
            number: page.number,
            subcode: page.subcode,
            versions: page.versions.map(version => ({
                subcode: version.subcode,
                flags: version.flags ?? [],
                rows: version.rows.map(rowToHex),
                parityErrors: version.parityErrors ?? null,
                receivedAt: version.receivedAt
            }))
        }))
    };

    const baseName = editorState.sourceFileName.replace(/(\.session)?\.[^.]+$/, "");
    downloadFile(`${baseName}.session.json`, new Blob([JSON.stringify(session)], { type: "application/json" }));
    editorState.hasUnsavedChanges = false;
    announceStatus(`Saved your work as ${baseName}.session.json. Open that file later to ccontinue working from where you previously stopped.`);
}


// & Re-attach saved edits
function reattachSavedEdits() {
    const currentKeys = new Set(editorState.pages.map(pageKey));
    const orphanKeys = [...editorState.editedPageRows.keys()].filter(key => !currentKeys.has(key));
    const endOfKey = key => key.slice(key.lastIndexOf("/") + 1);   // "all", or a transmission number

    // Entries with a damaged subcode (P146/0700) are now sorted in with their page's subpages
    const fromDamagedSubcode = key => parseInt(key.split("/")[1].split("~")[0], 16) > HIGHEST_USUAL_SUBCODE;

    const pairs = [];
    for (const key of orphanKeys.filter(key => !fromDamagedSubcode(key))) {
        const number = key.split("/")[0];
        const editedPage = { rows: editorState.editedPageRows.get(key) };
        for (const page of editorState.pages) {
            if (page.number !== number || String(page.transmission ?? "all") !== endOfKey(key)) continue;
            if (editorState.editedPageRows.has(pageKey(page))) continue;
            pairs.push({ key, page, difference: differenceRate(editedPage, { rows: startingRowsFor(page) }) ?? 1 });
        }
    }

    // Closest matches first; each old edit and each new entry is used once
    pairs.sort((first, second) => first.difference - second.difference);
    const movedKeys = new Set();
    const filledKeys = new Set();
    for (const { key, page } of pairs) {
        const newKey = pageKey(page);
        if (movedKeys.has(key) || filledKeys.has(newKey)) continue;
        editorState.editedPageRows.set(newKey, editorState.editedPageRows.get(key));
        editorState.editedPageRows.delete(key);
        movedKeys.add(key);
        filledKeys.add(newKey);
    }

    const pageNumbers = keys => [...new Set([...keys].map(key => `P${key.split("/")[0]}`))];
    return {
        movedNumbers: pageNumbers(movedKeys),
        unplacedNumbers: pageNumbers(orphanKeys.filter(key => !movedKeys.has(key)))
    };
}


// & Put a saved session back exactly as it was
function restoreSession(session) {
    if (session.version > SESSION_VERSION) {
        throw new Error("This session was saved by a newer version of the editor.");
    }

    const pages = session.pages.map(page => ({
        number: page.number,
        subcode: page.subcode,
        versions: page.versions.map(version => ({
            subcode: version.subcode,
            flags: version.flags ?? [],
            rows: version.rows.map(hexToRow),
            parityErrors: version.parityErrors ?? undefined,
            receivedAt: version.receivedAt
        }))
    }));

    if (elements.splitOption) elements.splitOption.checked = Boolean(session.splitTransmissions);

    // Work saved before subpages were separated used the combined pages, so keep them combined
    if (elements.groupOption) elements.groupOption.checked = session.separateSubpages ?? false;
    editorState.sourceFileName = session.sourceFileName || "session";

    // Clears the old state and shows the first page
    loadPages(pages, { separatedTransmissions: session.separatedTransmissions ?? [] });

    session.removedPageKeys?.forEach(key => editorState.removedPageKeys.add(key));

    // Older saved work has no steps. Treat everything it removed as one step
    editorState.removalSteps = session.removalSteps
        ?? (editorState.removedPageKeys.size ? [[...editorState.removedPageKeys]] : []);
    Object.entries(session.editedPageRows ?? {}).forEach(([key, rows]) =>
        editorState.editedPageRows.set(key, rows.map(hexToRow)));

    editorState.pages = buildPageList();
    const { movedNumbers, unplacedNumbers } = reattachSavedEdits();

    const selectedIndex = editorState.pages.findIndex(page => pageKey(page) === session.selectedKey);
    selectPage(Math.max(0, selectedIndex));

    // Save again to keep the moved edits in plave
    editorState.hasUnsavedChanges = movedNumbers.length > 0;

    const savedDate = new Date(session.savedAt).toLocaleString();
    let summary = `Restored your work from ${savedDate}: ${editorState.editedPageRows.size} edited page(s), ${editorState.removedPageKeys.size} removed.`;
    if (movedNumbers.length > 0) {
        summary += ` Subpages are now sorted differently in ${movedNumbers.join(", ")}; your edits there were moved to the matching subpage. Checking them is advised.`;
    }
    if (unplacedNumbers.length > 0) {
        summary += ` Some edits in ${unplacedNumbers.join(", ")} matched no remaining entry and are not shown (these edits are kept in the session file).`;
    }
    announceStatus(summary);
}


// Menu action buttons
const menuActions = {
    "open": () => {
        if (editorState.hasUnsavedChanges
            && !window.confirm("You have unsaved changes. Opening another file will replace them. Continue?")) return;
        elements.fileInput.click();
    },
    "save-session": saveSession,
    "export-all-json": exportAllPagesAsJSON,
    "export-png": exportCurrentPageAsPNG,
    "export-all-png": exportAllPagesAsPNG,
    "rebuild": () => selectPage(editorState.selectedPageIndex, { startOver: true }),
    "remove-page": removeSelectedPage,
    "remove-checked": removeCheckedPages,
    "separate-transmission": separateTransmission,
    "rejoin-transmission": rejoinTransmission,
    "restore-pages": restoreLastRemoval,
    "restore-all-pages": restoreAllRemovedPages,
    "fill-missing": fillMissingRowsFromComparedVersion,
    "unscramble-sportscreen": toggleSportScreenScrambling,
    "copy": copyLatestSelection,
    "paste-cursor": () => pasteClipboard(editorState.cursor.column, editorState.cursor.row),
    "paste-same": pasteAtOriginalPosition,
    "undo": undoLastChange,
    "update-hex": applyHexFromInspector
};


// Arrow key event handler
const ARROW_KEY_STEPS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1]
};

const isShortcut = (event, letter) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === letter


// & Convert mouse position on page canvas to character cell
function getCellFromPointer(canvas, pointerEvent) {
    const canvasBounds = canvas.getBoundingClientRect();

    // This is 0 when the canvas has now row numbers
    const gutterWidth = canvas.width - PAGE_WIDTH;

    // Convert from screen pixels (the canvas is scaled by CSS) to canvas pixels
    const canvasX = (pointerEvent.clientX - canvasBounds.left) / canvasBounds.width * canvas.width;
    const canvasY = (pointerEvent.clientY - canvasBounds.top) / canvasBounds.height * canvas.height;

    return {
        column: clampColumn(Math.floor((canvasX - gutterWidth) / CELL_WIDTH)),
        row: clampRow(Math.floor(canvasY / CELL_HEIGHT))
    };
}


// & Convert typed key to a teletext byte or null
function byteForTypedCharacter(typedCharacter) {
    const substitution = Object.entries(ENGLISH_CHARACTER_SUBS).find(([, character]) => character === typedCharacter);
    const byteValue = substitution ? Number(substitution[0]) : typedCharacter.charCodeAt(0);
    return byteValue >= FIRST_PRINTABLE_BYTE && byteValue <= LAST_BYTE ? byteValue : null;
}


// Menus, toolbar buttons, and theme
document.addEventListener("click", event => {
    const actionElement = event.target.closest("[data-action]");

    if (actionElement) {
        const actionName = actionElement.dataset.action;
        const pageIsLoaded = editorState.selectedPageIndex >= 0;
        if (menuActions[actionName] && (pageIsLoaded || actionName === "open")) menuActions[actionName]();
    }
});

elements.fileInput.addEventListener("change", async event => {
    const chosenFile = event.target.files[0];
    if (!chosenFile) return;

    event.target.value = "";
    announceStatus(`Reading ${chosenFile.name}...`);

    let decoded;

    try {
        const fileBytes = new Uint8Array(await chosenFile.arrayBuffer());
        decoded = await CaptureDecoder.loadFile(chosenFile.name.toLowerCase(), fileBytes);
    } catch (error) {
        announceStatus(`Couldn't open ${chosenFile.name}: ${error.message}`);
        return;
    }

    if (decoded.session) {
        try {
            restoreSession(decoded.session);
        } catch (error) {
            announceStatus(`Couldn't restore ${chosenFile.name}: ${error.message}`);
        }
        return;
    }

    if (!decoded.pages?.length) {
        announceStatus(`No teletext pages found in ${chosenFile.name}.`);
        return;
    }

    editorState.sourceFileName = chosenFile.name;
    if (elements.groupOption) elements.groupOption.checked = true;
    loadPages(decoded.pages);

    const versionCount = decoded.pages.reduce((total, page) => total + page.versions.length, 0);
    let summary = `Loaded ${decoded.pages.length} page(s), ${versionCount} transmitted version(s) from ${chosenFile.name}.`

    const separatedNumbers = [...new Set(editorState.groupedPages.filter(page => page.subpage).map(page => `P${page.number}`))];
    const mergedCount = editorState.decodedPages.length
        - new Set(editorState.groupedPages.map(page => `${page.number}/${page.subcode}`)).size;
    if (mergedCount > 0) summary += ` Merged ${mergedCount} damaged subcode(s) back into their pages.`;
    if (separatedNumbers.length > 0) {
        summary += ` Separated subpages sharing a subcode in ${separatedNumbers.length} page(s)`
            + (separatedNumbers.length <= 8 ? ` (${separatedNumbers.join(", ")}).` : ".");
    }

    if (decoded.stats) {
        const { damagedAddresses, damagedHeaders, parityErrors } = decoded.stats;
        summary += ` Skipped ${damagedAddresses} damaged packet(s) and ${damagedHeaders} damaged header(s); ${parityErrors} byte(s) failed the parity check.`;
    }
    announceStatus(summary);
});

// Warn before leaving the page with unsaved work
window.addEventListener("beforeunload", event => {
    if (!editorState.hasUnsavedChanges) return;
    event.preventDefault();
    event.returnValue = "";   // older browsers need this to show the prompt
});

elements.pageFilter.addEventListener("input", renderPageList);
elements.highlightMissingOptions.addEventListener("change", renderEverything);
elements.revealOption.addEventListener("change", renderEverything);

// Either switch rebuilds the page list and stays on the same page number
function rebuildPageListKeepingNumber() {
    const currentNumber = getSelectedPage()?.number;
    editorState.checkedPageKeys.clear();   // ticks belong to the old list
    editorState.lastCheckedIndex = null;
    editorState.pages = buildPageList();
    const sameNumberIndex = editorState.pages.findIndex(page => page.number === currentNumber);
    selectPage(Math.max(0, sameNumberIndex));
}
elements.splitOption?.addEventListener("change", rebuildPageListKeepingNumber);
elements.groupOption?.addEventListener("change", rebuildPageListKeepingNumber);

document.querySelectorAll('input[name="cmSet"]').forEach(radio => radio.addEventListener("change", renderCharacterMap));


// Final rendered page with cursor and editing abilities. A click puts the cursor there and dragging selects characters to copy (the cursor stays where the drag began)
let isDraggingFinalSelection = false;

elements.finalCanvas.addEventListener("pointerdown", event => {
    if (editorState.selectedPageIndex < 0) return;
    const cell = getCellFromPointer(elements.finalCanvas, event);
    editorState.cursor = cell;
    editorState.finalSelection = null;
    isDraggingFinalSelection = true;
    elements.finalCanvas.setPointerCapture(event.pointerId);
    elements.finalCanvas.focus();
    moveCursor(0, 0);
    event.preventDefault();
});

elements.finalCanvas.addEventListener("pointermove", event => {
    if (!isDraggingFinalSelection) return;
    const cell = getCellFromPointer(elements.finalCanvas, event);
    const current = editorState.finalSelection;
    if (!current && cell.column === editorState.cursor.column && cell.row === editorState.cursor.row) return;
    if (current && cell.column === current.endColumn && cell.row === current.endRow) return;

    editorState.finalSelection = { ...(current ?? singleCellSelection(editorState.cursor.column, editorState.cursor.row)), endColumn: cell.column, endRow: cell.row };
    editorState.lastSelected = "final";
    renderPageViews();
});

elements.finalCanvas.addEventListener("pointerup", () => { isDraggingFinalSelection = false; });

// Create keyboard shortcuts
elements.finalCanvas.addEventListener("keydown", event => {
    if (editorState.selectedPageIndex < 0) return;

    // CTRL/CMD + C - Copy the characters selected on the final page
    if (isShortcut(event, "c")) {
        copyFinalSelection();
        event.preventDefault();
        return;
    }

    // CTRL/CMD + A - Select the whole final page
    if (isShortcut(event, "a")) {
        editorState.finalSelection = { anchorColumn: 0, anchorRow: 0, endColumn: COLUMN_COUNT - 1, endRow: ROW_COUNT - 1 };
        editorState.lastSelected = "final";
        renderPageViews();
        event.preventDefault();
        return;
    }

    // SHIFT + arrow keys - Select from the cursor
    if (event.shiftKey && ARROW_KEY_STEPS[event.key]) {
        const [columnStep, rowStep] = ARROW_KEY_STEPS[event.key];
        const current = editorState.finalSelection ?? singleCellSelection(editorState.cursor.column, editorState.cursor.row);
        editorState.finalSelection = {
            ...current,
            endColumn: clampColumn(current.endColumn + columnStep),
            endRow: clampRow(current.endRow + rowStep)
        };
        editorState.lastSelected = "final";
        const bounds = getSelectionBounds(editorState.finalSelection);
        announceStatus(`Selected rows ${bounds.top}-${bounds.bottom}, columns ${bounds.left}-${bounds.right} of the final page.`);
        renderPageViews();
        event.preventDefault();
        return;
    }

    // CTRL/CMD + V - Paste
    if (isShortcut(event, "v")) {
        if (event.shiftKey) pasteAtOriginalPosition();
        else pasteClipboard(editorState.cursor.column, editorState.cursor.row);
        event.preventDefault();
        return;
    }

    // CTRL/CMD + Z - Undo
    if (isShortcut(event, "z")) {
        undoLastChange();
        event.preventDefault();
        return;
    }

    // Escape clears the selection and hides the paste outline
    if (event.key === "Escape") {
        editorState.finalSelection = null;
        editorState.showPastePreview = false;
        renderPageViews();
        return;
    }

    if (event.ctrlKey || event.metaKey) return;

    // Any other key edits at the cursor, so the selection goes
    if (editorState.finalSelection && !["Shift", "Alt", "Meta", "Control"].includes(event.key)) {
        editorState.finalSelection = null;
        renderPageViews();
    }


    // Moving cursor with arrow keys
    if (ARROW_KEY_STEPS[event.key]) {
        moveCursor(...ARROW_KEY_STEPS[event.key]);
        event.preventDefault();
        return;
    }


    // Delete character before cursor when the "backspace" ("delete" on Mac) key is pressed
    if (event.key === "Backspace") {
        eraseBeforeCursor();
        event.preventDefault();
        return;
    }


    // Write characters as they are typed
    if (event.key.length === 1) {
        const byteValue = byteForTypedCharacter(event.key);

        if (byteValue !== null) {
            typeCharacterAtCursor(byteValue);
            event.preventDefault();
        }
    }
});


// Select characters in compared version with mouse or keyboard
let isDraggingSelection = false;

elements.comparedCanvas.addEventListener("pointerdown", event => {
    if (editorState.selectedPageIndex < 0) return;
    const cell = getCellFromPointer(elements.comparedCanvas, event);
    editorState.selection = singleCellSelection(cell.column, cell.row);
    editorState.lastSelected = "compared";
    isDraggingSelection = true;
    elements.comparedCanvas.setPointerCapture(event.pointerId);
    elements.comparedCanvas.focus();
    renderPageViews();
    event.preventDefault();
});


// Select characters when when dragging mouse pointer
elements.comparedCanvas.addEventListener("pointermove", event => {
    if (!isDraggingSelection) return;
    const cell = getCellFromPointer(elements.comparedCanvas, event);
    const selection = editorState.selection;

    if (cell.column !== selection.endColumn || cell.row !== selection.endRow) {
        selection.endColumn = cell.column;
        selection.endRow = cell.row;
        renderPageViews();
    }
});


// Release everything when pointer is released
elements.comparedCanvas.addEventListener("pointerup", () => { isDraggingSelection = false });


// Double-click copies the selection and jumps to the final page
elements.comparedCanvas.addEventListener("dblclick", () => {
    copySelection();
    elements.finalCanvas.focus()
});


elements.comparedCanvas.addEventListener("keydown", event => {
    if (editorState.selectedPageIndex < 0) return;

    // CTRL/CMD + C - Copy
    if (isShortcut(event, "c")) {
        copySelection();
        event.preventDefault();
        return
    }

    // CTRL/CMD + A - Select all on page
    if (isShortcut(event, "a")) {
        editorState.selection = { anchorColumn: 0, anchorRow: 0, endColumn: COLUMN_COUNT - 1, endRow: ROW_COUNT - 1 };
        renderPageViews();
        event.preventDefault();
        return;
    }


    // "Escape" ("Delete" on macOS) key - Clears the selection
    if (event.key === "Escape") {
        editorState.selection = null;
        renderPageViews();
        return;
    }

    if (!ARROW_KEY_STEPS[event.key]) return;


    // Arrow keys move the selection. Using SHIFT + arrow keys will extend it
    const [columnStep, rowStep] = ARROW_KEY_STEPS[event.key];
    const currentSelection = editorState.selection ?? singleCellSelection(0, 0);
    const newColumn = clampColumn(currentSelection.endColumn + columnStep);
    const newRow = clampRow(currentSelection.endRow + rowStep);
    editorState.selection = event.shiftKey
        ? { ...currentSelection, endColumn: newColumn, endRow: newRow }
        : singleCellSelection(newColumn, newRow);

    const bounds = getSelectionBounds(editorState.selection);
    const rowRange = bounds.bottom > bounds.top ? `${bounds.top}-${bounds.bottom}` : `${bounds.top}`;
    const columnRange = bounds.right > bounds.left ? `${bounds.left}-${bounds.right}` : `${bounds.left}`;
    announceStatus(`Selected row ${rowRange}, column ${columnRange}.`);
    renderPageViews();
    event.preventDefault();
});

fitViewerFontToCell();
renderCharacterMap();
renderColorCodeButtons();
showEmptyEditor();

// Once the web font has loaded, measure it again and redraw
document.fonts?.load(VIEWER_FONT).then(() => {
    fitViewerFontToCell();
    renderCharacterMap();
    renderEverything();
}).catch(() => { });
announceStatus("Open a T42 file or saved work (Session JSON) to start.");