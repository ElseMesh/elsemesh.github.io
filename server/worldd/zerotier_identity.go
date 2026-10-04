package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// prepareZeroTierIdentityStorage prevents an initialized installation from
// silently creating a replacement identity if libzt's persistent key files
// are removed or damaged.
func prepareZeroTierIdentityStorage(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return fmt.Errorf("create ZeroTier identity directory: %w", err)
	}
	if err := os.Chmod(path, 0700); err != nil {
		return fmt.Errorf("secure ZeroTier identity directory: %w", err)
	}
	publicExists, err := fileExists(filepath.Join(path, "identity.public"))
	if err != nil {
		return err
	}
	secretExists, err := fileExists(filepath.Join(path, "identity.secret"))
	if err != nil {
		return err
	}
	markerExists, err := fileExists(filepath.Join(path, "elsemesh-node-id"))
	if err != nil {
		return err
	}
	if publicExists != secretExists {
		return errors.New("ZeroTier identity key pair is incomplete; restore both identity.public and identity.secret from backup")
	}
	if secretExists {
		if err := os.Chmod(filepath.Join(path, "identity.secret"), 0600); err != nil {
			return fmt.Errorf("secure ZeroTier private identity key: %w", err)
		}
	}
	if markerExists && !publicExists {
		return errors.New("ZeroTier identity keys are missing; refusing to generate a replacement identity (restore the zerotier state directory from backup)")
	}
	return nil
}

func migrateLegacyZeroTierStorage(legacyPath, currentPath string) error {
	currentExists, err := fileExists(currentPath)
	if err != nil {
		return err
	}
	if currentExists {
		for _, name := range []string{"identity.public", "identity.secret", "elsemesh-node-id"} {
			exists, statErr := fileExists(filepath.Join(currentPath, name))
			if statErr != nil || exists {
				return statErr
			}
		}
		if err := os.Remove(currentPath); err != nil {
			return fmt.Errorf("remove empty ZeroTier state directory before migration: %w", err)
		}
	}
	legacyExists, err := fileExists(legacyPath)
	if err != nil || !legacyExists {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(currentPath), 0700); err != nil {
		return fmt.Errorf("create parent for migrated ZeroTier identity: %w", err)
	}
	if err := os.Rename(legacyPath, currentPath); err != nil {
		return fmt.Errorf("preserve existing ZeroTier identity from %s: %w", legacyPath, err)
	}
	if err := os.Chmod(currentPath, 0700); err != nil {
		return fmt.Errorf("secure migrated ZeroTier identity directory: %w", err)
	}
	return nil
}

func verifyZeroTierNodeID(path string, nodeID uint64) error {
	markerPath := filepath.Join(path, "elsemesh-node-id")
	marker := fmt.Sprintf("%010x\n", nodeID)
	contents, err := os.ReadFile(markerPath)
	if err == nil {
		if strings.TrimSpace(string(contents)) != strings.TrimSpace(marker) {
			return fmt.Errorf("libzt identity changed: stored node ID %q, current node ID %010x; refusing to continue", strings.TrimSpace(string(contents)), nodeID)
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read ZeroTier node ID marker: %w", err)
	}
	f, err := os.OpenFile(markerPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		if !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("persist ZeroTier node ID marker: %w", err)
		}
		contents, readErr := os.ReadFile(markerPath)
		if readErr != nil {
			return fmt.Errorf("read concurrently persisted ZeroTier node ID marker: %w", readErr)
		}
		if strings.TrimSpace(string(contents)) != strings.TrimSpace(marker) {
			return errors.New("concurrent libzt startup detected a different ZeroTier identity in the shared state directory")
		}
		return nil
	}
	if _, err = f.WriteString(marker); err != nil {
		_ = f.Close()
		_ = os.Remove(markerPath)
		return fmt.Errorf("write ZeroTier node ID marker: %w", err)
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync ZeroTier node ID marker: %w", err)
	}
	if err = f.Close(); err != nil {
		return fmt.Errorf("close ZeroTier node ID marker: %w", err)
	}
	return nil
}

func fileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}
