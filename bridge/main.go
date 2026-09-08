package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
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
	maxFileSize        = 50 * 1024 * 1024
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

func printUsage() {
	fmt.Println("Connect Your Agent (CYA) - secure, ephemeral remote agent bridge")
	fmt.Println("")
	fmt.Println("Usage:")
	fmt.Println("  cya <session-code> [key]              Run bridge daemon to connect this machine")
	fmt.Println("  cya run [--url <url>] [--session <id>] --key <key> <command>")
	fmt.Println("                                        Execute an encrypted command against an active session")
	fmt.Println("  cya --help                            Show this help message")
	fmt.Println("")
	fmt.Println("Environment variables:")
	fmt.Println("  BRIDGE_WS_URL     WebSocket URL of CYA server (for bridge mode)")
	fmt.Println("  BRIDGE_CODE       Session code (fallback if not given in args)")
	fmt.Println("  KEY / BRIDGE_KEY  Encryption key for E2E encryption")
	fmt.Println("  CYA_URL           CYA server base URL (for run mode, default: http://localhost:8765)")
}

func main() {
	if len(os.Args) > 1 {
		arg1 := os.Args[1]
		if arg1 == "--help" || arg1 == "-h" || arg1 == "help" {
			printUsage()
			return
		}
		if arg1 == "run" {
			handleRunCommand(os.Args[2:])
			return
		}
	}

	wsURL := os.Getenv("BRIDGE_WS_URL")
	if wsURL == "" {
		fatal(`Missing env var: BRIDGE_WS_URL. Run "cya --help" for usage information.`)
	}

	var code string
	var keyBytes []byte

	rawKey := os.Getenv("BRIDGE_KEY")
	if rawKey == "" {
		rawKey = os.Getenv("KEY")
	}

	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--key" && i+1 < len(args) {
			rawKey = args[i+1]
			i++
		} else if arg == "--code" && i+1 < len(args) {
			code = args[i+1]
			i++
		} else if sessionCodePattern.MatchString(arg) && code == "" {
			code = arg
		} else if rawKey == "" {
			rawKey = arg
		}
	}

	if code == "" {
		code = os.Getenv("BRIDGE_CODE")
	}

	if rawKey != "" {
		parsed, err := ParseKeyOrPhrase(rawKey)
		if err == nil {
			keyBytes = parsed
			if code == "" {
				code = DeriveSessionCode(keyBytes)
			}
		} else if code == "" && sessionCodePattern.MatchString(rawKey) {
			code = rawKey
		}
	}

	if !sessionCodePattern.MatchString(code) {
		fatal("Usage: cya-bridge <session code> [key/phrase] or KEY=<key/phrase> cya-bridge")
	}

	var sessionKeys *SessionKeys
	if len(keyBytes) > 0 {
		k := DeriveSubkeys(keyBytes, code)
		sessionKeys = &k
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

		_, reconnect := dialAndRun(wsURL, code, connectURL, sessionKeys, quit)
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

func stripScheme(raw string) string {
	for _, prefix := range []string{"wss://", "ws://", "https://", "http://"} {
		raw = strings.TrimPrefix(raw, prefix)
	}
	return raw
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

func handleRunCommand(args []string) {
	url := os.Getenv("CYA_URL")
	if url == "" {
		url = "http://localhost:8765"
	}
	keyRaw := os.Getenv("CYA_KEY")
	if keyRaw == "" {
		keyRaw = os.Getenv("KEY")
	}
	sessionOverride := os.Getenv("CYA_SESSION")
	if sessionOverride == "" {
		sessionOverride = os.Getenv("SESSION")
	}
	var cmdParts []string

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if (arg == "--url" || arg == "-u") && i+1 < len(args) {
			url = args[i+1]
			i++
		} else if (arg == "--key" || arg == "-k") && i+1 < len(args) {
			keyRaw = args[i+1]
			i++
		} else if (arg == "--session" || arg == "-s" || arg == "--code" || arg == "-c") && i+1 < len(args) {
			sessionOverride = args[i+1]
			i++
		} else {
			cmdParts = append(cmdParts, arg)
		}
	}

	cmdStr := strings.Join(cmdParts, " ")
	if strings.TrimSpace(cmdStr) == "" {
		fmt.Fprintln(os.Stderr, "Usage: cya run [--url <url>] [--session <id>] --key <key/phrase> <command>")
		os.Exit(1)
	}

	var sessionCode string
	var keys *SessionKeys

	if keyRaw != "" {
		keyBytes, err := ParseKeyOrPhrase(keyRaw)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error parsing key: %v\n", err)
			os.Exit(1)
		}
		if sessionOverride != "" && sessionCodePattern.MatchString(sessionOverride) {
			sessionCode = sessionOverride
		} else {
			sessionCode = DeriveSessionCode(keyBytes)
		}
		k := DeriveSubkeys(keyBytes, sessionCode)
		keys = &k
	} else {
		fmt.Fprintln(os.Stderr, "Error: missing --key or KEY env var for run command")
		os.Exit(1)
	}

	runURL := fmt.Sprintf("%s/api/session/%s/run", strings.TrimRight(url, "/"), sessionCode)
	reqID := fmt.Sprintf("%d", time.Now().UnixNano())

	cmdPayload, _ := json.Marshal(map[string]any{
		"cmd": cmdStr,
	})
	iv, encData, err := EncryptAESGCM(keys.CmdKey, cmdPayload, []byte(reqID))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error encrypting command: %v\n", err)
		os.Exit(1)
	}

	bodyJSON, _ := json.Marshal(map[string]any{
		"enc":  true,
		"id":   reqID,
		"iv":   iv,
		"data": encData,
	})

	resp, err := http.Post(runURL, "application/json", bytes.NewReader(bodyJSON))
	if err != nil {
		fmt.Fprintf(os.Stderr, "HTTP request failed: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error reading response: %v\n", err)
		os.Exit(1)
	}

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "Server error (%d): %s\n", resp.StatusCode, string(respBytes))
		os.Exit(1)
	}

	var respPayload struct {
		Enc  bool   `json:"enc"`
		ID   string `json:"id"`
		IV   string `json:"iv"`
		Data string `json:"data"`
	}
	if err := json.Unmarshal(respBytes, &respPayload); err != nil {
		fmt.Fprintf(os.Stderr, "Failed parsing JSON response: %v\n", err)
		os.Exit(1)
	}

	if !respPayload.Enc {
		fmt.Fprintln(os.Stderr, "Server returned unencrypted response")
		os.Exit(1)
	}

	decrypted, err := DecryptAESGCM(keys.RespKey, respPayload.IV, respPayload.Data, []byte(reqID))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed decrypting response: %v\n", err)
		os.Exit(1)
	}

	var res struct {
		Output   string `json:"output"`
		ExitCode int    `json:"exit_code"`
	}
	if err := json.Unmarshal(decrypted, &res); err != nil {
		fmt.Fprintf(os.Stderr, "Failed parsing decrypted response: %v\n", err)
		os.Exit(1)
	}

	os.Stdout.WriteString(res.Output)
	os.Exit(res.ExitCode)
}

