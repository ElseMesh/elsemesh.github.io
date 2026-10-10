package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	worldProposalSubmissionProtocol = "elsemesh.world-proposal-submission/1"
	worldProposalSubmissionDomain   = worldProposalSubmissionProtocol + "\n"
	maxProposalSubmissionBytes      = 16 << 20
	maxProposalInboxBytes           = 256 << 20
	maxProposalInboxEntries         = 4096
)

var proposalSourceHashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

type worldProposalSubmission struct {
	Protocol         string          `json:"protocol"`
	AccountPublicKey string          `json:"accountPublicKey"`
	Grant            signedDocument  `json:"grant"`
	Proposal         json.RawMessage `json:"proposal"`
	Signature        string          `json:"signature"`
}

type unsignedWorldProposalSubmission struct {
	Protocol         string          `json:"protocol"`
	AccountPublicKey string          `json:"accountPublicKey"`
	Grant            signedDocument  `json:"grant"`
	Proposal         json.RawMessage `json:"proposal"`
}

type worldProposalHeader struct {
	Protocol   string            `json:"protocol"`
	WorldID    string            `json:"worldId"`
	SourceHash string            `json:"sourceHash"`
	Operations []json.RawMessage `json:"operations"`
}

func authorizeProposalOperations(scopes []string, operations []json.RawMessage) error {
	required := make(map[string]struct{}, 2)
	for _, raw := range operations {
		var operation struct {
			Op string `json:"op"`
		}
		if err := json.Unmarshal(raw, &operation); err != nil {
			return errors.New("proposal contains an invalid operation")
		}
		switch operation.Op {
		case "object.add", "object.update", "object.remove", "world.update":
			required["world.content.edit"] = struct{}{}
		case "portal.add", "portal.update", "portal.remove":
			required["world.portals.manage"] = struct{}{}
		default:
			return errors.New("proposal contains an unsupported operation")
		}
	}
	for scope := range required {
		if !containsRoleScope(scopes, scope) {
			return fmt.Errorf("role grant does not authorize %s", scope)
		}
	}
	return nil
}

type queuedWorldProposal struct {
	ID                    string `json:"id"`
	AccountKeyFingerprint string `json:"accountKeyFingerprint"`
	GrantID               string `json:"grantId"`
	SourceHash            string `json:"sourceHash"`
	OperationCount        int    `json:"operationCount"`
}

// listWorldProposals reads the private local inbox and verifies that each
// entry is still the exact content-addressed, account-signed submission that
// was accepted by the HTTP intake path.
func listWorldProposals(directory, worldID, ownerPeerID string) ([]queuedWorldProposal, error) {
	if err := validatePrivateProposalInbox(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []queuedWorldProposal{}, nil
	}
	if err != nil {
		return nil, err
	}
	result := make([]queuedWorldProposal, 0, len(entries))
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") || len(entry.Name()) != 64+len(".json") {
			return nil, errors.New("proposal inbox contains an unexpected entry")
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil, errors.New("proposal inbox contains a symbolic link")
		}
		id := "sha256:" + stringsTrimSuffixJSON(entry.Name())
		item, err := readQueuedWorldProposal(filepath.Join(directory, entry.Name()), id, worldID, ownerPeerID)
		if err != nil {
			return nil, fmt.Errorf("proposal %s: %w", id, err)
		}
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result, nil
}

func exportWorldProposal(directory, id, worldID, ownerPeerID, destination string) (queuedWorldProposal, error) {
	if !proposalSourceHashPattern.MatchString(id) {
		return queuedWorldProposal{}, errors.New("proposal ID must be a sha256 content ID")
	}
	if err := validatePrivateProposalInbox(directory); err != nil {
		return queuedWorldProposal{}, err
	}
	path := filepath.Join(directory, stringsTrimPrefixSHA256(id)+".json")
	item, err := readQueuedWorldProposal(path, id, worldID, ownerPeerID)
	if err != nil {
		return queuedWorldProposal{}, err
	}
	var submission worldProposalSubmission
	if err := decodeStrictJSONFile(path, &submission); err != nil {
		return queuedWorldProposal{}, err
	}
	proposal, err := json.MarshalIndent(json.RawMessage(submission.Proposal), "", "  ")
	if err != nil {
		return queuedWorldProposal{}, err
	}
	if err := writeNewPrivateFile(destination, append(proposal, '\n')); err != nil {
		return queuedWorldProposal{}, err
	}
	return item, nil
}

