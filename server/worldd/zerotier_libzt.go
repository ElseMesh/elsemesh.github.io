//go:build zerotier && cgo

package main

/*
#include <stdlib.h>
#include <arpa/inet.h>
#include <ZeroTierSockets.h>
static int zt_ipv4_prefix(uint64_t net_id) {
	struct zts_sockaddr_storage assigned;
	if (zts_addr_get(net_id, ZTS_AF_INET, &assigned) != ZTS_ERR_OK) return -1;
	return (int)ntohs(((struct zts_sockaddr_in*)&assigned)->sin_port);
}
static ssize_t zt_read_with_errno(int fd, void *buf, size_t len, int *err) {
	ssize_t n = zts_read(fd, buf, len);
	*err = (n < 0) ? zts_errno : 0;
	return n;
}
static ssize_t zt_write_with_errno(int fd, const void *buf, size_t len, int *err) {
	ssize_t n = zts_write(fd, buf, len);
	*err = (n < 0) ? zts_errno : 0;
	return n;
}
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
	"unsafe"

	libp2p "github.com/libp2p/go-libp2p"
	quic "github.com/libp2p/go-libp2p/p2p/transport/quic"
	"github.com/libp2p/go-libp2p/p2p/transport/tcp"
	libp2pwebrtc "github.com/libp2p/go-libp2p/p2p/transport/webrtc"
	websocket "github.com/libp2p/go-libp2p/p2p/transport/websocket"
	webtransport "github.com/libp2p/go-libp2p/p2p/transport/webtransport"
	ma "github.com/multiformats/go-multiaddr"
)

const defaultZeroTierNetworkID = "e3918db4832a3056"
const daemonName = "thruholdd"

type libztRuntime struct {
	networkID    uint64
	nodeID       uint64
	address      net.IP
	prefix       net.IPNet
	ipv4         net.IP
	ipv4Prefix   net.IPNet
	port         int
	closeOnce    sync.Once
	listener     int
	ipv4Listener int
	listenerOnce sync.Once
}

func startZeroTier(networkID, storagePath string) (zeroTierRuntime, error) {
	if len(networkID) != 16 {
		return nil, errors.New("network ID must contain exactly 16 hexadecimal digits")
	}
	netID, err := strconv.ParseUint(networkID, 16, 64)
	if err != nil || netID == 0 {
		return nil, errors.New("network ID must be a nonzero 16-digit hexadecimal value")
	}
	if err := prepareZeroTierIdentityStorage(storagePath); err != nil {
		return nil, err
	}
	path := C.CString(storagePath)
	defer C.free(unsafe.Pointer(path))
	if code := int(C.zts_init_from_storage(path)); code != 0 {
		return nil, fmt.Errorf("libzt state initialization failed (%d)", code)
	}
	if code := int(C.zts_node_start()); code != 0 {
		return nil, fmt.Errorf("libzt node start failed (%d)", code)
	}
	started := true
	defer func() {
		if started {
			C.zts_node_stop()
		}
	}()
	deadline := time.Now().Add(60 * time.Second)
	for int(C.zts_node_is_online()) != 1 && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
	if int(C.zts_node_is_online()) != 1 {
		return nil, errors.New("timed out waiting for ZeroTier node to come online")
	}
	nodeID := uint64(C.zts_node_get_id())
	if nodeID == 0 || nodeID > (1<<40)-1 {
		return nil, errors.New("libzt returned an invalid node ID")
	}
	if err := verifyZeroTierNodeID(storagePath, nodeID); err != nil {
		return nil, err
	}
	if code := int(C.zts_net_join(C.uint64_t(netID))); code != 0 {
		return nil, fmt.Errorf("libzt could not join network (%d)", code)
	}
	deadline = time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		switch int(C.zts_net_get_status(C.uint64_t(netID))) {
		case 1:
			if int(C.zts_addr_is_assigned(C.uint64_t(netID), C.ZTS_AF_INET6)) != 1 {
				time.Sleep(250 * time.Millisecond)
				continue
			}
			var raw [C.ZTS_IP_MAX_STR_LEN]C.char
			if code := int(C.zts_addr_get_str(C.uint64_t(netID), C.ZTS_AF_INET6, &raw[0], C.uint(C.ZTS_IP_MAX_STR_LEN))); code != 0 {
				return nil, fmt.Errorf("read assigned ZeroTier IPv6 address failed (%d)", code)
			}
			address := net.ParseIP(C.GoString(&raw[0])).To16()
			if address == nil {
				return nil, errors.New("libzt returned an invalid assigned ZeroTier IPv6 address")
			}
			if code := int(C.zts_addr_compute_6plane_str(C.uint64_t(netID), C.uint64_t(nodeID), &raw[0], C.uint(C.ZTS_IP_MAX_STR_LEN))); code != 0 {
				return nil, fmt.Errorf("compute expected 6PLANE address failed (%d)", code)
			}
			expected := net.ParseIP(C.GoString(&raw[0])).To16()
			if expected == nil || !address.Equal(expected) {
				return nil, errors.New("assigned ZeroTier IPv6 address does not match this network's 6PLANE address")
			}
			mask := net.CIDRMask(40, 128)
			runtime := &libztRuntime{networkID: netID, nodeID: nodeID, address: address, prefix: net.IPNet{IP: address.Mask(mask), Mask: mask}, listener: -1, ipv4Listener: -1}
			switch assigned := int(C.zts_addr_is_assigned(C.uint64_t(netID), C.ZTS_AF_INET)); assigned {
			case 0:
				log.Printf("ZeroTier managed IPv4 address: not assigned")
			case 1:
				if code := int(C.zts_addr_get_str(C.uint64_t(netID), C.ZTS_AF_INET, &raw[0], C.uint(C.ZTS_IP_MAX_STR_LEN))); code != 0 {
					return nil, fmt.Errorf("read assigned ZeroTier IPv4 address failed (%d)", code)
				}
				ipv4 := net.ParseIP(C.GoString(&raw[0])).To4()
				prefixBits := int(C.zt_ipv4_prefix(C.uint64_t(netID)))
				if ipv4 == nil || prefixBits < 1 || prefixBits > 32 {
					return nil, errors.New("libzt returned an invalid managed ZeroTier IPv4 address or prefix")
				}
				ipv4Mask := net.CIDRMask(prefixBits, 32)
				runtime.ipv4 = ipv4
				runtime.ipv4Prefix = net.IPNet{IP: ipv4.Mask(ipv4Mask), Mask: ipv4Mask}
				log.Printf("ZeroTier managed IPv4 address: %s/%d", ipv4, prefixBits)
			default:
				return nil, fmt.Errorf("could not determine ZeroTier IPv4 assignment (%d)", assigned)
			}
			started = false
			return runtime, nil
		case 2:
			return nil, errors.New("ZeroTier Central denied this node membership")
		case 3:
			return nil, errors.New("ZeroTier network was not found")
		case 4:
			return nil, errors.New("libzt network initialization failed")
		case 5:
			return nil, errors.New("ZeroTier network requires a newer libzt version")
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil, errors.New("timed out waiting for ZeroTier network configuration (check membership and 6PLANE settings)")
}

func (z *libztRuntime) Addresses() []net.IP {
	addresses := []net.IP{append(net.IP(nil), z.address...)}
	if z.ipv4 != nil {
		addresses = append(addresses, append(net.IP(nil), z.ipv4...))
	}
	return addresses
}
func (z *libztRuntime) NodeID() string { return fmt.Sprintf("%010x", z.nodeID) }

func (z *libztRuntime) Libp2pOptions() []libp2p.Option {
	dialer := tcp.WithDialerForAddr(func(address ma.Multiaddr) (tcp.ContextDialer, error) {
		if ipText, err := address.ValueForProtocol(ma.P_IP4); err == nil {
			ip := net.ParseIP(ipText).To4()
			if ip != nil && z.ipv4 != nil && z.ipv4Prefix.Contains(ip) {
				return ztDialer{}, nil
			}
		}
		if ipText, err := address.ValueForProtocol(ma.P_IP6); err == nil {
			ip := net.ParseIP(ipText)
			if ip != nil && z.prefix.Contains(ip) {
				return ztDialer{}, nil
			}
		}
		return &net.Dialer{}, nil
	})
	return []libp2p.Option{
		libp2p.Transport(tcp.NewTCPTransport, dialer),
		libp2p.Transport(quic.NewTransport),
		libp2p.Transport(websocket.New),
		libp2p.Transport(webtransport.New),
		libp2p.Transport(libp2pwebrtc.New),
	}
}

func (z *libztRuntime) StartBridge(ctx context.Context, port int) error {
	z.port = port
	if err := z.startBridgeListener(ctx, z.address.String(), C.ZTS_AF_INET6); err != nil {
		return err
	}
	if z.ipv4 != nil {
		if err := z.startBridgeListener(ctx, z.ipv4.String(), C.ZTS_AF_INET); err != nil {
			z.closeListener()
			return err
		}
	}
	return nil
}

func (z *libztRuntime) startBridgeListener(ctx context.Context, addressText string, family C.int) error {
	address := C.CString(addressText)
	defer C.free(unsafe.Pointer(address))
	fd := int(C.zts_socket(family, C.ZTS_SOCK_STREAM, C.ZTS_IPPROTO_TCP))
	if fd < 0 {
		return fmt.Errorf("libzt TCP socket creation failed (%d)", fd)
	}
	if code := int(C.zts_bind(C.int(fd), address, C.ushort(z.port))); code != 0 {
		C.zts_close(C.int(fd))
		return fmt.Errorf("libzt TCP bind failed (%d)", code)
	}
	if code := int(C.zts_listen(C.int(fd), 64)); code != 0 {
		C.zts_close(C.int(fd))
		return fmt.Errorf("libzt TCP listen failed (%d)", code)
	}
	// libzt's blocking accept does not wake reliably when zts_close is called
	// from another goroutine. A receive timeout bounds cancellation latency and
	// lets the accept loop observe ctx before the listener is closed.
	if code := int(C.zts_set_recv_timeout(C.int(fd), 0, 250000)); code != 0 {
		C.zts_close(C.int(fd))
		return fmt.Errorf("libzt TCP accept timeout setup failed (%d)", code)
	}
	if family == C.ZTS_AF_INET {
		z.ipv4Listener = fd
	} else {
		z.listener = fd
	}
	go func() {
		<-ctx.Done()
		z.closeListener()
	}()
	go func() {
		for ctx.Err() == nil {
			var remote [C.ZTS_IP_MAX_STR_LEN]C.char
			var remotePort C.ushort
			accepted := int(C.zts_accept(C.int(fd), &remote[0], C.int(C.ZTS_IP_MAX_STR_LEN), &remotePort))
			if accepted < 0 {
				if ctx.Err() != nil {
					return
				}
				time.Sleep(50 * time.Millisecond)
				continue
			}
			go z.proxy(accepted)
		}
	}()
	return nil
}

func (z *libztRuntime) proxy(fd int) {
	ztConn := &ztConn{fd: fd}
	defer ztConn.Close()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(z.port)), 5*time.Second)
	if err != nil {
		return
	}
	defer conn.Close()
	done := make(chan struct{}, 1)
	go func() {
		_, _ = io.Copy(conn, ztConn)
		done <- struct{}{}
	}()
	_, _ = io.Copy(ztConn, conn)
	_ = ztConn.Close()
	<-done
}

func (z *libztRuntime) Close() error {
	z.closeOnce.Do(func() { C.zts_node_stop() })
	z.closeListener()
	return nil
}

func (z *libztRuntime) closeListener() {
	z.listenerOnce.Do(func() {
		if z.listener >= 0 {
			C.zts_close(C.int(z.listener))
		}
		if z.ipv4Listener >= 0 {
			C.zts_close(C.int(z.ipv4Listener))
		}
	})
}

type ztDialer struct{}

func (ztDialer) DialContext(ctx context.Context, _, address string) (net.Conn, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return nil, errors.New("invalid ZeroTier TCP port")
	}
	family := C.int(C.ZTS_AF_INET6)
	if ip := net.ParseIP(host); ip != nil && ip.To4() != nil {
		family = C.int(C.ZTS_AF_INET)
	}
	fd := int(C.zts_socket(family, C.ZTS_SOCK_STREAM, C.ZTS_IPPROTO_TCP))
	if fd < 0 {
		return nil, fmt.Errorf("libzt TCP socket creation failed (%d)", fd)
	}
	cHost := C.CString(host)
	defer C.free(unsafe.Pointer(cHost))
	timeout := 15000
	if deadline, ok := ctx.Deadline(); ok {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			C.zts_close(C.int(fd))
			return nil, context.DeadlineExceeded
		}
		if remaining.Milliseconds() < int64(timeout) {
			timeout = int(remaining.Milliseconds())
		}
	}
	if code := int(C.zts_connect(C.int(fd), cHost, C.ushort(port), C.int(timeout))); code != 0 {
		C.zts_close(C.int(fd))
		if ctx.Err() != nil {
			return nil, fmt.Errorf("libzt TCP connect to %s failed (%d): %w", address, code, ctx.Err())
		}
		return nil, fmt.Errorf("libzt TCP connect to %s failed (%d)", address, code)
	}
	localAddr, err := ztSocketAddr(fd, false)
	if err != nil {
		C.zts_close(C.int(fd))
		return nil, fmt.Errorf("read libzt local socket address: %w", err)
	}
	remoteAddr, err := ztSocketAddr(fd, true)
	if err != nil {
		C.zts_close(C.int(fd))
		return nil, fmt.Errorf("read libzt remote socket address: %w", err)
	}
	return &ztConn{fd: fd, localAddr: localAddr, remoteAddr: remoteAddr}, nil
}

type ztConn struct {
	fd         int
	localAddr  net.Addr
	remoteAddr net.Addr
	closeOnce  sync.Once
}

func (c *ztConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	var socketErr C.int
	n := int(C.zt_read_with_errno(C.int(c.fd), unsafe.Pointer(&p[0]), C.size_t(len(p)), &socketErr))
	if n == 0 {
		return 0, io.EOF
	}
	if n < 0 {
		if socketErr == C.ZTS_EAGAIN {
			return 0, os.ErrDeadlineExceeded
		}
		return 0, fmt.Errorf("libzt read failed (%d)", int(socketErr))
	}
	return n, nil
}

func (c *ztConn) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	var socketErr C.int
	n := int(C.zt_write_with_errno(C.int(c.fd), unsafe.Pointer(&p[0]), C.size_t(len(p)), &socketErr))
	if n < 0 {
		if socketErr == C.ZTS_EAGAIN {
			return 0, os.ErrDeadlineExceeded
		}
		return 0, fmt.Errorf("libzt write failed (%d)", int(socketErr))
	}
	return n, nil
}

func (c *ztConn) Close() error {
	c.closeOnce.Do(func() { C.zts_close(C.int(c.fd)) })
	return nil
}

func (c *ztConn) LocalAddr() net.Addr {
	if c.localAddr != nil {
		return c.localAddr
	}
	addr, _ := ztSocketAddr(c.fd, false)
	if addr == nil {
		return &net.TCPAddr{}
	}
	return addr
}
func (c *ztConn) RemoteAddr() net.Addr {
	if c.remoteAddr != nil {
		return c.remoteAddr
	}
	addr, _ := ztSocketAddr(c.fd, true)
	if addr == nil {
		return &net.TCPAddr{}
	}
	return addr
}
func (c *ztConn) SetDeadline(deadline time.Time) error {
	if err := c.SetReadDeadline(deadline); err != nil {
		return err
	}
	return c.SetWriteDeadline(deadline)
}
func (c *ztConn) SetReadDeadline(deadline time.Time) error {
	seconds, micros := socketTimeout(deadline)
	if code := int(C.zts_set_recv_timeout(C.int(c.fd), seconds, micros)); code != 0 {
		return fmt.Errorf("set libzt receive deadline failed (%d)", code)
	}
	return nil
}
func (c *ztConn) SetWriteDeadline(deadline time.Time) error {
	seconds, micros := socketTimeout(deadline)
	if code := int(C.zts_set_send_timeout(C.int(c.fd), seconds, micros)); code != 0 {
		return fmt.Errorf("set libzt send deadline failed (%d)", code)
	}
	return nil
}

func socketTimeout(deadline time.Time) (C.int, C.int) {
	if deadline.IsZero() {
		return 0, 0
	}
	d := time.Until(deadline)
	if d <= 0 {
		d = time.Microsecond
	}
	return C.int(d / time.Second), C.int((d % time.Second) / time.Microsecond)
}

func ztSocketAddr(fd int, remote bool) (*net.TCPAddr, error) {
	var raw [C.ZTS_INET6_ADDRSTRLEN]C.char
	var port C.ushort
	var code C.int
	if remote {
		code = C.zts_getpeername(C.int(fd), &raw[0], C.int(C.ZTS_INET6_ADDRSTRLEN), &port)
	} else {
		code = C.zts_getsockname(C.int(fd), &raw[0], C.int(C.ZTS_INET6_ADDRSTRLEN), &port)
	}
	if code != 0 {
		return nil, fmt.Errorf("libzt socket address query failed (%d)", int(code))
	}
	ip := net.ParseIP(C.GoString(&raw[0]))
	if ip == nil {
		return nil, errors.New("libzt returned an invalid socket address")
	}
	return &net.TCPAddr{IP: ip, Port: int(port)}, nil
}

func osMkdirAllPrivate(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	return os.Chmod(path, 0700)
}

var _ net.Conn = (*ztConn)(nil)
var _ tcp.ContextDialer = ztDialer{}
