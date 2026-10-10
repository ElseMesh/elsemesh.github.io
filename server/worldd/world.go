package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strings"
	"time"

	crypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

const (
	manifestProtocol  = "tidewater.world/1"
	authorityProtocol = "tidewater.authority/2"
	maxManifestBytes  = 1 << 20
	maxAssetBytes     = 2 << 30
	maxSafeJSInteger  = uint64(9007199254740991)
	maxCollisionBoxes = 2048
)

var (
	worldIDPattern           = regexp.MustCompile(`^tw-world:[a-zA-Z0-9._-]{1,128}$`)
	objectIDPattern          = regexp.MustCompile(`^tw-object:[\w.-]{1,128}$`)
	portalIDPattern          = regexp.MustCompile(`^tw-portal:[\w.-]{1,128}$`)
	componentIDPattern       = regexp.MustCompile(`^tw-component:[\w.-]{1,128}$`)
	assetIDPattern           = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	sourceContentHashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	worldFeaturePattern      = regexp.MustCompile(`^tidewater\.[a-z0-9.-]+/\d+$`)
)

type vector3 [3]float64
type vector4 [4]float64

type transform struct {
	Position vector3  `json:"position"`
	Yaw      float64  `json:"yaw"`
	Rotation *vector4 `json:"rotation,omitempty"`
}

type streamingBounds struct {
	Center vector3 `json:"center"`
	Radius float64 `json:"radius"`
}

type assetRef struct {
	ID       string `json:"id"`
	Bytes    int64  `json:"bytes"`
	Kind     string `json:"kind"`
	Priority string `json:"priority"`
	Path     string `json:"path,omitempty"`
}

type objectLOD struct {
	AssetID           string  `json:"assetId"`
	MaxScreenFraction float64 `json:"maxScreenFraction"`
}

func (level *objectLOD) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if len(fields) != 2 || fields["assetId"] == nil || fields["maxScreenFraction"] == nil {
		return errors.New("object LOD requires only assetId and maxScreenFraction")
	}
	type plainLOD objectLOD
	return json.Unmarshal(data, (*plainLOD)(level))
}

type worldObject struct {
	LODs             []objectLOD      `json:"lods,omitempty"`
	ID               string           `json:"id"`
	Kind             string           `json:"kind"`
	Label            string           `json:"label"`
	AssetID          string           `json:"assetId"`
	Priority         string           `json:"priority,omitempty"`
	ReplacesObjectID string           `json:"replacesObjectId,omitempty"`
	StreamingBounds  *streamingBounds `json:"streamingBounds,omitempty"`
	Transform        transform        `json:"transform"`
	Scale            vector3          `json:"scale"`
	Collision        struct {
		Shape       string         `json:"shape"`
		Enabled     bool           `json:"enabled"`
		Center      vector3        `json:"center"`
		HalfExtents vector3        `json:"halfExtents"`
		Boxes       []collisionBox `json:"boxes,omitempty"`
		Columns     uint32         `json:"columns"`
		Rows        uint32         `json:"rows"`
		Walkable    bool           `json:"walkable"`
		Solid       bool           `json:"solid"`
	} `json:"collision"`
}

type collisionBox struct {
	Center      vector3 `json:"center"`
	HalfExtents vector3 `json:"halfExtents"`
	Yaw         float64 `json:"yaw"`
	Walkable    bool    `json:"walkable"`
	Solid       bool    `json:"solid"`
}

type portalBack struct {
	Destination string    `json:"destinationWorldId"`
	PeerID      string    `json:"destinationPeerId,omitempty"`
	Gateway     string    `json:"destinationGateway,omitempty"`
	Exit        transform `json:"exit"`
	OpenView    bool      `json:"openView"`
	Enabled     bool      `json:"enabled"`
}

func (side *portalBack) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if fields == nil {
		return errors.New("portal back must be an object")
	}
	for key := range fields {
		switch key {
		case "destinationWorldId", "destinationPeerId", "destinationGateway", "exit", "openView", "enabled":
		default:
			return fmt.Errorf("unsupported portal back field %q", key)
		}
	}
	for _, key := range []string{"destinationWorldId", "exit", "openView", "enabled"} {
		if raw, ok := fields[key]; !ok || strings.TrimSpace(string(raw)) == "null" {
			return fmt.Errorf("portal back requires %s", key)
		}
	}
	var exitFields map[string]json.RawMessage
	if err := json.Unmarshal(fields["exit"], &exitFields); err != nil {
		return err
	}
	if len(exitFields) != 2 || exitFields["position"] == nil || exitFields["yaw"] == nil {
		return errors.New("portal back exit requires only position and yaw")
	}
	for _, raw := range exitFields {
		if strings.TrimSpace(string(raw)) == "null" {
			return errors.New("portal back exit values cannot be null")
		}
	}
	var coordinates []json.RawMessage
	if err := json.Unmarshal(exitFields["position"], &coordinates); err != nil || len(coordinates) != 3 {
		return errors.New("portal back exit position requires three coordinates")
	}
	for _, raw := range coordinates {
		if strings.TrimSpace(string(raw)) == "null" {
			return errors.New("portal back coordinate cannot be null")
		}
	}
	type plain portalBack
	return json.Unmarshal(data, (*plain)(side))
}

type portal struct {
	Back        *portalBack `json:"back,omitempty"`
	ID          string      `json:"id"`
	Destination string      `json:"destinationWorldId"`
	PeerID      string      `json:"destinationPeerId,omitempty"`
	Gateway     string      `json:"destinationGateway,omitempty"`
	Visual      string      `json:"visual,omitempty"`
	Entry       transform   `json:"entry"`
	Exit        transform   `json:"exit"`
	OpenView    bool        `json:"openView"`
	Enabled     bool        `json:"enabled"`
}