// removeWorldProposal removes exactly one reviewed submission. Verification is
// required even for cleanup so an ID cannot delete an unrelated inbox file.
func removeWorldProposal(directory, id, worldID, ownerPeerID string) (queuedWorldProposal, error) {
	if !proposalSourceHashPattern.MatchString(id) {
		return queuedWorldProposal{}, errors.New("proposal ID must be a sha256 content ID")
	}
	if err := validatePrivateProposalInbox(directory); err != nil {
		return queuedWorldProposal{}, err
	}
	path := filepath.Join(directory, stringsTrimPrefixSHA256(id)+".json")
	item, err := readQueuedWorldProposal(path, id, worldID, ownerPeerID)
	if err != nil {
		return queuedWorldProposal{}, err
	}
	if err := os.Remove(path); err != nil {
		return queuedWorldProposal{}, err
	}
	inbox, err := os.Open(directory)
	if err != nil {
		return item, fmt.Errorf("proposal removed but inbox durability could not be confirmed: %w", err)
	}
	defer inbox.Close()
	if err := inbox.Sync(); err != nil {
		return item, fmt.Errorf("proposal removed but inbox durability could not be confirmed: %w", err)
	}
	return item, nil
}

func validatePrivateProposalInbox(directory string) error {
	info, err := os.Lstat(directory)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return fmt.Errorf("proposal inbox must be a private 0700 directory (got %s)", info.Mode().Perm())
	}
	return nil
}

func readQueuedWorldProposal(path, id, worldID, ownerPeerID string) (queuedWorldProposal, error) {
	var item queuedWorldProposal
	info, err := os.Lstat(path)
	if err != nil {
		return item, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > maxProposalSubmissionBytes {
		return item, errors.New("stored proposal is not a private regular file within the size limit")
	}
	encoded, err := os.ReadFile(path)
	if err != nil {
		return item, err
	}
	var submission worldProposalSubmission
	if err := decodeStrictJSON(encoded, &submission); err != nil {
		return item, errors.New("invalid stored submission")
	}
	canonical, err := canonicalJSON(submission)
	if err != nil {
		return item, err
	}
	digest := sha256.Sum256(canonical)
	if "sha256:"+hex.EncodeToString(digest[:]) != id {
		return item, errors.New("stored content does not match its proposal ID")
	}
	if submission.Protocol != worldProposalSubmissionProtocol {
		return item, errors.New("unsupported submission protocol")
	}
	if err := verifyDocument(submission.Grant, worldRoleGrantProtocol); err != nil || submission.Grant.Signer != ownerPeerID {
		return item, errors.New("owner role-grant signature is invalid")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(submission.AccountPublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return item, errors.New("invalid account public key")
	}
	signature, err := base64.RawURLEncoding.DecodeString(submission.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return item, errors.New("invalid account signature")
	}
	unsigned := unsignedWorldProposalSubmission{Protocol: submission.Protocol, AccountPublicKey: submission.AccountPublicKey, Grant: submission.Grant, Proposal: submission.Proposal}
	message, err := canonicalJSON(unsigned)
	if err != nil {
		return item, err
	}
	message = append([]byte(worldProposalSubmissionDomain), message...)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), message, signature) {
		return item, errors.New("account submission signature is invalid")
	}
	var grant worldRoleGrant
	if err := json.Unmarshal(submission.Grant.Payload, &grant); err != nil || grant.WorldID != worldID || grant.OwnerPeerID != ownerPeerID {
		return item, errors.New("role grant does not target this world owner")
	}
	fingerprintBytes := sha256.Sum256(publicKey)
	fingerprint := "sha256:" + hex.EncodeToString(fingerprintBytes[:])
	if grant.AccountKeyFingerprint != fingerprint {
		return item, errors.New("role grant does not authorize this account")
	}
	var proposal worldProposalHeader
	if err := decodeStrictJSON(submission.Proposal, &proposal); err != nil || proposal.Protocol != "elsemesh.world-proposal/1" || proposal.WorldID != worldID || !proposalSourceHashPattern.MatchString(proposal.SourceHash) || len(proposal.Operations) == 0 || len(proposal.Operations) > 1000 {
		return item, errors.New("invalid proposal document")
	}
	if err := authorizeProposalOperations(grant.Scopes, proposal.Operations); err != nil {
		return item, err
	}
	return queuedWorldProposal{ID: id, AccountKeyFingerprint: fingerprint, GrantID: grant.GrantID, SourceHash: proposal.SourceHash, OperationCount: len(proposal.Operations)}, nil
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON data")
	}
	return nil
}

