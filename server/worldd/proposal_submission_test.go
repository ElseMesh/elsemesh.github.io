package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	crypto "github.com/libp2p/go-libp2p/core/crypto"
)

func TestWorldProposalSubmissionRequiresFreshGrantAndPersistsForOwnerReview(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:proposal-inbox"
	proposalDir := filepath.Join(t.TempDir(), "proposals")
	if err := os.Mkdir(proposalDir, 0700); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	grant := worldRoleGrant{
		Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID,
		GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint,
		Scopes: []string{"world.content.edit"}, IssuedAt: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	grantDocument, err := signDocument(worldRoleGrantProtocol, grant, owner)
	if err != nil {
		t.Fatal(err)
	}
	revocationDocument := signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-time.Minute), now.Add(10*time.Minute), nil, nil)
	d := &daemon{
		world: worldManifest{WorldID: worldID, OwnerPeerID: ownerID}, key: owner,
		roleState: revocationDocument, roleStateSerial: 1, proposalDir: proposalDir,
	}
	proposal := proposalForTest(worldID, "world.update")
	submission := makeSignedProposalSubmission(t, member, grantDocument, proposal)
	body, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/world/proposals", bytes.NewReader(body))
	response := httptest.NewRecorder()
	d.handleWorldProposalSubmission(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("valid proposal rejected: code=%d body=%s", response.Code, response.Body.String())
	}
	var reply struct {
		ProposalID string `json:"proposalId"`
		Status     string `json:"status"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Status != "queued-for-owner-review" || len(reply.ProposalID) != len("sha256:")+64 {
		t.Fatalf("unexpected proposal response: %+v", reply)
	}
	storedPath := filepath.Join(proposalDir, reply.ProposalID[len("sha256:"):]+".json")
	stored, err := os.Stat(storedPath)
	if err != nil || stored.Mode().Perm() != 0600 {
		t.Fatalf("proposal not stored privately: stat=%v err=%v", stored, err)
	}
	storedJSON, err := os.ReadFile(storedPath)
	if err != nil {
		t.Fatal(err)
	}
	var persisted worldProposalSubmission
	var storedProposal worldProposalHeader
	if err := json.Unmarshal(storedJSON, &persisted); err != nil || json.Unmarshal(persisted.Proposal, &storedProposal) != nil || storedProposal.Protocol == "" {
		t.Fatalf("stored proposal is invalid: err=%v", err)
	}
	response = httptest.NewRecorder()
	d.handleWorldProposalSubmission(response, httptest.NewRequest(http.MethodPost, "/api/world/proposals", bytes.NewReader(body)))
	if response.Code != http.StatusCreated {
		t.Fatalf("idempotent resubmission failed: code=%d body=%s", response.Code, response.Body.String())
	}
}

func TestWorldProposalCanonicalEnvelopeEscapesHTMLLikeBrowserSigner(t *testing.T) {
	unsigned := unsignedWorldProposalSubmission{
		Protocol: worldProposalSubmissionProtocol, AccountPublicKey: "AQID",
		Grant: signedDocument{
			Protocol: "tidewater.world-role/1", Signer: "owner", PublicKey: "public", Signature: "signature",
			Payload: json.RawMessage(`{"name":"<A&B>","n":1}`),
		},
		Proposal: json.RawMessage(`{"protocol":"elsemesh.world-proposal/1","worldId":"tw-world:canonical","sourceHash":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","operations":[],"title":"<A&B>"}`),
	}
	canonical, err := canonicalJSON(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"accountPublicKey":"AQID","grant":{"payload":{"n":1,"name":"\u003cA\u0026B\u003e"},"protocol":"tidewater.world-role/1","publicKey":"public","signature":"signature","signer":"owner"},"proposal":{"operations":[],"protocol":"elsemesh.world-proposal/1","sourceHash":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","title":"\u003cA\u0026B\u003e","worldId":"tw-world:canonical"},"protocol":"elsemesh.world-proposal-submission/1"}`
	if string(canonical) != want {
		t.Fatalf("canonical submission = %s, want %s", canonical, want)
	}
}

func TestOwnerCanListAndExportVerifiedQueuedWorldProposal(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:proposal-review"
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	grant := worldRoleGrant{
		Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID,
		GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint,
		Scopes: []string{"world.content.edit"}, IssuedAt: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	grantDocument, err := signDocument(worldRoleGrantProtocol, grant, owner)
	if err != nil {
		t.Fatal(err)
	}
	submission := makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))
	canonical, err := canonicalJSON(submission)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	id := "sha256:" + hex.EncodeToString(digest[:])
	inbox := filepath.Join(t.TempDir(), "proposals")
	if err := prepareProposalInbox(inbox); err != nil {
		t.Fatal(err)
	}
	if err := writeNewPrivateFile(filepath.Join(inbox, stringsTrimPrefixSHA256(id)+".json"), append(canonical, '\n')); err != nil {
		t.Fatal(err)
	}
	listed, err := listWorldProposals(inbox, worldID, ownerID)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != id || listed[0].AccountKeyFingerprint != fingerprint || listed[0].GrantID != grant.GrantID || listed[0].OperationCount != 1 {
		t.Fatalf("unexpected proposal list: %+v", listed)
	}
	output := filepath.Join(t.TempDir(), "proposal.json")
	exported, err := exportWorldProposal(inbox, id, worldID, ownerID, output)
	if err != nil {
		t.Fatal(err)
	}
	if exported.ID != id {
		t.Fatalf("exported proposal ID = %s, want %s", exported.ID, id)
	}
	info, err := os.Stat(output)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("proposal export is not private: stat=%v err=%v", info, err)
	}
	var proposal worldProposalHeader
	if err := decodeStrictJSONFile(output, &proposal); err != nil || proposal.WorldID != worldID || len(proposal.Operations) != 1 {
		t.Fatalf("export is not the unsigned proposal patch: proposal=%+v err=%v", proposal, err)
	}
	if _, err := exportWorldProposal(inbox, id, worldID, ownerID, output); !errors.Is(err, os.ErrExist) {
		t.Fatalf("export overwrote existing file: err=%v", err)
	}
	for _, wrong := range []struct{ id, world, owner string }{
		{"../outside", worldID, ownerID},
		{id, "tw-world:other", ownerID},
		{id, worldID, peerIDForTest(t, member.GetPublic())},
	} {
		if _, err := removeWorldProposal(inbox, wrong.id, wrong.world, wrong.owner); err == nil {
			t.Fatal("cleanup accepted an invalid ID or wrong world owner")
		}
	}
	if _, err := os.Stat(filepath.Join(inbox, stringsTrimPrefixSHA256(id)+".json")); err != nil {
		t.Fatalf("failed cleanup changed the inbox: %v", err)
	}
	removed, err := removeWorldProposal(inbox, id, worldID, ownerID)
	if err != nil || removed.ID != id {
		t.Fatalf("verified cleanup failed: item=%+v err=%v", removed, err)
	}
	listed, err = listWorldProposals(inbox, worldID, ownerID)
	if err != nil || len(listed) != 0 {
		t.Fatalf("removed proposal remains queued: %+v %v", listed, err)
	}
	if _, err := os.Stat(output); err != nil {
		t.Fatalf("cleanup removed the exported review patch: %v", err)
	}
	if _, err := removeWorldProposal(inbox, id, worldID, ownerID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing proposal cleanup: %v", err)
	}

}

