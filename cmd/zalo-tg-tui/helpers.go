package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func alignLine(width int, left, right string) string {
	if right == "" {
		return left
	}
	space := width - lipgloss.Width(left) - lipgloss.Width(right)
	if space < 1 {
		return left
	}
	return left + strings.Repeat(" ", space) + right
}

func commandBar(width int, items ...string) string {
	if len(items) == 0 {
		return ""
	}
	separator := ui.muted.Render("  ·  ")
	line := ui.muted.Render(items[0])
	for _, item := range items[1:] {
		next := line + separator + ui.muted.Render(item)
		if lipgloss.Width(next) > width {
			break
		}
		line = next
	}
	return line
}

func horizontalRule(width int, left, center, right string) string {
	remaining := width - lipgloss.Width(left) - lipgloss.Width(center) - lipgloss.Width(right)
	if remaining < 2 {
		return truncate(left+" "+center+" "+right, width)
	}
	leftGap := remaining / 2
	rightGap := remaining - leftGap
	return left + strings.Repeat(" ", leftGap) + center + strings.Repeat(" ", rightGap) + right
}

func renderBox(style lipgloss.Style, outerWidth int, content string) string {
	innerWidth := max(1, outerWidth-style.GetHorizontalFrameSize())
	return style.Width(innerWidth).Render(content)
}

func renderBoxHeight(style lipgloss.Style, outerWidth, outerHeight int, content string) string {
	innerWidth := max(1, outerWidth-style.GetHorizontalFrameSize())
	innerHeight := max(1, outerHeight-style.GetVerticalFrameSize())
	return style.Width(innerWidth).Height(innerHeight).Render(content)
}

func spinnerView(online bool, spinView string, frame int) string {
	if online {
		breath := breathing(frame, 48)
		c := interpolateColor(string(ui.palette.green), string(ui.palette.cyan), breath*0.5)
		return lipgloss.NewStyle().Foreground(lipgloss.Color(c)).Render("●")
	}
	return lipgloss.NewStyle().Foreground(statusColor("starting")).Render(spinView)
}

func statusLabel(value string) string {
	switch strings.ToLower(value) {
	case "online":
		return "up"
	case "error":
		return "error"
	case "stopping":
		return "stopping"
	default:
		return "connecting"
	}
}

func compactServiceName(name string) string {
	switch strings.ToLower(name) {
	case "bridge":
		return "br"
	case "telegram":
		return "tg"
	case "zalo":
		return "za"
	default:
		return name
	}
}

func compactStatusLabel(value string) string {
	switch strings.ToLower(value) {
	case "online":
		return "up"
	case "error":
		return "err"
	case "stopping":
		return "stop"
	default:
		return "sync"
	}
}

func statusColor(value string) lipgloss.Color {
	switch strings.ToLower(value) {
	case "online":
		return ui.palette.green
	case "error":
		return ui.palette.red
	case "stopping":
		return ui.palette.yellow
	default:
		return ui.palette.cyan
	}
}

func toneGlyph(tone string) (string, lipgloss.Color) {
	switch tone {
	case "success":
		return "●", ui.palette.green
	case "info":
		return "◆", ui.palette.cyan
	case "warn":
		return "▲", ui.palette.yellow
	case "error":
		return "×", ui.palette.red
	default:
		return "·", ui.palette.muted
	}
}

func toneLevel(tone string) (string, lipgloss.Color) {
	switch tone {
	case "success":
		return "ok", ui.palette.green
	case "info":
		return "info", ui.palette.blue
	case "warn":
		return "warn", ui.palette.yellow
	case "error":
		return "error", ui.palette.red
	default:
		return "debug", ui.palette.muted
	}
}

func labelColor(label string) lipgloss.Color {
	lower := strings.ToLower(label)
	switch {
	case strings.Contains(lower, "zalo"):
		return ui.palette.magenta
	case strings.Contains(lower, "telegram"), strings.Contains(lower, "tg"):
		return ui.palette.cyan
	case strings.Contains(lower, "bridge"):
		return ui.palette.green
	case strings.Contains(lower, "cache"), strings.Contains(lower, "topic"):
		return ui.palette.orange
	case strings.Contains(lower, "system"), strings.Contains(lower, "runtime"):
		return ui.palette.blue
	default:
		return ui.palette.ink
	}
}

func uptime() string {
	total := int(time.Since(startedAt).Seconds())
	hours := total / 3600
	minutes := (total % 3600) / 60
	seconds := total % 60
	return fmt.Sprintf("%02d:%02d:%02d", hours, minutes, seconds)
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func truncate(value string, width int) string {
	if width <= 0 {
		return ""
	}
	if lipgloss.Width(value) <= width {
		return value
	}
	runes := []rune(value)
	for len(runes) > 0 && lipgloss.Width(string(runes)+"…") > width {
		runes = runes[:len(runes)-1]
	}
	return string(runes) + "…"
}

func padRight(value string, width int) string {
	current := lipgloss.Width(value)
	if current >= width {
		return value
	}
	return value + strings.Repeat(" ", width-current)
}

func fillLine(value string, width int) string {
	current := lipgloss.Width(value)
	if current >= width {
		return value
	}
	return value + strings.Repeat(" ", width-current)
}

func plural(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func circularDistance(a, b, size int) int {
	if size <= 0 {
		return 0
	}
	distance := a - b
	if distance < 0 {
		distance = -distance
	}
	return min(distance, size-distance)
}

func clamp(value, low, high int) int {
	return min(high, max(low, value))
}

func activityViewportTop() int {
	return 4
}