func readCommands(wsc *wsConn, keys *SessionKeys, dot string) bool {
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
				Cmd  string `json:"cmd"`
				ID   string `json:"id"`
				Enc  bool   `json:"enc"`
				IV   string `json:"iv"`
				Data string `json:"data"`
			}
			_ = json.Unmarshal(data, &msg)
			if msg.ID == "" {
				continue
			}

			cmdToRun := msg.Cmd
			if msg.Enc {
				if keys == nil {
					printLine(dot, " ", ansiRed, "Received encrypted command without configured key", ansiReset)
					continue
				}
				decrypted, err := DecryptAESGCM(keys.CmdKey, msg.IV, msg.Data, []byte(msg.ID))
				if err != nil {
					printLine(dot, " ", ansiRed, "Command decryption failed: ", err.Error(), ansiReset)
					continue
				}
				var inner struct {
					Cmd string `json:"cmd"`
				}
				if err := json.Unmarshal(decrypted, &inner); err != nil {
					continue
				}
				cmdToRun = inner.Cmd
			}

			printLine(ansiCyan+"▶"+ansiReset, " ", ansiBold, cmdToRun, ansiReset)
			out, code, truncated := runOneShot(cmdToRun)
			if out != "" {
				for _, line := range strings.Split(out, "\n") {
					_, _ = os.Stdout.WriteString(ansiDim + "  " + line + ansiReset + "\n")
				}
			}

			if msg.Enc && keys != nil {
				innerRes, _ := json.Marshal(map[string]any{
					"output":    out,
					"exit_code": code,
					"truncated": truncated,
				})
				iv, encData, err := EncryptAESGCM(keys.RespKey, innerRes, []byte(msg.ID))
				if err == nil {
					wsc.sendJSON(map[string]any{
						"type": "command_result",
						"id":   msg.ID,
						"enc":  true,
						"iv":   iv,
						"data": encData,
					})
				}
			} else {
				wsc.sendJSON(map[string]any{
					"type":      "command_result",
					"id":        msg.ID,
					"output":    out,
					"exit_code": code,
					"truncated": truncated,
				})
			}
		case "file_read":
			var msg struct {
				ID   string `json:"id"`
				Path string `json:"path"`
				Enc  bool   `json:"enc"`
				IV   string `json:"iv"`
				Data string `json:"data"`
			}
			_ = json.Unmarshal(data, &msg)
			if msg.ID == "" {
				continue
			}
			filePath := msg.Path
			if msg.Enc && keys != nil {
				dec, err := DecryptAESGCM(keys.CmdKey, msg.IV, msg.Data, []byte(msg.ID))
				if err == nil {
					var inner struct {
						Path string `json:"path"`
					}
					if err := json.Unmarshal(dec, &inner); err == nil {
						filePath = inner.Path
					}
				}
			}
			sendFile(wsc, keys, msg.ID, filePath, msg.Enc && keys != nil)
		case "bye":
			wsc.close()
			return false
		}
	}
}

