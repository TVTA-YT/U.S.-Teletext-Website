<?php
// Created August 12, 2026, 23:52

// * This tracks the "first seen" date of each record by ID across runs

function trackFirstSeen(array $rows, string $trackerPath, string $idField = 'UUID', int $windowDays = 7): array {
    $tracker = [];

    if (file_exists($trackerPath)) {
        $decoded = json_decode(file_get_contents($trackerPath), true);
        if (is_array($decoded)) {
            $tracker = $decoded;
        }
    }

    $now = time();
    $windowSeconds = $windowDays * 24 * 60 * 60;
    $seenIdsThisRun = [];

    foreach ($rows as &$row) {
        $id = $row[$idField] ?? null;
        if ($id === null) {
            $row['IsNew'] = false;
            continue;
        }

        $seenIdsThisRun[$id] = true;

        if (!isset($tracker[$id])) {
            // Never seen before — record its first-seen timestamp now.
            $tracker[$id] = $now;
        }

        $row['IsNew'] = ($now - $tracker[$id]) <= $windowSeconds;
    }
    unset($row);

    // Prune tracker entries for records that no longer exist in the table at all (deleted rows).
    $tracker = array_intersect_key($tracker, $seenIdsThisRun);

    $trackerDir = dirname($trackerPath);
    if (!is_dir($trackerDir)) {
        mkdir($trackerDir, 0755, true);
    }
    file_put_contents($trackerPath, json_encode($tracker, JSON_PRETTY_PRINT));

    return $rows;
}