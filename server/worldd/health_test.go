package main

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestHealthNamesLibp2pPeerCountAndKeepsLegacyAlias(t *testing.T) {
	d := presenceTestDaemon(t)
	recorder := httptest.NewRecorder()
	d.handleHealth(recorder, httptest.NewRequest("GET", "/healthz", nil))

	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode health response: %v", err)
	}
	if got := response["libp2pPeers"]; got != float64(0) {
		t.Fatalf("libp2pPeers = %v, want 0", got)
	}
	if got := response["dhtPeers"]; got != response["libp2pPeers"] {
		t.Fatalf("legacy dhtPeers alias = %v, libp2pPeers = %v", got, response["libp2pPeers"])
	}
}
