package main

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	maxWebRTCOffers           = 32
	maxWebRTCOffersPerSession = 1
	maxWebRTCSDPBytes         = 64 << 10
	maxWebRTCMessageBytes     = 2 << 20
	maxWebRTCRequests         = 3
	webRTCSetupTimeout        = 15 * time.Second
)

type worldRTCSession struct {
	id              string
	worldID         string
	gatewayPeerID   string
	presenceSession string
	peer            *webrtc.PeerConnection
	requests        chan struct{}
	requestMu       sync.Mutex
	requestIDs      map[string]struct{}
	writeMu         sync.Mutex
	idleMu          sync.Mutex
	idleTimer       *time.Timer
	closeOnce       sync.Once
}

func validateSTUNServerURLs(values []string) error {
	for _, value := range values {
		parsed, err := url.Parse(value)
		if err != nil || (parsed.Scheme != "stun" && parsed.Scheme != "stuns") || parsed.Opaque == "" && parsed.Host == "" || parsed.User != nil || strings.ContainsAny(value, " \t\r\n") {
			return fmt.Errorf("invalid --webrtc-stun-server %q: expected a stun: or stuns: URL", value)
		}
	}
	return nil
}

func validateWebRTCPortRange(minimum, maximum uint) error {
	if minimum < 1 || maximum > 65535 || maximum < minimum || maximum-minimum+1 < maxWebRTCOffers {
		return fmt.Errorf("WebRTC UDP port range must contain at least %d ports", maxWebRTCOffers)
	}
	return nil
}

func (d *daemon) webrtcICEServers() []webrtc.ICEServer {
	if len(d.webrtcSTUNServers) == 0 {
		return nil
	}
	return []webrtc.ICEServer{{URLs: append([]string(nil), d.webrtcSTUNServers...)}}
}

func (d *daemon) acceptWebRTCOffer(request gatewayMessage) (peerResponse, error) {
	if request.gatewayPeerID == "" || request.PresenceSession == "" {
		return peerResponse{}, errors.New("webrtc_signaling_session_required")
	}
	if len(request.SDP) == 0 || len(request.SDP) > maxWebRTCSDPBytes {
		return peerResponse{}, errors.New("webrtc_offer_size_invalid")
	}
	d.webrtcMu.Lock()
	if d.webrtcSessions == nil {
		d.webrtcSessions = make(map[string]*worldRTCSession)
	}
	if len(d.webrtcSessions) >= maxWebRTCOffers {
		d.webrtcMu.Unlock()
		return peerResponse{}, errors.New("webrtc_offer_limit_reached")
	}
	peerSessions := 0
	for _, active := range d.webrtcSessions {
		if active.gatewayPeerID == request.gatewayPeerID && active.presenceSession == request.PresenceSession {
			peerSessions++
		}
	}
	if peerSessions >= maxWebRTCOffersPerSession {
		d.webrtcMu.Unlock()
		return peerResponse{}, errors.New("webrtc_session_offer_limit_reached")
	}
	var idBytes [16]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		d.webrtcMu.Unlock()
		return peerResponse{}, err
	}
	id := fmt.Sprintf("%x", idBytes[:])
	session := &worldRTCSession{
		id: id, worldID: request.WorldID, gatewayPeerID: request.gatewayPeerID,
		presenceSession: request.PresenceSession, requests: make(chan struct{}, maxWebRTCRequests), requestIDs: make(map[string]struct{}),
	}
	session.idleTimer = time.AfterFunc(2*time.Minute, func() { d.closeWebRTCSession(session) })
	d.webrtcSessions[id] = session
	d.webrtcMu.Unlock()

	settingEngine := webrtc.SettingEngine{}
	portMin, portMax := d.webrtcUDPPortMin, d.webrtcUDPPortMax
	if portMin == 0 && portMax == 0 {
		portMin, portMax = 42950, 43049
	}
	if err := settingEngine.SetEphemeralUDPPortRange(portMin, portMax); err != nil {
		d.closeWebRTCSession(session)
		return peerResponse{}, fmt.Errorf("configure WebRTC UDP ports: %w", err)
	}
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))
	configuration := webrtc.Configuration{ICEServers: d.webrtcICEServers()}
	peerConnection, err := api.NewPeerConnection(configuration)
	if err != nil {
		d.closeWebRTCSession(session)
		return peerResponse{}, fmt.Errorf("create WebRTC peer: %w", err)
	}
	session.peer = peerConnection
	peerConnection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			d.closeWebRTCSession(session)
		}
	})
	var channelMu sync.Mutex
	channelAccepted := false
	peerConnection.OnDataChannel(func(channel *webrtc.DataChannel) {
		channelMu.Lock()
		if channelAccepted {
			channelMu.Unlock()
			_ = channel.Close()
			return
		}
		channelAccepted = true
		channelMu.Unlock()
		if channel.Label() != "elsemesh-world-v1" || channel.Ordered() == false {
			_ = channel.Close()
			return
		}
		channel.OnMessage(func(message webrtc.DataChannelMessage) {
			d.handleWebRTCRequest(session, channel, message.Data)
		})
	})

	setupTimer := time.AfterFunc(webRTCSetupTimeout, func() { d.closeWebRTCSession(session) })
	defer setupTimer.Stop()
	if err := peerConnection.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: request.SDP}); err != nil {
		d.closeWebRTCSession(session)
		return peerResponse{}, fmt.Errorf("apply WebRTC offer: %w", err)
	}
	answer, err := peerConnection.CreateAnswer(nil)
	if err != nil {
		d.closeWebRTCSession(session)
		return peerResponse{}, fmt.Errorf("create WebRTC answer: %w", err)
	}
	gatherComplete := webrtc.GatheringCompletePromise(peerConnection)
	if err := peerConnection.SetLocalDescription(answer); err != nil {
		d.closeWebRTCSession(session)
		return peerResponse{}, fmt.Errorf("set WebRTC answer: %w", err)
	}
	select {
	case <-gatherComplete:
	case <-time.After(webRTCSetupTimeout):
		d.closeWebRTCSession(session)
		return peerResponse{}, errors.New("WebRTC ICE gathering timed out")
	}
	local := peerConnection.LocalDescription()
	if local == nil || len(local.SDP) == 0 || len(local.SDP) > maxWebRTCSDPBytes {
		d.closeWebRTCSession(session)
		return peerResponse{}, errors.New("WebRTC answer size invalid")
	}
	return peerResponse{Type: "webrtc.answer", WorldID: request.WorldID, RequestID: request.RequestID, SDP: local.SDP}, nil
}

