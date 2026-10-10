package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	crypto "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

func TestWorldManifestOwnerAndScopedHostGrant(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	manifest := newStarterManifest("Island", ownerID.String())
	manifest.WorldID = "tw-world:private-island"
	document, err := signDocument(manifestProtocol, manifest, owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeManifest(document, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("owner should serve world: %v", err)
	}

	delegate, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	delegateID, _ := peer.IDFromPublicKey(delegate.GetPublic())
	manifest.Hosts = []hostingGrant{{PeerID: delegateID.String(), Scopes: []string{"content-cache"}, ExpiresAt: time.Now().Add(time.Hour).Unix(), Epoch: 1}}
	if !canServeWorldAssets(manifest, delegateID.String(), time.Now()) {
		t.Fatal("active content-cache grant should allow serving immutable assets")
	}
	document, err = signDocument(manifestProtocol, manifest, owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeManifest(document, delegateID.String(), time.Now()); err != nil {
		t.Fatalf("valid cache delegate rejected: %v", err)
	}
	if _, err := decodeManifest(document, "unlisted-peer", time.Now()); err == nil {
		t.Fatal("unlisted host accepted")
	}
	manifest.Hosts[0].Epoch = maxSafeJSInteger + 1
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("host grant epoch outside browser-safe integer range accepted")
	}
	manifest.Hosts[0].Epoch = 1
	manifest.Hosts[0].ExpiresAt = time.Now().Add(-time.Hour).Unix()
	if err := validateManifest(manifest, delegateID.String(), time.Now()); err == nil {
		t.Fatal("expired host grant accepted")
	}
	if canServeWorldAssets(manifest, delegateID.String(), time.Now()) {
		t.Fatal("expired content-cache grant still allowed asset serving")
	}
	manifest.Hosts[0] = hostingGrant{PeerID: delegateID.String(), Scopes: []string{"failover-authority"}, Epoch: 1, FailoverAfter: time.Now().Add(-time.Minute).Unix(), FailoverSeconds: 30, ExpiresAt: time.Now().Add(time.Hour).Unix()}
	if canServeWorldAssets(manifest, delegateID.String(), time.Now()) {
		t.Fatal("failover-authority scope implicitly granted content caching")
	}
	if !canServeWorldAssets(manifest, ownerID.String(), time.Now()) {
		t.Fatal("world owner should always be able to serve its own assets")
	}
}

func TestWorldManifestRejectsUnsafeAuthorityEpochAndVersion(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	manifest := newStarterManifest("Safe epochs", ownerID.String())
	manifest.WorldID = "tw-world:safe-epochs"
	manifest.AuthorityEpoch = maxSafeJSInteger + 1
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("authority epoch outside JavaScript safe integer range accepted")
	}
	manifest.AuthorityEpoch = 1
	manifest.Version = maxSafeJSInteger + 1
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("world version outside JavaScript safe integer range accepted")
	}
}

func TestWorldManifestRejectsUnsafeAssetAndPortalData(t *testing.T) {
	manifest := newStarterManifest("Island", "owner")
	manifest.WorldID = "tw-world:invalid-case"
	manifest.Rules.Gravity = 99
	if err := validateManifest(manifest, "owner", time.Now()); err == nil {
		t.Fatal("unsafe gravity accepted")
	}
	manifest = newStarterManifest("Island", "owner")
	manifest.WorldID = "tw-world:invalid-case"
	manifest.Assets = []assetRef{{ID: "sha256:bad", Bytes: 10, Kind: "glb", Priority: "visible"}}
	if err := validateManifest(manifest, "owner", time.Now()); err == nil {
		t.Fatal("invalid asset identifier accepted")
	}
}

func TestWorldManifestAllowsPortalProviderDiscoveryByWorldID(t *testing.T) {
	owner := testKey(t)
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Discovered destination", ownerID.String())
	manifest.WorldID = "tw-world:portal-discovery"
	manifest.Portals = []portal{{
		ID: "tw-portal:destination", Destination: "tw-world:other",
		Visual: "timber",
		Entry:  transform{Position: vector3{1, 2, 3}}, Exit: transform{Position: vector3{4, 5, 6}},
		OpenView: true, Enabled: true,
	}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("portal without a pinned peer should resolve by world ID: %v", err)
	}
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "destinationPeerId") {
		t.Fatalf("un-pinned portal should omit the destinationPeerId field: %s", encoded)
	}
	manifest.Portals[0].Visual = "glass"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unsupported portal visual style accepted")
	}
	manifest.Portals[0].Visual = ""
	manifest.Portals[0].PeerID = "not-a-peer-id"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("malformed optional destination peer should be rejected")
	}
}

