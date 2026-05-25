package main

import (
	"bytes"
	"encoding/json"
	"io"
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

func main() {
	wsURL := os.Getenv("BRIDGE_WS_URL")
	if wsURL == "" {
		fatal(`Missing env var: BRIDGE_WS_URL`)
	}
	if len(os.Args) < 2 {
		fatal("Usage: cya-bridge <session code>")
	}
	code := os.Args[1]
	if !sessionCodePattern.MatchString(code) {
		fatal("Usage: cya-bridge <session code>")
	}

	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := dialer.Dial(wsURL, http.Header{})
	if err != nil {
		if resp != nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
		}
		fatal(err.Error())
	}

	bridge := &wsConn{conn: conn}
	dot := ansiCyan + "●" + ansiReset
	printLine(dot, " ", ansiBold, code, ansiReset, "  —  Ctrl+C to disconnect")

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
		fatal("websocket send failed")
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sig
		bridge.close()
		os.Exit(0)
	}()

	readCommands(bridge, dot)
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

func readCommands(wsc *wsConn, dot string) {
	defer func() {
		printLine("\n", dot, " Connection closed.", ansiReset)
		wsc.close()
	}()

	for {
		_, data, err := wsc.conn.ReadMessage()
		if err != nil {
			return
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
			return
		}
	}
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