func decodeStrictJSONFile(path string, destination any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return decodeStrictJSON(data, destination)
}

func writeNewPrivateFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		_ = os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(path)
		return err
	}
	directory, err := os.Open(filepath.Dir(path))
	if err != nil {
		_ = os.Remove(path)
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func stringsTrimSuffixJSON(name string) string { return strings.TrimSuffix(name, ".json") }

func (d *daemon) handleWorldProposalSubmission(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST, OPTIONS")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if d.key == nil || d.proposalDir == "" {
		http.Error(w, "proposal inbox is not available", http.StatusServiceUnavailable)
		return
	}
	ownerID, err := peerIDForKey(d.key.GetPublic())
	if err != nil || ownerID.String() != d.world.OwnerPeerID {
		http.Error(w, "only the world owner node accepts edit proposals", http.StatusForbidden)
		return
	}
	if r.Body == nil {
		http.Error(w, "missing signed proposal submission", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProposalSubmissionBytes+1))
	if err != nil || len(body) > maxProposalSubmissionBytes {
		http.Error(w, "proposal submission exceeds 16 MiB", http.StatusRequestEntityTooLarge)
		return
	}
	var submission worldProposalSubmission
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&submission); err != nil {
		http.Error(w, "invalid proposal submission", http.StatusBadRequest)
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		http.Error(w, "invalid proposal submission", http.StatusBadRequest)
		return
	}
	if err := d.validateWorldProposalSubmission(submission, time.Now()); err != nil {
		http.Error(w, "proposal submission rejected: "+err.Error(), http.StatusForbidden)
		return
	}
	canonical, err := canonicalJSON(submission)
	if err != nil {
		http.Error(w, "could not canonicalize proposal submission", http.StatusBadRequest)
		return
	}
	digest := sha256.Sum256(canonical)
	proposalID := "sha256:" + hex.EncodeToString(digest[:])
	d.proposalMu.Lock()
	defer d.proposalMu.Unlock()
	if err := d.storeWorldProposal(proposalID, canonical); err != nil {
		if errors.Is(err, errProposalInboxFull) {
			http.Error(w, "proposal inbox is full", http.StatusInsufficientStorage)
		} else {
			http.Error(w, "could not store proposal submission", http.StatusInternalServerError)
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]string{"proposalId": proposalID, "status": "queued-for-owner-review"})
}