func (p *portal) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if raw, ok := fields["back"]; ok && strings.TrimSpace(string(raw)) == "null" {
		return errors.New("portal back must be an object")
	}
	type plain portal
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*p = portal(decoded)
	return nil
}

// A present LOD declaration must be an array; null is not an absent declaration.
func (object *worldObject) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	if raw, present := fields["lods"]; present && strings.TrimSpace(string(raw)) == "null" {
		return errors.New("object LOD list cannot be null")
	}
	type plainObject worldObject
	return json.Unmarshal(data, (*plainObject)(object))
}

type worldComponent struct {
	ID               string           `json:"id"`
	Type             string           `json:"type"`
	ObjectID         string           `json:"objectId,omitempty"`
	Seed             uint32           `json:"seed,omitempty"`
	Priority         string           `json:"priority,omitempty"`
	PlacementAssetID string           `json:"placementAssetId,omitempty"`
	DataAssetID      string           `json:"dataAssetId,omitempty"`
	StreamingBounds  *streamingBounds `json:"streamingBounds,omitempty"`
	Center           []float64        `json:"center,omitempty"`
	Extent           float64          `json:"extent,omitempty"`
	Profile          string           `json:"profile,omitempty"`
	Beds             []audioBed       `json:"beds,omitempty"`
}

type audioBed struct {
	AssetID     string   `json:"assetId"`
	Gain        float64  `json:"gain"`
	Condition   string   `json:"condition,omitempty"`
	Position    *vector3 `json:"position,omitempty"`
	RefDistance *float64 `json:"refDistance,omitempty"`
	Rolloff     *float64 `json:"rolloff,omitempty"`
}

func (bed *audioBed) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for key := range fields {
		if key != "assetId" && key != "gain" && key != "condition" && key != "position" && key != "refDistance" && key != "rolloff" {
			return fmt.Errorf("unknown field %q in ambient audio bed", key)
		}
	}
	if fields["assetId"] == nil || fields["gain"] == nil {
		return errors.New("ambient audio bed requires assetId and gain")
	}
	if rawPosition, exists := fields["position"]; exists {
		var position []float64
		if err := json.Unmarshal(rawPosition, &position); err != nil || len(position) != 3 {
			return errors.New("ambient audio bed position must contain three coordinates")
		}
	}
	type plain audioBed
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*bed = audioBed(decoded)
	return nil
}

func (component *worldComponent) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	var typeName string
	if err := json.Unmarshal(fields["type"], &typeName); err != nil {
		return errors.New("world component has no valid type")
	}
	allowed := map[string]bool{"id": true, "type": true, "priority": true}
	switch typeName {
	case "tidewater.procedural-island-vegetation/1":
		allowed["seed"], allowed["placementAssetId"] = true, true
	case "tidewater.static-vegetation/1":
		allowed["placementAssetId"] = true
	case "tidewater.static-reef/1":
		allowed["placementAssetId"] = true
	case "tidewater.island-ocean/1":
	case "tidewater.procedural-island-terrain/1":
		allowed["objectId"], allowed["profile"] = true, true
	case "tidewater.terrain-surface/1":
		allowed["objectId"], allowed["profile"], allowed["dataAssetId"] = true, true, true
	case "tidewater.water-body/1":
		allowed["center"], allowed["extent"], allowed["profile"] = true, true, true
	case "tidewater.ambient-audio/1":
		allowed["beds"] = true
	case "tidewater.downeast-boat/1":
		allowed["objectId"] = true
	default:
		return fmt.Errorf("unsupported world component type %q", typeName)
	}
	allowed["streamingBounds"] = true
	if rawBounds, exists := fields["streamingBounds"]; exists {
		var boundsFields map[string]json.RawMessage
		if err := json.Unmarshal(rawBounds, &boundsFields); err != nil {
			return errors.New("invalid component streaming bounds")
		}
		if len(boundsFields) != 2 || boundsFields["center"] == nil || boundsFields["radius"] == nil {
			return errors.New("component streaming bounds must contain only center and radius")
		}
		var center []float64
		var radius float64
		if err := json.Unmarshal(boundsFields["center"], &center); err != nil || len(center) != 3 {
			return errors.New("component streaming bounds center must have three coordinates")
		}
		if err := json.Unmarshal(boundsFields["radius"], &radius); err != nil {
			return errors.New("component streaming bounds radius must be numeric")
		}
	}
	for key := range fields {
		if !allowed[key] {
			return fmt.Errorf("unknown field %q in world component", key)
		}
	}
	type plain worldComponent
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*component = worldComponent(decoded)
	return nil
}

type hostingGrant struct {
	PeerID          string   `json:"peerId"`
	Scopes          []string `json:"scopes"`
	ExpiresAt       int64    `json:"expiresAt"`
	Epoch           uint64   `json:"epoch"`
	FailoverAfter   int64    `json:"failoverAfter,omitempty"`
	FailoverSeconds int64    `json:"failoverSeconds,omitempty"`
}

type worldRules struct {
	Gravity          float64        `json:"gravity"`
	SeaLevel         *float64       `json:"seaLevel,omitempty"`
	AtmosphereLevel  *float64       `json:"atmosphereLevel,omitempty"`
	AvatarComplexity uint32         `json:"avatarComplexity"`
	PhysicsProfile   string         `json:"physicsProfile"`
	Movement         *movementRules `json:"movement,omitempty"`
	VehiclePolicy    *vehiclePolicy `json:"vehiclePolicy,omitempty"`
	MaxPackageBytes  *int64         `json:"maxPackageBytes,omitempty"`
	StyleGuide       string         `json:"styleGuide,omitempty"`
	RequiredFeatures []string       `json:"requiredFeatures,omitempty"`
}

