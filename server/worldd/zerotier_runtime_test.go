package main

import (
	"net"
	"testing"
)

func TestZeroTierMultiaddrsAnnounceManagedIPv4And6Plane(t *testing.T) {
	addresses, err := zeroTierMultiaddrs([]net.IP{
		net.ParseIP("172.30.12.34"),
		net.ParseIP("fd12:3456:789a::1"),
	}, 42901)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"/ip4/172.30.12.34/tcp/42901",
		"/ip6/fd12:3456:789a::1/tcp/42901",
	}
	if len(addresses) != len(want) {
		t.Fatalf("got %d announced addresses, want %d", len(addresses), len(want))
	}
	for i := range want {
		if got := addresses[i].String(); got != want[i] {
			t.Errorf("address %d = %q, want %q", i, got, want[i])
		}
	}
}

func TestZeroTierMultiaddrsRejectInvalidAddress(t *testing.T) {
	if _, err := zeroTierMultiaddrs([]net.IP{{1, 2, 3}}, 42901); err == nil {
		t.Fatal("invalid ZeroTier address was accepted")
	}
}
