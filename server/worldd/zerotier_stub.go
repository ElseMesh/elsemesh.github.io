//go:build !zerotier || !cgo

package main

import "errors"

const defaultZeroTierNetworkID = ""
const daemonName = "worldd"

func startZeroTier(string, string, []string) (zeroTierRuntime, error) {
	return nil, errors.New("ZeroTier support is not included; rebuild worldd with -tags zerotier and libzt cgo flags")
}
