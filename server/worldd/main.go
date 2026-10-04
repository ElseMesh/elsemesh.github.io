package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p-kad-dht"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	"github.com/libp2p/go-libp2p/p2p/discovery/routing"
	ma "github.com/multiformats/go-multiaddr"
	"github.com/quic-go/quic-go/http3"
	"github.com/quic-go/webtransport-go"
)

const worldProtocol protocol.ID = "/tidewater/world/1.0.0"

var buildRevision = "development"

type stringFlags []string

func (s *stringFlags) String() string         { return strings.Join(*s, ",") }
func (s *stringFlags) Set(value string) error { *s = append(*s, value); return nil }

type daemon struct {
	ctx                   context.Context
	host                  host.Host
	dht                   *dht.IpfsDHT
	discovery             *routing.RoutingDiscovery
	manifest              signedDocument
	authorityMu           sync.RWMutex
	authority             *signedDocument
	authorityChanged      chan struct{}
	world                 worldManifest
	key                   crypto.PrivKey
	assetsDir             string
	webRoot               string
	publicGateway         string
	directoryURL          string
	allowedBrowserOrigins map[string]struct{}
	assetCheckMu          sync.Mutex
	verifiedAssets        map[string]assetFileStamp
	roleStateMu           sync.RWMutex
	roleState             signedDocument
	roleStateSerial       uint64
	roleStatePath         string
	proposalDir           string
	proposalMu            sync.Mutex
	presenceMu            sync.Mutex
	players               map[string]playerPresence
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	version := flag.Bool("version", false, "print the build revision and exit")
	configDir, err := os.UserConfigDir()
	if err != nil {
		return err
	}
	elsemeshConfigDir := filepath.Join(configDir, "elsemesh")
	defaultData := filepath.Join(configDir, "tidewater", "worldd")
	worldsDir := flag.String("worlds-dir", filepath.Join(configDir, "elsemesh", "worlds"), "directory containing named local ThruHold profiles")
	worldProfile := flag.String("world-profile", "", "select a named local ThruHold profile (uses a separate node identity and data directory)")
	listWorldProfiles := flag.Bool("list-world-profiles", false, "list named local ThruHold profiles, then exit")
	listProposals := flag.Bool("list-proposals", false, "list this owner's locally queued edit proposals, then exit (requires --manifest)")
	inspectManifest := flag.Bool("inspect-manifest", false, "verify and print the current owner-signed manifest payload, then exit")
	publishManifestPath := flag.String("publish-manifest", "", "publish an unsigned next-version manifest after importing its package assets")
	baseSourcePath := flag.String("base-source", "", "exact world-source file used as the publication base")
	candidateSourcePath := flag.String("source", "", "world-source file represented by --publish-manifest")
	exportProposalID := flag.String("export-proposal", "", "export one verified queued proposal patch by sha256 ID (requires --manifest and --proposal-out)")
	removeProposalID := flag.String("remove-proposal", "", "remove one verified queued proposal by sha256 ID after owner review (requires --manifest)")
	proposalOut := flag.String("proposal-out", "", "new private output file for --export-proposal")
	dataDir := flag.String("data", defaultData, "private daemon data directory")
	zeroTierDataDir := flag.String("zerotier-data", filepath.Join(elsemeshConfigDir, "zerotier"), "private persistent libzt identity/state directory (one identity per device by default)")
	manifestPath := flag.String("manifest", "", "owner-signed world manifest JSON")
	signManifestPath := flag.String("sign-manifest", "", "validate and owner-sign an unsigned runtime world manifest, then exit")
	manifestOut := flag.String("manifest-out", "", "output path for --sign-manifest (must not already exist)")
	signRoleGrantPath := flag.String("sign-role-grant", "", "validate and owner-sign a world role grant payload, then exit")
	signRoleRevocationsPath := flag.String("sign-role-revocations", "", "validate and owner-sign a role revocation payload, then exit")
	roleDocumentOut := flag.String("role-document-out", "", "new private output path for --sign-role-grant or --sign-role-revocations")
	importAssetPath := flag.String("import-asset", "", "import one asset into the content-addressed store, print its sha256 ID, then exit")
	importPackagePath := flag.String("import-package", "", "verify and import all assets referenced by --manifest from this hash-named assets directory, then exit")
	printNodeID := flag.Bool("print-node-id", false, "print this data directory's persistent node PeerID, then exit")
	exportNodeKey := flag.String("export-node-key", "", "write this data directory's private identity key to a new 0600 file, then exit")
	importNodeKey := flag.String("import-node-key", "", "install a 0600 private identity key if node.key does not exist, then exit")
	worldName := flag.String("world-name", "My ThruHold", "create a local starter world when none is supplied")
	listenPort := flag.Int("p2p-port", 42901, "libp2p TCP and QUIC listen port")
	zeroTierNetwork := flag.String("zerotier-network", defaultZeroTierNetworkID, "ZeroTier network ID to join through libzt (requires a zerotier build)")
	httpAddress := flag.String("http", "127.0.0.1:5200", "HTTP/WebSocket gateway listen address; place behind TLS for public browser access")
	webTransportAddress := flag.String("webtransport", "", "optional WebTransport HTTP/3 UDP listen address, for example :5201")
	webTransportCert := flag.String("webtransport-tls-cert", "", "TLS certificate for the optional WebTransport listener")
	webTransportKey := flag.String("webtransport-tls-key", "", "TLS private key for the optional WebTransport listener")
	webRoot := flag.String("web-root", "", "optional built ElseMesh web client directory")
	publicGateway := flag.String("public-gateway", "", "public HTTPS/WSS gateway origin included in signed node records")
	directoryURL := flag.String("directory-url", "", "optional HTTPS ElseMesh directory service URL for publishing this discoverable node")
	var allowedBrowserOriginsFlags stringFlags
	dhtMode := flag.String("dht-mode", "auto", "DHT mode: auto, client, or server")
	serveRelay := flag.Bool("relay-service", false, "allow this node to provide a bounded libp2p circuit relay")
	var bootstrap stringFlags
	var relays stringFlags
	var cacheFrom stringFlags
	var roleStateFrom stringFlags
	var announceAddresses stringFlags
	flag.Var(&bootstrap, "bootstrap", "bootstrap peer multiaddr (repeatable)")
	flag.Var(&relays, "relay", "static relay peer multiaddr (repeatable)")
	flag.Var(&cacheFrom, "cache-from", "owner-authorized upstream node PeerID to seed this node's content cache (repeatable)")
	flag.Var(&roleStateFrom, "role-state-from", "world neighbor PeerID to sync owner-signed role revocations from (repeatable)")
	flag.Var(&announceAddresses, "announce-address", "externally reachable IP multiaddr to advertise (repeatable; useful when Android blocks interface discovery)")
	flag.Var(&allowedBrowserOriginsFlags, "allow-browser-origin", "allow this exact HTTP(S) browser origin to connect to the WebSocket gateway (repeatable)")
	cacheSyncInterval := flag.Duration("cache-sync-interval", 5*time.Minute, "how often to retry missing owner-authorized cached assets")
	roleStateSyncInterval := flag.Duration("role-state-sync-interval", time.Minute, "how often to sync owner-signed role revocations")
	flag.Parse()
	if *version {
		fmt.Printf("%s %s\n", daemonName, buildRevision)
		return nil
	}
	operationCount := 0
	for _, requested := range []bool{*printNodeID, *exportNodeKey != "", *importNodeKey != "", *importAssetPath != "", *importPackagePath != "", *signManifestPath != "", *signRoleGrantPath != "", *signRoleRevocationsPath != "", *listWorldProfiles, *listProposals, *inspectManifest, *publishManifestPath != "", *exportProposalID != "", *removeProposalID != ""} {
		if requested {
			operationCount++
		}
	}
	publishOperation := *publishManifestPath != "" && *importPackagePath != "" && *manifestPath != "" && *baseSourcePath != "" && *candidateSourcePath != ""
	if publishOperation {
		operationCount-- // publishing is one combined import-and-activate operation
	}
	if operationCount > 1 || (*publishManifestPath != "" && !publishOperation) || ((*baseSourcePath != "" || *candidateSourcePath != "") && *publishManifestPath == "") || (*inspectManifest && *manifestPath == "") || (*manifestOut != "" && *signManifestPath == "") || (*roleDocumentOut != "" && *signRoleGrantPath == "" && *signRoleRevocationsPath == "") || ((*signRoleGrantPath != "" || *signRoleRevocationsPath != "") && *roleDocumentOut == "") || (*signRoleGrantPath != "" && *signRoleRevocationsPath != "") || (*proposalOut != "" && *exportProposalID == "") || (*exportProposalID != "" && (*proposalOut == "" || *manifestPath == "")) || ((*listProposals || *removeProposalID != "") && *manifestPath == "") {
		return errors.New("choose one one-shot operation; publish, signing, and proposal export flags require their matching inputs")
	}
	if *listWorldProfiles {
		if *worldProfile != "" {
			return errors.New("--list-world-profiles cannot be combined with --world-profile")
		}
		profiles, listErr := listWorldProfilesIn(*worldsDir)
		if listErr != nil {
			return listErr
		}
		for _, profile := range profiles {
			fmt.Println(profile)
		}
		return nil
	}
	dataWasSet := false
	flag.Visit(func(current *flag.Flag) {
		if current.Name == "data" {
			dataWasSet = true
		}
	})
	if *worldProfile != "" {
		if dataWasSet {
			return errors.New("--world-profile cannot be combined with --data")
		}
		profileData, profileErr := worldProfileDataDir(*worldsDir, *worldProfile)
		if profileErr != nil {
			return profileErr
		}
		*dataDir = profileData
	}
	if *listenPort < 1 || *listenPort > 65535 {
		return errors.New("p2p-port must be between 1 and 65535")
	}
	if *dhtMode != "auto" && *dhtMode != "client" && *dhtMode != "server" {
		return errors.New("dht-mode must be auto, client, or server")
	}
	if *cacheSyncInterval < time.Second {
		return errors.New("cache-sync-interval must be at least one second")
	}
	if *roleStateSyncInterval < time.Second || *roleStateSyncInterval > 10*time.Minute {
		return errors.New("role-state-sync-interval must be between one second and ten minutes")
	}
	parsedAnnounceAddresses, err := parseAnnounceAddresses(announceAddresses)
	if err != nil {
		return fmt.Errorf("announce address: %w", err)
	}
	var zeroTier zeroTierRuntime
	if (*webTransportAddress == "" && (*webTransportCert != "" || *webTransportKey != "")) || (*webTransportAddress != "" && (*webTransportCert == "" || *webTransportKey == "")) {
		return errors.New("--webtransport requires both --webtransport-tls-cert and --webtransport-tls-key")
	}
	if *publicGateway != "" && !validPortalGateway(*publicGateway) {
		return errors.New("public-gateway must be a secure HTTPS/WSS origin without path, query, or credentials")
	}
	if *directoryURL != "" && (!validDirectoryURL(*directoryURL) || *publicGateway == "") {
		return errors.New("directory-url requires an HTTPS service origin and --public-gateway")
	}
	allowedBrowserOrigins, err := parseAllowedBrowserOrigins(allowedBrowserOriginsFlags)
	if err != nil {
		return fmt.Errorf("allow-browser-origin: %w", err)
	}
	if *listProposals || *removeProposalID != "" || *exportProposalID != "" || *inspectManifest || *publishManifestPath != "" {
		identityPath := filepath.Join(*dataDir, "node.key")
		info, statErr := os.Lstat(identityPath)
		if statErr != nil {
			return fmt.Errorf("proposal review requires an existing owner node key at %s: %w", identityPath, statErr)
		}
		if !info.Mode().IsRegular() {
			return errors.New("proposal review requires a regular owner node key file")
		}
	}
	if err := os.MkdirAll(*dataDir, 0700); err != nil {
		return err
	}
	if *importNodeKey != "" {
		id, importErr := importIdentity(*importNodeKey, filepath.Join(*dataDir, "node.key"))
		if importErr != nil {
			return importErr
		}
		fmt.Println(id)
		return nil
	}
	key, err := loadIdentity(filepath.Join(*dataDir, "node.key"))
	if err != nil {
		return err
	}
	localID, err := peer.IDFromPublicKey(key.GetPublic())
	if err != nil {
		return err
	}
	if *printNodeID {
		fmt.Println(localID.String())
		return nil
	}
	if *exportNodeKey != "" {
		id, exportErr := exportIdentity(filepath.Join(*dataDir, "node.key"), *exportNodeKey)
		if exportErr != nil {
			return exportErr
		}
		fmt.Println(id)
		return nil
	}
	if *listProposals || *removeProposalID != "" || *exportProposalID != "" {
		document, loadErr := loadWorldManifest(*manifestPath, *dataDir, *worldName, localID.String(), key)
		if loadErr != nil {
			return loadErr
		}
		world, decodeErr := decodeManifest(document, localID.String(), time.Now())
		if decodeErr != nil {
			return fmt.Errorf("world manifest: %w", decodeErr)
		}
		if world.OwnerPeerID != localID.String() {
			return errors.New("proposal inbox commands are available only on the world owner node")
		}
		inbox := filepath.Join(*dataDir, "proposals")
		if *listProposals {
			proposals, listErr := listWorldProposals(inbox, world.WorldID, world.OwnerPeerID)
			if listErr != nil {
				return listErr
			}
			encoded, marshalErr := json.MarshalIndent(proposals, "", "  ")
			if marshalErr != nil {
				return marshalErr
			}
			fmt.Println(string(encoded))
			return nil
		}
		var proposal queuedWorldProposal
		var reviewErr error
		if *removeProposalID != "" {
			proposal, reviewErr = removeWorldProposal(inbox, *removeProposalID, world.WorldID, world.OwnerPeerID)
		} else {
			proposal, reviewErr = exportWorldProposal(inbox, *exportProposalID, world.WorldID, world.OwnerPeerID, *proposalOut)
		}
		if reviewErr != nil {
			return reviewErr
		}
		encoded, marshalErr := json.Marshal(proposal)
		if marshalErr != nil {
			return marshalErr
		}
		fmt.Println(string(encoded))
		return nil
	}
	if *inspectManifest || *publishManifestPath != "" {
		activePath := filepath.Join(*dataDir, "world.json")
		if *manifestPath != activePath {
			return errors.New("manifest inspection and publication require --manifest to be this profile's data/world.json")
		}
		if *inspectManifest {
			world, _, inspectErr := readOwnedWorldManifest(activePath, localID.String(), key, time.Now())
			if inspectErr != nil {
				return inspectErr
			}
			encoded, marshalErr := json.Marshal(world)
			if marshalErr != nil {
				return marshalErr
			}
			fmt.Println(string(encoded))
			return nil
		}
		baseHash, hashErr := hashWorldSourceFile(*baseSourcePath)
		if hashErr != nil {
			return fmt.Errorf("base source: %w", hashErr)
		}
		candidateHash, hashErr := hashWorldSourceFile(*candidateSourcePath)
		if hashErr != nil {
			return fmt.Errorf("candidate source: %w", hashErr)
		}
		count, totalBytes, publishErr := publishOwnerWorldManifest(activePath, *publishManifestPath, *importPackagePath, baseHash, candidateHash, *dataDir, localID.String(), key, time.Now())
		if publishErr != nil {
			return publishErr
		}
		fmt.Printf("Published world version after importing %d verified package assets (%d bytes); restart worldd to load the new manifest.\n", count, totalBytes)
		return nil
	}
	if *importAssetPath != "" {
		id, importErr := importAsset(*importAssetPath, filepath.Join(*dataDir, "assets"))
		if importErr != nil {
			return importErr
		}
		fmt.Println(id)
		return nil
	}
	if *importPackagePath != "" {
		if *manifestPath == "" {
			return errors.New("--import-package requires an owner-signed --manifest")
		}
		document, loadErr := loadWorldManifest(*manifestPath, *dataDir, *worldName, localID.String(), key)
		if loadErr != nil {
			return loadErr
		}
		count, totalBytes, importErr := importAuthorizedPackage(document, localID.String(), *importPackagePath, filepath.Join(*dataDir, "assets"), time.Now())
		if importErr != nil {
			return importErr
		}
		fmt.Printf("Imported %d verified package assets (%d bytes)\n", count, totalBytes)
		return nil
	}
	if *signManifestPath != "" {
		if *manifestOut == "" {
			return errors.New("--manifest-out is required with --sign-manifest")
		}
		return signManifestFile(*signManifestPath, *manifestOut, localID.String(), key, time.Now())
	}
	if *signRoleGrantPath != "" || *signRoleRevocationsPath != "" {
		if *manifestPath == "" {
			return errors.New("role documents require --manifest for the exact world being authorized")
		}
		if *roleDocumentOut == *signRoleGrantPath || *roleDocumentOut == *signRoleRevocationsPath {
			return errors.New("role-document output must differ from its unsigned input")
		}
		document, loadErr := loadWorldManifest(*manifestPath, *dataDir, *worldName, localID.String(), key)
		if loadErr != nil {
			return loadErr
		}
		world, decodeErr := decodeManifest(document, localID.String(), time.Now())
		if decodeErr != nil {
			return fmt.Errorf("world manifest: %w", decodeErr)
		}
		if *signRoleGrantPath != "" {
			return signWorldRoleGrantFile(*signRoleGrantPath, *roleDocumentOut, world, key, time.Now())
		}
		state := &daemon{world: world, roleStatePath: roleRevocationStatePath(*dataDir, world.WorldID)}
		if err := state.loadRoleRevocations(); err != nil {
			return fmt.Errorf("load persisted role revocations: %w", err)
		}
		return signWorldRoleRevocationsFile(*signRoleRevocationsPath, *roleDocumentOut, world, state.roleStateSerial, key, time.Now())
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	if *zeroTierNetwork != "" {
		if err := migrateLegacyZeroTierStorage(filepath.Join(configDir, "tidewater", "worldd", "zerotier"), *zeroTierDataDir); err != nil {
			return fmt.Errorf("migrate existing ZeroTier identity: %w", err)
		}
		zeroTier, err = startZeroTier(*zeroTierNetwork, *zeroTierDataDir)
		if err != nil {
			return fmt.Errorf("start ZeroTier: %w", err)
		}
		defer func() {
			stop()
			_ = zeroTier.Close()
		}()
		address := zeroTier.Address()
		ztTCP, parseErr := ma.NewMultiaddr(fmt.Sprintf("/ip6/%s/tcp/%d", address, *listenPort))
		if parseErr != nil {
			return fmt.Errorf("ZeroTier 6PLANE address: %w", parseErr)
		}
		parsedAnnounceAddresses = append(parsedAnnounceAddresses, ztTCP)
		log.Printf("ZeroTier node %s joined %s at %s", zeroTier.NodeID(), *zeroTierNetwork, address)
	} else {
		defer stop()
	}

	listen := libp2pListenAddresses(*listenPort, parsedAnnounceAddresses)
	opts := []libp2p.Option{libp2p.Identity(key), libp2p.ListenAddrStrings(listen...), libp2p.EnableAutoNATv2(), libp2p.EnableHolePunching()}
	if zeroTier != nil {
		opts = append(opts, zeroTier.Libp2pOptions()...)
	}
	if len(parsedAnnounceAddresses) > 0 {
		opts = append(opts, libp2p.AddrsFactory(appendAnnouncedAddresses(parsedAnnounceAddresses)))
	}
	relayOpts, relayErr := worlddRelayOptions(*serveRelay, relays)
	if relayErr != nil {
		return fmt.Errorf("relay address: %w", relayErr)
	}
	opts = append(opts, relayOpts...)
	p2pHost, err := libp2p.New(opts...)
	if err != nil {
		return fmt.Errorf("start libp2p: %w", err)
	}
	defer p2pHost.Close()
	if zeroTier != nil {
		if err := zeroTier.StartBridge(ctx, *listenPort); err != nil {
			return fmt.Errorf("start ZeroTier TCP bridge: %w", err)
		}
	}

	mode := dht.ModeAuto
	if *dhtMode == "client" {
		mode = dht.ModeClient
	}
	if *dhtMode == "server" {
		mode = dht.ModeServer
	}
	bootPeers, err := parsePeerAddrs(bootstrap)
	if err != nil {
		return fmt.Errorf("bootstrap address: %w", err)
	}
	dhtOptions := []dht.Option{dht.Mode(mode), dht.ProtocolPrefix("/tidewater/kad/1.0.0")}
	if len(bootPeers) > 0 {
		dhtOptions = append(dhtOptions, dht.BootstrapPeers(bootPeers...))
	}
	router, err := dht.New(ctx, p2pHost, dhtOptions...)
	if err != nil {
		return fmt.Errorf("start peer discovery: %w", err)
	}
	defer router.Close()
	for _, info := range bootPeers {
		p2pHost.Peerstore().AddAddrs(info.ID, info.Addrs, time.Hour)
		connectCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		if connectErr := p2pHost.Connect(connectCtx, info); connectErr != nil {
			log.Printf("bootstrap peer %s connection pending: %v", info.ID, connectErr)
		}
		cancel()
	}
	if err := router.Bootstrap(ctx); err != nil {
		log.Printf("DHT bootstrap pending: %v", err)
	}

	localPeerID := p2pHost.ID().String()
	manifest, err := loadWorldManifest(*manifestPath, *dataDir, *worldName, localPeerID, key)
	if err != nil {
		return err
	}
	world, err := decodeManifest(manifest, localPeerID, time.Now())
	if err != nil {
		return fmt.Errorf("world manifest: %w", err)
	}
	d := &daemon{ctx: ctx, host: p2pHost, dht: router, discovery: routing.NewRoutingDiscovery(router), manifest: manifest, world: world, key: key, assetsDir: filepath.Join(*dataDir, "assets"), proposalDir: filepath.Join(*dataDir, "proposals"), webRoot: *webRoot, publicGateway: *publicGateway, directoryURL: *directoryURL, allowedBrowserOrigins: allowedBrowserOrigins, authorityChanged: make(chan struct{}, 1), verifiedAssets: make(map[string]assetFileStamp), roleStatePath: roleRevocationStatePath(*dataDir, world.WorldID)}
	if err := d.loadRoleRevocations(); err != nil {
		return fmt.Errorf("load persisted role revocations: %w", err)
	}
	if world.OwnerPeerID != localPeerID {
		go d.maintainFailoverAuthority()
	}
	if err := os.MkdirAll(d.assetsDir, 0700); err != nil {
		return err
	}
	if err := prepareProposalInbox(d.proposalDir); err != nil {
		return err
	}
	cacheSources := make([]peer.ID, 0, len(cacheFrom))
	for _, value := range cacheFrom {
		id, decodeErr := peer.Decode(value)
		if decodeErr != nil || id == p2pHost.ID() {
			return fmt.Errorf("invalid --cache-from peer %q", value)
		}
		cacheSources = append(cacheSources, id)
	}
	roleStateSources := make([]peer.ID, 0, len(roleStateFrom))
	for _, value := range roleStateFrom {
		id, decodeErr := peer.Decode(value)
		if decodeErr != nil || id == p2pHost.ID() {
			return fmt.Errorf("invalid --role-state-from peer %q", value)
		}
		roleStateSources = append(roleStateSources, id)
	}
	if len(cacheSources) > 0 {
		if !d.canServeAssets(time.Now()) {
			return errors.New("--cache-from requires ownership or an active content-cache grant")
		}
		go d.syncCacheLoop(cacheSources, *cacheSyncInterval)
	}
	if len(roleStateSources) > 0 {
		go d.syncRoleRevocationsLoop(roleStateSources, *roleStateSyncInterval)
	}
	p2pHost.SetStreamHandler(worldProtocol, d.handlePeerStream)
	go d.advertiseWorld()
	go d.logPeerAddresses()
	if d.directoryURL != "" {
		go d.publishDirectory()
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", d.handleHealth)
	mux.HandleFunc("/.well-known/tidewater/node", d.handleNodeRecord)
	mux.HandleFunc("/api/lookup", d.handleLookup)
	mux.HandleFunc("/api/world/manifest", d.handleManifest)
	mux.HandleFunc("/api/world/roles/revocations", d.handleRoleRevocations)
	mux.HandleFunc("/api/world/proposals", d.handleWorldProposalSubmission)
	mux.HandleFunc("/api/assets/", d.handleAsset)
	mux.HandleFunc("/gateway", d.handleBrowserGateway)
	var wtServer *webtransport.Server
	if *webTransportAddress != "" {
		wtServer = &webtransport.Server{H3: http3.Server{Addr: *webTransportAddress, Handler: securityHeaders(mux)}}
		mux.HandleFunc("/gateway-webtransport", func(w http.ResponseWriter, r *http.Request) {
			d.handleBrowserWebTransport(w, r, wtServer)
		})
	}
	if d.webRoot != "" {
		mux.Handle("/", http.FileServer(http.Dir(d.webRoot)))
	}
	server := &http.Server{Addr: *httpAddress, Handler: securityHeaders(mux), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 90 * time.Second}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.ListenAndServe() }()
	var webTransportErr chan error
	if wtServer != nil {
		webTransportErr = make(chan error, 1)
		go func() { webTransportErr <- wtServer.ListenAndServeTLS(*webTransportCert, *webTransportKey) }()
		log.Printf("worldd WebTransport HTTP/3 UDP listen=%s", *webTransportAddress)
	}
	log.Printf("worldd node=%s world=%s http=%s", localID, world.WorldID, *httpAddress)
	for _, addr := range p2pHost.Addrs() {
		log.Printf("p2p address %s/p2p/%s", addr, p2pHost.ID())
	}
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		httpErr := server.Shutdown(shutdownCtx)
		if wtServer != nil {
			if wtErr := wtServer.Close(); httpErr == nil {
				httpErr = wtErr
			}
		}
		return httpErr
	case err := <-serverErr:
		if wtServer != nil {
			_ = wtServer.Close()
		}
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case err := <-webTransportErr:
		_ = server.Close()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func parsePeerAddrs(values []string) ([]peer.AddrInfo, error) {
	infos := make([]peer.AddrInfo, 0, len(values))
	indices := make(map[peer.ID]int, len(values))
	seenAddrs := make(map[peer.ID]map[string]struct{}, len(values))
	for _, value := range values {
		addr, err := ma.NewMultiaddr(value)
		if err != nil {
			return nil, err
		}
		info, err := peer.AddrInfoFromP2pAddr(addr)
		if err != nil {
			return nil, err
		}
		index, exists := indices[info.ID]
		if !exists {
			index = len(infos)
			indices[info.ID] = index
			seenAddrs[info.ID] = make(map[string]struct{}, len(info.Addrs))
			infos = append(infos, peer.AddrInfo{ID: info.ID})
		}
		for _, candidate := range info.Addrs {
			if _, exists := seenAddrs[info.ID][candidate.String()]; exists {
				continue
			}
			infos[index].Addrs = append(infos[index].Addrs, candidate)
			seenAddrs[info.ID][candidate.String()] = struct{}{}
		}
	}
	return infos, nil
}

func worlddRelayOptions(serveRelay bool, relayAddresses []string) ([]libp2p.Option, error) {
	options := make([]libp2p.Option, 0, 2)
	if serveRelay {
		options = append(options, libp2p.EnableRelayService())
	}
	if len(relayAddresses) != 0 {
		infos, err := parsePeerAddrs(relayAddresses)
		if err != nil {
			return nil, err
		}
		options = append(options, libp2p.EnableRelay(), libp2p.EnableAutoRelayWithStaticRelays(infos))
	}
	return options, nil
}

func parseAnnounceAddresses(values []string) ([]ma.Multiaddr, error) {
	if len(values) > 16 {
		return nil, errors.New("at most 16 announce addresses are allowed")
	}
	addresses := make([]ma.Multiaddr, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		addr, err := ma.NewMultiaddr(value)
		if err != nil {
			return nil, err
		}
		protocols := addr.Protocols()
		validShape := len(protocols) == 2 && (protocols[0].Code == ma.P_IP4 || protocols[0].Code == ma.P_IP6) && protocols[1].Code == ma.P_TCP
		validShape = validShape || len(protocols) == 3 && (protocols[0].Code == ma.P_IP4 || protocols[0].Code == ma.P_IP6) && protocols[1].Code == ma.P_UDP && protocols[2].Code == ma.P_QUIC_V1
		if !validShape {
			return nil, fmt.Errorf("%q must be an IP/TCP or IP/UDP/QUIC-v1 multiaddr without a peer ID", value)
		}
		ipText, err := addr.ValueForProtocol(protocols[0].Code)
		if err != nil {
			return nil, err
		}
		ip := net.ParseIP(ipText)
		if ip == nil || !ip.IsGlobalUnicast() {
			return nil, fmt.Errorf("%q must use a non-loopback unicast IP address", value)
		}
		canonical := addr.String()
		if !seen[canonical] {
			addresses = append(addresses, addr)
			seen[canonical] = true
		}
	}
	return addresses, nil
}

func appendAnnouncedAddresses(extra []ma.Multiaddr) func([]ma.Multiaddr) []ma.Multiaddr {
	return func(addresses []ma.Multiaddr) []ma.Multiaddr {
		result := append([]ma.Multiaddr(nil), addresses...)
		seen := make(map[string]bool, len(result)+len(extra))
		for _, address := range result {
			seen[address.String()] = true
		}
		for _, address := range extra {
			if !seen[address.String()] {
				result = append(result, address)
				seen[address.String()] = true
			}
		}
		return result
	}
}

func libp2pListenAddresses(port int, announced []ma.Multiaddr) []string {
	addresses := []string{fmt.Sprintf("/ip4/0.0.0.0/tcp/%d", port), fmt.Sprintf("/ip4/0.0.0.0/udp/%d/quic-v1", port)}
	for _, address := range announced {
		protocols := address.Protocols()
		if len(protocols) > 0 && protocols[0].Code == ma.P_IP6 {
			addresses = append(addresses, fmt.Sprintf("/ip6/::/tcp/%d", port), fmt.Sprintf("/ip6/::/udp/%d/quic-v1", port))
			break
		}
	}
	return addresses
}

func loadWorldManifest(path, dataDir, title, owner string, key crypto.PrivKey) (signedDocument, error) {
	if path == "" {
		path = filepath.Join(dataDir, "world.json")
	}
	bytes, err := os.ReadFile(path)
	if err == nil {
		var doc signedDocument
		if len(bytes) > maxManifestBytes {
			return doc, errors.New("world manifest exceeds 1 MiB")
		}
		if err := json.Unmarshal(bytes, &doc); err != nil {
			return doc, err
		}
		return doc, nil
	}
	if !errors.Is(err, os.ErrNotExist) || path != filepath.Join(dataDir, "world.json") {
		return signedDocument{}, err
	}
	manifest := newStarterManifest(title, owner)
	doc, err := signDocument(manifestProtocol, manifest, key)
	if err != nil {
		return signedDocument{}, err
	}
	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return signedDocument{}, err
	}
	if err := os.WriteFile(path, encoded, 0600); err != nil {
		return signedDocument{}, err
	}
	return doc, nil
}

func newStarterManifest(title, owner string) worldManifest {
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		panic(err)
	}
	return worldManifest{Protocol: manifestProtocol, WorldID: fmt.Sprintf("tw-world:%x", random[:]), OwnerPeerID: owner, AuthorityPeerID: owner, AuthorityEpoch: 1, Version: 1, Title: title,
		Rules: worldRules{Gravity: 1, AvatarComplexity: 20000, PhysicsProfile: "tidewater-default", Movement: &movementRules{WalkSpeed: 3, SprintSpeed: 6.2, JumpSpeed: 4.6}}, Assets: []assetRef{}, Portals: []portal{}, UpdatedAt: time.Now().Unix()}
}

