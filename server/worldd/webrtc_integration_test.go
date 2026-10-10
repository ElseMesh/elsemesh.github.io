package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	libp2p "github.com/libp2p/go-libp2p"
	crypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/pion/webrtc/v4"
)

func TestBrowserWebRTCDataChannelServesSignedManifest(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	key, _, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	host, err := libp2p.New(libp2p.Identity(key), libp2p.ListenAddrStrings("/ip4/127.0.0.1/tcp/0"))
	if err != nil {
		t.Fatal(err)
	}
	defer host.Close()
	world := newStarterManifest("WebRTC integration", host.ID().String())
	document, err := signDocument(manifestProtocol, world, key)
	if err != nil {
		t.Fatal(err)
	}
	d := &daemon{ctx: ctx, host: host, manifest: document, world: world, key: key, authorityChanged: make(chan struct{}, 1), webrtcSessions: make(map[string]*worldRTCSession)}
	server := httptest.NewServer(http.HandlerFunc(d.handleBrowserGateway))
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/gateway", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	_ = ws.SetReadDeadline(time.Now().Add(15 * time.Second))
	if err := ws.WriteJSON(gatewayMessage{Type: "connect", WorldID: world.WorldID}); err != nil {
		t.Fatal(err)
	}
	var connected map[string]any
	if err := ws.ReadJSON(&connected); err != nil || connected["type"] != "connected" {
		t.Fatalf("gateway connect: %v (%v)", connected, err)
	}

	client, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	channel, err := client.CreateDataChannel("elsemesh-world-v1", &webrtc.DataChannelInit{Ordered: ptrBool(true)})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{}, 1)
	channel.OnOpen(func() { opened <- struct{}{} })
	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(client)
	if err := client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gatherComplete:
	case <-ctx.Done():
		t.Fatal("client ICE gathering timed out")
	}
	if err := ws.WriteJSON(gatewayMessage{Type: "webrtc.offer", WorldID: world.WorldID, TargetPeerID: host.ID().String(), RequestID: "rtc-offer", PresenceSession: "11111111111111111111111111111111", SDP: client.LocalDescription().SDP}); err != nil {
		t.Fatal(err)
	}
	var answer peerResponse
	if err := ws.ReadJSON(&answer); err != nil {
		t.Fatal(err)
	}
	if answer.Type != "webrtc.answer" || answer.WorldID != world.WorldID || answer.RequestID != "rtc-offer" {
		t.Fatalf("unexpected WebRTC answer: %+v", answer)
	}
	if err := client.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-ctx.Done():
		t.Fatal("WebRTC data channel did not open")
	}

	responses := make(chan peerResponse, 1)
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		var response peerResponse
		if json.Unmarshal(message.Data, &response) == nil {
			responses <- response
		}
	})
	request, _ := json.Marshal(gatewayMessage{Type: "manifest.get", WorldID: world.WorldID, RequestID: "rtc-manifest"})
	if err := channel.Send(request); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-responses:
		if response.Type != "manifest" || response.WorldID != world.WorldID || response.RequestID != "rtc-manifest" || response.Document == nil {
			t.Fatalf("unexpected direct manifest response: %+v", response)
		}
		if err := verifyDocument(*response.Document, manifestProtocol); err != nil {
			t.Fatalf("direct response signature invalid: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("WebRTC manifest request timed out")
	}
	closed := make(chan struct{}, 1)
	channel.OnClose(func() { closed <- struct{}{} })
	if err := channel.Send(request); err != nil {
		t.Fatalf("send duplicate request: %v", err)
	}
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("server did not close the data channel after a duplicate request ID")
	}
}

func ptrBool(value bool) *bool { return &value }
