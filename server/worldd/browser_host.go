package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	crypto "github.com/libp2p/go-libp2p/core/crypto"
)

const (
	browserHostProtocol      = "elsemesh.browser-host/1"
	browserHostProofDomain   = "elsemesh.browser-host/1\n"
	browserHostConnectWindow = 15 * time.Second
	browserHostIdleWindow    = 45 * time.Second
	browserHostRequestWindow = 20 * time.Second
	maxBrowserHostMessage    = 2 << 20
	maxBrowserHostSessions   = 128
	maxBrowserHostsPerWorld  = 4
	maxBrowserHostRequests   = 32
)

type browserHostFrame struct {
	Type      string          `json:"type"`
	WorldID   string          `json:"worldId,omitempty"`
	Nonce     string          `json:"nonce,omitempty"`
	Document  *signedDocument `json:"document,omitempty"`
	Proof     string          `json:"proof,omitempty"`
	RequestID string          `json:"requestId,omitempty"`
	Request   *gatewayMessage `json:"request,omitempty"`
	Response  *peerResponse   `json:"response,omitempty"`
	Error     string          `json:"error,omitempty"`
}

type browserHostPending struct {
	response chan peerResponse
}

type browserHostSession struct {
	world    worldManifest
	document signedDocument
	conn     *websocket.Conn
	writeMu  sync.Mutex
	mu       sync.Mutex
	pending  map[string]browserHostPending
	closed   chan struct{}
	close    sync.Once
}

func browserHostProofMessage(worldID, nonce string) []byte {
	return []byte(browserHostProofDomain + worldID + "\n" + nonce)
}

func verifyBrowserHostRegistration(frame browserHostFrame, nonce string, now time.Time) (worldManifest, error) {
	if frame.Type != "host.register" || frame.Document == nil || !worldIDPattern.MatchString(frame.WorldID) {
		return worldManifest{}, errors.New("invalid_browser_host_registration")
	}
	manifest, err := decodeManifest(*frame.Document, frame.Document.Signer, now)
	if err != nil || manifest.WorldID != frame.WorldID {
		return worldManifest{}, errors.New("invalid_browser_host_manifest")
	}
	publicKeyBytes, err := base64.RawStdEncoding.DecodeString(frame.Document.PublicKey)
	if err != nil {
		return worldManifest{}, errors.New("invalid_browser_host_public_key")
	}
	publicKey, err := crypto.UnmarshalPublicKey(publicKeyBytes)
	if err != nil {
		return worldManifest{}, errors.New("invalid_browser_host_public_key")
	}
	proof, err := base64.RawStdEncoding.DecodeString(frame.Proof)
	if err != nil {
		return worldManifest{}, errors.New("invalid_browser_host_proof")
	}
	valid, err := publicKey.Verify(browserHostProofMessage(frame.WorldID, nonce), proof)
	if err != nil || !valid {
		return worldManifest{}, errors.New("invalid_browser_host_proof")
	}
	return manifest, nil
}

func (d *daemon) handleBrowserHost(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(request *http.Request) bool {
		return browserGatewayOriginAllowed(request.Header.Get("Origin"), request.Host, request.TLS != nil, d.allowedBrowserOrigins)
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(maxBrowserHostMessage)
	_ = conn.SetReadDeadline(time.Now().Add(browserHostConnectWindow))
	var nonceBytes [32]byte
	if _, err := rand.Read(nonceBytes[:]); err != nil {
		_ = conn.WriteJSON(browserHostFrame{Type: "error", Error: "challenge_unavailable"})
		return
	}
	nonce := base64.RawURLEncoding.EncodeToString(nonceBytes[:])
	if err := conn.WriteJSON(browserHostFrame{Type: "host.challenge", Nonce: nonce}); err != nil {
		return
	}
	var registration browserHostFrame
	if err := conn.ReadJSON(&registration); err != nil {
		return
	}
	world, err := verifyBrowserHostRegistration(registration, nonce, time.Now())
	if err != nil {
		_ = conn.WriteJSON(browserHostFrame{Type: "error", Error: err.Error()})
		return
	}
	session := &browserHostSession{world: world, document: *registration.Document, conn: conn, pending: make(map[string]browserHostPending), closed: make(chan struct{})}
	if err := d.installBrowserHost(session); err != nil {
		_ = conn.WriteJSON(browserHostFrame{Type: "error", Error: err.Error()})
		return
	}
	defer d.removeBrowserHost(session)
	if err := conn.WriteJSON(browserHostFrame{Type: "host.registered", WorldID: world.WorldID}); err != nil {
		return
	}
	conn.SetReadLimit(512 << 10)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(browserHostIdleWindow))
		var frame browserHostFrame
		if err := conn.ReadJSON(&frame); err != nil {
			return
		}
		switch frame.Type {
		case "host.heartbeat":
			if frame.WorldID != world.WorldID {
				return
			}
		case "host.response":
			if frame.Response == nil || frame.RequestID == "" || frame.Response.WorldID != world.WorldID || frame.Response.RequestID != frame.RequestID {
				return
			}
			session.deliver(frame.RequestID, *frame.Response)
		default:
			return
		}
	}
}