type vehiclePolicy struct {
	Enabled               bool     `json:"enabled"`
	MaxSpeed              *float64 `json:"maxSpeed,omitempty"`
	MaxCombinedComplexity *uint32  `json:"maxCombinedComplexity,omitempty"`
}

func (policy *vehiclePolicy) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return errors.New("vehicle policy must be an object")
	}
	for field := range fields {
		if field != "enabled" && field != "maxSpeed" && field != "maxCombinedComplexity" {
			return fmt.Errorf("unknown vehicle policy field %q", field)
		}
	}
	type plain vehiclePolicy
	var decoded plain
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	*policy = vehiclePolicy(decoded)
	return nil
}

type movementRules struct {
	WalkSpeed   float64 `json:"walkSpeed"`
	SprintSpeed float64 `json:"sprintSpeed"`
	JumpSpeed   float64 `json:"jumpSpeed"`
}

type worldSpawn struct {
	Position []float64 `json:"position"`
	Yaw      *float64  `json:"yaw"`
	Pitch    *float64  `json:"pitch"`
}

type worldManifest struct {
	Protocol        string           `json:"protocol"`
	WorldID         string           `json:"worldId"`
	SourceHash      string           `json:"sourceHash,omitempty"`
	OwnerPeerID     string           `json:"ownerPeerId"`
	AuthorityPeerID string           `json:"authorityPeerId"`
	AuthorityEpoch  uint64           `json:"authorityEpoch"`
	Discoverable    bool             `json:"discoverable"`
	Version         uint64           `json:"version"`
	Title           string           `json:"title"`
	Experience      *worldExperience `json:"experience,omitempty"`
	Spawn           *worldSpawn      `json:"spawn,omitempty"`
	Rules           worldRules       `json:"rules"`
	Assets          []assetRef       `json:"assets"`
	Objects         []worldObject    `json:"objects"`
	Components      []worldComponent `json:"components,omitempty"`
	Portals         []portal         `json:"portals"`
	Hosts           []hostingGrant   `json:"hosts,omitempty"`
	UpdatedAt       int64            `json:"updatedAt"`
}

type worldExperience struct {
	Genre       string            `json:"genre"`
	Tagline     string            `json:"tagline"`
	LoadingNote string            `json:"loadingNote"`
	Tips        []string          `json:"tips"`
	Stages      map[string]string `json:"stages"`
}

func validateWorldExperience(experience *worldExperience) error {
	if experience == nil {
		return nil
	}
	for name, text := range map[string]string{"genre": experience.Genre, "tagline": experience.Tagline, "loadingNote": experience.LoadingNote} {
		if strings.TrimSpace(text) == "" || len(text) > 240 {
			return fmt.Errorf("world experience %s is invalid", name)
		}
	}
	if len(experience.Tips) == 0 || len(experience.Tips) > 12 {
		return errors.New("world experience tips must contain between one and twelve entries")
	}
	for _, tip := range experience.Tips {
		if strings.TrimSpace(tip) == "" || len(tip) > 320 {
			return errors.New("world experience tip is invalid")
		}
	}
	if len(experience.Stages) > 12 {
		return errors.New("world experience has too many loading stages")
	}
	allowedStages := map[string]bool{"gpu": true, "atmosphere": true, "terrain": true, "village": true, "vegetation": true, "ocean": true, "reef": true, "simulation": true, "shaders": true, "world": true, "compile": true, "warmup": true}
	for stage, text := range experience.Stages {
		if !allowedStages[stage] || strings.TrimSpace(text) == "" || len(text) > 120 {
			return fmt.Errorf("world experience loading stage %q is invalid", stage)
		}
	}
	return nil
}

