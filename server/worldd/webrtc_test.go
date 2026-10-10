package main

import "testing"

func TestWebRTCConfigurationValidation(t *testing.T) {
	if err := validateSTUNServerURLs([]string{"stun:stun.example.org:3478", "stuns:stun.example.org:5349"}); err != nil {
		t.Fatalf("valid STUN servers rejected: %v", err)
	}
	for _, invalid := range [][]string{{"turn:turn.example.org:3478"}, {"stun:"}, {"stun://"}, {"stun:host:3478\n--evil"}} {
		if err := validateSTUNServerURLs(invalid); err == nil {
			t.Errorf("invalid STUN configuration accepted: %q", invalid)
		}
	}
	if err := validateWebRTCPortRange(42950, 43049); err != nil {
		t.Fatalf("default WebRTC UDP range rejected: %v", err)
	}
	for _, ports := range [][2]uint{{0, 100}, {43000, 42950}, {1, 31}, {65536, 65560}} {
		if err := validateWebRTCPortRange(ports[0], ports[1]); err == nil {
			t.Errorf("invalid WebRTC UDP range accepted: %v", ports)
		}
	}
}
