package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	osuser "os/user"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const maxOutputBytes = 128 * 1024

const (
	reconnectBaseDelay = 1 * time.Second
	reconnectMaxDelay  = 30 * time.Second
	pongWait           = 60 * time.Second
)

var sessionCodePattern = regexp.MustCompile(`^[0-9a-f]{12}$`)

// ANSI hints for readable local CLI feedback.
const (
	ansiReset = "\x1b[0m"
	ansiBold  = "\x1b[1m"
	ansiDim   = "\x1b[2m"
	ansiCyan  = "\x1b[36m"
	ansiRed   = "\x1b[31m"
)

func printLine(parts ...string) {
	_, _ = os.Stdout.WriteString(strings.Join(parts, "") + "\n")
}

// Global reference for signal handler to gracefully close the connection
var (
	currentBridge   *wsConn
	currentBridgeMu sync.Mutex
)

func setCurrentBridge(w *wsConn) {
	currentBridgeMu.Lock()
	currentBridge = w
	currentBridgeMu.Unlock()
}

func clearCurrentBridge() {
	currentBridgeMu.Lock()
	currentBridge = nil
	currentBridgeMu.Unlock()
}

func closeCurrentBridge() {
	currentBridgeMu.Lock()
	if currentBridge != nil {
		currentBridge.close()
	}
	currentBridgeMu.Unlock()
}

func main() {
	wsURL := os.Getenv("BRIDGE_WS_URL")
	if wsURL == "" {
		fatal(`Missing env var: BRIDGE_WS_URL`)
	}
	code := os.Args[1]
	if !sessionCodePattern.MatchString(code) {
		code = os.Getenv("BRIDGE_CODE")
	}
	if !sessionCodePattern.MatchString(code) {
		fatal("Usage: cya-bridge <session code>")
	}

	// Derive HTTP base URL from WebSocket URL for the connect link
	baseURL := strings.Replace(wsURL, "ws://", "http://", 1)
	baseURL = strings.Replace(baseURL, "wss://", "https://", 1)
	baseURL = strings.TrimSuffix(baseURL, "/ws")
	connectURL := baseURL + "/c/" + code

	quit := make(chan struct{})
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		// Gracefully close the bridge WebSocket connection so the server
		// gets a clean close frame. This also unblocks ReadMessage().
		closeCurrentBridge()
		close(quit)
	}()

	delay := reconnectBaseDelay

	for {
		select {
		case <-quit:
			printLine("")
			return
		default:
		}

		_, reconnect := dialAndRun(wsURL, code, connectURL, quit)
		if !reconnect {
			return
		}

		printLine(ansiDim, "⚠ Connection lost, reconnecting in ", fmt.Sprintf("%.0fs", delay.Seconds()), "...", ansiReset)

		select {
		case <-quit:
			return
		case <-time.After(delay):
		}

		delay *= 2
		if delay > reconnectMaxDelay {
			delay = reconnectMaxDelay
		}
	}
}

func fatal(msg string) {
	dot := ansiCyan + "●" + ansiReset
	printLine(dot, " ", ansiRed, "Error:", ansiReset, " ", msg)
	os.Exit(1)
}

func cwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return wd
}

func shellName() string {
	if runtime.GOOS == "windows" {
		return "powershell.exe"
	}
	return "/bin/sh"
}

func oneShotArgs(cmd string) (name string, args []string) {
	if runtime.GOOS == "windows" {
		return "cmd.exe", []string{"/d", "/s", "/c", cmd}
	}
	return "/bin/sh", []string{"-c", cmd}
}

func joinOS() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func joinArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH
}

func safeUser() string {
	u, err := osuser.Current()
	if err != nil {
		if v := os.Getenv("USER"); v != "" {
			return v
		}
		if v := os.Getenv("USERNAME"); v != "" {
			return v
		}
		return "unknown"
	}
	return u.Username
}

func isElevated() bool {
	if runtime.GOOS == "windows" {
		u, err := osuser.Current()
		currentUser := ""
		if err == nil {
			currentUser = u.Username
		}
		return isWindowsAdministrator(currentUser, os.Getenv("USERNAME"))
	}
	if os.Getenv("SUDO_UID") != "" {
		return true
	}
	return syscall.Geteuid() == 0
}

func isWindowsAdministrator(currentUser, envUser string) bool {
	return windowsUsernameLeaf(currentUser) == "administrator" ||
		windowsUsernameLeaf(envUser) == "administrator"
}

func windowsUsernameLeaf(value string) string {
	value = strings.TrimSpace(value)
	if idx := strings.LastIndexAny(value, `\/`); idx >= 0 {
		value = value[idx+1:]
	}
	return strings.ToLower(value)
}

func hostnameSafe() string {
	h, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return h
}

type wsConn struct {
	mu     sync.Mutex
	conn   *websocket.Conn
	closed bool
}

func (w *wsConn) sendJSON(v any) bool {
	payload, err := json.Marshal(v)
	if err != nil {
		return false
	}

	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return false
	}
	return w.conn.WriteMessage(websocket.TextMessage, payload) == nil
}

func (w *wsConn) close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	_ = w.conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
	_ = w.conn.Close()
}

func (w *wsConn) closeUnderlying() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return
	}
	w.closed = true
	_ = w.conn.Close()
}

