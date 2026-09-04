<?php
require __DIR__ . '/database.php';

$TABLES_WITH_IA_IDENTIFIERS = [
    [
        'table' => 'DaTaVizion',
        'ia_column' => 'IA_ID',
        'recovered_by_column' => 'Recovered_By',
        'title_column' => 'Program_Title',
        'date_column' => 'Date',
        'service_column' => 'Service_Name',
        'network_column' => 'Network'
    ],
    [
        'table' => 'Electra',
        'ia_column' => 'IA_ID',
        'recovered_by_column' => 'Recovered_By',
        'title_column' => 'Program_Title',
        'date_column' => 'Date',
        'service_column' => 'Service_Name',
        'network_column' => 'Network'
    ],
    [
        'table' => 'ExtraVision',
        'ia_column' => 'IA_ID',
        'recovered_by_column' => 'Recovered_By',
        'title_column' => 'Program_Title',
        'date_column' => 'Date',
        'service_column' => 'Service_Name',
        'network_column' => 'Network'
    ],
    [
        'table' => 'Keyfax',
        'ia_column' => 'IA_ID',
        'recovered_by_column' => 'Recovered_By',
        'title_column' => 'Program_Title',
        'date_column' => 'Date',
        'service_column' => 'Service_Name',
        'network_column' => 'Network'
    ],
    [
        'table' => 'NBC_Teletext',
        'ia_column' => 'IA_ID',
        'recovered_by_column' => 'Recovered_By',
        'title_column' => 'Program_Title',
        'date_column' => 'Date',
        'service_column' => 'Service_Name',
        'network_column' => 'Network'
    ],
];

$OUTPUT_DIR = __DIR__ . '/../json/teletext-image-data/';

// Skip re-fetching a manifest younger than this, unless --force is passed.
$CACHE_TTL_SECONDS = 24 * 60 * 60;

// Filenames must match one of these to be included:
const FILENAME_PATTERN = '/^(?:Record-\d+-\d+-v\d+|Page-\d+-\d+)\.(png|jpg|jpeg|gif)$/i';

const ZIP_FILENAME_PATTERN = '/\.zip$/i';

$force = in_array('--force', $argv, true);

$singleIdentifier = null;
foreach ($argv as $arg) {
    if (strpos($arg, '--identifier=') === 0) {
        $singleIdentifier = substr($arg, strlen('--identifier='));
        break;
    }
}

function logLine(string $message): void {
    fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . "] $message\n");
}

function logError(string $message): void {
    fwrite(STDERR, '[' . date('Y-m-d H:i:s') . "] ERROR: $message\n");
}

function collectIdentifierMeta(mysqli $conn, array $tables): array {
    $meta = [];

    foreach ($tables as $entry) {
        $table = $entry['table'];
        $iaColumn = $entry['ia_column'];
        $recoveredByColumn = $entry['recovered_by_column'] ?? null;
        $titleColumn = $entry['title_column'] ?? null;
        $dateColumn = $entry['date_column'] ?? null;
        $serviceColumn = $entry['service_column'] ?? null;
        $networkColumn = $entry['network_column'] ?? null;

        $selectParts = ["`$iaColumn` AS ID"];
        $selectParts[] = $recoveredByColumn ? "`$recoveredByColumn` AS Recovered_By" : "NULL AS Recovered_By";
        $selectParts[] = $titleColumn ? "`$titleColumn` AS Program_Title" : "NULL AS Program_Title";
        $selectParts[] = $dateColumn ? "`$dateColumn` AS Date" : "NULL AS Date";
        $selectParts[] = $serviceColumn ? "`$serviceColumn` AS Service_Name" : "NULL AS Service_Name";
        $selectParts[] = $networkColumn ? "`$networkColumn` AS Network" : "NULL AS Network";

        $sql = 'SELECT ' . implode(', ', $selectParts) . " FROM `$table` " . "WHERE `$iaColumn` IS NOT NULL AND `$iaColumn` != ''";

        $result = mysqli_query($conn, $sql);
        if ($result === false) {
            logError("Query failed for table `$table`, column `$iaColumn`: " . mysqli_error($conn));
            continue;
        }

        while ($row = mysqli_fetch_assoc($result)) {
            $id = $row['ID'];
            if (!isset($meta[$id])) {
                $meta[$id] = [
                    'Recovered_By' => $row['Recovered_By'],
                    'Program_Title' => $row['Program_Title'],
                    'Date' => $row['Date'],
                    'Service_Name' => $row['Service_Name'],
                    'Network' => $row['Network'],
                ];
            }
        }

        mysqli_free_result($result);
    }

    return $meta;
}

function fetchIaMetadata(string $identifier): ?array {
    $url = 'https://archive.org/metadata/' . rawurlencode($identifier);

    $response = fetchUrl($url);
    if ($response === null) {
        return null; // fetchUrl() already logged the specific failure
    }

    $data = json_decode($response, true);
    if (!is_array($data) || !isset($data['files'])) {
        logError("Malformed or empty metadata response for $identifier");
        return null;
    }

    return $data;
}

