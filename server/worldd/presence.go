package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
)

const playerPresenceProtocol = "elsemesh.player-presence/2"
const legacyPlayerPresenceProtocol = "elsemesh.player-presence/1"
const maxPresencePlayers = 128
const presenceTTL = 10 * time.Second
const downeastBoatTriangles = 46845 // tidewater.downeast-boat/1 complexity contract

var presenceSessionPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var presenceColorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)

type avatarAppearance struct {
	Style    string `json:"style"`
	Shirt    string `json:"shirt"`
	Trousers string `json:"trousers"`
	Skin     string `json:"skin"`
	Hair     string `json:"hair"`
}
type playerPose struct {
	Protocol     string           `json:"protocol"`
	Sequence     uint64           `json:"sequence"`
	Position     []float64        `json:"position"`
	Yaw          float64          `json:"yaw"`
	Pitch        float64          `json:"pitch"`
	Moving       bool             `json:"moving"`
	Mode         string           `json:"mode"`
	VehicleSpeed *float64         `json:"vehicleSpeed,omitempty"`
	Appearance   avatarAppearance `json:"appearance"`
}
type playerPresence struct {
	ID string `json:"id"`
	playerPose
	UpdatedAt int64 `json:"updatedAt"`
	updated   time.Time
}

func newPresenceSession() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes[:]), nil
}
func presenceKey(gatewayID, session string) string {
	digest := sha256.Sum256([]byte(gatewayID + ":" + session))
	return "player:" + hex.EncodeToString(digest[:])
}
func validatePlayerPose(p *playerPose) error {
	if p == nil || (p.Protocol != playerPresenceProtocol && p.Protocol != legacyPlayerPresenceProtocol) || p.Sequence > 9007199254740991 || len(p.Position) != 3 {
		return errors.New("invalid_presence_pose")
	}
	for _, v := range p.Position {
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 100000 {
			return errors.New("invalid_presence_position")
		}
	}
	if math.IsNaN(p.Yaw) || math.IsInf(p.Yaw, 0) || math.Abs(p.Yaw) > 1000 || math.IsNaN(p.Pitch) || math.IsInf(p.Pitch, 0) || math.Abs(p.Pitch) > 1.5 {
		return errors.New("invalid_presence_orientation")
	}
	if p.Mode != "walk" && p.Mode != "swim" && p.Mode != "deck" && p.Mode != "boat" {
		return errors.New("invalid_presence_mode")
	}
	if p.Mode == "boat" || p.Mode == "deck" {
		if p.Protocol != playerPresenceProtocol {
			return errors.New("vehicle_presence_protocol_upgrade_required")
		}
		if p.VehicleSpeed == nil || math.IsNaN(*p.VehicleSpeed) || math.IsInf(*p.VehicleSpeed, 0) || *p.VehicleSpeed < 0 || *p.VehicleSpeed > 100 {
			return errors.New("invalid_vehicle_speed")
		}
	} else if p.Protocol == playerPresenceProtocol && p.VehicleSpeed != nil {
		return errors.New("unexpected_vehicle_speed")
	}
	if p.Appearance.Style != "male" && p.Appearance.Style != "female" {
		return errors.New("invalid_avatar_style")
	}
	for _, color := range []string{p.Appearance.Shirt, p.Appearance.Trousers, p.Appearance.Skin, p.Appearance.Hair} {
		if !presenceColorPattern.MatchString(color) {
			return errors.New("invalid_avatar_color")
		}
	}
	return nil
}

func (d *daemon) validateVehiclePresence(p *playerPose) error {
	if p.Mode != "boat" && p.Mode != "deck" {
		return nil
	}
	policy := d.world.Rules.VehiclePolicy
	if policy == nil || !policy.Enabled {
		return errors.New("vehicle_not_allowed")
	}
	if policy.MaxSpeed == nil || policy.MaxCombinedComplexity == nil {
		return errors.New("vehicle_policy_invalid")
	}
	if *p.VehicleSpeed > *policy.MaxSpeed+0.01 {
		return errors.New("vehicle_speed_exceeded")
	}
	hasBoat := false
	for _, component := range d.world.Components {
		if component.Type == "tidewater.downeast-boat/1" {
			hasBoat = true
			break
		}
	}
	if !hasBoat {
		return errors.New("vehicle_unsupported")
	}
	if uint64(d.world.Rules.AvatarComplexity)+downeastBoatTriangles > uint64(*policy.MaxCombinedComplexity) {
		return errors.New("vehicle_complexity_exceeded")
	}
	return nil
}

func (d *daemon) presenceRequest(request gatewayMessage, now time.Time) (peerResponse, error) {
	if d.world.OwnerPeerID != d.host.ID().String() {
		return peerResponse{}, errors.New("presence_owner_required")
	}
	if request.presenceKey == "" {
		return peerResponse{}, errors.New("presence_session_required")
	}
	if request.Type != "presence.update" && request.Type != "presence.leave" {
		return peerResponse{}, errors.New("unsupported_presence_request")
	}
	if request.Type == "presence.update" {
		if err := validatePlayerPose(request.Pose); err != nil {
			return peerResponse{}, err
		}
		if err := d.validateVehiclePresence(request.Pose); err != nil {
			return peerResponse{}, err
		}
	}
	d.presenceMu.Lock()
	defer d.presenceMu.Unlock()
	if d.players == nil {
		d.players = make(map[string]playerPresence)
	}
	for id, p := range d.players {
		if now.Sub(p.updated) >= presenceTTL {
			delete(d.players, id)
		}
	}
	if request.Type == "presence.leave" {
		delete(d.players, request.presenceKey)
	} else {
		old, exists := d.players[request.presenceKey]
		if exists && request.Pose.Sequence <= old.Sequence {
			return peerResponse{}, errors.New("stale_presence_sequence")
		}
		if !exists && len(d.players) >= maxPresencePlayers {
			return peerResponse{}, errors.New("presence_full")
		}
		if exists && now.Sub(old.updated) < 50*time.Millisecond {
			return peerResponse{}, errors.New("presence_rate_limited")
		}
		d.players[request.presenceKey] = playerPresence{ID: request.presenceKey, playerPose: *request.Pose, UpdatedAt: now.UnixMilli(), updated: now}
	}
	players := make([]playerPresence, 0, len(d.players))
	for _, p := range d.players {
		players = append(players, p)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	return peerResponse{Type: "presence", WorldID: d.world.WorldID, RequestID: request.RequestID, PlayerID: request.presenceKey, Players: players}, nil
}

// The browser cannot choose a session ID: its gateway overwrites the field.
// Peer forwarding namespaces that session with the authenticated libp2p peer.
func bindPresenceRequest(message *gatewayMessage, gatewayID, session string) {
	message.PresenceSession = ""
	message.presenceKey = ""
	if strings.HasPrefix(message.Type, "presence.") && presenceSessionPattern.MatchString(session) {
		message.PresenceSession = session
		message.presenceKey = presenceKey(gatewayID, session)
	}
}
func (d *daemon) leaveBrowserPresence(worldID, targetPeerID, session string) {
	request := gatewayMessage{Type: "presence.leave", WorldID: worldID, TargetPeerID: targetPeerID, RequestID: "presence-close"}
	bindPresenceRequest(&request, d.host.ID().String(), session)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = d.gatewayRequest(ctx, request)
}
