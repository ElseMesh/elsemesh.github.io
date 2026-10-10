package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/libp2p/go-libp2p/core/peer"
)

func TestVerifyBrowserHostRegistrationBindsFreshOwnerProof(t *testing.T) {
	ownerKey := testKey(t)
	ownerID, err := peer.IDFromPrivateKey(ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	world := newStarterManifest("Browser-hosted test", ownerID.String())
	world.WorldID = "tw-world:browser-host-test"
	document, err := signDocument(manifestProtocol, world, ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	nonce := "unique-challenge"
	proof, err := ownerKey.Sign(browserHostProofMessage(world.WorldID, nonce))
	if err != nil {
		t.Fatal(err)
	}
	frame := browserHostFrame{Type: "host.register", WorldID: world.WorldID, Document: &document, Proof: base64.RawStdEncoding.EncodeToString(proof)}
	decoded, err := verifyBrowserHostRegistration(frame, nonce, time.Now())
	if err != nil || decoded.OwnerPeerID != ownerID.String() {
		t.Fatalf("valid owner proof rejected: owner=%s err=%v", decoded.OwnerPeerID, err)
	}
	if _, err := verifyBrowserHostRegistration(frame, "different-challenge", time.Now()); err == nil {
		t.Fatal("proof for a previous challenge was accepted")
	}
	frame.Proof = base64.RawStdEncoding.EncodeToString(make([]byte, 64))
	if _, err := verifyBrowserHostRegistration(frame, nonce, time.Now()); err == nil {
		t.Fatal("invalid owner signature was accepted")
	}
}

func TestBrowserHostReverseGatewayServesManifestAndBoundedAssets(t *testing.T) {
	gateway := presenceTestDaemon(t)
	ownerKey := testKey(t)
	ownerID, err := peer.IDFromPrivateKey(ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	world := newStarterManifest("Browser-hosted test", ownerID.String())
	world.WorldID = "tw-world:browser-host-test"
	assetBytes := []byte("browser-host-asset")
	digest := sha256.Sum256(assetBytes)
	assetID := fmt.Sprintf("sha256:%x", digest)
	world.Assets = []assetRef{{ID: assetID, Bytes: int64(len(assetBytes)), Kind: "glb", Priority: "visible"}}
	document, err := signDocument(manifestProtocol, world, ownerKey)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/browser-host", gateway.handleBrowserHost)
	mux.HandleFunc("/gateway", gateway.handleBrowserGateway)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	base.Scheme = "ws"
	hostURL := *base
	hostURL.Path = "/browser-host"
	hostConn, _, err := websocket.DefaultDialer.Dial(hostURL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = hostConn.Close() })
	_ = hostConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var challenge browserHostFrame
	if err := hostConn.ReadJSON(&challenge); err != nil || challenge.Type != "host.challenge" || challenge.Nonce == "" {
		t.Fatalf("invalid host challenge: %+v err=%v", challenge, err)
	}
	proof, err := ownerKey.Sign(browserHostProofMessage(world.WorldID, challenge.Nonce))
	if err != nil {
		t.Fatal(err)
	}
	registration := browserHostFrame{Type: "host.register", WorldID: world.WorldID, Document: &document, Proof: base64.RawStdEncoding.EncodeToString(proof)}
	if err := hostConn.WriteJSON(registration); err != nil {
		t.Fatal(err)
	}
	var registered browserHostFrame
	if err := hostConn.ReadJSON(&registered); err != nil || registered.Type != "host.registered" || registered.WorldID != world.WorldID {
		t.Fatalf("host registration failed: %+v err=%v", registered, err)
	}

	guestURL := *base
	guestURL.Path = "/gateway"
	guestConn, _, err := websocket.DefaultDialer.Dial(guestURL.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = guestConn.Close() })
	_ = guestConn.SetReadDeadline(time.Now().Add(3 * time.Second))
	if err := guestConn.WriteJSON(gatewayMessage{Type: "connect", WorldID: world.WorldID, TargetPeerID: ownerID.String()}); err != nil {
		t.Fatal(err)
	}
	var connected map[string]any
	if err := guestConn.ReadJSON(&connected); err != nil || connected["type"] != "connected" {
		t.Fatalf("guest could not connect to active browser host: %+v err=%v", connected, err)
	}
	session := gateway.browserHostSession(world.WorldID, ownerID.String())
	if session == nil {
		t.Fatal("authenticated browser host was not registered")
	}
	if _, err := gateway.gatewayRequest(context.Background(), gatewayMessage{Type: "manifest.get", WorldID: world.WorldID, TargetPeerID: ownerID.String()}); err == nil {
		t.Fatal("gateway accepted a browser-host request without a request ID")
	}
	if err := guestConn.WriteJSON(gatewayMessage{Type: "manifest.get", WorldID: world.WorldID, RequestID: "manifest-1"}); err != nil {
		t.Fatal(err)
	}
	var manifestReply peerResponse
	if err := guestConn.ReadJSON(&manifestReply); err != nil || manifestReply.Type != "manifest" || manifestReply.Document == nil || manifestReply.Document.Signer != ownerID.String() {
		t.Fatalf("gateway did not serve owner-signed manifest: %+v err=%v", manifestReply, err)
	}
	request := gatewayMessage{Type: "asset.get", WorldID: world.WorldID, RequestID: "asset-1", AssetID: assetID, Offset: 0, Length: int64(len(assetBytes))}
	if err := guestConn.WriteJSON(request); err != nil {
		t.Fatal(err)
	}
	var hostRequest browserHostFrame
	if err := hostConn.ReadJSON(&hostRequest); err != nil || hostRequest.Type != "host.request" || hostRequest.Request == nil || hostRequest.Request.AssetID != assetID {
		t.Fatalf("gateway did not forward declared asset request: %+v err=%v", hostRequest, err)
	}
	chunk := peerResponse{Type: "asset.chunk", WorldID: world.WorldID, RequestID: hostRequest.RequestID, AssetID: assetID, Offset: 0, Total: int64(len(assetBytes)), Chunk: base64.RawStdEncoding.EncodeToString(assetBytes)}
	if err := hostConn.WriteJSON(browserHostFrame{Type: "host.response", WorldID: world.WorldID, RequestID: hostRequest.RequestID, Response: &chunk}); err != nil {
		t.Fatal(err)
	}
	var assetReply peerResponse
	if err := guestConn.ReadJSON(&assetReply); err != nil || assetReply.Type != "asset.chunk" || assetReply.Chunk != chunk.Chunk {
		t.Fatalf("gateway did not relay browser-host asset: %+v err=%v", assetReply, err)
	}
	if _, err := gateway.gatewayRequest(context.Background(), gatewayMessage{Type: "asset.get", WorldID: world.WorldID, TargetPeerID: ownerID.String(), RequestID: "bad-range", AssetID: assetID, Offset: 0, Length: 192 << 10}); err == nil {
		t.Fatal("gateway accepted an asset range longer than the declared asset")
	}
	if err := hostConn.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("browser host session did not close after disconnect")
	}
	if gateway.browserHostSession(world.WorldID, ownerID.String()) != nil {
		t.Fatal("disconnected browser host remained discoverable")
	}
}