function buildImageList(string $identifier, array $files): array {
    $images = [];

    foreach ($files as $file) {
        $filename = $file['name'] ?? '';

        if (preg_match(ZIP_FILENAME_PATTERN, $filename)) {
            logLine("Expanding zip contents for $identifier/$filename...");
            $images = array_merge($images, expandZipImages($identifier, $filename));
            continue;
        }

        if (!preg_match(FILENAME_PATTERN, $filename)) {
            continue;
        }

        $images[] = [
            'filename' => $filename,
            'url' => 'https://archive.org/download/' . rawurlencode($identifier) . '/' . rawurlencode($filename),
        ];
    }

    return $images;
}

function expandZipImages(string $identifier, string $zipFilename): array {
    $images = [];
    $entries = fetchZipEntries($identifier, $zipFilename);
    logLine('Zip listing returned ' . count($entries) . ' total entrie(s) for ' . $zipFilename . '.');

    if (!empty($entries)) {
        logLine('First few entries seen: ' . implode(', ', array_slice($entries, 0, 5)));
    }

    foreach ($entries as $entryPath) {
        $baseName = basename($entryPath);
        if (!preg_match(FILENAME_PATTERN, $baseName)) {
            continue;
        }

        $images[] = [
            'filename' => $baseName,
            'url' => buildZipEntryUrl($identifier, $zipFilename, $entryPath),
        ];
    }

    logLine(count($images) . ' of ' . count($entries) . ' entries matched FILENAME_PATTERN.');

    return $images;
}

function fetchZipEntries(string $identifier, string $zipFilename): array {
    $zipUrl = 'https://archive.org/download/' . rawurlencode($identifier) . '/' . rawurlencode($zipFilename);

    $fileSize = fetchRemoteFileSize($zipUrl);
    if ($fileSize === null) {
        logError("Could not determine file size for $zipUrl — server may not support byte-range requests.");
        return [];
    }

    $tailSize = min($fileSize, 65557);
    $tail = fetchByteRange($zipUrl, $fileSize - $tailSize, $fileSize - 1);
    if ($tail === null) {
        logError("Could not fetch end-of-file region for $zipUrl");
        return [];
    }

    $eocd = locateEocd($tail);
    if ($eocd === null) {
        logError("Could not locate End Of Central Directory record for $zipUrl (unexpected zip format?)");
        return [];
    }

    if ($eocd['entryCount'] === 0xFFFF || $eocd['cdOffset'] === 0xFFFFFFFF) {
        logError("$zipUrl appears to use Zip64 (sentinel values in EOCD) — not supported by this script.");
        return [];
    }

    $centralDirectory = fetchByteRange($zipUrl, $eocd['cdOffset'], $eocd['cdOffset'] + $eocd['cdSize'] - 1);
    if ($centralDirectory === null) {
        logError("Could not fetch central directory for $zipUrl");
        return [];
    }

    $filenames = parseCentralDirectoryFilenames($centralDirectory, $eocd['entryCount']);

    return array_values(array_filter($filenames, static fn($name) => substr($name, -1) !== '/'));
}

function fetchRemoteFileSize(string $url): ?int {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HEADER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'US-Teletext-Website-GalleryExport/1.0',
        CURLOPT_RANGE => '0-0',
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($response === false || $httpCode !== 206) {
        logError("Range probe failed for $url (HTTP $httpCode)");
        return null;
    }

    if (preg_match('/^Content-Range:\s*bytes\s+\d+-\d+\/(\d+)/mi', $response, $m)) {
        return (int) $m[1];
    }

    logError("No parsable Content-Range header in response for $url");
    return null;
}

function fetchByteRange(string $url, int $start, int $end): ?string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_USERAGENT => 'US-Teletext-Website-GalleryExport/1.0',
        CURLOPT_RANGE => "$start-$end",
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);

    if ($response === false || $httpCode !== 206) {
        logError("Range request failed for $url ($start-$end): HTTP $httpCode");
        return null;
    }

    return $response;
}

function locateEocd(string $tail): ?array {
    $pos = strrpos($tail, "\x50\x4b\x05\x06");
    if ($pos === false) {
        return null;
    }

    $record = substr($tail, $pos, 22);
    if (strlen($record) < 22) {
        return null;
    }

    $fields = unpack('Vsig/vdisk/vcdDisk/ventriesDisk/ventries/VcdSize/VcdOffset/vcommentLen', $record);
    if ($fields === false) {
        return null;
    }

    return [
        'entryCount' => $fields['entries'],
        'cdSize' => $fields['cdSize'],
        'cdOffset' => $fields['cdOffset'],
    ];
}

