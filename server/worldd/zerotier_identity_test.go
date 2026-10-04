package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestZeroTierIdentityMarkerPersistsAndRejectsReplacement(t *testing.T) {
	path := t.TempDir()
	if err := prepareZeroTierIdentityStorage(path); err != nil {
		t.Fatal(err)
	}
	if err := verifyZeroTierNodeID(path, 0x123456789a); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "identity.public"), []byte("public"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "identity.secret"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareZeroTierIdentityStorage(path); err != nil {
		t.Fatalf("existing identity should be reusable: %v", err)
	}
	if err := verifyZeroTierNodeID(path, 0x123456789a); err != nil {
		t.Fatalf("stable ID should be accepted: %v", err)
	}
	if err := verifyZeroTierNodeID(path, 0x123456789b); err == nil {
		t.Fatal("replacement ZeroTier node ID was accepted")
	}
	if err := os.Remove(filepath.Join(path, "identity.secret")); err != nil {
		t.Fatal(err)
	}
	if err := prepareZeroTierIdentityStorage(path); err == nil {
		t.Fatal("incomplete identity key pair was accepted")
	}
}

func TestZeroTierIdentityStorageRefusesRegenerationAfterKeyLoss(t *testing.T) {
	path := t.TempDir()
	if err := prepareZeroTierIdentityStorage(path); err != nil {
		t.Fatal(err)
	}
	if err := verifyZeroTierNodeID(path, 0x123456789a); err != nil {
		t.Fatal(err)
	}
	if err := prepareZeroTierIdentityStorage(path); err == nil {
		t.Fatal("missing identity keys did not stop replacement identity generation")
	}
}

func TestMigrateLegacyZeroTierStoragePreservesFiles(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "old", "zerotier")
	current := filepath.Join(root, "new", "zerotier")
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "identity.secret"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyZeroTierStorage(legacy, current); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(current, "identity.secret"))
	if err != nil || string(got) != "private" {
		t.Fatalf("migrated identity secret = %q, %v", got, err)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy state still exists after migration: %v", err)
	}
}