func validateManifest(manifest worldManifest, localPeerID string, now time.Time) error {
	if spawn := manifest.Spawn; spawn != nil {
		if len(spawn.Position) != 3 || spawn.Yaw == nil || spawn.Pitch == nil || math.IsNaN(*spawn.Yaw) || math.IsInf(*spawn.Yaw, 0) || math.Abs(*spawn.Yaw) > 360 || math.IsNaN(*spawn.Pitch) || math.IsInf(*spawn.Pitch, 0) || math.Abs(*spawn.Pitch) > 1.5 {
			return errors.New("invalid world spawn pose")
		}
		for _, value := range spawn.Position {
			if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > 1e6 {
				return errors.New("invalid world spawn position")
			}
		}
	}
	if manifest.Protocol != manifestProtocol || !worldIDPattern.MatchString(manifest.WorldID) || manifest.Version == 0 || manifest.Version > maxSafeJSInteger {
		return errors.New("invalid world identity or protocol")
	}
	if manifest.SourceHash != "" && !sourceContentHashPattern.MatchString(manifest.SourceHash) {
		return errors.New("invalid world source hash")
	}
	if len(manifest.Title) == 0 || len(manifest.Title) > 160 || strings.TrimSpace(manifest.Title) != manifest.Title {
		return errors.New("invalid world title")
	}
	if err := validateWorldExperience(manifest.Experience); err != nil {
		return err
	}
	if manifest.Rules.Gravity < 0.2 || manifest.Rules.Gravity > 2 || math.IsNaN(manifest.Rules.Gravity) || math.IsInf(manifest.Rules.Gravity, 0) {
		return errors.New("gravity is outside the supported range")
	}
	for name, level := range map[string]*float64{"sea level": manifest.Rules.SeaLevel, "atmosphere level": manifest.Rules.AtmosphereLevel} {
		if level != nil && (math.IsNaN(*level) || math.IsInf(*level, 0) || math.Abs(*level) > 1e6) {
			return fmt.Errorf("world %s is outside the supported range", name)
		}
	}
	if manifest.Rules.AvatarComplexity == 0 || manifest.Rules.AvatarComplexity > 100000 || len(manifest.Rules.PhysicsProfile) > 64 || len(manifest.Rules.StyleGuide) > 512 {
		return errors.New("invalid world rules")
	}
	if manifest.Rules.PhysicsProfile != "default" && manifest.Rules.PhysicsProfile != "tidewater-default" {
		return errors.New("unsupported world physics profile")
	}
	if movement := manifest.Rules.Movement; movement != nil {
		if math.IsNaN(movement.WalkSpeed) || math.IsInf(movement.WalkSpeed, 0) || movement.WalkSpeed < 0.5 || movement.WalkSpeed > 10 || math.IsNaN(movement.SprintSpeed) || math.IsInf(movement.SprintSpeed, 0) || movement.SprintSpeed < movement.WalkSpeed || movement.SprintSpeed > 15 || math.IsNaN(movement.JumpSpeed) || math.IsInf(movement.JumpSpeed, 0) || movement.JumpSpeed < 0 || movement.JumpSpeed > 10 {
			return errors.New("world movement speeds are outside the supported range")
		}
	}
	if policy := manifest.Rules.VehiclePolicy; policy != nil {
		if !policy.Enabled && (policy.MaxSpeed != nil || policy.MaxCombinedComplexity != nil) {
			return errors.New("disabled vehicle policy cannot declare limits")
		}
		if policy.Enabled && (policy.MaxSpeed == nil || *policy.MaxSpeed < 0.5 || *policy.MaxSpeed > 16 || math.IsNaN(*policy.MaxSpeed) || math.IsInf(*policy.MaxSpeed, 0) || policy.MaxCombinedComplexity == nil || *policy.MaxCombinedComplexity < 1 || *policy.MaxCombinedComplexity > 1000000) {
			return errors.New("world vehicle policy limits are outside the supported range")
		}
	}
	if len(manifest.Rules.RequiredFeatures) > 64 {
		return errors.New("too many required world features")
	}
	seenFeatures := make(map[string]bool, len(manifest.Rules.RequiredFeatures))
	for _, feature := range manifest.Rules.RequiredFeatures {
		if len(feature) > 96 || !worldFeaturePattern.MatchString(feature) || seenFeatures[feature] {
			return errors.New("invalid or duplicate required world feature")
		}
		seenFeatures[feature] = true
	}
	if len(manifest.Assets) > 10000 || len(manifest.Objects) > 10000 || len(manifest.Components) > 128 || len(manifest.Portals) > 1024 || len(manifest.Hosts) > 256 {
		return errors.New("manifest contains too many entries")
	}
	permitted := manifest.OwnerPeerID == localPeerID
	if manifest.AuthorityPeerID == "" || manifest.AuthorityEpoch == 0 || manifest.AuthorityEpoch > maxSafeJSInteger || manifest.AuthorityPeerID != manifest.OwnerPeerID {
		return errors.New("world authority is missing an epoch")
	}
	if _, err := peer.Decode(manifest.OwnerPeerID); err != nil {
		return errors.New("invalid owner peer identity")
	}
	if _, err := peer.Decode(manifest.AuthorityPeerID); err != nil {
		return errors.New("invalid authority peer identity")
	}
	seenHosts := make(map[string]bool, len(manifest.Hosts))
	failoverWindows := make([][2]int64, 0, len(manifest.Hosts))
	for _, grant := range manifest.Hosts {
		if _, err := peer.Decode(grant.PeerID); err != nil || seenHosts[grant.PeerID] || grant.Epoch == 0 || grant.Epoch > maxSafeJSInteger || grant.ExpiresAt <= 0 || grant.ExpiresAt > int64(maxSafeJSInteger) {
			return errors.New("invalid or duplicate hosting grant")
		}
		seenHosts[grant.PeerID] = true
		seenScopes := make(map[string]bool, len(grant.Scopes))
		for _, scope := range grant.Scopes {
			if (scope != "content-cache" && scope != "failover-authority") || seenScopes[scope] {
				return errors.New("invalid hosting grant scope")
			}
			seenScopes[scope] = true
		}
		if len(seenScopes) == 0 {
			return errors.New("hosting grant has no scopes")
		}
		if seenScopes["failover-authority"] {
			if grant.FailoverAfter <= 0 || grant.FailoverAfter > int64(maxSafeJSInteger) || grant.FailoverSeconds < 1 || grant.FailoverSeconds > 3600 || grant.FailoverAfter > grant.ExpiresAt-grant.FailoverSeconds {
				return errors.New("invalid failover grant window")
			}
			failoverWindows = append(failoverWindows, [2]int64{grant.FailoverAfter, grant.FailoverAfter + grant.FailoverSeconds})
		} else if grant.FailoverAfter != 0 || grant.FailoverSeconds != 0 {
			return errors.New("failover window without failover permission")
		}
		if grant.PeerID == localPeerID && grant.ExpiresAt > now.Unix() {
			permitted = true
		}
	}
	for i, window := range failoverWindows {
		for _, other := range failoverWindows[i+1:] {
			if window[0] < other[1] && other[0] < window[1] {
				return errors.New("failover authority windows overlap")
			}
		}
	}
	if !permitted {
		return errors.New("this node has no unexpired owner grant for the world")
	}
	if budget := manifest.Rules.MaxPackageBytes; budget != nil && (*budget < 1 || *budget > 16<<30) {
		return errors.New("world package byte budget is outside the supported range")
	}
	seenAssets := make(map[string]bool, len(manifest.Assets))
	var totalAssetBytes int64
	for _, asset := range manifest.Assets {
		if !assetIDPattern.MatchString(asset.ID) || seenAssets[asset.ID] || asset.Bytes < 0 || asset.Bytes > maxAssetBytes {
			return fmt.Errorf("invalid or duplicate asset %q", asset.ID)
		}
		if manifest.Rules.MaxPackageBytes != nil {
			if asset.Bytes > *manifest.Rules.MaxPackageBytes-totalAssetBytes {
				return errors.New("world package exceeds its declared byte budget")
			}
			totalAssetBytes += asset.Bytes
		}
		if asset.Priority != "portal-preview" && asset.Priority != "visible" && asset.Priority != "nearby" && asset.Priority != "background" {
			return fmt.Errorf("invalid priority for asset %s", asset.ID)
		}
		seenAssets[asset.ID] = true
	}
	assetKinds := make(map[string]string, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		assetKinds[asset.ID] = asset.Kind
	}
	seenObjects := make(map[string]bool, len(manifest.Objects))
	for _, object := range manifest.Objects {
		if !objectIDPattern.MatchString(object.ID) || seenObjects[object.ID] || object.Kind != "asset-instance" || len(object.Label) > 160 || !assetIDPattern.MatchString(object.AssetID) || !seenAssets[object.AssetID] {
			return fmt.Errorf("invalid or duplicate world object %q", object.ID)
		}
		if object.LODs != nil {
			if len(object.LODs) < 1 || len(object.LODs) > 3 || object.StreamingBounds == nil || assetKinds[object.AssetID] != "glb" {
				return errors.New("invalid object LOD list")
			}
			seen := map[string]bool{object.AssetID: true}
			previous := 1.0
			for _, level := range object.LODs {
				if !assetIDPattern.MatchString(level.AssetID) || seen[level.AssetID] || assetKinds[level.AssetID] != "glb" || math.IsNaN(level.MaxScreenFraction) || math.IsInf(level.MaxScreenFraction, 0) || level.MaxScreenFraction <= 0 || level.MaxScreenFraction >= previous {
					return errors.New("invalid object LOD variant")
				}
				seen[level.AssetID] = true
				previous = level.MaxScreenFraction
			}
		}
		for _, coordinate := range object.Transform.Position {
			if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 1e6 {
				return errors.New("object coordinate out of bounds")
			}
		}
		if math.IsNaN(object.Transform.Yaw) || math.IsInf(object.Transform.Yaw, 0) || math.Abs(object.Transform.Yaw) > 360 {
			return errors.New("object yaw out of bounds")
		}
		if object.Transform.Rotation != nil {
			if object.Collision.Enabled || !validUnitQuaternion(object.Transform.Rotation) {
				return errors.New("object quaternion must be normalized and collision-free")
			}
		}
		if object.Priority != "" && object.Priority != "portal-preview" && object.Priority != "visible" && object.Priority != "nearby" && object.Priority != "background" {
			return errors.New("invalid object streaming priority")
		}
		if bounds := object.StreamingBounds; bounds != nil {
			if math.IsNaN(bounds.Radius) || math.IsInf(bounds.Radius, 0) || bounds.Radius <= 0 || bounds.Radius > 10000 {
				return errors.New("object streaming bounds radius out of bounds")
			}
			for _, coordinate := range bounds.Center {
				if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 10000 {
					return errors.New("object streaming bounds center out of bounds")
				}
			}
		}
		for _, scale := range object.Scale {
			if math.IsNaN(scale) || math.IsInf(scale, 0) || scale <= 0 || scale > 1000 {
				return errors.New("object scale out of bounds")
			}
		}
		if object.Collision.Shape != "box" && object.Collision.Shape != "compound" && object.Collision.Shape != "heightfield" && object.Collision.Shape != "none" {
			return errors.New("unsupported object collision shape")
		}
		if object.Collision.Enabled {
			switch object.Collision.Shape {
			case "box":
				for _, extent := range object.Collision.HalfExtents {
					if math.IsNaN(extent) || math.IsInf(extent, 0) || extent <= 0 || extent > 1000 {
						return errors.New("object collision half extents out of bounds")
					}
				}
				for _, coordinate := range object.Collision.Center {
					if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 1e6 {
						return errors.New("object collision center out of bounds")
					}
				}
			case "heightfield":
				if object.Collision.Columns < 2 || object.Collision.Rows < 2 || object.Collision.Columns > 4097 || object.Collision.Rows > 4097 || uint64(object.Collision.Columns)*uint64(object.Collision.Rows) > 4194304 || !object.Collision.Walkable || !object.Collision.Solid {
					return errors.New("invalid object heightfield dimensions or flags")
				}
			case "compound":
				if len(object.Collision.Boxes) == 0 || len(object.Collision.Boxes) > maxCollisionBoxes {
					return errors.New("invalid compound collision box count")
				}
				for _, box := range object.Collision.Boxes {
					for _, extent := range box.HalfExtents {
						if math.IsNaN(extent) || math.IsInf(extent, 0) || extent <= 0 || extent > 1000 {
							return errors.New("compound collision half extents out of bounds")
						}
					}
					for _, coordinate := range box.Center {
						if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 1e6 {
							return errors.New("compound collision center out of bounds")
						}
					}
					if math.IsNaN(box.Yaw) || math.IsInf(box.Yaw, 0) || math.Abs(box.Yaw) > 360 {
						return errors.New("compound collision yaw out of bounds")
					}
				}
			default:
				return errors.New("enabled object collision must use box, compound, or heightfield shape")
			}
		}
		seenObjects[object.ID] = true
	}
	objectByID := make(map[string]worldObject, len(manifest.Objects))
	for _, object := range manifest.Objects {
		objectByID[object.ID] = object
	}
	replacedObjects := make(map[string]bool)
	for _, object := range manifest.Objects {
		if object.ReplacesObjectID == "" {
			continue
		}
		preview, exists := objectByID[object.ReplacesObjectID]
		if !exists || preview.Priority != "portal-preview" || object.Priority == "portal-preview" || preview.Collision.Enabled || replacedObjects[preview.ID] {
			return fmt.Errorf("invalid preview replacement on world object %q", object.ID)
		}
		replacedObjects[preview.ID] = true
	}
	seenPortals := make(map[string]bool, len(manifest.Portals))
	for _, p := range manifest.Portals {
		if !portalIDPattern.MatchString(p.ID) || seenPortals[p.ID] || seenObjects[p.ID] || !worldIDPattern.MatchString(p.Destination) || len(p.PeerID) > 256 || p.Visual != "" && p.Visual != "timber" && p.Visual != "stone" && p.Visual != "metal" {
			return fmt.Errorf("invalid portal %q", p.ID)
		}
		if p.PeerID != "" {
			if _, err := peer.Decode(p.PeerID); err != nil {
				return fmt.Errorf("invalid destination peer for portal %q", p.ID)
			}
		}
		if p.Gateway != "" && !validPortalGateway(p.Gateway) {
			return fmt.Errorf("invalid destination gateway for portal %q", p.ID)
		}
		for _, t := range []transform{p.Entry, p.Exit} {
			if t.Rotation != nil {
				return errors.New("portal transforms support yaw only")
			}
			for _, coordinate := range t.Position {
				if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 1e6 {
					return errors.New("portal coordinate out of bounds")
				}
			}
			if math.IsNaN(t.Yaw) || math.IsInf(t.Yaw, 0) || math.Abs(t.Yaw) > 360 {
				return errors.New("portal yaw out of bounds")
			}
		}
		if p.Back != nil {
			if !seenFeatures["tidewater.portal-two-sided/1"] {
				return errors.New("portal back requires tidewater.portal-two-sided/1")
			}
			back := p.Back
			if !worldIDPattern.MatchString(back.Destination) || back.Gateway != "" && !validPortalGateway(back.Gateway) {
				return errors.New("invalid portal back destination")
			}
			if back.PeerID != "" {
				if _, err := peer.Decode(back.PeerID); err != nil {
					return errors.New("invalid portal back peer")
				}
			}
			t := back.Exit
			if t.Rotation != nil || math.IsNaN(t.Yaw) || math.IsInf(t.Yaw, 0) || math.Abs(t.Yaw) > 360 {
				return errors.New("invalid portal back transform")
			}
			for _, coordinate := range t.Position {
				if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 1e6 {
					return errors.New("portal back coordinate out of bounds")
				}
			}
		}
		seenPortals[p.ID] = true
	}
	seenComponents := make(map[string]bool, len(manifest.Components))
	islandOceanCount := 0
	waterBodyCount := 0
	ambientAudioCount := 0
	boatCount := 0
	var boatObject worldObject
	waterBodies := make([]worldComponent, 0, 4)
	assetRefs := make(map[string]assetRef, len(manifest.Assets))
	for _, asset := range manifest.Assets {
		assetRefs[asset.ID] = asset
	}
	for _, component := range manifest.Components {
		vegetation := component.Type == "tidewater.procedural-island-vegetation/1" && component.Seed == 7
		staticVegetation := component.Type == "tidewater.static-vegetation/1" && component.Seed == 0 && component.PlacementAssetID != ""
		staticReef := component.Type == "tidewater.static-reef/1" && component.Seed == 0 && component.PlacementAssetID != "" && component.StreamingBounds != nil
		ambientAudio := component.Type == "tidewater.ambient-audio/1" && component.Seed == 0 && component.PlacementAssetID == "" && len(component.Beds) > 0 && len(component.Beds) <= 16
		boat := component.Type == "tidewater.downeast-boat/1" && component.Seed == 0 && component.PlacementAssetID == "" && component.ObjectID != ""
		islandOcean := component.Type == "tidewater.island-ocean/1" && component.Seed == 0 && component.PlacementAssetID == ""
		proceduralTerrain := component.Type == "tidewater.procedural-island-terrain/1" && component.Seed == 0 && component.PlacementAssetID == "" && component.Profile == "example-island-v1" && component.ObjectID != "" && objectByID[component.ObjectID].Kind == "asset-instance"
		terrainSurface := component.Type == "tidewater.terrain-surface/1" && component.Seed == 0 && component.PlacementAssetID == "" && component.Profile == "example-island-v1" && component.ObjectID != "" && objectByID[component.ObjectID].Kind == "asset-instance" && component.DataAssetID != ""
		waterBody := component.Type == "tidewater.water-body/1" && component.Seed == 0 && component.PlacementAssetID == "" && len(component.Center) == 2 && component.Extent >= 8 && component.Extent <= 100000 && (component.Profile == "" || component.Profile == "deep-ocean" || component.Profile == "calm-lagoon" || component.Profile == "storm")
		if waterBody {
			waterBodyCount++
			for _, coordinate := range component.Center {
				if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate)+component.Extent > 1e6 {
					waterBody = false
				}
			}
			if math.IsNaN(component.Extent) || math.IsInf(component.Extent, 0) {
				waterBody = false
			}
		}
		if islandOcean {
			islandOceanCount++
		}
		if ambientAudio {
			ambientAudioCount++
		}
		if boat {
			boatCount++
			preview, exists := objectByID[component.ObjectID]
			previewAsset, assetExists := assetRefs[preview.AssetID]
			if !exists || !assetExists || previewAsset.Kind != "glb" || previewAsset.Priority != "portal-preview" || preview.Kind != "asset-instance" || preview.Priority != "portal-preview" || preview.Collision.Enabled || preview.Collision.Shape != "none" || preview.Transform.Rotation != nil || preview.Scale != (vector3{1, 1, 1}) || component.Priority != "portal-preview" {
				return fmt.Errorf("invalid berth preview object on boat component %q", component.ID)
			}
			boatObject = preview
		}
		if !componentIDPattern.MatchString(component.ID) || seenComponents[component.ID] || seenObjects[component.ID] || seenPortals[component.ID] || (!vegetation && !staticVegetation && !staticReef && !islandOcean && !proceduralTerrain && !terrainSurface && !waterBody && !ambientAudio && !boat) || islandOceanCount > 1 || waterBodyCount > 4 || ambientAudioCount > 16 || boatCount > 1 || component.Priority != "" && component.Priority != "portal-preview" && component.Priority != "visible" && component.Priority != "nearby" && component.Priority != "background" || !seenFeatures[component.Type] {
			return fmt.Errorf("invalid or unsupported world component %q", component.ID)
		}
		if waterBody && (manifest.Rules.SeaLevel == nil || islandOceanCount > 0) || islandOcean && waterBodyCount > 0 {
			return errors.New("portable water requires seaLevel and cannot be combined with island-ocean")
		}
		if waterBody {
			for _, other := range waterBodies {
				if math.Abs(component.Center[0]-other.Center[0]) < component.Extent+other.Extent && math.Abs(component.Center[1]-other.Center[1]) < component.Extent+other.Extent {
					return errors.New("portable water body bounds cannot overlap")
				}
			}
			waterBodies = append(waterBodies, component)
		}
		if component.PlacementAssetID != "" {
			asset, exists := assetRefs[component.PlacementAssetID]
			priority := component.Priority
			if priority == "" {
				priority = "portal-preview"
			}
			kind := "vegetation-placement/1"
			if staticReef {
				kind = "reef-placement/1"
			}
			if !assetIDPattern.MatchString(component.PlacementAssetID) || !exists || asset.Kind != kind || asset.Priority != priority {
				return fmt.Errorf("invalid placement asset reference on world component %q", component.ID)
			}
		}
		if terrainSurface {
			asset, exists := assetRefs[component.DataAssetID]
			priority := component.Priority
			if priority == "" {
				priority = "portal-preview"
			}
			if !assetIDPattern.MatchString(component.DataAssetID) || !exists || asset.Kind != "terrain-surface/1" || asset.Priority != priority || asset.Bytes == 0 || asset.Bytes > 128<<20 {
				return fmt.Errorf("invalid terrain surface asset reference on world component %q", component.ID)
			}
		}
		if ambientAudio {
			priority := component.Priority
			if priority == "" {
				priority = "portal-preview"
			}
			for _, bed := range component.Beds {
				asset, exists := assetRefs[bed.AssetID]
				invalidPosition := bed.Position != nil && vector3OutOfBounds(*bed.Position, 100000)
				invalidRefDistance := bed.RefDistance != nil && (math.IsNaN(*bed.RefDistance) || math.IsInf(*bed.RefDistance, 0) || *bed.RefDistance < 0.5 || *bed.RefDistance > 1000)
				invalidRolloff := bed.Rolloff != nil && (math.IsNaN(*bed.Rolloff) || math.IsInf(*bed.Rolloff, 0) || *bed.Rolloff < 0 || *bed.Rolloff > 10)
				if !assetIDPattern.MatchString(bed.AssetID) || !exists || asset.Kind != "audio/ogg" || asset.Bytes == 0 || asset.Bytes > 16<<20 || asset.Priority != priority || math.IsNaN(bed.Gain) || math.IsInf(bed.Gain, 0) || bed.Gain < 0 || bed.Gain > 1 || bed.Condition != "" && bed.Condition != "always" && bed.Condition != "day" && bed.Condition != "night" && bed.Condition != "dawn" && bed.Condition != "underwater" || invalidPosition || invalidRefDistance || invalidRolloff {
					return fmt.Errorf("invalid ambient audio bed on world component %q", component.ID)
				}
			}
		}
		if bounds := component.StreamingBounds; bounds != nil {
			if math.IsNaN(bounds.Radius) || math.IsInf(bounds.Radius, 0) || bounds.Radius <= 0 || bounds.Radius > 10000 {
				return errors.New("component streaming bounds radius out of bounds")
			}
			for _, coordinate := range bounds.Center {
				if math.IsNaN(coordinate) || math.IsInf(coordinate, 0) || math.Abs(coordinate) > 10000 {
					return errors.New("component streaming bounds center out of bounds")
				}
			}
		}
		seenComponents[component.ID] = true
	}
	if boatCount > 0 {
		if manifest.Rules.SeaLevel == nil || islandOceanCount != 1 && waterBodyCount == 0 {
			return errors.New("a Downeast boat requires seaLevel and a declared water renderer")
		}
		if waterBodyCount > 0 {
			inside := false
			for _, water := range waterBodies {
				if math.Abs(boatObject.Transform.Position[0]-water.Center[0]) <= water.Extent && math.Abs(boatObject.Transform.Position[2]-water.Center[1]) <= water.Extent {
					inside = true
				}
			}
			if !inside {
				return errors.New("a Downeast boat berth must be inside a declared water body")
			}
		}
	}
	return nil
}

