package main

import (
	"context"
	"fmt"
	"net"

	libp2p "github.com/libp2p/go-libp2p"
	ma "github.com/multiformats/go-multiaddr"
)

type zeroTierRuntime interface {
	Addresses() []net.IP
	NodeID() string
	Libp2pOptions() []libp2p.Option
	StartBridge(context.Context, int) error
	StopAccepting() error
	CloseListeners() error
	Stop() error
}

func zeroTierMultiaddrs(addresses []net.IP, port int) ([]ma.Multiaddr, error) {
	result := make([]ma.Multiaddr, 0, len(addresses))
	for _, address := range addresses {
		var text string
		if ipv4 := address.To4(); ipv4 != nil {
			text = fmt.Sprintf("/ip4/%s/tcp/%d", ipv4, port)
		} else if ipv6 := address.To16(); ipv6 != nil {
			text = fmt.Sprintf("/ip6/%s/tcp/%d", ipv6, port)
		} else {
			return nil, fmt.Errorf("invalid ZeroTier address %q", address)
		}
		multiaddr, err := ma.NewMultiaddr(text)
		if err != nil {
			return nil, err
		}
		result = append(result, multiaddr)
	}
	return result, nil
}