func TestWorldManifestRejectsOverlappingFailoverAuthorityWindows(t *testing.T) {
	owner, delegateA, delegateB := testKey(t), testKey(t), testKey(t)
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	delegateAID, _ := peer.IDFromPublicKey(delegateA.GetPublic())
	delegateBID, _ := peer.IDFromPublicKey(delegateB.GetPublic())
	now := time.Now()
	start := now.Add(time.Hour).Unix()
	manifest := newStarterManifest("Sequential authority", ownerID.String())
	manifest.WorldID = "tw-world:sequential-authority"
	manifest.Hosts = []hostingGrant{
		{PeerID: delegateAID.String(), Scopes: []string{"failover-authority"}, Epoch: 1, FailoverAfter: start, FailoverSeconds: 60, ExpiresAt: start + 120},
		{PeerID: delegateBID.String(), Scopes: []string{"failover-authority"}, Epoch: 1, FailoverAfter: start + 60, FailoverSeconds: 60, ExpiresAt: start + 180},
	}
	if err := validateManifest(manifest, ownerID.String(), now); err != nil {
		t.Fatalf("adjacent failover windows should be allowed: %v", err)
	}
	manifest.Hosts[1].FailoverAfter--
	manifest.Hosts[1].ExpiresAt--
	if err := validateManifest(manifest, ownerID.String(), now); err == nil {
		t.Fatal("overlapping failover authority windows were accepted")
	}
}

func TestWorldManifestValidatesRequiredFeatureIdentifiers(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	manifest := newStarterManifest("Feature rules", ownerID.String())
	manifest.WorldID = "tw-world:feature-rules"
	manifest.Rules.RequiredFeatures = []string{"tidewater.portal-handoff/1", "tidewater.portal-preview-static/1"}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid required features rejected: %v", err)
	}
	manifest.Rules.RequiredFeatures = []string{"tidewater.portal-handoff/1", "tidewater.portal-handoff/1"}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("duplicate required feature accepted")
	}
	manifest.Rules.RequiredFeatures = []string{"not-a-feature-id"}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("malformed required feature accepted")
	}
	manifest.Rules.RequiredFeatures = nil
	manifest.Rules.PhysicsProfile = "custom-physics"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unsupported physics profile accepted")
	}
}

func TestWorldManifestValidatesProceduralComponents(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Procedural component", ownerID.String())
	manifest.WorldID = "tw-world:procedural-component"
	manifest.Rules.RequiredFeatures = []string{"tidewater.procedural-island-vegetation/1"}
	placementID := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	manifest.Assets = []assetRef{{ID: placementID, Bytes: 1, Kind: "vegetation-placement/1", Priority: "portal-preview"}}
	manifest.Components = []worldComponent{{ID: "tw-component:island-vegetation", Type: "tidewater.procedural-island-vegetation/1", Seed: 7, Priority: "portal-preview", PlacementAssetID: placementID}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid procedural component rejected: %v", err)
	}
	manifest.Rules.RequiredFeatures = append(manifest.Rules.RequiredFeatures, "tidewater.island-ocean/1")
	manifest.Components = append(manifest.Components, worldComponent{ID: "tw-component:island-ocean", Type: "tidewater.island-ocean/1", Priority: "portal-preview"})
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid island ocean component rejected: %v", err)
	}
	oceanJSON, err := json.Marshal(manifest.Components[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(oceanJSON), `"seed"`) {
		t.Fatalf("island ocean serialization includes a vegetation-only field: %s", oceanJSON)
	}
	manifest.Components = append(manifest.Components, worldComponent{ID: "tw-component:island-ocean-copy", Type: "tidewater.island-ocean/1"})
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("duplicate island ocean components accepted")
	}
	manifest.Components = manifest.Components[:1]
	manifest.Rules.RequiredFeatures = manifest.Rules.RequiredFeatures[:1]
	manifest.Components[0].PlacementAssetID = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("procedural component referencing an undeclared placement asset accepted")
	}
	manifest.Components[0].PlacementAssetID = placementID
	manifest.Assets[0].Priority = "visible"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("procedural placement data not available for portal preview accepted")
	}
	manifest.Assets[0].Priority = "portal-preview"

	manifest.Rules.RequiredFeatures = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("component missing its required feature declaration accepted")
	}
	manifest.Rules.RequiredFeatures = []string{"tidewater.procedural-island-vegetation/1"}
	manifest.Components[0].Seed = 8
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unsupported procedural seed accepted")
	}
	manifest.Components[0].Seed = 7
	manifest.Components = append(manifest.Components, manifest.Components[0])
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("duplicate procedural component ID accepted")
	}
	manifest.Components = manifest.Components[:1]
	manifest.Components[0].ID = "tw-object:invalid-kind-collision"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("component ID using another entity prefix accepted")
	}
}

func TestWorldManifestValidatesProceduralIslandTerrain(t *testing.T) {
	owner := testKey(t)
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Terrain fidelity", ownerID.String())
	manifest.WorldID = "tw-world:terrain-fidelity"
	manifest.Rules.RequiredFeatures = []string{"tidewater.procedural-island-terrain/1"}
	assetID := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 1, Kind: "glb", Priority: "visible"}}
	var fallback worldObject
	if err := json.Unmarshal([]byte(`{"id":"tw-object:terrain-fallback","kind":"asset-instance","label":"Terrain fallback","assetId":"`+assetID+`","transform":{"position":[0,0,0],"yaw":0},"scale":[1,1,1],"collision":{"shape":"none","enabled":false}}`), &fallback); err != nil {
		t.Fatal(err)
	}
	manifest.Objects = []worldObject{fallback}
	manifest.Components = []worldComponent{{
		ID: "tw-component:procedural-terrain", Type: "tidewater.procedural-island-terrain/1",
		Profile: "example-island-v1", ObjectID: manifest.Objects[0].ID, Priority: "visible",
	}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid procedural terrain component rejected: %v", err)
	}
	manifest.Components[0].Profile = "unknown-profile"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unsupported procedural terrain profile accepted")
	}
}

