<?php
// Created August 11, 2026, 14:33

require __DIR__ . '/database.php';
require __DIR__ . '/track-first-seen.php';

if (!$conn) {
    fwrite(STDERR, "Connection failed: " . mysqli_connect_error() . "\n");
    exit(1);
}

// New entires will be marked for 7 days
const NEW_WINDOW_DAYS = 7;

/* One entry per table. ExtraVision and NBC Teletext will share
the same columns.
*/
$sharedColumns = "ID, Year, Month, Date, Time, Affiliate, Program_Title, Tape_Type, Tape_Speed, Download_Link, Thumbnail, Network, Service_Name, Notes, Date_Added";
$sharedOrderBy = "Year, FIELD(Month,
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
), Date";

// Published files will go here
$jsonDirectory = dirname(__DIR__) . '/json';

// This is not read by the front end, mainly bookkeeping
$trackerDirectory = dirname(__DIR__) . '/.trackers';

$exports = [
    [
        'table'      =>  'ExtraVision',
        'idField'    =>  'ID',
        'columns'    =>  $sharedColumns,
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/extravision_data.json',
        'trackerFile' => $trackerDirectory . '/extravision_data.json',
    ],
    [
        'table'      =>  'NBC_Teletext',
        'idField'    =>  'ID',
        'columns'    =>  $sharedColumns,
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/nbc_teletext_data.json',
        'trackerFile' => $trackerDirectory . '/nbc_teletext_data.json',
    ],
    [
        'table'      => 'Electra',
        'idField'    => 'ID',
        'columns'    => "ID, Year, Month, Date, Time, Program_Title, Tape_Type, Tape_Speed, Download_Link, Thumbnail, Network, Service_Name, Notes, Date_Added",
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/electra_data.json',
        'trackerFile' => $trackerDirectory . '/electra_data.json',

    ],
    [
        'table'      => 'KET_AgText',
        'idField'    => 'ID',
        'columns'    => "ID, Year, Month, Date, Affiliate, Program_Title, Tape_Type, Tape_Speed, HTML_Link, Network, Service_Name, Notes, Date_Added",
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/ket_agtext_data.json',
        'trackerFile' => $trackerDirectory . '/ket_agtext_data.json',

    ],
    [
        'table'      => 'ABC_PLUS',
        'idField'    => 'ID',
        'columns'    => "ID, Year, Month, Date, Affiliate, Program_Title, Tape_Type, Tape_Speed, TEXT1, TEXT2, Network, Service_Name, Notes, Date_Added",
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/abc_plus_data.json',
        'trackerFile' => $trackerDirectory . '/abc_plus_data.json',

    ],
    [
        'table'      => 'Wis_Infotext',
        'idField'    => 'ID',
        'columns'    => "ID, Year, Month, Date, Program_Title, Tape_Type, Tape_Speed, TEXT1, TEXT2, Network, Service_Name, Notes, Date_Added",
        'orderBy'    =>  $sharedOrderBy,
        'outputFile' =>  $jsonDirectory . '/wisconsin_infotext_data.json',
        'trackerFile' => $trackerDirectory . '/wisconsin_infotext_data.json',

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

    $rows = trackFirstSeen($rows, $export['trackerFile'], $export['idField'], NEW_WINDOW_DAYS);

    // Diff against the OLD file before it gets overwritten below.

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