func vector3OutOfBounds(vector vector3, limit float64) bool {
	for _, value := range vector {
		if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > limit {
			return true
		}
	}
	return false
}

func validUnitQuaternion(rotation *vector4) bool {
	if rotation == nil {
		return false
	}
	lengthSquared := 0.0
	for _, component := range rotation {
		if math.IsNaN(component) || math.IsInf(component, 0) {
			return false
		}
		lengthSquared += component * component
	}
	return math.Abs(math.Sqrt(lengthSquared)-1) <= 1e-4
}

func validPortalGateway(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.IsAbs() && (parsed.Scheme == "https" || parsed.Scheme == "wss") && parsed.Hostname() != "" && parsed.User == nil && (parsed.Path == "" || parsed.Path == "/") && parsed.RawQuery == "" && parsed.Fragment == ""
}

func validDirectoryURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.IsAbs() && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil && (parsed.Path == "" || parsed.Path == "/") && parsed.RawQuery == "" && parsed.Fragment == ""
}

type authorityLease struct {
	WorldID         string `json:"worldId"`
	AuthorityPeerID string `json:"authorityPeerId"`
	Epoch           uint64 `json:"epoch"`
	GrantEpoch      uint64 `json:"grantEpoch"`
	NotBefore       int64  `json:"notBefore"`
	ExpiresAt       int64  `json:"expiresAt"`
}

