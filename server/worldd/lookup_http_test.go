package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	dht "github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/p2p/discovery/routing"
)

func TestWorldLookupAllowsCredentialFreeCrossOriginReads(t *testing.T) {
	d := &daemon{}
	preflight := httptest.NewRecorder()
	d.handleLookup(preflight, httptest.NewRequest(http.MethodOptions, "/api/lookup", nil))
	if preflight.Code != http.StatusNoContent || preflight.Header().Get("Access-Control-Allow-Origin") != "*" || preflight.Header().Get("Access-Control-Allow-Methods") != "GET, OPTIONS" {
		t.Fatalf("lookup CORS preflight = status %d, headers %v", preflight.Code, preflight.Header())
	}

	lookup := httptest.NewRecorder()
	d.handleLookup(lookup, httptest.NewRequest(http.MethodGet, "/api/lookup?worldId=invalid", nil))
	if lookup.Code != http.StatusBadRequest || lookup.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("cross-origin lookup response = status %d, headers %v", lookup.Code, lookup.Header())
	}
}

func TestWorldLookupPrioritizesLiveBrowserHostsWithoutDuplicates(t *testing.T) {
	got := appendBrowserHostProviders(nil, []string{"browser-owner", "shared"}, 3)
	got = appendBrowserHostProviders(got, []string{"local", "shared", "dht"}, 3)
	if len(got) != 3 || got[0] != "browser-owner" || got[1] != "shared" || got[2] != "local" {
		t.Fatalf("provider order = %v", got)
	}
}

func TestWorldLookupReturnsActiveBrowserHostOwner(t *testing.T) {
	d := presenceTestDaemon(t)
	ownerKey := testKey(t)
	ownerID, err := peer.IDFromPrivateKey(ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	world := newStarterManifest("Browser-hosted test", ownerID.String())
	world.WorldID = "tw-world:browser-host-test"
	if err := d.installBrowserHost(&browserHostSession{world: world}); err != nil {
		t.Fatal(err)
	}
	dhtNode, err := dht.New(context.Background(), d.host, dht.Mode(dht.ModeClient))
	if err != nil {
		t.Fatal(err)
	}
	d.discovery = routing.NewRoutingDiscovery(dhtNode)
	t.Cleanup(func() { _ = dhtNode.Close() })
	request := httptest.NewRequest(http.MethodGet, "/api/lookup?worldId="+world.WorldID, nil)
	response := httptest.NewRecorder()
	d.handleLookup(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("browser-host lookup status=%d body=%s", response.Code, response.Body.String())
	}
	var result struct {
		WorldID   string   `json:"worldId"`
		Providers []string `json:"providers"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.WorldID != world.WorldID || len(result.Providers) == 0 || result.Providers[0] != ownerID.String() {
		t.Fatalf("lookup result did not prioritize active browser owner: %+v", result)
	}
}