func TestWorldManifestValidatesPortableTerrainSurface(t *testing.T) {
	owner := testKey(t)
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Portable terrain", ownerID.String())
	manifest.WorldID = "tw-world:portable-terrain"
	manifest.Rules.RequiredFeatures = []string{"tidewater.terrain-surface/1"}
	glbID := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	dataID := "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	manifest.Assets = []assetRef{{ID: glbID, Bytes: 1, Kind: "glb", Priority: "visible"}, {ID: dataID, Bytes: 100, Kind: "terrain-surface/1", Priority: "visible"}}
	var fallback worldObject
	if err := json.Unmarshal([]byte(`{"id":"tw-object:terrain-fallback","kind":"asset-instance","label":"Terrain fallback","assetId":"`+glbID+`","priority":"visible","transform":{"position":[0,0,0],"yaw":0},"scale":[1,1,1],"collision":{"shape":"heightfield","enabled":true,"columns":2,"rows":2,"walkable":true,"solid":true}}`), &fallback); err != nil {
		t.Fatal(err)
	}
	manifest.Objects = []worldObject{fallback}
	manifest.Components = []worldComponent{{ID: "tw-component:terrain-surface", Type: "tidewater.terrain-surface/1", Profile: "example-island-v1", ObjectID: fallback.ID, DataAssetID: dataID, Priority: "visible"}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid portable terrain surface rejected: %v", err)
	}
	manifest.Components[0].DataAssetID = glbID
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("terrain component referencing a non-terrain asset accepted")
	}
}

func TestWorldManifestValidatesHostedBoatBerthAsset(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Hosted boat", ownerID.String())
	manifest.WorldID = "tw-world:hosted-boat"
	seaLevel := 0.0
	manifest.Rules.SeaLevel = &seaLevel
	assetID := "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	manifest.Rules.RequiredFeatures = []string{"tidewater.island-ocean/1", "tidewater.downeast-boat/1"}
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 10, Kind: "glb", Priority: "portal-preview"}}
	var berth worldObject
	if err := json.Unmarshal([]byte(`{"id":"tw-object:boat-berth","kind":"asset-instance","label":"Boat berth","assetId":"`+assetID+`","priority":"portal-preview","transform":{"position":[0,0,0],"yaw":0},"scale":[1,1,1],"collision":{"shape":"none","enabled":false}}`), &berth); err != nil {
		t.Fatal(err)
	}
	manifest.Objects = []worldObject{berth}
	manifest.Components = []worldComponent{
		{ID: "tw-component:island-ocean", Type: "tidewater.island-ocean/1", Priority: "portal-preview"},
		{ID: "tw-component:hosted-boat", Type: "tidewater.downeast-boat/1", ObjectID: berth.ID, Priority: "portal-preview"},
	}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid hosted boat berth rejected: %v", err)
	}

	manifest.Assets[0].Kind = "audio/ogg"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("hosted boat berth with a non-GLB asset was accepted")
	}
	manifest.Assets[0].Kind = "glb"
	manifest.Assets[0].Priority = "background"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("hosted boat berth asset not staged for portal preview was accepted")
	}
	manifest.Assets[0].Priority = "portal-preview"
	manifest.Assets = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("hosted boat berth referencing an undeclared asset was accepted")
	}
}

func TestWorldComponentRejectsUnknownFields(t *testing.T) {
	var component worldComponent
	err := json.Unmarshal([]byte(`{"id":"tw-component:vegetation","type":"tidewater.procedural-island-vegetation/1","seed":7,"extra":true}`), &component)
	if err == nil || !strings.Contains(err.Error(), `unknown field "extra"`) {
		t.Fatalf("unknown component field should be rejected, got %v", err)
	}
	err = json.Unmarshal([]byte(`{"id":"tw-component:vegetation","type":"tidewater.static-vegetation/1","seed":7,"placementAssetId":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}`), &component)
	if err == nil || !strings.Contains(err.Error(), `unknown field "seed"`) {
		t.Fatalf("island-only seed should be rejected on static vegetation, got %v", err)
	}
	err = json.Unmarshal([]byte(`{"id":"tw-component:vegetation","type":"tidewater.static-vegetation/1","placementAssetId":"sha256:0000000000000000000000000000000000000000000000000000000000000000","streamingBounds":{"center":[0,0,0],"radius":10,"extra":1}}`), &component)
	if err == nil || !strings.Contains(err.Error(), "only center and radius") {
		t.Fatalf("unknown component bound fields should be rejected, got %v", err)
	}
	err = json.Unmarshal([]byte(`{"id":"tw-component:vegetation","type":"tidewater.static-vegetation/1","placementAssetId":"sha256:0000000000000000000000000000000000000000000000000000000000000000","streamingBounds":{"center":[0,0],"radius":10}}`), &component)
	if err == nil || !strings.Contains(err.Error(), "three coordinates") {
		t.Fatalf("short component bound centers should be rejected, got %v", err)
	}
}

