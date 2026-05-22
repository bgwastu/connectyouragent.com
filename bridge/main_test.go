package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSessionCodePattern(t *testing.T) {
	valid := []string{"a1b2c3d4e5f6", "123456789012", "abcdefabcdef"}
	invalid := []string{"", "a1b2c3d4e5f", "a1b2c3d4e5f6g", "A1b2c3d4e5f6"}
	for _, code := range valid {
		if !sessionCodePattern.MatchString(code) {
			t.Fatalf("expected valid session code: %q", code)
		}
	}
	for _, code := range invalid {
		if sessionCodePattern.MatchString(code) {
			t.Fatalf("expected invalid session code: %q", code)
		}
	}
}

func TestTrimOutput(t *testing.T) {
	unchanged := strings.Repeat("x", maxOutputBytes)
	if got, truncated := trimOutput(unchanged); got != unchanged || truncated {
		t.Fatalf("expected max-sized output to remain unchanged")
	}

	got, truncated := trimOutput(strings.Repeat("x", maxOutputBytes+1))
	if !truncated {
		t.Fatalf("expected truncated flag")
	}
	if !strings.HasPrefix(got, strings.Repeat("x", maxOutputBytes)) {
		t.Fatalf("expected truncated output to keep prefix")
	}
	if !strings.Contains(got, "[output truncated at 131072 bytes]") {
		t.Fatalf("missing truncation marker: %q", got[len(got)-64:])
	}
}

func TestShellMetadataHelpers(t *testing.T) {
	if runtime.GOOS == "windows" {
		if shellName() != "powershell.exe" {
			t.Fatalf("unexpected Windows shell name: %q", shellName())
		}
		if joinOS() != "win32" {
			t.Fatalf("unexpected Windows OS label: %q", joinOS())
		}
	} else {
		if shellName() != "/bin/sh" {
			t.Fatalf("unexpected shell name: %q", shellName())
		}
		if joinOS() != runtime.GOOS {
			t.Fatalf("unexpected OS label: %q", joinOS())
		}
	}

	if runtime.GOARCH == "amd64" {
		if joinArch() != "x64" {
			t.Fatalf("unexpected amd64 arch label: %q", joinArch())
		}
	} else if joinArch() != runtime.GOARCH {
		t.Fatalf("unexpected arch label: %q", joinArch())
	}
	if hostnameSafe() == "" {
		t.Fatalf("hostnameSafe returned empty hostname")
	}
	if cwd() == "" {
		t.Fatalf("cwd returned empty directory")
	}
}

func TestOneShotArgs(t *testing.T) {
	name, args := oneShotArgs("echo ok")
	if runtime.GOOS == "windows" {
		if name != "cmd.exe" || strings.Join(args, " ") != "/d /s /c echo ok" {
			t.Fatalf("unexpected Windows command args: %q %q", name, args)
		}
		return
	}
	if name != "/bin/sh" || strings.Join(args, " ") != "-c echo ok" {
		t.Fatalf("unexpected Unix command args: %q %q", name, args)
	}
}

func TestRunOneShotMergesStdoutStderrAndExitCode(t *testing.T) {
	cmd := `printf stdout; printf stderr >&2; exit 7`
	if runtime.GOOS == "windows" {
		cmd = `echo stdout && echo stderr 1>&2 && exit /b 7`
	}

	output, code, truncated := runOneShot(cmd)
	if code != 7 {
		t.Fatalf("expected exit code 7, got %d with output %q", code, output)
	}
	if truncated {
		t.Fatalf("did not expect small output to be truncated")
	}
	if !strings.Contains(output, "stdout") || !strings.Contains(output, "stderr") {
		t.Fatalf("expected merged stdout/stderr, got %q", output)
	}
}

func TestReadCommandsExecutesCommandAndSendsResult(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	done := make(chan struct{})
	go func() {
		readCommands(&wsConn{conn: client}, "")
		close(done)
	}()

	cmd := `printf ws-ok`
	if runtime.GOOS == "windows" {
		cmd = `echo ws-ok`
	}
	if err := server.WriteJSON(map[string]any{
		"type": "command",
		"id":   "cmd-1",
		"cmd":  cmd,
	}); err != nil {
		t.Fatalf("write command: %v", err)
	}

	var result struct {
		Type      string `json:"type"`
		ID        string `json:"id"`
		Output    string `json:"output"`
		ExitCode  int    `json:"exit_code"`
		Truncated bool   `json:"truncated"`
	}
	if err := server.ReadJSON(&result); err != nil {
		t.Fatalf("read result: %v", err)
	}
	if result.Type != "command_result" || result.ID != "cmd-1" {
		t.Fatalf("unexpected result envelope: %+v", result)
	}
	if result.ExitCode != 0 || !strings.Contains(result.Output, "ws-ok") {
		t.Fatalf("unexpected command result: %+v", result)
	}
	if result.Truncated {
		t.Fatalf("did not expect command output to be truncated")
	}

	_ = server.WriteJSON(map[string]any{"type": "bye"})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("readCommands did not exit after bye")
	}
}

func TestReadCommandsIgnoresMalformedMessages(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	done := make(chan struct{})
	go func() {
		readCommands(&wsConn{conn: client}, "")
		close(done)
	}()

	if err := server.WriteMessage(websocket.TextMessage, []byte(`not json`)); err != nil {
		t.Fatalf("write malformed message: %v", err)
	}
	if err := server.WriteJSON(map[string]any{"type": "command", "cmd": "echo ignored"}); err != nil {
		t.Fatalf("write missing-id command: %v", err)
	}
	_ = server.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	if _, _, err := server.ReadMessage(); err == nil {
		t.Fatalf("expected no response for malformed/missing-id messages")
	}

	_ = server.SetReadDeadline(time.Time{})
	_ = server.WriteJSON(map[string]any{"type": "bye"})
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("readCommands did not exit after bye")
	}
}

func websocketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	serverConn := make(chan *websocket.Conn, 1)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		serverConn <- conn
	}))
	t.Cleanup(httpServer.Close)

	url := "ws" + strings.TrimPrefix(httpServer.URL, "http")
	client, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	t.Cleanup(func() { _ = client.Close() })

	select {
	case server := <-serverConn:
		t.Cleanup(func() { _ = server.Close() })
		return client, server
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for websocket server conn")
		return nil, nil
	}
}

func TestSendJSONRejectsUnmarshalableAndClosedConn(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()
	wsc := &wsConn{conn: client}

	if wsc.sendJSON(make(chan int)) {
		t.Fatalf("expected unmarshalable payload to fail")
	}
	wsc.close()
	if wsc.sendJSON(map[string]string{"type": "test"}) {
		t.Fatalf("expected sendJSON on closed conn to fail")
	}
}

func TestSendJSONWritesTextMessage(t *testing.T) {
	client, server := websocketPair(t)
	wsc := &wsConn{conn: client}
	defer wsc.close()

	if !wsc.sendJSON(map[string]string{"type": "ping"}) {
		t.Fatalf("sendJSON failed")
	}
	typ, payload, err := server.ReadMessage()
	if err != nil {
		t.Fatalf("read message: %v", err)
	}
	if typ != websocket.TextMessage {
		t.Fatalf("expected text message, got %d", typ)
	}
	var got map[string]string
	if err := json.Unmarshal(payload, &got); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if got["type"] != "ping" {
		t.Fatalf("unexpected payload: %q", payload)
	}
}
