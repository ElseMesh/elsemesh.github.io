package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

type testZeroTierPathQuerier struct {
	peerID uint64
	paths  []string
}

func (q *testZeroTierPathQuerier) PhysicalPeerPaths(peerID uint64) ([]string, error) {
	q.peerID = peerID
	return q.paths, nil
}

func TestParseZeroTierPeerID(t *testing.T) {
	got, err := parseZeroTierPeerID("0000abc123")
	if err != nil || got != 0xabc123 {
		t.Fatalf("parseZeroTierPeerID() = %#x, %v", got, err)
	}
	for _, value := range []string{"", "abc123", "0000000000", "10000000000", "00000000xz"} {
		if _, err := parseZeroTierPeerID(value); err == nil {
			t.Errorf("parseZeroTierPeerID(%q) unexpectedly succeeded", value)
		}
	}
}

func TestIsLoopbackListenAddress(t *testing.T) {
	for address, want := range map[string]bool{
		"127.0.0.1:5200": true,
		"[::1]:5200":     true,
		"localhost:5200": false,
		":5200":          false,
		"0.0.0.0:5200":   false,
		"192.0.2.1:5200": false,
	} {
		if got := isLoopbackListenAddress(address); got != want {
			t.Errorf("isLoopbackListenAddress(%q) = %v, want %v", address, got, want)
		}
	}
}

func TestZeroTierPathHandlerIsLoopbackOnlyAndReturnsFreshPaths(t *testing.T) {
	query := &testZeroTierPathQuerier{paths: []string{"198.51.100.7/43123", "2001:db8::7/43124"}}
	handler := zeroTierPathHandler(query)
	request := httptest.NewRequest(http.MethodGet, "/debug/zerotier/paths?peerId=0000abc123", nil)
	request.Host = "127.0.0.1:5200"
	request.RemoteAddr = "127.0.0.1:43210"
	response := httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", response.Code, response.Body)
	}
	if query.peerID != 0xabc123 {
		t.Fatalf("queried peer ID = %#x", query.peerID)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
	var body struct {
		PeerID string   `json:"peerId"`
		Paths  []string `json:"paths"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.PeerID != "0000abc123" || !reflect.DeepEqual(body.Paths, query.paths) {
		t.Fatalf("response = %+v", body)
	}

	request = httptest.NewRequest(http.MethodGet, "/debug/zerotier/paths?peerId=0000abc123", nil)
	request.RemoteAddr = "192.0.2.4:43210"
	response = httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("non-loopback request status = %d, want 403", response.Code)
	}
	if query.peerID != 0xabc123 {
		t.Fatal("non-loopback request reached the libzt query")
	}

	request = httptest.NewRequest(http.MethodGet, "/debug/zerotier/paths?peerId=invalid", nil)
	request.Host = "127.0.0.1:5200"
	request.RemoteAddr = "127.0.0.1:43210"
	response = httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid peer request status = %d, want 400", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/debug/zerotier/paths?peerId=0000abc123", nil)
	request.Host = "world.example.org"
	request.RemoteAddr = "127.0.0.1:43210"
	response = httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("proxied public-host request status = %d, want 403", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/debug/zerotier/paths?peerId=0000abc123", nil)
	request.Host = "127.0.0.1:5200"
	request.RemoteAddr = "127.0.0.1:43210"
	request.Header.Set("X-Forwarded-For", "198.51.100.8")
	response = httptest.NewRecorder()
	handler(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("forwarded request status = %d, want 403", response.Code)
	}
}
