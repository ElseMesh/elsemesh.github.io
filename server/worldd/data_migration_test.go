package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrateLegacyWorldDataPreservesFilesAndIdentity(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "tidewater", "worldd")
	current := filepath.Join(root, "elsemesh", "worldd")
	if err := os.MkdirAll(filepath.Join(legacy, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "node.key"), []byte("stable owner identity"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "assets", "world.glb"), []byte("world asset"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyWorldData(legacy, current); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{
		"node.key":         "stable owner identity",
		"assets/world.glb": "world asset",
	} {
		got, err := os.ReadFile(filepath.Join(current, name))
		if err != nil || string(got) != want {
			t.Errorf("migrated %s = %q, %v; want %q", name, got, err, want)
		}
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy data path still exists after migration: %v", err)
	}
	info, err := os.Stat(current)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0700 {
		t.Fatalf("migrated directory mode = %04o; want 0700", info.Mode().Perm())
	}
}

func TestMigrateLegacyWorldDataRefusesTwoPopulatedDirectories(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "tidewater", "worldd")
	current := filepath.Join(root, "elsemesh", "worldd")
	for path, contents := range map[string]string{
		filepath.Join(legacy, "node.key"):  "legacy identity",
		filepath.Join(current, "node.key"): "current identity",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrateLegacyWorldData(legacy, current); err == nil {
		t.Fatal("migration silently merged two populated world data directories")
	}
	for path, want := range map[string]string{
		filepath.Join(legacy, "node.key"):  "legacy identity",
		filepath.Join(current, "node.key"): "current identity",
	} {
		got, err := os.ReadFile(path)
		if err != nil || string(got) != want {
			t.Errorf("conflicting file %s changed to %q, %v", path, got, err)
		}
	}
}

func TestMigrateLegacyWorldDataUsesSourceWhenDestinationIsEmpty(t *testing.T) {
	root := t.TempDir()
	legacy := filepath.Join(root, "tidewater", "worldd")
	current := filepath.Join(root, "elsemesh", "worldd")
	if err := os.MkdirAll(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "node.key"), []byte("identity"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(current, 0700); err != nil {
		t.Fatal(err)
	}
	if err := migrateLegacyWorldData(legacy, current); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(current, "node.key")); err != nil {
		t.Fatalf("legacy identity was not moved: %v", err)
	}
}