func TestWorldManifestValidatesStaticVegetationComponent(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Portable foliage", ownerID.String())
	manifest.WorldID = "tw-world:portable-foliage"
	manifest.Rules.RequiredFeatures = []string{"tidewater.static-vegetation/1"}
	placementID := "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	manifest.Assets = []assetRef{{ID: placementID, Bytes: 1, Kind: "vegetation-placement/1", Priority: "visible"}}
	manifest.Components = []worldComponent{{ID: "tw-component:portable-foliage", Type: "tidewater.static-vegetation/1", Priority: "visible", PlacementAssetID: placementID, StreamingBounds: &streamingBounds{Center: vector3{0, 2, -10}, Radius: 12}}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid bounded static vegetation component rejected: %v", err)
	}
	document, err := signDocument(manifestProtocol, manifest, owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeManifest(document, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("signed bounded static vegetation component failed runtime decoding: %v", err)
	}
	manifest.Assets[0].Priority = "portal-preview"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("component with mismatched asset streaming priority accepted")
	}
	manifest.Assets[0].Priority = "visible"
	manifest.Components[0].StreamingBounds = &streamingBounds{Center: vector3{0, 0, 0}, Radius: 0}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("component with invalid streaming bounds accepted")
	}
	manifest.Components[0].PlacementAssetID = ""
	manifest.Components[0].StreamingBounds = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("static vegetation without placement data accepted")
	}
}

func TestWorldManifestValidatesStaticReefComponent(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(owner.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Portable reef", ownerID.String())
	manifest.WorldID = "tw-world:portable-reef"
	manifest.Rules.RequiredFeatures = []string{"tidewater.static-reef/1"}
	placementID := "sha256:1111111111111111111111111111111111111111111111111111111111111111"
	manifest.Assets = []assetRef{{ID: placementID, Bytes: 1, Kind: "reef-placement/1", Priority: "visible"}}
	manifest.Components = []worldComponent{{ID: "tw-component:reef-tile", Type: "tidewater.static-reef/1", Priority: "visible", PlacementAssetID: placementID, StreamingBounds: &streamingBounds{Center: vector3{0, -4, 0}, Radius: 32}}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid bounded static reef component rejected: %v", err)
	}
	manifest.Assets[0].Kind = "vegetation-placement/1"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("static reef component accepted a vegetation placement asset")
	}
}

func TestWorldManifestValidatesDeterministicMovementRules(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Movement rules", ownerID.String())
	manifest.WorldID = "tw-world:movement-rules"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("default movement rules rejected: %v", err)
	}
	manifest.Rules.Movement = &movementRules{WalkSpeed: 4, SprintSpeed: 8, JumpSpeed: 3}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid authored movement rules rejected: %v", err)
	}
	manifest.Rules.Movement.SprintSpeed = 3
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("sprint speed below walk speed accepted")
	}
	manifest.Rules.Movement = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("legacy manifest without movement fields rejected: %v", err)
	}
}

func TestWorldManifestValidatesDestinationVehiclePolicy(t *testing.T) {
	var unknownFieldRules worldRules
	if err := json.Unmarshal([]byte(`{"vehiclePolicy":{"enabled":true,"unknown":1}}`), &unknownFieldRules); err == nil {
		t.Fatal("unknown vehicle policy field accepted")
	}
	key := testKey(t)
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Vehicle policy", ownerID.String())
	manifest.WorldID = "tw-world:vehicle-policy"
	maxSpeed := 8.0
	maxComplexity := uint32(50000)
	manifest.Rules.VehiclePolicy = &vehiclePolicy{Enabled: true, MaxSpeed: &maxSpeed, MaxCombinedComplexity: &maxComplexity}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid destination vehicle policy rejected: %v", err)
	}
	manifest.Rules.VehiclePolicy.MaxSpeed = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("enabled vehicle policy without a speed cap accepted")
	}
	manifest.Rules.VehiclePolicy = &vehiclePolicy{Enabled: false, MaxSpeed: &maxSpeed}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("disabled vehicle policy with limits accepted")
	}
	manifest.Rules.VehiclePolicy = &vehiclePolicy{Enabled: true, MaxSpeed: &maxSpeed, MaxCombinedComplexity: &maxComplexity}
	*manifest.Rules.VehiclePolicy.MaxCombinedComplexity = 1000001
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("vehicle complexity above supported maximum accepted")
	}
}

