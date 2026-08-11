<?php
// Run via CLI: php export_json.php
// Dumps the full Teletext table to a JSON file for a static front end.

require __DIR__ . '/database.php'; // reuse existing $conn setup

if (!$conn) {
    fwrite(STDERR, "Connection failed: " . mysqli_connect_error() . "\n");
    exit(1);
}

$sql = "SELECT Year, Month, Date, Time, Affiliate, Program_Title, Tape_Type, ZIP, Download_Link
        FROM Teletext
        ORDER BY Year,
        FIELD(Month,
        'January','February','March','April','May','June',
        'July','August','September','October','November','December'), Date";

$result = mysqli_query($conn, $sql);
if (!$result) {
    fwrite(STDERR, "Query failed: " . mysqli_error($conn) . "\n");
    exit(1);
}

$rows = [];
while ($row = mysqli_fetch_assoc($result)) {
    $rows[] = $row;
}

$outputPath = __DIR__ . '/teletext_data.json';
file_put_contents($outputPath, json_encode($rows, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

echo "Exported " . count($rows) . " rows to $outputPath\n";