func readCommands(wsc *wsConn, dot string) bool {
	defer func() {
		printLine("\n", dot, " Connection closed.", ansiReset)
		wsc.close()
	}()

	for {
		_, data, err := wsc.conn.ReadMessage()
		if err != nil {
			// Normal WebSocket close = intentional (bye, signal, or server close)
			if _, ok := err.(*websocket.CloseError); ok {
				return false
			}
			// Network error or unexpected drop → should reconnect
			return true
		}
		var head struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &head); err != nil {
			continue
		}
		switch head.Type {
		case "error":
			var msg struct {
				Message string `json:"message"`
			}
			_ = json.Unmarshal(data, &msg)
			printLine(dot, " ", ansiRed, "Server error:", ansiReset, " ", msg.Message)
		case "command":
			var msg struct {
				Cmd string `json:"cmd"`
				ID  string `json:"id"`
			}
			_ = json.Unmarshal(data, &msg)
			if msg.ID == "" {
				continue
			}
			printLine(ansiCyan+"▶"+ansiReset, " ", ansiBold, msg.Cmd, ansiReset)
			out, code, truncated := runOneShot(msg.Cmd)
			if out != "" {
				for _, line := range strings.Split(out, "\n") {
					_, _ = os.Stdout.WriteString(ansiDim + "  " + line + ansiReset + "\n")
				}
			}
			wsc.sendJSON(map[string]any{
				"type":      "command_result",
				"id":        msg.ID,
				"output":    out,
				"exit_code": code,
				"truncated": truncated,
			})
		case "bye":
			wsc.close()
			return false
		}
	}
}

// dialWS connects to a WebSocket URL, falling back to 8.8.8.8 for DNS
// if the system resolver fails (common on Android/Termux where /etc/resolv.conf
// points to a non-existent localhost DNS server).
func dialWS(wsURL string) (*websocket.Conn, *http.Response, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, nil, err
	}

	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, http.Header{})
	if err == nil {
		return conn, resp, nil
	}

	// Check if it's a DNS error by trying to resolve with a fallback DNS
	hostname := u.Hostname()
	port := u.Port()
	if port == "" {
		if u.Scheme == "wss" {
			port = "443"
		} else {
			port = "80"
		}
	}

	// Try to resolve using the system DNS first (may have failed)
	ips, lookupErr := net.DefaultResolver.LookupHost(context.Background(), hostname)
	if lookupErr != nil {
		// System DNS failed — try Google DNS (8.8.8.8) directly
		altResolver := &net.Resolver{
			PreferGo: true,
			Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
				d := net.Dialer{Timeout: 5 * time.Second}
				return d.DialContext(ctx, "udp", "8.8.8.8:53")
			},
		}
		ips, lookupErr = altResolver.LookupHost(context.Background(), hostname)
		if lookupErr != nil || len(ips) == 0 {
			return conn, resp, fmt.Errorf("%w (DNS: also tried 8.8.8.8: %v)", err, lookupErr)
		}
	}

	// Try each resolved IP with the WebSocket dialer
	for _, ip := range ips {
		directURL := wsURL
		if strings.HasPrefix(wsURL, "ws://") {
			directURL = fmt.Sprintf("ws://%s:%s", ip, port)
		} else if strings.HasPrefix(wsURL, "wss://") {
			directURL = fmt.Sprintf("wss://%s:%s", ip, port)
		}

		headers := http.Header{}
		headers.Set("Host", hostname)
		conn, resp, err = dialer.Dial(directURL, headers)
		if err == nil {
			return conn, resp, nil
		}
	}

	return conn, resp, err
}

func dialAndRun(wsURL, code, connectURL string, quit <-chan struct{}) (string, bool) {
	conn, resp, err := dialWS(wsURL)
	if err != nil {
		if resp != nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
		}
		select {
		case <-quit:
			return "", false
		default:
		}
		printLine(ansiDim, "⚠ Dial failed: ", err.Error(), ansiReset)
		return "", true
	}

	bridge := &wsConn{conn: conn}
	setCurrentBridge(bridge)

	dot := ansiCyan + "●" + ansiReset
	printLine(dot, " ", connectURL, ansiReset)
	printLine(dot, " ", ansiBold, code, ansiReset, "  —  Ctrl+C to disconnect")

	// Set up heartbeat: reset read deadline on server ping, respond with pong
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPingHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(10*time.Second))
	})

	if !bridge.sendJSON(map[string]any{
		"type":    "join",
		"session": code,
		"role":    "agent",
		"meta": map[string]any{
			"host":     hostnameSafe(),
			"os":       joinOS(),
			"arch":     joinArch(),
			"user":     safeUser(),
			"cwd":      cwd(),
			"shell":    shellName(),
			"elevated": isElevated(),
		},
	}) {
		select {
		case <-quit:
			clearCurrentBridge()
			return "", false
		default:
		}
		printLine(dot, " ", ansiRed, "Join failed, reconnecting...", ansiReset)
		bridge.close()
		clearCurrentBridge()
		return "", true
	}

	reconnect := readCommands(bridge, dot)
	clearCurrentBridge()
	return dot, reconnect
}

func runOneShot(cmdLine string) (output string, status int, truncated bool) {
	name, args := oneShotArgs(cmdLine)
	c := exec.Command(name, args...)
	c.Dir = cwd()
	c.Env = os.Environ()
	var stdout, stderr bytes.Buffer
	c.Stdout = &stdout
	c.Stderr = &stderr
	err := c.Run()
	output, truncated = trimOutput(stdout.String() + stderr.String())
	return output, childExitCode(err), truncated
}

func trimOutput(output string) (string, bool) {
	if len(output) <= maxOutputBytes {
		return output, false
	}
	return output[:maxOutputBytes] + "\n[output truncated at 131072 bytes]\n", true
}

func childExitCode(err error) int {
	if err == nil {
		return 0
	}
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 1
}