func TestWorldManifestValidatesOptionalEnvironmentLevels(t *testing.T) {
	key := testKey(t)
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Environment levels", ownerID.String())
	manifest.WorldID = "tw-world:environment-levels"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("omitted environment levels should preserve legacy worlds: %v", err)
	}
	sea, atmosphere := -3.5, 12000.0
	manifest.Rules.SeaLevel = &sea
	manifest.Rules.AtmosphereLevel = &atmosphere
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid optional environment levels rejected: %v", err)
	}
	atmosphere = math.Inf(1)
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("non-finite atmosphere level accepted")
	}
	atmosphere = 1e6 + 1
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("out-of-bounds atmosphere level accepted")
	}
}

func TestWorldManifestValidatesPortableWaterBody(t *testing.T) {
	key := testKey(t)
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	seaLevel := 2.5
	manifest := newStarterManifest("Portable water", ownerID.String())
	manifest.WorldID = "tw-world:portable-water"
	manifest.Rules.SeaLevel = &seaLevel
	manifest.Rules.RequiredFeatures = []string{"tidewater.water-body/1"}
	manifest.Components = []worldComponent{{ID: "tw-component:water", Type: "tidewater.water-body/1", Center: []float64{-20, 45}, Extent: 256, Profile: "storm"}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid terrain-independent water body rejected: %v", err)
	}
	manifest.Components = make([]worldComponent, 4)
	for i, x := range []float64{-900, -300, 300, 900} {
		manifest.Components[i] = worldComponent{ID: fmt.Sprintf("tw-component:water-%d", i+1), Type: "tidewater.water-body/1", Center: []float64{x, 0}, Extent: 100}
	}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("four non-overlapping portable water bodies rejected: %v", err)
	}
	manifest.Components = append(manifest.Components, worldComponent{ID: "tw-component:water-5", Type: "tidewater.water-body/1", Center: []float64{1500, 0}, Extent: 100})
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("more than four portable water bodies accepted")
	}
	manifest.Components = manifest.Components[:4]
	manifest.Components[1].Center = []float64{-850, 0}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("overlapping portable water body bounds accepted")
	}
	manifest.Components = []worldComponent{{ID: "tw-component:water", Type: "tidewater.water-body/1", Center: []float64{-20, 45}, Extent: 256, Profile: "storm"}}
	document, err := signDocument(manifestProtocol, manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeManifest(document, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("signed portable water component failed daemon JSON decode: %v", err)
	}
	var unknownField []worldComponent
	if err := json.Unmarshal([]byte(`[{"id":"tw-component:water","type":"tidewater.water-body/1","center":[0,0],"extent":256,"extra":true}]`), &unknownField); err == nil {
		t.Fatal("unknown portable water component field accepted")
	}
	manifest.Components[0].Profile = "custom"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unknown portable water component profile accepted")
	}
	manifest.Components[0].Profile = "storm"
	manifest.Rules.SeaLevel = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("water body without a declared sea level accepted")
	}
	manifest.Rules.SeaLevel = &seaLevel
	manifest.Components[0].Center = []float64{1e6, 0}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("water body extending beyond world bounds accepted")
	}
}

func TestWorldManifestValidatesAmbientAudioBeds(t *testing.T) {
	key := testKey(t)
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	assetID := "sha256:" + strings.Repeat("a", 64)
	manifest := newStarterManifest("Ambient audio", ownerID.String())
	manifest.WorldID = "tw-world:ambient-audio"
	manifest.Rules.RequiredFeatures = []string{"tidewater.ambient-audio/1"}
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 12, Kind: "audio/ogg", Priority: "portal-preview"}}
	manifest.Components = []worldComponent{{ID: "tw-component:ambience", Type: "tidewater.ambient-audio/1", Beds: []audioBed{{AssetID: assetID, Gain: 0.4, Condition: "underwater", Position: &vector3{1, 2, 3}}}}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid ambient audio component rejected: %v", err)
	}
	document, err := signDocument(manifestProtocol, manifest, key)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := decodeManifest(document, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("signed ambient audio component failed daemon JSON decode: %v", err)
	}
	bad := manifest
	bad.Components = append([]worldComponent(nil), manifest.Components...)
	bad.Components[0].Beds = []audioBed{{AssetID: assetID, Gain: 0.4, Condition: "storms"}}
	if err := validateManifest(bad, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unknown ambient audio condition accepted")
	}
	bad = manifest
	bad.Assets = []assetRef{{ID: assetID, Bytes: 12, Kind: "glb", Priority: "portal-preview"}}
	if err := validateManifest(bad, ownerID.String(), time.Now()); err == nil {
		t.Fatal("non-audio asset accepted as an ambient bed")
	}
	bad.Assets = []assetRef{{ID: assetID, Bytes: 0, Kind: "audio/ogg", Priority: "portal-preview"}}
	if err := validateManifest(bad, ownerID.String(), time.Now()); err == nil {
		t.Fatal("empty audio asset accepted as an ambient bed")
	}
	var unknownBedField []worldComponent
	if err := json.Unmarshal([]byte(`[{"id":"tw-component:ambience","type":"tidewater.ambient-audio/1","beds":[{"assetId":"`+assetID+`","gain":0.4,"url":"https://invalid.example/audio.ogg"}]}]`), &unknownBedField); err == nil {
		t.Fatal("unknown ambient audio bed field accepted")
	}
}