func (d *daemon) installBrowserHost(session *browserHostSession) error {
	key := browserHostKey(session.world.WorldID, session.world.OwnerPeerID)
	d.browserHostsMu.Lock()
	if d.browserHosts == nil {
		d.browserHosts = make(map[string]*browserHostSession)
	}
	previous := d.browserHosts[key]
	if previous == nil {
		worldHosts := 0
		for _, active := range d.browserHosts {
			if active.world.WorldID == session.world.WorldID {
				worldHosts++
			}
		}
		if len(d.browserHosts) >= maxBrowserHostSessions || worldHosts >= maxBrowserHostsPerWorld {
			d.browserHostsMu.Unlock()
			return errors.New("browser_host_capacity_reached")
		}
	}
	d.browserHosts[key] = session
	d.browserHostsMu.Unlock()
	if previous != nil {
		previous.shutdown(errors.New("browser_host_replaced"))
	}
	return nil
}

func (d *daemon) removeBrowserHost(session *browserHostSession) {
	key := browserHostKey(session.world.WorldID, session.world.OwnerPeerID)
	d.browserHostsMu.Lock()
	if d.browserHosts[key] == session {
		delete(d.browserHosts, key)
	}
	d.browserHostsMu.Unlock()
	session.shutdown(errors.New("browser_host_disconnected"))
}

func browserHostKey(worldID, ownerPeerID string) string { return worldID + "\n" + ownerPeerID }

func (d *daemon) browserHostSession(worldID, ownerPeerID string) *browserHostSession {
	d.browserHostsMu.RLock()
	session := d.browserHosts[browserHostKey(worldID, ownerPeerID)]
	d.browserHostsMu.RUnlock()
	return session
}

func (d *daemon) browserHostProviders(worldID string) []string {
	d.browserHostsMu.RLock()
	providers := make([]string, 0, 2)
	for _, session := range d.browserHosts {
		if session.world.WorldID == worldID {
			providers = append(providers, session.world.OwnerPeerID)
		}
	}
	d.browserHostsMu.RUnlock()
	sort.Strings(providers)
	return providers
}

func (s *browserHostSession) request(ctx context.Context, request gatewayMessage) (peerResponse, error) {
	if request.WorldID != s.world.WorldID {
		return peerResponse{}, errors.New("world_not_hosted")
	}
	if request.RequestID == "" || len(request.RequestID) > 128 {
		return peerResponse{}, errors.New("invalid_request_id")
	}
	if request.Type == "manifest.get" {
		return peerResponse{Type: "manifest", WorldID: request.WorldID, RequestID: request.RequestID, Document: &s.document}, nil
	}
	if request.Type != "asset.get" {
		return peerResponse{}, errors.New("unsupported_browser_host_request")
	}
	var asset *assetRef
	for i := range s.world.Assets {
		if s.world.Assets[i].ID == request.AssetID {
			asset = &s.world.Assets[i]
			break
		}
	}
	if asset == nil {
		return peerResponse{}, errors.New("asset_not_in_manifest")
	}
	if request.Offset < 0 || request.Length < 1 || request.Length > 192<<10 || request.Offset > asset.Bytes || request.Length > asset.Bytes-request.Offset {
		return peerResponse{}, errors.New("invalid_asset_range")
	}
	response := make(chan peerResponse, 1)
	s.mu.Lock()
	select {
	case <-s.closed:
		s.mu.Unlock()
		return peerResponse{}, errors.New("browser_host_unavailable")
	default:
	}
	if _, exists := s.pending[request.RequestID]; exists {
		s.mu.Unlock()
		return peerResponse{}, errors.New("duplicate_request_id")
	}
	if len(s.pending) >= maxBrowserHostRequests {
		s.mu.Unlock()
		return peerResponse{}, errors.New("browser_host_busy")
	}
	s.pending[request.RequestID] = browserHostPending{response: response}
	s.mu.Unlock()
	defer s.finishRequest(request.RequestID)
	if err := s.write(browserHostFrame{Type: "host.request", WorldID: request.WorldID, RequestID: request.RequestID, Request: &request}); err != nil {
		return peerResponse{}, err
	}
	timer := time.NewTimer(browserHostRequestWindow)
	defer timer.Stop()
	select {
	case result := <-response:
		if result.Type == "error" {
			return peerResponse{}, errors.New(result.Error)
		}
		if result.Type != "asset.chunk" || result.AssetID != request.AssetID || result.Offset != request.Offset || result.Total != asset.Bytes {
			return peerResponse{}, errors.New("browser_host_response_mismatch")
		}
		chunk, err := base64.RawStdEncoding.DecodeString(result.Chunk)
		if err != nil || int64(len(chunk)) != request.Length {
			return peerResponse{}, errors.New("browser_host_chunk_size_mismatch")
		}
		return result, nil
	case <-s.closed:
		return peerResponse{}, errors.New("browser_host_unavailable")
	case <-ctx.Done():
		return peerResponse{}, ctx.Err()
	case <-timer.C:
		return peerResponse{}, errors.New("browser_host_request_timeout")
	}
}

func (s *browserHostSession) write(frame browserHostFrame) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = s.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return s.conn.WriteJSON(frame)
}

func (s *browserHostSession) deliver(requestID string, response peerResponse) {
	s.mu.Lock()
	request, ok := s.pending[requestID]
	if ok {
		delete(s.pending, requestID)
	}
	s.mu.Unlock()
	if ok {
		request.response <- response
	}
}

func (s *browserHostSession) finishRequest(requestID string) {
	s.mu.Lock()
	delete(s.pending, requestID)
	s.mu.Unlock()
}

func (s *browserHostSession) shutdown(reason error) {
	s.close.Do(func() {
		close(s.closed)
		s.mu.Lock()
		pending := s.pending
		s.pending = make(map[string]browserHostPending)
		s.mu.Unlock()
		for _, request := range pending {
			request.response <- peerResponse{Type: "error", Error: fmt.Sprint(reason)}
		}
		_ = s.conn.Close()
	})
}
