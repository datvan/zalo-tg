package main

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/charmbracelet/glamour"
	glowutils "github.com/charmbracelet/glow/utils"
)

func (m model) markdownContent(width int) string {
	if cached, ok := m.markdownFor[width]; ok {
		return cached
	}
	source := `---
title: Zalo Telegram Bridge
---

## Keys

| key | action |
| --- | --- |
| ↑/↓ or wheel | scroll focused pane |
| PgUp/PgDn | page focused pane |
| g / G | jump oldest / live |
| drag in activity | select rows without leaving scroll mode |
| y / ctrl+y | copy selected rows to clipboard |
| ctrl+c | copy selected rows; stop bridge when nothing is selected |
| Esc | clear selection |
| Tab | move focus between activity and help |
| s | native-select freeze fallback |
| ? or h | toggle this help |
| F1 | expanded keymap |

## Notes

- live mode follows new activity when the log is at the bottom.
- set ` + "`ZALO_TG_TUI_MOUSE=0`" + ` to keep native terminal mouse selection/scrolling.
- default mouse mode keeps wheel scrolling and adds app-level row selection/copy, similar to OpenCode's renderer-managed selection.
- copy uses local clipboard tools when available and also emits OSC52 for compatible terminals.
- select mode disables mouse capture temporarily when you need native terminal selection.
- set ` + "`ZALO_TG_TUI_ENGINE=ansi`" + ` to force the legacy TypeScript dashboard.
- set ` + "`ZALO_TG_TUI=0`" + ` for plain logs.
`
	rendered := renderMarkdown(source, width)
	m.markdownFor[width] = rendered
	return rendered
}

func renderMarkdown(markdown string, width int) string {
	clean := string(glowutils.RemoveFrontmatter([]byte(markdown)))
	if rendered, err := renderWithGlow(clean, width); err == nil {
		return strings.TrimSpace(rendered)
	}
	renderer, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithEmoji(),
		glamour.WithWordWrap(max(24, width)),
	)
	if err != nil {
		return clean
	}
	rendered, err := renderer.Render(clean)
	if err != nil {
		return clean
	}
	return strings.TrimSpace(rendered)
}

func renderWithGlow(markdown string, width int) (string, error) {
	bin, err := resolveGlowBinary()
	if err != nil {
		return "", err
	}
	cmd := exec.Command(bin, "-s", "dark", "-w", strconv.Itoa(max(24, width)), "-")
	cmd.Stdin = strings.NewReader(markdown)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return "", err
	}
	return out.String(), nil
}

func resolveGlowBinary() (string, error) {
	candidates := []string{}
	if explicit := strings.TrimSpace(os.Getenv("ZALO_TG_GLOW_BIN")); explicit != "" {
		candidates = append(candidates, explicit)
	}
	if self, err := os.Executable(); err == nil {
		candidates = append(candidates, siblingBinary(self, "glow"))
	}
	if fromPath, err := exec.LookPath(glowBinaryName()); err == nil {
		candidates = append(candidates, fromPath)
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		if stat, err := os.Stat(candidate); err == nil && !stat.IsDir() {
			return candidate, nil
		}
	}
	return "", errors.New("glow binary not found")
}

func glowBinaryName() string {
	if os.PathSeparator == '\\' {
		return "glow.exe"
	}
	return "glow"
}

func siblingBinary(self, name string) string {
	if os.PathSeparator == '\\' && !strings.HasSuffix(name, ".exe") {
		name += ".exe"
	}
	return filepath.Join(filepath.Dir(self), name)
}