func TestWorldManifestEnforcesAggregatePackageByteBudget(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Package budget", ownerID.String())
	manifest.WorldID = "tw-world:package-budget"
	budget := int64(3)
	manifest.Rules.MaxPackageBytes = &budget
	manifest.Assets = []assetRef{
		{ID: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Bytes: 2, Kind: "glb", Priority: "visible"},
		{ID: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Bytes: 2, Kind: "glb", Priority: "nearby"},
	}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("package larger than its signed aggregate byte budget accepted")
	}
	budget = 4
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("package at its signed aggregate byte budget rejected: %v", err)
	}
	budget = 16 << 30
	manifest.Assets[0].Bytes = maxAssetBytes + 1
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("asset larger than per-asset limit accepted under aggregate budget")
	}
}

func TestWorldManifestValidatesQuaternionAssetTransforms(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Quaternion transform", ownerID.String())
	manifest.WorldID = "tw-world:quaternion"
	assetID := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 1, Kind: "glb", Priority: "visible"}}
	manifest.Objects = []worldObject{{ID: "tw-object:rotated", Kind: "asset-instance", Label: "Rotated", AssetID: assetID, Transform: transform{Position: vector3{0, 0, 0}, Rotation: &vector4{0, 0, 0, 1}}, Scale: vector3{1, 1, 1}}}
	manifest.Objects[0].Collision.Shape = "none"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("normalized collision-free quaternion rejected: %v", err)
	}
	manifest.Objects[0].Transform.Rotation = &vector4{0, 0, 0, 2}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("non-normalized quaternion accepted")
	}
	manifest.Objects[0].Transform.Rotation = &vector4{0, 0, 0, 1}
	manifest.Objects[0].Collision.Enabled = true
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("quaternion transform with unsupported collision rotation accepted")
	}
}

func TestWorldManifestValidatesStreamingBounds(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Streaming bounds", ownerID.String())
	manifest.WorldID = "tw-world:streaming-bounds"
	assetID := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 1, Kind: "glb", Priority: "background"}}
	manifest.Objects = []worldObject{{ID: "tw-object:bounded", Kind: "asset-instance", Label: "Bounded", AssetID: assetID, Transform: transform{}, Scale: vector3{1, 1, 1}, Priority: "background", StreamingBounds: &streamingBounds{Center: vector3{1, 2, 3}, Radius: 2}}}
	manifest.Objects[0].Collision.Shape = "none"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid streaming bounds rejected: %v", err)
	}
	manifest.Objects[0].StreamingBounds.Radius = 0
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("zero-radius streaming bounds accepted")
	}
	manifest.Objects[0].StreamingBounds.Radius = 2
	manifest.Objects[0].Priority = "urgent"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("unknown object streaming priority accepted")
	}
}

func TestWorldManifestValidatesEnabledObjectCollisionBounds(t *testing.T) {
	key, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	manifest := newStarterManifest("Collision", ownerID.String())
	manifest.WorldID = "tw-world:collision"
	assetID := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	manifest.Assets = []assetRef{{ID: assetID, Bytes: 1, Kind: "glb", Priority: "visible"}}
	object := worldObject{ID: "tw-object:platform", Kind: "asset-instance", Label: "Platform", AssetID: assetID, Transform: transform{Position: vector3{0, 0, 0}}, Scale: vector3{1, 1, 1}}
	object.Collision.Shape = "box"
	object.Collision.Enabled = true
	object.Collision.HalfExtents = vector3{1, 2, 3}
	manifest.Objects = []worldObject{object}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid collision bounds rejected: %v", err)
	}
	manifest.Objects[0].Collision.HalfExtents[1] = 0
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("zero collision extent accepted")
	}
	manifest.Objects[0].Collision.HalfExtents = vector3{1, 2, 3}
	manifest.Objects[0].Collision.Shape = "none"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("enabled collision with no shape accepted")
	}
	manifest.Objects[0].Collision.Shape = "heightfield"
	manifest.Objects[0].Collision.Columns = 513
	manifest.Objects[0].Collision.Rows = 513
	manifest.Objects[0].Collision.Walkable = true
	manifest.Objects[0].Collision.Solid = true
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid heightfield collision rejected: %v", err)
	}
	manifest.Objects[0].Collision.Columns = 4097
	manifest.Objects[0].Collision.Rows = 4097
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("oversized heightfield collision accepted")
	}
	manifest.Objects[0].Collision.Shape = "compound"
	manifest.Objects[0].Collision.Boxes = []collisionBox{{Center: vector3{1, 2, 3}, HalfExtents: vector3{1, 0.5, 2}, Yaw: 0.4, Walkable: true, Solid: true}}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatalf("valid compound collision rejected: %v", err)
	}
	manifest.Objects[0].Collision.Boxes[0].Yaw = 361
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("out-of-range compound collider yaw accepted")
	}
	manifest.Objects[0].Collision.Boxes = make([]collisionBox, maxCollisionBoxes+1)
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("excessive compound collision boxes accepted")
	}
}