func (d *daemon) advertiseWorld() {
	if !d.waitForWorldAnnouncement() {
		return
	}
	for {
		if d.ctx.Err() != nil || !d.canAnnounceWorld(time.Now()) {
			return
		}
		if d.canServeAssets(time.Now()) && !d.hasCompleteAssets() && d.currentAuthorityLease() == nil {
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-d.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}
		break
	}
	namespace := "tidewater-world-v1:" + d.world.WorldID
	for {
		if !d.canAnnounceWorld(time.Now()) || d.canServeAssets(time.Now()) && !d.hasCompleteAssets() && d.currentAuthorityLease() == nil {
			return
		}
		// An isolated node can report a successful local advertisement without
		// publishing a provider record to any DHT peers. Retry promptly after it
		// joins the mesh instead of sleeping for the full provider-record TTL.
		if len(d.host.Network().Peers()) == 0 {
			timer := time.NewTimer(5 * time.Second)
			select {
			case <-d.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			continue
		}
		ctx, cancel := context.WithTimeout(d.ctx, 75*time.Second)
		ttl, err := d.discovery.Advertise(ctx, namespace)
		cancel()
		if err != nil {
			log.Printf("world discovery publish failed: %v", err)
			ttl = 5 * time.Minute
		}
		refresh := ttl * 2 / 3
		if refresh > time.Minute {
			refresh = time.Minute
		}
		timer := time.NewTimer(refresh)
		select {
		case <-d.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (d *daemon) logPeerAddresses() {
	<-time.After(2 * time.Second)
	for _, addr := range d.host.Addrs() {
		log.Printf("node address %s/p2p/%s", addr, d.host.ID())
	}
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if r.URL.Scheme == "https" || r.Header.Get("X-Forwarded-Proto") == "https" {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

func (d *daemon) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "nodeId": d.host.ID().String(), "worldId": d.world.WorldID, "protocol": manifestProtocol, "dhtPeers": len(d.host.Network().Peers())})
}

func (d *daemon) maintainFailoverAuthority() {
	for d.ctx.Err() == nil {
		now := time.Now()
		changed := false
		d.authorityMu.Lock()
		if d.authority != nil {
			if _, err := validateAuthorityLease(*d.authority, d.world, now); err != nil {
				d.authority = nil
				changed = true
			}
		}
		if d.authority == nil {
			if lease, err := activateFailover(d.world, d.host.ID().String(), d.key, now); err == nil {
				d.authority = &lease
				changed = true
				log.Printf("temporary failover authority active for %s at epoch %d", d.world.WorldID, d.world.AuthorityEpoch+1)
			}
		}
		var active *signedDocument
		if d.authority != nil {
			lease := *d.authority
			active = &lease
		}
		d.authorityMu.Unlock()
		if changed {
			select {
			case d.authorityChanged <- struct{}{}:
			default:
			}
		}

		delay := failoverCheckDelay(d.world, d.host.ID().String(), active, now)
		if delay <= 0 {
			return
		}
		timer := time.NewTimer(delay)
		select {
		case <-d.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (d *daemon) waitForWorldAnnouncement() bool {
	for d.ctx.Err() == nil {
		now := time.Now()
		if d.canAnnounceWorld(now) {
			return true
		}
		delay := failoverCheckDelay(d.world, d.host.ID().String(), nil, now)
		if delay <= 0 {
			if !d.world.Discoverable || !d.canServeAssets(now) || d.hasCompleteAssets() {
				return false
			}
			delay = 5 * time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-d.ctx.Done():
			timer.Stop()
			return false
		case <-d.authorityChanged:
			timer.Stop()
		case <-timer.C:
		}
	}
	return false
}

func (d *daemon) currentAuthorityLease() *signedDocument {
	d.authorityMu.Lock()
	defer d.authorityMu.Unlock()
	if d.authority == nil {
		return nil
	}
	if _, err := validateAuthorityLease(*d.authority, d.world, time.Now()); err != nil {
		d.authority = nil
		return nil
	}
	lease := *d.authority
	return &lease
}

func (d *daemon) handleNodeRecord(w http.ResponseWriter, _ *http.Request) {
	now := time.Now()
	record := map[string]any{"protocol": "tidewater.node/1", "nodeId": d.host.ID().String(), "addresses": d.peerAddresses(), "worldIds": []string{d.world.WorldID}, "gateway": d.publicGateway, "issuedAt": now.Unix(), "expiresAt": now.Add(24 * time.Hour).Unix()}
	doc, err := signDocument("tidewater.node/1", record, d.key)
	if err != nil {
		http.Error(w, "could not sign node record", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (d *daemon) publishDirectory() {
	if !d.world.Discoverable {
		log.Printf("directory publishing skipped: world %s is not marked discoverable", d.world.WorldID)
		return
	}
	if !d.waitForWorldAnnouncement() {
		return
	}
	client := &http.Client{Timeout: 15 * time.Second}
	for d.ctx.Err() == nil {
		if !d.canAnnounceWorld(time.Now()) {
			log.Printf("directory publishing stopped: node is no longer authorized to announce %s", d.world.WorldID)
			return
		}
		if d.canServeAssets(time.Now()) && !d.hasCompleteAssets() && d.currentAuthorityLease() == nil {
			timer := time.NewTimer(5 * time.Minute)
			select {
			case <-d.ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				continue
			}
		}
		published := false
		now := time.Now()
		nodeRecord := map[string]any{"protocol": "tidewater.node/1", "nodeId": d.host.ID().String(), "addresses": d.peerAddresses(), "worldIds": []string{d.world.WorldID}, "gateway": d.publicGateway, "issuedAt": now.Unix(), "expiresAt": now.Add(24 * time.Hour).Unix()}
		nodeDocument, err := signDocument("tidewater.node/1", nodeRecord, d.key)
		if err == nil {
			body, marshalErr := json.Marshal(map[string]any{"node": nodeDocument, "manifest": d.manifest, "authorityLease": d.currentAuthorityLease()})
			if marshalErr == nil {
				ctx, cancel := context.WithTimeout(d.ctx, 15*time.Second)
				request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(d.directoryURL, "/")+"/v1/announce", bytes.NewReader(body))
				if requestErr == nil {
					request.Header.Set("Content-Type", "application/json")
					response, postErr := client.Do(request)
					if postErr != nil {
						log.Printf("directory publish failed: %v", postErr)
					} else {
						response.Body.Close()
						if response.StatusCode == http.StatusAccepted {
							published = true
						} else {
							log.Printf("directory publish rejected: HTTP %d", response.StatusCode)
						}
					}
				} else {
					log.Printf("directory publish request failed: %v", requestErr)
				}
				cancel()
			} else {
				log.Printf("directory publish encode failed: %v", marshalErr)
			}
		} else {
			log.Printf("directory node record signing failed: %v", err)
		}
		interval := 5 * time.Minute
		if published {
			interval = 12 * time.Hour
		}
		timer := time.NewTimer(interval)
		select {
		case <-d.ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (d *daemon) peerAddresses() []string {
	addresses := make([]string, 0, len(d.host.Addrs()))
	for _, addr := range d.host.Addrs() {
		addresses = append(addresses, addr.Encapsulate(mustP2PAddr(d.host.ID())).String())
	}
	return addresses
}

func mustP2PAddr(id peer.ID) ma.Multiaddr {
	addr, _ := ma.NewMultiaddr("/p2p/" + id.String())
	return addr
}

func (d *daemon) handleManifest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if r.URL.Query().Get("worldId") != "" && r.URL.Query().Get("worldId") != d.world.WorldID {
		http.NotFound(w, r)
		return
	}
	if !d.canServeWorldManifest(time.Now()) {
		http.Error(w, "this node is not authorized to serve the world manifest", http.StatusForbidden)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=30, must-revalidate")
	writeJSON(w, http.StatusOK, map[string]any{"document": d.manifest, "authorityLease": d.currentAuthorityLease()})
}

func (d *daemon) handleLookup(w http.ResponseWriter, r *http.Request) {
	setPublicReadCORS(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	worldID := r.URL.Query().Get("worldId")
	if !worldIDPattern.MatchString(worldID) {
		http.Error(w, "invalid worldId", http.StatusBadRequest)
		return
	}
	localCanServe := worldID == d.world.WorldID && d.canServeWorldDiscovery(time.Now())
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	peers, err := d.discovery.FindPeers(ctx, "tidewater-world-v1:"+worldID)
	if err != nil {
		if localCanServe {
			writeJSON(w, http.StatusOK, map[string]any{"worldId": worldID, "providers": []string{d.host.ID().String()}, "authority": d.currentAuthorityIdentity()})
			return
		}
		http.Error(w, "discovery unavailable", http.StatusServiceUnavailable)
		return
	}
	discovered := make([]peer.AddrInfo, 0, 16)
	for info := range peers {
		discovered = append(discovered, info)
		if len(discovered) == 32 {
			break
		}
	}
	providers := collectProviders(d.host.ID(), localCanServe, discovered, 16)
	for _, info := range discovered {
		if info.ID != "" && info.ID != d.host.ID() {
			d.host.Peerstore().AddAddrs(info.ID, info.Addrs, time.Hour)
		}
	}
	result := map[string]any{"worldId": worldID, "providers": providers}
	if worldID == d.world.WorldID {
		result["authority"] = d.currentAuthorityIdentity()
	}
	writeJSON(w, http.StatusOK, result)
}

func setPublicReadCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
}

func collectProviders(local peer.ID, localCanServe bool, discovered []peer.AddrInfo, limit int) []string {
	if limit <= 0 {
		return []string{}
	}
	providers := make([]string, 0, min(limit, len(discovered)+1))
	seen := make(map[peer.ID]bool, len(discovered)+1)
	if localCanServe && local != "" {
		providers = append(providers, local.String())
		seen[local] = true
	}
	for _, info := range discovered {
		if info.ID == "" || seen[info.ID] || (info.ID == local && !localCanServe) {
			continue
		}
		providers = append(providers, info.ID.String())
		seen[info.ID] = true
		if len(providers) == limit {
			break
		}
	}
	return providers
}

func (d *daemon) handleAsset(w http.ResponseWriter, r *http.Request) {
	if !d.canServeAssets(time.Now()) {
		http.Error(w, "this node is not authorized to cache world content", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/assets/")
	if !assetIDPattern.MatchString(id) {
		http.Error(w, "invalid asset id", http.StatusBadRequest)
		return
	}
	if !d.manifestHasAsset(id) {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(d.assetsDir, strings.TrimPrefix(id, "sha256:"))
	f, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	asset, ok := d.assetRef(id)
	if err != nil || !ok || !info.Mode().IsRegular() || info.Size() != asset.Bytes {
		http.Error(w, "asset unavailable", http.StatusBadRequest)
		return
	}
	hash, err := hashFile(f)
	if err != nil || hash != id {
		http.Error(w, "asset hash does not match its address", http.StatusUnprocessableEntity)
		return
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		http.Error(w, "asset unavailable", http.StatusInternalServerError)
		return
	}
	w.Header().Set("ETag", `"`+strings.TrimPrefix(id, "sha256:")+`"`)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Accept-Ranges", "bytes")
	http.ServeContent(w, r, id, info.ModTime(), f)
}

func (d *daemon) resolveWorldPeer(ctx context.Context, worldID, targetPeerID string) error {
	if targetPeerID == d.host.ID().String() {
		if worldID != d.world.WorldID {
			return errors.New("world_not_hosted")
		}
		return nil
	}
	peerID, err := peer.Decode(targetPeerID)
	if err != nil {
		return errors.New("invalid_target_peer")
	}
	if d.host.Network().Connectedness(peerID) == network.Connected {
		return nil
	}
	if len(d.host.Peerstore().Addrs(peerID)) == 0 {
		if err := d.discoverTarget(ctx, worldID, peerID); err != nil {
			return err
		}
	}
	connectCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	return d.host.Connect(connectCtx, peer.AddrInfo{ID: peerID})
}

func hashFile(f io.Reader) (string, error) {
	hasher := sha256.New()
	if _, err := io.Copy(hasher, io.LimitReader(f, maxAssetBytes+1)); err != nil {
		return "", err
	}
	return fmt.Sprintf("sha256:%x", hasher.Sum(nil)), nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func parseAllowedBrowserOrigins(origins []string) (map[string]struct{}, error) {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		normalized, ok := normalizeBrowserOrigin(origin)
		if !ok {
			return nil, fmt.Errorf("%q must be an HTTPS origin or a loopback HTTP origin without a path", origin)
		}
		allowed[normalized] = struct{}{}
	}
	return allowed, nil
}

func normalizeBrowserOrigin(origin string) (string, bool) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Opaque != "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", false
	}
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Host)
	if scheme != "https" && (scheme != "http" || !isLoopbackBrowserHost(parsed.Hostname())) {
		return "", false
	}
	return scheme + "://" + host, true
}

func isLoopbackBrowserHost(host string) bool {
	return strings.EqualFold(host, "localhost") || strings.EqualFold(host, "127.0.0.1") || strings.EqualFold(host, "::1")
}

func browserGatewayOriginAllowed(origin, requestHost string, secure bool, allowed map[string]struct{}) bool {
	if origin == "" {
		return true
	}
	normalized, ok := normalizeBrowserOrigin(origin)
	if !ok {
		return false
	}
	scheme := "http"
	if secure {
		scheme = "https"
	}
	if strings.EqualFold(normalized, scheme+"://"+requestHost) {
		return true
	}
	_, ok = allowed[normalized]
	return ok
}

type gatewayMessage struct {
	PresenceSession string      `json:"presenceSession,omitempty"`
	Pose            *playerPose `json:"pose,omitempty"`
	presenceKey     string
	Type            string `json:"type"`
	WorldID         string `json:"worldId,omitempty"`
	AssetID         string `json:"assetId,omitempty"`
	TargetPeerID    string `json:"targetPeerId,omitempty"`
	RequestID       string `json:"requestId,omitempty"`
	Offset          int64  `json:"offset,omitempty"`
	Length          int64  `json:"length,omitempty"`
}

type peerResponse struct {
	PlayerID        string           `json:"playerId,omitempty"`
	Players         []playerPresence `json:"players,omitempty"`
	Type            string           `json:"type"`
	WorldID         string           `json:"worldId,omitempty"`
	RequestID       string           `json:"requestId,omitempty"`
	Document        *signedDocument  `json:"document,omitempty"`
	RoleRevocations *signedDocument  `json:"roleRevocations,omitempty"`
	AuthorityLease  *signedDocument  `json:"authorityLease,omitempty"`
	AssetID         string           `json:"assetId,omitempty"`
	Offset          int64            `json:"offset"`
	Total           int64            `json:"total,omitempty"`
	Chunk           string           `json:"chunk,omitempty"`
	Error           string           `json:"error,omitempty"`
}

func (d *daemon) handleBrowserGateway(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 4096, CheckOrigin: func(request *http.Request) bool {
		return browserGatewayOriginAllowed(request.Header.Get("Origin"), request.Host, request.TLS != nil, d.allowedBrowserOrigins)
	}}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()
	conn.SetReadLimit(64 << 10)
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	var first gatewayMessage
	if err := conn.ReadJSON(&first); err != nil || first.Type != "connect" || !worldIDPattern.MatchString(first.WorldID) {
		_ = conn.WriteJSON(map[string]string{"type": "error", "code": "world_unavailable"})
		return
	}
	if first.TargetPeerID == "" {
		first.TargetPeerID = d.host.ID().String()
	}
	if err := d.resolveWorldPeer(r.Context(), first.WorldID, first.TargetPeerID); err != nil {
		_ = conn.WriteJSON(map[string]string{"type": "error", "code": "world_unreachable"})
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	if err := conn.WriteJSON(map[string]any{"type": "connected", "nodeId": d.host.ID().String(), "targetPeerId": first.TargetPeerID, "worldId": first.WorldID, "manifestProtocol": manifestProtocol}); err != nil {
		return
	}
	sessionID, err := newPresenceSession()
	if err != nil {
		return
	}
	defer d.leaveBrowserPresence(first.WorldID, first.TargetPeerID, sessionID)
	requestCtx, cancelRequests := context.WithCancel(r.Context())
	var requestGroup sync.WaitGroup
	var writeMu sync.Mutex
	requestSlots := make(chan struct{}, 3)
	defer func() {
		cancelRequests()
		requestGroup.Wait()
	}()
	for {
		var message gatewayMessage
		if err := conn.ReadJSON(&message); err != nil {
			return
		}
		message.WorldID = first.WorldID
		message.TargetPeerID = first.TargetPeerID
		bindPresenceRequest(&message, d.host.ID().String(), sessionID)
		requestSlots <- struct{}{}
		requestGroup.Add(1)
		go func(message gatewayMessage) {
			defer requestGroup.Done()
			defer func() { <-requestSlots }()
			response, err := d.gatewayRequest(requestCtx, message)
			if err != nil {
				response = peerResponse{Type: "error", WorldID: first.WorldID, RequestID: message.RequestID, Error: err.Error()}
			}
			writeMu.Lock()
			writeErr := conn.WriteJSON(response)
			writeMu.Unlock()
			if writeErr != nil {
				cancelRequests()
				_ = conn.Close()
			}
		}(message)
	}
}

func (d *daemon) manifestHasAsset(id string) bool {
	_, ok := d.assetRef(id)
	return ok
}

func (d *daemon) assetRef(id string) (assetRef, bool) {
	for _, asset := range d.world.Assets {
		if asset.ID == id {
			return asset, true
		}
	}
	return assetRef{}, false
}

func (d *daemon) hasCompleteAssets() bool {
	for _, asset := range d.world.Assets {
		if !d.hasVerifiedAsset(asset) {
			return false
		}
	}
	return true
}

func (d *daemon) canServeAssets(now time.Time) bool {
	return canServeWorldAssets(d.world, d.host.ID().String(), now)
}

func (d *daemon) canServeWorldManifest(now time.Time) bool {
	return canServeWorldManifest(d.world, d.host.ID().String(), d.currentAuthorityLease(), now)
}

func canServeWorldManifest(manifest worldManifest, localID string, lease *signedDocument, now time.Time) bool {
	if canServeWorldAssets(manifest, localID, now) {
		return true
	}
	if lease == nil {
		return false
	}
	_, err := validateAuthorityLease(*lease, manifest, now)
	return err == nil && lease.Signer == localID
}

func (d *daemon) canAnnounceWorld(now time.Time) bool {
	return d.world.Discoverable && d.canServeWorldDiscovery(now)
}

func (d *daemon) canServeWorldDiscovery(now time.Time) bool {
	if d.canServeAssets(now) && d.hasCompleteAssets() {
		return true
	}
	return d.currentAuthorityLease() != nil
}

func (d *daemon) currentAuthorityIdentity() string {
	if lease := d.currentAuthorityLease(); lease != nil {
		var payload authorityLease
		if json.Unmarshal(lease.Payload, &payload) == nil {
			return payload.AuthorityPeerID
		}
	}
	return d.world.AuthorityPeerID
}

func canServeWorldAssets(manifest worldManifest, localID string, now time.Time) bool {
	if manifest.OwnerPeerID == localID {
		return true
	}
	for _, grant := range manifest.Hosts {
		if grant.PeerID != localID || grant.ExpiresAt <= now.Unix() {
			continue
		}
		for _, scope := range grant.Scopes {
			if scope == "content-cache" {
				return true
			}
		}
	}
	return false
}

func (d *daemon) handlePeerStream(stream network.Stream) {
	defer stream.Close()
	stream.SetReadDeadline(time.Now().Add(20 * time.Second))
	var envelope gatewayMessage
	decoder := json.NewDecoder(io.LimitReader(stream, 64<<10))
	if err := decoder.Decode(&envelope); err != nil {
		return
	}
	bindPresenceRequest(&envelope, stream.Conn().RemotePeer().String(), envelope.PresenceSession)
	response, err := d.localRequest(envelope)
	if err != nil {
		response = peerResponse{Type: "error", WorldID: envelope.WorldID, RequestID: envelope.RequestID, Error: err.Error()}
	}
	stream.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = json.NewEncoder(stream).Encode(response)
}

func (d *daemon) localRequest(request gatewayMessage) (peerResponse, error) {
	if request.WorldID != d.world.WorldID {
		return peerResponse{}, errors.New("world_not_hosted")
	}
	switch request.Type {
	case "presence.update", "presence.leave":
		return d.presenceRequest(request, time.Now())
	case "manifest.get":
		return peerResponse{Type: "manifest", WorldID: d.world.WorldID, RequestID: request.RequestID, Document: &d.manifest, AuthorityLease: d.currentAuthorityLease()}, nil
	case "role-revocations.get":
		d.roleStateMu.RLock()
		defer d.roleStateMu.RUnlock()
		var document *signedDocument
		if d.roleStateSerial > 0 {
			copy := d.roleState
			document = &copy
		}
		return peerResponse{Type: "role-revocations", WorldID: d.world.WorldID, RequestID: request.RequestID, RoleRevocations: document}, nil
	case "asset.get":
		if !d.canServeAssets(time.Now()) {
			return peerResponse{}, errors.New("content_cache_not_authorized")
		}
		return d.assetChunk(request)
	default:
		return peerResponse{}, errors.New("unsupported_request")
	}
}

func (d *daemon) gatewayRequest(ctx context.Context, request gatewayMessage) (peerResponse, error) {
	if request.TargetPeerID == d.host.ID().String() {
		return d.localRequest(request)
	}
	peerID, err := peer.Decode(request.TargetPeerID)
	if err != nil {
		return peerResponse{}, errors.New("invalid_target_peer")
	}
	if d.host.Network().Connectedness(peerID) != network.Connected {
		if len(d.host.Peerstore().Addrs(peerID)) == 0 {
			if err := d.discoverTarget(ctx, request.WorldID, peerID); err != nil {
				return peerResponse{}, err
			}
		}
		connectCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		defer cancel()
		if err := d.host.Connect(connectCtx, peer.AddrInfo{ID: peerID}); err != nil {
			return peerResponse{}, errors.New("target_peer_unreachable")
		}
	}
	streamCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	stream, err := d.host.NewStream(streamCtx, peerID, worldProtocol)
	if err != nil {
		return peerResponse{}, errors.New("target_stream_unavailable")
	}
	defer stream.Close()
	_ = stream.SetDeadline(time.Now().Add(15 * time.Second))
	if err := json.NewEncoder(stream).Encode(request); err != nil {
		return peerResponse{}, err
	}
	var response peerResponse
	if err := json.NewDecoder(io.LimitReader(stream, 2<<20)).Decode(&response); err != nil {
		return peerResponse{}, err
	}
	if response.WorldID != request.WorldID || response.RequestID != request.RequestID {
		return peerResponse{}, errors.New("target_response_mismatch")
	}
	if response.Type == "error" {
		return peerResponse{}, errors.New(response.Error)
	}
	return response, nil
}

func (d *daemon) discoverTarget(ctx context.Context, worldID string, target peer.ID) error {
	lookupCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	peers, err := d.discovery.FindPeers(lookupCtx, "tidewater-world-v1:"+worldID)
	if err != nil {
		return errors.New("world_discovery_unavailable")
	}
	for info := range peers {
		if info.ID != target {
			continue
		}
		d.host.Peerstore().AddAddrs(info.ID, info.Addrs, time.Minute)
		return nil
	}
	return errors.New("world_peer_not_found")
}

func (d *daemon) assetChunk(request gatewayMessage) (peerResponse, error) {
	asset, ok := d.assetRef(request.AssetID)
	if !ok {
		return peerResponse{}, errors.New("asset_not_in_manifest")
	}
	if request.Offset < 0 || request.Length < 1 || request.Length > 192<<10 {
		return peerResponse{}, errors.New("invalid_asset_range")
	}
	path := filepath.Join(d.assetsDir, strings.TrimPrefix(request.AssetID, "sha256:"))
	f, err := os.Open(path)
	if err != nil {
		return peerResponse{}, errors.New("asset_unavailable")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != asset.Bytes {
		return peerResponse{}, errors.New("asset_unavailable")
	}
	if request.Offset >= info.Size() && info.Size() != 0 {
		return peerResponse{}, errors.New("asset_offset_out_of_range")
	}
	if _, err := f.Seek(request.Offset, io.SeekStart); err != nil {
		return peerResponse{}, err
	}
	chunk := make([]byte, request.Length)
	n, err := io.ReadFull(f, chunk)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return peerResponse{}, err
	}
	chunk = chunk[:n]
	return peerResponse{Type: "asset.chunk", WorldID: d.world.WorldID, RequestID: request.RequestID, AssetID: request.AssetID, Offset: request.Offset, Total: info.Size(), Chunk: base64.RawStdEncoding.EncodeToString(chunk)}, nil
}