func TestOwnerProposalReviewRejectsTamperedInboxEntry(t *testing.T) {
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:proposal-tamper"
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	grant := worldRoleGrant{Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID, GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint, Scopes: []string{"world.content.edit"}, IssuedAt: time.Now().Add(-time.Minute).Unix(), ExpiresAt: time.Now().Add(time.Hour).Unix()}
	grantDocument, err := signDocument(worldRoleGrantProtocol, grant, owner)
	if err != nil {
		t.Fatal(err)
	}
	submission := makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))
	canonical, err := canonicalJSON(submission)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(canonical)
	id := "sha256:" + hex.EncodeToString(digest[:])
	inbox := filepath.Join(t.TempDir(), "proposals")
	if err := prepareProposalInbox(inbox); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(inbox, stringsTrimPrefixSHA256(id)+".json")
	if err := writeNewPrivateFile(filename, append(canonical, '\n')); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(`{"protocol":"tampered"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := listWorldProposals(inbox, worldID, ownerID); err == nil {
		t.Fatal("tampered inbox entry was listed")
	}
	if _, err := removeWorldProposal(inbox, id, worldID, ownerID); err == nil {
		t.Fatal("cleanup removed a tampered submission")
	}
	if _, err := os.Lstat(filename); err != nil {
		t.Fatalf("tampered submission was deleted: %v", err)
	}
	if err := os.Remove(filename); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := writeNewPrivateFile(outside, append(canonical, '\n')); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filename); err != nil {
		t.Fatal(err)
	}
	if _, err := removeWorldProposal(inbox, id, worldID, ownerID); err == nil {
		t.Fatal("cleanup followed an inbox symlink")
	}
	if _, err := os.Lstat(filename); err != nil {
		t.Fatalf("symlink was deleted: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("symlink target was deleted: %v", err)
	}

}

func TestWorldProposalSubmissionRejectsMissingStaleRevokedAndNonOwnerCases(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:proposal-denials"
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	grant := worldRoleGrant{
		Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID,
		GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint,
		Scopes: []string{"world.content.edit"}, IssuedAt: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}
	grantDocument, err := signDocument(worldRoleGrantProtocol, grant, owner)
	if err != nil {
		t.Fatal(err)
	}
	validState := signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-time.Minute), now.Add(10*time.Minute), nil, nil)
	tests := []struct {
		name       string
		localKey   crypto.PrivKey
		state      signedDocument
		serial     uint64
		submission worldProposalSubmission
	}{
		{name: "missing revocation state", localKey: owner, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))},
		{name: "stale revocation state", localKey: owner, state: signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-20*time.Minute), now.Add(-10*time.Minute), nil, nil), serial: 1, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))},
		{name: "revoked grant", localKey: owner, state: signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-time.Minute), now.Add(10*time.Minute), []string{grant.GrantID}, nil), serial: 1, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))},
		{name: "wrong world", localKey: owner, state: validState, serial: 1, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest("tw-world:other", "world.update"))},
		{name: "unsupported operation", localKey: owner, state: validState, serial: 1, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "run-script"))},
		{name: "not owner node", localKey: testKey(t), state: validState, serial: 1, submission: makeSignedProposalSubmission(t, member, grantDocument, proposalForTest(worldID, "world.update"))},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "proposals")
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			d := &daemon{world: worldManifest{WorldID: worldID, OwnerPeerID: ownerID}, key: test.localKey, proposalDir: dir, roleState: test.state, roleStateSerial: test.serial}
			body, err := json.Marshal(test.submission)
			if err != nil {
				t.Fatal(err)
			}
			response := httptest.NewRecorder()
			d.handleWorldProposalSubmission(response, httptest.NewRequest(http.MethodPost, "/api/world/proposals", bytes.NewReader(body)))
			if response.Code != http.StatusForbidden {
				t.Fatalf("invalid proposal accepted: code=%d body=%s", response.Code, response.Body.String())
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 0 {
				t.Fatalf("rejected proposal was stored: entries=%d err=%v", len(entries), err)
			}
		})
	}
}

func TestWorldProposalSubmissionRequiresScopesForEachOperation(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:proposal-scopes"
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	state := signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-time.Minute), now.Add(10*time.Minute), nil, nil)
	operations := map[string]json.RawMessage{
		"content": json.RawMessage(`{"op":"world.update","fields":{"title":"Updated"}}`),
		"portal":  json.RawMessage(`{"op":"portal.add","fields":{"id":"portal-1"}}`),
	}
	tests := []struct {
		name       string
		scopes     []string
		operations []json.RawMessage
		wantOK     bool
	}{
		{name: "content edit permits world edit", scopes: []string{"world.content.edit"}, operations: []json.RawMessage{operations["content"]}, wantOK: true},
		{name: "portal manager permits portal edit", scopes: []string{"world.portals.manage"}, operations: []json.RawMessage{operations["portal"]}, wantOK: true},
		{name: "content edit cannot edit portal", scopes: []string{"world.content.edit"}, operations: []json.RawMessage{operations["portal"]}},
		{name: "portal manager cannot edit world", scopes: []string{"world.portals.manage"}, operations: []json.RawMessage{operations["content"]}},
		{name: "mixed proposal needs both scopes", scopes: []string{"world.content.edit"}, operations: []json.RawMessage{operations["content"], operations["portal"]}},
		{name: "both scopes permit mixed proposal", scopes: []string{"world.content.edit", "world.portals.manage"}, operations: []json.RawMessage{operations["content"], operations["portal"]}, wantOK: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			grant := worldRoleGrant{
				Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID,
				GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint,
				Scopes: test.scopes, IssuedAt: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
			}
			grantDocument, err := signDocument(worldRoleGrantProtocol, grant, owner)
			if err != nil {
				t.Fatal(err)
			}
			proposal, err := json.Marshal(worldProposalHeader{
				Protocol: "elsemesh.world-proposal/1", WorldID: worldID,
				SourceHash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				Operations: test.operations,
			})
			if err != nil {
				t.Fatal(err)
			}
			submission := makeSignedProposalSubmission(t, member, grantDocument, proposal)
			d := &daemon{
				world:     worldManifest{WorldID: worldID, OwnerPeerID: ownerID},
				roleState: state, roleStateSerial: 1,
			}
			err = d.validateWorldProposalSubmission(submission, now)
			if (err == nil) != test.wantOK {
				t.Fatalf("validateWorldProposalSubmission() error = %v, wantOK %t", err, test.wantOK)
			}
		})
	}
}

func TestPortalOnlyGrantCanQueueAndExportPortalProposal(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	owner, member := testKey(t), testKey(t)
	ownerID := peerIDForTest(t, owner.GetPublic())
	worldID := "tw-world:portal-proposal"
	fingerprint, err := accountKeyFingerprint(member.GetPublic())
	if err != nil {
		t.Fatal(err)
	}
	grant, err := signDocument(worldRoleGrantProtocol, worldRoleGrant{
		Protocol: worldRoleGrantProtocol, WorldID: worldID, OwnerPeerID: ownerID,
		GrantID: "grant_0123456789ab", Version: 1, AccountKeyFingerprint: fingerprint,
		Scopes: []string{"world.portals.manage"}, IssuedAt: now.Add(-time.Minute).Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
	}, owner)
	if err != nil {
		t.Fatal(err)
	}
	proposal := json.RawMessage(`{"protocol":"elsemesh.world-proposal/1","worldId":"tw-world:portal-proposal","sourceHash":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","operations":[{"op":"portal.add","fields":{"id":"portal-1"}}]}`)
	submission := makeSignedProposalSubmission(t, member, grant, proposal)
	inbox := filepath.Join(t.TempDir(), "proposals")
	if err := os.Mkdir(inbox, 0700); err != nil {
		t.Fatal(err)
	}
	d := &daemon{
		world: worldManifest{WorldID: worldID, OwnerPeerID: ownerID}, key: owner,
		roleState:       signRoleRevocationsForProposalTest(t, owner, worldID, ownerID, 1, now.Add(-time.Minute), now.Add(10*time.Minute), nil, nil),
		roleStateSerial: 1, proposalDir: inbox,
	}
	body, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	d.handleWorldProposalSubmission(response, httptest.NewRequest(http.MethodPost, "/api/world/proposals", bytes.NewReader(body)))
	if response.Code != http.StatusCreated {
		t.Fatalf("portal-only grant rejected: code=%d body=%s", response.Code, response.Body.String())
	}
	var reply struct {
		ProposalID string `json:"proposalId"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	exported := filepath.Join(t.TempDir(), "portal-proposal.json")
	if _, err := exportWorldProposal(inbox, reply.ProposalID, worldID, ownerID, exported); err != nil {
		t.Fatalf("owner could not export portal-only proposal: %v", err)
	}
	var decoded worldProposalHeader
	if err := decodeStrictJSONFile(exported, &decoded); err != nil || len(decoded.Operations) != 1 {
		t.Fatalf("exported portal proposal is invalid: proposal=%+v err=%v", decoded, err)
	}
}

func proposalForTest(worldID, operation string) json.RawMessage {
	return json.RawMessage(`{"protocol":"elsemesh.world-proposal/1","worldId":"` + worldID + `","sourceHash":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","operations":[{"op":"` + operation + `","fields":{"title":"A proposed title"}}]}`)
}

func makeSignedProposalSubmission(t *testing.T, accountKey crypto.PrivKey, grant signedDocument, proposal json.RawMessage) worldProposalSubmission {
	t.Helper()
	publicKey, err := accountKey.GetPublic().Raw()
	if err != nil {
		t.Fatal(err)
	}
	unsigned := unsignedWorldProposalSubmission{
		Protocol: worldProposalSubmissionProtocol, AccountPublicKey: base64.RawURLEncoding.EncodeToString(publicKey),
		Grant: grant, Proposal: proposal,
	}
	message, err := canonicalJSON(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	message = append([]byte(worldProposalSubmissionDomain), message...)
	signature, err := accountKey.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	return worldProposalSubmission{Protocol: unsigned.Protocol, AccountPublicKey: unsigned.AccountPublicKey, Grant: grant, Proposal: proposal, Signature: base64.RawURLEncoding.EncodeToString(signature)}
}

func signRoleRevocationsForProposalTest(t *testing.T, owner crypto.PrivKey, worldID, ownerID string, serial uint64, issuedAt, expiresAt time.Time, grantIDs, fingerprints []string) signedDocument {
	t.Helper()
	state := worldRoleRevocations{
		Protocol: worldRoleRevocationsProtocol, WorldID: worldID, OwnerPeerID: ownerID,
		Serial: serial, IssuedAt: issuedAt.Unix(), ExpiresAt: expiresAt.Unix(),
		GrantIDs: grantIDs, AccountKeyFingerprints: fingerprints,
	}
	if state.GrantIDs == nil {
		state.GrantIDs = []string{}
	}
	if state.AccountKeyFingerprints == nil {
		state.AccountKeyFingerprints = []string{}
	}
	document, err := signDocument(worldRoleRevocationsProtocol, state, owner)
	if err != nil {
		t.Fatal(err)
	}
	return document
}