func TestTemporaryFailoverAuthorityRequiresOwnerWindow(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	delegate, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	delegateID, _ := peer.IDFromPublicKey(delegate.GetPublic())
	start := time.Now().Add(time.Minute).Unix()
	manifest := newStarterManifest("Island", ownerID.String())
	manifest.WorldID = "tw-world:failover"
	manifest.Hosts = []hostingGrant{{PeerID: delegateID.String(), Scopes: []string{"failover-authority"}, Epoch: 4, FailoverAfter: start, FailoverSeconds: 120, ExpiresAt: start + 300}}
	if _, err := activateFailover(manifest, delegateID.String(), delegate, time.Unix(start-1, 0)); err == nil {
		t.Fatal("failover started before owner-granted window")
	}
	document, err := activateFailover(manifest, delegateID.String(), delegate, time.Unix(start+1, 0))
	if err != nil {
		t.Fatalf("valid failover grant rejected: %v", err)
	}
	lease, err := validateAuthorityLease(document, manifest, time.Unix(start+1, 0))
	if err != nil {
		t.Fatalf("valid authority lease rejected: %v", err)
	}
	if lease.AuthorityPeerID != delegateID.String() || lease.Epoch != manifest.AuthorityEpoch+1 || lease.GrantEpoch != manifest.Hosts[0].Epoch || lease.ExpiresAt != start+120 {
		t.Fatalf("unexpected bounded authority lease: %+v", lease)
	}
	if canServeWorldAssets(manifest, delegateID.String(), time.Unix(start+1, 0)) {
		t.Fatal("failover authority implicitly granted content-cache rights")
	}
	if !canServeWorldManifest(manifest, delegateID.String(), &document, time.Unix(start+1, 0)) {
		t.Fatal("active failover authority should permit serving the signed world manifest")
	}
	if canServeWorldManifest(manifest, delegateID.String(), nil, time.Unix(start+1, 0)) {
		t.Fatal("failover-only delegate served a world manifest without an active lease")
	}
	manifest.Hosts[0].Epoch++
	if _, err := validateAuthorityLease(document, manifest, time.Unix(start+1, 0)); err == nil {
		t.Fatal("authority lease from a superseded owner grant was accepted")
	}
	manifest.Hosts[0].Epoch--
	if _, err := validateAuthorityLease(document, manifest, time.Unix(start+120, 0)); err == nil {
		t.Fatal("expired authority lease accepted")
	}
	if delay := failoverCheckDelay(manifest, delegateID.String(), nil, time.Unix(start-30, 0)); delay != 30*time.Second {
		t.Fatalf("daemon should wake at the owner-granted activation time, got %v", delay)
	}
	if delay := failoverCheckDelay(manifest, delegateID.String(), &document, time.Unix(start+30, 0)); delay != 90*time.Second {
		t.Fatalf("daemon should wake to expire its bounded lease, got %v", delay)
	}
	manifest.AuthorityEpoch = maxSafeJSInteger
	if _, err := activateFailover(manifest, delegateID.String(), delegate, time.Unix(start+1, 0)); err == nil {
		t.Fatal("failover authority advanced an epoch beyond JavaScript safe integer range")
	}
	if _, err := validateAuthorityLease(document, manifest, time.Unix(start+1, 0)); err == nil {
		t.Fatal("authority lease accepted a manifest epoch that cannot be safely advanced")
	}
}

func TestFailoverProviderWaitsForOwnerWindowBeforeDiscovery(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	delegate, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h, err := libp2p.New(libp2p.Identity(delegate), libp2p.NoListenAddrs)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Now()
	start := now.Add(2 * time.Second).Unix()
	manifest := newStarterManifest("Failover discovery", ownerID.String())
	manifest.WorldID = "tw-world:failover-discovery"
	manifest.Discoverable = true
	manifest.Hosts = []hostingGrant{{PeerID: h.ID().String(), Scopes: []string{"failover-authority"}, Epoch: 2, FailoverAfter: start, FailoverSeconds: 60, ExpiresAt: start + 120}}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	daemon := &daemon{ctx: ctx, host: h, world: manifest, key: delegate, authorityChanged: make(chan struct{}, 1)}
	maintained := make(chan struct{})
	go func() { daemon.maintainFailoverAuthority(); close(maintained) }()
	if daemon.canAnnounceWorld(now) {
		t.Fatal("failover provider advertised before its owner-authorized window")
	}
	if !daemon.waitForWorldAnnouncement() {
		t.Fatal("failover provider did not become discoverable when its owner-authorized window opened")
	}
	if daemon.currentAuthorityLease() == nil {
		t.Fatal("failover provider became discoverable without an active lease")
	}
	cancel()
	select {
	case <-maintained:
	case <-time.After(time.Second):
		t.Fatal("failover authority maintainer did not stop after cancellation")
	}
}