func activateFailover(manifest worldManifest, delegateID string, key crypto.PrivKey, now time.Time) (signedDocument, error) {
	if manifest.AuthorityEpoch == 0 || manifest.AuthorityEpoch >= maxSafeJSInteger {
		return signedDocument{}, errors.New("world authority epoch cannot be safely advanced")
	}
	keyPeerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil || keyPeerID.String() != delegateID {
		return signedDocument{}, errors.New("failover signer does not match delegate node")
	}
	for _, grant := range manifest.Hosts {
		if grant.PeerID != delegateID || grant.ExpiresAt <= now.Unix() {
			continue
		}
		authorized := false
		for _, scope := range grant.Scopes {
			if scope == "failover-authority" {
				authorized = true
			}
		}
		if !authorized {
			continue
		}
		if now.Unix() < grant.FailoverAfter {
			return signedDocument{}, errors.New("failover grant is not active yet")
		}
		expires := min(grant.ExpiresAt, grant.FailoverAfter+grant.FailoverSeconds)
		if now.Unix() >= expires {
			return signedDocument{}, errors.New("failover grant has expired")
		}
		lease := authorityLease{WorldID: manifest.WorldID, AuthorityPeerID: delegateID, Epoch: manifest.AuthorityEpoch + 1, GrantEpoch: grant.Epoch, NotBefore: grant.FailoverAfter, ExpiresAt: expires}
		return signDocument(authorityProtocol, lease, key)
	}
	return signedDocument{}, errors.New("node has no failover-authority grant")
}

