<?php
// Created August 11, 2026, 14:32
function markNewRecords(array $rows, string $previousJsonPath, string $idField = 'ID'): array {
    $previousIds = [];

    if (file_exists($previousJsonPath)) {
        $previousData = json_decode(file_get_contents($previousJsonPath), true);
        if (is_array($previousData)) {
            foreach ($previousData as $row) {
                if (isset($row[$idField])) {
                    $previousIds[$row[$idField]] = true;
                }
            }
        }
    }
    // Note: if $previousJsonPath doesn't exist yet (first-ever run),
    // $previousIds stays empty, so every row gets IsNew = true on that
    // first run.

    foreach ($rows as &$row) {
        $row['IsNew'] = isset($row[$idField]) && !isset($previousIds[$row[$idField]]);
    }
    unset($row);

    return $rows;
}