function parseCentralDirectoryFilenames(string $buffer, int $entryCount): array {
    $filenames = [];
    $offset = 0;
    $len = strlen($buffer);

    for ($i = 0; $i < $entryCount; $i++) {
        if ($offset + 46 > $len) {
            break; // truncated relative to what the EOCD claimed — stop rather than read garbage
        }

        $header = substr($buffer, $offset, 46);
        $fields = unpack(
            'Vsig/vverMade/vverNeed/vflags/vmethod/vmodTime/vmodDate/VcrC/Vcompressed/Vuncompressed/'
            . 'vnameLen/vextraLen/vcommentLen/vdiskStart/vintAttr/VextAttr/VlocalHeaderOffset',
            $header
        );

        if ($fields === false || $fields['sig'] !== 0x02014b50) {
            break; // not a central directory header — stop parsing rather than risk garbage
        }

        $nameLen = $fields['nameLen'];
        $filenames[] = substr($buffer, $offset + 46, $nameLen);

        $offset += 46 + $nameLen + $fields['extraLen'] + $fields['commentLen'];
    }

    return $filenames;
}

function buildZipEntryUrl(string $identifier, string $zipFilename, string $entryPath): string {
    $segments = array_map('rawurlencode', explode('/', $entryPath));
    return 'https://archive.org/download/' . rawurlencode($identifier) . '/' . rawurlencode($zipFilename)
        . '/' . implode('/', $segments);
}

function fetchUrl(string $url): ?string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_USERAGENT => 'US-Teletext-Website-GalleryExport/1.0',
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);

    if ($response === false) {
        logError("Curl failed for $url: $curlError");
        return null;
    }
    if ($httpCode !== 200) {
        logError("Unexpected HTTP $httpCode for $url");
        return null;
    }

    return $response;
}

function manifestPath(string $outputDir, string $identifier): string {
    $safe = preg_replace('/[^A-Za-z0-9_\-\.]/', '_', $identifier);
    return rtrim($outputDir, '/') . "/gallery-$safe.json";
}

function shouldSkip(string $path, int $ttlSeconds, bool $force): bool {
    if ($force || !file_exists($path)) {
        return false;
    }
    return (time() - filemtime($path)) < $ttlSeconds;
}

if (!is_dir($OUTPUT_DIR)) {
    if (!mkdir($OUTPUT_DIR, 0755, true) && !is_dir($OUTPUT_DIR)) {
        logError("Could not create output directory: $OUTPUT_DIR");
        exit(1);
    }
}

if ($singleIdentifier !== null) {
    $identifiers = [$singleIdentifier];
    $identifierMeta = [];
    logLine("Single-identifier mode: testing against \"$singleIdentifier\" only, DB not queried (recovered_by/program_title will be blank).");
} else {
    if (!isset($conn) || !($conn instanceof mysqli) || mysqli_connect_errno()) {
        logError('DB connection not available — check database.php: ' . mysqli_connect_error());
        exit(1);
    }

    if (empty($TABLES_WITH_IA_IDENTIFIERS)) {
        logError('$TABLES_WITH_IA_IDENTIFIERS is empty — add table/column entries before running.');
        exit(1);
    }

    $identifierMeta = collectIdentifierMeta($conn, $TABLES_WITH_IA_IDENTIFIERS);
    $identifiers = array_keys($identifierMeta);
    logLine('Found ' . count($identifiers) . ' distinct IA identifier(s) in the DB.');
}

$built = 0;
$skipped = 0;
$failed = 0;

foreach ($identifiers as $identifier) {
    $path = manifestPath($OUTPUT_DIR, $identifier);

    if (shouldSkip($path, $CACHE_TTL_SECONDS, $force)) {
        $skipped++;
        continue;
    }

    logLine("Fetching metadata for $identifier...");
    $metadata = fetchIaMetadata($identifier);

    if ($metadata === null) {
        $failed++;
        continue;
    }

    $images = buildImageList($identifier, $metadata['files']);

    if (empty($images)) {
        logLine("No matching Record-###-###-v# files found for $identifier — skipping manifest write.");
        continue;
    }

    $manifest = [
        'identifier' => $identifier,
        'generated_at' => date('c'),
        'recovered_by' => $identifierMeta[$identifier]['Recovered_By'] ?? null,
        'program_title' => $identifierMeta[$identifier]['Program_Title'] ?? null,
        'date' => $identifierMeta[$identifier]['Date'] ?? null,
        'service' => $identifierMeta[$identifier]['Service_Name'] ?? null,
        'network' => $identifierMeta[$identifier]['Network'] ?? null,
        'images' => $images,
    ];

    $json = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if (file_put_contents($path, $json) === false) {
        logError("Failed to write manifest: $path");
        $failed++;
        continue;
    }

    logLine('Wrote ' . count($images) . " image(s) to $path");
    $built++;
}

logLine("Done. Built: $built, Skipped (cached): $skipped, Failed: $failed");
exit($failed > 0 ? 1 : 0);