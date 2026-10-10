package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	crypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

func TestChromiumWorldConnectorUsesDirectWebRTC(t *testing.T) {
	chromium, err := exec.LookPath("chromium")
	if err != nil {
		chromium, err = exec.LookPath("chromium-browser")
	}
	if err != nil {
		t.Skip("Chromium is not installed")
	}
	key, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	targetHost, err := libp2p.New(libp2p.Identity(key), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	defer targetHost.Close()
	gatewayKey, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatewayHost, err := libp2p.New(libp2p.Identity(gatewayKey), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	defer gatewayHost.Close()
	world := newStarterManifest("Chromium WebRTC integration", targetHost.ID().String())
	assetData := []byte("direct-webrtc-asset-content")
	assetDigest := sha256.Sum256(assetData)
	assetID := "sha256:" + hex.EncodeToString(assetDigest[:])
	world.Assets = []assetRef{{ID: assetID, Bytes: int64(len(assetData)), Kind: "test", Priority: "visible"}}
	document, err := signDocument(manifestProtocol, world, key)
	if err != nil {
		t.Fatal(err)
	}
	assetsDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(assetsDir, strings.TrimPrefix(assetID, "sha256:")), assetData, 0600); err != nil {
		t.Fatal(err)
	}
	target := &daemon{ctx: context.Background(), host: targetHost, manifest: document, world: world, key: key, assetsDir: assetsDir, authorityChanged: make(chan struct{}, 1), webrtcSessions: make(map[string]*worldRTCSession)}
	targetHost.SetStreamHandler(worldProtocol, target.handlePeerStream)
	if err := gatewayHost.Connect(context.Background(), peer.AddrInfo{ID: targetHost.ID(), Addrs: targetHost.Addrs()}); err != nil {
		t.Fatal(err)
	}
	gateway := &daemon{ctx: context.Background(), host: gatewayHost, manifest: document, world: world}
	mux := http.NewServeMux()
	mux.HandleFunc("/gateway", gateway.handleBrowserGateway)
	repoRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	mux.Handle("/src/", http.StripPrefix("/src/", http.FileServer(http.Dir(filepath.Join(repoRoot, "src")))))
	mux.HandleFunc("/webrtc-test", func(w http.ResponseWriter, _ *http.Request) {
		worldIDJSON, _ := json.Marshal(world.WorldID)
		nodeIDJSON, _ := json.Marshal(targetHost.ID().String())
		assetIDJSON, _ := json.Marshal(assetID)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><body>WAIT<script type="module">
import { WorldConnector } from '/src/network/WorldConnector.js';
const connector = new WorldConnector({worldId:%s,nodeId:%s,gateway:location.origin});
try {
  const manifest = await connector.getManifest();
  const data = await connector.getAsset(%s);
  const direct = connector.rtcChannel?.readyState === 'open' && connector.rtcPeerConnection?.connectionState === 'connected';
  connector.rtcPeerConnection?.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const fallbackManifest = await connector.getManifest();
  const fallback = fallbackManifest.worldId === manifest.worldId && connector.rtcChannel?.readyState !== 'open';
  document.body.textContent = direct && fallback && data.length === %d ? 'PASS direct WebRTC and gateway fallback' : 'FAIL direct or fallback transport';
  connector.close();
} catch (error) { document.body.textContent = 'FAIL ' + String(error); }
</script></body>`, worldIDJSON, nodeIDJSON, assetIDJSON, len(assetData))
	})
	server := httptest.NewServer(mux)
	defer server.Close()
	profileDir, err := os.MkdirTemp("/var/tmp", "elsemesh-chromium-webrtc-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(profileDir)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, chromium, "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-proxy-server", "--disable-background-networking", "--user-data-dir="+profileDir, "--virtual-time-budget=30000", "--dump-dom", server.URL+"/webrtc-test")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("run Chromium direct-WebRTC page: %v\n%s", err, output)
	}
	if !strings.Contains(string(output), "PASS direct WebRTC and gateway fallback") {
		t.Fatalf("Chromium did not complete direct WebRTC manifest and asset retrieval:\n%s", output)
	}
}