func TestLookupIncludesAuthorizedCacheProviders(t *testing.T) {
	localKey, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	cacheKey, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	local, _ := peer.IDFromPublicKey(localKey.GetPublic())
	cache, _ := peer.IDFromPublicKey(cacheKey.GetPublic())
	providers := collectProviders(local, true, []peer.AddrInfo{{ID: local}, {ID: cache}, {ID: cache}}, 16)
	if len(providers) != 2 || providers[0] != local.String() || providers[1] != cache.String() {
		t.Fatalf("lookup should return the local owner and unique cache peers, got %v", providers)
	}
	providers = collectProviders(local, false, []peer.AddrInfo{{ID: local}, {ID: cache}}, 16)
	if len(providers) != 1 || providers[0] != cache.String() {
		t.Fatalf("lookup should omit a node that cannot serve and retain cache peers, got %v", providers)
	}
}

func TestPortalGatewayRequiresSecureOrigin(t *testing.T) {
	for _, gateway := range []string{"https://world.example", "wss://world.example:8443/"} {
		if !validPortalGateway(gateway) {
			t.Errorf("secure portal gateway rejected: %s", gateway)
		}
	}
	for _, gateway := range []string{"http://world.example", "wss://user:pass@world.example", "https://world.example/path", "https://world.example?token=x"} {
		if validPortalGateway(gateway) {
			t.Errorf("unsafe or ambiguous portal gateway accepted: %s", gateway)
		}
	}
}

func TestDirectoryURLMustBeSecureOrigin(t *testing.T) {
	for _, directory := range []string{"https://thruhold.org", "https://directory.example/"} {
		if !validDirectoryURL(directory) {
			t.Errorf("valid directory origin rejected: %s", directory)
		}
	}
	for _, directory := range []string{"http://thruhold.org", "wss://thruhold.org", "https://directory.example/path", "https://user:pass@directory.example"} {
		if validDirectoryURL(directory) {
			t.Errorf("invalid directory URL accepted: %s", directory)
		}
	}
}

func TestWorldObjectLODContract(t *testing.T) {
	owner, _, _ := crypto.GenerateEd25519Key(rand.Reader)
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	manifest := newStarterManifest("LOD", ownerID.String())
	base := "sha256:" + strings.Repeat("a", 64)
	medium := "sha256:" + strings.Repeat("b", 64)
	low := "sha256:" + strings.Repeat("c", 64)
	manifest.Assets = []assetRef{{ID: base, Kind: "glb", Priority: "visible"}, {ID: medium, Kind: "glb", Priority: "visible"}, {ID: low, Kind: "glb", Priority: "visible"}}
	object := worldObject{ID: "tw-object:lod", Kind: "asset-instance", AssetID: base, Scale: vector3{1, 1, 1}, StreamingBounds: &streamingBounds{Radius: 4}, LODs: []objectLOD{{medium, .2}, {low, .05}}}
	object.Collision.Shape = "none"
	manifest.Objects = []worldObject{object}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, levels := range [][]objectLOD{{}, {{base, .2}}, {{medium, 1}}, {{medium, 0}}, {{medium, .2}, {low, .3}}, {{medium, .2}, {medium, .1}}, {{"sha256:" + strings.Repeat("d", 64), .2}}, {{medium, .2}, {low, .05}, {base, .01}, {low, .001}}} {
		manifest.Objects[0].LODs = levels
		if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
			t.Fatalf("accepted invalid levels %+v", levels)
		}
	}
	manifest.Objects[0] = object
	manifest.Objects[0].StreamingBounds = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("accepted LOD without bounds")
	}
	manifest.Objects[0] = object
	manifest.Assets[1].Kind = "audio/ogg"
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("accepted non GLB variant")
	}
}

func TestWorldSpawnValidation(t *testing.T) {
	owner, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ownerID, _ := peer.IDFromPublicKey(owner.GetPublic())
	manifest := newStarterManifest("Spawn", ownerID.String())
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatal(err)
	}
	yaw, pitch := math.Pi, -0.05
	manifest.Spawn = &worldSpawn{Position: []float64{53.6, 4.447713719743241, -77}, Yaw: &yaw, Pitch: &pitch}
	document, err := signDocument(manifestProtocol, manifest, owner)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodeManifest(document, ownerID.String(), time.Now())
	if err != nil || decoded.Spawn == nil || decoded.Spawn.Position[0] != 53.6 || *decoded.Spawn.Yaw != math.Pi {
		t.Fatalf("signed spawn not preserved: %v", err)
	}
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err != nil {
		t.Fatal(err)
	}
	for _, position := range [][]float64{{1, 2}, {0, math.Inf(1), 0}, {0, math.NaN(), 0}, {0, 1000001, 0}} {
		manifest.Spawn.Position = position
		if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
			t.Fatal("invalid spawn position accepted")
		}
	}
	manifest.Spawn.Position = []float64{0, 3, 8}
	for _, value := range []float64{math.NaN(), math.Inf(1), 361} {
		yaw = value
		if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
			t.Fatal("invalid spawn yaw accepted")
		}
	}
	yaw, pitch = 0, 1.6
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("invalid spawn pitch accepted")
	}
	pitch = 0
	manifest.Spawn.Yaw = nil
	if err := validateManifest(manifest, ownerID.String(), time.Now()); err == nil {
		t.Fatal("missing spawn angle accepted")
	}
}
