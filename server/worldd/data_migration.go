package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// migrateLegacyWorldData moves the former default data directory without
// merging identities or silently replacing files in a new installation.
func migrateLegacyWorldData(legacyPath, currentPath string) error {
	legacyEntries, legacyExists, err := readMigrationDirectory(legacyPath)
	if err != nil || !legacyExists {
		return err
	}
	if len(legacyEntries) == 0 {
		return os.Remove(legacyPath)
	}

	currentEntries, currentExists, err := readMigrationDirectory(currentPath)
	if err != nil {
		return err
	}
	if currentExists {
		if len(currentEntries) != 0 {
			return fmt.Errorf("both legacy and ElseMesh data directories contain files; preserve or merge them manually, or select one with --data (%s, %s)", legacyPath, currentPath)
		}
		if err := os.Remove(currentPath); err != nil {
			return fmt.Errorf("remove empty new world data directory: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(currentPath), 0700); err != nil {
		return fmt.Errorf("create parent for migrated world data: %w", err)
	}
	if err := os.Rename(legacyPath, currentPath); err != nil {
		return fmt.Errorf("preserve existing world data from %s: %w", legacyPath, err)
	}
	if err := os.Chmod(currentPath, 0700); err != nil {
		return fmt.Errorf("secure migrated world data directory: %w", err)
	}
	return nil
}

func readMigrationDirectory(path string) ([]os.DirEntry, bool, error) {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("inspect world data directory %s: %w", path, err)
	}
	if !info.IsDir() {
		return nil, false, fmt.Errorf("world data path %s is not a directory", path)
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return nil, false, fmt.Errorf("read world data directory %s: %w", path, err)
	}
	return entries, true, nil
}
