package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
)

var errZeroTierPeerNotFound = errors.New("ZeroTier peer not found")

type zeroTierPathQuerier interface {
	PhysicalPeerPaths(uint64) ([]string, error)
}

func parseZeroTierPeerID(value string) (uint64, error) {
	if len(value) != 10 {
		return 0, fmt.Errorf("peerId must be exactly 10 hexadecimal digits")
	}
	peerID, err := strconv.ParseUint(value, 16, 40)
	if err != nil || peerID == 0 {
		return 0, fmt.Errorf("peerId must be a nonzero 40-bit hexadecimal value")
	}
	return peerID, nil
}

func isLoopbackListenAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func zeroTierPathHandler(query zeroTierPathQuerier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		remoteHost, _, err := net.SplitHostPort(r.RemoteAddr)
		remoteIP := net.ParseIP(remoteHost)
		if err != nil || remoteIP == nil || !remoteIP.IsLoopback() ||
			r.Header.Get("Forwarded") != "" || r.Header.Get("X-Forwarded-For") != "" ||
			r.Header.Get("X-Forwarded-Host") != "" || r.Header.Get("X-Forwarded-Proto") != "" ||
			!isLoopbackRequestHost(r.Host) {
			http.Error(w, "loopback access required", http.StatusForbidden)
			return
		}
		peerID, err := parseZeroTierPeerID(r.URL.Query().Get("peerId"))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		paths, err := query.PhysicalPeerPaths(peerID)
		if err != nil {
			if errors.Is(err, errZeroTierPeerNotFound) {
				http.Error(w, "ZeroTier peer not found", http.StatusNotFound)
				return
			}
			http.Error(w, "ZeroTier path query failed", http.StatusBadGateway)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(struct {
			PeerID string   `json:"peerId"`
			Paths  []string `json:"paths"`
		}{PeerID: strings.ToLower(r.URL.Query().Get("peerId")), Paths: paths})
	}
}

func isLoopbackRequestHost(hostport string) bool {
	host, port, err := net.SplitHostPort(hostport)
	if err != nil {
		host = hostport
	} else if port == "" {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
