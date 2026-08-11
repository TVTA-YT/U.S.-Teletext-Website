<?php
// Created August 11, 2026, 14:33

require __DIR__ . '/database.php';
require __DIR__ . '/new-records.php';

if (!$conn) {
    fwrite(STDERR, "Connection failed: " . mysqli_connect_error() . "\n");
    exit(1);
}

/* One entry per table. ExtraVision and NBC Teletext will share
the same columns.
*/
$sharedColumns = "ID, Year, Month, Date, Time, Affiliate, Program_Title, Tape_Type, ZIP, Download_Link";
$sharedOrderBy = "Year, FIELD(Month,
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
), Date";

$exports = [
    [
        'table'      => 'ExtraVision',
        'idField'    => 'ID',
        'columns'    => $sharedColumns,
        'orderBy'    => $sharedOrderBy,
        'outputFile' => __DIR__ . '/../json/extravision_data.json',
    ],
    [
        'table'      => 'NBC_Teletext',
        'idField'    => 'ID',
        'columns'    => $sharedColumns,
        'orderBy'    => $sharedOrderBy,
        'outputFile' => __DIR__ . '/../json/nbc_teletext_data.json',
    ],
    [
        'table'      => 'Electra',
        'idField'    => 'ID',
        'columns'    => "ID, Year, Month, Date, Time, Program_Title, Tape_Type, ZIP, Download_Link",
        'orderBy'    => "Year, FIELD(Month,
            'January','February','March','April','May','June',
            'July','August','September','October','November','December'
        ), Date",
        'outputFile' => __DIR__ . '/../json/electra_data.json',
    ],
];

foreach ($exports as $export) {
    exportTable($conn, $export);
}

function exportTable(mysqli $conn, array $export): void {
    $sql = "SELECT {$export['columns']} FROM {$export['table']} ORDER BY {$export['orderBy']}";

    $result = mysqli_query($conn, $sql);
    if (!$result) {
        fwrite(STDERR, "Query failed for {$export['table']}: " . mysqli_error($conn) . "\n");
        return; // Don't let one table's failure stop the others
    }

    $rows = [];
    while ($row = mysqli_fetch_assoc($result)) {
        $rows[] = $row;
    }

    // Diff against the OLD file before it gets overwritten below.
    $rows = markNewRecords($rows, $export['outputFile'], $export['idField']);

    $outputDir = dirname($export['outputFile']);
    if (!is_dir($outputDir)) {
        mkdir($outputDir, 0755, true);
    }

    file_put_contents(
        $export['outputFile'],
        json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)
    );

    $newCount = count(array_filter($rows, fn($r) => $r['IsNew']));
    echo "{$export['table']}: exported " . count($rows) . " rows to {$export['outputFile']} ($newCount new)\n";
}