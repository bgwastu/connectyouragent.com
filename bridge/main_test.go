package main

import (
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
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

func TestWindowsAdminUsernameDetection(t *testing.T) {
	cases := []struct {
		name        string
		currentUser string
		envUser     string
		want        bool
	}{
		{name: "plain administrator", currentUser: "Administrator", want: true},
		{name: "domain administrator", currentUser: `WINBOX\Administrator`, want: true},
		{name: "env administrator fallback", envUser: "Administrator", want: true},
		{name: "normal user", currentUser: `WINBOX\bagas`, envUser: "bagas", want: false},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			if got := isWindowsAdministrator(tt.currentUser, tt.envUser); got != tt.want {
				t.Fatalf("isWindowsAdministrator() = %v, want %v", got, tt.want)
			}
		})
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

	resultCh := make(chan bool, 1)
	go func() {
		resultCh <- readCommands(&wsConn{conn: client}, "")
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
	case reconnect := <-resultCh:
		if reconnect {
			t.Fatalf("expected readCommands to return false after bye, got true")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("readCommands did not exit after bye")
	}
}

func TestReadCommandsIgnoresMalformedMessages(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	resultCh := make(chan bool, 1)
	go func() {
		resultCh <- readCommands(&wsConn{conn: client}, "")
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
	case reconnect := <-resultCh:
		if reconnect {
			t.Fatalf("expected readCommands to return false after bye, got true")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("readCommands did not exit after bye")
	}
}

func TestReadCommandsReturnsTrueOnUnexpectedDisconnect(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	resultCh := make(chan bool, 1)
	go func() {
		resultCh <- readCommands(&wsConn{conn: client}, "")
	}()

	// Close the raw TCP connection to simulate a network drop
	// (no websocket close frame sent)
	if err := client.NetConn().(*net.TCPConn).Close(); err != nil {
		t.Fatalf("close raw TCP: %v", err)
	}

	select {
	case reconnect := <-resultCh:
		if !reconnect {
			t.Fatalf("expected readCommands to return true on unexpected disconnect, got false")
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("readCommands did not exit after unexpected disconnect")
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

func TestReadFile(t *testing.T) {
	tmp := t.TempDir()
	path := tmp + "/test.txt"
	content := "hello world"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	data, size, err := readFile(path)
	if err != nil {
		t.Fatalf("readFile failed: %v", err)
	}
	if size != int64(len(content)) {
		t.Fatalf("expected size %d, got %d", len(content), size)
	}
	decoded, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		t.Fatalf("decode base64: %v", err)
	}
	if string(decoded) != content {
		t.Fatalf("expected %q, got %q", content, string(decoded))
	}
}

func TestReadFileNonexistent(t *testing.T) {
	_, _, err := readFile("/nonexistent/path")
	if err == nil {
		t.Fatalf("expected error for nonexistent file")
	}
}

func TestWriteFileBase64(t *testing.T) {
	tmp := t.TempDir()
	path := tmp + "/output.txt"
	content := "hello from bridge"
	encoded := base64.StdEncoding.EncodeToString([]byte(content))

	bytesWritten, err := writeFile(path, encoded, "base64")
	if err != nil {
		t.Fatalf("writeFile failed: %v", err)
	}
	if bytesWritten != len(content) {
		t.Fatalf("expected %d bytes written, got %d", len(content), bytesWritten)
	}

	read, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(read) != content {
		t.Fatalf("expected %q, got %q", content, string(read))
	}
}

func TestWriteFileBase64url(t *testing.T) {
	tmp := t.TempDir()
	path := tmp + "/output.txt"
	content := "hello with base64url"
	encoded := base64.URLEncoding.EncodeToString([]byte(content))

	bytesWritten, err := writeFile(path, encoded, "base64")
	if err != nil {
		t.Fatalf("writeFile with base64url failed: %v", err)
	}
	if bytesWritten != len(content) {
		t.Fatalf("expected %d bytes written, got %d", len(content), bytesWritten)
	}

	read, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(read) != content {
		t.Fatalf("expected %q, got %q", content, string(read))
	}
}

func TestWriteFileInvalidBase64(t *testing.T) {
	tmp := t.TempDir()
	path := tmp + "/output.txt"
	_, err := writeFile(path, "!!!not-base64!!!", "base64")
	if err == nil {
		t.Fatalf("expected error for invalid base64")
	}
}

func TestHandleFileReadSendsResult(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	tmp := t.TempDir()
	path := tmp + "/test.txt"
	content := "file read test"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	wsc := &wsConn{conn: client}
	go handleFileRead(wsc, "file-1", path)

	var result struct {
		Type     string `json:"type"`
		ID       string `json:"id"`
		Path     string `json:"path"`
		Data     string `json:"data"`
		Size     int64  `json:"size"`
		Encoding string `json:"encoding"`
	}
	if err := server.ReadJSON(&result); err != nil {
		t.Fatalf("read result: %v", err)
	}
	if result.Type != "file_read_result" || result.ID != "file-1" || result.Path != path {
		t.Fatalf("unexpected result: %+v", result)
	}
	if result.Size != int64(len(content)) {
		t.Fatalf("expected size %d, got %d", len(content), result.Size)
	}
	decoded, _ := base64.StdEncoding.DecodeString(result.Data)
	if string(decoded) != content {
		t.Fatalf("expected content %q, got %q", content, string(decoded))
	}
}

func TestReadCommandsHandlesFileRead(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	tmp := t.TempDir()
	path := tmp + "/cmd-test.txt"
	content := "read via command"
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write test file: %v", err)
	}

	resultCh := make(chan bool, 1)
	go func() {
		resultCh <- readCommands(&wsConn{conn: client}, "")
	}()

	if err := server.WriteJSON(map[string]any{
		"type": "file_read",
		"id":   "fr-1",
		"path": path,
	}); err != nil {
		t.Fatalf("write file_read: %v", err)
	}

	var result struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Path string `json:"path"`
		Data string `json:"data"`
		Size int64  `json:"size"`
	}
	if err := server.ReadJSON(&result); err != nil {
		t.Fatalf("read result: %v", err)
	}
	if result.Type != "file_read_result" || result.ID != "fr-1" {
		t.Fatalf("unexpected type: %+v", result)
	}

	// Clean up by sending bye
	_ = server.WriteJSON(map[string]any{"type": "bye"})
	<-resultCh
}

func TestReadCommandsHandlesFileWrite(t *testing.T) {
	client, server := websocketPair(t)
	defer server.Close()

	tmp := t.TempDir()
	path := tmp + "/write-test.txt"
	content := "written via command"
	encoded := base64.StdEncoding.EncodeToString([]byte(content))

	resultCh := make(chan bool, 1)
	go func() {
		resultCh <- readCommands(&wsConn{conn: client}, "")
	}()

	if err := server.WriteJSON(map[string]any{
		"type":     "file_write",
		"id":       "fw-1",
		"path":     path,
		"data":     encoded,
		"encoding": "base64",
	}); err != nil {
		t.Fatalf("write file_write: %v", err)
	}

	var result struct {
		Type         string `json:"type"`
		ID           string `json:"id"`
		Path         string `json:"path"`
		BytesWritten int    `json:"bytes_written"`
	}
	if err := server.ReadJSON(&result); err != nil {
		t.Fatalf("read result: %v", err)
	}
	if result.Type != "file_write_result" || result.ID != "fw-1" {
		t.Fatalf("unexpected type: %+v", result)
	}
	if result.BytesWritten != len(content) {
		t.Fatalf("expected %d bytes, got %d", len(content), result.BytesWritten)
	}

	// Verify content was written
	read, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read written file: %v", err)
	}
	if string(read) != content {
		t.Fatalf("expected %q, got %q", content, string(read))
	}

	// Clean up
	_ = server.WriteJSON(map[string]any{"type": "bye"})
	<-resultCh
}