func (d *daemon) validateWorldProposalSubmission(submission worldProposalSubmission, now time.Time) error {
	if submission.Protocol != worldProposalSubmissionProtocol || len(submission.Proposal) == 0 || len(submission.Proposal) > maxProposalSubmissionBytes {
		return errors.New("invalid submission envelope")
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(submission.AccountPublicKey)
	if err != nil || len(publicKey) != ed25519.PublicKeySize {
		return errors.New("invalid account public key")
	}
	signature, err := base64.RawURLEncoding.DecodeString(submission.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize {
		return errors.New("invalid account signature")
	}
	digest := sha256.Sum256(publicKey)
	fingerprint := "sha256:" + hex.EncodeToString(digest[:])
	grant, err := validateWorldRoleGrant(submission.Grant, d.world.WorldID, d.world.OwnerPeerID, now)
	if err != nil {
		return fmt.Errorf("invalid owner role grant: %w", err)
	}
	if grant.AccountKeyFingerprint != fingerprint {
		return errors.New("role grant does not target this account")
	}
	d.roleStateMu.RLock()
	if d.roleStateSerial == 0 {
		d.roleStateMu.RUnlock()
		return errors.New("fresh owner revocation state is required")
	}
	revocationsDocument := d.roleState
	serial := d.roleStateSerial
	d.roleStateMu.RUnlock()
	revocations, err := validateWorldRoleRevocations(revocationsDocument, d.world.WorldID, d.world.OwnerPeerID, serial, now)
	if err != nil {
		return fmt.Errorf("fresh owner revocation state is required: %w", err)
	}
	if roleGrantIsRevoked(grant, revocations) {
		return errors.New("account key or role grant has been revoked")
	}
	var proposal worldProposalHeader
	proposalDecoder := json.NewDecoder(bytes.NewReader(submission.Proposal))
	proposalDecoder.DisallowUnknownFields()
	if err := proposalDecoder.Decode(&proposal); err != nil {
		return fmt.Errorf("invalid world proposal: %w", err)
	}
	var proposalTrailing any
	if err := proposalDecoder.Decode(&proposalTrailing); !errors.Is(err, io.EOF) {
		return errors.New("invalid world proposal")
	}
	if proposal.Protocol != "elsemesh.world-proposal/1" || proposal.WorldID != d.world.WorldID || !proposalSourceHashPattern.MatchString(proposal.SourceHash) || len(proposal.Operations) == 0 || len(proposal.Operations) > 1000 {
		return errors.New("proposal must target this world and contain a bounded source-hash-bound operation list")
	}
	if err := authorizeProposalOperations(grant.Scopes, proposal.Operations); err != nil {
		return err
	}
	unsigned := unsignedWorldProposalSubmission{
		Protocol: submission.Protocol, AccountPublicKey: submission.AccountPublicKey,
		Grant: submission.Grant, Proposal: submission.Proposal,
	}
	message, err := canonicalJSON(unsigned)
	if err != nil {
		return err
	}
	message = append([]byte(worldProposalSubmissionDomain), message...)
	if !ed25519.Verify(ed25519.PublicKey(publicKey), message, signature) {
		return errors.New("account proposal signature is invalid")
	}
	return nil
}

var errProposalInboxFull = errors.New("proposal inbox is full")

func (d *daemon) storeWorldProposal(id string, data []byte) error {
	entries, err := os.ReadDir(d.proposalDir)
	if err != nil {
		return err
	}
	var total int64
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("proposal inbox contains an invalid entry")
		}
		total += info.Size()
	}
	name := filepath.Join(d.proposalDir, stringsTrimPrefixSHA256(id)+".json")
	if info, err := os.Stat(name); err == nil && info.Mode().IsRegular() {
		return nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(entries) >= maxProposalInboxEntries || total+int64(len(data)) > maxProposalInboxBytes {
		return errProposalInboxFull
	}
	file, err := os.CreateTemp(d.proposalDir, ".proposal-*")
	if err != nil {
		return err
	}
	temporary := file.Name()
	defer os.Remove(temporary)
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(temporary, name); err != nil {
		if errors.Is(err, os.ErrExist) {
			return nil
		}
		return err
	}
	directory, err := os.Open(d.proposalDir)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func prepareProposalInbox(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("proposal inbox must be a real directory")
	}
	return os.Chmod(path, 0700)
}

func stringsTrimPrefixSHA256(id string) string {
	return id[len("sha256:"):]
}

func containsRoleScope(scopes []string, wanted string) bool {
	for _, scope := range scopes {
		if scope == wanted {
			return true
		}
	}
	return false
}