func (d *daemon) handleWebRTCRequest(session *worldRTCSession, channel *webrtc.DataChannel, data []byte) {
	if len(data) == 0 || len(data) > maxWebRTCMessageBytes {
		_ = channel.Close()
		return
	}
	select {
	case session.requests <- struct{}{}:
	default:
		_ = channel.Close()
		return
	}
	go func() {
		defer func() { <-session.requests }()
		var request gatewayMessage
		if err := json.Unmarshal(data, &request); err != nil || request.RequestID == "" || len(request.RequestID) > 128 || request.WorldID != session.worldID {
			_ = channel.Close()
			return
		}
		session.requestMu.Lock()
		_, duplicate := session.requestIDs[request.RequestID]
		limitExceeded := len(session.requestIDs) >= 8192
		if !duplicate && !limitExceeded {
			session.requestIDs[request.RequestID] = struct{}{}
		}
		session.requestMu.Unlock()
		if duplicate || limitExceeded {
			_ = channel.Close()
			return
		}
		session.idleMu.Lock()
		if session.idleTimer != nil {
			session.idleTimer.Reset(2 * time.Minute)
		}
		session.idleMu.Unlock()
		switch request.Type {
		case "manifest.get", "role-revocations.get", "asset.get", "presence.update", "presence.leave":
		default:
			_ = channel.Close()
			return
		}
		bindPresenceRequest(&request, session.gatewayPeerID, session.presenceSession)
		response, err := d.localRequest(request)
		if err != nil {
			response = peerResponse{Type: "error", WorldID: session.worldID, RequestID: request.RequestID, Error: err.Error()}
		}
		encoded, err := json.Marshal(response)
		if err != nil || len(encoded) > maxWebRTCMessageBytes {
			_ = channel.Close()
			return
		}
		session.writeMu.Lock()
		defer session.writeMu.Unlock()
		if channel.ReadyState() == webrtc.DataChannelStateOpen {
			_ = channel.Send(encoded)
		}
	}()
}

func (d *daemon) closeWebRTCSession(session *worldRTCSession) {
	if session == nil {
		return
	}
	session.closeOnce.Do(func() {
		d.webrtcMu.Lock()
		delete(d.webrtcSessions, session.id)
		d.webrtcMu.Unlock()
		session.idleMu.Lock()
		if session.idleTimer != nil {
			session.idleTimer.Stop()
		}
		session.idleMu.Unlock()
		if session.peer != nil {
			_ = session.peer.Close()
		}
	})
}