func sendFile(wsc *wsConn, keys *SessionKeys, id, path string, enc bool) {
	f, err := os.Open(path)
	if err != nil {
		sendFileResult(wsc, keys, id, path, "", 0, err.Error(), enc)
		return
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		sendFileResult(wsc, keys, id, path, "", 0, err.Error(), enc)
		return
	}

	size := fi.Size()
	if size > maxFileSize {
		sendFileResult(wsc, keys, id, path, "", 0, fmt.Sprintf("file too large: %d bytes (max %d)", size, maxFileSize), enc)
		return
	}

	data, err := io.ReadAll(f)
	if err != nil {
		sendFileResult(wsc, keys, id, path, "", 0, err.Error(), enc)
		return
	}

	encoded := base64.StdEncoding.EncodeToString(data)
	sendFileResult(wsc, keys, id, path, encoded, size, "", enc)
}

func sendFileResult(wsc *wsConn, keys *SessionKeys, id, path, data string, size int64, errMsg string, enc bool) {
	if enc && keys != nil {
		inner := map[string]any{
			"path": path,
			"data": data,
			"size": size,
		}
		if errMsg != "" {
			inner["error"] = errMsg
		}
		innerBytes, _ := json.Marshal(inner)
		iv, encData, err := EncryptAESGCM(keys.RespKey, innerBytes, []byte(id))
		if err == nil {
			wsc.sendJSON(map[string]any{
				"type": "file_read_result",
				"id":   id,
				"enc":  true,
				"iv":   iv,
				"data": encData,
			})
			return
		}
	}

	msg := map[string]any{
		"type":     "file_read_result",
		"id":       id,
		"path":     path,
		"data":     data,
		"size":     size,
		"encoding": "base64",
	}
	if errMsg != "" {
		msg["error"] = errMsg
	}
	wsc.sendJSON(msg)
}

// resolveWithFallback resolves hostname, falling back to 8.8.8.8:53 if the
// system resolver fails (common on Android/Termux where /etc/resolv.conf
// points to a non-existent localhost DNS server).
func resolveWithFallback(hostname string) ([]net.IP, error) {
	// System DNS first
	ips, err := net.DefaultResolver.LookupHost(context.Background(), hostname)
	if err == nil && len(ips) > 0 {
		return parseIPs(ips)
	}

	// Fallback: resolve via 8.8.8.8 directly
	alt := &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return net.DialTimeout("udp", "8.8.8.8:53", 5*time.Second)
		},
	}
	ips, err = alt.LookupHost(context.Background(), hostname)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("resolve %s: system DNS failed, 8.8.8.8 fallback also failed: %v", hostname, err)
	}
	return parseIPs(ips)
}

func parseIPs(addrs []string) ([]net.IP, error) {
	ips := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		ip := net.ParseIP(a)
		if ip != nil {
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no valid IPs found")
	}
	return ips, nil
}

func dialAndRun(wsURL, code, connectURL string, keys *SessionKeys, quit <-chan struct{}) (string, bool) {
	// Extract hostname from ws:// or wss:// URL for DNS fallback
	hostname := stripScheme(wsURL)
	if idx := strings.IndexByte(hostname, '/'); idx >= 0 {
		hostname = hostname[:idx]
	}
	if h, _, err := net.SplitHostPort(hostname); err == nil {
		hostname = h
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 15 * time.Second,
		NetDial: func(network, addr string) (net.Conn, error) {
			_, port, _ := net.SplitHostPort(addr)
			ips, err := resolveWithFallback(hostname)
			if err != nil {
				return nil, err
			}
			var lastErr error
			for _, ip := range ips {
				target := net.JoinHostPort(ip.String(), port)
				conn, err := net.DialTimeout(network, target, 15*time.Second)
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
	}
	conn, resp, err := dialer.Dial(wsURL, http.Header{})
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
	if keys != nil {
		printLine(dot, " ", ansiBold, code, ansiReset, "  [E2E Encrypted]  —  Ctrl+C to disconnect")
	} else {
		printLine(dot, " ", ansiBold, code, ansiReset, "  —  Ctrl+C to disconnect")
	}

	// Set up heartbeat: reset read deadline on server ping, respond with pong
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPingHandler(func(appData string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return conn.WriteControl(websocket.PongMessage, []byte(appData), time.Now().Add(10*time.Second))
	})

	var joinMsg map[string]any
	if keys != nil {
		metaBytes, _ := json.Marshal(map[string]any{
			"host":     hostnameSafe(),
			"os":       joinOS(),
			"arch":     joinArch(),
			"user":     safeUser(),
			"cwd":      cwd(),
			"shell":    shellName(),
			"elevated": isElevated(),
		})
		iv, encMeta, err := EncryptAESGCM(keys.MetaKey, metaBytes, []byte("meta"))
		if err != nil {
			clearCurrentBridge()
			return "", false
		}
		joinMsg = map[string]any{
			"type":    "join",
			"session": code,
			"role":    "agent",
			"enc":     true,
			"iv":      iv,
			"data":    encMeta,
		}
	} else {
		joinMsg = map[string]any{
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
		}
	}

	if !bridge.sendJSON(joinMsg) {
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

	reconnect := readCommands(bridge, keys, dot)
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