func failoverCheckDelay(manifest worldManifest, localID string, active *signedDocument, now time.Time) time.Duration {
	if active != nil {
		var lease authorityLease
		if json.Unmarshal(active.Payload, &lease) == nil {
			return time.Unix(lease.ExpiresAt, 0).Sub(now)
		}
	}
	for _, grant := range manifest.Hosts {
		if grant.PeerID != localID || grant.ExpiresAt <= now.Unix() {
			continue
		}
		authorized := false
		for _, scope := range grant.Scopes {
			if scope == "failover-authority" {
				authorized = true
				break
			}
		}
		if !authorized {
			continue
		}
		if now.Unix() < grant.FailoverAfter {
			return time.Unix(grant.FailoverAfter, 0).Sub(now)
		}
		end := min(grant.ExpiresAt, grant.FailoverAfter+grant.FailoverSeconds)
		if now.Unix() < end {
			return time.Unix(end, 0).Sub(now)
		}
	}
	return 0
}

func validateAuthorityLease(document signedDocument, manifest worldManifest, now time.Time) (authorityLease, error) {
	var lease authorityLease
	if err := verifyDocument(document, authorityProtocol); err != nil {
		return lease, err
	}
	if err := json.Unmarshal(document.Payload, &lease); err != nil {
		return lease, err
	}
	if manifest.AuthorityEpoch == 0 || manifest.AuthorityEpoch >= maxSafeJSInteger || lease.Epoch == 0 || lease.Epoch > maxSafeJSInteger || lease.GrantEpoch == 0 || lease.GrantEpoch > maxSafeJSInteger ||
		lease.NotBefore <= 0 || lease.NotBefore > int64(maxSafeJSInteger) || lease.ExpiresAt <= lease.NotBefore || lease.ExpiresAt > int64(maxSafeJSInteger) ||
		lease.WorldID != manifest.WorldID || lease.AuthorityPeerID != document.Signer || lease.Epoch != manifest.AuthorityEpoch+1 || now.Unix() < lease.NotBefore || now.Unix() >= lease.ExpiresAt {
		return lease, errors.New("authority lease is not currently valid")
	}
	for _, grant := range manifest.Hosts {
		if grant.PeerID != lease.AuthorityPeerID || grant.Epoch == 0 || grant.Epoch != lease.GrantEpoch || grant.ExpiresAt < lease.ExpiresAt || grant.FailoverAfter != lease.NotBefore {
			continue
		}
		for _, scope := range grant.Scopes {
			if scope == "failover-authority" && lease.ExpiresAt <= grant.FailoverAfter+grant.FailoverSeconds {
				return lease, nil
			}
		}
	}
	return lease, errors.New("authority lease lacks owner delegation")
}

func decodeManifest(doc signedDocument, localPeerID string, now time.Time) (worldManifest, error) {
	if err := verifyDocument(doc, manifestProtocol); err != nil {
		return worldManifest{}, err
	}
	var manifest worldManifest
	if err := json.Unmarshal(doc.Payload, &manifest); err != nil {
		return worldManifest{}, err
	}
	if doc.Signer != manifest.OwnerPeerID {
		return worldManifest{}, errors.New("manifest is not signed by its declared owner")
	}
	if err := validateManifest(manifest, localPeerID, now); err != nil {
		return worldManifest{}, err
	}
	return manifest, nil
}
